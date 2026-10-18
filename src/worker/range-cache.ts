// http 來源的 Range 快取與預讀（ADR-0007）。快取以 256 KiB 的區塊為單位、LRU 淘汰，屬於 media Worker，
// 主來源與外掛音軌共用一個上限（`limits.cacheBytes`）。每個來源以 `CachedSource` 讀取：隨機讀一次請求涵蓋的區塊，
// 循序讀合併成最多 2 MiB 的請求；預讀從播放位置（demux 讀到的位置）往後抓到目標就停，掉到一半以下才恢復。

import type { WorkerError } from './errors.js';
import { retryable, type ByteSource, type RangeClient } from './source.js';

/** 區塊大小：LRU 與對齊的單位。 */
export const BLOCK_BYTES = 256 * 1024;
/** 一個請求最多的 bytes。 */
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
/** 單一來源的預讀最多用掉 `cacheBytes` 的比例，其餘留給播放位置之前的資料。 */
export const MAX_READAHEAD_SHARE = 0.75;
/** 抓取階段同時進行的預讀請求數：一個在收資料時，下一個已經發出。 */
const READAHEAD_REQUESTS = 2;
/** 預讀的請求以可重試的錯誤失敗（重試也用完）之後，隔這麼久（ms）再抓。 */
const READAHEAD_RETRY_MS = 2000;
const MAX_REQUEST_BLOCKS = MAX_REQUEST_BYTES / BLOCK_BYTES;

/** 所有來源共用的區塊快取（LRU）。 */
export class RangeCache {
  readonly limitBytes: number;
  /** Map 的順序就是 LRU 的順序：最前面的最久沒用到。 */
  readonly #blocks = new Map<string, Uint8Array>();
  #bytes = 0;
  #nextSource = 0;
  /** 讀取時已在快取中的區塊數與需要等網路的區塊數。 */
  hits = 0;
  misses = 0;

  constructor(limitBytes: number) {
    this.limitBytes = limitBytes;
  }

  get bytes(): number {
    return this.#bytes;
  }

  /** 給新的來源一個 id。 */
  newSource(): number {
    return ++this.#nextSource;
  }

  has(source: number, index: number): boolean {
    return this.#blocks.has(key(source, index));
  }

  /** 取出一個區塊並標記為最近用過。 */
  get(source: number, index: number): Uint8Array | undefined {
    const k = key(source, index);
    const block = this.#blocks.get(k);
    if (block) {
      this.#blocks.delete(k);
      this.#blocks.set(k, block);
    }
    return block;
  }

  put(source: number, index: number, data: Uint8Array): void {
    const k = key(source, index);
    const old = this.#blocks.get(k);
    if (old) {
      this.#bytes -= old.length;
      this.#blocks.delete(k);
    }
    this.#blocks.set(k, data);
    this.#bytes += data.length;
    for (const [oldest, block] of this.#blocks) {
      if (this.#bytes <= this.limitBytes || oldest === k) break;
      this.#blocks.delete(oldest);
      this.#bytes -= block.length;
    }
  }

  /** 移除一個來源的所有區塊（來源被丟棄時）。 */
  drop(source: number): void {
    const prefix = `${String(source)}:`;
    for (const [k, block] of this.#blocks) {
      if (!k.startsWith(prefix)) continue;
      this.#blocks.delete(k);
      this.#bytes -= block.length;
    }
  }
}

function key(source: number, index: number): string {
  return `${String(source)}:${String(index)}`;
}

/** 一個進行中的請求，涵蓋 `[first, first + count)` 的區塊。 */
interface BlockRequest {
  first: number;
  count: number;
  readahead: boolean;
  /** 被 `abort()` 丟掉之後不再更新狀態。 */
  dead: boolean;
  /** 結束時的錯誤；成功或還沒結束時為 null。 */
  error: Error | null;
  settled: boolean;
}

/**
 * 經過 Range 快取的 http 來源。讀取的位置就是播放位置（demux 讀到的位置）；`setReadahead()` 之後依它預讀。
 *
 * 預讀遇到不可重試的錯誤（401、404、不支援 Range 等）時記下錯誤，之後需要網路的讀取直接以它 reject，快取內的照常
 * 讀；可重試的錯誤（重試也用完）只讓預讀暫停一段時間，讀取自己再發請求。
 */
export class CachedSource implements ByteSource {
  readonly size: number;
  readonly client: RangeClient;
  readonly #cache: RangeCache;
  readonly #id: number;
  #controller = new AbortController();
  /** 請求中的區塊 → 涵蓋它的請求。 */
  readonly #pending = new Map<number, BlockRequest>();
  readonly #requests = new Set<BlockRequest>();
  readonly #waiters = new Set<() => void>();
  /** 上一個讀取的結尾，用來判斷循序讀；`abort()` 之後為 null。 */
  #lastEnd: number | null = null;
  /** 播放位置：最後一個讀取的結尾；`abort()` 之後到下一個讀取之前為 null。 */
  #position: number | null = null;
  /** 預讀目標（bytes）；0 表示不預讀。 */
  #target = 0;
  #fetching = false;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #failure: WorkerError | null = null;
  #closed = false;
  /** 區塊進來、預讀的階段改變時呼叫。 */
  onChange: (() => void) | null = null;

  constructor(client: RangeClient, cache: RangeCache) {
    this.client = client;
    this.size = client.size;
    this.#cache = cache;
    this.#id = cache.newSource();
  }

  /** 播放位置：demux 最後讀到的位置；seek 中止讀取之後到下一個讀取之前為 null。 */
  get position(): number | null {
    return this.#position;
  }

  /** 實際生效的預讀目標：設定的目標，最多 `cacheBytes` 的 75%。 */
  get readaheadTarget(): number {
    return Math.min(this.#target, MAX_READAHEAD_SHARE * this.#cache.limitBytes);
  }

  /** 是否處於預讀的抓取階段。 */
  get fetching(): boolean {
    return this.#fetching;
  }

  /** 從播放位置起連續在快取中的 bytes（到檔尾為止）。 */
  get aheadBytes(): number {
    const position = this.#position;
    if (position === null) return 0;
    let index = Math.floor(position / BLOCK_BYTES);
    let end = position;
    while (end < this.size && this.#cache.has(this.#id, index)) {
      index++;
      end = Math.min(index * BLOCK_BYTES, this.size);
    }
    return end - position;
  }

  /** 開始（或改變目標）預讀；目標是 bytes，0 表示停止。 */
  setReadahead(targetBytes: number): void {
    this.#target = Math.max(0, targetBytes);
    this.#pump();
  }

  async read(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    const end = Math.min(offset + length, this.size);
    if (end <= offset) return new Uint8Array();
    const last = this.#lastEnd;
    const sequential = last !== null && offset >= last && offset <= last + BLOCK_BYTES;
    this.#lastEnd = end;
    this.#position = end;
    const first = Math.floor(offset / BLOCK_BYTES);
    const lastBlock = Math.floor((end - 1) / BLOCK_BYTES);
    for (let i = first; i <= lastBlock; i++) {
      if (this.#cache.has(this.#id, i)) this.#cache.hits++;
      else this.#cache.misses++;
    }
    await this.#ensure(first, lastBlock, sequential, signal);
    const out = new Uint8Array(end - offset);
    for (let i = first; i <= lastBlock; i++) {
      const block = this.#cache.get(this.#id, i);
      if (!block) throw new Error('unreachable: 區塊不在快取中');
      const start = i * BLOCK_BYTES;
      const from = Math.max(offset, start) - start;
      const to = Math.min(end, start + block.length) - start;
      out.set(block.subarray(from, to), start + from - offset);
    }
    return out;
  }

  /** 中止所有進行中的請求（seek、卡住時）；之後的讀取照常，預讀等下一個讀取決定位置後再開始。 */
  abort(): void {
    this.#controller.abort(new DOMException('讀取被中止', 'AbortError'));
    this.#controller = new AbortController();
    for (const request of this.#requests) request.dead = true;
    this.#requests.clear();
    this.#pending.clear();
    this.#lastEnd = null;
    this.#position = null;
    this.#setFetching(false);
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#notify();
  }

  /** 來源被丟棄：中止請求、移除它的快取，不再預讀。 */
  close(): void {
    this.#closed = true;
    this.abort();
    this.#cache.drop(this.#id);
  }

  /** 等到 `[first, last]` 的區塊都在快取中；沒有在請求中的區塊由這個讀取發出請求。 */
  async #ensure(first: number, last: number, sequential: boolean, signal: AbortSignal) {
    /** 這個讀取等著的請求：結束時看它的錯誤。 */
    const waitingOn = new Map<number, BlockRequest>();
    for (;;) {
      signal.throwIfAborted();
      let missing = false;
      for (let i = first; i <= last; i++) {
        if (this.#cache.has(this.#id, i)) continue;
        missing = true;
        const previous = waitingOn.get(i);
        if (previous?.settled && previous.error !== null && !previous.dead) {
          if (!previous.readahead || !retryable(previous.error)) throw previous.error;
        }
        if (this.#failure) throw this.#failure;
        let request = this.#pending.get(i);
        if (!request) {
          const count = sequential
            ? this.#sequentialCount(i, last)
            : this.#missingRun(i, last - i + 1);
          request = this.#request(i, count, false);
        }
        waitingOn.set(i, request);
      }
      if (!missing) {
        this.#pump();
        return;
      }
      this.#pump();
      await this.#changed(signal);
    }
  }

  /** 循序讀從區塊 `index` 起請求的區塊數：至少到 `last`，有預讀目標時到目標為止，最多 2 MiB。 */
  #sequentialCount(index: number, last: number): number {
    let until = index + MAX_REQUEST_BLOCKS;
    if (this.#target > 0 && this.#position !== null) {
      const window = Math.ceil((this.#position + this.readaheadTarget) / BLOCK_BYTES);
      until = Math.min(until, Math.max(window, last + 1));
    }
    return this.#missingRun(index, until - index);
  }

  /** 從 `index` 起連續沒有在快取、也沒有在請求中的區塊數，最多 `max` 個、不超過檔尾。 */
  #missingRun(index: number, max: number): number {
    const blocks = Math.ceil(this.size / BLOCK_BYTES);
    let count = 0;
    while (
      count < Math.min(max, MAX_REQUEST_BLOCKS) &&
      index + count < blocks &&
      !this.#cache.has(this.#id, index + count) &&
      !this.#pending.has(index + count)
    ) {
      count++;
    }
    return Math.max(count, 1);
  }

  /** 預讀：依 hysteresis 決定階段，抓取階段時把播放位置之後、目標以內缺的區塊發出請求。 */
  #pump(): void {
    if (this.#closed || this.#target <= 0 || this.#position === null || this.#failure) return;
    if (this.#retryTimer !== null) return;
    const position = this.#position;
    const ahead = this.aheadBytes;
    const target = this.readaheadTarget;
    const toEnd = this.size - position;
    if (this.#fetching && ahead >= Math.min(target, toEnd)) this.#setFetching(false);
    else if (!this.#fetching && ahead < target / 2 && ahead < toEnd) this.#setFetching(true);
    if (!this.#fetching) return;
    const windowEnd = Math.min(this.size, position + target);
    const lastBlock = Math.ceil(windowEnd / BLOCK_BYTES);
    let index = Math.floor((position + ahead) / BLOCK_BYTES);
    let active = [...this.#requests].filter((r) => r.readahead).length;
    while (active < READAHEAD_REQUESTS && index < lastBlock) {
      if (this.#cache.has(this.#id, index) || this.#pending.has(index)) {
        index++;
        continue;
      }
      const count = this.#missingRun(index, lastBlock - index);
      this.#request(index, count, true);
      index += count;
      active++;
    }
  }

  #setFetching(fetching: boolean): void {
    if (this.#fetching === fetching) return;
    this.#fetching = fetching;
    this.onChange?.();
  }

  /** 發出一個請求；區塊到齊一個就放進快取，不等整個請求結束。 */
  #request(first: number, count: number, readahead: boolean): BlockRequest {
    const request: BlockRequest = {
      first,
      count,
      readahead,
      dead: false,
      error: null,
      settled: false,
    };
    this.#requests.add(request);
    for (let i = first; i < first + count; i++) this.#pending.set(i, request);
    const start = first * BLOCK_BYTES;
    const end = Math.min((first + count) * BLOCK_BYTES, this.size) - 1;
    let index = first;
    let block = new Uint8Array(Math.min(BLOCK_BYTES, this.size - index * BLOCK_BYTES));
    let filled = 0;
    const onData = (chunk: Uint8Array) => {
      if (request.dead) return;
      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(chunk.length - offset, block.length - filled);
        block.set(chunk.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled < block.length) break;
        this.#cache.put(this.#id, index, block);
        this.#pending.delete(index);
        index++;
        if (index < first + count) {
          block = new Uint8Array(Math.min(BLOCK_BYTES, this.size - index * BLOCK_BYTES));
          filled = 0;
        }
      }
      this.#notify();
      this.onChange?.();
      this.#pump();
    };
    this.client.stream(start, end, this.#controller.signal, onData).then(
      () => {
        this.#finish(request, null);
      },
      (error: unknown) => {
        this.#finish(request, error instanceof Error ? error : new Error(String(error)));
      },
    );
    return request;
  }

  #finish(request: BlockRequest, error: Error | null): void {
    request.settled = true;
    if (request.dead) return;
    request.error = error;
    this.#requests.delete(request);
    for (let i = request.first; i < request.first + request.count; i++) {
      if (this.#pending.get(i) === request) this.#pending.delete(i);
    }
    if (error !== null && request.readahead) {
      if (!retryable(error)) {
        this.#failure = error as WorkerError;
        this.#setFetching(false);
      } else {
        this.#retryTimer = setTimeout(() => {
          this.#retryTimer = null;
          this.#pump();
        }, READAHEAD_RETRY_MS);
      }
    }
    this.#notify();
    this.#pump();
  }

  /** 等到下一次狀態改變（區塊進來、請求結束、abort）；`signal` 中止時以它的 reason reject。 */
  #changed(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.#waiters.delete(wake);
        reject(signal.reason as Error);
      };
      const wake = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      this.#waiters.add(wake);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #notify(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake();
  }
}

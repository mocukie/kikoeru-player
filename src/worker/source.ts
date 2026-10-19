// 來源：以 `read(offset, length, signal)` 讀取位元組（ADR-0001）。http 依狀態碼分類錯誤，5xx 與網路錯誤以指數退避
// 重試；給了 `RangeCache` 時，http 經過 Range 快取與預讀（range-cache.ts，ADR-0007）。

import type { RetryPolicy, WireSource, WorkerErrorCode } from '../protocol/index.js';
import { WorkerError } from './errors.js';
import type { WorkerHost } from './host.js';
import { silentLogger, type Logger } from './log.js';
import { CachedSource, type RangeCache } from './range-cache.js';

/** 一個可隨機讀取的來源。 */
export interface ByteSource {
  readonly size: number;
  /** 讀取 `[offset, offset + length)`，超出結尾的部分截掉；被 `signal` 中止時以 AbortError reject。 */
  read(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
  /** 中止所有進行中的請求（含預讀），之後的讀取照常；seek 時呼叫。沒有背景請求的來源省略。 */
  abort?(): void;
  /** 來源被丟棄：中止請求、釋放它佔用的快取。沒有東西要釋放的來源省略。 */
  close?(): void;
  /** 預讀與網路的統計（`WorkerStats` 的 cache、network）；不經過 Range 快取的來源省略。 */
  stats?(): SourceStats;
}

/** 一個來源的預讀與網路統計。 */
export interface SourceStats {
  /** 從播放位置起連續在快取中的 bytes。 */
  aheadBytes: number;
  /** 實際生效的預讀目標（bytes）。 */
  readaheadTarget: number;
  /** 是否處於預讀的抓取階段。 */
  fetching: boolean;
  /** 累計讀取的 bytes。 */
  bytesLoaded: number;
  /** 進行中的請求。 */
  inflight: InflightRequest[];
}

export interface SourceDeps {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** http 讀取的重試；省略時不重試。 */
  retry?: RetryPolicy;
  /** http 經過的 Range 快取；省略時 http 直接讀取，不快取也不預讀。 */
  cache?: RangeCache;
  /** http 的每個請求失敗時呼叫（包括之後會重試的），供卡住時回報最後一次的讀取錯誤。 */
  onRequestError?: (error: WorkerError) => void;
  /** 請求、失敗與重試的 log（scope `'io'`）；省略時不記錄。 */
  log?: Logger;
}

/** 進行中的 http 請求，供 `getStats().network.inflight`。 */
export interface InflightRequest {
  url: string;
  start: number;
  end: number;
  elapsedMs: number;
}

/** http 的 Range 讀取：重試、錯誤分類與網路統計。 */
export interface RangeClient {
  readonly url: string;
  readonly size: number;
  /**
   * 讀 `[start, end]`（含兩端）的 bytes，依序以 `onData` 交出。5xx 與網路錯誤（含 body 讀到一半斷線、長度不符）以
   * `retry` 重試，重試從已經收到的位置接續；用完重試或其他錯誤以分類過的 `WorkerError` reject，被中止時以
   * `signal` 的 reason reject。
   */
  stream(
    start: number,
    end: number,
    signal: AbortSignal,
    onData: (chunk: Uint8Array) => void,
  ): Promise<void>;
  /** 累計收到的 body bytes。 */
  readonly bytesLoaded: number;
  /** 進行中的請求。 */
  inflight(): InflightRequest[];
}

/** 開啟來源並取得大小；http 沒有給大小時發一個 Range 請求。 */
export async function openSource(
  wire: WireSource<WorkerHost>,
  signal: AbortSignal,
  deps: SourceDeps = {},
): Promise<ByteSource> {
  switch (wire.kind) {
    case 'bytes':
      return bytesSource(wire.data instanceof Uint8Array ? wire.data : new Uint8Array(wire.data));
    case 'blob':
      return blobSource(wire.blob);
    case 'http': {
      const client = await openHttp(wire, signal, deps);
      return deps.cache ? new CachedSource(client, deps.cache, deps.log) : directSource(client);
    }
  }
}

function bytesSource(data: Uint8Array): ByteSource {
  return {
    size: data.length,
    read: (offset, length, signal) =>
      signal.aborted
        ? Promise.reject(signal.reason as Error)
        : Promise.resolve(data.subarray(offset, offset + length)),
  };
}

function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    async read(offset, length, signal) {
      signal.throwIfAborted();
      // Blob 的讀取不能中止；中止時不等它完成。
      const buffer = await abortable(blob.slice(offset, offset + length).arrayBuffer(), signal);
      return new Uint8Array(buffer);
    },
  };
}

/** 不經過快取的 http：每個讀取一個 Range 請求。 */
function directSource(client: RangeClient): ByteSource {
  return {
    size: client.size,
    async read(offset, length, signal) {
      const end = Math.min(offset + length, client.size) - 1;
      if (end < offset) return new Uint8Array();
      const data = new Uint8Array(end - offset + 1);
      let filled = 0;
      await client.stream(offset, end, signal, (chunk) => {
        data.set(chunk, filled);
        filled += chunk.length;
      });
      return data;
    },
  };
}

/** 建立 http 的 `RangeClient`；沒有給大小時先以 `bytes=0-0` 探測。 */
export async function openHttp(
  wire: Extract<WireSource<WorkerHost>, { kind: 'http' }>,
  signal: AbortSignal,
  deps: SourceDeps = {},
): Promise<RangeClient> {
  const { url } = wire;
  const retry = deps.retry ?? noRetry;
  const log = deps.log ?? silentLogger;
  const fetchImpl = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const inflight = new Set<{ start: number; end: number; startedAt: number }>();
  let bytesLoaded = 0;

  /**
   * 一次 Range 請求，body 依序交給 `onData`；body 不完整或超出範圍時丟 `SOURCE_NETWORK`，其他失敗時丟分類過的
   * `WorkerError`，被中止時丟 `signal` 的錯誤。
   */
  const request = async (
    start: number,
    end: number,
    signal: AbortSignal,
    onData: (chunk: Uint8Array) => void,
  ): Promise<string | null> => {
    const entry = { start, end, startedAt: performance.now() };
    inflight.add(entry);
    log.log('debug', 'io', 'Range 請求', { url, start, end });
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          ...(wire.credentials && { credentials: wire.credentials }),
          headers: { ...wire.headers, Range: `bytes=${String(start)}-${String(end)}` },
          signal,
        });
      } catch (error) {
        signal.throwIfAborted();
        // 網路中斷、CORS、DNS 在 fetch() 都是同一個 TypeError，分不出來。
        throw new WorkerError('SOURCE_NETWORK', `無法連線到 ${url}`, {
          detail: { url },
          cause: error,
        });
      }
      if (response.status !== 206) {
        await response.body?.cancel().catch(() => undefined);
        const { status } = response;
        throw new WorkerError(httpErrorCode(status), `${url} 回應 HTTP ${String(status)}`, {
          detail: { status, url },
        });
      }
      const expected = end - start + 1;
      let received = 0;
      const reader = response.body?.getReader();
      try {
        for (;;) {
          const chunk = reader ? await reader.read() : { done: true as const, value: undefined };
          if (chunk.done) break;
          if (received + chunk.value.length > expected) {
            throw new WorkerError('SOURCE_NETWORK', `${url} 的回應超出要求的範圍`, {
              detail: { url },
            });
          }
          received += chunk.value.length;
          bytesLoaded += chunk.value.length;
          onData(chunk.value);
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof WorkerError) throw error;
        throw new WorkerError('SOURCE_NETWORK', `讀取 ${url} 時連線中斷`, {
          detail: { url },
          cause: error,
        });
      } finally {
        reader?.cancel().catch(() => undefined);
      }
      if (received !== expected) {
        throw new WorkerError(
          'SOURCE_NETWORK',
          `${url} 的回應不完整：要求 ${String(expected)} bytes，收到 ${String(received)} bytes`,
          { detail: { url } },
        );
      }
      return response.headers.get('Content-Range');
    } finally {
      inflight.delete(entry);
    }
  };

  /** 以 `retry` 重試 5xx 與網路錯誤，從已經收到的位置接續；退避中的等待也以 `signal` 中止。 */
  const stream = async (
    start: number,
    end: number,
    signal: AbortSignal,
    onData: (chunk: Uint8Array) => void,
  ): Promise<string | null> => {
    let position = start;
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(position, end, signal, (chunk) => {
          position += chunk.length;
          onData(chunk);
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason as Error;
        if (error instanceof WorkerError) deps.onRequestError?.(error);
        const retrying = retryable(error) && attempt < retry.attempts;
        if (log.enabled('warn')) {
          const detail = error instanceof WorkerError ? error : null;
          log.log(
            'warn',
            'io',
            `請求失敗：${error instanceof Error ? error.message : String(error)}`,
            {
              url,
              start: position,
              end,
              code: detail?.code ?? 'INTERNAL',
              ...(detail?.detail?.status !== undefined && { status: detail.detail.status }),
              attempt: attempt + 1,
              retrying,
            },
          );
        }
        if (!retrying) throw error;
      }
      const delayMs = retry.baseDelayMs * 2 ** attempt;
      log.log('info', 'io', `${String(delayMs)} ms 後重試`, { url, retry: attempt + 1, delayMs });
      await sleep(delayMs, signal);
    }
  };

  let size = wire.size;
  if (size === undefined) {
    // 第一個 Range 回應的 Content-Range 帶著總大小。
    size = parseTotalSize(await stream(0, 0, signal, () => undefined));
    if (size === undefined) {
      throw new WorkerError('SOURCE_RANGE_UNSUPPORTED', `${url} 沒有回報檔案大小`, {
        detail: { url },
      });
    }
  }
  const total = size;

  return {
    url,
    size: total,
    async stream(start, end, signal, onData) {
      await stream(start, end, signal, onData);
    },
    get bytesLoaded() {
      return bytesLoaded;
    },
    inflight() {
      const now = performance.now();
      return [...inflight].map(({ start, end, startedAt }) => ({
        url,
        start,
        end,
        elapsedMs: now - startedAt,
      }));
    },
  };
}

const noRetry: RetryPolicy = { attempts: 0, baseDelayMs: 0 };

/** 只重試網路錯誤與 5xx。 */
export function retryable(error: unknown): boolean {
  if (!(error instanceof WorkerError)) return false;
  return error.code === 'SOURCE_NETWORK' || (error.detail?.status ?? 0) >= 500;
}

/**
 * 不是 206 的回應：200（伺服器忽略 Range）與 416 是 Range 不可用；401／403／404／410 各自分類；
 * 5xx 與其他狀態碼是 `SOURCE_SERVER`（只有 5xx 會重試）。
 */
function httpErrorCode(status: number): WorkerErrorCode {
  if (status >= 500) return 'SOURCE_SERVER';
  switch (status) {
    case 401:
      return 'SOURCE_UNAUTHORIZED';
    case 403:
      return 'SOURCE_FORBIDDEN';
    case 404:
    case 410:
      return 'SOURCE_NOT_FOUND';
    case 416:
      return 'SOURCE_RANGE_UNSUPPORTED';
    default:
      return status < 300 ? 'SOURCE_RANGE_UNSUPPORTED' : 'SOURCE_SERVER';
  }
}

/** 等 `ms` 毫秒；`signal` 中止時立即以它的 reason reject。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return abortable(
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
        },
        { once: true },
      );
    }),
    signal,
  );
}

/** `Content-Range: bytes 0-0/12345` 的 12345。 */
function parseTotalSize(header: string | null): number | undefined {
  const match = header && /\/(\d+)\s*$/.exec(header);
  return match ? Number(match[1]) : undefined;
}

/** `signal` 中止時以它的 reason reject，不等 `promise`。 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

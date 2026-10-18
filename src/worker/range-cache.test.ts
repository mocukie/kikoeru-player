import { afterEach, describe, expect, test, vi } from 'vitest';
import { WorkerError } from './errors.js';
import { BLOCK_BYTES, CachedSource, RangeCache } from './range-cache.js';
import type { RangeClient } from './source.js';

const B = BLOCK_BYTES;
const never = new AbortController().signal;

/** 一個 Range 請求：測試以 `deliver()`／`fail()` 決定它的結果。 */
interface FakeRequest {
  start: number;
  end: number;
  signal: AbortSignal;
  /** 送出 `[start + 已送出, start + 已送出 + bytes)` 的內容（每個 byte 是位置 mod 251）。 */
  deliver(bytes?: number): void;
  fail(error: Error): void;
  readonly settled: boolean;
}

/** 由測試控制的 `RangeClient`：記下每個請求，回覆的時機與內容都由測試決定。 */
function fakeClient(size: number): RangeClient & { requests: FakeRequest[] } {
  const requests: FakeRequest[] = [];
  return {
    url: 'https://x/a.wav',
    size,
    requests,
    bytesLoaded: 0,
    inflight: () => [],
    stream(start, end, signal, onData) {
      return new Promise<void>((resolve, reject) => {
        let sent = 0;
        let settled = false;
        const settle = () => {
          settled = true;
        };
        signal.addEventListener('abort', () => {
          settle();
          reject(signal.reason as Error);
        });
        requests.push({
          start,
          end,
          signal,
          get settled() {
            return settled;
          },
          deliver(bytes = end - start + 1 - sent) {
            if (settled) return;
            const from = start + sent;
            onData(Uint8Array.from({ length: bytes }, (_, i) => (from + i) % 251));
            sent += bytes;
            if (sent === end - start + 1) {
              settle();
              resolve();
            }
          },
          fail(error) {
            settle();
            reject(error);
          },
        });
      });
    },
  };
}

/** 位置 `offset` 起、長 `length` 的預期內容。 */
function expected(offset: number, length: number): number[] {
  return Array.from({ length }, (_, i) => (offset + i) % 251);
}

/** 讓 microtask 跑完（請求完成後的 cache 更新與等待者）。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function ranges(client: { requests: FakeRequest[] }): [number, number][] {
  return client.requests.map((r) => [r.start / B, (r.end + 1) / B]);
}

describe('RangeCache', () => {
  test('超過上限時淘汰最久沒用到的區塊；讀取會更新順序', () => {
    const cache = new RangeCache(3 * B);
    const block = () => new Uint8Array(B);
    cache.put(1, 0, block());
    cache.put(1, 1, block());
    cache.put(1, 2, block());
    cache.get(1, 0);
    cache.put(1, 3, block());
    expect([0, 1, 2, 3].map((i) => cache.has(1, i))).toEqual([true, false, true, true]);
    expect(cache.bytes).toBe(3 * B);
  });

  test('不同來源的區塊共用同一個上限', () => {
    const cache = new RangeCache(2 * B);
    cache.put(1, 0, new Uint8Array(B));
    cache.put(2, 0, new Uint8Array(B));
    cache.put(2, 1, new Uint8Array(B));
    expect(cache.has(1, 0)).toBe(false);
    expect(cache.has(2, 0) && cache.has(2, 1)).toBe(true);
  });

  test('drop() 移除一個來源的所有區塊', () => {
    const cache = new RangeCache(4 * B);
    cache.put(1, 0, new Uint8Array(B));
    cache.put(2, 0, new Uint8Array(B));
    cache.drop(1);
    expect(cache.has(1, 0)).toBe(false);
    expect(cache.bytes).toBe(B);
  });
});

describe('CachedSource 的讀取', () => {
  test('隨機讀只請求涵蓋的區塊，之後同一個區塊命中快取', async () => {
    const client = fakeClient(10 * B);
    const cache = new RangeCache(100 * B);
    const source = new CachedSource(client, cache);
    const reading = source.read(3 * B + 10, 100, never);
    expect(ranges(client)).toEqual([[3, 4]]);
    client.requests[0]?.deliver();
    expect([...(await reading)]).toEqual(expected(3 * B + 10, 100));

    expect([...(await source.read(3 * B + 500, 10, never))]).toEqual(expected(3 * B + 500, 10));
    expect(client.requests).toHaveLength(1);
    expect(cache).toMatchObject({ hits: 1, misses: 1 });
  });

  test('還沒開始預讀（開檔、probe）時，循序讀也一次請求一個區塊', async () => {
    const client = fakeClient(40 * B);
    const source = new CachedSource(client, new RangeCache(100 * B));
    const first = source.read(0, B, never);
    client.requests[0]?.deliver();
    await first;
    const next = source.read(B, B, never);
    expect(ranges(client)).toEqual([
      [0, 1],
      [1, 2],
    ]);
    client.requests[1]?.deliver();
    expect([...(await next)]).toEqual(expected(B, B));
  });

  test('請求中的第一個區塊到了就交出，不等整個請求', async () => {
    vi.useFakeTimers();
    const client = fakeClient(40 * B);
    const source = new CachedSource(client, new RangeCache(100 * B));
    const first = source.read(0, B, never);
    client.requests[0]?.deliver();
    await first;
    source.setReadahead(20 * B);
    client.requests[1]?.fail(new WorkerError('SOURCE_NETWORK', 'offline'));
    await vi.advanceTimersByTimeAsync(0);
    // 預讀暫停中：讀取自己發出合併的請求。
    const next = source.read(B, B, never);
    expect(ranges(client).at(-1)).toEqual([1, 9]);
    client.requests.at(-1)?.deliver(B);
    expect([...(await next)]).toEqual(expected(B, B));
    vi.useRealTimers();
  });

  test('區塊已在請求中時等它，不重複請求', async () => {
    const client = fakeClient(40 * B);
    const source = new CachedSource(client, new RangeCache(100 * B));
    const first = source.read(0, 10, never);
    const second = source.read(5, 10, never);
    expect(client.requests).toHaveLength(1);
    client.requests[0]?.deliver();
    expect([...(await second)]).toEqual(expected(5, 10));
    await first;
  });

  test('讀取被中止時立即以 AbortError reject', async () => {
    const client = fakeClient(10 * B);
    const source = new CachedSource(client, new RangeCache(100 * B));
    const controller = new AbortController();
    const reading = source.read(0, 10, controller.signal);
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('請求失敗時讀取以同一個錯誤 reject', async () => {
    const client = fakeClient(10 * B);
    const source = new CachedSource(client, new RangeCache(100 * B));
    const reading = source.read(0, 10, never);
    const error = new WorkerError('SOURCE_NETWORK', 'offline');
    client.requests[0]?.fail(error);
    await expect(reading).rejects.toBe(error);
  });

  test('abort() 中止所有進行中的請求；等著它的讀取改發新的請求', async () => {
    const client = fakeClient(10 * B);
    const source = new CachedSource(client, new RangeCache(100 * B));
    const reading = source.read(0, 10, never);
    source.abort();
    expect(client.requests[0]?.signal.aborted).toBe(true);
    await settle();
    expect(client.requests).toHaveLength(2);
    client.requests[1]?.deliver();
    expect([...(await reading)]).toEqual(expected(0, 10));
  });
});

describe('預讀', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 開檔後讀過第一個區塊，預讀從 `B` 開始。 */
  async function started(options: { size?: number; cacheBytes?: number; target: number }) {
    const client = fakeClient(options.size ?? 100 * B);
    const cache = new RangeCache(options.cacheBytes ?? 1000 * B);
    const source = new CachedSource(client, cache);
    const first = source.read(0, B, never);
    client.requests[0]?.deliver();
    await first;
    source.setReadahead(options.target);
    return { client, cache, source };
  }

  test('從播放位置往後抓到目標就停', async () => {
    const { client, source } = await started({ target: 20 * B });
    // 最多 2 MiB 一個請求，同時兩個。
    expect(ranges(client).slice(1)).toEqual([
      [1, 9],
      [9, 17],
    ]);
    expect(source.fetching).toBe(true);
    client.requests[1]?.deliver();
    await settle();
    expect(ranges(client).slice(3)).toEqual([[17, 21]]);
    client.requests[2]?.deliver();
    client.requests[3]?.deliver();
    await settle();
    expect(source.aheadBytes).toBe(20 * B);
    expect(source.fetching).toBe(false);
    expect(client.requests).toHaveLength(4);
  });

  test('hysteresis：播放位置往前、預讀掉到目標的一半以下才恢復抓取', async () => {
    const { client, source } = await started({ target: 8 * B });
    client.requests[1]?.deliver();
    await settle();
    expect(source.aheadBytes).toBe(8 * B);

    await source.read(4 * B, B, never);
    expect(source.aheadBytes).toBe(4 * B);
    expect(client.requests).toHaveLength(2);

    await source.read(5 * B, B, never);
    expect(source.aheadBytes).toBe(3 * B);
    expect(source.fetching).toBe(true);
    expect(ranges(client).slice(2)).toEqual([[9, 14]]);
  });

  test('單一來源的預讀最多用掉 cacheBytes 的 75%', async () => {
    const { client, source } = await started({ target: 1000 * B, cacheBytes: 16 * B });
    expect(source.readaheadTarget).toBe(12 * B);
    expect(ranges(client).slice(1)).toEqual([
      [1, 9],
      [9, 13],
    ]);
  });

  test('目標超過檔尾時抓到檔尾就停', async () => {
    const { client, source } = await started({ size: 3 * B + 100, target: 50 * B });
    expect(client.requests[1]).toMatchObject({ start: B, end: 3 * B + 99 });
    client.requests[1]?.deliver();
    await settle();
    expect(source.aheadBytes).toBe(2 * B + 100);
    expect(source.fetching).toBe(false);
  });

  test('預讀中的區塊被讀取時，讀取等它，不另外請求', async () => {
    const { client, source } = await started({ target: 8 * B });
    const reading = source.read(2 * B, 10, never);
    // 預讀的視窗跟著位置往後移，但不重複請求已在請求中的區塊。
    expect(client.requests.slice(2).every((r) => r.start >= 9 * B)).toBe(true);
    client.requests[1]?.deliver(2 * B);
    expect([...(await reading)]).toEqual(expected(2 * B, 10));
  });

  test('預讀遇到不可重試的錯誤：之後需要網路的讀取直接以它 reject，快取內的照常讀', async () => {
    const { client, source } = await started({ target: 8 * B });
    const error = new WorkerError('SOURCE_UNAUTHORIZED', '401', { detail: { status: 401 } });
    client.requests[1]?.deliver(2 * B);
    client.requests[1]?.fail(error);
    await settle();
    expect([...(await source.read(2 * B, 10, never))]).toEqual(expected(2 * B, 10));
    await expect(source.read(3 * B, 10, never)).rejects.toBe(error);
    expect(client.requests).toHaveLength(2);
  });

  test('預讀遇到可重試的錯誤：過一段時間再抓；讀取自己發請求', async () => {
    vi.useFakeTimers();
    const { client, source } = await started({ target: 8 * B });
    client.requests[1]?.fail(new WorkerError('SOURCE_NETWORK', 'offline'));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.requests).toHaveLength(2);

    const reading = source.read(B, 10, never);
    expect(ranges(client)[2]).toEqual([1, 9]);
    client.requests[2]?.deliver();
    await reading;

    // 暫停期間不預讀；之後從目標內缺的區塊接著抓。
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.requests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1500);
    expect(ranges(client).slice(3)).toEqual([[9, 10]]);
  });

  test('abort() 之後等下一個讀取決定新的位置才重新預讀', async () => {
    const { client, source } = await started({ target: 8 * B });
    source.abort();
    await settle();
    expect(client.requests).toHaveLength(2);
    const reading = source.read(50 * B, 10, never);
    expect(ranges(client).slice(2)).toEqual([
      [50, 51],
      [51, 59],
    ]);
    client.requests[2]?.deliver();
    await reading;
  });

  test('有讀取時以設定的預讀目標合併循序讀的請求', async () => {
    const { client, source } = await started({ target: B });
    // 預讀目標 1 個區塊：預讀先抓了第 2 個區塊；讀到第 3 個區塊時只請求到播放位置之後 1 個區塊，不是 2 MiB。
    expect(ranges(client).slice(1)).toEqual([[1, 2]]);
    client.requests[1]?.deliver();
    await settle();
    const reading = source.read(2 * B, 10, never);
    expect(ranges(client).slice(2)).toEqual([[2, 4]]);
    client.requests[2]?.deliver();
    await reading;
  });

  test('close() 中止請求、移除快取，之後不再預讀', async () => {
    const { client, cache, source } = await started({ target: 8 * B });
    source.close();
    expect(client.requests[1]?.signal.aborted).toBe(true);
    expect(cache.bytes).toBe(0);
    await settle();
    expect(client.requests).toHaveLength(2);
  });
});

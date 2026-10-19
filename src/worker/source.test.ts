import { afterEach, describe, expect, test, vi } from 'vitest';
import { WorkerError } from './errors.js';
import type { Logger } from './log.js';
import { openSource } from './source.js';

const never = new AbortController().signal;

function bytes(length: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_, i) => i % 256);
}

describe('bytes', () => {
  test('大小與任意位置的讀取；超出結尾的部分截掉', async () => {
    const source = await openSource({ kind: 'bytes', data: bytes(100).buffer }, never);
    expect(source.size).toBe(100);
    expect([...(await source.read(10, 3, never))]).toEqual([10, 11, 12]);
    expect((await source.read(95, 10, never)).length).toBe(5);
  });

  test('Uint8Array 只取它自己的範圍', async () => {
    const view = bytes(100).subarray(20, 30);
    const source = await openSource({ kind: 'bytes', data: view }, never);
    expect(source.size).toBe(10);
    expect([...(await source.read(0, 2, never))]).toEqual([20, 21]);
  });
});

describe('blob', () => {
  test('大小與讀取', async () => {
    const source = await openSource({ kind: 'blob', blob: new Blob([bytes(50)]) }, never);
    expect(source.size).toBe(50);
    expect([...(await source.read(48, 10, never))]).toEqual([48, 49]);
  });

  test('已中止的讀取以 AbortError reject', async () => {
    const source = await openSource({ kind: 'blob', blob: new Blob([bytes(50)]) }, never);
    const aborted = AbortSignal.abort();
    await expect(source.read(0, 10, aborted)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('http', () => {
  function respond(
    status: number,
    body: Uint8Array<ArrayBuffer>,
    headers: Record<string, string> = {},
  ) {
    return new Response(status === 204 ? null : body, { status, headers });
  }

  test('沒有給大小時以 Range 讀第一個 byte，從 Content-Range 取得大小', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(respond(206, bytes(1), { 'Content-Range': 'bytes 0-0/12345' })),
    );
    const source = await openSource({ kind: 'http', url: 'https://x/a.mp3' }, never, { fetch });
    expect(source.size).toBe(12345);
    expect(fetch).toHaveBeenCalledWith(
      'https://x/a.mp3',
      expect.objectContaining({ headers: { Range: 'bytes=0-0' } }),
    );
  });

  test('給了大小就不另外請求；讀取帶 Range、credentials、headers 與 signal', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(respond(206, bytes(4), { 'Content-Range': 'bytes 10-13/100' })),
    );
    const source = await openSource(
      {
        kind: 'http',
        url: 'https://x/a.mp3',
        size: 100,
        credentials: 'include',
        headers: { Authorization: 'Bearer t' },
      },
      never,
      { fetch },
    );
    expect(source.size).toBe(100);
    expect(fetch).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    expect((await source.read(10, 4, signal)).length).toBe(4);
    expect(fetch).toHaveBeenCalledWith('https://x/a.mp3', {
      credentials: 'include',
      headers: { Authorization: 'Bearer t', Range: 'bytes=10-13' },
      signal,
    });
  });

  test('讀取的範圍夾在檔案結尾之前', async () => {
    const fetch = vi.fn(() => Promise.resolve(respond(206, bytes(5))));
    const source = await openSource({ kind: 'http', url: 'u', size: 100 }, never, { fetch });
    await source.read(95, 50, never);
    expect(fetch).toHaveBeenCalledWith(
      'u',
      expect.objectContaining({ headers: { Range: 'bytes=95-99' } }),
    );
  });

  test.each([
    [401, 'SOURCE_UNAUTHORIZED'],
    [403, 'SOURCE_FORBIDDEN'],
    [404, 'SOURCE_NOT_FOUND'],
    [503, 'SOURCE_SERVER'],
  ])('HTTP %i 為 %s', async (status, code) => {
    const fetch = () => Promise.resolve(respond(status, new Uint8Array()));
    const opening = openSource({ kind: 'http', url: 'u' }, never, { fetch });
    await expect(opening).rejects.toBeInstanceOf(WorkerError);
    await expect(opening).rejects.toMatchObject({ code, detail: { status, url: 'u' } });
  });

  test('伺服器不支援 Range（回 200）為 SOURCE_RANGE_UNSUPPORTED', async () => {
    const fetch = () => Promise.resolve(respond(200, bytes(10)));
    await expect(openSource({ kind: 'http', url: 'u' }, never, { fetch })).rejects.toMatchObject({
      code: 'SOURCE_RANGE_UNSUPPORTED',
    });
  });

  test('網路錯誤為 SOURCE_NETWORK', async () => {
    const fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const source = await openSource({ kind: 'http', url: 'u', size: 10 }, never, { fetch });
    await expect(source.read(0, 1, never)).rejects.toMatchObject({ code: 'SOURCE_NETWORK' });
  });

  test('被中止的讀取以 AbortError reject，不轉成錯誤碼', async () => {
    const fetch = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const source = await openSource({ kind: 'http', url: 'u', size: 10 }, never, { fetch });
    const controller = new AbortController();
    const reading = source.read(0, 1, controller.signal);
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('http 的重試', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const ok = () =>
    new Response(bytes(4), { status: 206, headers: { 'Content-Range': 'bytes 0-3/100' } });
  const status = (code: number) => new Response(null, { status: code });
  const offline = () => Promise.reject(new TypeError('Failed to fetch'));

  /** 依序回覆 `replies`，用完之後一直重複最後一個；記下每次請求的時刻。 */
  function scripted(...replies: (() => Promise<Response> | Response)[]) {
    const calls: number[] = [];
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() => {
      calls.push(Date.now());
      const reply = replies[Math.min(calls.length, replies.length) - 1];
      if (!reply) return Promise.reject(new Error('沒有回覆'));
      return Promise.resolve().then(reply);
    });
    return { fetch, calls };
  }

  function open(
    fetch: (url: string, init: RequestInit) => Promise<Response>,
    retry = { attempts: 3, baseDelayMs: 100 },
  ) {
    return openSource({ kind: 'http', url: 'https://x/a.wav', size: 100 }, never, {
      fetch,
      retry,
    });
  }

  test('5xx 之後以退避重試，成功就回傳資料', async () => {
    vi.useFakeTimers({ now: 0 });
    const { fetch, calls } = scripted(() => status(503), ok);
    const source = await open(fetch);
    const reading = source.read(0, 4, never);
    await vi.advanceTimersByTimeAsync(99);
    expect(calls).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect((await reading).length).toBe(4);
    expect(calls).toEqual([0, 100]);
  });

  test('請求、失敗與重試都有 io 的 log', async () => {
    vi.useFakeTimers({ now: 0 });
    const { fetch } = scripted(() => status(503), ok);
    const entries: { level: string; scope: string; data?: Record<string, unknown> }[] = [];
    const log: Logger = {
      enabled: () => true,
      log: (level, scope, _message, data) => entries.push({ level, scope, ...(data && { data }) }),
    };
    const source = await openSource({ kind: 'http', url: 'https://x/a.wav', size: 100 }, never, {
      fetch,
      retry: { attempts: 3, baseDelayMs: 100 },
      log,
    });
    const reading = source.read(0, 4, never);
    await vi.advanceTimersByTimeAsync(100);
    await reading;
    expect(entries).toEqual([
      { level: 'debug', scope: 'io', data: { url: 'https://x/a.wav', start: 0, end: 3 } },
      {
        level: 'warn',
        scope: 'io',
        data: expect.objectContaining({
          code: 'SOURCE_SERVER',
          status: 503,
          attempt: 1,
        }) as unknown,
      },
      { level: 'info', scope: 'io', data: { url: 'https://x/a.wav', retry: 1, delayMs: 100 } },
      { level: 'debug', scope: 'io', data: { url: 'https://x/a.wav', start: 0, end: 3 } },
    ]);
  });

  test('每次退避加倍；用完重試次數就回報最後一次的錯誤', async () => {
    vi.useFakeTimers({ now: 0 });
    const { fetch, calls } = scripted(() => status(502));
    const source = await open(fetch);
    const settled = expect(source.read(0, 4, never)).rejects.toMatchObject({
      code: 'SOURCE_SERVER',
      detail: { status: 502, url: 'https://x/a.wav' },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    expect(calls).toEqual([0, 100, 300, 700]);
  });

  test('網路錯誤也重試，用完後為 SOURCE_NETWORK', async () => {
    vi.useFakeTimers({ now: 0 });
    const { fetch, calls } = scripted(offline);
    const source = await open(fetch, { attempts: 2, baseDelayMs: 10 });
    const settled = expect(source.read(0, 4, never)).rejects.toMatchObject({
      code: 'SOURCE_NETWORK',
      detail: { url: 'https://x/a.wav' },
    });
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
    expect(calls).toEqual([0, 10, 30]);
  });

  test('body 讀到一半斷線是網路錯誤，重試後恢復', async () => {
    vi.useFakeTimers({ now: 0 });
    const broken = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new TypeError('network error'));
          },
        }),
        { status: 206 },
      );
    const { fetch, calls } = scripted(broken, ok);
    const source = await open(fetch);
    const reading = source.read(0, 4, never);
    await vi.advanceTimersByTimeAsync(100);
    expect((await reading).length).toBe(4);
    expect(calls).toHaveLength(2);
  });

  test('body 比要求的範圍短是網路錯誤，重試從已經收到的位置接續', async () => {
    vi.useFakeTimers({ now: 0 });
    const head = () => new Response(Uint8Array.of(10, 11), { status: 206 });
    const tail = () => new Response(Uint8Array.of(12, 13), { status: 206 });
    const { fetch, calls } = scripted(head, tail);
    const source = await open(fetch);
    const reading = source.read(0, 4, never);
    await vi.advanceTimersByTimeAsync(100);
    expect([...(await reading)]).toEqual([10, 11, 12, 13]);
    expect(calls).toHaveLength(2);
    expect(fetch.mock.calls[1]?.[1].headers).toEqual({ Range: 'bytes=2-3' });
  });

  test('body 超出要求的範圍是網路錯誤', async () => {
    const { fetch } = scripted(() => new Response(bytes(8), { status: 206 }));
    const source = await open(fetch, { attempts: 0, baseDelayMs: 0 });
    await expect(source.read(0, 4, never)).rejects.toMatchObject({ code: 'SOURCE_NETWORK' });
  });

  test('整段都收到之後才斷線：資料完整，不再發出請求', async () => {
    let sent = false;
    const complete = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) {
              controller.error(new TypeError('network error'));
              return;
            }
            sent = true;
            controller.enqueue(Uint8Array.of(10, 11, 12, 13));
          },
        }),
        { status: 206 },
      );
    const { fetch, calls } = scripted(complete, () => status(416));
    const source = await open(fetch);
    expect([...(await source.read(0, 4, never))]).toEqual([10, 11, 12, 13]);
    expect(calls).toHaveLength(1);
  });

  test('每個失敗的請求都交給 onRequestError，包括之後重試成功的', async () => {
    vi.useFakeTimers({ now: 0 });
    const { fetch } = scripted(() => status(503), ok);
    const errors: unknown[] = [];
    const source = await openSource({ kind: 'http', url: 'u', size: 100 }, never, {
      fetch,
      retry: { attempts: 3, baseDelayMs: 10 },
      onRequestError: (error) => errors.push(error),
    });
    const reading = source.read(0, 4, never);
    await vi.advanceTimersByTimeAsync(10);
    await reading;
    expect(errors).toMatchObject([{ code: 'SOURCE_SERVER', detail: { status: 503 } }]);
  });

  test.each([
    [401, 'SOURCE_UNAUTHORIZED'],
    [403, 'SOURCE_FORBIDDEN'],
    [404, 'SOURCE_NOT_FOUND'],
    [410, 'SOURCE_NOT_FOUND'],
    [200, 'SOURCE_RANGE_UNSUPPORTED'],
    [416, 'SOURCE_RANGE_UNSUPPORTED'],
    [429, 'SOURCE_SERVER'],
  ])('HTTP %i（%s）不重試', async (code, expected) => {
    const { fetch } = scripted(() => (code === 200 ? new Response(bytes(100)) : status(code)), ok);
    const source = await open(fetch);
    await expect(source.read(0, 4, never)).rejects.toMatchObject({
      code: expected,
      detail: { status: code, url: 'https://x/a.wav' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('attempts 為 0 時不重試', async () => {
    const { fetch } = scripted(() => status(500), ok);
    const source = await open(fetch, { attempts: 0, baseDelayMs: 100 });
    await expect(source.read(0, 4, never)).rejects.toMatchObject({ code: 'SOURCE_SERVER' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('退避中被中止：立即以 AbortError reject，不再發出請求', async () => {
    vi.useFakeTimers({ now: 0 });
    const { fetch } = scripted(() => status(503), ok);
    const source = await open(fetch, { attempts: 3, baseDelayMs: 1000 });
    const controller = new AbortController();
    const settled = expect(source.read(0, 4, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await settled;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('沒有給大小時，探測大小的請求也會重試', async () => {
    vi.useFakeTimers({ now: 0 });
    const { fetch } = scripted(
      offline,
      () =>
        new Response(bytes(1), { status: 206, headers: { 'Content-Range': 'bytes 0-0/12345' } }),
    );
    const opening = openSource({ kind: 'http', url: 'u' }, never, {
      fetch,
      retry: { attempts: 1, baseDelayMs: 50 },
    });
    await vi.advanceTimersByTimeAsync(50);
    expect((await opening).size).toBe(12345);
  });

  test('206 沒有 Content-Range 的總大小時為 SOURCE_RANGE_UNSUPPORTED', async () => {
    const fetch = () => Promise.resolve(new Response(bytes(1), { status: 206 }));
    await expect(openSource({ kind: 'http', url: 'u' }, never, { fetch })).rejects.toMatchObject({
      code: 'SOURCE_RANGE_UNSUPPORTED',
      detail: { url: 'u' },
    });
  });
});

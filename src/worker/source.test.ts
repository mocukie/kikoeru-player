import { describe, expect, test, vi } from 'vitest';
import { WorkerError } from './errors.js';
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

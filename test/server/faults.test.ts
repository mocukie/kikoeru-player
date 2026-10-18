// test/server 的故障注入：以 node:http 掛上 `/media/*` 的 handler，對暫存目錄的檔案發請求。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { serveMedia } from './index.ts';

const SIZE = 64 * 1024;
const content = Uint8Array.from({ length: SIZE }, (_, i) => i % 251);

let dir: string;
let server: Server;
let base: string;
let seq = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kikoeru-faults-'));
  await writeFile(join(dir, 'a.bin'), content);
  const handle = serveMedia(dir);
  server = createServer((req, res) => {
    handle(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true });
});

/** 每個測試一個新的 URL，故障的計數互不影響。 */
function url(query: string): string {
  return `${base}/a.bin?id=${String(++seq)}&${query}`;
}

function range(target: string, start: number, end: number, signal?: AbortSignal) {
  return fetch(target, { headers: { Range: `bytes=${String(start)}-${String(end)}` }, signal });
}

describe('狀態碼', () => {
  test('503@2：只有第 2 個請求回應 503', async () => {
    const target = url('fault=503@2');
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await range(target, 0, 9)).status);
    expect(statuses).toEqual([206, 503, 206]);
  });

  test('401@2+：第 2 個以後的請求都回應 401', async () => {
    const target = url('fault=401@2%2B');
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await range(target, 0, 9)).status);
    expect(statuses).toEqual([206, 401, 401]);
  });

  test('200@1：忽略 Range、回應整個檔案', async () => {
    const response = await range(url('fault=200@1'), 0, 9);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(SIZE);
  });

  test('多個故障以逗號分隔', async () => {
    const target = url('fault=503@1,404@2');
    expect((await range(target, 0, 0)).status).toBe(503);
    expect((await range(target, 0, 0)).status).toBe(404);
    expect((await range(target, 0, 0)).status).toBe(206);
  });

  test('有故障參數的回應不讓瀏覽器快取', async () => {
    const response = await range(url('fault=503@9'), 0, 0);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('ETag')).toBeNull();
  });
});

describe('drop', () => {
  test('drop@16KB：第一個跨過 16 KiB 的回應送到那裡就斷線，之後正常', async () => {
    const target = url('fault=drop@16KB');
    const first = await range(target, 0, SIZE - 1);
    expect(first.status).toBe(206);
    await expect(first.arrayBuffer()).rejects.toThrow();

    const second = await range(target, 0, SIZE - 1);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(content);
  });

  test('沒有跨過該位置的回應不受影響', async () => {
    const target = url('fault=drop@16KB');
    const response = await range(target, 0, 1023);
    expect((await response.arrayBuffer()).byteLength).toBe(1024);
  });

  test('drop@16KB+：每個跨過的回應都斷線', async () => {
    const target = url('fault=drop@16KB%2B');
    for (let i = 0; i < 2; i++) {
      await expect((await range(target, 8192, SIZE - 1)).arrayBuffer()).rejects.toThrow();
    }
  });
});

describe('stall', () => {
  test('stall@16KB：送到 16 KiB 就停住，連線保持開著直到 client 中止', async () => {
    const controller = new AbortController();
    const response = await range(url('fault=stall@16KB'), 0, SIZE - 1, controller.signal);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('沒有 body');
    let received = 0;
    const reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return 'done';
        received += value.length;
      }
    })();
    await expect.poll(() => received).toBe(16 * 1024);
    const settled = await Promise.race([
      reading,
      new Promise((resolve) => setTimeout(resolve, 200, 'pending')),
    ]);
    expect(settled).toBe('pending');
    controller.abort();
    await expect(reading).rejects.toThrow();
  });

  test('stall@0：連一個 byte 都不送', async () => {
    const controller = new AbortController();
    const response = await range(url('fault=stall@0'), 0, 9, controller.signal);
    expect(response.status).toBe(206);
    const body = response.arrayBuffer();
    const settled = await Promise.race([
      body.then(() => 'done'),
      new Promise((resolve) => setTimeout(resolve, 200, 'pending')),
    ]);
    expect(settled).toBe('pending');
    controller.abort();
    await expect(body).rejects.toThrow();
  });
});

test('delay=100：每個回應延遲 100 ms', async () => {
  const target = url('delay=100');
  const started = performance.now();
  const response = await range(target, 0, 9);
  expect(performance.now() - started).toBeGreaterThanOrEqual(95);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(content.subarray(0, 10));
});

test('沒有故障參數時照常提供 Range', async () => {
  const response = await range(`${base}/a.bin`, 10, 19);
  expect(response.status).toBe(206);
  expect(response.headers.get('Content-Range')).toBe(`bytes 10-19/${String(SIZE)}`);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(content.subarray(10, 20));
});

test('不認得的故障參數回應 400，訊息指出哪一個', async () => {
  const response = await range(url('fault=boom@1'), 0, 0);
  expect(response.status).toBe(400);
  expect(await response.text()).toContain('boom@1');
});

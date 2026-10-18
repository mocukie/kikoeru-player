import { describe, expect, test } from 'vitest';
import type { WorkerBufferMessage } from '../protocol/index.js';
import { BufferTracker } from './buffer-tracker.js';
import { BLOCK_BYTES, CachedSource, RangeCache } from './range-cache.js';
import type { ByteSource, RangeClient } from './source.js';

const B = BLOCK_BYTES;
const never = new AbortController().signal;

/** 每個請求立即回覆完整內容的 `RangeClient`，記下請求的範圍。 */
function instantClient(size: number): RangeClient & { ranges: [number, number][] } {
  const ranges: [number, number][] = [];
  return {
    url: 'u',
    size,
    ranges,
    bytesLoaded: 0,
    inflight: () => [],
    stream(start, end, _signal, onData) {
      ranges.push([start, end]);
      onData(new Uint8Array(end - start + 1));
      return Promise.resolve();
    },
  };
}

function setup(options: { size?: number; duration?: number; byteRate?: number } = {}) {
  const size = options.size ?? 100 * B;
  const client = instantClient(size);
  const source = new CachedSource(client, new RangeCache(1000 * B));
  const posted: WorkerBufferMessage[] = [];
  const tracker = new BufferTracker({
    source,
    size,
    duration: options.duration ?? 100,
    byteRate: options.byteRate ?? B,
    readaheadSeconds: 10,
    post: (m) => posted.push(m),
  });
  return { client, source, posted, tracker };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('BufferTracker', () => {
  test('輸出開始時以「預讀秒數 × 位元組率」開始預讀', async () => {
    const { source, tracker, client } = setup();
    await source.read(0, B, never);
    tracker.start(1, 0);
    await settle();
    expect(source.readaheadTarget).toBe(10 * B);
    expect(client.ranges.at(-1)).toEqual([9 * B, 11 * B - 1]);
  });

  test('第一次 demux 之後才送出；終點是 demux 的進度加上預讀 bytes 換算的秒數', async () => {
    const { source, tracker, posted } = setup();
    await source.read(0, B, never);
    tracker.start(3, 0);
    await settle();
    expect(posted).toEqual([]);
    tracker.onDemux(3, 0.5, false);
    expect(posted.at(-1)).toEqual({
      type: 'buffer',
      epoch: 3,
      end: 10.5,
      eof: false,
      fetching: false,
    });
  });

  test('預讀到檔尾時 eof，終點是 duration', async () => {
    const { source, tracker, posted } = setup({ size: 5 * B, duration: 20 });
    await source.read(0, B, never);
    tracker.start(1, 0);
    await settle();
    tracker.onDemux(1, 1, false);
    expect(posted.at(-1)).toMatchObject({ end: 20, eof: true });
  });

  test('demux 到結尾時 eof', async () => {
    const { source, tracker, posted } = setup();
    await source.read(0, B, never);
    tracker.start(1, 0);
    tracker.onDemux(1, 3, true);
    expect(posted.at(-1)).toMatchObject({ end: 100, eof: true });
  });

  test('舊 epoch 的 demux 進度不送出', async () => {
    const { source, tracker, posted } = setup();
    await source.read(0, B, never);
    tracker.start(1, 0);
    tracker.start(2, 50);
    tracker.onDemux(1, 3, false);
    expect(posted).toEqual([]);
  });

  test('位元組率依讀取位置修正後，預讀目標跟著改變', async () => {
    const { source, tracker } = setup({ byteRate: B });
    await source.read(0, B, never);
    tracker.start(1, 0);
    tracker.onRead(B);
    tracker.onDemux(1, 1, false);
    tracker.onRead(5 * B);
    tracker.onDemux(1, 2, false);
    tracker.onRead(9 * B);
    expect(source.readaheadTarget).toBe(40 * B);
  });

  test('bytes／blob 來源：終點是 duration，一律 eof', () => {
    const local: ByteSource = { size: 100, read: () => Promise.resolve(new Uint8Array()) };
    const posted: WorkerBufferMessage[] = [];
    const tracker = new BufferTracker({
      source: local,
      size: 100,
      duration: 8,
      byteRate: 10,
      readaheadSeconds: 60,
      post: (m) => posted.push(m),
    });
    tracker.start(1, 0);
    tracker.onDemux(1, 0.5, false);
    expect(posted).toEqual([{ type: 'buffer', epoch: 1, end: 8, eof: true, fetching: false }]);
  });
});

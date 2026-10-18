import { describe, expect, test } from 'vitest';
import { WorkerError } from './errors.js';
import { PacketQueue } from './packet-queue.js';

/** 測試用的封包：所屬的軌、時間（秒）、時長與大小。 */
interface P {
  time: number;
  duration: number;
  bytes: number;
}

const measure = (p: P) => p.bytes;
const timing = (p: P) => ({ time: p.time, duration: p.duration });

/** 從 `from` 秒起每 `step` 秒一個、每個 `bytes` 的封包。 */
function packets(from: number, count: number, step = 0.1, bytes = 1000): P[] {
  return Array.from({ length: count }, (_, i) => ({
    time: from + i * step,
    duration: step,
    bytes,
  }));
}

const MiB = 1024 * 1024;

function queue(streams: number[], hardBytes = 64 * MiB) {
  return new PacketQueue<P>(streams, { seconds: 2, bytes: 8 * MiB, hardBytes }, measure, timing);
}

describe('PacketQueue', () => {
  test('平常到 2 秒就滿了，不再 demux', () => {
    const q = queue([1]);
    q.push(1, packets(0, 19));
    expect(q.full).toBe(false);
    q.push(1, packets(1.9, 1));
    expect(q.full).toBe(true);
    expect(q.seconds(1)).toBeCloseTo(2, 9);
  });

  test('bytes 先到 8 MiB 時以 bytes 為準', () => {
    const q = queue([1]);
    q.push(1, packets(0, 4, 0.1, 2 * MiB));
    expect(q.seconds(1)).toBeCloseTo(0.4, 9);
    expect(q.full).toBe(true);
  });

  test('取出封包後不滿就繼續 demux', () => {
    const q = queue([1]);
    q.push(1, packets(0, 20));
    q.shift(1);
    expect(q.full).toBe(false);
    expect(q.bytes).toBe(19_000);
  });

  test('交錯不良：某條選用中的軌是空的就繼續 demux，超過平常的上限也一樣', () => {
    const q = queue([1, 2]);
    q.push(2, packets(0, 50, 0.1, 200 * 1024));
    expect(q.seconds(2)).toBeCloseTo(5, 9);
    expect(q.full).toBe(false);
    q.push(1, packets(0, 1));
    expect(q.full).toBe(true);
  });

  test('超過硬上限時以 MEMORY_LIMIT 失敗', () => {
    const q = queue([1, 2], 1 * MiB);
    q.push(2, packets(0, 5, 0.1, 200 * 1024));
    let error: unknown;
    try {
      q.push(2, packets(0.5, 1, 0.1, 200 * 1024));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WorkerError);
    expect(error).toMatchObject({ code: 'MEMORY_LIMIT' });
  });

  test('依軌道各自先進先出；沒有封包時回傳 undefined', () => {
    const q = queue([1, 2]);
    const [a, b] = packets(0, 2) as [P, P];
    q.push(1, [a, b]);
    q.push(2, packets(5, 1));
    expect(q.shift(1)).toBe(a);
    expect(q.shift(1)).toBe(b);
    expect(q.shift(1)).toBeUndefined();
    expect(q.seconds(2)).toBeCloseTo(0.1, 9);
  });

  test('沒有時間戳的封包以時長累計秒數', () => {
    const q = new PacketQueue<P>(
      [1],
      { seconds: 2, bytes: 8 * MiB, hardBytes: 64 * MiB },
      measure,
      (p) => ({ time: null, duration: p.duration }),
    );
    q.push(1, packets(0, 5, 0.25));
    expect(q.seconds(1)).toBeCloseTo(1.25, 9);
  });

  test('等待：有封包、結束或失敗時醒來', async () => {
    const q = queue([1]);
    const waiting = q.next(1, new AbortController().signal);
    q.push(1, packets(3, 1));
    expect(await waiting).toMatchObject({ time: 3 });

    const ending = q.next(1, new AbortController().signal);
    q.end();
    expect(await ending).toBeUndefined();

    const failing = queue([1]);
    const error = new Error('demux 失敗');
    const pending = failing.next(1, new AbortController().signal);
    failing.fail(error);
    await expect(pending).rejects.toBe(error);
  });

  test('等空間：不滿時醒來；被中止時以 signal 的 reason reject', async () => {
    const q = queue([1]);
    q.push(1, packets(0, 20));
    const waiting = q.space(new AbortController().signal);
    q.shift(1);
    await waiting;

    q.push(1, packets(2, 1));
    const controller = new AbortController();
    const aborted = q.space(controller.signal);
    controller.abort(new DOMException('stop', 'AbortError'));
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
  });
});

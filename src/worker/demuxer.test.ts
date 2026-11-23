// Demuxer 的稀疏軌（字幕）：不進封包佇列，每批 demux 的封包直接交給回呼，不影響 demux 的停止條件與進度。
import { describe, expect, test } from 'vitest';
import { Demuxer, type PacketReader } from './demuxer.js';

interface FakePacket {
  stream: number;
  time: number;
  duration: number;
}

/** 依序讀出 `batches`，最後一批之後是 EOF；記錄 read() 的次數。 */
class FakeReader implements PacketReader<FakePacket> {
  reads = 0;
  readonly #batches: FakePacket[][];
  constructor(batches: FakePacket[][]) {
    this.#batches = [...batches];
  }
  read() {
    this.reads++;
    const packets = this.#batches.shift() ?? [];
    return Promise.resolve({ packets, eof: this.#batches.length === 0 });
  }
  measure(packet: FakePacket) {
    return { stream: packet.stream, bytes: 100, time: packet.time, duration: packet.duration };
  }
}

const AUDIO = 0;
const SUBTITLE = 2;

/** 每批一個 0.1 秒的音訊封包；`subtitleEvery` 批夾一個 0.5 秒、時長 10 秒的字幕封包。 */
function batches(count: number, subtitleEvery: number): FakePacket[][] {
  return Array.from({ length: count }, (_, i) => [
    { stream: AUDIO, time: i * 0.1, duration: 0.1 },
    ...(i % subtitleEvery === 0 ? [{ stream: SUBTITLE, time: i * 0.1, duration: 10 }] : []),
  ]);
}

async function settle() {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

describe('稀疏軌', () => {
  test('每批的字幕封包交給回呼，音訊照常進 lane；佇列滿時一樣停下', async () => {
    const reader = new FakeReader(batches(100, 10));
    const received: FakePacket[][] = [];
    const ends: number[] = [];
    const demuxer = new Demuxer({
      reader,
      streams: [AUDIO],
      sparse: { streams: [SUBTITLE], onPackets: (packets) => received.push(packets) },
      startTime: 0,
      epoch: 1,
      onDemux: (end) => ends.push(end),
    });
    const stop = new AbortController();
    void demuxer.run(stop.signal);
    await settle();

    // 2 秒的音訊就停：字幕的 lane 沒有封包也不會讓 demux 繼續。
    expect(reader.reads).toBe(20);
    expect(received.map((batch) => batch.map((p) => p.time))).toEqual([[0], [1]]);
    // 字幕的時長不算進 demux 進度。
    expect(ends.at(-1)).toBeCloseTo(2, 6);
    stop.abort();
  });

  test('被停下之後讀到的那一批不交給回呼', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const received: FakePacket[][] = [];
    const reader: PacketReader<FakePacket> = {
      read: async () => {
        await gate;
        return { packets: [{ stream: SUBTITLE, time: 0, duration: 1 }], eof: true };
      },
      measure: (p) => ({ stream: p.stream, bytes: 1, time: p.time, duration: p.duration }),
    };
    const demuxer = new Demuxer({
      reader,
      streams: [AUDIO],
      sparse: { streams: [SUBTITLE], onPackets: (packets) => received.push(packets) },
      startTime: 0,
      epoch: 1,
    });
    const stop = new AbortController();
    const running = demuxer.run(stop.signal);
    stop.abort();
    release();
    await running;
    expect(received).toEqual([]);
  });
});

describe('settled', () => {
  test('只 demux 稀疏軌時 demux 失敗：以 demux 的錯誤 reject（不是當成正常結束）', async () => {
    const failure = new Error('讀取失敗');
    let reads = 0;
    const reader: PacketReader<FakePacket> = {
      read: () =>
        ++reads === 1
          ? Promise.resolve({ packets: [{ stream: SUBTITLE, time: 0, duration: 1 }], eof: false })
          : Promise.reject(failure),
      measure: (p) => ({ stream: p.stream, bytes: 1, time: p.time, duration: p.duration }),
    };
    const demuxer = new Demuxer({
      reader,
      streams: [],
      sparse: { streams: [SUBTITLE], onPackets: () => undefined },
      startTime: 0,
      epoch: 1,
    });
    const stop = new AbortController();
    const running = demuxer.run(stop.signal);
    await expect(demuxer.settled(stop.signal)).rejects.toBe(failure);
    await running;
  });

  test('demux 到結尾：resolve', async () => {
    const demuxer = new Demuxer({
      reader: new FakeReader([[{ stream: SUBTITLE, time: 0, duration: 1 }]]),
      streams: [],
      sparse: { streams: [SUBTITLE], onPackets: () => undefined },
      startTime: 0,
      epoch: 1,
    });
    const stop = new AbortController();
    void demuxer.run(stop.signal);
    await expect(demuxer.settled(stop.signal)).resolves.toBeUndefined();
  });
});

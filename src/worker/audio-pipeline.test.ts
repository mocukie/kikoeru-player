import { describe, expect, test } from 'vitest';
import type { WorkerToWorkletMessage, WorkletPcmMessage } from '../protocol/index.js';
import {
  AudioPipeline,
  BufferPool,
  Demand,
  type AudioDecoder,
  type DecodedAudio,
  type PacketReader,
} from './audio-pipeline.js';
import { WorkerError } from './errors.js';
import type { Logger } from './log.js';
import type { PacketQueueLimits } from './packet-queue.js';

const RATE = 48_000;

/** 假封包：每個解出 `frames` 個 frame；`fail` 的解碼失敗。 */
interface FakePacket {
  frames: number;
  fail?: boolean;
  /** 封包時長（秒）；0 表示容器沒有記錄。 */
  duration?: number;
  /** 解出的 frame 的時間戳（秒）；預設接續前一個。 */
  time?: number;
}

/** 一次讀出一批封包，最後一批之後是 EOF。 */
class FakeReader implements PacketReader<FakePacket> {
  readonly #batches: FakePacket[][];
  #error: Error | null = null;
  constructor(batches: FakePacket[][]) {
    this.#batches = [...batches];
  }
  /** read() 被呼叫的次數。 */
  reads = 0;
  failNextReadWith(error: Error) {
    this.#error = error;
  }
  read() {
    this.reads++;
    if (this.#error) return Promise.reject(this.#error);
    const packets = this.#batches.shift() ?? [];
    return Promise.resolve({ packets, eof: this.#batches.length === 0 });
  }
  measure(packet: FakePacket) {
    return { bytes: packet.frames * 4, time: packet.time ?? null, duration: packet.frames / RATE };
  }
}

/**
 * 假 decoder：輸出的 sample 值是 frame 的序號（左聲道正、右聲道負），可以檢查連續性。
 * 時間從 `firstTime` 起依 frame 數推算。
 */
class FakeDecoder implements AudioDecoder<FakePacket> {
  #next = 0;
  constructor(
    readonly channels: 1 | 2 = 2,
    readonly firstTime: number | null = 0,
    readonly flushFrames = 0,
  ) {}
  decode(packet: FakePacket): Promise<DecodedAudio[]> {
    if (packet.fail) {
      // 解不出來的封包仍佔用時間軸，之後的時間戳跟著往後。
      this.#next += packet.frames;
      return Promise.reject(new Error('Error decoding audio frame'));
    }
    const frame = this.#frame(packet.frames);
    return Promise.resolve([packet.time === undefined ? frame : { ...frame, time: packet.time }]);
  }
  flush(): Promise<DecodedAudio[]> {
    return Promise.resolve(this.flushFrames > 0 ? [this.#frame(this.flushFrames)] : []);
  }
  packetDuration(packet: FakePacket): number {
    return packet.duration ?? packet.frames / RATE;
  }
  #frame(frames: number): DecodedAudio {
    const start = this.#next;
    this.#next += frames;
    const planes = Array.from({ length: this.channels }, (_, c) =>
      Float32Array.from({ length: frames }, (_, i) => (c === 0 ? 1 : -1) * (start + i)),
    );
    return { planes, time: this.firstTime === null ? null : this.firstTime + start / RATE };
  }
}

function setup(
  options: {
    batches?: FakePacket[][];
    decoder?: FakeDecoder;
    startTime?: number;
    epoch?: number;
    queueLimits?: PacketQueueLimits;
    onDemux?: (end: number) => void;
    log?: Logger;
  } = {},
) {
  const posted: { message: WorkerToWorkletMessage; transfer: Transferable[] }[] = [];
  const reader = new FakeReader(
    options.batches ?? Array.from({ length: 10 }, () => [{ frames: 1024 }, { frames: 1024 }]),
  );
  const demand = new Demand();
  const pool = new BufferPool();
  const controller = new AbortController();
  const epoch = options.epoch ?? 1;
  demand.setEpoch(epoch);
  const pipeline = new AudioPipeline({
    reader,
    decoder: options.decoder ?? new FakeDecoder(),
    sampleRate: RATE,
    startTime: options.startTime ?? 0,
    epoch,
    demand,
    pool,
    signal: controller.signal,
    ...(options.queueLimits && { queueLimits: options.queueLimits }),
    ...(options.onDemux && { onDemux: options.onDemux }),
    ...(options.log && { log: options.log }),
    // 與 MessagePort 一樣 transfer：送出後原本的 buffer 被 detach。
    post: (message, transfer) => posted.push(structuredClone({ message, transfer }, { transfer })),
  });
  const running = pipeline.run();
  const pcm = () =>
    posted.map((p) => p.message).filter((m): m is WorkletPcmMessage => m.type === 'pcm');
  return { pipeline, running, posted, pcm, demand, pool, reader, controller, epoch };
}

/** 讓 pipeline 處理完目前能處理的工作。 */
async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function frames(messages: WorkletPcmMessage[]): number {
  return messages.reduce((sum, m) => sum + (m.channels[0]?.length ?? 0), 0);
}

describe('供料', () => {
  test('worklet 要求之前不送 PCM', async () => {
    const { posted } = setup();
    await settle();
    expect(posted).toEqual([]);
  });

  test('依要求送出 2048–4096 frame 的 stereo chunk，帶 epoch 與連續的媒體時間', async () => {
    const { demand, pcm, epoch } = setup({ epoch: 7 });
    demand.need(epoch, 10_000);
    await settle();
    const chunks = pcm();
    expect(frames(chunks)).toBeGreaterThanOrEqual(10_000);
    expect(frames(chunks)).toBeLessThan(10_000 + 4096);
    let expected = 0;
    for (const chunk of chunks) {
      expect(chunk.epoch).toBe(7);
      expect(chunk.channels).toHaveLength(2);
      const length = chunk.channels[0]?.length ?? 0;
      expect(length).toBeGreaterThanOrEqual(2048);
      expect(length).toBeLessThanOrEqual(4096);
      expect(chunk.time).toBeCloseTo(expected / RATE, 9);
      expect(chunk.channels[0]?.[0]).toBe(expected);
      expect(chunk.channels[1]?.[0]).toBe(-expected);
      expected += length;
    }
  });

  test('要求是增量，累加後才繼續送', async () => {
    const { demand, pcm, epoch } = setup();
    demand.need(epoch, 2048);
    await settle();
    expect(frames(pcm())).toBe(2048);
    demand.need(epoch, 3000);
    await settle();
    expect(frames(pcm())).toBe(2048 + 3000);
  });

  test('每個聲道的 view 各自擁有一個以 transfer 傳送的 buffer', async () => {
    const { demand, posted, epoch } = setup();
    demand.need(epoch, 4096);
    await settle();
    const [{ message, transfer }] = posted as [(typeof posted)[number]];
    expect(message.type === 'pcm' && message.channels.map((c) => c.buffer)).toEqual(transfer);
    expect(new Set(transfer).size).toBe(2);
  });

  test('release 送回的 buffer 會被重用', async () => {
    const { demand, posted, pool, epoch } = setup();
    demand.need(epoch, 4096);
    await settle();
    const first = posted[0]?.transfer as ArrayBuffer[];
    pool.release(first);
    demand.need(epoch, 4096);
    await settle();
    expect(posted[1]?.transfer).toEqual(expect.arrayContaining(first));
  });

  test('音訊到結尾送出 EOF；最後一個 chunk 可以短於 2048', async () => {
    const { demand, posted, pcm, running, epoch } = setup({
      batches: [[{ frames: 3000 }], [{ frames: 1000 }]],
    });
    demand.need(epoch, 100_000);
    await running;
    expect(pcm().map((m) => m.channels[0]?.length)).toEqual([4000]);
    expect(posted.at(-1)?.message).toEqual({ type: 'eof', epoch });
  });

  test('最後一段送出後，不等下一個要求就送出 EOF', async () => {
    const { demand, posted, running, epoch } = setup({ batches: [[{ frames: 3000 }]] });
    demand.need(epoch, 3000);
    await running;
    expect(posted.map((p) => p.message.type)).toEqual(['pcm', 'eof']);
  });

  test('decoder 在結尾排出的資料也會送出', async () => {
    const { demand, pcm, running, epoch } = setup({
      batches: [[{ frames: 1000 }]],
      decoder: new FakeDecoder(2, 0, 500),
    });
    demand.need(epoch, 100_000);
    await running;
    expect(frames(pcm())).toBe(1500);
  });

  test('mono 複製到兩個聲道', async () => {
    const { demand, pcm, epoch } = setup({ decoder: new FakeDecoder(1) });
    demand.need(epoch, 2048);
    await settle();
    const [chunk] = pcm();
    expect(chunk?.channels).toHaveLength(2);
    expect([...(chunk?.channels[1] ?? [])]).toEqual([...(chunk?.channels[0] ?? [])]);
  });

  test('起點之前的 sample 丟掉，第一個 chunk 從起點開始', async () => {
    const batches = Array.from({ length: 30 }, () => [{ frames: 2048 }]);
    const { demand, pcm, epoch } = setup({ batches, startTime: 0.5 });
    demand.need(epoch, 2048);
    await settle();
    const [chunk] = pcm();
    expect(chunk?.time).toBe(0.5);
    expect(chunk?.channels[0]?.[0]).toBe(0.5 * RATE);
  });

  test('frame 沒有時間戳時接續前一段', async () => {
    const { demand, pcm, epoch } = setup({ decoder: new FakeDecoder(2, null), startTime: 0 });
    demand.need(epoch, 8192);
    await settle();
    expect(pcm().map((m) => m.time)).toEqual([0, 4096 / RATE]);
  });

  test('中止後不再送出任何訊息', async () => {
    const { demand, posted, controller, running, epoch } = setup();
    controller.abort();
    demand.need(epoch, 4096);
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(posted).toEqual([]);
  });
});

describe('需求的 epoch', () => {
  test('比目前新的 epoch 先記下，換到該 epoch 時生效；舊的丟棄', () => {
    const demand = new Demand();
    demand.setEpoch(1);
    demand.need(2, 500);
    demand.need(1, 100);
    expect(demand.credit(1)).toBe(100);
    demand.setEpoch(2);
    demand.need(1, 100);
    expect(demand.credit(1)).toBe(0);
    expect(demand.credit(2)).toBe(500);
  });
});

describe('錯誤', () => {
  test('壞的封包補上等長的靜音後繼續', async () => {
    const { demand, pcm, epoch } = setup({
      batches: [[{ frames: 1024 }, { frames: 1024, fail: true }, { frames: 2048 }]],
    });
    demand.need(epoch, 100_000);
    await settle();
    const [chunk] = pcm();
    const left = chunk?.channels[0] ?? new Float32Array();
    expect(left.length).toBe(4096);
    expect(left[1023]).toBe(1023);
    expect(left.subarray(1024, 2048).every((x) => x === 0)).toBe(true);
    expect(left[2048]).toBe(2048);
  });

  test('壞的封包與 demux 結尾記 log', async () => {
    const messages: string[] = [];
    const log: Logger = {
      enabled: () => true,
      log: (level, scope, message) => messages.push(`${level}:${scope}:${message}`),
    };
    const { demand, epoch } = setup({
      batches: [[{ frames: 1024 }, { frames: 1024, fail: true }]],
      log,
    });
    demand.need(epoch, 100_000);
    await settle();
    expect(messages).toEqual([
      expect.stringMatching(/^debug:demux:/) as string,
      expect.stringMatching(/^warn:audio:封包解碼失敗/) as string,
    ]);
  });

  test('沒有時間戳時，壞的封包也補上等長的靜音', async () => {
    const { demand, pcm, epoch } = setup({
      batches: [[{ frames: 1024 }, { frames: 1024, fail: true }, { frames: 2048 }]],
      decoder: new FakeDecoder(2, null),
    });
    demand.need(epoch, 100_000);
    await settle();
    const left = pcm()[0]?.channels[0] ?? new Float32Array();
    expect(left.length).toBe(4096);
    expect(left.subarray(1024, 2048).every((x) => x === 0)).toBe(true);
  });

  test('結尾的壞封包也補上靜音', async () => {
    const { demand, pcm, epoch, running } = setup({
      batches: [[{ frames: 1024 }, { frames: 1024, fail: true }]],
    });
    demand.need(epoch, 100_000);
    await running;
    expect(frames(pcm())).toBe(2048);
  });

  test('壞的封包之後 decoder 補出的資料不會和靜音重複', async () => {
    // 例如 MP3 的 bit reservoir：解碼失敗的封包，時間軸由下一個封包的時間戳決定。
    const { demand, pcm, epoch, running } = setup({
      batches: [
        [{ frames: 1024 }, { frames: 1024, fail: true }, { frames: 2048, time: 1024 / RATE }],
      ],
    });
    demand.need(epoch, 100_000);
    await running;
    expect(frames(pcm())).toBe(3072);
  });

  test('時間戳出現空缺（decoder 丟掉了封包）時補上靜音', async () => {
    const { demand, pcm, epoch } = setup({
      batches: [[{ frames: 1024 }, { frames: 1024, time: 0.1 }, { frames: 4096 }]],
    });
    demand.need(epoch, 100_000);
    await settle();
    const left = Float32Array.from(pcm().flatMap((m) => [...(m.channels[0] ?? [])]));
    expect(left[1023]).toBe(1023);
    expect(left.subarray(1024, 4800).every((x) => x === 0)).toBe(true);
    expect(left[4800]).toBe(1024);
  });

  test('時間戳倒退（與已送出的資料重疊）時丟掉重疊的部分', async () => {
    const { demand, pcm, epoch, running } = setup({
      batches: [[{ frames: 2048 }, { frames: 2048, time: 1024 / RATE }]],
    });
    demand.need(epoch, 100_000);
    await running;
    const left = Float32Array.from(pcm().flatMap((m) => [...(m.channels[0] ?? [])]));
    expect(left.length).toBe(3072);
    expect(left[2047]).toBe(2047);
    expect(left[2048]).toBe(2048 + 1024);
  });

  test('時間戳的小幅抖動不補靜音', async () => {
    const { demand, pcm, epoch } = setup({
      batches: [[{ frames: 1024 }, { frames: 1024, time: 1024 / RATE + 0.001 }]],
    });
    demand.need(epoch, 100_000);
    await settle();
    expect(frames(pcm())).toBe(2048);
  });

  test('封包沒有時長時，靜音沿用上一個成功的封包長度', async () => {
    const { demand, pcm, epoch } = setup({
      batches: [[{ frames: 1000 }, { frames: 0, duration: 0, fail: true }, { frames: 1000 }]],
      decoder: new FakeDecoder(2, null),
    });
    demand.need(epoch, 100_000);
    await settle();
    expect(frames(pcm())).toBe(3000);
  });

  test('連續失敗累計 1 媒體秒才是 fatal 的 DECODE_FAILED', async () => {
    const bad = { frames: 4800, fail: true };
    const { demand, running, epoch } = setup({
      batches: [[{ frames: 1024 }, ...Array.from({ length: 10 }, () => bad), { frames: 1024 }]],
    });
    demand.need(epoch, 1_000_000);
    await expect(running).rejects.toMatchObject({ code: 'DECODE_FAILED' });
  });

  test('中間有成功的封包就重新累計', async () => {
    const bad = { frames: 4800, fail: true };
    const nine = Array.from({ length: 9 }, () => bad);
    const { demand, running, epoch, posted } = setup({
      batches: [[...nine, { frames: 1024 }, ...nine, { frames: 1024 }]],
    });
    demand.need(epoch, 1_000_000);
    await running;
    expect(posted.at(-1)?.message.type).toBe('eof');
  });

  test('沒有時長、也還沒有成功過的壞封包仍計入 1 秒的上限', async () => {
    const bad = { frames: 0, duration: 0, fail: true };
    const { demand, running, epoch } = setup({
      batches: [Array.from({ length: 200 }, () => bad)],
      decoder: new FakeDecoder(2, null),
    });
    demand.need(epoch, 1_000_000);
    await expect(running).rejects.toMatchObject({ code: 'DECODE_FAILED' });
  });

  test('wasm trap 不當成壞封包，原樣丟出', async () => {
    const decoder = new FakeDecoder();
    decoder.decode = () => Promise.reject(new WebAssembly.RuntimeError('unreachable'));
    const { demand, running, epoch } = setup({ decoder });
    demand.need(epoch, 4096);
    await expect(running).rejects.toBeInstanceOf(WebAssembly.RuntimeError);
  });

  test('wasm 記憶體用完（FFmpeg 的 ENOMEM）不當成壞封包，原樣丟出', async () => {
    const decoder = new FakeDecoder();
    const oom = new Error('Error submitting the packet to the decoder: Out of memory');
    decoder.decode = () => Promise.reject(oom);
    const { demand, running, epoch } = setup({ decoder });
    demand.need(epoch, 4096);
    await expect(running).rejects.toBe(oom);
  });

  test('demux 的錯誤原樣丟出', async () => {
    const { demand, reader, running, epoch } = setup();
    reader.failNextReadWith(new WorkerError('FORMAT_CORRUPT', 'demux 失敗'));
    demand.need(epoch, 4096);
    await expect(running).rejects.toMatchObject({ code: 'FORMAT_CORRUPT' });
  });
});

describe('封包佇列', () => {
  /** `count` 批、每批一個 1024 frame（約 21 ms）的封包。 */
  const many = (count: number) => Array.from({ length: count }, () => [{ frames: 1024 }]);

  test('worklet 要求之前就 demux 到約 2 秒的封包，之後停下', async () => {
    const ends: number[] = [];
    const { reader, pipeline } = setup({ batches: many(500), onDemux: (end) => ends.push(end) });
    await settle();
    const reads = reader.reads;
    expect(reads).toBeGreaterThan(90);
    expect(reads).toBeLessThan(100);
    expect(pipeline.queuedSeconds).toBeGreaterThanOrEqual(2);
    expect(ends.at(-1)).toBeCloseTo((reads * 1024) / RATE, 6);
    await settle();
    expect(reader.reads).toBe(reads);
  });

  test('解碼取出封包後繼續 demux', async () => {
    const { reader, demand, epoch } = setup({ batches: many(500) });
    await settle();
    const reads = reader.reads;
    demand.need(epoch, 48_000);
    await settle();
    expect(reader.reads).toBeGreaterThan(reads + 40);
  });

  test('超過硬上限時以 MEMORY_LIMIT 結束', async () => {
    const { running } = setup({
      batches: [[{ frames: 4096 }, { frames: 4096 }]],
      queueLimits: { seconds: 2, bytes: 8 * 1024 * 1024, hardBytes: 20_000 },
    });
    await expect(running).rejects.toMatchObject({ code: 'MEMORY_LIMIT' });
  });
});

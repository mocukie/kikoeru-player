import { describe, expect, test } from 'vitest';
import type { HoldableLane } from './demuxer.js';
import { PacketQueue } from './packet-queue.js';
import {
  FrameCredit,
  MAX_DECODE_QUEUE,
  MAX_OPEN_FRAMES,
  VideoDecoding,
  type DecodedFrame,
  type VideoChunk,
  type VideoDecoderInit,
  type VideoDecoderLike,
} from './video-pipeline.js';
import type { VideoConfig } from './video-codec.js';

const config: VideoConfig = { codec: 'avc1.64000d', codedWidth: 320, codedHeight: 180 };

/** 假的 VideoFrame：記錄是否 close。 */
class FakeFrame implements DecodedFrame {
  closed = false;
  constructor(readonly timestamp: number) {}
  close(): void {
    this.closed = true;
  }
}

/**
 * 假的 VideoDecoder：decode 的 chunk 進入佇列（`decodeQueueSize`），`auto` 時在下一個 microtask 依序輸出同一個
 * timestamp 的 frame；`auto` 為 false 時由測試以 `output()` 輸出。`failOn` 的 chunk 讓 decoder 以錯誤關閉。
 */
class FakeDecoder implements VideoDecoderLike {
  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  readonly queue: VideoChunk[] = [];
  readonly configured: VideoConfig[] = [];
  readonly decoded: VideoChunk[] = [];
  readonly frames: FakeFrame[] = [];
  resets = 0;
  maxQueue = 0;
  auto = true;
  failOn: ((chunk: VideoChunk) => boolean) | null = null;
  configureError: Error | null = null;
  ondequeue: (() => void) | null = null;
  constructor(readonly init: VideoDecoderInit<FakeFrame>) {}

  get decodeQueueSize(): number {
    return this.queue.length;
  }
  configure(c: VideoConfig): void {
    if (this.configureError) throw this.configureError;
    this.configured.push(c);
    this.state = 'configured';
  }
  decode(chunk: VideoChunk): void {
    if (this.state !== 'configured') throw new Error(`decode() 時 state 為 ${this.state}`);
    this.queue.push(chunk);
    this.decoded.push(chunk);
    this.maxQueue = Math.max(this.maxQueue, this.queue.length);
    if (this.auto) {
      queueMicrotask(() => {
        this.output(1);
      });
    }
  }
  /** 輸出佇列前 `count` 個 chunk 的 frame。 */
  output(count = this.queue.length): void {
    for (let i = 0; i < count; i++) {
      const chunk = this.queue.shift();
      if (!chunk || this.state !== 'configured') return;
      this.ondequeue?.();
      if (this.failOn?.(chunk)) {
        this.state = 'closed';
        this.init.error(new DOMException('decode failed', 'EncodingError'));
        return;
      }
      const frame = new FakeFrame(chunk.timestamp);
      this.frames.push(frame);
      this.init.output(frame);
    }
  }
  flush(): Promise<void> {
    this.output();
    return Promise.resolve();
  }
  reset(): void {
    this.resets++;
    this.queue.length = 0;
    this.state = 'unconfigured';
  }
  close(): void {
    this.state = 'closed';
  }
}

/** 假封包：timestamp 以 ms 表示。 */
interface Packet {
  ms: number;
  key: boolean;
}

/** 依序交出封包的 lane（真實的封包佇列，stream 1）；`end` 之前取完會等待。 */
function liveLane(initial: Packet[] = []) {
  const queue = new PacketQueue<Packet>(
    [1],
    { seconds: 2, bytes: 8 * 1024 * 1024, hardBytes: 64 * 1024 * 1024 },
    () => 1,
    (p) => ({ time: p.ms / 1000, duration: 1 / 30 }),
  );
  queue.push(1, initial);
  let held = false;
  const lane: HoldableLane<Packet> = {
    next: (signal) => queue.next(1, signal),
    get drained() {
      return queue.laneDrained(1);
    },
    hold: (value) => {
      held = value;
      queue.hold(1, value);
    },
    entries: () => queue.lanePackets(1).map((p) => ({ key: p.key, time: p.ms / 1000 })),
    trim: (count) => {
      queue.trim(1, count);
    },
    changed: (signal) => queue.changed(signal),
  };
  return {
    lane,
    queue,
    get held() {
      return held;
    },
    push: (list: Packet[]) => {
      queue.push(1, list);
    },
    end: () => {
      queue.end();
    },
    /** lane 中封包的時間（ms）。 */
    get times() {
      return queue.lanePackets(1).map((p) => Math.round(p.ms));
    },
  };
}

/** 依序交出封包、之後結束的 lane。 */
function lane(packets: Packet[]): HoldableLane<Packet> {
  const live = liveLane(packets);
  live.end();
  return live.lane;
}

/** `seconds` 秒、30 fps、每秒一個 keyframe 的封包，從 `from` 秒起。 */
function packets(seconds: number, from = 0): Packet[] {
  return Array.from({ length: Math.round(seconds * 30) }, (_, i) => {
    const frame = Math.round(from * 30) + i;
    return { ms: (frame * 1000) / 30, key: frame % 30 === 0 };
  });
}

const toChunk = (p: Packet): VideoChunk => ({
  type: p.key ? 'key' : 'delta',
  timestamp: Math.round(p.ms * 1000),
  duration: 33_333,
  data: new Uint8Array(1),
});

/** `failFrom`：每個新建的 decoder 在這個 timestamp（µs）以後的 chunk 都失敗（壞掉的資料）。 */
function setup(options: { failFrom?: number } = {}) {
  const decoders: FakeDecoder[] = [];
  const credit = new FrameCredit();
  const state = { failFrom: options.failFrom ?? null };
  const decoding = new VideoDecoding<Packet, FakeFrame>({
    config,
    toChunk,
    credit,
    createDecoder: (init) => {
      const decoder = new FakeDecoder(init);
      const failFrom = state.failFrom;
      if (failFrom !== null) decoder.failOn = (chunk) => chunk.timestamp >= failFrom;
      decoders.push(decoder);
      return decoder;
    },
  });
  const posted: { epoch: number; frame: FakeFrame }[] = [];
  const events: string[] = [];
  const failures: { error: Error; beforeFirstFrame: boolean }[] = [];
  const retries: Error[] = [];
  const run = (
    source: HoldableLane<Packet>,
    options: {
      startTime?: number;
      epoch?: number;
      signal?: AbortSignal;
      played?: () => number | null;
    } = {},
  ) => {
    const epoch = options.epoch ?? 1;
    return decoding.run({
      packets: source,
      startTime: options.startTime ?? 0,
      epoch,
      signal: options.signal ?? new AbortController().signal,
      post: (frame) => {
        posted.push({ epoch, frame });
      },
      end: () => events.push(`end ${String(epoch)}`),
      fail: (error, beforeFirstFrame) => {
        failures.push({ error, beforeFirstFrame });
        events.push(`fail ${String(epoch)}`);
      },
      retry: (error) => retries.push(error),
      ...(options.played && { played: options.played }),
    });
  };
  return {
    decoding,
    credit,
    posted,
    events,
    failures,
    retries,
    run,
    get failFrom() {
      return state.failFrom;
    },
    set failFrom(value: number | null) {
      state.failFrom = value;
    },
    get decoder() {
      const d = decoders.at(-1);
      if (!d) throw new Error('還沒有建立 decoder');
      return d;
    },
    decoders,
  };
}

async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** 模擬主執行緒：close 收到的 frame 並告訴 Worker。 */
function closeAll(posted: { frame: FakeFrame }[], credit: FrameCredit): void {
  const open = posted.filter((p) => !p.frame.closed);
  for (const p of open) p.frame.close();
  credit.release(open.length);
}

describe('VideoDecoding', () => {
  test('從頭解碼：送出每一張 frame（依 timestamp），結尾 flush 後送出 end', async () => {
    const t = setup();
    const running = t.run(lane(packets(1)));
    // 主執行緒持續 close 收到的 frame。
    const timer = setInterval(() => {
      closeAll(t.posted, t.credit);
    }, 0);
    await running;
    clearInterval(timer);
    expect(t.posted.map((p) => p.frame.timestamp)).toEqual(
      packets(1).map((p) => Math.round(p.ms * 1000)),
    );
    expect(t.events).toEqual(['end 1']);
    expect(t.decoder.configured).toEqual([config]);
  });

  test('第一個 keyframe 之前的 delta 封包不送進 decoder', async () => {
    const t = setup();
    const source = [...packets(0.5, 0.5), ...packets(0.2, 1)];
    const running = t.run(lane(source));
    const timer = setInterval(() => {
      closeAll(t.posted, t.credit);
    }, 0);
    await running;
    clearInterval(timer);
    expect(t.decoder.decoded[0]).toMatchObject({ type: 'key', timestamp: 1_000_000 });
    expect(t.decoder.decoded).toHaveLength(6);
  });

  test('seek：起點之前的 frame 在 Worker 內 close，只送出起點那一張（pts ≤ 起點的最後一張）與之後的', async () => {
    const t = setup();
    const running = t.run(lane(packets(1.5)), { startTime: 0.5 });
    const timer = setInterval(() => {
      closeAll(t.posted, t.credit);
    }, 0);
    await running;
    clearInterval(timer);
    closeAll(t.posted, t.credit);
    const first = t.posted[0]?.frame.timestamp ?? NaN;
    expect(first).toBe(500_000);
    expect(t.posted).toHaveLength(30);
    // decoder 輸出的 frame 都 close 了（Worker 丟掉的與主執行緒 close 的）。
    expect(t.decoder.frames.every((f) => f.closed)).toBe(true);
    expect(t.credit.open).toBe(0);
  });

  test('起點落在兩張 frame 之間：送出之前的那一張', async () => {
    const t = setup();
    const running = t.run(lane(packets(1)), { startTime: 0.51 });
    const timer = setInterval(() => {
      closeAll(t.posted, t.credit);
    }, 0);
    await running;
    clearInterval(timer);
    expect(t.posted[0]?.frame.timestamp).toBe(500_000);
  });

  test(`decodeQueueSize 不超過 ${String(MAX_DECODE_QUEUE)}`, async () => {
    const t = setup();
    const source = lane(packets(1));
    const running = t.run(source);
    t.decoder.auto = false;
    await settle();
    expect(t.decoder.decodeQueueSize).toBe(MAX_DECODE_QUEUE);
    for (let i = 0; i < 40; i++) {
      t.decoder.output(1);
      closeAll(t.posted, t.credit);
      await settle();
    }
    await running;
    expect(t.decoder.maxQueue).toBe(MAX_DECODE_QUEUE);
  });

  test(`沒有 close 的 frame 加上 decode 佇列最多 ${String(MAX_OPEN_FRAMES)} 張；主執行緒 close 之後才繼續`, async () => {
    const t = setup();
    void t.run(lane(packets(1)));
    await settle();
    // 主執行緒沒有 close 任何 frame。
    expect(t.credit.open + t.decoder.decodeQueueSize).toBe(MAX_OPEN_FRAMES);
    const decoded = t.decoder.decoded.length;
    await settle();
    expect(t.decoder.decoded).toHaveLength(decoded);

    closeAll(t.posted, t.credit);
    await settle();
    expect(t.decoder.decoded.length).toBeGreaterThan(decoded);
  });

  test('中止：不再送出 frame，Worker 內暫留的 frame 也 close', async () => {
    const t = setup();
    const controller = new AbortController();
    const running = t.run(lane(packets(1, 0)), { startTime: 0.9, signal: controller.signal });
    await settle();
    controller.abort();
    await expect(running).rejects.toThrow();
    expect(t.posted).toHaveLength(0);
    await settle();
    expect(t.decoder.frames.every((f) => f.closed)).toBe(true);
    expect(t.credit.open).toBe(0);
    expect(t.decoding.openFrames).toBe(0);
  });

  test('下一個 epoch（seek）reset 並重新 configure 同一個 decoder', async () => {
    const t = setup();
    const first = new AbortController();
    void t.run(lane(packets(1)), { signal: first.signal }).catch(() => undefined);
    await settle();
    first.abort();
    const running = t.run(lane(packets(1, 2)), { startTime: 2, epoch: 2 });
    const timer = setInterval(() => {
      closeAll(t.posted, t.credit);
    }, 0);
    await running;
    clearInterval(timer);
    expect(t.decoders).toHaveLength(1);
    expect(t.decoder.resets).toBe(1);
    expect(t.decoder.configured).toHaveLength(2);
    expect(t.posted.find((p) => p.epoch === 2)?.frame.timestamp).toBe(2_000_000);
    expect(t.events).toEqual(['end 2']);
  });

  test('第一個 keyframe 就解碼失敗：以 beforeFirstFrame 回報，不送出 end', async () => {
    const t = setup();
    const source = lane(packets(1));
    const running = t.run(source);
    t.decoder.failOn = () => true;
    await running;
    expect(t.failures).toMatchObject([{ beforeFirstFrame: true }]);
    expect(t.events).toEqual(['fail 1']);
  });

  test('configure 失敗：以 beforeFirstFrame 回報', async () => {
    const t = setup();
    const decoding = new VideoDecoding<Packet, FakeFrame>({
      config,
      toChunk,
      credit: t.credit,
      createDecoder: (init) => {
        const decoder = new FakeDecoder(init);
        decoder.configureError = new DOMException('unsupported', 'NotSupportedError');
        return decoder;
      },
    });
    const failures: boolean[] = [];
    await decoding.run({
      packets: lane(packets(1)),
      startTime: 0,
      epoch: 1,
      signal: new AbortController().signal,
      post: () => undefined,
      end: () => undefined,
      fail: (_, beforeFirstFrame) => failures.push(beforeFirstFrame),
    });
    expect(failures).toEqual([true]);
  });

  test('解出 frame 之後的解碼失敗：重新設定 decoder，從下一個 keyframe 繼續', async () => {
    const t = setup();
    const running = t.run(lane(packets(3)));
    // 只有 1.5 秒那個封包是壞的。
    t.decoder.failOn = (chunk) => chunk.timestamp === 1_500_000;
    const timer = setInterval(() => {
      closeAll(t.posted, t.credit);
    }, 0);
    await running;
    clearInterval(timer);
    expect(t.failures).toEqual([]);
    expect(t.retries).toHaveLength(1);
    expect(t.events).toEqual(['end 1']);
    expect(t.decoders).toHaveLength(2);
    expect(t.decoders[1]?.decoded[0]).toMatchObject({ type: 'key', timestamp: 2_000_000 });
    expect(t.posted.at(-1)?.frame.timestamp).toBe(Math.round((89 * 1e6) / 30));
  });

  test('重新設定之後還沒解出 frame 又失敗：放棄（beforeFirstFrame 為 false）；下一個 epoch 建立新的 decoder', async () => {
    const t = setup({ failFrom: 300_000 });
    const running = t.run(lane(packets(3)));
    const timer = setInterval(() => {
      closeAll(t.posted, t.credit);
    }, 0);
    await running;
    clearInterval(timer);
    expect(t.retries).toHaveLength(1);
    expect(t.decoders).toHaveLength(2);
    expect(t.failures).toMatchObject([{ beforeFirstFrame: false }]);
    expect(t.events).toEqual(['fail 1']);

    t.failFrom = null;
    const again = t.run(lane(packets(0.2, 1)), { startTime: 1, epoch: 2 });
    const timer2 = setInterval(() => {
      closeAll(t.posted, t.credit);
    }, 0);
    await again;
    clearInterval(timer2);
    expect(t.decoders).toHaveLength(3);
    expect(t.events.at(-1)).toBe('end 2');
  });

  test('stats：解出的 frame 數與 decode 佇列', async () => {
    const t = setup();
    const running = t.run(lane(packets(0.5)));
    const timer = setInterval(() => {
      closeAll(t.posted, t.credit);
    }, 0);
    await running;
    clearInterval(timer);
    expect(t.decoding.stats).toMatchObject({ decoded: 15, decodeQueueSize: 0 });
    expect(t.decoding.stats.avgDecodeMs).toBeGreaterThanOrEqual(0);
  });

  test('close：關掉 decoder', async () => {
    const t = setup();
    const controller = new AbortController();
    void t.run(lane(packets(1)), { signal: controller.signal }).catch(() => undefined);
    await settle();
    controller.abort();
    t.decoding.close();
    expect(t.decoder.state).toBe('closed');
  });
});

describe('VideoDecoding 的背景（suspend／resume）', () => {
  /** 主執行緒持續 close 收到的 frame，回傳停止的函式。 */
  function consume(t: ReturnType<typeof setup>): () => void {
    const timer = setInterval(() => {
      closeAll(t.posted, t.credit);
    }, 0);
    return () => {
      clearInterval(timer);
    };
  }

  /** 等到 `predicate` 成立（每次讓出 macrotask）。 */
  async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !predicate(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(predicate()).toBe(true);
  }

  const µs = (frame: number) => Math.round((frame * 1e6) / 30);

  test('suspend：關閉 decoder、不再送出 frame，Worker 內暫留的 frame close；知道播放位置時 lane 被 hold', async () => {
    const t = setup();
    const live = liveLane(packets(1));
    const stop = consume(t);
    const running = t.run(live.lane, { startTime: 0.5, played: () => 0 });
    await until(() => t.posted.length > 0);
    t.decoding.suspend();
    const decoder = t.decoder;
    expect(decoder.state).toBe('closed');
    expect(t.decoding.openFrames).toBe(0);
    const posted = t.posted.length;
    live.push(packets(1, 1));
    await settle();
    expect(t.posted).toHaveLength(posted);
    expect(t.decoders).toHaveLength(1);
    expect(live.held).toBe(true);
    stop();
    closeAll(t.posted, t.credit);
    expect(t.credit.open).toBe(0);
    void running.catch(() => undefined);
  });

  test('suspend 中依播放位置丟掉之前的 GOP：保留 pts ≤ 播放位置的最後一個 keyframe 之後的封包', async () => {
    const t = setup();
    const live = liveLane(packets(0.5));
    let played: number | null = null;
    const stop = consume(t);
    void t.run(live.lane, { played: () => played }).catch(() => undefined);
    await until(() => t.posted.length > 3);
    t.decoding.suspend();
    // 還不知道播放位置：不丟。
    live.push(packets(2.5, 0.5));
    await settle();
    expect(live.times[0]).toBeLessThanOrEqual(500);
    expect(live.times.length).toBeGreaterThanOrEqual(15);
    played = 2.2;
    live.push(packets(1, 3));
    await settle();
    expect(live.times[0]).toBe(2000);
    expect(live.times.at(-1)).toBe(Math.round(µs(119) / 1000));
    stop();
  });

  test('resume：建立新的 decoder，從 pts ≤ 恢復位置的 keyframe 解碼，第一張送出的是恢復位置的 frame', async () => {
    const t = setup();
    const live = liveLane(packets(0.5));
    let played: number | null = null;
    const stop = consume(t);
    const running = t.run(live.lane, { played: () => played });
    await until(() => t.posted.length > 3);
    t.decoding.suspend();
    played = 1.2;
    live.push(packets(3.5, 0.5));
    live.end();
    await settle();
    const before = t.posted.length;
    t.decoding.resume(2.5);
    await running;
    stop();
    expect(t.decoders).toHaveLength(2);
    // 1–2 秒的 GOP 整個略過，從 2 秒的 keyframe 開始解碼。
    expect(t.decoders[1]?.decoded[0]).toMatchObject({ type: 'key', timestamp: 2_000_000 });
    expect(t.posted[before]?.frame.timestamp).toBe(2_500_000);
    expect(t.posted.at(-1)?.frame.timestamp).toBe(µs(119));
    expect(t.events).toEqual(['end 1']);
  });

  test('短暫的背景（不到一個 GOP）：恢復時從已經送進 decoder 的 keyframe 重新解碼', async () => {
    const t = setup();
    const live = liveLane(packets(0.5));
    const stop = consume(t);
    const running = t.run(live.lane, { played: () => 0.2 });
    await until(() => t.posted.length > 3);
    t.decoding.suspend();
    live.push(packets(1.5, 0.5));
    live.end();
    await settle();
    const before = t.posted.length;
    t.decoding.resume(0.4);
    await running;
    stop();
    expect(t.decoders[1]?.decoded[0]).toMatchObject({ type: 'key', timestamp: 0 });
    expect(t.posted[before]?.frame.timestamp).toBe(400_000);
    expect(t.posted.at(-1)?.frame.timestamp).toBe(µs(59));
  });

  test('背景中開始的 run（背景中 load 或 seek）：resume 之前不建立 decoder；不知道播放位置時不 hold', async () => {
    const t = setup();
    t.decoding.suspend();
    const live = liveLane(packets(2));
    live.end();
    const stop = consume(t);
    const running = t.run(live.lane, { startTime: 0.5 });
    await settle();
    expect(t.decoders).toHaveLength(0);
    expect(live.held).toBe(false);
    t.decoding.resume(1.1);
    await running;
    stop();
    expect(t.posted[0]?.frame.timestamp).toBe(1_100_000);
  });

  test('suspend 中被中止（seek）：以 signal 的 reason reject，lane 不再 hold', async () => {
    const t = setup();
    const live = liveLane(packets(0.5));
    const controller = new AbortController();
    const stop = consume(t);
    const running = t.run(live.lane, { signal: controller.signal, played: () => 0 });
    await until(() => t.posted.length > 0);
    t.decoding.suspend();
    await settle();
    expect(live.held).toBe(true);
    controller.abort(new DOMException('seek', 'AbortError'));
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(live.held).toBe(false);
    stop();
  });
});

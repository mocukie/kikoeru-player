// 一個 epoch 的 demux：從 demuxer 讀出選用中的各條軌的封包，放進各自的封包佇列（ADR-0007）。音訊與影片的供料
// 各自從自己的 lane 取封包；佇列平常約 2 秒，某條選用中的軌是空的（交錯不良）時繼續 demux 到硬上限。
// 字幕這類稀疏的軌不進佇列：封包隨 demux 的進度直接交出，否則它空著的 lane 會讓 demux 一直跑到硬上限。

import { WorkerError } from './errors.js';
import type { Logger } from './log.js';
import {
  NORMAL_QUEUE_BYTES,
  NORMAL_QUEUE_SECONDS,
  PacketQueue,
  type PacketQueueLimits,
} from './packet-queue.js';

/** 從 demuxer 讀封包。 */
export interface PacketReader<P> {
  /** 讀一批選用中各條軌的封包（依 demux 的順序）；`eof` 表示這是最後一批。demux 失敗時丟 `WorkerError`。 */
  read(): Promise<{ packets: P[]; eof: boolean }>;
  /**
   * 封包所屬的 stream index、大小（bytes）、媒體時間（秒，沒有時間戳時為 null）與時長（秒），供 lane 的分配、
   * 封包佇列的上限與 demux 的進度。
   */
  measure(packet: P): { stream: number; bytes: number; time: number | null; duration: number };
}

/** 一條軌在封包佇列中的 lane，由該軌的供料取用。 */
export interface PacketLane<P> {
  /** 等到有封包並取出；demux 到結尾、lane 空了時為 undefined，demux 失敗時以它的錯誤 reject（佇列中的封包先取完）。 */
  next(signal: AbortSignal): Promise<P | undefined>;
  /** demux 已到結尾，而且這條 lane 空了。 */
  readonly drained: boolean;
}

/**
 * 可以暫停取用的 lane（背景分頁時的影片）：hold 時它不影響 demux 何時停下，取用的一方以 `trim` 丟掉不再需要的封包，
 * lane 才不會一直增長。
 */
export interface HoldableLane<P> extends PacketLane<P> {
  hold(held: boolean): void;
  /** lane 中各封包是否為 keyframe 與媒體時間（秒，沒有時間戳時為 null），依先進先出的順序。 */
  entries(): { key: boolean; time: number | null }[];
  /** 丟掉最前面的 `count` 個封包。 */
  trim(count: number): void;
  /** 等到 lane 或封包佇列有變化（demux 推進、取出、結束）；被中止時以 signal 的 reason reject。 */
  changed(signal: AbortSignal): Promise<void>;
  /** 封包的大小（bytes），與封包佇列計算上限時相同。 */
  size(packet: P): number;
  /**
   * 取出之後仍保留在取用的一方的 bytes（取代前一次的值），例如影片 catch up 中還沒送進 decoder 的 GOP。增加時立即
   * 檢查硬上限；超過時以同一個 `MEMORY_LIMIT` 中止 demuxer 的 `fatal` signal 並丟出錯誤。
   */
  retain(bytes: number): void;
}

/** `Demuxer.lane()`：除了取用，也能 hold 並 trim（見 `HoldableLane`）；`packets()` 是 lane 中的封包，依先進先出的順序。 */
export interface DemuxerLane<P> extends Omit<HoldableLane<P>, 'entries'> {
  packets(): readonly P[];
}

export interface DemuxerOptions<P> {
  reader: PacketReader<P>;
  /** 選用中各條軌的 stream index；其他 stream 的封包丟掉。 */
  streams: readonly number[];
  /**
   * 稀疏的軌（字幕）：不進封包佇列、不影響 demux 何時停下與 demux 進度，每批 demux 讀到的封包（依 demux 的順序）
   * 直接交給 `onPackets`。停下之後讀到的那一批不交出。
   */
  sparse?: { streams: readonly number[]; onPackets: (packets: P[]) => void };
  /**
   * 只用來推進 demux 進度的軌：封包推進 `end` 後直接丟掉，不進封包佇列。只 demux 稀疏軌時以它讓 demux 有進度、
   * 每次讀取有上限（稀疏軌的封包很小，單靠它們一次讀取會讀過一大段）。
   */
  progress?: readonly number[];
  /** 這個 epoch 的起點（秒）：demux 進度的初始值。 */
  startTime: number;
  epoch: number;
  /** 封包佇列的上限；省略時為平常的 2 秒／8 MiB 與 64 MiB 的硬上限。 */
  queueLimits?: PacketQueueLimits;
  /** demux 進度：已 demux 的封包到媒體時間 `end`（秒）；`eof` 表示 demux 到了結尾。 */
  onDemux?: (end: number, eof: boolean) => void;
  /** demux 結尾與 demux 失敗的 log；省略時不記錄。 */
  log?: Logger;
  /**
   * 每次讀取之前等它 resolve（`end` 是目前的 demux 進度）：只有稀疏軌的 demux 沒有封包佇列讓它停下，以它控制
   * demux 不超前太多。`stop` 時以它的 reason reject。
   */
  pace?: (end: number, stop: AbortSignal) => Promise<void>;
}

/** 省略 `queueLimits` 時的上限（桌面的硬上限）。 */
const DEFAULT_QUEUE_LIMITS: PacketQueueLimits = {
  seconds: NORMAL_QUEUE_SECONDS,
  bytes: NORMAL_QUEUE_BYTES,
  hardBytes: 64 * 1024 * 1024,
};

export class Demuxer<P> {
  readonly #options: DemuxerOptions<P>;
  readonly #packets: PacketQueue<P>;
  readonly #streams: ReadonlySet<number>;
  readonly #sparse: ReadonlySet<number>;
  readonly #progress: ReadonlySet<number>;
  /** 封包佇列超過硬上限：所有供料立即結束（`MEMORY_LIMIT`）。 */
  readonly #fatal = new AbortController();
  /** 已 demux 的封包的結尾（媒體時間）。 */
  #end: number;
  /** demux 到了結尾。 */
  #ended = false;
  /** demux 失敗的錯誤；沒有失敗時為 null。 */
  #error: Error | null = null;

  constructor(options: DemuxerOptions<P>) {
    this.#options = options;
    this.#streams = new Set(options.streams);
    this.#sparse = new Set(options.sparse?.streams);
    this.#progress = new Set(options.progress);
    this.#end = options.startTime;
    const measure = (p: P) => options.reader.measure(p);
    this.#packets = new PacketQueue<P>(
      options.streams,
      options.queueLimits ?? DEFAULT_QUEUE_LIMITS,
      (p) => measure(p).bytes,
      measure,
    );
  }

  /** 封包佇列超過硬上限時以 `MEMORY_LIMIT` abort；供料以它立即結束。 */
  get fatal(): AbortSignal {
    return this.#fatal.signal;
  }

  /** 所有 lane 的 bytes 合計。 */
  get bytes(): number {
    return this.#packets.bytes;
  }

  /** 一條軌在佇列中的秒數；不是選用中的軌時為 0。 */
  seconds(stream: number): number {
    return this.#streams.has(stream) ? this.#packets.seconds(stream) : 0;
  }

  /** 已 demux 的封包的結尾（媒體時間，秒）。 */
  get end(): number {
    return this.#end;
  }

  /** demux 到了結尾（之後 `end` 不再改變）。 */
  get ended(): boolean {
    return this.#ended;
  }

  /**
   * 等到 demux 到結尾；demux 失敗時以它的錯誤 reject，被中止時以 signal 的 reason reject。沒有供料取用 lane（只有稀疏軌）
   * 時，以它決定 demux 何時停止，失敗照一般的讀取錯誤回報。
   */
  async settled(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (this.#error) throw this.#error;
      if (this.#ended) return;
      await this.#packets.changed(signal);
    }
  }

  /** 一條軌在佇列中的下一個封包的媒體時間（秒）；沒有封包、沒有時間戳或不是選用中的軌時為 null。 */
  headTime(stream: number): number | null {
    return this.#streams.has(stream) ? this.#packets.headTime(stream) : null;
  }

  lane(stream: number): DemuxerLane<P> {
    const packets = this.#packets;
    return {
      next: (signal) => packets.next(stream, signal),
      get drained() {
        return packets.laneDrained(stream);
      },
      hold: (held) => {
        packets.hold(stream, held);
      },
      packets: () => packets.lanePackets(stream),
      trim: (count) => {
        packets.trim(stream, count);
      },
      changed: (signal) => packets.changed(signal),
      size: (packet) => this.#options.reader.measure(packet).bytes,
      retain: (bytes) => {
        try {
          packets.retain(stream, bytes);
        } catch (error) {
          if (error instanceof WorkerError && error.code === 'MEMORY_LIMIT') {
            this.fatal.throwIfAborted();
            this.#fail(error);
          }
          throw error;
        }
      },
    };
  }

  /**
   * demux 到封包佇列，滿了就等，直到結尾或 `stop`。結尾時結束佇列；失敗時讓佇列以同一個錯誤失敗（佇列中的封包照常
   * 取完才回報，錯誤的位置接近實際播放到的地方），封包佇列超過硬上限則 abort `fatal`。不會 reject。
   */
  async run(stop: AbortSignal): Promise<void> {
    const { reader, onDemux, log, epoch, sparse, pace } = this.#options;
    const signal = AbortSignal.any([stop, this.fatal]);
    try {
      for (;;) {
        await this.#packets.space(signal);
        await pace?.(this.#end, signal);
        signal.throwIfAborted();
        const { packets, eof } = await reader.read();
        if (signal.aborted) return;
        const byStream = new Map<number, P[]>();
        const sparsePackets: P[] = [];
        for (const packet of packets) {
          const { stream, time, duration } = reader.measure(packet);
          if (this.#sparse.has(stream)) {
            sparsePackets.push(packet);
            continue;
          }
          const progress = this.#progress.has(stream);
          if (!progress && !this.#streams.has(stream)) continue;
          this.#end = time === null ? this.#end + duration : Math.max(this.#end, time + duration);
          if (progress) continue;
          const lane = byStream.get(stream) ?? [];
          lane.push(packet);
          byStream.set(stream, lane);
        }
        if (sparsePackets.length > 0) sparse?.onPackets(sparsePackets);
        for (const [stream, lane] of byStream) this.#packets.push(stream, lane);
        onDemux?.(this.#end, eof);
        if (eof) {
          log?.log('debug', 'demux', 'demux 到結尾', { epoch, end: this.#end });
          this.#ended = true;
          this.#packets.end();
          return;
        }
      }
    } catch (error) {
      if (!signal.aborted) this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #fail(error: Error): void {
    const { log, epoch } = this.#options;
    log?.log('warn', 'demux', `demux 失敗：${error.message}`, { epoch, end: this.#end });
    this.#error = error;
    this.#packets.fail(error);
    if (error instanceof WorkerError && error.code === 'MEMORY_LIMIT') this.#fatal.abort(error);
  }
}

/**
 * 在 `consume`（各條軌的供料）執行期間 demux。`consume` 結束（含被中止）時停止 demux 並等它停下；`consume` 失敗時
 * 不等：demux 可能卡在讀取，之後由 seek 中止讀取或 Worker 被 terminate。
 */
export async function withDemux<T, P>(
  demuxer: Demuxer<P>,
  signal: AbortSignal,
  consume: () => Promise<T>,
): Promise<T> {
  const stop = new AbortController();
  const demuxing = demuxer.run(stop.signal);
  let failed = false;
  try {
    return await consume();
  } catch (error) {
    failed = !signal.aborted;
    throw error;
  } finally {
    stop.abort();
    if (!failed) await demuxing;
  }
}

// 一個 epoch 的 demux：從 demuxer 讀出選用中的各條軌的封包，放進各自的封包佇列（ADR-0007）。音訊與影片的供料
// 各自從自己的 lane 取封包；佇列平常約 2 秒，某條選用中的軌是空的（交錯不良）時繼續 demux 到硬上限。

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

export interface DemuxerOptions<P> {
  reader: PacketReader<P>;
  /** 選用中各條軌的 stream index；其他 stream 的封包丟掉。 */
  streams: readonly number[];
  /** 這個 epoch 的起點（秒）：demux 進度的初始值。 */
  startTime: number;
  epoch: number;
  /** 封包佇列的上限；省略時為平常的 2 秒／8 MiB 與 64 MiB 的硬上限。 */
  queueLimits?: PacketQueueLimits;
  /** demux 進度：已 demux 的封包到媒體時間 `end`（秒）；`eof` 表示 demux 到了結尾。 */
  onDemux?: (end: number, eof: boolean) => void;
  /** demux 結尾與 demux 失敗的 log；省略時不記錄。 */
  log?: Logger;
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
  /** 封包佇列超過硬上限：所有供料立即結束（`MEMORY_LIMIT`）。 */
  readonly #fatal = new AbortController();
  /** 已 demux 的封包的結尾（媒體時間）。 */
  #end: number;

  constructor(options: DemuxerOptions<P>) {
    this.#options = options;
    this.#streams = new Set(options.streams);
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

  lane(stream: number): PacketLane<P> {
    const packets = this.#packets;
    return {
      next: (signal) => packets.next(stream, signal),
      get drained() {
        return packets.laneDrained(stream);
      },
    };
  }

  /**
   * demux 到封包佇列，滿了就等，直到結尾或 `stop`。結尾時結束佇列；失敗時讓佇列以同一個錯誤失敗（佇列中的封包照常
   * 取完才回報，錯誤的位置接近實際播放到的地方），封包佇列超過硬上限則 abort `fatal`。不會 reject。
   */
  async run(stop: AbortSignal): Promise<void> {
    const { reader, onDemux, log, epoch } = this.#options;
    try {
      for (;;) {
        await this.#packets.space(stop);
        const { packets, eof } = await reader.read();
        if (stop.aborted) return;
        const byStream = new Map<number, P[]>();
        for (const packet of packets) {
          const { stream, time, duration } = reader.measure(packet);
          if (!this.#streams.has(stream)) continue;
          this.#end = time === null ? this.#end + duration : Math.max(this.#end, time + duration);
          const lane = byStream.get(stream) ?? [];
          lane.push(packet);
          byStream.set(stream, lane);
        }
        for (const [stream, lane] of byStream) this.#packets.push(stream, lane);
        onDemux?.(this.#end, eof);
        if (eof) {
          log?.log('debug', 'demux', 'demux 到結尾', { epoch, end: this.#end });
          this.#packets.end();
          return;
        }
      }
    } catch (error) {
      if (stop.aborted) return;
      log?.log(
        'warn',
        'demux',
        `demux 失敗：${error instanceof Error ? error.message : String(error)}`,
        { epoch, end: this.#end },
      );
      this.#packets.fail(error);
      if (error instanceof WorkerError && error.code === 'MEMORY_LIMIT') this.#fatal.abort(error);
    }
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

// 音訊的供料：從封包佇列（demuxer.ts，約 2 秒，ADR-0007）的音訊 lane 取封包，依 worklet 的要求解碼，把 PCM 切成
// chunk 經 MessagePort 送出（ADR-0004）。解碼經由 AudioDecoder 介面，libav 的實作在 libav.ts。
// demux 與解碼同時進行：libav.js 的 demux 讀取掛起時，同一個 instance 仍可以解碼（#17 的實測）。

import type { WorkerToWorkletMessage } from '../protocol/index.js';
import type { PacketLane } from './demuxer.js';
import { crashReason, WorkerError } from './errors.js';
import { TempoStage, type Allocate, type CreateStretcher } from './tempo.js';
import type { Logger } from './log.js';

/** chunk 的 frame 數下限；`eof` 前的最後一段除外。 */
export const MIN_CHUNK_FRAMES = 2048;
/** chunk 的 frame 數上限，也是 buffer pool 中每個 buffer 的大小。 */
export const MAX_CHUNK_FRAMES = 4096;
/** 連續解碼失敗累計到這個媒體秒數才是 fatal。 */
const MAX_FAILED_SECONDS = 1;
/** 壞封包沒有時長、也還沒有成功解碼過的封包可以參考時，以這個秒數計（約一個 AAC frame）。 */
const FALLBACK_PACKET_SECONDS = 0.02;
/** 時間戳比前一段的結尾晚超過這個秒數，視為中間的資料遺失（例如 decoder 丟掉的壞封包），補上靜音。 */
const GAP_SECONDS = 0.01;
/** pool 保留的 buffer 上限；多的交給 GC。 */
const MAX_POOLED_BUFFERS = 64;

/** 解碼加上 filter graph：輸出已重採樣到 `sampleRate` 的 float planar。 */
export interface AudioDecoder<P> {
  /** 輸出的聲道數：mono 的來源為 1（由 pipeline 複製成 stereo），其餘 downmix 成 2。 */
  readonly channels: 1 | 2;
  /** 解一個封包；解碼失敗時丟錯。 */
  decode(packet: P): Promise<DecodedAudio[]>;
  /** 排出 decoder 與 filter graph 剩下的資料。 */
  flush(): Promise<DecodedAudio[]>;
  /** 封包的時長（秒）；容器沒有記錄時為 0。 */
  packetDuration(packet: P): number;
}

/** 一段解碼後的音訊。 */
export interface DecodedAudio {
  planes: readonly Float32Array[];
  /** 第一個 sample 在媒體時間軸上的位置（秒）；沒有時間戳時為 null，接續前一段。 */
  time: number | null;
}

/** 重用 worklet 送回的 PCM buffer。 */
export class BufferPool {
  readonly #buffers: ArrayBuffer[] = [];

  acquire(): ArrayBuffer {
    return (
      this.#buffers.pop() ?? new ArrayBuffer(MAX_CHUNK_FRAMES * Float32Array.BYTES_PER_ELEMENT)
    );
  }

  release(buffers: readonly ArrayBuffer[]): void {
    for (const buffer of buffers) {
      if (this.#buffers.length >= MAX_POOLED_BUFFERS) return;
      if (buffer.byteLength === MAX_CHUNK_FRAMES * Float32Array.BYTES_PER_ELEMENT) {
        this.#buffers.push(buffer);
      }
    }
  }
}

/**
 * worklet 的要求（`need`）依 epoch 累計。比 Worker 目前的 epoch 新的要求先記下（worklet 可能比 Worker 先換 epoch），
 * 比目前舊的丟棄。
 */
export class Demand {
  readonly #credits = new Map<number, number>();
  #epoch = -Infinity;
  readonly #waiters = new Set<() => void>();

  setEpoch(epoch: number): void {
    this.#epoch = epoch;
    for (const key of this.#credits.keys()) if (key < epoch) this.#credits.delete(key);
    this.#wake();
  }

  need(epoch: number, frames: number): void {
    if (epoch < this.#epoch || !(frames > 0)) return;
    this.#credits.set(epoch, this.credit(epoch) + frames);
    this.#wake();
  }

  credit(epoch: number): number {
    return epoch < this.#epoch ? 0 : Math.max(0, this.#credits.get(epoch) ?? 0);
  }

  consume(epoch: number, frames: number): void {
    this.#credits.set(epoch, (this.#credits.get(epoch) ?? 0) - frames);
  }

  /** 等到這個 epoch 有要求；被中止時以 `signal.reason` reject。 */
  async wait(epoch: number, signal: AbortSignal): Promise<void> {
    while (this.credit(epoch) <= 0) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.#waiters.delete(wake);
          reject(signal.reason as Error);
        };
        const wake = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        this.#waiters.add(wake);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    signal.throwIfAborted();
  }

  #wake(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake();
  }
}

/** PcmQueue 中的一段：解碼的資料，或靜音（`planes` 為 null，不配置陣列，取出時才寫入 0）。 */
interface PcmSegment {
  planes: readonly [Float32Array, Float32Array] | null;
  /** 這一段的 frame 數。 */
  length: number;
  /** 還沒送出的第一個 frame。 */
  offset: number;
  /** 第 0 個 frame 的媒體時間。 */
  time: number;
}

/** 解碼後、尚未送出的 stereo PCM。 */
class PcmQueue {
  readonly #segments: PcmSegment[] = [];
  readonly #sampleRate: number;
  readonly #startTime: number;
  /** 媒體的長度（秒）；NaN 表示未知。補靜音的空缺不超過它。 */
  readonly #duration: number;
  /** 最後一段的結尾時間；沒有時間戳的資料接在這裡。 */
  #endTime: number;
  /** 已經收過資料；之後的時間戳才用來偵測空缺。 */
  #started = false;
  /** 壞封包預留、還沒補上的靜音（frame）。 */
  #pendingSilence = 0;
  /** 空缺的靜音補到了媒體的結尾：之後的資料都在媒體之外。 */
  #complete = false;
  frames = 0;

  constructor(sampleRate: number, startTime: number, duration: number) {
    this.#sampleRate = sampleRate;
    this.#startTime = startTime;
    this.#endTime = startTime;
    this.#duration = duration;
  }

  /** 空缺的靜音已補到媒體的結尾，之後的資料都在媒體之外，不必再解碼。 */
  get complete(): boolean {
    return this.#complete;
  }

  /**
   * 加入一段資料，mono 複製成 stereo。有時間戳時依它對齊：比前一段的結尾（第一段是起點）晚就在中間補靜音，早就丟掉
   * 重疊的部分；10 ms 以內的抖動視為連續。起點前補靜音的是音軌 offset 為正（或音訊比起點晚開始）的情況。
   * 空缺的靜音只補到媒體的結尾（`duration`）：越過它時這段資料在媒體之外，丟掉，之後的也不收（`complete`）。
   */
  push(planes: readonly Float32Array[], time: number | null): void {
    const left = planes[0];
    if (!left || this.#complete) return;
    const right = planes[1] ?? left;
    if (time !== null) {
      // 有時間戳時，遺失的範圍由時間戳決定，取代壞封包預留的靜音。
      this.#pendingSilence = 0;
      if (time - this.#endTime > GAP_SECONDS) {
        const beyond = time >= this.#duration;
        const gapEnd = beyond ? this.#duration : time;
        if (gapEnd > this.#endTime) {
          this.#pushSilence(Math.round((gapEnd - this.#endTime) * this.#sampleRate));
        }
        if (beyond) {
          this.#complete = true;
          return;
        }
      }
    }
    this.finish();
    this.#append([left, right], left.length, time);
  }

  /**
   * 壞封包佔用的時間：先記下，下一段有時間戳時以時間戳的空缺為準（decoder 可能仍會補出這段資料），
   * 沒有時間戳或到了結尾才補上這麼多靜音。
   */
  deferSilence(frames: number): void {
    this.#pendingSilence += frames;
  }

  /** 補上還沒補的靜音。 */
  finish(): void {
    const frames = this.#pendingSilence;
    this.#pendingSilence = 0;
    if (frames > 0) this.#pushSilence(frames);
  }

  #pushSilence(frames: number): void {
    this.#append(null, frames, null);
  }

  /** 接上一段（`planes` 為 null 時是靜音）：丟掉起點之前與時間戳倒退而與已有資料重疊的部分。 */
  #append(
    planes: readonly [Float32Array, Float32Array] | null,
    length: number,
    time: number | null,
  ): void {
    const origin = time ?? this.#endTime;
    // 起點之前的 sample，以及時間戳倒退而與已有資料重疊的部分（例如損毀的封包讓 parser 估錯時間）都丟掉。
    const keepFrom =
      this.#started && this.#endTime - origin > GAP_SECONDS ? this.#endTime : this.#startTime;
    this.#started = true;
    const skip = Math.min(length, Math.max(0, Math.round((keepFrom - origin) * this.#sampleRate)));
    this.#endTime = Math.max(this.#endTime, origin + length / this.#sampleRate);
    const kept = length - skip;
    if (kept === 0) return;
    this.#segments.push({ planes, length, offset: skip, time: origin });
    this.frames += kept;
  }

  /** 取出最多 `frames` 個 frame，複製進 `allocate` 給的 buffer。 */
  take(
    frames: number,
    allocate: Allocate,
  ): { time: number; channels: [Float32Array, Float32Array] } {
    const time = this.#headTime();
    const channels = allocate(frames);
    let written = 0;
    while (written < frames) {
      const segment = this.#segments[0];
      if (!segment) break;
      const count = Math.min(frames - written, segment.length - segment.offset);
      if (segment.planes) {
        const [left, right] = segment.planes;
        channels[0].set(left.subarray(segment.offset, segment.offset + count), written);
        channels[1].set(right.subarray(segment.offset, segment.offset + count), written);
      } else {
        // 靜音：allocate 給的 buffer 可能是重用的，要寫入 0。
        channels[0].fill(0, written, written + count);
        channels[1].fill(0, written, written + count);
      }
      written += count;
      segment.offset += count;
      if (segment.offset === segment.length) this.#segments.shift();
    }
    this.frames -= written;
    return { time, channels };
  }

  /** 複製接下來最多 `frames` 個 frame，不取出。 */
  peek(frames: number): { time: number; channels: [Float32Array, Float32Array] } {
    const time = this.#headTime();
    const count = Math.min(frames, this.frames);
    const channels: [Float32Array, Float32Array] = [
      new Float32Array(count),
      new Float32Array(count),
    ];
    let written = 0;
    for (const segment of this.#segments) {
      if (written >= count) break;
      const n = Math.min(count - written, segment.length - segment.offset);
      // 靜音的段不必寫：新配置的陣列已經是 0。
      if (segment.planes) {
        const [left, right] = segment.planes;
        channels[0].set(left.subarray(segment.offset, segment.offset + n), written);
        channels[1].set(right.subarray(segment.offset, segment.offset + n), written);
      }
      written += n;
    }
    return { time, channels };
  }

  /** 下一個要取出的 frame 的媒體時間。 */
  #headTime(): number {
    const head = this.#segments[0];
    // 時間戳換算的誤差可能讓起點落在 startTime 之前一點點。
    return Math.max(
      head ? head.time + head.offset / this.#sampleRate : this.#endTime,
      this.#startTime,
    );
  }
}

export interface AudioPipelineOptions<P> {
  /** 封包佇列中選用音軌的 lane。 */
  packets: PacketLane<P>;
  /** abort 時（封包佇列超過硬上限）立即以它的 reason 結束供料。 */
  fatal?: AbortSignal;
  decoder: AudioDecoder<P>;
  /** 輸出的取樣率（`ctx.sampleRate`）。 */
  sampleRate: number;
  /** 從這個媒體時間（秒）開始輸出，之前的 sample 丟掉。 */
  startTime: number;
  /**
   * 媒體的長度（秒），省略或 NaN 表示未知：時間戳的空缺（例如 offset 為正時起點前的靜音）只補到它，越過它的資料在媒體
   * 之外，丟掉並結束這個 epoch 的音訊（之後由 worklet 以靜音推進到 `duration`）。
   */
  duration?: number;
  /**
   * 音軌 offset（秒），預設 0：decoder 給的時間是來源的時間，`mediaTime = sourceTime + offset`（ADR-0004 之前的
   * 「音訊輸出排程與變速」#13）。在 stretcher 之前套用。
   */
  offset?: number;
  /** 開始時的播放速度（不變調）；之後以 `setRate()` 改變。 */
  rate: number;
  /** 速度不是 1 時建立 stretcher。 */
  createStretcher: CreateStretcher;
  epoch: number;
  demand: Demand;
  pool: BufferPool;
  signal: AbortSignal;
  post: (message: WorkerToWorkletMessage, transfer: Transferable[]) => void;
  /** 壞封包的 log；省略時不記錄。 */
  log?: Logger;
}

/** 一個 epoch 的音訊輸出。 */
export class AudioPipeline<P> {
  readonly #options: AudioPipelineOptions<P>;
  readonly #queue: PcmQueue;
  readonly #tempo: TempoStage;
  /** 供料內部的中止：外部的 `signal` 或封包佇列超過硬上限。 */
  readonly #inner = new AbortController();
  #ended = false;
  /** 連續解碼失敗所補的靜音 frame 數。 */
  #failedFrames = 0;
  /** 上一個成功解碼的封包長度（frame），封包沒有時長時用來補靜音。 */
  #lastPacketFrames = 0;

  constructor(options: AudioPipelineOptions<P>) {
    this.#options = options;
    const queue = new PcmQueue(options.sampleRate, options.startTime, options.duration ?? NaN);
    this.#queue = queue;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getter 內的 this 是 input 物件。
    const pipeline = this;
    this.#tempo = new TempoStage({
      input: {
        get frames() {
          return queue.frames;
        },
        get ended() {
          return pipeline.#ended;
        },
        more: async () => {
          await this.#decodeMore();
          this.#inner.signal.throwIfAborted();
        },
        take: (frames, allocate) => queue.take(frames, allocate),
        peek: (frames) => queue.peek(frames),
      },
      sampleRate: options.sampleRate,
      rate: options.rate,
      createStretcher: options.createStretcher,
    });
  }

  /** 改變播放速度：已經產生的輸出照舊速度送出，之後的輸入用新的速度（tempo.ts）。 */
  setRate(rate: number): void {
    this.#tempo.setRate(rate);
  }

  /**
   * 依要求供料，送出 `eof` 後 resolve。被中止時以 `signal.reason` reject，之後不再送出任何訊息；
   * 致命錯誤（含 demux 失敗）以 `WorkerError` reject。demux 由呼叫端執行（`withDemux()`）。
   */
  async run(): Promise<void> {
    const signals = [this.#options.signal, this.#options.fatal].filter(
      (s): s is AbortSignal => s !== undefined,
    );
    const onAbort = (event: Event) => {
      this.#inner.abort((event.target as AbortSignal).reason);
    };
    for (const signal of signals) {
      if (signal.aborted) this.#inner.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      await this.#feed();
    } finally {
      for (const signal of signals) signal.removeEventListener('abort', onAbort);
      await this.#tempo.close();
    }
  }

  async #feed(): Promise<void> {
    const { demand, epoch, pool, post } = this.#options;
    const signal = this.#inner.signal;
    for (;;) {
      // 資料送完就立即送出 EOF，不等 worklet 的下一個要求。
      if (this.#tempo.done) {
        post({ type: 'eof', epoch }, []);
        return;
      }
      await demand.wait(epoch, signal);
      const want = Math.min(Math.max(demand.credit(epoch), MIN_CHUNK_FRAMES), MAX_CHUNK_FRAMES);
      const chunk = await this.#tempo.take(want, (frames) => [
        new Float32Array(pool.acquire(), 0, frames),
        new Float32Array(pool.acquire(), 0, frames),
      ]);
      signal.throwIfAborted();
      if (!chunk) continue;
      const { time, rate, channels } = chunk;
      // transfer 之後 view 被 detach，長度要在送出前記下。
      const frames = channels[0].length;
      post({ type: 'pcm', epoch, time, rate, channels }, [channels[0].buffer, channels[1].buffer]);
      demand.consume(epoch, frames);
    }
  }

  async #decodeMore(): Promise<void> {
    const lane = this.#options.packets;
    const packet = await lane.next(this.#inner.signal);
    if (packet !== undefined) {
      await this.#decode(packet);
      // 最後一個封包解完就排出 decoder，不等下一個要求。
      if (!lane.drained && !this.#queue.complete) return;
    }
    // 之後的資料都在媒體之外時不必排出 decoder。
    if (!this.#queue.complete) {
      this.#push(await this.#options.decoder.flush());
      this.#queue.finish();
    }
    this.#ended = true;
  }

  async #decode(packet: P): Promise<void> {
    const { decoder, sampleRate } = this.#options;
    const signal = this.#inner.signal;
    let decoded: DecodedAudio[];
    try {
      decoded = await decoder.decode(packet);
    } catch (error) {
      signal.throwIfAborted();
      // wasm trap 與記憶體用完之後 instance 不能再用，不是壞封包。
      if (crashReason(error) !== null) throw error;
      // 壞的封包補上等長的靜音；連續失敗累計 1 媒體秒才放棄。
      const duration = decoder.packetDuration(packet);
      const frames =
        duration > 0
          ? Math.round(duration * sampleRate)
          : this.#lastPacketFrames || Math.round(FALLBACK_PACKET_SECONDS * sampleRate);
      this.#failedFrames += frames;
      this.#options.log?.log('warn', 'audio', '封包解碼失敗，以等長的靜音補上', {
        epoch: this.#options.epoch,
        frames,
        failedFrames: this.#failedFrames,
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.#failedFrames >= MAX_FAILED_SECONDS * sampleRate) {
        throw new WorkerError('DECODE_FAILED', '音訊連續 1 秒無法解碼', { cause: error });
      }
      this.#queue.deferSilence(frames);
      return;
    }
    this.#failedFrames = 0;
    const frames = decoded.reduce((sum, d) => sum + (d.planes[0]?.length ?? 0), 0);
    if (frames > 0) this.#lastPacketFrames = frames;
    this.#push(decoded);
  }

  #push(decoded: readonly DecodedAudio[]): void {
    const offset = this.#options.offset ?? 0;
    for (const { planes, time } of decoded) {
      this.#queue.push(planes, time === null ? null : time + offset);
    }
  }
}

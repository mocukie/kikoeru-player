// 影片的解碼：從封包佇列的影片 lane 取封包，交給 WebCodecs 的 `VideoDecoder`，解出的 `VideoFrame` transfer 回主執行緒
// （ADR-0002、ADR-0003）。主執行緒依音訊時鐘挑選與繪製，close 之後以 `frameclosed` 告訴 Worker。
// backpressure：decode 佇列（`decodeQueueSize`）最多 4 個；還沒 close 的 frame（Worker 內暫留的加上送到主執行緒的）
// 與 decode 佇列合計到 8 張就不再送進 decoder，主執行緒來不及 close 時停止解碼，封包留在封包佇列。decoder 內部
// （例如 B-frame 的重排）暫存、還沒輸出的 frame 看不到，不計入。

import type { PacketLane } from './demuxer.js';
import type { VideoConfig } from './video-codec.js';

/** decode 佇列的上限。 */
export const MAX_DECODE_QUEUE = 4;
/** 還沒 close 的 frame 加上 decode 佇列的上限。 */
export const MAX_OPEN_FRAMES = 8;
/** `avgDecodeMs` 的指數移動平均的權重。 */
const DECODE_MS_WEIGHT = 0.1;

/** 交給 decoder 的 chunk（`EncodedVideoChunkInit`）。timestamp 是媒體時間軸上的 µs。 */
export interface VideoChunk {
  type: 'key' | 'delta';
  timestamp: number;
  duration?: number;
  data: Uint8Array;
}

/** `VideoFrame` 中這裡用到的部分。 */
export interface DecodedFrame {
  /** 媒體時間軸上的 µs（沿用 chunk 的 timestamp）。 */
  readonly timestamp: number;
  close(): void;
}

/** `VideoDecoder` 的建構參數。 */
export interface VideoDecoderInit<F> {
  output(frame: F): void;
  error(error: Error): void;
}

/** `VideoDecoder` 中這裡用到的部分。 */
export interface VideoDecoderLike {
  readonly state: 'unconfigured' | 'configured' | 'closed';
  readonly decodeQueueSize: number;
  ondequeue: (() => void) | null;
  configure(config: VideoConfig): void;
  decode(chunk: VideoChunk): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}

/** 還沒 close 的 frame 數；Worker 內所有 epoch 共用，主執行緒 close 之後經 `frameclosed` 減少。 */
export class FrameCredit {
  #open = 0;
  readonly #waiters = new Set<() => void>();

  /** 還沒 close 的 frame 數。 */
  get open(): number {
    return this.#open;
  }

  acquire(): void {
    this.#open++;
  }

  release(count: number): void {
    this.#open = Math.max(0, this.#open - count);
    for (const wake of [...this.#waiters]) wake();
  }

  /** 註冊 release 時的回呼；回傳取消註冊的函式。 */
  onRelease(wake: () => void): () => void {
    this.#waiters.add(wake);
    return () => this.#waiters.delete(wake);
  }
}

export interface VideoDecodingOptions<P, F> {
  config: VideoConfig;
  /** 封包轉成 chunk；沒有時間戳等無法解碼的封包為 null（略過）。 */
  toChunk: (packet: P) => VideoChunk | null;
  credit: FrameCredit;
  createDecoder: (init: VideoDecoderInit<F>) => VideoDecoderLike;
}

/** 一個 epoch 的輸出。 */
export interface VideoRunOptions<P, F> {
  packets: PacketLane<P>;
  /** 起點（秒）：之前的 frame 在 Worker 內 close，只送出 pts ≤ 起點的最後一張與之後的。 */
  startTime: number;
  epoch: number;
  signal: AbortSignal;
  /** 送出一張 frame（transfer 給主執行緒）；之後由主執行緒 close。 */
  post: (frame: F) => void;
  /** 這個 epoch 的 frame 都送出了。 */
  end: () => void;
  /**
   * decoder 失敗（configure 丟錯或 error 回呼）；之後這個 epoch 不再送出 frame。`beforeFirstFrame`：這條軌還沒解出過
   * 任何 frame（configure 或首個 keyframe 失敗，等同 `isConfigSupported` 誤報）。
   */
  fail: (error: Error, beforeFirstFrame: boolean) => void;
}

/** 目前輸出中的 epoch 的狀態。 */
interface Current<F> {
  target: number;
  post: (frame: F) => void;
  /** pts ≤ 起點的最後一張，等下一張出現（或結尾）才知道它就是起點的 frame。 */
  pending: F | null;
  signal: AbortSignal;
  error: Error | null;
  wake: () => void;
}

/** 一條影片軌的解碼：decoder 屬於這次 load，seek 時 reset 後重新 configure。 */
export class VideoDecoding<P, F extends DecodedFrame> {
  readonly #options: VideoDecodingOptions<P, F>;
  #decoder: VideoDecoderLike | null = null;
  #current: Current<F> | null = null;
  /** 這條軌解出過 frame。 */
  #decodedAny = false;
  #decoded = 0;
  #avgDecodeMs = 0;
  /** 送進 decoder 的時刻，依 chunk 的 timestamp（µs）。 */
  readonly #submitted = new Map<number, number>();

  constructor(options: VideoDecodingOptions<P, F>) {
    this.#options = options;
  }

  get stats(): { decoded: number; decodeQueueSize: number; avgDecodeMs: number } {
    return {
      decoded: this.#decoded,
      decodeQueueSize: this.#decoder?.decodeQueueSize ?? 0,
      avgDecodeMs: this.#avgDecodeMs,
    };
  }

  /** Worker 內還沒 close 的 frame（seek 時暫留的起點 frame）。 */
  get openFrames(): number {
    return this.#current?.pending ? 1 : 0;
  }

  /**
   * 解碼一個 epoch：取代前一個（呼叫端先中止它），reset decoder 後從第一個 keyframe 開始。被中止時以 `signal.reason`
   * reject；送完時呼叫 `end` 後以 `'end'` resolve，decoder 失敗時呼叫 `fail` 後以 `'failed'` resolve。
   */
  async run(options: VideoRunOptions<P, F>): Promise<'end' | 'failed'> {
    const { signal } = options;
    signal.throwIfAborted();
    const current: Current<F> = {
      target: Math.round(options.startTime * 1e6),
      post: options.post,
      pending: null,
      signal,
      error: null,
      wake: () => undefined,
    };
    // 以函式讀取：error 由 decoder 的回呼在 await 期間設定。
    const errored = (): boolean => current.error !== null;
    this.#current = current;
    this.#submitted.clear();
    try {
      const decoder = this.#configure(current);
      if (!decoder) return this.#fail(current, options);
      let needKey = true;
      for (;;) {
        const packet = await options.packets.next(signal);
        if (errored()) break;
        if (packet === undefined) {
          await decoder.flush().catch(() => undefined);
          signal.throwIfAborted();
          if (errored()) break;
          this.#emitPending(current);
          options.end();
          return 'end';
        }
        const chunk = this.#options.toChunk(packet);
        if (!chunk || (needKey && chunk.type !== 'key')) continue;
        needKey = false;
        await this.#space(decoder, current);
        if (errored()) break;
        this.#submitted.set(chunk.timestamp, performance.now());
        decoder.decode(chunk);
      }
      return this.#fail(current, options);
    } catch (error) {
      // 中止，或 decode() 在 decoder 關閉時丟錯（error 回呼之後）。
      if (errored() && !signal.aborted) return this.#fail(current, options);
      throw error;
    } finally {
      this.#closePending(current);
      if (this.#current === current) this.#current = null;
    }
  }

  /** 關掉 decoder（load 結束）。 */
  close(): void {
    if (this.#current) this.#closePending(this.#current);
    if (this.#decoder?.state !== 'closed') this.#decoder?.close();
    this.#decoder = null;
  }

  #fail(current: Current<F>, options: VideoRunOptions<P, F>): 'failed' {
    options.signal.throwIfAborted();
    options.fail(current.error ?? new Error('VideoDecoder 失敗'), !this.#decodedAny);
    return 'failed';
  }

  /** 取得可用的 decoder 並 configure；configure 失敗時記下錯誤並回傳 null。 */
  #configure(current: Current<F>): VideoDecoderLike | null {
    let decoder = this.#decoder;
    if (!decoder || decoder.state === 'closed') {
      decoder = this.#options.createDecoder({
        output: (frame) => {
          this.#onOutput(frame);
        },
        error: (error) => {
          const active = this.#current;
          if (active && !active.error) active.error = error;
          active?.wake();
        },
      });
      decoder.ondequeue = () => this.#current?.wake();
      this.#decoder = decoder;
    } else if (decoder.state === 'configured') {
      // seek：丟掉 decoder 內前一個 epoch 的工作，之後要從 keyframe 開始。
      decoder.reset();
    }
    try {
      decoder.configure(this.#options.config);
      return decoder;
    } catch (error) {
      current.error = error instanceof Error ? error : new Error(String(error));
      return null;
    }
  }

  /** 等到 decode 佇列與還沒 close 的 frame 都有空間；中止時以 `signal.reason` reject，decoder 失敗時直接返回。 */
  async #space(decoder: VideoDecoderLike, current: Current<F>): Promise<void> {
    const { credit } = this.#options;
    const full = () =>
      decoder.decodeQueueSize >= MAX_DECODE_QUEUE ||
      credit.open + decoder.decodeQueueSize >= MAX_OPEN_FRAMES;
    while (full() && !current.error) {
      current.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          off();
          current.signal.removeEventListener('abort', onAbort);
          current.wake = () => undefined;
        };
        const onAbort = () => {
          done();
          reject(current.signal.reason as Error);
        };
        const wake = () => {
          done();
          resolve();
        };
        const off = credit.onRelease(wake);
        current.wake = wake;
        current.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    current.signal.throwIfAborted();
  }

  #onOutput(frame: F): void {
    const current = this.#current;
    if (!current || current.signal.aborted || current.error) {
      frame.close();
      return;
    }
    const { credit } = this.#options;
    credit.acquire();
    this.#decodedAny = true;
    this.#decoded++;
    const submitted = this.#submitted.get(frame.timestamp);
    if (submitted !== undefined) {
      this.#submitted.delete(frame.timestamp);
      const ms = performance.now() - submitted;
      this.#avgDecodeMs =
        this.#decoded === 1 ? ms : this.#avgDecodeMs + DECODE_MS_WEIGHT * (ms - this.#avgDecodeMs);
    }
    if (frame.timestamp <= current.target) {
      // 起點之前：只留最後一張。
      this.#closePending(current);
      current.pending = frame;
      return;
    }
    this.#emitPending(current);
    current.post(frame);
  }

  #emitPending(current: Current<F>): void {
    const pending = current.pending;
    current.pending = null;
    if (pending) current.post(pending);
  }

  #closePending(current: Current<F>): void {
    const pending = current.pending;
    current.pending = null;
    if (!pending) return;
    pending.close();
    this.#options.credit.release(1);
  }
}

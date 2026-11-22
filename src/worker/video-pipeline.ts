// 影片的解碼：從封包佇列的影片 lane 取封包，交給 WebCodecs 的 `VideoDecoder`，解出的 `VideoFrame` transfer 回主執行緒
// （ADR-0002、ADR-0003）。主執行緒依音訊時鐘挑選與繪製，close 之後以 `frameclosed` 告訴 Worker。
// backpressure：decode 佇列（`decodeQueueSize`）最多 4 個；還沒 close 的 frame（Worker 內暫留的加上送到主執行緒的）
// 與 decode 佇列合計到 8 張就不再送進 decoder，主執行緒來不及 close 時停止解碼，封包留在封包佇列。decoder 內部
// （例如 B-frame 的重排）暫存、還沒輸出的 frame 看不到，不計入。

import type { HoldableLane } from './demuxer.js';
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
  packets: HoldableLane<P>;
  /** 起點（秒）：之前的 frame 在 Worker 內 close，只送出 pts ≤ 起點的最後一張與之後的。 */
  startTime: number;
  epoch: number;
  signal: AbortSignal;
  /** 送出一張 frame（transfer 給主執行緒）；之後由主執行緒 close。 */
  post: (frame: F) => void;
  /** 這個 epoch 的 frame 都送出了。 */
  end: () => void;
  /**
   * 放棄解碼（configure 丟錯，或 error 回呼之後重新設定也失敗）；之後這個 epoch 不再送出 frame。`beforeFirstFrame`：
   * 這條軌還沒解出過任何 frame（configure 或首個 keyframe 失敗，等同 `isConfigSupported` 誤報）。
   */
  fail: (error: Error, beforeFirstFrame: boolean) => void;
  /** 解出過 frame 之後 decoder 失敗，重新設定 decoder（從下一個 keyframe 繼續）。 */
  retry?: (error: Error) => void;
  /**
   * 背景中（`suspend()`）播放確定已經過的媒體時間（秒），不知道時為 null。有它時 suspend 中 hold 影片的 lane，丟掉這個時間
   * 之前的 GOP，只留 pts ≤ 它的最後一個 keyframe 之後的封包；沒有時不 hold（lane 照常讓 demux 停在平常的上限）。
   */
  played?: () => number | null;
}

/** 目前輸出中的 epoch 的狀態。 */
interface Current<F> {
  target: number;
  post: (frame: F) => void;
  /** pts ≤ 起點的最後一張，等下一張出現（或結尾）才知道它就是起點的 frame。 */
  pending: F | null;
  /** 這段解碼的 signal：epoch 被中止或 `suspend()` 時 abort。 */
  signal: AbortSignal;
  error: Error | null;
  wake: () => void;
  /** 中止這段解碼（`suspend()`）。 */
  interrupt: () => void;
}

/** `suspend()` 中止一段解碼時的 reason。 */
const SUSPENDED = new DOMException('影片解碼暫停（背景）', 'AbortError');

/**
 * 一條影片軌的解碼：decoder 屬於這次 load，seek 時 reset 後重新 configure。
 *
 * 背景（`suspend()`）時關閉 decoder、不再取用 lane；`resume(time)` 時建立新的 decoder，從 pts ≤ `time` 的最後一個
 * keyframe 解碼，只送出 `time` 的那一張與之後的。為此 suspend 時把這個 GOP 已經取出的封包留著（backlog），恢復時先讀它。
 */
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
  #suspended = false;
  /** `resume()` 的位置（秒），由目前的 run 取用。 */
  #resumeAt: number | null = null;
  /** 這個 GOP 已經從 lane 取出的封包（最後一個 keyframe 開始），suspend 時放進 backlog。 */
  #history: P[] = [];
  /** 恢復之後先於 lane 讀的封包。 */
  #backlog: P[] = [];

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

  /** 背景：關閉 decoder，暫留的 frame close，不再解碼，直到 `resume()`；之後開始的 run 也一樣。 */
  suspend(): void {
    if (this.#suspended) return;
    this.#suspended = true;
    this.#resumeAt = null;
    const current = this.#current;
    if (current) {
      this.#closePending(current);
      current.interrupt();
      this.#backlog = [...this.#history, ...this.#backlog];
      this.#history = [];
    }
    if (this.#decoder && this.#decoder.state !== 'closed') this.#decoder.close();
    this.#decoder = null;
    this.#submitted.clear();
  }

  /** 回到前景：建立新的 decoder，從 pts ≤ `time`（秒）的最後一個 keyframe 解碼，送出 `time` 的那一張與之後的。 */
  resume(time: number): void {
    if (!this.#suspended) return;
    this.#suspended = false;
    this.#resumeAt = time;
    this.#current?.wake();
  }

  /**
   * 解碼一個 epoch：取代前一個（呼叫端先中止它），reset decoder 後從第一個 keyframe 開始。被中止時以 `signal.reason`
   * reject；送完時呼叫 `end` 後以 `'end'` resolve，放棄解碼時呼叫 `fail` 後以 `'failed'` resolve。
   *
   * 解出過 frame 之後 decoder 失敗：呼叫 `retry`，建立新的 decoder 從下一個 keyframe 繼續；新的 decoder 還沒解出 frame
   * 又失敗才放棄。configure 或首個 keyframe 失敗（這條軌從沒解出過 frame）不重試。背景中（`suspend()`）不解碼，等
   * `resume()`。
   */
  async run(options: VideoRunOptions<P, F>): Promise<'end' | 'failed'> {
    options.signal.throwIfAborted();
    const current: Current<F> = {
      target: Math.round(options.startTime * 1e6),
      post: options.post,
      pending: null,
      signal: options.signal,
      error: null,
      wake: () => undefined,
      interrupt: () => undefined,
    };
    this.#current = current;
    this.#submitted.clear();
    this.#history = [];
    this.#backlog = [];
    this.#resumeAt = null;
    try {
      /** 上一次重新設定時的解碼數；之後沒有再解出 frame 就不再重試。 */
      let retriedAt: number | null = null;
      let catchUp = true;
      for (;;) {
        if (this.#suspended) await this.#hold(current, options);
        const resumeAt = this.#takeResume();
        if (resumeAt !== null) {
          current.target = Math.round(resumeAt * 1e6);
          current.error = null;
          catchUp = true;
          retriedAt = null;
        }
        const outcome = await this.#decode(current, options, catchUp);
        if (outcome === 'end') {
          this.#emitPending(current);
          options.end();
          return 'end';
        }
        if (outcome === 'suspended' || this.#suspended) continue;
        const error = current.error ?? new Error('VideoDecoder 失敗');
        if (!this.#decodedAny || retriedAt === this.#decoded) return this.#fail(current, options);
        retriedAt = this.#decoded;
        current.error = null;
        catchUp = false;
        options.retry?.(error);
      }
    } finally {
      this.#closePending(current);
      if (this.#current === current) {
        this.#current = null;
        this.#history = [];
        this.#backlog = [];
      }
    }
  }

  /**
   * 一段連續的解碼：取得可用的 decoder，從 backlog 與 lane 取封包送進 decoder，直到送完（`'end'`）、decoder 失敗
   * （`'error'`）或 `suspend()`（`'suspended'`）。`catchUp` 時先略過起點之前的 GOP：只把 pts ≤ 起點的最後一個 keyframe
   * 之後的封包送進 decoder；否則從下一個 keyframe 開始。
   */
  async #decode(
    current: Current<F>,
    options: VideoRunOptions<P, F>,
    catchUp: boolean,
  ): Promise<'end' | 'error' | 'suspended'> {
    // 這段解碼自己的 signal：epoch 被中止時跟著 abort，suspend() 時也 abort。
    const phase = new AbortController();
    const forward = () => {
      phase.abort(options.signal.reason);
    };
    options.signal.addEventListener('abort', forward, { once: true });
    current.signal = phase.signal;
    current.interrupt = () => {
      phase.abort(SUSPENDED);
    };
    const { signal } = phase;
    // 以函式讀取：error 由 decoder 的回呼在 await 期間設定。
    const errored = (): boolean => current.error !== null;
    try {
      const decoder = this.#configure(current);
      if (!decoder) return 'error';
      let needKey = true;
      /** catch up 中：起點之前最後一個 keyframe 開始的封包，等到超過起點的封包才送進 decoder。 */
      let gop: VideoChunk[] | null = catchUp ? [] : null;
      const submit = async (chunk: VideoChunk): Promise<boolean> => {
        await this.#space(decoder, current);
        if (errored()) return false;
        this.#submitted.set(chunk.timestamp, performance.now());
        decoder.decode(chunk);
        return true;
      };
      for (;;) {
        const packet =
          this.#backlog.length > 0 ? this.#backlog.shift() : await options.packets.next(signal);
        if (errored()) return 'error';
        const chunk = packet === undefined ? undefined : this.#options.toChunk(packet);
        if (chunk === null) continue;
        if (packet !== undefined && chunk) this.#remember(packet, chunk);
        if (gop && chunk && chunk.timestamp <= current.target) {
          if (chunk.type === 'key') gop = [chunk];
          else if (gop.length > 0) gop.push(chunk);
          continue;
        }
        if (gop) {
          const buffered = gop;
          gop = null;
          for (const c of buffered) {
            needKey = false;
            if (!(await submit(c))) return 'error';
          }
        }
        if (chunk === undefined) {
          await decoder.flush().catch(() => undefined);
          signal.throwIfAborted();
          return errored() ? 'error' : 'end';
        }
        if (needKey && chunk.type !== 'key') continue;
        needKey = false;
        if (!(await submit(chunk))) return 'error';
      }
    } catch (error) {
      if (options.signal.aborted) throw error;
      if (signal.aborted) return 'suspended';
      // decode() 在 decoder 關閉時丟錯（error 回呼之後）。
      if (errored()) return 'error';
      throw error;
    } finally {
      options.signal.removeEventListener('abort', forward);
      current.signal = options.signal;
      current.interrupt = () => undefined;
    }
  }

  /** 取用 `resume()` 的位置（以方法讀取，避開 TypeScript 對欄位跨 await 的窄化）。 */
  #takeResume(): number | null {
    const time = this.#resumeAt;
    this.#resumeAt = null;
    return time;
  }

  /** 記下這個 GOP 從 lane 取出的封包：keyframe 重新開始，之前沒有 keyframe 的 delta 不記。 */
  #remember(packet: P, chunk: VideoChunk): void {
    if (chunk.type === 'key') this.#history = [packet];
    else if (this.#history.length > 0) this.#history.push(packet);
  }

  /**
   * 背景中等 `resume()`；被中止時以 `signal.reason` reject。有 `played` 時 hold lane，每次 lane 有變化就丟掉播放位置
   * 之前的 GOP。
   */
  async #hold(current: Current<F>, options: VideoRunOptions<P, F>): Promise<void> {
    const { packets, played, signal } = options;
    if (played) packets.hold(true);
    try {
      while (this.#suspended) {
        signal.throwIfAborted();
        if (played) this.#trim(packets, played());
        await new Promise<void>((resolve, reject) => {
          const watch = new AbortController();
          const done = () => {
            watch.abort();
            signal.removeEventListener('abort', onAbort);
            current.wake = () => undefined;
          };
          const onAbort = () => {
            done();
            reject(signal.reason as Error);
          };
          const wake = () => {
            done();
            resolve();
          };
          current.wake = wake;
          signal.addEventListener('abort', onAbort, { once: true });
          if (played) packets.changed(watch.signal).then(wake, () => undefined);
        });
      }
      signal.throwIfAborted();
    } finally {
      if (played) packets.hold(false);
    }
  }

  /**
   * 丟掉 backlog 與 lane 前面、播放位置 `time`（秒）之前的 GOP：保留 pts ≤ `time` 的最後一個 keyframe 之後的封包；
   * 沒有這樣的 keyframe 時保留第一個 keyframe 之後的，連 keyframe 都沒有時全部丟掉（沒有 keyframe 的 delta 解不出來）。
   */
  #trim(packets: HoldableLane<P>, time: number | null): void {
    if (time === null) return;
    const backlog = this.#backlog.map((p) => {
      const chunk = this.#options.toChunk(p);
      return { key: chunk?.type === 'key', time: chunk ? chunk.timestamp / 1e6 : null };
    });
    const entries = [...backlog, ...packets.entries()];
    let first = -1;
    let last = -1;
    entries.forEach((entry, i) => {
      if (!entry.key) return;
      if (first < 0) first = i;
      if (entry.time !== null && entry.time <= time) last = i;
    });
    const keep = last >= 0 ? last : first >= 0 ? first : entries.length;
    const fromBacklog = Math.min(keep, this.#backlog.length);
    this.#backlog.splice(0, fromBacklog);
    if (keep > fromBacklog) packets.trim(keep - fromBacklog);
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
    if (!current || current.signal.aborted || current.error || this.#suspended) {
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

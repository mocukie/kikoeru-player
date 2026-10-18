// AudioWorklet 的單一檔案：ring buffer、水位與音訊時鐘（ADR-0004）。只能 import type（硬性約束第 7 條）。
// 邏輯集中在不依賴 AudioWorkletGlobalScope 的 OutputCore，Node 測試直接驅動它；檔案最後的 processor 只是外殼，
// 只在 AudioWorkletGlobalScope 內註冊。

import type {
  HostTypes,
  MainToWorkletMessage,
  WorkerToWorkletMessage,
  WorkletConnectMessage,
  WorkletProcessorName,
  WorkletProcessorOptions,
  WorkletToMainMessage,
  WorkletToWorkerMessage,
} from '../protocol/index.js';

/** Worker 一個 chunk 的 frame 數上限（協定：2048–4096）；ring 至少多留這麼多，容納 Worker 多送的一段。 */
const MAX_CHUNK_FRAMES = 4096;
/** 時鐘前進時，`clock` 回報的間隔（秒）。 */
const CLOCK_INTERVAL_SECONDS = 0.25;
/** 包絡換算 frame 數時的浮點誤差容許。 */
const EPSILON = 1e-6;

/** ring 的水位（frame）。 */
export interface Watermarks {
  /** 低於它就向 Worker 要資料。 */
  refill: number;
  /** 要資料時補到這裡；flush 與 starved 之後補到這裡才出聲。 */
  target: number;
  /** ring 最多存放的量。 */
  capacity: number;
}

/** 把 `EngineOptions.audioBuffer` 的 ms 換算成 frame。 */
export function toWatermarks(
  audioBuffer: WorkletProcessorOptions['audioBuffer'],
  sampleRate: number,
): Watermarks {
  const frames = (ms: number) => Math.round((ms * sampleRate) / 1000);
  return {
    refill: frames(audioBuffer.refillMs),
    target: frames(audioBuffer.targetMs),
    capacity: frames(audioBuffer.capacityMs),
  };
}

/**
 * 依水位決定要向 Worker 再要多少 frame。`level` 是 ring 內加上已要求、還沒收到的 frame 數。
 * 平常低於 `refill` 才要（hysteresis）；`filling`（flush 或 starved 之後、還沒補到 target）時低於 `target` 就要，
 * 否則還沒收到的要求被播完之後，ring 永遠補不到 target。要求的量一律補到 `target`。
 */
export function framesToRequest(marks: Watermarks, level: number, filling: boolean): number {
  const threshold = filling ? marks.target : marks.refill;
  return level < threshold ? marks.target - level : 0;
}

/**
 * 固定容量的 stereo ring buffer。收到的 chunk 複製進來（buffer 立即還給 Worker），並記下每段的媒體時間與速度，
 * 讀出時換算下一個 frame 的媒體時間：段內第 i 個 frame 是 `time + i × rate / sampleRate`。
 */
export class PcmRing {
  readonly #channels: [Float32Array, Float32Array];
  readonly #sampleRate: number;
  /** 累計讀出與寫入的 frame 數；位置取 capacity 的餘數。 */
  #read = 0;
  #write = 0;
  /** 每段的起點（以 `#write` 計）、媒體時間與速度；讀過的段只保留最後一段。 */
  #segments: { start: number; time: number; rate: number }[] = [];

  constructor(capacity: number, sampleRate: number) {
    this.#channels = [new Float32Array(capacity), new Float32Array(capacity)];
    this.#sampleRate = sampleRate;
  }

  get capacity(): number {
    return this.#channels[0].length;
  }

  get buffered(): number {
    return this.#write - this.#read;
  }

  /** 下一個要讀出的 frame 的媒體時間；空的時候是最後寫入的 frame 之後；從沒寫入過時為 null。 */
  get time(): number | null {
    const segment = this.#current();
    if (!segment) return null;
    return segment.time + ((this.#read - segment.start) * segment.rate) / this.#sampleRate;
  }

  /** 下一個要讀出的 frame 的速度；從沒寫入過時為 1。 */
  get rate(): number {
    return this.#current()?.rate ?? 1;
  }

  /** 從下一個要讀出的 frame 到下一段開始（速度可能改變）之前的 frame 數；沒有下一段時是 `buffered`。 */
  get framesInSegment(): number {
    const next = this.#segments.find((s) => s.start > this.#read);
    return next ? next.start - this.#read : this.buffered;
  }

  #current(): { start: number; time: number; rate: number } | undefined {
    return this.#segments.findLast((s) => s.start <= this.#read) ?? this.#segments[0];
  }

  /** 寫入一段 PCM（mono 時複製到兩個聲道）；放不下的部分丟掉。回傳寫入的 frame 數。 */
  write(time: number, channels: readonly Float32Array[], rate = 1): number {
    const left = channels[0];
    if (!left) return 0;
    const right = channels[1] ?? left;
    const frames = Math.min(left.length, this.capacity - this.buffered);
    if (frames <= 0) return 0;
    this.#segments.push({ start: this.#write, time, rate });
    this.#copy(left, right, frames);
    this.#write += frames;
    return frames;
  }

  /** 讀出 `frames` 個 frame，寫進 `output` 每個聲道的 `offset` 起；必須 `frames <= buffered`。 */
  read(output: readonly Float32Array[], offset: number, frames: number): void {
    const capacity = this.capacity;
    let done = 0;
    while (done < frames) {
      const at = (this.#read + done) % capacity;
      const count = Math.min(frames - done, capacity - at);
      for (const [index, channel] of output.entries()) {
        const source = this.#channels[index === 0 ? 0 : 1];
        channel.set(source.subarray(at, at + count), offset + done);
      }
      done += count;
    }
    this.#read += frames;
    // 只留下包含 #read 的那一段與之後的段。
    const current = this.#segments.findLastIndex((s) => s.start <= this.#read);
    if (current > 0) this.#segments = this.#segments.slice(current);
  }

  clear(): void {
    this.#read = this.#write = 0;
    this.#segments = [];
  }

  #copy(left: Float32Array, right: Float32Array, frames: number): void {
    const capacity = this.capacity;
    let done = 0;
    while (done < frames) {
      const at = (this.#write + done) % capacity;
      const count = Math.min(frames - done, capacity - at);
      this.#channels[0].set(left.subarray(done, done + count), at);
      this.#channels[1].set(right.subarray(done, done + count), at);
      done += count;
    }
  }
}

/** worklet 與 media Worker 之間的 PCM 傳輸。v1 只有 MessagePort 版（`messagePortTransport`），不用 SharedArrayBuffer。 */
export interface PcmTransport {
  post(message: WorkletToWorkerMessage, transfer: ArrayBuffer[]): void;
  /** 開始接收 Worker 的訊息；每個 transport 只呼叫一次。 */
  listen(onMessage: (message: WorkerToWorkletMessage) => void): void;
  close(): void;
}

/** 以 `MessagePort` 實作的 `PcmTransport`。 */
export function messagePortTransport(port: MessagePort): PcmTransport {
  return {
    post(message, transfer) {
      port.postMessage(message, transfer);
    },
    listen(onMessage) {
      port.onmessage = ({ data }: MessageEvent<WorkerToWorkletMessage>) => {
        onMessage(data);
      };
    },
    close() {
      port.onmessage = null;
      port.close();
    },
  };
}

export interface OutputCoreOptions {
  /** `AudioContext.sampleRate`。 */
  sampleRate: number;
  audioBuffer: WorkletProcessorOptions['audioBuffer'];
  audioFadeMs: WorkletProcessorOptions['audioFadeMs'];
  /** 送給主執行緒。 */
  report: (message: WorkletToMainMessage) => void;
}

/**
 * worklet 的本體：依主執行緒的指令（flush、play、pause、duration）與 Worker 的 PCM 決定每個 render quantum 的輸出，
 * 並推進音訊時鐘。時鐘只在播出 media sample（或 `eof` 之後補到 `duration` 的靜音）時前進。
 *
 * 淡入淡出（`audioFadeMs`，0 為硬切）逐 sample 線性：開始輸出時淡入；pause 時淡出，淡出的 sample 照常推進時鐘，
 * 淡出結束才停住並回報 `paused`；ring 快用完（還沒 `eof`）時提前淡出，讓最後一個 sample 落在 0；flush 時把 ring 內
 * 接下來的一段舊資料另外淡出（不推進時鐘），與新 epoch 的淡入相加。
 *
 * 狀態的轉換在收到訊息時就判斷，不等 `render()`：context 還沒開始跑時，load 也能在補滿後完成。
 */
export class OutputCore {
  readonly #sampleRate: number;
  readonly #marks: Watermarks;
  readonly #ring: PcmRing;
  readonly #report: (message: WorkletToMainMessage) => void;
  /** 淡入淡出的 frame 數；0 為硬切。 */
  readonly #fadeFrames: number;
  #transport: PcmTransport | null = null;
  /** 淡入淡出的包絡（0–1），每個輸出的 sample 乘上它；硬切時不使用。 */
  #gain = 0;
  /** flush 時從 ring 取出、已套上淡出的舊資料，在之後的 quantum 加進輸出。 */
  #tail: { channels: [Float32Array, Float32Array]; offset: number } | null = null;

  /** 第一個 flush 之前不輸出、不要求資料。 */
  #epoch = -Infinity;
  /** 下一個要播出的 sample 的媒體時間（秒）。 */
  #position = 0;
  #duration = NaN;
  #playIntent = false;
  /** 主執行緒的播放速度：沒有 PCM（`eof` 之後）時以靜音推進時鐘的速度。 */
  #rate = 1;
  /** 最後一個 clock 帶的速度。 */
  #clockRate = 1;
  /** flush 之後已補滿（回報過 playing／paused）。 */
  #filled = false;
  /** 播放中 ring 用完，等補回 target。 */
  #starved = false;
  #outputting = false;
  #eof = false;
  /** `eof` 之後補上的靜音：開始的位置與累計的 frame 數。 */
  #silence: { from: number; frames: number } | null = null;
  #ended = false;
  /** 已要求、還沒收到的 frame 數。 */
  #pending = 0;
  /** 比目前 epoch 新的 Worker 訊息：Worker 可能比 worklet 先換 epoch（例如立即送出的 `eof`），等 flush 到該 epoch 再用。 */
  #early: WorkerToWorkletMessage[] = [];
  #underruns = 0;
  /** 下一個 render quantum 開始的 context frame。 */
  #frame = 0;
  /** 正在 render 的 quantum 開始的 context frame。 */
  #quantumStart = 0;
  #lastClockFrame = 0;

  constructor(options: OutputCoreOptions) {
    this.#sampleRate = options.sampleRate;
    this.#marks = toWatermarks(options.audioBuffer, options.sampleRate);
    this.#ring = new PcmRing(
      Math.max(this.#marks.capacity, this.#marks.target + MAX_CHUNK_FRAMES),
      options.sampleRate,
    );
    this.#report = options.report;
    this.#fadeFrames = Math.round((options.audioFadeMs * options.sampleRate) / 1000);
  }

  /** 接上新的 media Worker；之前的 transport 關閉，從它收到、還沒用到的訊息丟掉。 */
  connect(transport: PcmTransport): void {
    this.#transport?.close();
    this.#transport = transport;
    this.#early = [];
    // 新的 Worker 沒有之前的要求。
    this.#pending = 0;
    transport.listen((message) => {
      if (this.#transport === transport) this.#onWorkerMessage(message);
    });
    this.#request();
  }

  handle(message: MainToWorkletMessage): void {
    if (message.type === 'rate') {
      this.#setRate(message.rate);
      return;
    }
    if (message.epoch < this.#epoch) return;
    switch (message.type) {
      case 'flush':
        this.#flush(message.epoch, message.position);
        break;
      case 'play':
        this.#playIntent = true;
        // 淡出途中（還在輸出）：包絡自己轉回淡入。
        if (this.#filled && !this.#starved && !this.#ended && !this.#outputting) {
          this.#startOutput();
          this.#announce('playing');
        }
        break;
      case 'pause':
        this.#playIntent = false;
        if (this.#filled && !this.#ended) {
          // 正在出聲：render() 淡出結束才停住並回報。
          if (this.#outputting && this.#fadeFrames > 0 && this.#gain > 0 && !message.immediate) {
            break;
          }
          this.#outputting = false;
          this.#announce('paused');
        }
        break;
      case 'duration':
        if (message.epoch === this.#epoch) this.#duration = message.duration;
        break;
    }
  }

  /**
   * 填一個 render quantum。`output` 是各聲道的輸出（長度相同），`frame` 是這個 quantum 開始的 context frame
   * （`currentFrame`）。
   */
  render(output: readonly Float32Array[], frame: number): void {
    for (const channel of output) channel.fill(0);
    const frames = output[0]?.length ?? 0;
    this.#quantumStart = frame;
    this.#frame = frame + frames;
    if (this.#outputting) this.#play(output, frames);
    this.#mixTail(output, frames);
    if (
      this.#outputting &&
      this.#frame - this.#lastClockFrame >= CLOCK_INTERVAL_SECONDS * this.#sampleRate
    ) {
      this.#clock();
    }
    this.#request();
  }

  /** 主執行緒改了速度：正在以靜音推進時，從當下的位置換算並立即送出 clock。 */
  #setRate(rate: number): void {
    if (rate === this.#rate) return;
    this.#rate = rate;
    if (this.#silence) this.#silence = { from: this.#position, frames: 0 };
    if (this.#outputting && this.#ring.buffered === 0 && this.#eof) this.#clock();
  }

  #flush(epoch: number, position: number): void {
    if (this.#outputting && this.#fadeFrames > 0 && this.#gain > 0) this.#captureTail();
    this.#epoch = epoch;
    this.#position = position;
    this.#ring.clear();
    this.#silence = null;
    this.#pending = 0;
    this.#filled = this.#starved = this.#outputting = this.#eof = this.#ended = false;
    const early = this.#early;
    this.#early = [];
    for (const message of early) this.#onWorkerMessage(message);
    this.#request();
  }

  #onWorkerMessage(message: WorkerToWorkletMessage): void {
    if (message.epoch > this.#epoch) {
      this.#early.push(message);
      return;
    }
    switch (message.type) {
      case 'pcm': {
        if (message.epoch === this.#epoch && !this.#ended) {
          const frames = message.channels[0]?.length ?? 0;
          this.#ring.write(message.time, message.channels, message.rate);
          this.#pending = Math.max(0, this.#pending - frames);
        }
        // 已經複製進 ring（或過期而丟掉）：buffer 立即還給 Worker。
        const buffers = message.channels.map((c) => c.buffer as ArrayBuffer);
        this.#transport?.post({ type: 'release', buffers }, buffers);
        break;
      }
      case 'eof':
        if (message.epoch === this.#epoch) this.#eof = true;
        break;
    }
    if (message.epoch !== this.#epoch) return;
    this.#refilled();
    this.#request();
  }

  /** ring 補到 target（或已經 eof）時，結束補滿或 starved。 */
  #refilled(): void {
    if (this.#ended || (this.#ring.buffered < this.#marks.target && !this.#eof)) return;
    if (!this.#filled) {
      this.#filled = true;
      if (this.#playIntent) this.#startOutput();
      this.#announce(this.#playIntent ? 'playing' : 'paused');
    } else if (this.#starved) {
      this.#starved = false;
      if (this.#playIntent) {
        this.#startOutput();
        this.#announce('playing');
      }
    }
  }

  /** 開始輸出：從 0 淡入。 */
  #startOutput(): void {
    this.#outputting = true;
    this.#gain = 0;
  }

  /**
   * 從 ring 播出最多 `frames` 個 frame；ring 用完時 starved，到 `duration` 時 ended，pause 的淡出結束時停住。
   * 停住、starved、ended 回報的 clock 帶停住那個 sample 的 context frame。
   */
  #play(output: readonly Float32Array[], frames: number): void {
    let written = 0;
    while (written < frames) {
      if (this.#fadedOut()) {
        this.#stop(written);
        return;
      }
      const ringTime = this.#ring.buffered > 0 ? this.#ring.time : null;
      const remaining = this.#framesUntilEnd(ringTime ?? this.#position);
      if (remaining <= 0) {
        this.#end(written);
        return;
      }
      if (ringTime !== null) {
        const available = this.#ring.buffered;
        const count = Math.min(
          frames - written,
          this.#ring.framesInSegment,
          remaining,
          this.#framesUntilSilent(),
        );
        this.#ring.read(output, written, count);
        this.#envelope(output, written, count, available);
        written += count;
        this.#position = this.#ring.time ?? this.#position;
        // 換到不同速度的一段（drain 的接點）：從這個 frame 起依新的速度內插。
        if (this.#ring.buffered > 0 && this.#ring.rate !== this.#clockRate) {
          this.#clock(this.#quantumStart + written);
        }
      } else if (this.#eof) {
        if (!Number.isFinite(remaining)) {
          // duration 未知：音訊播完就結束。
          this.#end(written);
          return;
        }
        // 沒有音訊（或音訊比媒體短）：以靜音推進到 duration。以 frame 數換算，避免逐次累加的誤差。
        const count = Math.min(frames - written, remaining, this.#framesUntilSilent());
        this.#envelope(output, written, count, Infinity);
        written += count;
        this.#silence ??= { from: this.#position, frames: 0 };
        this.#silence.frames += count;
        this.#position =
          this.#silence.from + (this.#silence.frames * this.#rate) / this.#sampleRate;
      } else {
        this.#outputting = false;
        this.#starved = true;
        this.#underruns++;
        this.#announce('starved', this.#quantumStart + written);
        return;
      }
    }
    // 剛好播到 duration 或淡出結束時立即處理，不等下一個 quantum。
    if (this.#framesUntilEnd(this.#position) <= 0) this.#end(frames);
    else if (this.#fadedOut()) this.#stop(frames);
  }

  /** pause 的淡出已經結束。 */
  #fadedOut(): boolean {
    return !this.#playIntent && (this.#fadeFrames === 0 || this.#gain <= 0);
  }

  /** pause 的淡出結束：停住時鐘並回報 `paused`。 */
  #stop(written: number): void {
    this.#outputting = false;
    this.#announce('paused', this.#quantumStart + written);
  }

  /** pause 淡出時還要播出幾個 sample 才降到 0；不是在淡出時為 Infinity。 */
  #framesUntilSilent(): number {
    if (this.#playIntent || this.#fadeFrames === 0) return Infinity;
    return Math.max(1, Math.ceil(this.#gain * this.#fadeFrames - EPSILON));
  }

  /**
   * 對 `output` 的 `[offset, offset + count)` 套上包絡。`available` 是第一個 sample 之前 ring 內的 frame 數：
   * 還沒 `eof` 而剩下的 frame 不夠淡出時往下淡出，讓 ring 的最後一個 sample 落在 0。
   */
  #envelope(
    output: readonly Float32Array[],
    offset: number,
    count: number,
    available: number,
  ): void {
    const fade = this.#fadeFrames;
    if (fade === 0) return;
    const step = 1 / fade;
    let gain = this.#gain;
    for (let i = 0; i < count; i++) {
      const left = available - i;
      const down = !this.#playIntent || (!this.#eof && left <= gain * fade + EPSILON);
      gain = down ? gain - step : gain + step;
      // 逐次加減的浮點誤差不讓包絡停在 0 或 1 的附近。
      gain = gain < EPSILON ? 0 : gain > 1 - EPSILON ? 1 : gain;
      if (gain < 1) {
        for (const channel of output) channel[offset + i] = (channel[offset + i] ?? 0) * gain;
      }
    }
    this.#gain = gain;
  }

  /** flush 時取出 ring 內接下來的一段舊資料，從目前的包絡線性淡出到 0（ring 不夠時以較短的長度淡完）。 */
  #captureTail(): void {
    const frames = Math.min(
      Math.ceil(this.#gain * this.#fadeFrames - EPSILON),
      this.#ring.buffered,
      this.#framesUntilEnd(this.#position),
    );
    if (frames <= 0) return;
    const channels: [Float32Array, Float32Array] = [
      new Float32Array(frames),
      new Float32Array(frames),
    ];
    this.#ring.read(channels, 0, frames);
    for (let i = 0; i < frames; i++) {
      const gain = this.#gain * (1 - (i + 1) / frames);
      for (const channel of channels) channel[i] = (channel[i] ?? 0) * gain;
    }
    this.#tail = { channels, offset: 0 };
  }

  /** 把 flush 留下的淡出加進這個 quantum。 */
  #mixTail(output: readonly Float32Array[], frames: number): void {
    const tail = this.#tail;
    if (!tail) return;
    const count = Math.min(frames, tail.channels[0].length - tail.offset);
    for (const [index, channel] of output.entries()) {
      const source = tail.channels[index === 0 ? 0 : 1];
      for (let i = 0; i < count; i++) {
        channel[i] = (channel[i] ?? 0) + (source[tail.offset + i] ?? 0);
      }
    }
    tail.offset += count;
    if (tail.offset >= tail.channels[0].length) this.#tail = null;
  }

  /**
   * 從媒體時間 `time` 到 `duration` 還有幾個 frame（依目前的速度：ring 內的那一段，沒有資料時是主執行緒的速度）；
   * duration 未知時為 Infinity。
   */
  #framesUntilEnd(time: number): number {
    if (Number.isNaN(this.#duration)) return Infinity;
    return Math.round(((this.#duration - time) * this.#sampleRate) / this.#currentRate());
  }

  #currentRate(): number {
    return this.#ring.buffered > 0 ? this.#ring.rate : this.#rate;
  }

  #end(written: number): void {
    // 超出 duration 的音訊截掉。
    this.#ring.clear();
    if (!Number.isNaN(this.#duration)) this.#position = this.#duration;
    this.#outputting = false;
    this.#ended = true;
    this.#announce('ended', this.#quantumStart + written);
  }

  #request(): void {
    if (!this.#transport || this.#eof || this.#ended || this.#epoch === -Infinity) return;
    const level = this.#ring.buffered + this.#pending;
    const frames = framesToRequest(this.#marks, level, !this.#filled || this.#starved);
    if (frames <= 0) return;
    this.#pending += frames;
    this.#transport.post({ type: 'need', epoch: this.#epoch, frames }, []);
  }

  /** 先送出時鐘，再送出狀態。`frame` 是 `position` 的 sample 進入 graph 的 context frame。 */
  #announce(type: 'playing' | 'paused' | 'starved' | 'ended', frame = this.#frame): void {
    this.#clock(frame);
    this.#report({ type, epoch: this.#epoch });
  }

  #clock(frame = this.#frame): void {
    this.#lastClockFrame = frame;
    this.#clockRate = this.#currentRate();
    this.#report({
      type: 'clock',
      epoch: this.#epoch,
      position: this.#position,
      frame,
      rate: this.#clockRate,
      buffered: this.#ring.buffered,
      underruns: this.#underruns,
    });
  }
}

/** worklet 的 host 物件型別。 */
interface WorkletHost extends HostTypes {
  wasmModule: never;
  messagePort: MessagePort;
  blob: never;
}

// 只在 AudioWorkletGlobalScope 內註冊；Node 測試 import 這個檔案時不執行。
if ('registerProcessor' in globalThis) {
  const name: WorkletProcessorName = 'kikoeru-player-output';
  registerProcessor(
    name,
    class extends AudioWorkletProcessor {
      readonly #core: OutputCore;

      constructor(options: { processorOptions: WorkletProcessorOptions }) {
        super();
        this.#core = new OutputCore({
          sampleRate,
          audioBuffer: options.processorOptions.audioBuffer,
          audioFadeMs: options.processorOptions.audioFadeMs,
          report: (message) => {
            this.port.postMessage(message);
          },
        });
        this.port.onmessage = ({
          data,
        }: MessageEvent<MainToWorkletMessage | WorkletConnectMessage<WorkletHost>>) => {
          if (data.type === 'connect') this.#core.connect(messagePortTransport(data.port));
          else this.#core.handle(data);
        };
      }

      process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        this.#core.render(outputs[0] ?? [], currentFrame);
        return true;
      }
    },
  );
}

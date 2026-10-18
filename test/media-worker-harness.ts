// browser mode 測試用：載入 wasm 資產與測試媒體，以協定驅動 media Worker 並收集它送出的 PCM。
// 測試扮演主執行緒與 AudioWorklet：init 時給 MessageChannel 的一端，從另一端送 need、收 pcm／eof。

import type {
  MainToWorkerMessage,
  ProbedAudioTrack,
  ProbedMedia,
  RetryPolicy,
  WorkerLimits,
  WorkerStats,
  WorkerToMainMessage,
  WorkerToWorkletMessage,
  WorkletPcmMessage,
} from '../src/protocol/index.js';
import type { WorkerHost as BrowserHost } from '../src/worker/host.js';
import type { LibavAssets } from '../src/worker/libav.js';

/** 桌面平台的 `WorkerLimits`（Engine 的預設值）。 */
export const desktopLimits: WorkerLimits = {
  cacheBytes: 128 * 1024 * 1024,
  readaheadSeconds: 60,
  packetQueueBytes: 64 * 1024 * 1024,
};

/** 主執行緒 compile 一次、分給每個 Worker 的 wasm（與 Engine 相同的做法）。 */
let assets: Promise<LibavAssets> | null = null;

export function wasmAssets(): Promise<LibavAssets> {
  assets ??= (async () => {
    const base = new URL('/wasm/dist/', location.href);
    const module = await WebAssembly.compileStreaming(
      fetch(new URL('libav-6.10.9.0-kikoeru.wasm.wasm', base)),
    );
    return { module, glueUrl: new URL('libav-6.10.9.0-kikoeru.wasm.mjs', base).href };
  })();
  return assets;
}

/**
 * 只 import 一個函式 `module.field`、其餘什麼都沒有的極小 wasm，用來模擬 imports 與 glue 不符的資產。
 * 名稱限 ASCII 且短於 128 bytes（長度以單一 byte 的 LEB128 編碼）。
 */
export function importOnlyWasm(module: string, field: string): WebAssembly.Module {
  const name = (s: string) => [s.length, ...new TextEncoder().encode(s)];
  const section = (id: number, payload: number[]) => [id, payload.length, ...payload];
  return new WebAssembly.Module(
    Uint8Array.from([
      ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
      // type section：一個 () => void。
      ...section(1, [1, 0x60, 0, 0]),
      // import section：一個 func import，型別 0。
      ...section(2, [1, ...name(module), ...name(field), 0x00, 0]),
    ]),
  );
}

/**
 * CI 組測試媒體的 URL（`test/media/out/` 之下的路徑），由 test/server 的 `/media/*` 提供。Vitest 自己的靜態檔案
 * 不正確處理 Range（`bytes=0-0` 回應整個檔案），不用它。
 */
export function mediaUrl(path: string): string {
  return new URL(`/media/${path}`, location.href).href;
}

let faultSeq = 0;

/**
 * test/server 的 `/media/*` 加上故障參數（例如 `fault=503@2`，見 test/server/faults.ts）。每次呼叫帶一個不重複的
 * `id`，故障的請求計數不受其他測試影響。
 */
export function faultyMediaUrl(path: string, faults: string): string {
  const id = `${String(Date.now())}-${String(++faultSeq)}`;
  return new URL(`/media/${path}?id=${id}&${faults}`, location.href).href;
}

export async function mediaBytes(path: string): Promise<ArrayBuffer> {
  const response = await fetch(mediaUrl(path));
  if (!response.ok) throw new Error(`${path}：HTTP ${String(response.status)}`);
  return response.arrayBuffer();
}

/** 能收發協定訊息的 media Worker：測試內直接建立的 `MediaWorker`，或真實的 Worker。 */
export interface WorkerEndpoint {
  post(message: MainToWorkerMessage<BrowserHost>, transfer?: Transferable[]): void;
  onMessage(listener: (message: WorkerToMainMessage) => void): void;
}

/** 解出的音訊。 */
export interface DecodedPcm {
  sampleRate: number;
  /** 第一個 chunk 的媒體時間。 */
  time: number;
  left: Float32Array;
  right: Float32Array;
  chunks: WorkletPcmMessage[];
}

/** 以協定驅動一個 media Worker：init、load、start、要資料。 */
export class WorkerDriver {
  readonly messages: WorkerToMainMessage[] = [];
  readonly worklet: WorkerToWorkletMessage[] = [];
  readonly sampleRate: number;
  readonly #endpoint: WorkerEndpoint;
  readonly #port: MessagePort;
  readonly #listeners = new Set<() => void>();
  #statsId = 0;

  private constructor(endpoint: WorkerEndpoint, port: MessagePort, sampleRate: number) {
    this.#endpoint = endpoint;
    this.#port = port;
    this.sampleRate = sampleRate;
    endpoint.onMessage((message) => {
      this.messages.push(message);
      this.#notify();
    });
    port.onmessage = ({ data }: MessageEvent<WorkerToWorkletMessage>) => {
      this.worklet.push(data);
      this.#notify();
    };
  }

  /**
   * `module` 預設為 `wasmAssets()` 的 Module；給別的 Module 可以模擬與 glue 不符的資產。
   * `retry` 預設不重試；`limits` 預設為桌面的值（`readaheadSeconds` 60）。
   */
  static async init(
    endpoint: WorkerEndpoint,
    options: {
      sampleRate?: number;
      module?: WebAssembly.Module;
      retry?: RetryPolicy;
      limits?: Partial<WorkerLimits>;
      /** 播放速度，預設 1。 */
      rate?: number;
    } = {},
  ): Promise<WorkerDriver> {
    const assets = await wasmAssets();
    const {
      sampleRate = 48_000,
      module = assets.module,
      retry = { attempts: 0, baseDelayMs: 0 },
      rate = 1,
    } = options;
    const limits: WorkerLimits = { ...desktopLimits, ...options.limits };
    const { glueUrl } = assets;
    const channel = new MessageChannel();
    endpoint.post(
      {
        type: 'init',
        module,
        glueUrl,
        workletPort: channel.port1,
        sampleRate,
        retry,
        limits,
        rate,
      },
      [channel.port1],
    );
    return new WorkerDriver(endpoint, channel.port2, sampleRate);
  }

  post(message: MainToWorkerMessage<BrowserHost>, transfer?: Transferable[]): void {
    this.#endpoint.post(message, transfer);
  }

  /** load 並等到 probe 或 error。 */
  async load(
    source: Extract<MainToWorkerMessage<BrowserHost>, { type: 'load' }>['source'],
    epoch = 1,
  ): Promise<ProbedMedia> {
    this.post({ type: 'load', epoch, source });
    const reply = await this.waitFor(
      (m) => (m.type === 'probe' || m.type === 'error') && m.epoch === epoch,
    );
    if (reply.type === 'error') throw Object.assign(new Error(reply.error.message), reply.error);
    if (reply.type !== 'probe') throw new Error('unreachable');
    return reply.media;
  }

  /** 從 `time` 開始輸出 `audio` 軌，要 `frames` 個 frame（預設全部），等到 EOF 或送滿。 */
  async decode(
    audio: number | null,
    options: { epoch?: number; time?: number; frames?: number } = {},
  ): Promise<DecodedPcm> {
    const epoch = options.epoch ?? 1;
    this.post({ type: 'start', epoch, time: options.time ?? 0, audio });
    return this.collect(epoch, options.frames);
  }

  /** seek 到 `time`，以新的 `epoch` 要 `frames` 個 frame（預設全部），等到 EOF 或送滿。 */
  async seek(time: number, epoch: number, frames?: number): Promise<DecodedPcm> {
    this.post({ type: 'seek', epoch, time });
    return this.collect(epoch, frames);
  }

  /** 要 `epoch` 的 `frames` 個 frame（預設全部），收集之後送來的 PCM，等到 EOF 或送滿。 */
  async collect(epoch: number, frames = 1e12): Promise<DecodedPcm> {
    const from = this.worklet.length;
    this.need(epoch, frames);
    const ofEpoch = () => this.worklet.slice(from).filter((m) => m.epoch === epoch);
    const pcm = () => ofEpoch().filter((m): m is WorkletPcmMessage => m.type === 'pcm');
    await this.#until(
      () =>
        ofEpoch().some((m) => m.type === 'eof') ||
        pcm().reduce((sum, m) => sum + (m.channels[0]?.length ?? 0), 0) >= frames ||
        this.messages.some((m) => m.type === 'error' || m.type === 'crash'),
    );
    const failure = this.messages.find((m) => m.type === 'error' || m.type === 'crash');
    if (failure) throw Object.assign(new Error(JSON.stringify(failure)), failure);
    const chunks = pcm();
    return {
      sampleRate: this.sampleRate,
      time: chunks[0]?.time ?? NaN,
      left: concat(chunks.map((c) => c.channels[0] ?? new Float32Array())),
      right: concat(chunks.map((c) => c.channels[1] ?? new Float32Array())),
      chunks,
    };
  }

  need(epoch: number, frames: number): void {
    this.#port.postMessage({ type: 'need', epoch, frames });
  }

  async stats(): Promise<WorkerStats> {
    const id = ++this.#statsId;
    this.post({ type: 'stats', id });
    const reply = await this.waitFor((m) => m.type === 'stats' && m.id === id);
    if (reply.type !== 'stats') throw new Error('unreachable');
    return reply.stats;
  }

  async waitFor(match: (m: WorkerToMainMessage) => boolean): Promise<WorkerToMainMessage> {
    await this.#until(() => this.messages.some(match));
    const found = this.messages.find(match);
    if (!found) throw new Error('unreachable');
    return found;
  }

  #until(done: () => boolean): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (!done()) return;
        this.#listeners.delete(check);
        resolve();
      };
      this.#listeners.add(check);
    });
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

export function audioTracks(media: ProbedMedia): ProbedAudioTrack[] {
  return media.tracks.filter((t): t is ProbedAudioTrack => t.kind === 'audio');
}

function concat(parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ───────────────────────────── 訊號分析 ─────────────────────────────

/**
 * beep 的起點（秒）：超過門檻、且前面至少 0.5 秒都在門檻以下的 sample。測試媒體的 beep 從相位 0 開始，
 * 振幅 0.5（test/media/README.md）。
 */
export function beepOnsets(samples: Float32Array, sampleRate: number, threshold = 0.1): number[] {
  const onsets: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i] ?? 0) <= threshold) continue;
    if (i - last > sampleRate / 2) onsets.push(i / sampleRate);
    last = i;
  }
  return onsets;
}

export function peak(samples: Float32Array): number {
  let max = 0;
  for (const x of samples) max = Math.max(max, Math.abs(x));
  return max;
}

/** `frequency` 在 `[start, start + length)` 的振幅（Hann window 的 Goertzel，減少鄰近頻率的洩漏）。 */
export function amplitudeAt(
  samples: Float32Array,
  sampleRate: number,
  frequency: number,
  start: number,
  length: number,
): number {
  const k = (2 * Math.PI * frequency) / sampleRate;
  const coefficient = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  let gain = 0;
  for (let i = 0; i < length; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
    gain += w;
    const s0 = (samples[start + i] ?? 0) * w + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coefficient * s1 * s2;
  return (2 * Math.sqrt(Math.max(0, power))) / gain;
}

/** 以 JS 產生一個 PCM s16 的 WAV：每整秒開始的 0.1 秒是振幅 0.5、880 Hz 的 beep。 */
export function beepWav(options: {
  sampleRate: number;
  channels: number;
  seconds: number;
  formatTag?: number;
}): ArrayBuffer {
  const { sampleRate, channels, seconds } = options;
  const frames = sampleRate * seconds;
  const bytes = frames * channels * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, options.formatTag ?? 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, bytes, true);
  for (let i = 0; i < frames; i++) {
    const t = i % sampleRate;
    const value = t < sampleRate / 10 ? 0.5 * Math.sin((2 * Math.PI * 880 * t) / sampleRate) : 0;
    for (let c = 0; c < channels; c++) {
      view.setInt16(44 + (i * channels + c) * 2, Math.round(value * 32767), true);
    }
  }
  return view.buffer;
}

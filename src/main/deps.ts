// Engine 對外部資源的依賴（createEngineWith 的 deps）。真實實作由 createEngine() 提供，Node 測試注入 test/fakes/。

import type {
  MainToWorkerMessage,
  MainToWorkletMessage,
  WireLogEntry,
  WireLogLevel,
  WorkerToMainMessage,
  WorkletToMainMessage,
} from '../protocol/index.js';
import type { Platform } from './platform.js';

/** 主執行緒的 host 物件型別。 */
export interface MainHost {
  wasmModule: WebAssembly.Module;
  messagePort: MessagePort;
  blob: Blob;
}

/** compile 好的 wasm 與 libav.js glue 的 URL。 */
export interface WasmAssets {
  module: WebAssembly.Module;
  glueUrl: string;
}

/**
 * 資產（wasm、glue、Worker、worklet）載入失敗；deps 以它 reject，Engine 回報 `ASSET_LOAD_FAILED`。
 * 其他的失敗依發生處分類（例如音訊輸出的是 `AUDIO_OUTPUT`）。
 */
export class AssetLoadError extends Error {
  override readonly name = 'AssetLoadError';
}

/** `createEngineWith()` 的依賴。 */
export interface EngineDeps {
  /** 平台；決定 `audioBuffer` 與 `limits` 的預設值。 */
  platform: Platform;
  /** compile wasm 並解析 glue 的 URL；Engine 只在成功前重試，成功後持有結果給每個 Worker。 */
  loadWasm(): Promise<WasmAssets>;
  /** 建立一個新的 media Worker（每次 load 一個）。 */
  createWorker(handlers: MediaWorkerHandlers): MediaWorker;
  /**
   * 建立音訊輸出：一個新的 `AudioContext` 與 AudioWorklet。平常整個 Engine 一個；watchdog 重建 context 時再建立一個，
   * 舊的由 Engine 斷開並關閉。
   */
  createAudioOutput(handlers: AudioOutputHandlers, config: AudioOutputConfig): AudioOutput;
}

/** 音訊輸出的回呼。 */
export interface AudioOutputHandlers {
  /** AudioWorklet 的訊息。 */
  message(message: WorkletToMainMessage): void;
  /**
   * `AudioContext` 的 `statechange`，帶事件當下的 `state`（WebKit 有 `'interrupted'`）。Engine 只用它偵測
   * Engine 以外的變化（中斷、外部的 suspend／resume），不以它決定自己的流程。
   */
  statechange(state: AudioContextState): void;
  /** AudioWorklet 的 log，`time` 已換算成主執行緒的 `performance.now()` 時基。 */
  log(entry: WireLogEntry): void;
}

/** 音訊輸出的設定，取自 `EngineOptions`。 */
export interface AudioOutputConfig {
  /** ring buffer 的水位（ms），補上預設值之後。 */
  audioBuffer: { targetMs: number; refillMs: number; capacityMs: number };
  /** 淡入淡出的長度（ms），即 `EngineOptions.audioFadeMs`；0 為硬切。 */
  audioFadeMs: number;
  /** `EngineOptions.assets.workletUrl`；沒給時用套件內的 worklet。 */
  workletUrl?: string | URL;
  /** worklet 送出 log 的最低等級；null 表示不送（App 沒有設定 log hook）。 */
  logLevel: WireLogLevel | null;
}

/** media Worker 的回呼。 */
export interface MediaWorkerHandlers {
  message(message: WorkerToMainMessage): void;
  /**
   * Worker 已無法繼續運作：`error`／`messageerror`。Worker 的 script 載入失敗時以 `AssetLoadError` 呼叫
   *（Engine 回報 `ASSET_LOAD_FAILED`），其他情況 Engine 回報 `INTERNAL`。
   */
  crash(error: unknown): void;
}

/** 一個 media Worker。 */
export interface MediaWorker {
  post(message: MainToWorkerMessage<MainHost>, transfer?: Transferable[]): void;
  terminate(): void;
}

/** 主執行緒的音訊輸出：`AudioContext` 與 AudioWorklet。 */
export interface AudioOutput {
  /** `AudioContext.sampleRate`。 */
  readonly sampleRate: number;
  /**
   * 建立新的 `MessageChannel`，一端接上 worklet，回傳交給新的 media Worker 的另一端。
   * worklet 載入失敗時以 `AssetLoadError` reject，其他失敗（例如建立 `AudioWorkletNode`）以原本的錯誤 reject。
   * 載入完成前已經 `disconnect()` 時也 reject，且不建立 node、不接上 destination。
   */
  connect(): Promise<MessagePort>;
  /**
   * 此刻聽到的 sample 的 context frame（與 worklet 的 `currentFrame` 同一條軸）：以 `getOutputTimestamp()` 換算為主，
   * 取不到時依序用 `outputLatency`、`baseLatency`（見 `heardContextTime()`）。context 還沒開始時為 null。
   */
  heardFrame(): number | null;
  /** 輸出延遲（秒）：sample 進入 audio graph 到被聽到的時間；`getStats().audio.outputLatencyMs` 的來源。 */
  outputLatency(): number;
  /**
   * worklet 後面的 `GainNode` 的值（音量與靜音）。`smooth` 時以 `setTargetAtTime`（time constant 約 10 ms）趨近，
   * 否則立即套用（剛建立、還沒出聲時）。不用 `linearRampToValueAtTime`（Firefox bug 2011524）。
   */
  setGain(gain: number, smooth: boolean): void;
  /** 送給 worklet；worklet 還沒載入完成時先排隊，載入後依序送出。 */
  post(message: MainToWorkletMessage): void;
  /**
   * 原樣呼叫 `AudioContext.resume()`，在呼叫內同步呼叫（在 user gesture 的同步段內才能解鎖）。不排隊、不 timeout：
   * `resume()`、`suspend()`、`close()` 一律由 Engine 的串行佇列呼叫（硬性約束第 4 條、ADR-0004）。
   */
  resume(): Promise<void>;
  /** 原樣呼叫 `AudioContext.suspend()`；由 Engine 的串行佇列呼叫。 */
  suspend(): Promise<void>;
  /** 原樣呼叫 `AudioContext.close()`；由 Engine 的串行佇列呼叫。 */
  close(): Promise<void>;
  /** 斷開 worklet，之後不再呼叫 handlers。 */
  disconnect(): void;
}

// Engine 對外部資源的依賴（createEngineWith 的 deps）。真實實作由 createEngine() 提供，Node 測試注入 test/fakes/。

import type {
  MainToWorkerMessage,
  MainToWorkletMessage,
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

/** `createEngineWith()` 的依賴。 */
export interface EngineDeps {
  /** 平台；決定 `audioBuffer` 與 `limits` 的預設值。 */
  platform: Platform;
  /** compile wasm 並解析 glue 的 URL；Engine 只在成功前重試，成功後持有結果給每個 Worker。 */
  loadWasm(): Promise<WasmAssets>;
  /** 建立一個新的 media Worker（每次 load 一個）。 */
  createWorker(handlers: MediaWorkerHandlers): MediaWorker;
  /** 建立音訊輸出（整個 Engine 一個）；`onMessage` 接收 AudioWorklet 的訊息。 */
  createAudioOutput(onMessage: (message: WorkletToMainMessage) => void): AudioOutput;
}

/** media Worker 的回呼。 */
export interface MediaWorkerHandlers {
  message(message: WorkerToMainMessage): void;
  /** Worker 的 `error`／`messageerror`：Worker 已無法繼續運作。 */
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
  /** 建立新的 `MessageChannel`，一端接上 worklet，回傳交給新的 media Worker 的另一端。 */
  connect(): Promise<MessagePort>;
  post(message: MainToWorkletMessage): void;
  /** 斷開 worklet。 */
  disconnect(): void;
  /**
   * 關閉 `AudioContext`。實作經 Engine 自己的 `AudioContext` 串行佇列並帶 timeout（硬性約束第 4 條、ADR-0004，
   * 由「AudioContext 生命週期」#41 加入），所以這個 Promise 一定會 settle。
   */
  close(): Promise<void>;
}

// 主執行緒 ↔ media Worker 的訊息。會影響輸出的訊息都帶 epoch，收方丟棄過期的 epoch。

import type { HostTypes, ProbedMedia, WireError, WireSource } from './media.js';

/** 主執行緒送給 media Worker 的訊息。 */
export type MainToWorkerMessage<H extends HostTypes> =
  WorkerInitMessage<H> | WorkerLoadMessage<H> | WorkerStartMessage | WorkerSeekMessage;

/** Worker 建立後的第一個訊息；`workletPort` 以 transfer 傳送。 */
export interface WorkerInitMessage<H extends HostTypes> {
  type: 'init';
  /** 主執行緒 compile 一次、持有並分給每個 Worker 的 wasm。 */
  module: H['wasmModule'];
  /** libav.js 的 glue，Worker 以動態 import 載入。 */
  glueUrl: string;
  /** 直接供料給 AudioWorklet 的 `MessageChannel` 一端；每個 Worker 一條新的 channel。 */
  workletPort: H['messagePort'];
  /** `AudioContext.sampleRate`；filter graph 重採樣到這個取樣率。 */
  sampleRate: number;
}

/** 開檔並 probe；完成時回覆 `probe`。 */
export interface WorkerLoadMessage<H extends HostTypes> {
  type: 'load';
  epoch: number;
  source: WireSource<H>;
}

/** probe 之後開始輸出：選用軌道，從 `time`（秒）開始供料。 */
export interface WorkerStartMessage {
  type: 'start';
  epoch: number;
  time: number;
  /** 選用音軌的 stream index；null 表示不輸出音訊（worklet 以靜音推進時鐘）。 */
  audio: number | null;
}

/** 中止進行中的讀取，從 `time`（秒）重新供料。 */
export interface WorkerSeekMessage {
  type: 'seek';
  epoch: number;
  time: number;
}

/** media Worker 送給主執行緒的訊息。 */
export type WorkerToMainMessage = WorkerProbeMessage | WorkerErrorMessage | WorkerCrashMessage;

/** `load` 的 probe 結果。 */
export interface WorkerProbeMessage {
  type: 'probe';
  epoch: number;
  media: ProbedMedia;
}

/** Worker 內可分類的錯誤；fatal 時主執行緒進入 `'error'`。 */
export interface WorkerErrorMessage {
  type: 'error';
  epoch: number;
  error: WireError;
}

/** Worker 無法繼續運作（wasm trap、記憶體用完）；主執行緒回報 `INTERNAL`。 */
export interface WorkerCrashMessage {
  type: 'crash';
  reason: 'wasm-trap' | 'out-of-memory';
  message: string;
}

// 主執行緒 ↔ media Worker 的訊息。會影響輸出的訊息都帶 epoch，收方丟棄過期的 epoch。

import type { HostTypes, ProbedMedia, WireError, WireSource } from './media.js';

/** 主執行緒送給 media Worker 的訊息。 */
export type MainToWorkerMessage<H extends HostTypes> =
  | WorkerInitMessage<H>
  | WorkerLoadMessage<H>
  | WorkerStartMessage
  | WorkerSeekMessage
  | WorkerStatsRequestMessage;

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

/**
 * 開檔並 probe；完成時回覆 `probe`。每個來源一個 libav instance。正在 open／probe 或輸出的前一個 `load`
 * 被取代：它的讀取被中止，instance 被丟棄。
 */
export interface WorkerLoadMessage<H extends HostTypes> {
  type: 'load';
  epoch: number;
  source: WireSource<H>;
}

/**
 * probe 之後開始輸出：只讀選用的音軌（其餘 discard），從 `time`（秒）開始供料，之前的 sample 丟掉。
 * Worker 依 worklet 的 `need` 送出這個 epoch 的 PCM，音訊到結尾時送出 `eof`。
 */
export interface WorkerStartMessage {
  type: 'start';
  epoch: number;
  time: number;
  /** 選用音軌的 stream index；null 表示不輸出音訊：Worker 立即送出 `eof`，worklet 以靜音推進時鐘。 */
  audio: number | null;
}

/** 中止進行中的讀取，從 `time`（秒）重新供料。 */
export interface WorkerSeekMessage {
  type: 'seek';
  epoch: number;
  time: number;
}

/** 要求 Worker 回報它持有的資源；以 `stats` 回覆同一個 `id`。 */
export interface WorkerStatsRequestMessage {
  type: 'stats';
  id: number;
}

/** media Worker 送給主執行緒的訊息。 */
export type WorkerToMainMessage =
  WorkerProbeMessage | WorkerErrorMessage | WorkerCrashMessage | WorkerStatsMessage;

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

/** `stats` 要求的回覆。 */
export interface WorkerStatsMessage {
  type: 'stats';
  id: number;
  stats: WorkerStats;
}

/** media Worker 內的計數，主執行緒彙整進 `getStats()`。 */
export interface WorkerStats {
  /** 目前存在的 libav instance 數：open 開始時加一，被取代或 open／probe 失敗而丟棄時減一。 */
  libavInstances: number;
}

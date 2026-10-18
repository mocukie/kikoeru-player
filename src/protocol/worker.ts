// 主執行緒 ↔ media Worker 的訊息。會影響輸出的訊息都帶 epoch，收方丟棄過期的 epoch。

import type {
  HostTypes,
  ProbedMedia,
  RetryPolicy,
  WireError,
  WireLogEntry,
  WireLogLevel,
  WireSource,
} from './media.js';

/** 主執行緒送給 media Worker 的訊息。 */
export type MainToWorkerMessage<H extends HostTypes> =
  | WorkerInitMessage<H>
  | WorkerLoadMessage<H>
  | WorkerStartMessage
  | WorkerSeekMessage
  | WorkerPortMessage<H>
  | WorkerRateMessage
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
  /** http 讀取的自動重試（`EngineOptions.retry`）。 */
  retry: RetryPolicy;
  /** 記憶體與預讀的上限（ADR-0007）。 */
  limits: WorkerLimits;
  /** 目前的播放速度（`Engine.playbackRate`），之後以 `rate` 改變。 */
  rate: number;
  /**
   * 送出 `log` 的最低等級（`EngineOptions.logLevel`）；低於它的 log 在 Worker 內就丟掉，不跨執行緒傳送。
   * null 表示 App 沒有設定 log hook，Worker 不送任何 log。
   */
  logLevel: WireLogLevel | null;
}

/** 補上平台預設值的 `EngineOptions.limits`，加上內部的封包佇列硬上限。 */
export interface WorkerLimits {
  /** Range 快取的上限（bytes），Worker 內所有 http 來源共用。 */
  cacheBytes: number;
  /** 每個選用中來源的預讀目標（秒）。 */
  readaheadSeconds: number;
  /** 封包佇列的硬上限（bytes），超過時 fatal 的 `MEMORY_LIMIT`。 */
  packetQueueBytes: number;
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
 * probe 之後開始輸出：只讀選用的音軌（其餘 discard），從 `time`（秒）開始供料，精準度同 `seek`。
 * Worker 依 worklet 的 `need` 送出這個 epoch 的 PCM，音訊到結尾時送出 `eof`。每個 load 只送一次；
 * 之後改變位置經由 `seek`。
 */
export interface WorkerStartMessage {
  type: 'start';
  epoch: number;
  time: number;
  /** 選用音軌的 stream index；null 表示不輸出音訊：Worker 立即送出 `eof`，worklet 以靜音推進時鐘。 */
  audio: number | null;
}

/**
 * 換到新的 epoch，從 `time`（秒）重新供料，音軌沿用 `start` 的選擇；`start` 之前收到的 seek 不處理。
 * 中止進行中的讀取，等被取代的供料停下後，跳到 `time` 往前 preroll 的 keyframe 解碼並丟掉之前的 sample：
 * 送出的第一個 sample 就在 `time`（捨入到最近的 sample）。被取代的 seek 與供料不回報任何訊息。
 */
export interface WorkerSeekMessage {
  type: 'seek';
  epoch: number;
  time: number;
}

/**
 * watchdog 重建 AudioContext 之後：改接新的 worklet（`port` 以 transfer 傳送，舊的 port 關閉），並以 `epoch`
 * 從 `time`（秒）重新供料，等同 `seek`。還沒有 `start` 時只換 port。
 */
export interface WorkerPortMessage<H extends HostTypes> {
  type: 'port';
  port: H['messagePort'];
  epoch: number;
  time: number;
}

/**
 * 改變播放速度（不變調，ADR-0004）。不遞增 epoch：已經送出的 PCM（含 worklet 的 ring）照舊速度播完，之後的輸出
 * 才是新的速度。速度沿用到之後的 `start`、`seek`、`port`。
 */
export interface WorkerRateMessage {
  type: 'rate';
  /** 0.5–2；1 時不經過 stretcher。 */
  rate: number;
}

/** 要求 Worker 回報它持有的資源；以 `stats` 回覆同一個 `id`。 */
export interface WorkerStatsRequestMessage {
  type: 'stats';
  id: number;
}

/** media Worker 送給主執行緒的訊息。 */
export type WorkerToMainMessage =
  | WorkerReadyMessage
  | WorkerProbeMessage
  | WorkerErrorMessage
  | WorkerCrashMessage
  | WorkerStatsMessage
  | WorkerBufferMessage
  | WorkerReadErrorMessage
  | WorkerLogMessage;

/**
 * Worker 的 script 執行完畢、開始接收訊息時送出的第一個訊息。在它之前的 `error` 事件是 script 載入失敗
 *（`ASSET_LOAD_FAILED`），之後的是崩潰（`INTERNAL`）。
 */
export interface WorkerReadyMessage {
  type: 'ready';
}

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

/**
 * 輸出開始後，資料備妥的進度：媒體時間 `end` 之前的資料已經在 Worker 內（封包佇列，加上 Range 快取中的預讀 bytes
 * 以位元組率換算的秒數），是估計值。`end` 變動或 `eof`／`fetching` 改變時送出；每個 epoch 在第一次 demux 之後才送。
 */
export interface WorkerBufferMessage {
  type: 'buffer';
  epoch: number;
  /** 已備妥資料的終點（秒）；不超過 duration。 */
  end: number;
  /** 已備妥的資料到達來源的結尾（`bytes`／`blob` 來源一律為 true）。 */
  eof: boolean;
  /** 預讀正在抓取；false 表示已達目標（或沒有預讀），等待也不會再增加資料。 */
  fetching: boolean;
}

/** http 的一個請求失敗（包括之後會重試的）；非致命，供卡住而放棄時回報最後一次的讀取錯誤。 */
export interface WorkerReadErrorMessage {
  type: 'readerror';
  error: WireError;
}

/**
 * 一筆診斷 log，等級不低於 init 的 `logLevel`。`entry.time` 是 `performance.timeOrigin + performance.now()`
 *（ms），主執行緒減去自己的 `performance.timeOrigin` 換算成主執行緒的 `performance.now()` 時基。不帶 epoch：
 * 被取代的操作的 log 也照常轉送。
 */
export interface WorkerLogMessage {
  type: 'log';
  entry: WireLogEntry;
}

/**
 * Worker 無法繼續運作：wasm trap，或 wasm 記憶體用完（`MAXIMUM_MEMORY`）。主執行緒回報 `INTERNAL` 並 terminate Worker；
 * 不帶 epoch，因為整個 Worker 都不能再用。
 */
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
  /** 目前存在的 libav instance 數：建立 instance 時加一，被取代或 open／probe 失敗而丟棄時減一。 */
  libavInstances: number;
  /** Range 快取，欄位同 `EngineStats.cache`；沒有 http 來源時 bytes 等為 0。 */
  cache: {
    bytes: number;
    limitBytes: number;
    aheadBytes: number;
    readaheadTarget: number;
    fetching: boolean;
    hits: number;
    misses: number;
  };
  /** 網路，欄位同 `EngineStats.network`。 */
  network: {
    bytesLoaded: number;
    inflight: { url: string; start: number; end: number; elapsedMs: number }[];
  };
  /** 封包佇列，欄位同 `EngineStats.packetQueue`。 */
  packetQueue: { audioSeconds: number; videoSeconds: number; bytes: number };
  /** 存在中的 libav instance 的 wasm linear memory 合計（bytes）。 */
  wasmHeapBytes: number;
}

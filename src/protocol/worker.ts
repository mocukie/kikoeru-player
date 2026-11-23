// 主執行緒 ↔ media Worker 的訊息。會影響輸出的訊息都帶 epoch，收方丟棄過期的 epoch。

import type {
  HostTypes,
  ProbedAudioTrack,
  ProbedMedia,
  RetryPolicy,
  WireError,
  WireLogEntry,
  WireLogLevel,
  WireCue,
  WireSource,
} from './media.js';

/** 主執行緒送給 media Worker 的訊息。 */
export type MainToWorkerMessage<H extends HostTypes> =
  | WorkerInitMessage<H>
  | WorkerLoadMessage<H>
  | WorkerStartMessage
  | WorkerSeekMessage
  | WorkerSelectMessage
  | WorkerAddAudioMessage<H>
  | WorkerRemoveAudioMessage
  | WorkerPortMessage<H>
  | WorkerRateMessage
  | WorkerFrameClosedMessage
  | WorkerVideoSuspendMessage
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

/** `start`／`select` 選用的各軌；Worker 記住它，之後的 `seek`、`port` 沿用。 */
export interface WorkerTrackSelection {
  /**
   * 選用音軌的 stream index；null 表示不輸出音訊：Worker 立即送出 `eof`，worklet 以靜音推進時鐘（影片軌與字幕軌照常
   * 輸出）。
   */
  audio: number | null;
  /**
   * `audio` 所在的外掛音軌（`addaudio` 的 `id`）；省略時 `audio` 是主來源的 stream。外掛音軌在它自己的 libav instance
   * demux 與解碼，主來源只 demux 影片軌與字幕軌；只為字幕 demux 時不超前外掛音軌的 demux 進度太多。
   */
  audioSource?: string;
  /**
   * 音軌 offset（秒），省略時為 0：在 stretcher 之前套用 `sourceTime = mediaTime − offset`，正值時起點前補靜音，負值時
   * 跳過來源開頭。音訊從 `time − offset` demux（小於 0 時從頭開始）；外掛音軌的 0 點是它自己的第一個可播放 sample。
   * 容器內音軌的 |offset| 超過 2 秒且同時解碼影片時，音軌在同一個來源另開的 instance demux，封包佇列不因 offset 增長。
   */
  audioOffset?: number;
  /** 選用影片軌的 stream index（probe 時 supported 的軌）；null 表示不解碼影片。 */
  video: number | null;
  /** 選用字幕軌的 stream index（probe 時 supported 的軌）；null 表示不送 cue。 */
  subtitle: number | null;
}

/**
 * probe 之後開始輸出：只讀選用的音軌、影片軌與字幕軌（其餘 discard），從 `time`（秒）開始供料，精準度同 `seek`。
 * Worker 依 worklet 的 `need` 送出這個 epoch 的 PCM，音訊到結尾時送出 `eof`；影片解出的 frame 以 `frame` 送出，
 * 全部送出後送 `videoend`；字幕軌的 cue 隨 demux 的進度以 `cues` 送出。每個 load 只送一次；之後改變位置經由 `seek`。
 */
export interface WorkerStartMessage extends WorkerTrackSelection {
  type: 'start';
  epoch: number;
  time: number;
}

/**
 * 換到新的 epoch，從 `time`（秒）重新供料，各軌沿用 `start` 的選擇；`start` 之前收到的 seek 不處理。
 * 中止進行中的讀取，等被取代的供料停下後，跳到 `time` 往前 preroll 的 keyframe 解碼並丟掉之前的 sample：
 * 送出的第一個 sample 就在 `time`（捨入到最近的 sample）。被取代的 seek 與供料不回報任何訊息。
 */
export interface WorkerSeekMessage {
  type: 'seek';
  epoch: number;
  time: number;
}

/**
 * 換軌（`selectTracks()`）與改音軌 offset：選用的各軌改為這裡的值（之後的 `seek`、`port` 沿用），以新的 epoch 從 `time`
 *（秒）重新供料，其餘同 `seek`。換了影片軌時關閉舊軌的 `VideoDecoder`、為新軌建立新的，從 `time` 之前的 keyframe 解碼；
 * `video` 為 null 時關閉 decoder。新的影片軌 configure 或首個 keyframe 失敗時送出 `videoerror`（`beforeFirstFrame: true`），
 * 之後不再選用它；新音軌的 decoder 開不起來時送出 `audiofailed`。`start` 之前收到的 select 不處理。
 */
export interface WorkerSelectMessage extends WorkerTrackSelection {
  type: 'select';
  epoch: number;
  time: number;
}

/**
 * 加入外掛音軌（`addExternalAudio()`）：在同一個 Worker 內為 `source` 開一個新的 libav instance 並 probe，回覆
 * `audioprobe`（選用第一條可播的音軌，有 default 旗標的優先）或 `audioerror`（非致命；沒有可播的音軌時
 * `CODEC_UNSUPPORTED`）。http 來源與主來源共用 Range 快取。不帶 epoch：外掛音軌屬於這個 Worker 的媒體，不隨 seek 改變；
 * 被 `start`／`select` 選用之前不讀取（不預讀）。
 */
export interface WorkerAddAudioMessage<H extends HostTypes> {
  type: 'addaudio';
  /** 主執行緒指派的 id（外掛音軌的 track id），之後的 `audioSource`、`removeaudio` 以它指定。 */
  id: string;
  source: WireSource<H>;
}

/**
 * 移除外掛音軌：中止它的讀取、丟掉它的 instance。主執行緒先換掉選用中的音軌再送出；仍被選用時之後的輸出不再有音訊。
 */
export interface WorkerRemoveAudioMessage {
  type: 'removeaudio';
  id: string;
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

/**
 * 主執行緒 close 了 `count` 張 Worker 送來的 `VideoFrame`（畫過、被取代、過時或 epoch 過期）。Worker 依它控制還沒 close
 * 的 frame 數（backpressure），不帶 epoch：任何 epoch 的 frame 都計入。
 */
export interface WorkerFrameClosedMessage {
  type: 'frameclosed';
  count: number;
}

/**
 * 背景時暫停影片解碼、回到前景時恢復（`suspendVideoWhenHidden`）。不帶 epoch，沿用到之後的 `start`、`seek`，所以在
 * `start` 之前送出就讓這次 load 一開始就不解碼影片。
 *
 * - `suspended: true`：關閉 `VideoDecoder`，Worker 內暫留的 frame close，不再送出 frame；音訊照常。有音軌時影片的封包
 *   只留播放位置之前最後一個 keyframe 之後的（依音訊取用的進度估計），封包佇列不會因為影片沒人取用而增長；沒有音軌時
 *   影片的封包讓 demux 停在平常的上限。
 * - `suspended: false`：建立新的 decoder，從 pts ≤ `time` 的最後一個 keyframe 解碼，送出 `time` 的那一張（pts ≤ `time`
 *   的最後一張）與之後的。佇列中沒有那個 keyframe 時從下一個 keyframe 開始。
 */
export interface WorkerVideoSuspendMessage {
  type: 'videosuspend';
  suspended: boolean;
  /** 恢復時此刻的播放位置（秒）；`suspended: true` 時不使用。 */
  time: number;
}

/** 要求 Worker 回報它持有的資源；以 `stats` 回覆同一個 `id`。 */
export interface WorkerStatsRequestMessage {
  type: 'stats';
  id: number;
}

/**
 * media Worker 送給主執行緒的訊息。`H` 只決定 `frame` 的 `VideoFrame` 型別；不碰 frame 的一方可以省略。
 */
export type WorkerToMainMessage<H extends HostTypes = HostTypes> =
  | WorkerReadyMessage
  | WorkerProbeMessage
  | WorkerAudioProbeMessage
  | WorkerAudioErrorMessage
  | WorkerAudioFailedMessage
  | WorkerAudioEndMessage
  | WorkerErrorMessage
  | WorkerCrashMessage
  | WorkerStatsMessage
  | WorkerBufferMessage
  | WorkerReadErrorMessage
  | WorkerFrameMessage<H>
  | WorkerVideoEndMessage
  | WorkerVideoErrorMessage
  | WorkerCuesMessage
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

/** `addaudio` 的 probe 結果：外掛音軌選用的那條音軌（`streamIndex` 是它在外掛來源內的 index）。 */
export interface WorkerAudioProbeMessage {
  type: 'audioprobe';
  id: string;
  track: ProbedAudioTrack;
}

/** `addaudio` 開檔或 probe 失敗（instance 已經丟掉）。主執行緒以非致命的錯誤 reject `addExternalAudio()`。 */
export interface WorkerAudioErrorMessage {
  type: 'audioerror';
  id: string;
  error: WireError;
}

/**
 * 這個 epoch 的音軌無法輸出（`error.fatal` 為 false），由主執行緒決定怎麼處理：
 *
 * - `source` 為 null：主來源音軌的 decoder 建立或開啟失敗（`CODEC_UNSUPPORTED`），這個 epoch 的主來源輸出停止。
 * - `source` 為外掛音軌的 id：外掛音軌在輸出中開啟 decoder、seek、讀取、demux 或解碼失敗。Worker 丟掉它的 instance
 *   （之後選用它時不輸出音訊），送出這個 epoch 的 `eof`（worklet 以靜音推進時鐘），主來源的影片與字幕照常輸出。
 */
export interface WorkerAudioFailedMessage {
  type: 'audiofailed';
  epoch: number;
  source: string | null;
  error: WireError;
}

/**
 * 這個 epoch 的音訊送完了（`eof` 已送給 worklet）：音軌播到結尾，或沒有音訊可送。音軌比影片短時，之後的影片 demux
 * 不再受音訊的進度約束。
 */
export interface WorkerAudioEndMessage {
  type: 'audioend';
  epoch: number;
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

/**
 * 解出的一張 `VideoFrame`（以 transfer 傳送），依 pts 的順序。`frame.timestamp` 是媒體時間軸上的 µs。seek 之後的第一張
 * 是 pts ≤ 起點的最後一張。主執行緒負責 close（包括 epoch 過期的），close 之後送 `frameclosed`。
 */
export interface WorkerFrameMessage<H extends HostTypes> {
  type: 'frame';
  epoch: number;
  frame: H['videoFrame'];
}

/** 這個 epoch 的影片 frame 都送出了（播到結尾，或 demux 失敗而停止）。 */
export interface WorkerVideoEndMessage {
  type: 'videoend';
  epoch: number;
}

/**
 * `VideoDecoder` 失敗而放棄這條影片軌：之後不再送出 frame，之後的 `seek` 也不再 demux 它。解出過 frame 之後的失敗已經
 * 先重新設定 decoder（從下一個 keyframe 繼續）一次，還沒解出 frame 又失敗才送出（`DECODE_FAILED`）。
 * `beforeFirstFrame`：這條軌還沒解出過任何 frame（configure 或首個 keyframe 失敗，`CODEC_UNSUPPORTED`），等同
 * `isConfigSupported` 誤報。兩種情況主執行緒都把該軌改為不支援（`'platform'`）、只播音訊。
 */
export interface WorkerVideoErrorMessage {
  type: 'videoerror';
  epoch: number;
  error: WireError;
  beforeFirstFrame: boolean;
}

/**
 * 選用字幕軌的一批 cue：一次 demux 讀到的字幕封包，依 demux 的順序。seek（新的 epoch）之後從 demuxer 跳到的
 * keyframe 開始重新送出，跟之前送過的 cue 可能重複（`id` 相同）。
 */
export interface WorkerCuesMessage {
  type: 'cues';
  epoch: number;
  cues: WireCue[];
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
  /**
   * 目前存在的 libav instance 數（主來源與外掛音軌各一個，另開給 offset 很大的容器內音軌的也算一個）：建立 instance 時
   * 加一，被取代、移除、不再需要或 open／probe 失敗而丟棄時減一。
   */
  libavInstances: number;
  /** Range 快取，公開的 `EngineStats.cache` 沿用這個型別；沒有 http 來源時 bytes 等為 0。 */
  cache: {
    bytes: number;
    limitBytes: number;
    aheadBytes: number;
    readaheadTarget: number;
    fetching: boolean;
    hits: number;
    misses: number;
  };
  /** 網路，公開的 `EngineStats.network` 沿用這個型別。 */
  network: {
    bytesLoaded: number;
    inflight: { url: string; start: number; end: number; elapsedMs: number }[];
  };
  /** 封包佇列，公開的 `EngineStats.packetQueue` 沿用這個型別。 */
  packetQueue: { audioSeconds: number; videoSeconds: number; bytes: number };
  /** 存在中的 libav instance 的 wasm linear memory 合計（bytes）。 */
  wasmHeapBytes: number;
  /** 影片解碼；沒有解碼影片時為 null。`avgDecodeMs`：送進 decoder 到輸出 frame 的時間（ms，移動平均）。 */
  video: { decoded: number; decodeQueueSize: number; avgDecodeMs: number } | null;
  /** Worker 內還沒 close、也還沒送出的 `VideoFrame` 數。 */
  openVideoFrames: number;
}

// AudioWorklet 與主執行緒、media Worker 之間的訊息。會影響輸出的訊息都帶 epoch，收方丟棄過期的 epoch。

import type { HostTypes, WireLogEntry, WireLogLevel } from './media.js';

/** `registerProcessor()` 與 `AudioWorkletNode` 共用的 processor 名稱；兩邊各自以這個型別寫出字面值。 */
export type WorkletProcessorName = 'kikoeru-player-output';

/** ring buffer 的水位（ms），即 `EngineOptions.audioBuffer` 補上預設值之後。 */
export interface AudioBufferWatermarks {
  targetMs: number;
  refillMs: number;
  capacityMs: number;
}

/** `AudioWorkletNode` 的 `processorOptions`。 */
export interface WorkletProcessorOptions {
  /** ring buffer 的水位（ms），即 `EngineOptions.audioBuffer` 補上預設值之後。 */
  audioBuffer: AudioBufferWatermarks;
  /** 淡入淡出的長度（ms），即 `EngineOptions.audioFadeMs`；0 為硬切。 */
  audioFadeMs: number;
  /** 送出 `log` 的最低等級；null 表示 App 沒有設定 log hook，worklet 不送任何 log。 */
  logLevel: WireLogLevel | null;
}

/** 主執行緒送給 AudioWorklet 的訊息（經 `AudioWorkletNode.port`）。 */
export type MainToWorkletMessage =
  | WorkletFlushMessage
  | WorkletPlayMessage
  | WorkletPauseMessage
  | WorkletDurationMessage
  | WorkletRateMessage;

/**
 * 換成新的 epoch：丟掉 ring 內與之後收到的舊 epoch 資料，時鐘停在 `position`（秒），等新 epoch 的資料
 * 補到目標水位（或收到 `eof`）。補滿後依播放意圖回報 `playing` 或 `paused`。播放意圖與 `duration` 不受 flush 影響。
 * 正在出聲時，ring 內接下來 `audioFadeMs` 的舊資料淡出後播完（不推進時鐘），新 epoch 的輸出從 0 淡入。
 */
export interface WorkletFlushMessage {
  type: 'flush';
  epoch: number;
  position: number;
}

/**
 * 播放意圖改為播放：資料足夠時開始輸出（淡入）並回報 `playing`。flush 之後還沒補滿時，等補滿才回報；
 * starved 時等 ring 補回目標水位才回報。pause 的淡出途中收到時從目前的音量淡入回來，不回報。
 */
export interface WorkletPlayMessage {
  type: 'play';
  epoch: number;
}

/**
 * 播放意圖改為暫停：正在出聲時淡出 `audioFadeMs`（淡出的 sample 照常推進時鐘），淡出結束才停止輸出、
 * 時鐘停在那裡並回報 `paused`；沒有出聲（或 `audioFadeMs` 為 0）時立即回報。flush 之後還沒補滿時，等補滿才回報；
 * 已經 `ended` 時不回報。
 */
export interface WorkletPauseMessage {
  type: 'pause';
  epoch: number;
  /** 不淡出、立即停止並回報：AudioContext 沒有在 render（被 suspend、中斷、還沒開始）時，淡出永遠不會結束。 */
  immediate?: boolean;
}

/**
 * 媒體的長度（秒，未知時為 NaN），沿用到下一個 `duration`，不受 flush 影響。音訊超出 `duration` 的部分截掉；
 * 收到 `eof` 而時鐘還沒到 `duration` 時以靜音推進到 `duration`，到了就回報 `ended`。
 * 未知時，`eof` 之後 ring 播完就回報 `ended`。
 */
export interface WorkletDurationMessage {
  type: 'duration';
  epoch: number;
  duration: number;
}

/**
 * 播放速度（`Engine.playbackRate`），沿用到下一個 `rate`，不受 flush 影響、不帶 epoch。只用於沒有 PCM 的時候：
 * `eof` 之後以靜音推進時鐘的速度。有 PCM 時依 PCM 自己帶的 `rate`。
 */
export interface WorkletRateMessage {
  type: 'rate';
  rate: number;
}

/**
 * 主執行緒的音訊輸出送給 AudioWorklet：接上新的 media Worker 的 `MessageChannel` 一端（以 transfer 傳送）。
 * 之前的 port 關閉，從它收到、還沒用到的訊息丟掉。不帶 epoch，與其他訊息依送出順序處理。
 */
export interface WorkletConnectMessage<H extends HostTypes> {
  type: 'connect';
  port: H['messagePort'];
}

/** AudioWorklet 送給主執行緒的訊息，都帶 worklet 目前的 epoch。 */
export type WorkletToMainMessage =
  | { type: 'playing'; epoch: number }
  | { type: 'paused'; epoch: number }
  | { type: 'starved'; epoch: number }
  | { type: 'ended'; epoch: number }
  | WorkletClockMessage
  | WorkletLogMessage;

/**
 * 一筆診斷 log，等級不低於 `processorOptions.logLevel`。AudioWorkletGlobalScope 沒有 `performance`，所以以事件發生的
 * render quantum 的 context frame（`frame`）表示時間，主執行緒的音訊輸出換算成 `performance.now()` 的時基。
 * 主執行緒不以 epoch 丟棄 log。
 */
export interface WorkletLogMessage {
  type: 'log';
  epoch: number;
  entry: Omit<WireLogEntry, 'time'>;
  frame: number;
}

/**
 * 音訊時鐘。時鐘前進時約每 250 ms 一次；`playing`、`paused`、`starved`、`ended` 之前也各送一次。
 */
export interface WorkletClockMessage {
  type: 'clock';
  epoch: number;
  /** 下一個要播出的 sample 在媒體時間軸上的位置（秒）。 */
  position: number;
  /**
   * `position` 的 sample 進入 audio graph 的 context frame（`currentFrame`）。時鐘前進時，context 時間
   * `t` 秒進入 graph 的媒體位置為 `position + (t × sampleRate − frame) × rate / sampleRate`（尚未扣掉輸出延遲）。
   */
  frame: number;
  /**
   * `position` 之後的播放速度：每個輸出的 frame 推進 `rate / sampleRate` 秒的媒體時間。速度改變的那個 frame
   * 也送出一個 clock，所以兩個 clock 之間的速度固定。
   */
  rate: number;
  /** ring 內目前的 frame 數。 */
  buffered: number;
  /** ring 用完（starved）的累計次數。 */
  underruns: number;
}

/** media Worker 送給 AudioWorklet 的訊息（經 init 時的 `workletPort`）。 */
export type WorkerToWorkletMessage = WorkletPcmMessage | WorkletEofMessage;

/**
 * 一段 PCM，長 2048–4096 frame（`eof` 前的最後一段與速度改變之前的最後一段可以更短）；`channels` 的 buffer 以
 * transfer 傳送，用完後以 `release` 送回 Worker 重用。
 */
export interface WorkletPcmMessage {
  type: 'pcm';
  epoch: number;
  /** 第一個 frame 在媒體時間軸上的位置（秒）。 */
  time: number;
  /**
   * 這段 PCM 的播放速度（不變調）：第 `i` 個 frame 的媒體時間是 `time + i × rate / sampleRate`。1 表示沒有經過
   * stretcher。一段 PCM 內速度固定。
   */
  rate: number;
  /** 一律 stereo、`ctx.sampleRate` 的 float planar；兩個聲道的 view 各自擁有一個 `ArrayBuffer`。 */
  channels: readonly Float32Array[];
}

/** 這個 epoch 的音訊已經送完。 */
export interface WorkletEofMessage {
  type: 'eof';
  epoch: number;
}

/** AudioWorklet 送給 media Worker 的訊息。 */
export type WorkletToWorkerMessage = WorkletNeedMessage | WorkletReleaseMessage;

/**
 * 要求這個 epoch 再送 `frames` 個 frame（增量：與之前尚未滿足的要求累加）。Worker 以 2048–4096 frame 的 chunk
 * 回應，可能多送最多一個 chunk。epoch 比 Worker 目前的新時先記下，Worker 換到該 epoch 時生效；舊的 epoch 丟棄。
 */
export interface WorkletNeedMessage {
  type: 'need';
  epoch: number;
  frames: number;
}

/** 收進 ring 之後不再需要的 PCM buffer，transfer 回 Worker 重用。 */
export interface WorkletReleaseMessage {
  type: 'release';
  buffers: readonly ArrayBuffer[];
}

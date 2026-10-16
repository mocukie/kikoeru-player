// AudioWorklet 與主執行緒、media Worker 之間的訊息。會影響輸出的訊息都帶 epoch，收方丟棄過期的 epoch。

/** 主執行緒送給 AudioWorklet 的訊息（經 `AudioWorkletNode.port`）。 */
export type MainToWorkletMessage = WorkletFlushMessage | WorkletPlayMessage | WorkletPauseMessage;

/**
 * 換成新的 epoch：丟掉 ring 內與之後收到的舊 epoch 資料，時鐘停在 `position`（秒），等新 epoch 的資料
 * 補到目標水位。補滿後依播放意圖回報 `playing` 或 `paused`。
 */
export interface WorkletFlushMessage {
  type: 'flush';
  epoch: number;
  position: number;
}

/** 播放意圖改為播放：資料足夠時開始輸出並回報 `playing`。 */
export interface WorkletPlayMessage {
  type: 'play';
  epoch: number;
}

/** 播放意圖改為暫停：停止輸出、時鐘停住後回報 `paused`。 */
export interface WorkletPauseMessage {
  type: 'pause';
  epoch: number;
}

/** AudioWorklet 送給主執行緒的訊息，都帶 worklet 目前的 epoch。 */
export type WorkletToMainMessage =
  | { type: 'playing'; epoch: number }
  | { type: 'paused'; epoch: number }
  | { type: 'starved'; epoch: number }
  | { type: 'ended'; epoch: number }
  | WorkletClockMessage;

/** 音訊時鐘：此刻播出的位置（媒體時間軸，秒）。 */
export interface WorkletClockMessage {
  type: 'clock';
  epoch: number;
  position: number;
}

/** media Worker 送給 AudioWorklet 的訊息（經 init 時的 `workletPort`）。 */
export type WorkerToWorkletMessage = WorkletPcmMessage | WorkletEofMessage;

/**
 * 一段 PCM，長 2048–4096 frame（`eof` 前的最後一段可以更短）；`channels` 的 buffer 以 transfer 傳送，
 * 用完後以 `release` 送回 Worker 重用。
 */
export interface WorkletPcmMessage {
  type: 'pcm';
  epoch: number;
  /** 第一個 frame 在媒體時間軸上的位置（秒）。 */
  time: number;
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

/** 播完的 PCM buffer，transfer 回 Worker 重用。 */
export interface WorkletReleaseMessage {
  type: 'release';
  buffers: readonly ArrayBuffer[];
}

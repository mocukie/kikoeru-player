// 主執行緒的影片輸出：繪製 frame 的 VideoRenderer、依音訊時鐘的繪製迴圈、這個 epoch 的影片是否備妥（等第一張 frame，
// 超過 VIDEO_READY_TIMEOUT_MS 不再等），以及背景時暫停（suspendVideoWhenHidden）。備妥之後怎麼恢復音訊、何時降級，
// 由 Engine 決定。

import type { VideoSize, VideoTrack } from './types.js';
import {
  VideoRenderer,
  type RenderableFrame,
  type VideoRendererOptions,
} from './video-renderer.js';

/**
 * load、seek 時音訊已備妥而影片的第一張 frame 超過這麼久（ms）還沒來，就不再等它（例如 decoder 卡住），先開始播放，
 * frame 到了再畫。
 */
export const VIDEO_READY_TIMEOUT_MS = 2000;
/**
 * 繪製迴圈的備援 timer（ms）：背景分頁的 `requestAnimationFrame` 停住時（`suspendVideoWhenHidden: false`），改由 timer
 * 推進，frame 才會照常被消耗、close，Worker 的解碼與封包佇列不會因此停住而增長。
 */
const HIDDEN_FRAME_MS = 100;

/** `closed`、`resized` 同 `VideoRendererOptions`。 */
export interface VideoOutputOptions extends VideoRendererOptions {
  /** 此刻的音訊時鐘（`Engine.currentTime`），繪製時依它挑選 frame。 */
  clock(): number;
  /** 一開始是否在背景（暫停影片）。 */
  suspended: boolean;
}

export class VideoOutput {
  readonly #options: VideoOutputOptions;
  readonly #renderer: VideoRenderer;
  #track: VideoTrack | null = null;
  #pending = false;
  #suspended: boolean;
  /** 不再等影片的 timer。 */
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** 繪製迴圈的取消；沒有在畫時為 null。 */
  #cancelLoop: (() => void) | null = null;

  constructor(options: VideoOutputOptions) {
    this.#options = options;
    this.#suspended = options.suspended;
    this.#renderer = new VideoRenderer(options);
  }

  /** 解碼中的影片軌（已送出 `start`／`select`）；沒有選用、或影片軌失敗而只播音訊時為 null。 */
  get track(): VideoTrack | null {
    return this.#track;
  }

  /**
   * 這個 epoch 的影片還沒備妥（第一張 frame、`videoend` 或 `videoerror` 都還沒來，也還沒逾時）：Engine 讓 worklet 先停住，
   * 畫面與聲音一起開始。
   */
  get pending(): boolean {
    return this.#pending;
  }

  /** 背景中暫停影片：不畫、不等，收到的 frame 立即 close。 */
  get suspended(): boolean {
    return this.#suspended;
  }

  /** 畫出的 frame 的顯示尺寸（`Engine.videoSize`）。 */
  get size(): VideoSize | null {
    return this.#renderer.size;
  }

  /** 被時鐘跳過的 frame 數。 */
  get dropped(): number {
    return this.#renderer.dropped;
  }

  /** 還沒 close 的 frame 數。 */
  get open(): number {
    return this.#renderer.open;
  }

  attach(canvas: HTMLCanvasElement | null): void {
    this.#renderer.attach(canvas);
  }

  /** 開始解碼 `track`：等第一張 frame，並開始繪製迴圈。背景中不等、不畫。 */
  start(track: VideoTrack): void {
    this.#track = track;
    this.#renderer.setTrack(track);
    this.#pending = !this.#suspended;
    this.#runLoop(!this.#suspended);
  }

  /** 不再解碼影片（換媒體、結束媒體、關掉影片）：停止繪製迴圈，不再等影片。 */
  stop(): void {
    this.#runLoop(false);
    this.#track = null;
    this.#pending = false;
    this.#clearTimer();
  }

  /**
   * 影片軌失敗（降級或換軌失敗）：停止繪製迴圈、不再解碼，畫面上的 frame 留著。還在等影片時由 `markReady()` 結束等待。
   */
  abandon(): void {
    this.#runLoop(false);
    this.#track = null;
  }

  /** 新的媒體：close 所有 frame，`size` 回到 null。 */
  reset(epoch: number): void {
    this.#renderer.reset(epoch, null);
  }

  /** 改為畫 `track` 的 frame（null：不再畫，`size` 回到 null）。 */
  setTrack(track: VideoTrack | null): void {
    this.#renderer.setTrack(track);
  }

  /**
   * 新的 epoch：佇列中舊 epoch 的 frame close，畫面上的留到新的一張畫出。解碼中（不在背景）時重新等這個 epoch 的第一張
   * frame；回傳是否在等。
   */
  beginEpoch(epoch: number): boolean {
    this.#renderer.flush(epoch);
    this.#clearTimer();
    this.#pending = this.#track !== null && !this.#suspended;
    return this.#pending;
  }

  /** 只 close 佇列中的 frame（背景中收到的、切到背景時佇列中的），不改變等待。 */
  closeQueued(epoch: number): void {
    this.#renderer.flush(epoch);
  }

  /** 收到 Worker 送來的 frame。 */
  push(epoch: number, frame: RenderableFrame, source: unknown): void {
    this.#renderer.push(epoch, frame, source);
  }

  /** 依此刻的音訊時鐘挑選並繪製 frame。 */
  render(): void {
    if (this.#track) this.#renderer.render(this.#options.clock());
  }

  /** 結束等待：還在等時回傳 true（Engine 接著恢復 worklet），否則什麼都不做。 */
  markReady(): boolean {
    if (!this.#pending) return false;
    this.#pending = false;
    this.#clearTimer();
    return true;
  }

  /** 音訊已備妥、影片還沒：`VIDEO_READY_TIMEOUT_MS` 後還在等就呼叫 `onTimeout`。已經在計時時不重設。 */
  armTimer(onTimeout: () => void): void {
    this.#timer ??= setTimeout(() => {
      this.#timer = null;
      if (this.#pending) onTimeout();
    }, VIDEO_READY_TIMEOUT_MS);
  }

  /**
   * 切到背景（true）或回到前景（false）。背景中佇列中的 frame close、停止繪製（等待由 Engine 結束）；回到前景時重新開始
   * 繪製。沒有改變時回傳 false。
   */
  setSuspended(suspended: boolean, epoch: number): boolean {
    if (suspended === this.#suspended) return false;
    this.#suspended = suspended;
    if (!this.#track) return true;
    if (suspended) this.#renderer.flush(epoch);
    this.#runLoop(!suspended);
    return true;
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** 開始或停止繪製迴圈：每個 rAF（背景時 rAF 停住則由 timer）依音訊時鐘畫一次。 */
  #runLoop(run: boolean): void {
    this.#cancelLoop?.();
    this.#cancelLoop = null;
    if (!run) return;
    const schedule = frameScheduler();
    const tick = () => {
      this.#cancelLoop = schedule(tick);
      this.render();
    };
    this.#cancelLoop = schedule(tick);
  }
}

/**
 * 繪製迴圈的排程：有 `requestAnimationFrame` 時每個 frame 一次，rAF 超過 `HIDDEN_FRAME_MS` 沒有觸發（背景分頁）時由 timer
 * 代替；沒有 rAF 時（Node 測試）約 60 Hz 的 timer。回傳取消的函式。
 */
function frameScheduler(): (callback: () => void) => () => void {
  const raf = typeof requestAnimationFrame === 'function';
  return (callback) => {
    let done = false;
    let id: number | null = null;
    const cancel = () => {
      done = true;
      if (id !== null) cancelAnimationFrame(id);
      clearTimeout(timer);
    };
    const run = () => {
      if (done) return;
      cancel();
      callback();
    };
    const timer = setTimeout(run, raf ? HIDDEN_FRAME_MS : 16);
    if (raf) id = requestAnimationFrame(run);
    return cancel;
  };
}

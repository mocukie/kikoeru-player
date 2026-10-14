// PROTOTYPE — 背景播放模組（`kikoeru-player/background`）的形狀，決定於「行動裝置支援的歸屬」（#16，ADR-0006）。
// 只用 Engine 的公開 API 實作；core 不碰 DOM 的 `<audio>` 與 navigator.audioSession。

import type { Engine, LogHook } from './engine';

/**
 * 讓 OS 把 App 當成正在播放的媒體播放器，使播放能在背景、鎖屏與系統媒體控制下持續。
 * 所有平台都啟用，不偵測 UA。同一個 Engine 重複 attach 時丟錯；engine.destroy() 時自動 detach。
 *
 * - audioSession：有 `navigator.audioSession` 時，在每次 `beforeaudiostart` 設 `type = "playback"`。
 * - 靜音 anchor：模組自己產生 5 秒、8 kHz、mono 的靜音 WAV（blob URL），`loop`、`volume = 0.0001`，不掛進 DOM。
 *   - 跟著播放意圖 `paused` 走，不看 state：paused === false 時播放（含 loading、seeking、buffering、ended），
 *     paused === true、error、idle 時停止。
 *   - 第一次在 `beforeaudiostart` 內同步 play() 以取得 gesture 授權；paused 仍為 true 時隨即 pause()。
 *   - 不是模組自己觸發的 pause／play（Android 來電、audio focus 被搶、沒有 Media Session handler 時的
 *     通知與鎖屏按鍵）鏡像為 engine.pause()／engine.play()，statechange.reason 為 'command'，不另外通知 App。
 *   - play() 被拒不算 Engine 的錯誤、不影響播放；下一次 beforeaudiostart 或 paused 變成 false 時再試。
 * - App 的 CSP 若限制 `media-src`，要允許 `blob:`。Media Session 的 handler、metadata 與 position 仍由 App 負責。
 */
export declare function attachBackgroundPlayback(
  engine: Engine,
  options?: BackgroundPlaybackOptions,
): BackgroundPlayback;

export interface BackgroundPlaybackOptions {
  /** 設定 `navigator.audioSession.type = "playback"`。預設 true。 */
  audioSession?: boolean;
  /** 播放靜音 anchor。預設 true。 */
  anchor?: boolean;
  /** anchor 啟動失敗等診斷訊息，scope 為 'background'；與 createEngine 的 log 同型別。 */
  log?: LogHook;
}

export interface BackgroundPlayback {
  /** 停止 anchor、revoke blob URL、把 audioSession.type 還原成 attach 前的值。可重複呼叫。 */
  detach(): void;
}

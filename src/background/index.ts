// 背景播放模組（套件的 "./background" entry）。只能 import 公開 API（src/index.ts），證明 core 提供的 hook 足夠；
// 實作在 attach.ts，這裡接上真實的 `<audio>` 與 `navigator.audioSession`。

import type { Engine, LogHook, LogLevel } from '../index.js';
import { attachWith, type AudioSessionLike } from './attach.js';

/** `attachBackgroundPlayback()` 的選項。 */
export interface BackgroundPlaybackOptions {
  /** 有 `navigator.audioSession` 時，在每次 `beforeaudiostart` 設定 `type = "playback"`。預設 true。 */
  audioSession?: boolean;
  /** 播放靜音 anchor。預設 true。 */
  anchor?: boolean;
  /** anchor 啟動失敗等診斷訊息，scope 為 `'background'`；與 `createEngine()` 的 `log` 同型別。 */
  log?: LogHook;
  /**
   * 送進 `log` 的最低等級，預設 `'warn'`；不是 `LogLevel` 的值時 `attachBackgroundPlayback()` 丟 `RangeError`。
   * 與 `createEngine()` 的 `logLevel` 相同語意，但彼此獨立：要看模組的 `info` 時兩邊都要設定。
   */
  logLevel?: LogLevel;
}

/** `attachBackgroundPlayback()` 的回傳值。 */
export interface BackgroundPlayback {
  /** 停止 anchor、revoke blob URL、把 `audioSession.type` 還原成 attach 前的值。可以重複呼叫。 */
  detach(): void;
}

/**
 * 讓 OS 把 App 當成正在播放的媒體播放器，使播放能在背景、鎖屏與系統媒體控制下持續。
 * 所有平台都啟用，不偵測 UA。同一個 Engine 重複 attach 時丟錯（`detach()` 之後可以再 attach），`logLevel` 不合法時丟
 * `RangeError`；
 * `engine.destroy()` 時（`destroy` 事件）自動 detach。attach 時 `paused` 已經是 false 就立即啟動 anchor。
 *
 * - audioSession：有 `navigator.audioSession` 時，在每次 `beforeaudiostart` 設定 `type = "playback"`。
 * - 靜音 anchor：模組自己產生 5 秒、8 kHz、mono 的靜音 WAV（blob URL），`loop`、`volume = 0.0001`，不掛進 DOM。
 *   - 跟著播放意圖 `paused` 走：`paused === false` 時播放（含 loading、seeking、buffering、ended），`paused === true`
 *     時停止。唯一看 `state` 的例外是沒有媒體可播的 error 與 idle：即使 `paused === false` 也停止，離開之後
 *     （`load()`、`reload()`）再開始。
 *   - 第一次在 `beforeaudiostart` 內同步 `play()` 以取得 gesture 授權；觸發它的 `unlockAudio()`／`play()` 呼叫結束後
 *     （microtask）`paused` 仍為 true 時隨即 `pause()`。
 *   - 不是模組自己觸發的 pause／play（Android 來電、audio focus 被搶、沒有 Media Session handler 時的
 *     通知與鎖屏按鍵）鏡像為 `engine.pause()`／`engine.play()`，`statechange.reason` 為 `'command'`，不另外通知 App。
 *     沒有媒體（idle、error）時外部的 play 不鏡像，anchor 停回去。
 *   - anchor 的 `play()` 被拒不算 Engine 的錯誤、不影響播放；下一次 `beforeaudiostart`，或 `paused` 變成 false
 *     （含離開 error、idle）時再試，`paused` 維持 false 的其他 state 轉換不重試。
 *
 * App 的 CSP 若限制 `media-src`，要允許 `blob:`。Media Session 的 handler、metadata 與 position 仍由 App 負責。
 */
export function attachBackgroundPlayback(
  engine: Engine,
  options: BackgroundPlaybackOptions = {},
): BackgroundPlayback {
  return attachWith(engine, options, {
    createAnchor: () => new Audio(),
    audioSession: (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession,
  });
}

// E2E 的容差（docs/testing.md「E2E」）。flaky 時只調這裡。

/** beep 被聽到的時刻，`currentTime` 與 beep 的媒體時間的差（秒）。 */
export const BEEP_ONSET_TOLERANCE = 0.02;

/**
 * 變速（經過 `atempo`）時，beep 被聽到的時刻 `currentTime` 與 beep 的媒體時間的差（秒）。比 `BEEP_ONSET_TOLERANCE`
 * 寬：`atempo`（WSOLA）以 2048 sample 的 window 疊接，完全的靜音之後波形對齊找不到依據，片段會往前跳，beep 的起點
 * 比 time map 早出現（browser mode 實測 1.25x 早 12–20 ms，E2E 再加上量測誤差約 20–24 ms）。這是演算法的特性，
 * 不是時鐘或 time map 的誤差：beep 的間隔仍準確（`STRETCHED_BEEP_INTERVAL_TOLERANCE`）。
 *
 * 40 ms 低於 ITU-R BT.1359 對聲音領先畫面的可察覺門檻（約 45 ms），提早的方向也正是聲音領先。
 */
export const STRETCHED_BEEP_ONSET_TOLERANCE = 0.04;

/**
 * 白框出現的時刻與 beep 被聽到的時刻的差（秒）：1 個影片 frame（30 fps）加 1 個 rAF（60 Hz），約 50 ms。frame 依音訊時鐘
 * 在 rAF 內挑選，量測端也在 rAF 內讀 canvas，各有最多一個 rAF 的落差。
 */
export const WHITE_BOX_TO_BEEP_TOLERANCE = 1 / 30 + 1 / 60;

/** `atempo` 1.25x 時相鄰兩個 beep 被聽到的間隔，與 0.8 秒的差（秒）。 */
export const STRETCHED_BEEP_INTERVAL_TOLERANCE = 0.01;

/**
 * 播放中 `reload()`：按下 reload 之前讀到的 `currentTime` 與 reload 完成、回到 playing 之後讀到的差的上限（秒）。
 * 包括按下到 Engine 收到指令之間、以及回到 playing 到讀取之間仍在播放的時間。
 */
export const RELOAD_RESUME_SLACK = 1;

/**
 * error 之後 `reload()`：回到 playing 之後讀到的 `currentTime` 比 `EngineError.position` 晚的上限（秒），即回到 playing
 * 到讀取之間播放的時間。
 */
export const ERROR_RELOAD_RESUME_SLACK = 0.5;

/** bufferedchange 的間隔可以比 `timeUpdateInterval` 短多少（ms）：timer 的觸發時間與頁面取時間的誤差。 */
export const THROTTLE_SLACK_MS = 20;

/**
 * leak 測試：熱身之後到 100 次換檔與 destroy 之後，GC 後主執行緒 JS heap 的增長上限（bytes）。Demo 頁的事件 log
 * 本身會增長（每次換檔十幾行），所以不是 0。
 */
export const LEAK_HEAP_GROWTH_BYTES = 4 * 1024 * 1024;

/**
 * leak 測試：播放影片時還沒 close 的 VideoFrame 的上限。media Worker 在還沒 close 的 frame 加上 decode 佇列到 8 張時
 * 停止送進 decoder，decoder 內部（B-frame 的重排）暫存的之後仍會輸出，再加上畫面上的那一張。
 */
export const MAX_OPEN_VIDEO_FRAMES = 13;

/**
 * 讀取 Demo 頁顯示的 cue 時，`currentTime` 要離 cue 的起訖至少這麼遠（秒）：畫面在 rAF 內更新，讀取與更新之間
 * 最多差一個 rAF，再加上 cue 的起點因 `start_time` 平移的幾十 ms。
 */
export const CUE_EDGE_MARGIN = 0.12;

/** 改變 volume／muted 之後，等 GainNode（time constant 約 10 ms）趨近新值再開始錄音的時間（ms）。 */
export const GAIN_SETTLE_MS = 100;

/** volume 0.5 時錄到的峰值與 volume 1 的比，和 0.5 的差。 */
export const VOLUME_RATIO_TOLERANCE = 0.05;

/** muted 時錄到的峰值上限。 */
export const MUTED_PEAK_MAX = 1e-3;

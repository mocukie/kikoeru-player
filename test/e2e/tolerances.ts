// E2E 的容差（docs/testing.md「E2E」）。flaky 時只調這裡。

/** beep 被聽到的時刻，`currentTime` 與 beep 的媒體時間的差（秒）。 */
export const BEEP_ONSET_TOLERANCE = 0.02;

/**
 * 變速（經過 `atempo`）時，beep 被聽到的時刻 `currentTime` 與 beep 的媒體時間的差（秒）。比 `BEEP_ONSET_TOLERANCE`
 * 寬：`atempo`（WSOLA）以 2048 sample 的 window 疊接，完全的靜音之後波形對齊找不到依據，片段會往前跳，beep 的起點
 * 比 time map 早出現（browser mode 實測 1.25x 早 12–20 ms，E2E 再加上量測誤差約 20–24 ms）。不是 time map 的誤差：
 * beep 的間隔仍準確（`STRETCHED_BEEP_INTERVAL_TOLERANCE`）。
 */
export const STRETCHED_BEEP_ONSET_TOLERANCE = 0.03;

/** `atempo` 1.25x 時相鄰兩個 beep 被聽到的間隔，與 0.8 秒的差（秒）。 */
export const STRETCHED_BEEP_INTERVAL_TOLERANCE = 0.01;

/** bufferedchange 的間隔可以比 `timeUpdateInterval` 短多少（ms）：timer 的觸發時間與頁面取時間的誤差。 */
export const THROTTLE_SLACK_MS = 20;

/**
 * leak 測試：熱身之後到 100 次換檔與 destroy 之後，GC 後主執行緒 JS heap 的增長上限（bytes）。Demo 頁的事件 log
 * 本身會增長（每次換檔十幾行），所以不是 0。
 */
export const LEAK_HEAP_GROWTH_BYTES = 4 * 1024 * 1024;

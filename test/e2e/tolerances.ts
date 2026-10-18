// E2E 的容差（docs/testing.md「E2E」）。flaky 時只調這裡。

/** beep 被聽到的時刻，`currentTime` 與 beep 的媒體時間的差（秒）。 */
export const BEEP_ONSET_TOLERANCE = 0.02;

/**
 * leak 測試：熱身之後到 100 次換檔與 destroy 之後，GC 後主執行緒 JS heap 的增長上限（bytes）。Demo 頁的事件 log
 * 本身會增長（每次換檔十幾行），所以不是 0。
 */
export const LEAK_HEAP_GROWTH_BYTES = 4 * 1024 * 1024;

// E2E 的容差（docs/testing.md「E2E」）。flaky 時只調這裡。

/** beep 被聽到的時刻，`currentTime` 與 beep 的媒體時間的差（秒）。 */
export const BEEP_ONSET_TOLERANCE = 0.02;

/** bufferedchange 的間隔可以比 `timeUpdateInterval` 短多少（ms）：timer 的觸發時間與頁面取時間的誤差。 */
export const THROTTLE_SLACK_MS = 20;

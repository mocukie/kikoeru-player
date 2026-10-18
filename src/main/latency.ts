// 「此刻聽到的位置」的換算（ADR-0004「Consequences」）：sample 進入 audio graph 到被聽到之間的輸出延遲。

/** 同一時刻讀到的 AudioContext 時間與延遲；不支援的欄位為 undefined。 */
export interface OutputTiming {
  /** `AudioContext.currentTime`：已經 render 到的 context 時間（秒）。 */
  currentTime: number;
  /** `performance.now()`（ms）。 */
  now: number;
  /** `AudioContext.getOutputTimestamp()`。 */
  timestamp?: AudioTimestamp | undefined;
  /** `AudioContext.outputLatency`（秒）。 */
  outputLatency?: number | undefined;
  /** `AudioContext.baseLatency`（秒）。 */
  baseLatency?: number | undefined;
}

/**
 * 此刻聽到的 context 時間（秒），落在 `[0, currentTime]`；context 還沒開始（`currentTime` 為 0）時為 null。依序：
 * 1. `getOutputTimestamp()` 的 `contextTime` 加上 `performanceTime` 之後經過的時間（不支援或 `contextTime` 為 0 時跳過）。
 * 2. `currentTime − outputLatency`（不支援或為 0 時跳過）。
 * 3. `currentTime − baseLatency`。
 * 4. 都沒有時就是 `currentTime`。
 */
export function heardContextTime(timing: OutputTiming): number | null {
  const { currentTime, now, timestamp, outputLatency, baseLatency } = timing;
  if (currentTime <= 0) return null;
  const { contextTime, performanceTime } = timestamp ?? {};
  let heard: number;
  if (contextTime !== undefined && performanceTime !== undefined && contextTime > 0) {
    heard = contextTime + Math.max(0, now - performanceTime) / 1000;
  } else if (outputLatency !== undefined && Number.isFinite(outputLatency) && outputLatency > 0) {
    heard = currentTime - outputLatency;
  } else if (baseLatency !== undefined && Number.isFinite(baseLatency)) {
    heard = currentTime - baseLatency;
  } else {
    heard = currentTime;
  }
  return Math.min(Math.max(0, heard), currentTime);
}

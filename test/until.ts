// browser mode 測試用：輪詢等到條件成立（真實的 Worker、AudioContext 與 WebCodecs 沒有可以 await 的完成點）。

/** 每 20 ms 檢查一次 `predicate`，成立時 resolve；超過 `timeoutMs` 時以「等待逾時」reject。 */
export async function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('等待逾時');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

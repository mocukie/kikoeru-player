// 尚未實作的公開成員的佔位。不是 EngineErrorCode 的成員；v1.0.0 之前必須全部移除（`grep notImplemented` 為 0）。

/** 丟出指出成員名稱的錯誤。 */
export function notImplemented(member: string): never {
  throw new Error(`kikoeru-player: ${member} 尚未實作`);
}

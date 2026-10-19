// media Worker 的診斷 log：在送出端依 init 的 logLevel 過濾，只有通過的才跨執行緒傳到主執行緒。

import type {
  WireLogLevel,
  WireLogScope,
  WorkerLogMessage,
  WorkerToMainMessage,
} from '../protocol/index.js';

/** log 等級的高低（Worker 不能 import 主執行緒的程式碼，與主執行緒、worklet 各有一份）。 */
const rank: Readonly<Record<WireLogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Worker 內各模組使用的 log 出口。 */
export interface Logger {
  /** 這個等級會送出；用來避免組出用不到的 `data`。 */
  enabled(level: WireLogLevel): boolean;
  /** `data` 只能放 structured clone 得了的值。 */
  log(
    level: WireLogLevel,
    scope: WireLogScope,
    message: string,
    data?: Record<string, unknown>,
  ): void;
}

/** 什麼都不送的 Logger（init 之前、測試）。 */
export const silentLogger: Logger = {
  enabled: () => false,
  log: () => undefined,
};

/**
 * 依 `level` 過濾並以 `log` 訊息送出；`level` 為 null 時什麼都不送。`now` 是 `performance.timeOrigin +
 * performance.now()`（ms），主執行緒以自己的 timeOrigin 換算。
 */
export function createWorkerLogger(
  level: WireLogLevel | null,
  post: (message: WorkerToMainMessage) => void,
  now: () => number = () => performance.timeOrigin + performance.now(),
): Logger {
  if (level === null) return silentLogger;
  const threshold = rank[level];
  const enabled = (l: WireLogLevel) => rank[l] >= threshold;
  return {
    enabled,
    log(l, scope, message, data) {
      if (!enabled(l)) return;
      const entry = { level: l, scope, message, time: now(), ...(data && { data }) };
      post({ type: 'log', entry } satisfies WorkerLogMessage);
    },
  };
}

// 主執行緒的診斷 log：等級過濾、轉送 media Worker 與 worklet 的 log，並隔離 hook 丟出的錯誤。

import type { WireLogEntry } from '../protocol/index.js';
import type { EngineErrorCode, LogEntry, LogHook, LogLevel } from './types.js';

const rank: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 是 `LogLevel` 的四個值之一。 */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.hasOwn(rank, value);
}

/**
 * 把 media Worker 的 log 時間（`performance.timeOrigin + performance.now()`，ms）換算成主執行緒的
 * `performance.now()` 時基。
 */
export function fromWorkerTime(time: number, timeOrigin = performance.timeOrigin): number {
  return time - timeOrigin;
}

/**
 * 把 worklet 的 log 時間（事件發生的 render quantum 的 context frame）換算成主執行緒的 `performance.now()` 時基：
 * 以同一時刻讀到的 `AudioContext.currentTime` 與 `performance.now()` 對齊，不晚於此刻。
 */
export function fromContextFrame(timing: {
  frame: number;
  sampleRate: number;
  /** `AudioContext.currentTime`（秒）。 */
  currentTime: number;
  /** `performance.now()`（ms）。 */
  now: number;
}): number {
  const { frame, sampleRate, currentTime, now } = timing;
  const ago = Math.max(0, currentTime - frame / sampleRate) * 1000;
  return now - ago;
}

/** 依錯誤碼決定錯誤 log 的 scope。 */
export function errorScope(code: EngineErrorCode): LogEntry['scope'] {
  if (code.startsWith('SOURCE_')) return 'io';
  if (code.startsWith('FORMAT_')) return 'demux';
  if (code.startsWith('AUDIO_') || code === 'CODEC_UNSUPPORTED' || code === 'DECODE_FAILED') {
    return 'audio';
  }
  if (code === 'ASSET_LOAD_FAILED' || code === 'MEMORY_LIMIT' || code === 'INTERNAL') {
    return 'worker';
  }
  return 'command';
}

/** Engine 的 log 出口；沒有 hook 時什麼都不做，其他執行緒也被告知不送（`wireLevel` 為 null）。 */
export class Logger {
  readonly #hook: LogHook | null;
  readonly #level: LogLevel;

  constructor(hook: LogHook | null, level: LogLevel) {
    this.#hook = hook;
    this.#level = level;
  }

  /** 告訴 Worker 與 worklet 的最低等級；沒有 hook 時為 null。 */
  get wireLevel(): LogLevel | null {
    return this.#hook ? this.#level : null;
  }

  /** 這個等級的 log 會送進 hook；用來避免組出用不到的 `data`。 */
  enabled(level: LogLevel): boolean {
    return this.#hook !== null && rank[level] >= rank[this.#level];
  }

  /** 主執行緒自己的 log，時間取此刻的 `performance.now()`。 */
  log(
    level: LogLevel,
    scope: LogEntry['scope'],
    message: string,
    data?: Record<string, unknown>,
  ): void {
    if (!this.enabled(level)) return;
    this.#emit({ level, scope, message, time: performance.now(), ...(data && { data }) });
  }

  /** 其他執行緒的 log；`time` 已換算成主執行緒的時基。送出端已過濾，這裡再過濾一次。 */
  forward(entry: WireLogEntry): void {
    if (!this.enabled(entry.level)) return;
    this.#emit(entry);
  }

  #emit(entry: LogEntry): void {
    try {
      this.#hook?.(entry);
    } catch (error) {
      // hook 的錯誤不能打斷 Engine 的流程；交給全域的錯誤回報（Node 等沒有時丟掉）。
      const { reportError } = globalThis as { reportError?: (error: unknown) => void };
      reportError?.(error);
    }
  }
}

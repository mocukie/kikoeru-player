// media Worker 內可分類的錯誤，以及轉成跨執行緒的 WireError。

import type { WireError, WorkerCrashMessage, WorkerErrorCode } from '../protocol/index.js';

/** 帶錯誤碼的致命錯誤；Worker 以 `error` 訊息回報給主執行緒。 */
export class WorkerError extends Error {
  readonly code: WorkerErrorCode;
  readonly detail: WireError['detail'];

  constructor(
    code: WorkerErrorCode,
    message: string,
    options: { detail?: WireError['detail']; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'WorkerError';
    this.code = code;
    this.detail = options.detail;
  }
}

/** 轉成 `WireError`；沒有分類的錯誤是 fatal 的 `INTERNAL`。 */
export function toWireError(error: unknown): WireError {
  if (error instanceof WorkerError) {
    return {
      code: error.code,
      fatal: true,
      message: error.message,
      ...(error.detail && { detail: error.detail }),
    };
  }
  return { code: 'INTERNAL', fatal: true, message: errorMessage(error) };
}

/**
 * 記憶體用完的訊息：emscripten 的 `Out of memory`（`writeoutEmscriptenOOM`）與 `Aborted(OOM)`、FFmpeg 的
 * `AVERROR(ENOMEM)` 經 `ff_error()`（musl 的 strerror 是 `Out of memory`）、V8 配置不到 ArrayBuffer。
 */
const OUT_OF_MEMORY = /out of memory|\bOOM\b|cannot allocate memory|allocation failed/i;

/**
 * Worker 無法繼續運作的錯誤（ADR-0002）：wasm trap 之後 instance 不能再用；`MAXIMUM_MEMORY` 用完時 FFmpeg 與 libav.js
 * 到處都可能配置失敗。兩者都以 `crash` 回報（主執行緒回報 `INTERNAL`），不當成壞封包或可分類的錯誤。
 * `WorkerError`（例如建立 instance 時配置不到記憶體的 `MEMORY_LIMIT`）不是崩潰。
 */
export function crashReason(error: unknown): WorkerCrashMessage['reason'] | null {
  if (!(error instanceof Error) || error instanceof WorkerError) return null;
  if (OUT_OF_MEMORY.test(error.message)) return 'out-of-memory';
  if (error instanceof WebAssembly.RuntimeError) return 'wasm-trap';
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

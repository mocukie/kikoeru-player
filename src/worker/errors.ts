// media Worker 內可分類的錯誤，以及轉成跨執行緒的 WireError。

import type { WireError, WorkerErrorCode } from '../protocol/index.js';

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import type { EngineErrorCode } from './types.js';

/**
 * Engine 的錯誤。被取代或取消的指令不使用 `EngineError`，而是以 `DOMException`（name `'AbortError'`）reject，
 * App 用 `isAbortError()` 判斷後忽略即可。
 */
export class EngineError extends Error {
  override readonly name = 'EngineError';
  /** 錯誤的種類。 */
  readonly code: EngineErrorCode;
  /**
   * 致命錯誤會讓 state 進入 `'error'`。非致命的出現在指令的 reject（例如外掛音軌載入失敗），
   * 或播放中自動降級時的 `error` 事件（例如影片解碼失敗、退回只播音訊）。
   */
  readonly fatal: boolean;
  /** 發生時的播放位置（秒），供重新載入時接續。 */
  readonly position: number;
  /** 依錯誤種類附帶的資訊：HTTP status、來源 URL、相關的軌道與 codec。 */
  readonly detail: {
    readonly status?: number;
    readonly url?: string;
    readonly trackId?: string;
    readonly codec?: string;
  };
  /** 造成這個錯誤的底層錯誤，例如 `fetch()` 的 `TypeError`。 */
  declare readonly cause?: unknown;

  /**
   * 由 Engine 建立；App 一般不需要自己建立。
   *
   * @param code 錯誤的種類。
   * @param init `message` 省略時以 `code` 當 message；`detail` 省略時為空物件。
   */
  constructor(
    code: EngineErrorCode,
    init: {
      fatal: boolean;
      position: number;
      detail?: EngineError['detail'];
      message?: string;
      cause?: unknown;
    },
  ) {
    super(init.message ?? code, 'cause' in init ? { cause: init.cause } : undefined);
    this.code = code;
    this.fatal = init.fatal;
    this.position = init.position;
    this.detail = { ...init.detail };
  }
}

/**
 * 判斷是不是被取代或取消的指令所 reject 的 AbortError（`name` 為 `'AbortError'` 的錯誤）。
 * App 對指令的 reject 通常先以它過濾，再處理 `EngineError`。
 */
export function isAbortError(error: unknown): boolean {
  // 不用 instanceof：DOMException 可能來自其他 realm，部分環境中也不是 Error 的子類別。
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

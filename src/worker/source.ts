// 來源：以 `read(offset, length, signal)` 讀取位元組（ADR-0001）。http 依狀態碼分類錯誤，5xx 與網路錯誤以指數退避
// 重試；Range 快取與預讀由後續 issue 加入。

import type { RetryPolicy, WireSource, WorkerErrorCode } from '../protocol/index.js';
import { WorkerError } from './errors.js';
import type { WorkerHost } from './host.js';

/** 一個可隨機讀取的來源。 */
export interface ByteSource {
  readonly size: number;
  /** 讀取 `[offset, offset + length)`，超出結尾的部分截掉；被 `signal` 中止時以 AbortError reject。 */
  read(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
}

export interface SourceDeps {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** http 讀取的重試；省略時不重試。 */
  retry?: RetryPolicy;
}

/** 開啟來源並取得大小；http 沒有給大小時發一個 Range 請求。 */
export async function openSource(
  wire: WireSource<WorkerHost>,
  signal: AbortSignal,
  deps: SourceDeps = {},
): Promise<ByteSource> {
  switch (wire.kind) {
    case 'bytes':
      return bytesSource(wire.data instanceof Uint8Array ? wire.data : new Uint8Array(wire.data));
    case 'blob':
      return blobSource(wire.blob);
    case 'http':
      return httpSource(wire, signal, deps);
  }
}

function bytesSource(data: Uint8Array): ByteSource {
  return {
    size: data.length,
    read: (offset, length, signal) =>
      signal.aborted
        ? Promise.reject(signal.reason as Error)
        : Promise.resolve(data.subarray(offset, offset + length)),
  };
}

function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    async read(offset, length, signal) {
      signal.throwIfAborted();
      // Blob 的讀取不能中止；中止時不等它完成。
      const buffer = await abortable(blob.slice(offset, offset + length).arrayBuffer(), signal);
      return new Uint8Array(buffer);
    },
  };
}

async function httpSource(
  wire: Extract<WireSource<WorkerHost>, { kind: 'http' }>,
  signal: AbortSignal,
  deps: SourceDeps,
): Promise<ByteSource> {
  const { url } = wire;
  const retry = deps.retry ?? noRetry;
  const fetchImpl = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));

  /** 一次 Range 請求，讀完整個 body；失敗時丟分類過的 `WorkerError`，被中止時丟 `signal` 的錯誤。 */
  const request = async (start: number, end: number, signal: AbortSignal) => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...(wire.credentials && { credentials: wire.credentials }),
        headers: { ...wire.headers, Range: `bytes=${String(start)}-${String(end)}` },
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      // 網路中斷、CORS、DNS 在 fetch() 都是同一個 TypeError，分不出來。
      throw new WorkerError('SOURCE_NETWORK', `無法連線到 ${url}`, {
        detail: { url },
        cause: error,
      });
    }
    if (response.status !== 206) {
      await response.body?.cancel().catch(() => undefined);
      const { status } = response;
      throw new WorkerError(httpErrorCode(status), `${url} 回應 HTTP ${String(status)}`, {
        detail: { status, url },
      });
    }
    let data: Uint8Array;
    try {
      data = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      signal.throwIfAborted();
      throw new WorkerError('SOURCE_NETWORK', `讀取 ${url} 時連線中斷`, {
        detail: { url },
        cause: error,
      });
    }
    if (data.length !== end - start + 1) {
      throw new WorkerError(
        'SOURCE_NETWORK',
        `${url} 的回應不完整：要求 ${String(end - start + 1)} bytes，收到 ${String(data.length)} bytes`,
        { detail: { url } },
      );
    }
    return { data, contentRange: response.headers.get('Content-Range') };
  };

  /** 以 `retry` 重試 5xx 與網路錯誤；退避中的等待也以 `signal` 中止。 */
  const fetchRange = async (start: number, end: number, signal: AbortSignal) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(start, end, signal);
      } catch (error) {
        if (!retryable(error) || attempt >= retry.attempts) throw error;
      }
      await sleep(retry.baseDelayMs * 2 ** attempt, signal);
    }
  };

  let size = wire.size;
  if (size === undefined) {
    // 第一個 Range 回應的 Content-Range 帶著總大小。
    size = parseTotalSize((await fetchRange(0, 0, signal)).contentRange);
    if (size === undefined) {
      throw new WorkerError('SOURCE_RANGE_UNSUPPORTED', `${url} 沒有回報檔案大小`, {
        detail: { url },
      });
    }
  }
  const total = size;

  return {
    size: total,
    async read(offset, length, signal) {
      const end = Math.min(offset + length, total) - 1;
      if (end < offset) return new Uint8Array();
      return (await fetchRange(offset, end, signal)).data;
    },
  };
}

const noRetry: RetryPolicy = { attempts: 0, baseDelayMs: 0 };

/** 只重試網路錯誤與 5xx。 */
function retryable(error: unknown): boolean {
  if (!(error instanceof WorkerError)) return false;
  return error.code === 'SOURCE_NETWORK' || (error.detail?.status ?? 0) >= 500;
}

/**
 * 不是 206 的回應：200（伺服器忽略 Range）與 416 是 Range 不可用；401／403／404／410 各自分類；
 * 5xx 與其他狀態碼是 `SOURCE_SERVER`（只有 5xx 會重試）。
 */
function httpErrorCode(status: number): WorkerErrorCode {
  if (status >= 500) return 'SOURCE_SERVER';
  switch (status) {
    case 401:
      return 'SOURCE_UNAUTHORIZED';
    case 403:
      return 'SOURCE_FORBIDDEN';
    case 404:
    case 410:
      return 'SOURCE_NOT_FOUND';
    case 416:
      return 'SOURCE_RANGE_UNSUPPORTED';
    default:
      return status < 300 ? 'SOURCE_RANGE_UNSUPPORTED' : 'SOURCE_SERVER';
  }
}

/** 等 `ms` 毫秒；`signal` 中止時立即以它的 reason reject。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return abortable(
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
        },
        { once: true },
      );
    }),
    signal,
  );
}

/** `Content-Range: bytes 0-0/12345` 的 12345。 */
function parseTotalSize(header: string | null): number | undefined {
  const match = header && /\/(\d+)\s*$/.exec(header);
  return match ? Number(match[1]) : undefined;
}

/** `signal` 中止時以它的 reason reject，不等 `promise`。 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

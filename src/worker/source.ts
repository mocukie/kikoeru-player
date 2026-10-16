// 來源：以 `read(offset, length, signal)` 讀取位元組（ADR-0001）。http 的錯誤分類、重試與快取由後續 issue 加入。

import type { WireSource, WorkerErrorCode } from '../protocol/index.js';
import { WorkerError } from './errors.js';
import type { WorkerHost } from './host.js';

/** 一個可隨機讀取的來源。 */
export interface ByteSource {
  readonly size: number;
  /** 讀取 `[offset, offset + length)`，超出結尾的部分截掉；被 `signal` 中止時以 AbortError reject。 */
  read(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
}

export interface SourceDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

const defaultDeps: SourceDeps = { fetch: (url, init) => fetch(url, init) };

/** 開啟來源並取得大小；http 沒有給大小時發一個 Range 請求。 */
export async function openSource(
  wire: WireSource<WorkerHost>,
  signal: AbortSignal,
  deps: SourceDeps = defaultDeps,
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
    read: (offset, length) => Promise.resolve(data.subarray(offset, offset + length)),
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
  const request = async (start: number, end: number, signal: AbortSignal) => {
    let response: Response;
    try {
      response = await deps.fetch(wire.url, {
        ...(wire.credentials && { credentials: wire.credentials }),
        headers: { ...wire.headers, Range: `bytes=${String(start)}-${String(end)}` },
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new WorkerError('SOURCE_NETWORK', `無法連線到 ${wire.url}`, {
        detail: { url: wire.url },
        cause: error,
      });
    }
    if (response.status !== 206) {
      await response.body?.cancel();
      const code = httpErrorCode(response.status);
      throw new WorkerError(code, `${wire.url} 回應 HTTP ${String(response.status)}`, {
        detail: { status: response.status, url: wire.url },
      });
    }
    return response;
  };

  let size = wire.size;
  if (size === undefined) {
    const response = await request(0, 0, signal);
    await response.arrayBuffer();
    size = parseTotalSize(response.headers.get('Content-Range'));
    if (size === undefined) {
      throw new WorkerError('SOURCE_RANGE_UNSUPPORTED', `${wire.url} 沒有回報檔案大小`, {
        detail: { url: wire.url },
      });
    }
  }
  const total = size;

  return {
    size: total,
    async read(offset, length, signal) {
      const end = Math.min(offset + length, total) - 1;
      if (end < offset) return new Uint8Array();
      const response = await request(offset, end, signal);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

function httpErrorCode(status: number): WorkerErrorCode {
  switch (status) {
    case 200:
      return 'SOURCE_RANGE_UNSUPPORTED';
    case 401:
      return 'SOURCE_UNAUTHORIZED';
    case 403:
      return 'SOURCE_FORBIDDEN';
    case 404:
    case 410:
      return 'SOURCE_NOT_FOUND';
    default:
      return 'SOURCE_SERVER';
  }
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

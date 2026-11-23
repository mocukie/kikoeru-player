// 公開 API 的 `Source` 轉成送給 media Worker 的 `WireSource`。

import type { WireSource } from '../protocol/index.js';
import type { MainHost } from './deps.js';
import type { Source } from './types.js';

/** Worker 內的 fetch 以 Worker script 的位置解析相對 URL，所以先以 document 的 base URL 解析。 */
function resolveUrl(url: string | URL): string {
  if (typeof document === 'undefined') return String(url);
  try {
    return new URL(url, document.baseURI).href;
  } catch {
    // 無效的 URL 原樣交給 Worker，由 fetch 失敗回報。
    return String(url);
  }
}

export function toWireSource(source: Source): WireSource<MainHost> {
  switch (source.kind) {
    case 'http':
      return {
        kind: 'http',
        url: resolveUrl(source.url),
        ...(source.credentials && { credentials: source.credentials }),
        ...(source.headers && { headers: source.headers }),
        ...(source.size !== undefined && { size: source.size }),
      };
    case 'bytes':
      return { kind: 'bytes', data: source.data, ...(source.name && { name: source.name }) };
    case 'blob':
      return { kind: 'blob', blob: source.blob };
  }
}

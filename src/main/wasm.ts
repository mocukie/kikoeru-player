// wasm 與 libav.js glue 的位置與 compile（ADR-0005）。

import { AssetLoadError, type WasmAssets } from './deps.js';
import type { EngineOptions } from './types.js';

// 套件把 wasm/dist/ 的檔案複製到 dist/wasm/，所以從 dist/main/ 以 ../wasm/ 參照；App 的 bundler 依這個寫法把它們當成資產。
// 本 repo 的 dev server 與 browser mode 由 test/server/ 把 /src/wasm/ 對應到 wasm/dist/。
function defaultWasmUrl(): URL {
  return new URL('../wasm/libav-6.10.9.0-kikoeru.wasm.wasm', import.meta.url);
}

function defaultGlueUrl(): URL {
  return new URL('../wasm/libav-6.10.9.0-kikoeru.wasm.mjs', import.meta.url);
}

/**
 * 以 `compileStreaming` compile wasm（`.wasm` 必須以 `Content-Type: application/wasm` 提供），並解析 glue 的 URL。
 * 失敗時以 `AssetLoadError` reject。
 */
export async function loadWasmAssets(assets: EngineOptions['assets'] = {}): Promise<WasmAssets> {
  const wasmUrl = new URL(assets.wasmUrl ?? defaultWasmUrl(), globalThis.location.href);
  const glueUrl = new URL(assets.glueUrl ?? defaultGlueUrl(), globalThis.location.href);
  try {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    const module = await WebAssembly.compileStreaming(response);
    return { module, glueUrl: glueUrl.href };
  } catch (cause) {
    throw new AssetLoadError(`無法載入 wasm（${wasmUrl.href}）`, { cause });
  }
}

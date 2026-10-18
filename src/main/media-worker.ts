// 真實的 media Worker：每次 load 一個（ADR-0002）。

import type { MainToWorkerMessage, WorkerToMainMessage } from '../protocol/index.js';
import {
  AssetLoadError,
  type MainHost,
  type MediaWorker,
  type MediaWorkerHandlers,
} from './deps.js';

/**
 * 以字面寫法建立 media Worker（硬性約束第 6 條），讓 App 的 Vite 能辨識並 bundle。
 * Worker 的 `error`／`messageerror` 一律交給 `handlers.crash`：在 Worker 送出 `ready` 之前的 `error` 是 script 載入
 * 失敗（404、MIME type、import 失敗、script 的頂層丟錯），以 `AssetLoadError` 回報；之後的是崩潰，原樣回報。
 */
export function createWebMediaWorker(handlers: MediaWorkerHandlers): MediaWorker {
  const worker = new Worker(new URL('../worker/index.js', import.meta.url), { type: 'module' });
  let ready = false;
  worker.onmessage = ({ data }: MessageEvent<WorkerToMainMessage>) => {
    if (data.type === 'ready') ready = true;
    handlers.message(data);
  };
  worker.onerror = (event) => {
    // 不讓瀏覽器再把它當成未處理的錯誤；Engine 以 ASSET_LOAD_FAILED 或 INTERNAL 回報。
    event.preventDefault();
    handlers.crash(
      ready ? event : new AssetLoadError('media Worker 的 script 載入失敗', { cause: event }),
    );
  };
  worker.onmessageerror = (event) => {
    handlers.crash(event);
  };
  return {
    post(message: MainToWorkerMessage<MainHost>, transfer: Transferable[] = []) {
      worker.postMessage(message, transfer);
    },
    terminate() {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    },
  };
}

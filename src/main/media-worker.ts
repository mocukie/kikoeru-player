// 真實的 media Worker：每次 load 一個（ADR-0002）。

import type { MainToWorkerMessage, WorkerToMainMessage } from '../protocol/index.js';
import type { MainHost, MediaWorker, MediaWorkerHandlers } from './deps.js';

/**
 * 以字面寫法建立 media Worker（硬性約束第 6 條），讓 App 的 Vite 能辨識並 bundle。
 * Worker 的 `error`／`messageerror` 一律交給 `handlers.crash`。
 */
export function createWebMediaWorker(handlers: MediaWorkerHandlers): MediaWorker {
  const worker = new Worker(new URL('../worker/index.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }: MessageEvent<WorkerToMainMessage>) => {
    handlers.message(data);
  };
  worker.onerror = (event) => {
    // 不讓瀏覽器再把它當成未處理的錯誤；Engine 以 INTERNAL 回報。
    event.preventDefault();
    handlers.crash(event);
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

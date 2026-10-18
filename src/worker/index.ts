// media Worker 的進入點：Range I/O、demux、解碼與預讀。訊息處理見 media-worker.ts。

import type { MainToWorkerMessage, WorkerToMainMessage } from '../protocol/index.js';
import type { WorkerHost } from './host.js';
import { MediaWorker } from './media-worker.js';

const worker = new MediaWorker({
  postMessage: (message) => {
    self.postMessage(message);
  },
});

self.onmessage = ({ data }: MessageEvent<MainToWorkerMessage<WorkerHost>>) => {
  worker.handle(data);
};

// script 載入完成：主執行緒以此區分載入失敗（ASSET_LOAD_FAILED）與之後的崩潰（INTERNAL）。
self.postMessage({ type: 'ready' } satisfies WorkerToMainMessage);

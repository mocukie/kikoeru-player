// media Worker 的進入點：Range I/O、demux、解碼與預讀。訊息處理見 media-worker.ts。

import type { MainToWorkerMessage } from '../protocol/index.js';
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

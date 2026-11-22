// 影片的假資料：假的 VideoFrame、有影片軌的 probe 結果，以及以假 media Worker 送出 frame 的 helper。

import type { ProbedMedia, ProbedVideoTrack } from '../../src/protocol/index.js';
import { audioMedia, type FakeMediaWorker } from './media-worker.js';

/** 假的 VideoFrame：時間以秒給，記錄是否 close。 */
export class FakeFrame {
  closed = false;
  readonly timestamp: number;
  readonly displayWidth = 320;
  readonly displayHeight = 180;
  readonly visibleRect = { width: 320, height: 180 };
  constructor(seconds: number) {
    this.timestamp = Math.round(seconds * 1e6);
  }
  close(): void {
    this.closed = true;
  }
}

/** stream 1 的 H.264 影片軌，320×180、30 fps。 */
export const videoTrack: ProbedVideoTrack = {
  kind: 'video',
  streamIndex: 1,
  codec: 'h264',
  codecString: 'avc1.64000d',
  supported: true,
  default: true,
  forced: false,
  codedWidth: 320,
  codedHeight: 180,
  display: { width: 320, height: 180, rotation: 0 },
  frameRate: 30,
};

/** `audioMedia()` 的音軌加上一條影片軌。 */
export function videoMedia(video: Partial<ProbedVideoTrack> = {}): ProbedMedia {
  return audioMedia({ tracks: [...audioMedia().tracks, { ...videoTrack, ...video }] });
}

/** 只有影片軌的媒體（stream 0）。 */
export function videoOnlyMedia(): ProbedMedia {
  return audioMedia({ tracks: [{ ...videoTrack, streamIndex: 0 }] });
}

/** 送一張 frame（epoch 預設為最後一個 start／seek 的）。 */
export function frame(worker: FakeMediaWorker, seconds: number, epoch?: number): FakeFrame {
  const f = new FakeFrame(seconds);
  const latest = [...worker.received]
    .reverse()
    .find((m) => m.type === 'start' || m.type === 'seek');
  const e = epoch ?? (latest && 'epoch' in latest ? latest.epoch : 0);
  worker.reply({ type: 'frame', epoch: e, frame: f });
  return f;
}

/** Engine 以 `frameclosed` 告訴 Worker 的 close 數合計。 */
export function closedCount(worker: FakeMediaWorker): number {
  return worker.messages('frameclosed').reduce((sum, m) => sum + m.count, 0);
}

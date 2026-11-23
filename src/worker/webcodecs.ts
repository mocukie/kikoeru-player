// WebCodecs 的 `VideoDecoder`：影片只走 WebCodecs 解碼（ADR-0003）。沒有 WebCodecs 的瀏覽器（例如 Firefox Android）
// 一律不支援，標為 `'platform'`。

import type { VideoConfig } from './video-codec.js';
import type { VideoChunk, VideoDecoderInit, VideoDecoderLike } from './video-pipeline.js';

/** 瀏覽器是否能解這個 config；沒有 WebCodecs 時為 false。 */
export async function isVideoConfigSupported(config: VideoConfig): Promise<boolean> {
  if (typeof VideoDecoder === 'undefined') return false;
  const { supported } = await VideoDecoder.isConfigSupported(config);
  return supported === true;
}

/** 以 WebCodecs 的 `VideoDecoder` 實作 `VideoDecoderLike`。 */
export function createWebVideoDecoder(init: VideoDecoderInit<VideoFrame>): VideoDecoderLike {
  const decoder = new VideoDecoder({
    output: (frame) => {
      init.output(frame);
    },
    error: (error) => {
      init.error(error);
    },
  });
  const adapter: VideoDecoderLike = {
    get state() {
      return decoder.state;
    },
    get decodeQueueSize() {
      return decoder.decodeQueueSize;
    },
    ondequeue: null,
    configure: (config) => {
      decoder.configure(config);
    },
    decode: (chunk: VideoChunk) => {
      decoder.decode(new EncodedVideoChunk(chunk));
    },
    flush: () => decoder.flush(),
    reset: () => {
      decoder.reset();
    },
    close: () => {
      decoder.close();
    },
  };
  decoder.ondequeue = () => {
    adapter.ondequeue?.();
  };
  return adapter;
}

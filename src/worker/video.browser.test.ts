// media Worker 的影片解碼（以協定驅動，MediaWorker 直接在頁面內執行）：支援判斷、codec string、WebCodecs 解出的
// frame 數與尺寸、旋轉、seek 的起點 frame 與 backpressure。測試扮演主執行緒：收到的 frame 立即 close 並回報。
import { describe, expect, test } from 'vitest';
import {
  audioTracks,
  mediaBytes,
  WorkerDriver,
  type WorkerEndpoint,
} from '../../test/media-worker-harness.js';
import type { ProbedMedia, ProbedVideoTrack, WorkerToMainMessage } from '../protocol/index.js';
import type { WorkerHost } from './host.js';
import { MediaWorker, type MediaWorkerDeps } from './media-worker.js';
import {
  MAX_DECODE_QUEUE,
  MAX_OPEN_FRAMES,
  type VideoChunk,
  type VideoDecoderInit,
  type VideoDecoderLike,
} from './video-pipeline.js';
import { createWebVideoDecoder } from './webcodecs.js';

function inPage(deps: Omit<MediaWorkerDeps, 'postMessage'> = {}): WorkerEndpoint {
  let listener: ((message: WorkerToMainMessage<WorkerHost>) => void) | null = null;
  const worker = new MediaWorker({ ...deps, postMessage: (m) => listener?.(m) });
  return {
    post: (message) => {
      worker.handle(message);
    },
    onMessage: (l) => {
      listener = l;
    },
  };
}

const firefox = navigator.userAgent.includes('Firefox');

function videoTrack(media: ProbedMedia): ProbedVideoTrack {
  const track = media.tracks.find((t): t is ProbedVideoTrack => t.kind === 'video');
  if (!track) throw new Error('沒有影片軌');
  return track;
}

async function open(path: string, deps: Omit<MediaWorkerDeps, 'postMessage'> = {}) {
  const driver = await WorkerDriver.init(inPage(deps));
  const media = await driver.load({ kind: 'bytes', data: await mediaBytes(path) });
  return { driver, media, video: videoTrack(media) };
}

/** CI 組的影片（test/media/README.md）：30 fps、320×180。 */
const videoFiles = [
  { file: 'video/h264-aac.mp4', codec: 'h264', codecString: 'avc1.64000d', seconds: 10 },
  { file: 'video/vp9-opus.webm', codec: 'vp9', codecString: 'vp09.00.11.08', seconds: 10 },
  { file: 'video/av1-opus.webm', codec: 'av1', codecString: 'av01.0.00M.08', seconds: 10 },
  // AVI：Annex B、沒有 extradata 與 pts（以 dts 為時間戳），SPS／PPS 在 keyframe 內。第 2 個 chunk 是空的
  //（ffprobe 也是 dts 0、2、3…），所以第 1 張之後的 frame 晚一個 frame。
  { file: 'video/h264-mp3.avi', codec: 'h264', codecString: 'avc1.64000d', seconds: 10, gap: 1 },
  { file: 'video/multi-track.mkv', codec: 'h264', codecString: 'avc1.64000d', seconds: 20 },
];

describe('CI 組的影片', () => {
  test.each(videoFiles)('$file：解出每一張 frame，尺寸與時間戳正確', async (spec) => {
    const { driver, video } = await open(spec.file);
    expect(video).toMatchObject({
      codec: spec.codec,
      codecString: spec.codecString,
      codedWidth: 320,
      codedHeight: 180,
      display: { width: 320, height: 180, rotation: 0 },
    });
    // Chromium 支援 H.264、VP9、AV1；Firefox 只測它支援的（不支援時標為 platform）。
    if (!firefox) expect(video.supported).toBe(true);
    if (!video.supported) {
      expect(video.unsupportedReason).toBe('platform');
      return;
    }

    driver.post({
      type: 'start',
      epoch: 1,
      time: 0,
      audio: null,
      video: video.streamIndex,
      subtitle: null,
    });
    const { end, frames } = await driver.videoDone(1);
    expect(end.type).toBe('videoend');
    expect(frames).toHaveLength(spec.seconds * 30);
    frames.forEach((frame, i) => {
      expect(frame.time).toBeCloseTo((i + (i > 0 ? (spec.gap ?? 0) : 0)) / 30, 2);
      expect(frame).toMatchObject({ visibleWidth: 320, visibleHeight: 180 });
      expect(frame).toMatchObject({ displayWidth: 320, displayHeight: 180 });
    });
    // 繪製路徑要涵蓋的格式：Chromium 是 I420，Firefox 是 BGRX。
    expect(frames[0]?.format).toBe(firefox ? 'BGRX' : 'I420');
    const stats = await driver.stats();
    expect(stats.video).toMatchObject({ decoded: spec.seconds * 30, decodeQueueSize: 0 });
    expect(stats.video?.avgDecodeMs).toBeGreaterThan(0);
    expect(stats.openVideoFrames).toBe(0);
  });

  test('HEVC：瀏覽器不支援，標為 platform，帶 codec string', async () => {
    const { media, video } = await open('video/hevc-aac.mp4');
    expect(video).toMatchObject({
      codec: 'hevc',
      codecString: 'hvc1.1.6.L60.90',
      supported: false,
      unsupportedReason: 'platform',
    });
    // 只有影片軌不支援：音軌照常，load 不失敗。
    expect(audioTracks(media)[0]).toMatchObject({ codec: 'aac', supported: true });
  });

  test('沒有 WebCodecs（isConfigSupported 失敗）時影片軌標為 platform，只播音訊', async () => {
    const { media, video } = await open('video/h264-aac.mp4', {
      isVideoConfigSupported: () =>
        Promise.reject(new ReferenceError('VideoDecoder is not defined')),
    });
    expect(video).toMatchObject({ supported: false, unsupportedReason: 'platform' });
    expect(audioTracks(media)[0]?.supported).toBe(true);
  });

  test('容器的 SAR：sar-2-1.mkv 顯示為 640×180', async () => {
    const { video } = await open('video/sar-2-1.mkv');
    expect(video).toMatchObject({
      codedWidth: 320,
      codedHeight: 180,
      display: { width: 640, height: 180, rotation: 0 },
    });
  });

  test('display matrix：rotated-90.mp4 顯示為 180×320，順時針 270°', async () => {
    const { video } = await open('video/rotated-90.mp4');
    expect(video).toMatchObject({
      codedWidth: 320,
      codedHeight: 180,
      display: { width: 180, height: 320, rotation: 270 },
    });
  });
});

describe('影片的輸出', () => {
  test('音訊與影片一起輸出：PCM 與 frame 都完整', async () => {
    const { driver, media, video } = await open('video/h264-aac.mp4');
    if (!video.supported) return;
    const [audio] = audioTracks(media);
    const pcm = await driver.decode(audio?.streamIndex ?? null, { video: video.streamIndex });
    const { frames } = await driver.videoDone(1);
    expect(Math.abs(pcm.left.length / 48_000 - 10)).toBeLessThan(0.05);
    expect(frames).toHaveLength(300);
  });

  test.each([
    [4.5, 4.5],
    [4.51, 4.5],
    [4.53, 4.5],
    [4.54, 4.533],
  ])('從 %f 秒開始：第一張是 pts ≤ 起點的最後一張（%f 秒），之後連續', async (time, first) => {
    const { driver, video } = await open('video/h264-aac.mp4');
    if (!video.supported) return;
    driver.post({
      type: 'start',
      epoch: 1,
      time,
      audio: null,
      video: video.streamIndex,
      subtitle: null,
    });
    const { frames } = await driver.videoDone(1);
    expect(frames[0]?.time).toBeCloseTo(first, 3);
    expect(frames).toHaveLength(300 - Math.round(first * 30));
  });

  test('seek：新的 epoch 從落點之前的 keyframe 解碼，送出落點的 frame 與之後的', async () => {
    const { driver, media, video } = await open('video/vp9-opus.webm');
    if (!video.supported) return;
    const [audio] = audioTracks(media);
    await driver.decode(audio?.streamIndex ?? null, { video: video.streamIndex, frames: 48_000 });
    const pcm = await driver.seek(7.25, 2);
    const { frames } = await driver.videoDone(2);
    expect(pcm.time).toBe(7.25);
    expect(frames[0]?.time).toBeCloseTo(7.233, 2);
    expect(frames.at(-1)?.time).toBeCloseTo(9.967, 2);
  });

  test('backpressure：主執行緒沒有 close 時停止解碼，close 之後繼續', async () => {
    const { driver, video } = await open('video/h264-aac.mp4');
    if (!video.supported) return;
    driver.autoCloseFrames = false;
    driver.post({
      type: 'start',
      epoch: 1,
      time: 0,
      audio: null,
      video: video.streamIndex,
      subtitle: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    // 沒有 close 的 frame 加上 decode 佇列到 8 就停止送進 decoder；decoder 內部（B-frame 的重排）暫存的之後仍會輸出。
    expect(driver.heldFrames.length).toBeGreaterThanOrEqual(8 - MAX_DECODE_QUEUE);
    expect(driver.heldFrames.length).toBeLessThanOrEqual(MAX_OPEN_FRAMES + MAX_DECODE_QUEUE);
    const held = driver.frames.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(driver.frames.length).toBe(held);

    driver.releaseFrames();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(driver.frames.length).toBeGreaterThan(held);
    driver.autoCloseFrames = true;
    driver.releaseFrames();
    const { frames } = await driver.videoDone(1);
    expect(frames).toHaveLength(300);
  });

  test('configure 失敗：以 videoerror（beforeFirstFrame）回報，不影響音訊', async () => {
    const { driver, media, video } = await open('video/h264-aac.mp4', {
      isVideoConfigSupported: () => Promise.resolve(true),
      createVideoDecoder: (init) => {
        const decoder = new VideoDecoder(init);
        return {
          get state() {
            return decoder.state;
          },
          get decodeQueueSize() {
            return decoder.decodeQueueSize;
          },
          ondequeue: null,
          configure: () => {
            decoder.configure({ codec: 'not-a-codec' });
          },
          decode: () => undefined,
          flush: () => decoder.flush(),
          reset: () => {
            decoder.reset();
          },
          close: () => {
            decoder.close();
          },
        };
      },
    });
    const [audio] = audioTracks(media);
    const pcm = await driver.decode(audio?.streamIndex ?? null, { video: video.streamIndex });
    const { end } = await driver.videoDone(1);
    expect(end).toMatchObject({
      type: 'videoerror',
      beforeFirstFrame: true,
      error: { code: 'CODEC_UNSUPPORTED', fatal: false },
    });
    expect(Math.abs(pcm.left.length / 48_000 - 10)).toBeLessThan(0.05);
  });
});

describe('交錯不良與壞檔', () => {
  test('交錯不良的檔案（音訊在 5 秒的影片之後）：音訊與影片都完整', async () => {
    const { driver, media, video } = await open('video/bad-interleave.mp4');
    if (!video.supported) return;
    const [audio] = audioTracks(media);
    const pcm = await driver.decode(audio?.streamIndex ?? null, { video: video.streamIndex });
    const { end, frames } = await driver.videoDone(1);
    expect(pcm.left.length).toBeGreaterThanOrEqual(10 * 48_000);
    expect(end.type).toBe('videoend');
    expect(frames).toHaveLength(300);
  });

  test('交錯不良的檔案超過封包佇列的硬上限：fatal 的 MEMORY_LIMIT', async () => {
    const driver = await WorkerDriver.init(inPage(), { limits: { packetQueueBytes: 512 * 1024 } });
    const media = await driver.load({
      kind: 'bytes',
      data: await mediaBytes('video/bad-interleave.mp4'),
    });
    const video = videoTrack(media);
    if (!video.supported) return;
    const [audio] = audioTracks(media);
    await expect(
      driver.decode(audio?.streamIndex ?? null, { video: video.streamIndex }),
    ).rejects.toMatchObject({ type: 'error', error: { code: 'MEMORY_LIMIT', fatal: true } });
  });

  test('影片封包損毀的 MKV：音訊照常播完，影片不回報致命錯誤', async () => {
    const { driver, media, video } = await open('broken/bad-packets.mkv');
    if (!video.supported) return;
    const [audio] = audioTracks(media);
    const pcm = await driver.decode(audio?.streamIndex ?? null, { video: video.streamIndex });
    const { end } = await driver.videoDone(1);
    expect(Math.abs(pcm.left.length / 48_000 - 10)).toBeLessThan(0.05);
    // decoder 容忍損毀時送完（videoend），不容忍時是非致命的 videoerror（已經解出過 frame）。
    if (end.type === 'videoerror') expect(end).toMatchObject({ beforeFirstFrame: false });
    expect(driver.messages.filter((m) => m.type === 'error' || m.type === 'crash')).toEqual([]);
  });

  test('截斷的 MP4：影片解到資料結尾就結束，不回報致命錯誤', async () => {
    const { driver, media, video } = await open('broken/truncated.mp4');
    if (!video.supported) return;
    const [audio] = audioTracks(media);
    await driver.decode(audio?.streamIndex ?? null, { video: video.streamIndex });
    const { end, frames } = await driver.videoDone(1);
    // 最後一個封包可能只讀到一部分：decoder 以非致命的 videoerror 結束。
    if (end.type === 'videoerror') expect(end).toMatchObject({ beforeFirstFrame: false });
    expect(frames.length).toBeGreaterThan(60);
    expect(frames.length).toBeLessThan(200);
  });
});

describe('換影片軌（select）', () => {
  async function openMulti(deps: Omit<MediaWorkerDeps, 'postMessage'> = {}) {
    const opened = await open('video/multi-video.mkv', deps);
    const videos = opened.media.tracks.filter((t): t is ProbedVideoTrack => t.kind === 'video');
    const [h264, vp9, hevc] = videos;
    if (!h264 || !vp9 || !hevc) throw new Error('multi-video.mkv 應該有三條影片軌');
    const audio = audioTracks(opened.media)[0]?.streamIndex ?? null;
    return { ...opened, h264, vp9, hevc, audio };
  }

  test('multi-video.mkv 的軌道組成', async () => {
    const { h264, vp9, hevc } = await openMulti();
    expect(h264).toMatchObject({ codec: 'h264', default: true, title: 'H.264 320x180' });
    expect(vp9).toMatchObject({ codec: 'vp9', default: false, codedWidth: 640, codedHeight: 360 });
    expect(hevc).toMatchObject({ codec: 'hevc', supported: false, unsupportedReason: 'platform' });
  });

  test('關閉舊軌的 decoder、為新軌建立新的，從落點之前的 keyframe 解碼；新 epoch 只有新軌的 frame', async () => {
    const recording = recordingDecoders();
    const { driver, h264, vp9, audio } = await openMulti(recording);
    if (!h264.supported || !vp9.supported) return;
    await driver.decode(audio, { video: h264.streamIndex, frames: 48_000 });
    await driver.waitFor((m) => m.type === 'frame');
    driver.post({
      type: 'select',
      epoch: 2,
      time: 3.25,
      audio,
      video: vp9.streamIndex,
      subtitle: null,
    });
    const pcm = await driver.collect(2);
    const { end, frames } = await driver.videoDone(2);
    expect(end.type).toBe('videoend');
    expect(pcm.time).toBe(3.25);
    expect(Math.abs(pcm.left.length / 48_000 - 6.75)).toBeLessThan(0.05);
    expect(frames[0]?.time).toBeCloseTo(3.233, 2);
    expect(frames).toHaveLength(300 - 97);
    for (const frame of frames)
      expect(frame).toMatchObject({ visibleWidth: 640, visibleHeight: 360 });
    expect(recording.decoders).toHaveLength(2);
    expect(recording.decoders[0]?.state).toBe('closed');
    // 之後的 seek 沿用新的影片軌。
    await driver.seek(8, 3);
    const after = await driver.videoDone(3);
    expect(after.frames[0]).toMatchObject({ visibleWidth: 640 });
    expect(recording.decoders).toHaveLength(2);
    const stats = await driver.stats();
    expect(stats.openVideoFrames).toBe(0);
    expect(stats.video?.decoded).toBeGreaterThan(300 - 97);
  });

  test('video: null：關閉 decoder、不再送出 frame，音訊照常', async () => {
    const recording = recordingDecoders();
    const { driver, h264, audio } = await openMulti(recording);
    if (!h264.supported) return;
    await driver.decode(audio, { video: h264.streamIndex, frames: 48_000 });
    driver.post({ type: 'select', epoch: 2, time: 1, audio, video: null, subtitle: null });
    const pcm = await driver.collect(2);
    expect(pcm.time).toBe(1);
    expect(Math.abs(pcm.left.length / 48_000 - 9)).toBeLessThan(0.05);
    expect(driver.frames.filter((f) => f.epoch === 2)).toEqual([]);
    expect(recording.decoders[0]?.state).toBe('closed');
    expect((await driver.stats()).video).toBeNull();
  });

  test('新軌 configure 失敗：videoerror（beforeFirstFrame），換回原本的軌之後照常解碼', async () => {
    let created = 0;
    const { driver, h264, vp9, audio } = await openMulti({
      createVideoDecoder: (init) => {
        const decoder = createWebVideoDecoder(init);
        // 第二個 decoder（新軌）configure 失敗。
        if (++created !== 2) return decoder;
        return {
          get state() {
            return decoder.state;
          },
          get decodeQueueSize() {
            return decoder.decodeQueueSize;
          },
          ondequeue: null,
          configure: () => {
            decoder.configure({ codec: 'not-a-codec', codedWidth: 320, codedHeight: 180 });
          },
          decode: () => undefined,
          flush: () => decoder.flush(),
          reset: () => {
            decoder.reset();
          },
          close: () => {
            decoder.close();
          },
        };
      },
    });
    if (!h264.supported || !vp9.supported) return;
    await driver.decode(audio, { video: h264.streamIndex, frames: 48_000 });
    driver.post({
      type: 'select',
      epoch: 2,
      time: 1,
      audio,
      video: vp9.streamIndex,
      subtitle: null,
    });
    const { end } = await driver.videoDone(2);
    expect(end).toMatchObject({
      type: 'videoerror',
      beforeFirstFrame: true,
      error: { code: 'CODEC_UNSUPPORTED' },
    });
    driver.post({
      type: 'select',
      epoch: 3,
      time: 1,
      audio,
      video: h264.streamIndex,
      subtitle: null,
    });
    const pcm = await driver.collect(3);
    const { frames } = await driver.videoDone(3);
    expect(pcm.time).toBe(1);
    expect(frames[0]).toMatchObject({ time: 1, visibleWidth: 320 });
    expect(frames).toHaveLength(270);
    expect(driver.messages.filter((m) => m.type === 'error' || m.type === 'crash')).toEqual([]);
  });
});

/**
 * 記下建立的每個 decoder（真實的 WebCodecs）；`corrupt` 為 true 的 chunk 只送前一半的 bytes 進去（壞掉的影片封包：
 * length prefix 比資料長）。
 */
function recordingDecoders(corrupt: (chunk: VideoChunk) => boolean = () => false) {
  const decoders: VideoDecoderLike[] = [];
  const createVideoDecoder = (init: VideoDecoderInit<VideoFrame>): VideoDecoderLike => {
    const inner = createWebVideoDecoder(init);
    const decoder: VideoDecoderLike = {
      get state() {
        return inner.state;
      },
      get decodeQueueSize() {
        return inner.decodeQueueSize;
      },
      get ondequeue() {
        return inner.ondequeue;
      },
      set ondequeue(handler) {
        inner.ondequeue = handler;
      },
      configure: (config) => {
        inner.configure(config);
      },
      decode: (chunk) => {
        inner.decode(
          corrupt(chunk) ? { ...chunk, data: chunk.data.slice(0, chunk.data.length >> 1) } : chunk,
        );
      },
      flush: () => inner.flush(),
      reset: () => {
        inner.reset();
      },
      close: () => {
        inner.close();
      },
    };
    decoders.push(decoder);
    return decoder;
  };
  return { decoders, createVideoDecoder };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('影片的降級', () => {
  test('播放中壞掉的 keyframe：重新設定 decoder，從下一個 keyframe 繼續', async () => {
    // 3 秒的 keyframe 壞掉：3–4 秒的 GOP 解不出來，之後照常。
    const recording = recordingDecoders((chunk) => chunk.timestamp === 3_000_000);
    const { driver, media, video } = await open('video/h264-aac.mp4', recording);
    if (!video.supported) return;
    const [audio] = audioTracks(media);
    await driver.decode(audio?.streamIndex ?? null, { video: video.streamIndex });
    const { end, frames } = await driver.videoDone(1);
    expect(end.type).toBe('videoend');
    expect(recording.decoders).toHaveLength(2);
    const times = frames.map((f) => Math.round(f.time * 30));
    // decoder 失敗時還在它內部（B-frame 的重排）沒有輸出的 frame 一起丟掉。
    expect(times.filter((t) => t < 90).length).toBeGreaterThanOrEqual(80);
    expect(times.filter((t) => t >= 90 && t < 120)).toEqual([]);
    expect(times.filter((t) => t >= 120)).toHaveLength(180);
  });

  test('重新設定之後仍然失敗：放棄影片軌（DECODE_FAILED，非致命），音訊照常播完，之後的 seek 也不解碼影片', async () => {
    // 3 秒之後的封包都是壞的。
    const recording = recordingDecoders((chunk) => chunk.timestamp >= 3_000_000);
    const { driver, media, video } = await open('video/h264-aac.mp4', recording);
    if (!video.supported) return;
    const [audio] = audioTracks(media);
    const pcm = await driver.decode(audio?.streamIndex ?? null, { video: video.streamIndex });
    const { end, frames } = await driver.videoDone(1);
    expect(end).toMatchObject({
      type: 'videoerror',
      beforeFirstFrame: false,
      error: { code: 'DECODE_FAILED', fatal: false },
    });
    expect(recording.decoders).toHaveLength(2);
    expect(frames.length).toBeGreaterThanOrEqual(85);
    expect(frames.length).toBeLessThanOrEqual(92);
    expect(Math.abs(pcm.left.length / 48_000 - 10)).toBeLessThan(0.05);
    expect(driver.messages.filter((m) => m.type === 'error' || m.type === 'crash')).toEqual([]);

    await driver.seek(1, 2);
    await sleep(200);
    expect(driver.frames.filter((f) => f.epoch === 2)).toEqual([]);
    expect(recording.decoders).toHaveLength(2);
  });

  test('背景：關閉 decoder、不再送出 frame，音訊照常；影片的封包不隨播放累積', async () => {
    const recording = recordingDecoders();
    const { driver, media, video } = await open('video/multi-track.mkv', recording);
    if (!video.supported) return;
    const [audio] = audioTracks(media);
    await driver.decode(audio?.streamIndex ?? null, { video: video.streamIndex, frames: 48_000 });
    await driver.waitFor((m) => m.type === 'frame');
    driver.post({ type: 'videosuspend', suspended: true, time: 0 });
    expect(recording.decoders[0]?.state).toBe('closed');
    await sleep(50);
    const received = driver.frames.length;

    // 音訊播到 15 秒：影片的封包只留播放位置附近的（沒有修正時會從背景開始的位置一路累積到 17 秒）。
    await driver.collect(1, 14 * 48_000);
    const stats = await driver.stats();
    expect(stats.packetQueue.videoSeconds).toBeLessThan(6);
    expect(stats.openVideoFrames).toBe(0);
    expect(driver.frames).toHaveLength(received);
    expect(recording.decoders).toHaveLength(1);

    const rest = await driver.collect(1);
    expect(rest.left.length / 48_000).toBeGreaterThan(4.5);
    expect(driver.messages.filter((m) => m.type === 'error' || m.type === 'crash')).toEqual([]);
  });

  test('回到前景：建立新的 decoder，從恢復位置之前的 keyframe 解碼，第一張送出的是恢復位置的 frame', async () => {
    const recording = recordingDecoders();
    const { driver, media, video } = await open('video/h264-aac.mp4', recording);
    if (!video.supported) return;
    const [audio] = audioTracks(media);
    // 背景中 load：一開始就不解碼影片。
    driver.post({ type: 'videosuspend', suspended: true, time: 0 });
    await driver.decode(audio?.streamIndex ?? null, {
      video: video.streamIndex,
      frames: 6 * 48_000,
    });
    expect(recording.decoders).toHaveLength(0);
    expect(driver.frames).toEqual([]);

    driver.post({ type: 'videosuspend', suspended: false, time: 4.5 });
    await driver.collect(1);
    const { end, frames } = await driver.videoDone(1);
    expect(end.type).toBe('videoend');
    expect(recording.decoders).toHaveLength(1);
    expect(frames[0]?.time).toBeCloseTo(4.5, 3);
    expect(frames).toHaveLength(300 - 135);
  });
});

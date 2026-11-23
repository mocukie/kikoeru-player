// 影片的繪製與同步（#50）：VideoFrame 的接收、依音訊時鐘挑選、videoSize／videoresize、load 與 seek 等第一張 frame、
// 影片軌在 configure 或首個 keyframe 失敗時只播音訊，以及每張 frame 都 close。以假 media Worker 驅動 createEngineWith()。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeDeps, type FakeEngineDeps } from '../../test/fakes/engine-deps.js';
import type { FakeMediaWorker } from '../../test/fakes/media-worker.js';
import { closedCount, frame, videoMedia, videoOnlyMedia } from '../../test/fakes/video.js';
import type { ProbedMedia } from '../protocol/index.js';
import { createEngineWith } from './engine.js';
import type { Engine, Source, VideoSize } from './types.js';

const source: Source = { kind: 'http', url: 'https://example.test/a.mp4' };

async function startLoad(
  options: { paused?: boolean } = {},
  media: ProbedMedia = videoMedia(),
): Promise<{
  engine: Engine;
  deps: FakeEngineDeps;
  worker: FakeMediaWorker;
  loading: Promise<unknown>;
}> {
  const deps = createFakeDeps();
  const engine = createEngineWith(deps);
  const loading = engine.load(source, options);
  const worker = deps.workers.last;
  await worker.probe(media);
  await worker.next('start');
  return { engine, deps, worker, loading };
}

async function loaded(options: { paused?: boolean } = {}) {
  const t = await startLoad(options);
  frame(t.worker, 0);
  t.deps.audio.reply({ type: options.paused === false ? 'playing' : 'paused' });
  await t.loading;
  return t;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('load', () => {
  it('start 帶選用影片軌的 stream index', async () => {
    const { worker } = await startLoad();
    expect(worker.messages('start')[0]).toMatchObject({ audio: 0, video: 1 });
  });

  it('音訊備妥之後還要等第一張 frame 才完成，videoSize 與 videoresize 隨第一張 frame 出現', async () => {
    const { engine, deps, worker, loading } = await startLoad();
    const sizes: (VideoSize | null)[] = [];
    engine.addEventListener('videoresize', (e) => sizes.push(e.size));
    deps.audio.reply({ type: 'paused' });
    await settle();
    expect(engine.state).toBe('loading');
    expect(engine.videoSize).toBeNull();

    frame(worker, 0);
    await loading;
    expect(engine.state).toBe('ready');
    expect(engine.videoSize).toEqual({ width: 320, height: 180, rotation: 0 });
    expect(sizes).toEqual([{ width: 320, height: 180, rotation: 0 }]);
  });

  it('paused: false：第一張 frame 之前 worklet 停在 pause，之後才 play', async () => {
    const { deps, worker, loading } = await startLoad({ paused: false });
    deps.audio.reply({ type: 'paused' });
    await settle();
    const lastIntent = () =>
      deps.audio.received.filter((m) => m.type === 'play' || m.type === 'pause').at(-1)?.type;
    expect(lastIntent()).toBe('pause');

    frame(worker, 0);
    expect(lastIntent()).toBe('play');
    deps.audio.reply({ type: 'playing' });
    await loading;
  });

  it('configure 或首個 keyframe 失敗：影片軌改為不支援（platform），只播音訊', async () => {
    const { engine, deps, worker, loading } = await startLoad();
    const start = await worker.next('start');
    worker.reply({
      type: 'videoerror',
      epoch: start.epoch,
      beforeFirstFrame: true,
      error: { code: 'CODEC_UNSUPPORTED', fatal: false, message: 'configure 失敗' },
    });
    deps.audio.reply({ type: 'paused' });
    await loading;
    const track = engine.tracks.find((t) => t.kind === 'video');
    expect(track).toMatchObject({ supported: false, unsupportedReason: 'platform' });
    expect(engine.selectedTracks.video).toBeNull();
    expect(engine.state).toBe('ready');
    expect(engine.videoSize).toBeNull();
    expect((await statsOf(engine, worker)).video).toBeNull();
  });

  it('唯一可播的影片軌 configure 失敗、沒有其他可播的軌：load() reject CODEC_UNSUPPORTED，state 進入 error', async () => {
    const { engine, deps, worker, loading } = await startLoad({}, videoOnlyMedia());
    const result = loading.catch((e: unknown) => e);
    const start = await worker.next('start');
    worker.reply({
      type: 'videoerror',
      epoch: start.epoch,
      beforeFirstFrame: true,
      error: { code: 'CODEC_UNSUPPORTED', fatal: false, message: 'configure 失敗' },
    });
    deps.audio.reply({ type: 'paused' });
    expect(await result).toMatchObject({ name: 'EngineError', code: 'CODEC_UNSUPPORTED' });
    expect(engine.state).toBe('error');
    expect(engine.error).toMatchObject({ code: 'CODEC_UNSUPPORTED', fatal: true });
    expect(worker.terminated).toBe(true);
  });

  it('影片軌不支援（probe 時）：不選用，start 不帶影片軌', async () => {
    const { engine, deps, worker, loading } = await startLoad(
      {},
      videoMedia({ supported: false, unsupportedReason: 'platform' }),
    );
    expect(worker.messages('start')[0]).toMatchObject({ video: null });
    deps.audio.reply({ type: 'paused' });
    await loading;
    expect(engine.selectedTracks.video).toBeNull();
  });

  it('影片的第一張 frame 一直沒來：音訊備妥 2 秒後不再等', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, deps, loading } = await startLoad();
    deps.audio.reply({ type: 'paused' });
    await vi.advanceTimersByTimeAsync(1900);
    expect(engine.state).toBe('loading');
    await vi.advanceTimersByTimeAsync(200);
    await loading;
    expect(engine.state).toBe('ready');
  });
});

describe('繪製與同步', () => {
  it('依 currentTime 挑選 frame：被跳過的 close 並計入 dropped，close 後告訴 Worker', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, deps, worker } = await loaded({ paused: false });
    deps.audio.reply({ type: 'clock', position: 0, frame: 0, buffered: 0, underruns: 0 });
    deps.audio.frameNow = 0;
    const frames = [1 / 30, 2 / 30, 3 / 30].map((t) => frame(worker, t));
    deps.audio.frameNow = 48_000 * (3 / 30);
    expect(engine.currentTime).toBeCloseTo(0.1, 6);
    await vi.advanceTimersByTimeAsync(50);
    expect(frames.map((f) => f.closed)).toEqual([true, true, false]);
    // 第一張（0 秒）也在畫面換掉時 close。
    expect(closedCount(worker)).toBe(3);
    const stats = await statsOf(engine, worker, { decoded: 4, decodeQueueSize: 2, avgDecodeMs: 3 });
    expect(stats.video).toEqual({ decoded: 4, dropped: 2, decodeQueueSize: 2, avgDecodeMs: 3 });
  });

  it('seek：seeking 直到新 epoch 的第一張 frame；舊 epoch 的 frame close', async () => {
    const { engine, deps, worker } = await loaded();
    const queued = frame(worker, 1 / 30);
    const seeking = engine.seek(5);
    const seek = await worker.next('seek');
    expect(queued.closed).toBe(true);
    const stale = frame(worker, 2 / 30, seek.epoch - 1);
    expect(stale.closed).toBe(true);

    deps.audio.reply({ type: 'paused' });
    await settle();
    expect(engine.state).toBe('seeking');
    frame(worker, 5, seek.epoch);
    expect(await seeking).toBe(5);
    expect(engine.state).toBe('ready');
  });

  it('videoend（例如 seek 到最後一張之後）也算備妥', async () => {
    const { engine, deps, worker } = await loaded();
    const seeking = engine.seek(9.99);
    const seek = await worker.next('seek');
    deps.audio.reply({ type: 'paused' });
    worker.reply({ type: 'videoend', epoch: seek.epoch });
    await seeking;
    expect(engine.state).toBe('ready');
  });

  it('attachCanvas(null) 不丟錯；沒有 canvas 時照樣消耗 frame', async () => {
    const { engine, worker } = await loaded();
    engine.attachCanvas(null);
    const first = worker.received.length;
    expect(() => {
      engine.attachCanvas(null);
    }).not.toThrow();
    expect(worker.received.length).toBe(first);
  });
});

describe('競態', () => {
  it('等第一張 frame 時 destroy：load 以 AbortError reject，之後的 frame close', async () => {
    const { engine, deps, worker, loading } = await startLoad();
    deps.audio.reply({ type: 'paused' });
    const rejected = loading.catch((error: unknown) => error);
    await engine.destroy();
    expect(await rejected).toMatchObject({ name: 'AbortError' });
    expect(frame(worker, 0).closed).toBe(true);
    expect((await engine.getStats()).resources.openVideoFrames).toBe(0);
  });

  it('等第一張 frame 時 Worker 崩潰：load 以 INTERNAL reject，已收到的 frame close', async () => {
    const { engine, worker, loading } = await startLoad();
    const queued = frame(worker, 0.5);
    const rejected = loading.catch((error: unknown) => error);
    worker.crash();
    expect(await rejected).toMatchObject({ code: 'INTERNAL' });
    expect(queued.closed).toBe(true);
    expect(engine.state).toBe('error');
    expect(engine.videoSize).toBeNull();
  });

  it('等 seek 的第一張 frame 時再 seek：前一個 seek 被取代，等的是新 epoch 的 frame', async () => {
    const { engine, deps, worker } = await loaded();
    const first = engine.seek(3).catch((error: unknown) => error);
    const firstSeek = await worker.next('seek');
    const second = engine.seek(6);
    const secondSeek = await worker.next('seek', 2);
    expect(await first).toMatchObject({ name: 'AbortError' });
    deps.audio.reply({ type: 'paused' });
    frame(worker, 3, firstSeek.epoch);
    await settle();
    expect(engine.state).toBe('seeking');
    frame(worker, 6, secondSeek.epoch);
    expect(await second).toBe(6);
  });

  it('videoresize 的 listener 內 seek：第一張 frame 不會讓新的 seek 提早完成', async () => {
    const { engine, deps, worker, loading } = await startLoad();
    deps.audio.reply({ type: 'paused' });
    let seeking = null as Promise<number> | null;
    engine.addEventListener(
      'videoresize',
      () => {
        seeking = engine.seek(4);
      },
      { once: true },
    );
    frame(worker, 0);
    const seek = await worker.next('seek');
    await settle();
    // loading 期間的 seek 改寫起點，與 load 一起等新 epoch 的第一張 frame。
    expect(engine.state).toBe('loading');
    deps.audio.reply({ type: 'paused' });
    await settle();
    expect(engine.state).toBe('loading');
    frame(worker, 4, seek.epoch);
    await loading;
    expect(await seeking).toBe(4);
    expect(engine.state).toBe('ready');
  });
});

describe('VideoFrame 的 close', () => {
  it('destroy：佇列中與畫面上的 frame 都 close，openVideoFrames 為 0', async () => {
    const { engine, worker } = await loaded();
    const frames = [0.5, 1].map((t) => frame(worker, t));
    await engine.destroy();
    expect(frames.every((f) => f.closed)).toBe(true);
    expect((await engine.getStats()).resources.openVideoFrames).toBe(0);
  });

  it('openVideoFrames 合計主執行緒與 Worker 的', async () => {
    const { engine, worker } = await loaded();
    [0.5, 1].map((t) => frame(worker, t));
    const stats = await statsOf(engine, worker, undefined, 1);
    // 畫面上 1 張、佇列 2 張，加上 Worker 內 1 張。
    expect(stats.resources.openVideoFrames).toBe(4);
  });

  it('被 terminate 的 Worker 之後送來的 frame 立即 close', async () => {
    const { engine, deps, worker } = await loaded();
    void engine.load(source).catch(() => undefined);
    await deps.workers.last.next('load');
    const late = frame(worker, 1);
    expect(late.closed).toBe(true);
  });

  it('新的 load：上一份媒體的 frame close，videoSize 回到 null', async () => {
    const { engine, deps, worker } = await loaded();
    const shown = (await statsOf(engine, worker)).resources.openVideoFrames;
    expect(shown).toBe(1);
    const sizes: (VideoSize | null)[] = [];
    engine.addEventListener('videoresize', (e) => sizes.push(e.size));
    void engine.load(source).catch(() => undefined);
    await deps.workers.last.next('load');
    expect(engine.videoSize).toBeNull();
    expect(sizes).toEqual([null]);
  });
});

/** 取 getStats()，並以 `video`／`openVideoFrames` 回覆 Worker 的部分。 */
async function statsOf(
  engine: Engine,
  worker: FakeMediaWorker,
  video: { decoded: number; decodeQueueSize: number; avgDecodeMs: number } | null = null,
  openVideoFrames = 0,
) {
  const stats = engine.getStats();
  await worker.stats(1, { video, openVideoFrames });
  return stats;
}

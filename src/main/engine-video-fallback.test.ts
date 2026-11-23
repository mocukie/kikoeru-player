// 影片的降級（#51）：背景（`suspendVideoWhenHidden`）時暫停影片解碼、回到前景時重新同步，播放中解碼失敗時退回只播
// 音訊，以及純影片的媒體回到前景。以假 media Worker 與可控制的頁面可見性驅動 createEngineWith()。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeDeps, type FakeEngineDeps } from '../../test/fakes/engine-deps.js';
import type { FakeMediaWorker } from '../../test/fakes/media-worker.js';
import { closedCount, frame, videoMedia, videoOnlyMedia } from '../../test/fakes/video.js';
import type { ProbedMedia } from '../protocol/index.js';
import { createEngineWith } from './engine.js';
import type { Engine, EngineOptions, Source, VideoSize } from './types.js';

const source: Source = { kind: 'http', url: 'https://example.test/a.mp4' };

interface Setup {
  engine: Engine;
  deps: FakeEngineDeps;
  worker: FakeMediaWorker;
}

/** load 到 start 送出（還沒完成）；`hidden` 時從背景開始。 */
async function startLoad(
  options: {
    paused?: boolean;
    media?: ProbedMedia;
    engine?: EngineOptions;
    hidden?: boolean;
  } = {},
): Promise<Setup & { loading: Promise<unknown> }> {
  const deps = createFakeDeps();
  deps.visibility.hidden = options.hidden ?? false;
  const engine = createEngineWith(deps, options.engine);
  const loading = engine.load(source, { paused: options.paused ?? false });
  const worker = deps.workers.last;
  await worker.probe(options.media ?? videoMedia());
  await worker.next('start');
  return { engine, deps, worker, loading };
}

/** 播放中（load 完成、第一張 frame 已畫出，clock 在 `position`）。 */
async function playing(
  options: { media?: ProbedMedia; engine?: EngineOptions } = {},
  position = 1,
): Promise<Setup> {
  const t = await startLoad(options);
  if ((options.media ?? videoMedia()).tracks.some((track) => track.kind === 'video')) {
    frame(t.worker, 0);
  }
  t.deps.audio.reply({ type: 'playing' });
  await t.loading;
  clock(t.deps, position);
  return t;
}

/** worklet 回報 clock：此刻聽到的是 `position`。 */
function clock(deps: FakeEngineDeps, position: number): void {
  deps.audio.frameNow = Math.round(position * 48_000);
  deps.audio.reply({
    type: 'clock',
    position,
    frame: deps.audio.frameNow,
    buffered: 0,
    underruns: 0,
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('背景（suspendVideoWhenHidden）', () => {
  it('切到背景：Worker 收到 videosuspend，佇列中的 frame close，畫面上的留著；之後送來的 frame 立即 close', async () => {
    const { engine, deps, worker } = await playing();
    const queued = [1.1, 1.2].map((t) => frame(worker, t));
    deps.visibility.setHidden(true);
    expect(worker.messages('videosuspend')).toEqual([
      { type: 'videosuspend', suspended: true, time: expect.any(Number) as number },
    ]);
    expect(queued.every((f) => f.closed)).toBe(true);
    // 畫面上的那張（0 秒）留著。
    expect(engine.videoSize).toEqual({ width: 320, height: 180, rotation: 0 });
    const late = frame(worker, 1.3);
    expect(late.closed).toBe(true);
    expect(closedCount(worker)).toBe(3);
    expect(engine.state).toBe('playing');
  });

  it('回到前景：videosuspend false 帶此刻的 currentTime，之後的 frame 照常畫出', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, deps, worker } = await playing();
    deps.visibility.setHidden(true);
    clock(deps, 4);
    deps.visibility.setHidden(false);
    const resume = worker.messages('videosuspend').at(-1);
    expect(resume).toMatchObject({ suspended: false });
    expect(resume?.time).toBeCloseTo(4, 6);
    // 恢復之後的 frame（恢復位置那一張）照常畫出、取代畫面上的那張。
    const next = frame(worker, 4);
    await vi.advanceTimersByTimeAsync(50);
    expect(next.closed).toBe(false);
    expect(engine.state).toBe('playing');
    // 沒有新的 epoch：聲音不中斷。
    expect(worker.messages('seek')).toEqual([]);
  });

  it('可見性沒有改變時不重複送出；沒有選用影片軌時也告訴 Worker（之後的 load 沿用）', async () => {
    const { deps, worker } = await playing({ media: videoMedia({ supported: false }) });
    deps.visibility.setHidden(true);
    deps.visibility.setHidden(true);
    expect(worker.messages('videosuspend')).toHaveLength(1);
  });

  it('背景中 seek：不等影片的第一張 frame', async () => {
    const { engine, deps, worker } = await playing();
    deps.visibility.setHidden(true);
    const seeking = engine.seek(5);
    await worker.next('seek');
    deps.audio.reply({ type: 'playing' });
    expect(await seeking).toBe(5);
    expect(engine.state).toBe('playing');
  });

  it('背景中 load：start 之前送出 videosuspend，load 不等第一張 frame', async () => {
    const { engine, deps, worker, loading } = await startLoad({ hidden: true });
    const order = worker.received.map((m) => m.type);
    expect(order.indexOf('videosuspend')).toBeGreaterThan(-1);
    expect(order.indexOf('videosuspend')).toBeLessThan(order.indexOf('start'));
    deps.audio.reply({ type: 'playing' });
    await loading;
    expect(engine.state).toBe('playing');
    expect(engine.videoSize).toBeNull();
  });

  it('suspendVideoWhenHidden: false：不送 videosuspend，照常消耗 frame', async () => {
    const { deps, worker } = await playing({ engine: { suspendVideoWhenHidden: false } });
    deps.visibility.setHidden(true);
    expect(worker.messages('videosuspend')).toEqual([]);
    expect(deps.visibility.subscribers).toBe(0);
  });

  it('背景時 requestAnimationFrame 停住：繪製迴圈改由 timer 推進，frame 照常被消耗', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // rAF 永遠不觸發（背景分頁）。
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const { deps, worker } = await playing({ engine: { suspendVideoWhenHidden: false } });
    deps.visibility.setHidden(true);
    const frames = [1.1, 1.2, 1.3].map((t) => frame(worker, t));
    clock(deps, 1.35);
    await vi.advanceTimersByTimeAsync(500);
    // 1.3 秒的那張畫上，之前的 close。
    expect(frames.map((f) => f.closed)).toEqual([true, true, false]);
  });

  it('destroy 之後取消訂閱可見性', async () => {
    const { engine, deps } = await playing();
    expect(deps.visibility.subscribers).toBe(1);
    await engine.destroy();
    expect(deps.visibility.subscribers).toBe(0);
  });

  it('背景中 Worker 崩潰：進入 error，回到前景時不再送給被 terminate 的 Worker', async () => {
    const { engine, deps, worker } = await playing();
    deps.visibility.setHidden(true);
    worker.crash();
    expect(engine.state).toBe('error');
    deps.visibility.setHidden(false);
    expect(worker.messages('videosuspend')).toHaveLength(1);
  });

  it('純影片的媒體回到前景：從目前位置重新 seek（新的 epoch），state 維持 playing', async () => {
    const { engine, deps, worker } = await playing({ media: videoOnlyMedia() });
    expect(worker.messages('start')[0]).toMatchObject({ audio: null, video: 0 });
    deps.visibility.setHidden(true);
    clock(deps, 6);
    const states: string[] = [];
    engine.addEventListener('statechange', (e) => states.push(e.state));
    deps.visibility.setHidden(false);
    const seek = await worker.next('seek');
    expect(seek.time).toBeCloseTo(6, 6);
    const order = worker.received.map((m) => m.type);
    expect(order.lastIndexOf('videosuspend')).toBeLessThan(order.lastIndexOf('seek'));
    deps.audio.reply({ type: 'paused', epoch: seek.epoch });
    frame(worker, 6, seek.epoch);
    deps.audio.reply({ type: 'playing', epoch: seek.epoch });
    await settle();
    expect(engine.state).toBe('playing');
    expect(states).toEqual([]);
  });

  it('音軌比影片短、音訊已經送完（audioend）時回到前景：與純影片相同，從目前位置重新 seek', async () => {
    const { engine, deps, worker } = await playing();
    const [start] = worker.messages('start');
    deps.visibility.setHidden(true);
    worker.reply({ type: 'audioend', epoch: start?.epoch ?? NaN });
    clock(deps, 6);
    deps.visibility.setHidden(false);
    const seek = await worker.next('seek');
    expect(seek.time).toBeCloseTo(6, 6);
    deps.audio.reply({ type: 'paused', epoch: seek.epoch });
    frame(worker, 6, seek.epoch);
    deps.audio.reply({ type: 'playing', epoch: seek.epoch });
    await settle();
    expect(engine.state).toBe('playing');
  });

  it('過期 epoch 的 audioend 不算：回到前景時不重新 seek（聲音不中斷）', async () => {
    const { deps, worker, engine } = await playing();
    const [start] = worker.messages('start');
    const seeking = engine.seek(2);
    const seek = await worker.next('seek');
    worker.reply({ type: 'audioend', epoch: start?.epoch ?? NaN });
    frame(worker, 2, seek.epoch);
    deps.audio.reply({ type: 'playing', epoch: seek.epoch });
    await seeking;
    deps.visibility.setHidden(true);
    deps.visibility.setHidden(false);
    expect(worker.messages('seek')).toHaveLength(1);
  });
});

describe('播放中解碼失敗，退回只播音訊', () => {
  function decodeFailed(worker: FakeMediaWorker): void {
    const start = worker.messages('start')[0];
    worker.reply({
      type: 'videoerror',
      epoch: start?.epoch ?? 0,
      beforeFirstFrame: false,
      error: { code: 'DECODE_FAILED', fatal: false, message: '重新設定之後仍然失敗' },
    });
  }

  it('影片軌改為不支援、selectedTracks.video 為 null，發出 trackschange 與非致命的 DECODE_FAILED；state 不變', async () => {
    const { engine, worker } = await playing();
    const events: string[] = [];
    const sizes: (VideoSize | null)[] = [];
    engine.addEventListener('trackschange', (e) => {
      events.push(`trackschange video=${String(e.selected.video)}`);
    });
    engine.addEventListener('error', (e) => {
      events.push(`error ${e.error.code} fatal=${String(e.error.fatal)}`);
    });
    engine.addEventListener('videoresize', (e) => sizes.push(e.size));
    decodeFailed(worker);
    expect(events).toEqual(['trackschange video=null', 'error DECODE_FAILED fatal=false']);
    expect(engine.tracks.find((t) => t.kind === 'video')).toMatchObject({
      supported: false,
      unsupportedReason: 'platform',
    });
    expect(engine.selectedTracks.video).toBeNull();
    expect(engine.state).toBe('playing');
    expect(engine.error).toBeNull();
    expect(sizes).toEqual([null]);
    // 之後送來的 frame 立即 close。
    expect(frame(worker, 1.5).closed).toBe(true);
  });

  it('trackschange 的 listener 內 destroy：不再發出 error', async () => {
    const { engine, worker } = await playing();
    const errors: string[] = [];
    engine.addEventListener('trackschange', () => void engine.destroy());
    engine.addEventListener('error', (e) => errors.push(e.error.code));
    decodeFailed(worker);
    await settle();
    expect(errors).toEqual([]);
  });

  it('videoresize 的 listener 內 seek：降級照樣完成，仍發出 trackschange 與 error', async () => {
    const { engine, worker } = await playing();
    const events: string[] = [];
    engine.addEventListener('videoresize', () => void engine.seek(2).catch(() => undefined), {
      once: true,
    });
    engine.addEventListener('trackschange', () => events.push('trackschange'));
    engine.addEventListener('error', (e) => events.push(`error ${e.error.code}`));
    decodeFailed(worker);
    await settle();
    expect(events).toEqual(['trackschange', 'error DECODE_FAILED']);
    expect(engine.selectedTracks.video).toBeNull();
  });

  it('之後 seek 不再等影片', async () => {
    const { engine, deps, worker } = await playing();
    decodeFailed(worker);
    const seeking = engine.seek(3);
    await worker.next('seek');
    deps.audio.reply({ type: 'playing' });
    expect(await seeking).toBe(3);
  });

  it('trackschange 的 listener 內改選另一條影片軌：不會提前解除新軌的影片等待', async () => {
    const twoVideos: ProbedMedia = {
      ...videoMedia(),
      tracks: [
        ...videoMedia().tracks,
        {
          kind: 'video',
          streamIndex: 2,
          codec: 'vp9',
          codecString: 'vp09.00.20.08',
          supported: true,
          codedWidth: 640,
          codedHeight: 360,
          display: { width: 640, height: 360, rotation: 0 },
          default: false,
          forced: false,
        },
      ],
    };
    const { engine, deps, worker } = await playing({ media: twoVideos });
    const backup = engine.tracks.find((t) => t.kind === 'video' && t.streamIndex === 2);
    expect(backup).toBeDefined();
    const switching: Promise<void>[] = [];
    engine.addEventListener(
      'trackschange',
      () => {
        if (backup) switching.push(engine.selectTracks({ video: backup.id }));
      },
      { once: true },
    );
    decodeFailed(worker);
    const select = await worker.next('select');
    expect(select).toMatchObject({ video: 2 });
    // worklet 在新軌還沒收到 frame 之前應維持 pause（等待新軌首張 frame），不應被舊的 #onVideoReady() 提前送出 play。
    expect(
      deps.audio.received.findLast((m) => m.type === 'play' || m.type === 'pause'),
    ).toMatchObject({ type: 'pause' });
    frame(worker, 1, select.epoch);
    expect(deps.audio.received.at(-1)).toMatchObject({ type: 'play', epoch: select.epoch });
    deps.audio.reply({ type: 'playing', epoch: select.epoch });
    await switching[0];
    expect(engine.selectedTracks.video).toBe(backup?.id);
  });
});

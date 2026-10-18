// 純音訊播放的串接（#36）：currentTime 的內插、timeupdate、getStats() 的資源計數與 worklet 載入失敗。
// 以假 media Worker 與假音訊輸出驅動 createEngineWith()。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeDeps, type FakeEngineDeps } from '../../test/fakes/engine-deps.js';
import { audioMedia } from '../../test/fakes/media-worker.js';
import { AssetLoadError } from './deps.js';
import { createEngineWith } from './engine.js';
import type { TimeUpdateEvent } from './events.js';
import type { Engine, EngineOptions, Source } from './types.js';

const source: Source = { kind: 'http', url: 'https://example.test/a.flac' };
const SR = 48_000;

async function loaded(options: { paused?: boolean } = {}, engineOptions?: EngineOptions) {
  const deps = createFakeDeps();
  const engine = createEngineWith(deps, engineOptions);
  const loading = engine.load(source, options);
  const worker = deps.workers.last;
  await worker.probe(audioMedia({ duration: 10 }));
  await worker.next('start');
  deps.audio.reply({ type: options.paused === false ? 'playing' : 'paused' });
  await loading;
  return { engine, deps, worker };
}

/** worklet 的 clock：`position` 的 sample 在 context frame `frame` 進入 graph。 */
function clock(deps: FakeEngineDeps, position: number, frame: number, buffered = 0): void {
  deps.audio.reply({ type: 'clock', position, frame, buffered, underruns: 0 });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('預期 reject，卻 resolve 了');
    },
    (error: unknown) => error,
  );
}

describe('currentTime', () => {
  it('播放中依 clock 的 frame 與此刻聽到的 frame 內插', async () => {
    const { engine, deps } = await loaded({ paused: false });
    clock(deps, 2, 10 * SR);

    deps.audio.frameNow = 10 * SR + SR / 2;
    expect(engine.currentTime).toBeCloseTo(2.5, 9);
    deps.audio.frameNow = 10 * SR + (3 * SR) / 4;
    expect(engine.currentTime).toBeCloseTo(2.75, 9);
  });

  it('聽到的位置還在開始播放的位置之前（輸出延遲）時，停在開始播放的位置', async () => {
    const { engine, deps } = await loaded({ paused: false });
    void engine.seek(3);
    clock(deps, 3, 20 * SR);
    deps.audio.reply({ type: 'playing' });

    deps.audio.frameNow = 20 * SR - SR / 10;
    expect(engine.currentTime).toBe(3);
  });

  it('新的 clock 讓內插的結果變小時不倒退', async () => {
    const { engine, deps } = await loaded({ paused: false });
    clock(deps, 1, SR);
    deps.audio.frameNow = 1.5 * SR;
    expect(engine.currentTime).toBeCloseTo(1.5, 9);

    clock(deps, 1.6, 2 * SR);
    expect(engine.currentTime).toBeCloseTo(1.5, 9);
  });

  it('不超過 duration', async () => {
    const { engine, deps } = await loaded({ paused: false });
    clock(deps, 9.9, 0);
    deps.audio.frameNow = SR;
    expect(engine.currentTime).toBe(10);
  });

  it('暫停後停在 worklet 回報的位置', async () => {
    const { engine, deps } = await loaded({ paused: false });
    clock(deps, 4, 0);
    deps.audio.frameNow = SR / 10;
    void engine.pause();
    clock(deps, 4.2, SR / 5);
    deps.audio.reply({ type: 'paused' });

    deps.audio.frameNow = 10 * SR;
    expect(engine.state).toBe('paused');
    expect(engine.currentTime).toBe(4.2);
  });

  it('取不到聽到的 frame 時用 clock 的位置', async () => {
    const { engine, deps } = await loaded({ paused: false });
    clock(deps, 2, 10 * SR);
    deps.audio.frameNow = null;
    expect(engine.currentTime).toBe(2);
  });
});

describe('timeupdate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('播放中依 timeUpdateInterval 發出；位置沒變時不發', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { engine, deps } = await loaded({ paused: false }, { timeUpdateInterval: 100 });
    const times: number[] = [];
    engine.addEventListener('timeupdate', (event: TimeUpdateEvent) =>
      times.push(event.currentTime),
    );
    clock(deps, 0, 0);

    deps.audio.frameNow = SR / 10;
    vi.advanceTimersByTime(100);
    deps.audio.frameNow = SR / 5;
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);

    expect(times.map((t) => Math.round(t * 1000))).toEqual([100, 200]);
  });

  it('離開 playing 後不再發出', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { engine, deps } = await loaded({ paused: false }, { timeUpdateInterval: 100 });
    clock(deps, 0, 0);
    void engine.pause();
    clock(deps, 1, SR);
    deps.audio.reply({ type: 'paused' });
    const times: number[] = [];
    engine.addEventListener('timeupdate', (event: TimeUpdateEvent) =>
      times.push(event.currentTime),
    );

    deps.audio.frameNow = 5 * SR;
    vi.advanceTimersByTime(500);
    expect(times).toEqual([]);
  });
});

describe('getStats', () => {
  it('resources：換檔後 workers 為 1、libavInstances 取自 Worker；destroy 後全為 0', async () => {
    const { engine, deps, worker } = await loaded();
    const first = engine.getStats();
    await worker.stats(1);
    expect((await first).resources).toEqual({ workers: 1, libavInstances: 1, openVideoFrames: 0 });

    // destroy() 會以 AbortError 結束它。
    void engine.load(source).catch(() => undefined);
    const next = deps.workers.last;
    expect(next).not.toBe(worker);
    expect(worker.terminated).toBe(true);
    const second = engine.getStats();
    await next.stats(1);
    expect((await second).resources).toEqual({ workers: 1, libavInstances: 1, openVideoFrames: 0 });

    await engine.destroy();
    expect((await engine.getStats()).resources).toEqual({
      workers: 0,
      libavInstances: 0,
      openVideoFrames: 0,
    });
  });

  it('等待 Worker 回覆時 Worker 被 terminate：以 0 個 instance 回報', async () => {
    const { engine } = await loaded();
    const stats = engine.getStats();
    await engine.destroy();
    expect((await stats).resources).toEqual({ workers: 0, libavInstances: 0, openVideoFrames: 0 });
  });

  it('audio：ring 水位與 underrun 取自 clock，輸出延遲取自音訊輸出', async () => {
    const { engine, deps, worker } = await loaded({ paused: false });
    deps.audio.latency = 0.042;
    deps.audio.reply({ type: 'clock', position: 1, frame: 0, buffered: SR / 10, underruns: 2 });
    const stats = engine.getStats();
    await worker.stats(1);
    expect((await stats).audio).toEqual({
      ringMs: 100,
      underruns: 2,
      outputLatencyMs: 42,
      targetMs: 150,
    });
  });
});

describe('音訊輸出的錯誤', () => {
  it('worklet 載入失敗時 load 以 fatal 的 ASSET_LOAD_FAILED reject', async () => {
    const deps = createFakeDeps({
      onAudio: (audio) => (audio.connectError = new AssetLoadError('worklet 載入失敗')),
    });
    const engine: Engine = createEngineWith(deps);
    expect(await rejection(engine.load(source))).toMatchObject({
      name: 'EngineError',
      code: 'ASSET_LOAD_FAILED',
      fatal: true,
    });
    expect(engine.state).toBe('error');
  });

  it('其他的 connect 失敗是 AUDIO_OUTPUT', async () => {
    const deps = createFakeDeps({
      onAudio: (audio) => (audio.connectError = new Error('AudioWorkletNode 建立失敗')),
    });
    const engine = createEngineWith(deps);
    expect(await rejection(engine.load(source))).toMatchObject({
      code: 'AUDIO_OUTPUT',
      fatal: true,
    });
  });
});

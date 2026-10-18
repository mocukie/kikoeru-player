// 音量、靜音、淡入淡出的設定與輸出延遲（#42）：以假 media Worker 與假音訊輸出驅動 createEngineWith()。

import { describe, expect, it } from 'vitest';
import { createFakeDeps, type FakeEngineDeps } from '../../test/fakes/engine-deps.js';
import { audioMedia } from '../../test/fakes/media-worker.js';
import { createEngineWith } from './engine.js';
import type { EngineOptions, Source } from './types.js';

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

function clock(deps: FakeEngineDeps, position: number, frame: number): void {
  deps.audio.reply({ type: 'clock', position, frame, buffered: 0, underruns: 0 });
}

describe('volume 與 muted', () => {
  it('預設 volume 1、muted false；音訊輸出建立時直接套用（不 ramp）', async () => {
    const { engine, deps } = await loaded();
    expect(engine.volume).toBe(1);
    expect(engine.muted).toBe(false);
    expect(deps.audio.gains).toEqual([{ gain: 1, smooth: false }]);
  });

  it('改 volume 與 muted 時平滑地套用 gain；muted 時 gain 為 0，取消後回到 volume', async () => {
    const { engine, deps } = await loaded();
    engine.volume = 0.5;
    engine.muted = true;
    expect(engine.muted).toBe(true);
    engine.volume = 0.25;
    expect(engine.volume).toBe(0.25);
    engine.muted = false;
    expect(deps.audio.gains.slice(1)).toEqual([
      { gain: 0.5, smooth: true },
      { gain: 0, smooth: true },
      { gain: 0, smooth: true },
      { gain: 0.25, smooth: true },
    ]);
  });

  it('還沒有音訊輸出時設定的值，在建立時套用', () => {
    const deps = createFakeDeps();
    const engine = createEngineWith(deps);
    engine.volume = 0.3;
    engine.muted = true;
    engine.unlockAudio();
    expect(deps.audio.gains).toEqual([{ gain: 0, smooth: false }]);
    engine.muted = false;
    expect(deps.audio.gains.at(-1)).toEqual({ gain: 0.3, smooth: true });
  });

  it('volume 超出 0–1 或不是有限數時丟 RangeError，值不變', async () => {
    const { engine } = await loaded();
    engine.volume = 0.4;
    for (const value of [-0.01, 1.01, NaN, Infinity]) {
      expect(() => (engine.volume = value)).toThrow(RangeError);
    }
    expect(engine.volume).toBe(0.4);
  });

  it('muted 不影響音訊時鐘：worklet 不會收到任何訊息', async () => {
    const { engine, deps } = await loaded({ paused: false });
    const before = deps.audio.received.length;
    engine.muted = true;
    engine.volume = 0;
    expect(deps.audio.received.length).toBe(before);
    expect(engine.state).toBe('playing');
  });
});

describe('audioFadeMs', () => {
  it('以 processorOptions 交給 worklet（預設 10）', async () => {
    expect((await loaded()).deps.audio.config.audioFadeMs).toBe(10);
    expect((await loaded({}, { audioFadeMs: 0 })).deps.audio.config.audioFadeMs).toBe(0);
  });

  it('pause() 時 worklet 淡出（不帶 immediate）；AudioContext 沒有在跑時要求立即停止', async () => {
    const { engine, deps } = await loaded({ paused: false });
    engine.pause().catch(() => undefined);
    expect(deps.audio.received.at(-1)).toEqual({ type: 'pause', epoch: deps.audio.epoch });

    deps.audio.reply({ type: 'paused' });
    void engine.play();
    deps.audio.reply({ type: 'playing' });
    // 外部 suspend：context 不再 render，淡出不會結束。
    deps.audio.emitState('suspended');
    expect(deps.audio.received.at(-1)).toEqual({
      type: 'pause',
      epoch: deps.audio.epoch,
      immediate: true,
    });
  });
});

describe('currentTime 與輸出延遲', () => {
  it('暫停後，聽到的位置還沒到停住的位置時繼續內插，之後停在那裡', async () => {
    const { engine, deps } = await loaded({ paused: false });
    clock(deps, 4, 0);
    deps.audio.frameNow = SR / 10;
    expect(engine.currentTime).toBeCloseTo(4.1, 9);
    void engine.pause();
    // 淡出結束：4.2 的 sample 在 frame SR/5 進入 graph，輸出延遲 50 ms。
    clock(deps, 4.2, SR / 5);
    deps.audio.reply({ type: 'paused' });
    expect(engine.state).toBe('paused');

    deps.audio.frameNow = SR / 5 - SR / 20;
    expect(engine.currentTime).toBeCloseTo(4.15, 9);
    deps.audio.frameNow = SR;
    expect(engine.currentTime).toBe(4.2);
  });

  it('buffering 時同樣內插到 ring 用完的位置，恢復後從那裡接續', async () => {
    const { engine, deps } = await loaded({ paused: false });
    clock(deps, 1, 0);
    clock(deps, 1.5, SR / 2);
    deps.audio.reply({ type: 'starved' });
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(engine.state).toBe('buffering');
    deps.audio.frameNow = SR / 2 - SR / 10;
    expect(engine.currentTime).toBeCloseTo(1.4, 9);

    deps.audio.frameNow = SR;
    expect(engine.currentTime).toBe(1.5);
    clock(deps, 1.5, 2 * SR);
    deps.audio.reply({ type: 'playing' });
    deps.audio.frameNow = 2 * SR + SR / 10;
    expect(engine.currentTime).toBeCloseTo(1.6, 9);
  });

  it('暫停中 seek：currentTime 從落點算起，不受之前聽到的位置影響', async () => {
    const { engine, deps, worker } = await loaded({ paused: false });
    clock(deps, 4, 0);
    deps.audio.frameNow = SR / 10;
    expect(engine.currentTime).toBeCloseTo(4.1, 9);
    void engine.pause();
    clock(deps, 4.2, SR / 5);
    deps.audio.reply({ type: 'paused' });

    const seeking = engine.seek(1);
    await worker.next('seek');
    clock(deps, 1, SR / 2);
    deps.audio.reply({ type: 'paused' });
    await seeking;
    expect(engine.state).toBe('paused');
    deps.audio.frameNow = SR / 4;
    expect(engine.currentTime).toBe(1);
  });
});

// 不變調的播放速度（#43）：以假 media Worker 與假音訊輸出驅動 createEngineWith()。

import { describe, expect, it } from 'vitest';
import { createFakeDeps, type FakeEngineDeps } from '../../test/fakes/engine-deps.js';
import { audioMedia } from '../../test/fakes/media-worker.js';
import { createEngineWith } from './engine.js';
import type { Source } from './types.js';

const source: Source = { kind: 'http', url: 'https://example.test/a.flac' };
const SR = 48_000;

async function loaded(options: { paused?: boolean } = {}, deps = createFakeDeps()) {
  const engine = createEngineWith(deps);
  const loading = engine.load(source, options);
  const worker = deps.workers.last;
  await worker.probe(audioMedia({ duration: 10 }));
  await worker.next('start');
  deps.audio.reply({ type: options.paused === false ? 'playing' : 'paused' });
  await loading;
  return { engine, deps, worker };
}

function clock(deps: FakeEngineDeps, position: number, frame: number, rate: number): void {
  deps.audio.reply({ type: 'clock', position, frame, rate, buffered: 0, underruns: 0 });
}

describe('playbackRate', () => {
  it('預設 1；改變時告訴 Worker 與 worklet，不遞增 epoch（worklet 不會收到 flush）', async () => {
    const { engine, deps, worker } = await loaded({ paused: false });
    expect(engine.playbackRate).toBe(1);
    const flushes = deps.audio.received.filter((m) => m.type === 'flush').length;
    engine.playbackRate = 1.25;
    expect(engine.playbackRate).toBe(1.25);
    expect(worker.messages('rate')).toEqual([{ type: 'rate', rate: 1.25 }]);
    expect(deps.audio.received.filter((m) => m.type === 'rate').at(-1)).toEqual({
      type: 'rate',
      rate: 1.25,
    });
    expect(deps.audio.received.filter((m) => m.type === 'flush')).toHaveLength(flushes);
    expect(engine.state).toBe('playing');
  });

  it('不是 0.5–2 之間的數時丟 RangeError，值不變，也不送出訊息', async () => {
    const { engine, worker } = await loaded();
    engine.playbackRate = 0.75;
    for (const value of [0.49, 2.01, NaN, Infinity, -1]) {
      expect(() => (engine.playbackRate = value)).toThrow(RangeError);
    }
    expect(engine.playbackRate).toBe(0.75);
    expect(worker.messages('rate')).toHaveLength(1);
  });

  it('沒有媒體時也可以設定；之後的 load 與 reload 在 init 帶上目前的速度，新的音訊輸出也收到它', async () => {
    const deps = createFakeDeps();
    const engine = createEngineWith(deps);
    engine.playbackRate = 1.5;
    const loading = engine.load(source);
    const worker = deps.workers.last;
    expect((await worker.next('init')).rate).toBe(1.5);
    expect(deps.audio.received.filter((m) => m.type === 'rate')).toEqual([
      { type: 'rate', rate: 1.5 },
    ]);
    await worker.probe(audioMedia());
    await worker.next('start');
    deps.audio.reply({ type: 'paused' });
    await loading;

    engine.playbackRate = 0.5;
    const reloading = engine.reload();
    const next = deps.workers.last;
    expect(next).not.toBe(worker);
    expect((await next.next('init')).rate).toBe(0.5);
    await next.probe(audioMedia());
    await next.next('start');
    deps.audio.reply({ type: 'paused' });
    await reloading;
    expect(engine.playbackRate).toBe(0.5);
  });

  it('currentTime 依 clock 的 rate 內插：每個聽到的 frame 推進 rate / sampleRate 秒', async () => {
    const { engine, deps } = await loaded({ paused: false });
    clock(deps, 2, 0, 1.25);
    deps.audio.frameNow = SR * 0.4;
    expect(engine.currentTime).toBeCloseTo(2.5, 9);
    // drain 的接點：速度改變的那個 frame 送出新的 clock。
    clock(deps, 2.6, SR * 0.48, 2);
    deps.audio.frameNow = SR * 0.58;
    expect(engine.currentTime).toBeCloseTo(2.8, 9);
  });
});

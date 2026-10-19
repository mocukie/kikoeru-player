// AudioContext 的生命週期（#41）：解鎖、串行佇列與 timeout、長時間暫停的 suspend、系統中斷、外部操作與 watchdog。
// 以假 media Worker 與假音訊輸出驅動 createEngineWith()；timer 一律用 fake timers。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDeps, type FakeEngineDeps } from '../../test/fakes/engine-deps.js';
import { audioMedia } from '../../test/fakes/media-worker.js';
import { createEngineWith } from './engine.js';
import type { BeforeAudioStartEvent, EngineErrorEvent, StateChangeEvent } from './events.js';
import type { Engine, EngineOptions, Source } from './types.js';

const source: Source = { kind: 'http', url: 'https://example.test/a.flac' };
const SR = 48_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** 讓排隊中的 microtask 跑完（不推進時間）。 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('預期 reject，卻 resolve 了');
    },
    (error: unknown) => error,
  );
}

/** 載入到 ready（paused），還沒有解鎖 AudioContext。 */
async function loaded(deps: FakeEngineDeps = createFakeDeps(), options?: EngineOptions) {
  const engine = createEngineWith(deps, options);
  const loading = engine.load(source);
  const worker = deps.workers.last;
  await worker.probe(audioMedia({ duration: 10 }));
  await worker.next('start');
  deps.audio.reply({ type: 'paused' });
  await loading;
  return { engine, deps, worker };
}

/** 載入並播放中：AudioContext 已解鎖，worklet 回報過 playing 與 frame 0 的 clock。 */
async function playing(fakes?: FakeEngineDeps, options?: EngineOptions) {
  const setup = await loaded(fakes, options);
  const { engine, deps } = setup;
  const started = engine.play();
  await settle();
  clock(deps, 0, 0);
  deps.audio.reply({ type: 'playing' });
  await started;
  return setup;
}

function clock(deps: FakeEngineDeps, position: number, frame: number): void {
  deps.audio.reply({ type: 'clock', position, frame, buffered: 0, underruns: 0 });
}

function recordChanges(engine: Engine): StateChangeEvent[] {
  const changes: StateChangeEvent[] = [];
  engine.addEventListener('statechange', (event) => changes.push(event));
  return changes;
}

/** worklet 收到的 play／pause，依順序。 */
function intents(deps: FakeEngineDeps): string[] {
  return deps.audio.received
    .filter((m) => m.type === 'play' || m.type === 'pause')
    .map((m) => m.type);
}

describe('解鎖', () => {
  it('play() 在呼叫內同步發出 beforeaudiostart（unlock），接著同步 resume', async () => {
    const { engine, deps } = await loaded();
    const before = deps.audio.calls.length;
    let atEvent: string[] = [];
    engine.addEventListener('beforeaudiostart', (event: BeforeAudioStartEvent) => {
      expect(event.cause).toBe('unlock');
      atEvent = deps.audio.calls.slice(before);
    });

    void engine.play();

    expect(atEvent).toEqual([]);
    expect(deps.audio.calls.slice(before)).toEqual(['resume']);
  });

  it('context 開始之後才叫 worklet 播放；之後的 play() 不再 resume', async () => {
    const { engine, deps } = await loaded();
    expect(engine.audioUnlocked).toBe(false);

    const first = engine.play();
    expect(intents(deps)).toEqual(['pause']);
    await settle();
    expect(engine.audioUnlocked).toBe(true);
    expect(intents(deps)).toEqual(['pause', 'play']);
    deps.audio.reply({ type: 'playing' });
    await first;

    const pausing = engine.pause();
    deps.audio.reply({ type: 'paused' });
    await pausing;
    const events: BeforeAudioStartEvent[] = [];
    engine.addEventListener('beforeaudiostart', (event) => events.push(event));
    void engine.play();
    expect(events).toEqual([]);
    expect(deps.audio.calls.filter((c) => c === 'resume')).toHaveLength(1);
    expect(deps.audio.intent).toBe('play');
  });

  it('沒有 gesture 而 resume 被拒絕：play() 以非致命的 AUDIO_LOCKED reject，paused 回到 true，不曾進入 playing', async () => {
    const { engine, deps } = await loaded();
    deps.audio.behavior.resume = 'reject';
    const changes = recordChanges(engine);

    const error = await rejection(engine.play());

    expect(error).toMatchObject({ name: 'EngineError', code: 'AUDIO_LOCKED', fatal: false });
    expect(engine.paused).toBe(true);
    expect(engine.audioUnlocked).toBe(false);
    expect(changes.map((c) => [c.state, c.paused])).toEqual([
      ['ready', false],
      ['ready', true],
    ]);
    expect(intents(deps)).not.toContain('play');
  });

  it('resume 逾時（2 秒）時 AUDIO_LOCKED', async () => {
    const { engine, deps } = await loaded();
    deps.audio.behavior.resume = 'hang';
    const result = rejection(engine.play());

    await vi.advanceTimersByTimeAsync(1999);
    expect(engine.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toMatchObject({ code: 'AUDIO_LOCKED', fatal: false });
    expect(engine.paused).toBe(true);
  });

  it('逾時的 resume 之後才生效（例如之後的 gesture）時，不當成外部的 resume', async () => {
    const { engine, deps } = await loaded();
    deps.audio.behavior.resume = 'hang';
    const result = rejection(engine.play());
    await vi.advanceTimersByTimeAsync(2000);
    await result;

    deps.audio.emitState('running');
    expect(engine.paused).toBe(true);
    expect(engine.audioUnlocked).toBe(true);
  });

  it('unlockAudio() 在呼叫內建立 context 並 resume，之前同步發出 beforeaudiostart；同時先 compile wasm', async () => {
    const deps = createFakeDeps();
    const engine = createEngineWith(deps);
    const seen: number[] = [];
    engine.addEventListener('beforeaudiostart', (event) => {
      expect(event.cause).toBe('unlock');
      seen.push(deps.audioCreated);
    });

    engine.unlockAudio();

    expect(seen).toEqual([0]);
    expect(deps.audio.calls).toEqual(['resume']);
    expect(deps.wasmLoads).toBe(1);
    await settle();
    expect(engine.audioUnlocked).toBe(true);

    // 之後的 load 沿用同一個 context 與 compile 好的 wasm。
    void engine.load(source);
    await deps.workers.last.next('init');
    expect(deps.audioCreated).toBe(1);
    expect(deps.wasmLoads).toBe(1);
  });

  it('同一個 gesture 內的 unlockAudio() 與 play() 共用一次 resume', async () => {
    const { engine, deps } = await loaded();
    const events: BeforeAudioStartEvent[] = [];
    engine.addEventListener('beforeaudiostart', (event) => events.push(event));

    engine.unlockAudio();
    void engine.play();

    expect(events).toHaveLength(1);
    expect(deps.audio.calls.filter((c) => c === 'resume')).toHaveLength(1);
  });

  it('beforeaudiostart 的 listener 內 destroy()：play() 以 DESTROYED reject，不再 resume', async () => {
    const { engine, deps } = await loaded();
    engine.addEventListener('beforeaudiostart', () => void engine.destroy());

    const error = await rejection(engine.play());

    expect(error).toMatchObject({ code: 'DESTROYED' });
    expect(deps.audio.calls).not.toContain('resume');
  });

  it('load({ paused: false }) 沒有 gesture：以 ready resolve，paused 回到 true，不曾進入 playing', async () => {
    const deps = createFakeDeps({
      onAudio: (audio) => {
        audio.behavior.resume = 'reject';
      },
    });
    const engine = createEngineWith(deps);
    const changes = recordChanges(engine);
    const loading = engine.load(source, { paused: false });
    expect(deps.audio.calls[0]).toBe('resume');
    const worker = deps.workers.last;
    await worker.probe(audioMedia());
    await worker.next('start');
    deps.audio.reply({ type: 'paused' });

    await expect(loading).resolves.toMatchObject({ duration: 10 });
    expect(engine.state).toBe('ready');
    expect(engine.paused).toBe(true);
    expect(changes.map((c) => c.state)).not.toContain('playing');
    expect(intents(deps)).not.toContain('play');
  });

  it('load({ paused: false }) 時 resume 還沒有結果：等到 context 開始才進入 playing', async () => {
    const deps = createFakeDeps({
      onAudio: (audio) => {
        audio.behavior.resume = 'hang';
      },
    });
    const engine = createEngineWith(deps);
    const loading = engine.load(source, { paused: false });
    const worker = deps.workers.last;
    await worker.probe(audioMedia());
    await worker.next('start');
    // worklet 補滿，但 context 還沒開始：仍然 loading。
    deps.audio.reply({ type: 'paused' });
    await settle();
    expect(engine.state).toBe('loading');

    deps.audio.pending[0]?.resolve();
    await settle();
    expect(deps.audio.intent).toBe('play');
    deps.audio.reply({ type: 'playing' });
    await loading;
    expect(engine.state).toBe('playing');
  });
});

describe('串行佇列', () => {
  it('長時間暫停的 suspend 還沒結束時，play() 的 resume 排在它之後；suspend 逾時（2 秒）後才 resume', async () => {
    const { engine, deps } = await playing();
    void engine.pause();
    deps.audio.reply({ type: 'paused' });
    deps.audio.behavior.suspend = 'hang';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.audio.calls.at(-1)).toBe('suspend');

    const events: BeforeAudioStartEvent[] = [];
    engine.addEventListener('beforeaudiostart', (event) => events.push(event));
    const resumed = engine.play();
    expect(events.map((e) => e.cause)).toEqual(['resume']);
    expect(deps.audio.calls.at(-1)).toBe('suspend');

    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.audio.calls.at(-1)).toBe('resume');
    await settle();
    deps.audio.reply({ type: 'playing' });
    await resumed;
    expect(engine.state).toBe('playing');
  });

  it('suspend 結束時立即接著 resume', async () => {
    const { engine, deps } = await playing();
    void engine.pause();
    deps.audio.reply({ type: 'paused' });
    deps.audio.behavior.suspend = 'hang';
    await vi.advanceTimersByTimeAsync(30_000);
    void engine.play();

    deps.audio.pending[0]?.resolve();
    await settle();
    expect(deps.audio.calls.slice(-2)).toEqual(['suspend', 'resume']);
  });

  it('Engine 自己的操作進行中的 statechange 不當成外部操作', async () => {
    const { engine, deps } = await loaded();
    deps.audio.behavior.resume = 'hang';
    void engine.play();
    deps.audio.emitState('running');
    expect(engine.paused).toBe(false);
    deps.audio.pending[0]?.resolve();
    await settle();
    expect(deps.audio.intent).toBe('play');
  });

  it('destroy() 經佇列 close()，close 不結束時 2 秒後 resolve', async () => {
    const { engine, deps } = await playing();
    deps.audio.behavior.close = 'hang';
    let destroyed = false;
    void engine.destroy().then(() => (destroyed = true));
    expect(deps.audio.calls.slice(-2)).toEqual(['disconnect', 'close']);

    await vi.advanceTimersByTimeAsync(1999);
    expect(destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(destroyed).toBe(true);
  });
});

describe('長時間暫停', () => {
  // 假 Worker 不送資料：放寬卡住的時限，不讓 Engine 在等待期間進入 error（error 也會 suspend）。
  const noStall: EngineOptions = { stallTimeout: 120_000 };

  it('暫停超過 30 秒才 suspend；之前 play() 就不 suspend', async () => {
    const { engine, deps } = await playing(undefined, noStall);
    void engine.pause();
    deps.audio.reply({ type: 'paused' });
    await vi.advanceTimersByTimeAsync(29_999);
    void engine.play();
    deps.audio.reply({ type: 'playing' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.audio.calls).not.toContain('suspend');

    void engine.pause();
    deps.audio.reply({ type: 'paused' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.audio.calls.at(-1)).toBe('suspend');
  });

  it('播放中進入 error：30 秒後 suspend', async () => {
    const { engine, deps, worker } = await playing();
    worker.crash();
    expect(engine.state).toBe('error');
    expect(engine.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.audio.calls.at(-1)).toBe('suspend');
  });

  it('load() 之前 play()：idle 中 30 秒後 suspend', async () => {
    const deps = createFakeDeps();
    const engine = createEngineWith(deps);
    await rejection(engine.play());
    expect(engine.state).toBe('idle');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.audio.calls.at(-1)).toBe('suspend');
  });

  it('buffering 不 suspend', async () => {
    const { engine, deps } = await playing(undefined, noStall);
    deps.audio.reply({ type: 'starved' });
    await vi.advanceTimersByTimeAsync(250);
    expect(engine.state).toBe('buffering');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.audio.calls).not.toContain('suspend');
  });

  it('suspend 之後 play() 以 beforeaudiostart（resume）resume；resume 失敗時 AUDIO_LOCKED', async () => {
    const { engine, deps } = await playing();
    void engine.pause();
    deps.audio.reply({ type: 'paused' });
    await vi.advanceTimersByTimeAsync(30_000);
    deps.audio.behavior.resume = 'reject';
    const causes: string[] = [];
    engine.addEventListener('beforeaudiostart', (event) => causes.push(event.cause));

    const error = await rejection(engine.play());

    expect(causes).toEqual(['resume']);
    expect(error).toMatchObject({ code: 'AUDIO_LOCKED', fatal: false });
    expect(engine.paused).toBe(true);
    expect(engine.state).toBe('paused');
  });
});

describe('系統中斷', () => {
  it('播放中被中斷：paused 變為 true（reason interrupted）；WebKit 自己 resume 時仍然暫停', async () => {
    const { engine, deps } = await playing();
    const changes = recordChanges(engine);

    deps.audio.emitState('interrupted');
    expect(engine.paused).toBe(true);
    expect(deps.audio.intent).toBe('pause');
    deps.audio.reply({ type: 'paused' });
    expect(changes.map((c) => [c.state, c.paused, c.reason])).toEqual([
      ['playing', true, 'interrupted'],
      ['paused', true, 'interrupted'],
    ]);

    deps.audio.emitState('running');
    expect(engine.paused).toBe(true);
    expect(deps.audio.intent).toBe('pause');
  });

  it('中斷後的 play() 發出 beforeaudiostart（resume）並 resume', async () => {
    const { engine, deps } = await playing();
    deps.audio.emitState('interrupted');
    deps.audio.reply({ type: 'paused' });
    deps.audio.emitState('running');
    const causes: string[] = [];
    engine.addEventListener('beforeaudiostart', (event) => causes.push(event.cause));

    const resumed = engine.play();
    expect(causes).toEqual(['resume']);
    expect(deps.audio.calls.at(-1)).toBe('resume');
    await settle();
    expect(deps.audio.intent).toBe('play');
    deps.audio.reply({ type: 'playing' });
    await resumed;
  });

  it('resume 逾時且 context 仍處於 interrupted：play() 以非致命的 AUDIO_OUTPUT reject，paused 回到 true', async () => {
    const { engine, deps } = await playing();
    deps.audio.emitState('interrupted');
    deps.audio.reply({ type: 'paused' });
    deps.audio.behavior.resume = 'hang';

    const result = rejection(engine.play());
    await vi.advanceTimersByTimeAsync(2000);

    await expect(result).resolves.toMatchObject({ code: 'AUDIO_OUTPUT', fatal: false });
    expect(engine.paused).toBe(true);
    expect(engine.state).toBe('paused');
  });
});

describe('外部操作', () => {
  it('Engine 以外 suspend 再 resume：paused 跟著變，reason external', async () => {
    const { engine, deps } = await playing();
    const changes = recordChanges(engine);

    deps.audio.emitState('suspended');
    expect(engine.paused).toBe(true);
    deps.audio.reply({ type: 'paused' });
    deps.audio.emitState('running');
    expect(engine.paused).toBe(false);
    expect(deps.audio.intent).toBe('play');
    deps.audio.reply({ type: 'playing' });

    expect(changes.map((c) => [c.state, c.paused, c.reason])).toEqual([
      ['playing', true, 'external'],
      ['paused', true, 'external'],
      ['paused', false, 'external'],
      ['playing', false, 'external'],
    ]);
  });

  it('長時間暫停而 suspend 的 context 被外部 resume（例如鎖屏的播放鍵）：開始播放', async () => {
    const { engine, deps } = await playing();
    void engine.pause();
    deps.audio.reply({ type: 'paused' });
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();

    deps.audio.emitState('running');
    expect(engine.paused).toBe(false);
    expect(deps.audio.intent).toBe('play');
  });

  it('還沒開始過的 context 自己開始（例如已有 sticky activation）：不改變播放意圖', async () => {
    const { engine, deps } = await loaded();
    deps.audio.emitState('running');
    expect(engine.paused).toBe(true);
    expect(engine.audioUnlocked).toBe(true);
  });

  it('暫停中被外部 suspend：paused 不變，沒有 statechange', async () => {
    const { engine, deps } = await playing();
    const pausing = engine.pause();
    deps.audio.reply({ type: 'paused' });
    await pausing;
    const changes = recordChanges(engine);
    deps.audio.emitState('suspended');
    expect(changes).toEqual([]);
  });
});

describe('watchdog', () => {
  it('playing 而 frame 超過 1 秒沒有前進：先 suspend 再 resume；frame 前進就不再介入', async () => {
    const { deps } = await playing();
    await vi.advanceTimersByTimeAsync(750);
    clock(deps, 0.25, 0.25 * SR);
    await vi.advanceTimersByTimeAsync(999);
    expect(deps.audio.calls).not.toContain('suspend');

    await vi.advanceTimersByTimeAsync(1);
    expect(deps.audio.calls.slice(-2)).toEqual(['suspend', 'resume']);
    await settle();
    clock(deps, 0.5, 0.5 * SR);
    await vi.advanceTimersByTimeAsync(900);
    clock(deps, 1.4, 1.4 * SR);
    await vi.advanceTimersByTimeAsync(900);
    expect(deps.audioCreated).toBe(1);
  });

  it('suspend 加 resume 之後仍不前進：重建 context，給 Worker 新的 port，遞增 epoch 從目前位置重新供料', async () => {
    const { engine, deps, worker } = await playing();
    const old = deps.audio;
    clock(deps, 2, 2 * SR);
    const oldEpoch = old.epoch;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(deps.audioCreated).toBe(2);
    expect(old.calls.slice(-2)).toEqual(['disconnect', 'close']);
    expect(engine.state).toBe('buffering');
    const fresh = deps.audio;
    expect(fresh.epoch).toBeGreaterThan(oldEpoch);
    expect(fresh.received).toEqual([
      { type: 'rate', rate: 1 },
      { type: 'flush', epoch: fresh.epoch, position: 2 },
      { type: 'duration', epoch: fresh.epoch, duration: 10 },
      { type: 'pause', epoch: fresh.epoch, immediate: true },
      { type: 'play', epoch: fresh.epoch },
    ]);
    expect(fresh.calls).toEqual(['resume', 'connect']);
    const port = await worker.next('port');
    expect(port).toMatchObject({ epoch: fresh.epoch, time: 2 });

    // 舊的 context 的回報不再影響狀態；新的補滿後回到 playing，frame 從 0 重新算起。
    fresh.reply({ type: 'clock', position: 2, frame: 0, buffered: 0, underruns: 0 });
    fresh.reply({ type: 'playing' });
    expect(engine.state).toBe('playing');
    fresh.reply({ type: 'clock', position: 2.25, frame: 0.25 * SR, buffered: 0, underruns: 0 });
    await vi.advanceTimersByTimeAsync(900);
    expect(engine.state).toBe('playing');
  });

  it('重建的 context 沒有啟動：paused 變為 true（reason error），送出非致命的 AUDIO_LOCKED', async () => {
    // 重建出來的 context 沒有 user gesture，拒絕 resume。
    let created = 0;
    const { engine, deps } = await playing(
      createFakeDeps({
        onAudio: (audio) => {
          if (++created > 1) audio.behavior.resume = 'reject';
        },
      }),
    );
    const errors: EngineErrorEvent[] = [];
    engine.addEventListener('error', (event) => errors.push(event));
    const changes = recordChanges(engine);
    await vi.advanceTimersByTimeAsync(2000);
    const fresh = deps.audio;
    expect(deps.audioCreated).toBe(2);

    expect(errors.map((e) => [e.error.code, e.error.fatal])).toEqual([['AUDIO_LOCKED', false]]);
    expect(engine.paused).toBe(true);
    expect(changes.find((c) => c.paused)).toMatchObject({ reason: 'error' });
    fresh.reply({ type: 'paused' });
    expect(engine.state).toBe('paused');
  });

  it('重建之後仍不前進：fatal 的 AUDIO_OUTPUT', async () => {
    const { engine, deps } = await playing();
    await vi.advanceTimersByTimeAsync(2000);
    deps.audio.reply({ type: 'clock', position: 0, frame: 0, buffered: 0, underruns: 0 });
    deps.audio.reply({ type: 'playing' });
    expect(engine.state).toBe('playing');

    await vi.advanceTimersByTimeAsync(1000);

    expect(engine.state).toBe('error');
    expect(engine.error).toMatchObject({ code: 'AUDIO_OUTPUT', fatal: true });
  });

  it('暫停中不介入', async () => {
    const { engine, deps } = await playing();
    const pausing = engine.pause();
    deps.audio.reply({ type: 'paused' });
    await pausing;
    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.audio.calls).not.toContain('suspend');
  });

  it('重建期間 destroy：不再把 port 交給 Worker', async () => {
    const { engine, deps, worker } = await playing();
    await vi.advanceTimersByTimeAsync(1000);
    // 第二步：重建；同步 destroy。
    await vi.advanceTimersByTimeAsync(999);
    const destroying = engine.destroy();
    await vi.advanceTimersByTimeAsync(1);
    await destroying;
    expect(worker.messages('port')).toEqual([]);
    expect(engine.state).toBe('idle');
    expect(deps.audio.calls.at(-1)).toBe('close');
  });
});

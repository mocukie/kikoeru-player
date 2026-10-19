// 生命週期（#40）：unload()、destroy() 在各種指令執行中的競態、LoadOptions.signal、Worker 崩潰與資源計數。
// 以假 media Worker 與假音訊輸出驅動 createEngineWith()。

import { describe, expect, it } from 'vitest';
import { createFakeDeps, type FakeEngineDeps } from '../../test/fakes/engine-deps.js';
import { audioMedia } from '../../test/fakes/media-worker.js';
import { AssetLoadError } from './deps.js';
import { createEngineWith } from './engine.js';
import type { Engine, Source } from './types.js';

const source: Source = { kind: 'http', url: 'https://example.test/a.m4a' };

function setup(): { engine: Engine; deps: FakeEngineDeps } {
  const deps = createFakeDeps();
  return { engine: createEngineWith(deps), deps };
}

/** load 到 ready（`paused: false` 時到 playing）。 */
async function loaded(options: { paused?: boolean } = {}) {
  const { engine, deps } = setup();
  const loading = engine.load(source, options);
  const worker = deps.workers.last;
  await worker.probe(audioMedia());
  await worker.next('start');
  deps.audio.reply({ type: options.paused === false ? 'playing' : 'paused' });
  await loading;
  return { engine, deps, worker };
}

/** 依 Engine 的事件記錄 `type:state` 或 `type`。 */
function recordEvents(engine: Engine): string[] {
  const log: string[] = [];
  for (const type of ['statechange', 'durationchange', 'trackschange', 'seeked', 'error']) {
    engine.addEventListener(type, (event) => {
      log.push('state' in event ? `${type}:${String(event.state)}` : type);
    });
  }
  return log;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('預期 reject，卻 resolve 了');
    },
    (error: unknown) => error,
  );
}

const abortError: unknown = expect.objectContaining({ name: 'AbortError' });
const noResources = { workers: 0, libavInstances: 0, openVideoFrames: 0 };

describe('unload', () => {
  it('播放中 unload：回到 idle、paused 為 true，terminate Worker，清掉媒體；保留 AudioContext 與 worklet', async () => {
    const { engine, deps, worker } = await loaded({ paused: false });
    deps.audio.reply({ type: 'clock', position: 2, frame: 0, buffered: 0, underruns: 0 });
    const events = recordEvents(engine);

    await engine.unload();

    expect(engine.state).toBe('idle');
    expect(engine.paused).toBe(true);
    expect(engine.media).toBeNull();
    expect(engine.tracks).toEqual([]);
    expect(engine.duration).toBeNaN();
    expect(engine.currentTime).toBe(0);
    expect(engine.error).toBeNull();
    expect(worker.terminated).toBe(true);
    expect(deps.audio.intent).toBe('pause');
    // 停掉 ring 內剩下的聲音，之後舊 epoch 的回報被丟棄。
    expect(deps.audio.received.at(-2)).toMatchObject({ type: 'flush', position: 0 });
    expect(deps.audio.calls).not.toContain('disconnect');
    expect(deps.audio.calls).not.toContain('close');
    expect(events).toEqual(['durationchange', 'trackschange', 'statechange:idle']);
    expect((await engine.getStats()).resources).toEqual(noResources);
  });

  it('unload 之後的 load 沿用同一個 AudioContext，建立新的 Worker', async () => {
    const { engine, deps } = await loaded();
    await engine.unload();

    const loading = engine.load(source);
    const worker = deps.workers.last;
    await worker.probe(audioMedia());
    await worker.next('start');
    deps.audio.reply({ type: 'paused' });
    await loading;

    expect(engine.state).toBe('ready');
    expect(deps.workers.created).toHaveLength(2);
    expect(deps.audioCreated).toBe(1);
  });

  it('load 執行中 unload：load 與 loading 期間的 seek 以 AbortError reject，Worker 被 terminate', async () => {
    const { engine, deps } = setup();
    const loading = engine.load(source);
    const seeking = engine.seek(3);
    const worker = deps.workers.last;
    await worker.next('load');

    await engine.unload();

    await expect(rejection(loading)).resolves.toEqual(abortError);
    await expect(rejection(seeking)).resolves.toEqual(abortError);
    expect(worker.terminated).toBe(true);
    expect(engine.state).toBe('idle');
    // 被 terminate 的 Worker 之後送來的訊息不改變狀態。
    await worker.probe(audioMedia());
    worker.crash();
    expect(engine.state).toBe('idle');
    expect(engine.error).toBeNull();
  });

  it('seek、play、pause 執行中 unload：都以 AbortError reject', async () => {
    const { engine } = await loaded();
    const seeking = engine.seek(3);
    const playing = engine.play();
    const unloading = engine.unload();

    await expect(rejection(seeking)).resolves.toEqual(abortError);
    await expect(rejection(playing)).resolves.toEqual(abortError);
    await unloading;
    expect(engine.state).toBe('idle');
    expect(engine.paused).toBe(true);
  });

  it('error 時 unload：清掉 error 回到 idle；之後 reload 為 InvalidStateError', async () => {
    const { engine, worker } = await loaded();
    worker.crash();
    expect(engine.state).toBe('error');

    await engine.unload();
    expect(engine.state).toBe('idle');
    expect(engine.error).toBeNull();
    await expect(rejection(engine.reload())).resolves.toMatchObject({
      name: 'InvalidStateError',
    });
  });

  it('idle 時 unload 什麼都不做', async () => {
    const { engine, deps } = setup();
    const events = recordEvents(engine);
    await engine.unload();
    expect(engine.state).toBe('idle');
    expect(events).toEqual([]);
    expect(deps.workers.created).toEqual([]);
  });

  it('unload 被 load 取代：以 AbortError reject，load 照常完成', async () => {
    const { engine, deps } = await loaded();
    const unloading = engine.unload();
    const loading = engine.load(source);
    await expect(rejection(unloading)).resolves.toEqual(abortError);

    await deps.workers.last.probe(audioMedia());
    await deps.workers.last.next('start');
    deps.audio.reply({ type: 'paused' });
    await loading;
    expect(engine.state).toBe('ready');
  });

  it('等待 Worker 回覆 stats 時 unload：以 0 個 instance 回報', async () => {
    const { engine } = await loaded();
    const stats = engine.getStats();
    await engine.unload();
    expect((await stats).resources).toEqual(noResources);
  });

  it('destroy 之後 unload reject DESTROYED', async () => {
    const { engine } = await loaded();
    await engine.destroy();
    await expect(rejection(engine.unload())).resolves.toMatchObject({ code: 'DESTROYED' });
  });

  it('unload 執行中 destroy：unload 以 AbortError reject', async () => {
    const { engine } = await loaded();
    const unloading = engine.unload();
    const destroying = engine.destroy();
    await expect(rejection(unloading)).resolves.toEqual(abortError);
    await destroying;
    expect(engine.state).toBe('idle');
  });
});

describe('destroy 事件', () => {
  it('destroy() 呼叫內同步發出一次，此時 state 已是 idle、之後的指令 reject DESTROYED', async () => {
    const { engine } = await loaded({ paused: false });
    const seen: { state: string; paused: boolean; play: Promise<void> }[] = [];
    engine.addEventListener('destroy', () => {
      seen.push({ state: engine.state, paused: engine.paused, play: engine.play() });
    });

    const destroying = engine.destroy();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ state: 'idle', paused: true });
    await expect(rejection(seen[0]?.play ?? Promise.resolve())).resolves.toMatchObject({
      code: 'DESTROYED',
    });

    await engine.destroy();
    await destroying;
    expect(seen).toHaveLength(1);
  });

  it('沒有載入過媒體（state 不變、沒有 statechange）也會發出', async () => {
    const { engine } = setup();
    let destroyed = 0;
    engine.addEventListener('destroy', () => destroyed++);
    await engine.destroy();
    expect(destroyed).toBe(1);
  });
});

describe('destroy 的競態', () => {
  it('reload 執行中 destroy：reload 以 AbortError reject，新的 Worker 被 terminate，資源全為 0', async () => {
    const { engine, deps } = await loaded();
    const reloading = engine.reload();
    const worker = deps.workers.last;
    await worker.next('load');

    await engine.destroy();
    await expect(rejection(reloading)).resolves.toEqual(abortError);
    expect(worker.terminated).toBe(true);
    expect(engine.media).toBeNull();
    expect((await engine.getStats()).resources).toEqual(noResources);
  });

  it('play 等待 AudioContext 啟動時 destroy：play 以 AbortError reject，之後啟動的結果不改變狀態', async () => {
    const { engine, deps } = await loaded();
    deps.audio.behavior.resume = 'hang';
    deps.audio.emitState('suspended');
    const playing = rejection(engine.play());
    const destroying = engine.destroy();

    await expect(playing).resolves.toEqual(abortError);
    // close() 排在還沒 settle 的 resume() 之後。
    for (const op of deps.audio.pending) op.resolve();
    await destroying;
    deps.audio.reply({ type: 'playing' });
    expect(engine.state).toBe('idle');
    expect(engine.paused).toBe(true);
  });

  it('load 的 statechange listener 內 destroy：load 以 AbortError reject，Worker 沒有收到 load', async () => {
    const { engine, deps } = setup();
    engine.addEventListener('statechange', (event) => {
      if (event.state === 'loading') void engine.destroy();
    });
    const loading = engine.load(source);
    await expect(rejection(loading)).resolves.toEqual(abortError);
    expect(engine.state).toBe('idle');
    for (const worker of deps.workers.created) expect(worker.terminated).toBe(true);
    expect(deps.workers.created.flatMap((w) => w.messages('load'))).toEqual([]);
  });

  it('error 時 destroy：清掉 error；被 terminate 的 Worker 之後的 crash 不改變狀態', async () => {
    const { engine, worker } = await loaded();
    worker.crash();
    await engine.destroy();
    expect(engine.state).toBe('idle');
    expect(engine.error).toBeNull();
    worker.crash();
    worker.reply({ type: 'crash', reason: 'wasm-trap', message: 'unreachable' });
    expect(engine.state).toBe('idle');
    expect(engine.error).toBeNull();
  });
});

describe('Worker 崩潰的路線', () => {
  it.each([
    ['wasm-trap', 'unreachable'],
    ['out-of-memory', 'Out of memory'],
  ] as const)(
    '播放中的 crash 訊息（%s）：fatal 的 INTERNAL，帶 position；reload 以新的 Worker 恢復',
    async (reason, message) => {
      const { engine, deps, worker } = await loaded({ paused: false });
      deps.audio.reply({ type: 'clock', position: 6.5, frame: 0, buffered: 0, underruns: 0 });

      worker.reply({ type: 'crash', reason, message });
      expect(engine.state).toBe('error');
      expect(engine.error).toMatchObject({ code: 'INTERNAL', fatal: true, position: 6.5 });
      expect(worker.terminated).toBe(true);
      expect((await engine.getStats()).resources).toEqual(noResources);

      const reloading = engine.reload();
      const next = deps.workers.last;
      expect(next).not.toBe(worker);
      await next.probe(audioMedia());
      expect((await next.next('start')).time).toBe(6.5);
      deps.audio.reply({ type: 'playing' });
      await reloading;
      expect(engine.state).toBe('playing');
    },
  );

  it('seek 執行中崩潰：seek 以 INTERNAL reject', async () => {
    const { engine, worker } = await loaded();
    const seeking = engine.seek(4);
    worker.crash();
    await expect(rejection(seeking)).resolves.toMatchObject({ code: 'INTERNAL', fatal: true });
  });

  it('Worker 的 script 載入失敗（deps 以 AssetLoadError 回報）：fatal 的 ASSET_LOAD_FAILED', async () => {
    const { engine, deps } = setup();
    const loading = engine.load(source);
    deps.workers.last.crash(new AssetLoadError('media Worker 的 script 載入失敗'));

    await expect(rejection(loading)).resolves.toMatchObject({
      name: 'EngineError',
      code: 'ASSET_LOAD_FAILED',
      fatal: true,
    });
    expect(engine.state).toBe('error');
  });
});

describe('LoadOptions.signal', () => {
  it('已經 abort 的 signal：reject AbortError，不建立 Worker、不改變狀態', async () => {
    const { engine, deps } = await loaded();
    const events = recordEvents(engine);
    const signal = AbortSignal.abort(new Error('App 取消'));

    await expect(rejection(engine.load(source, { signal }))).resolves.toEqual(abortError);
    expect(deps.workers.created).toHaveLength(1);
    expect(engine.state).toBe('ready');
    expect(events).toEqual([]);
  });

  it('load 執行中 abort：load 與 loading 期間的 seek 以 AbortError reject，terminate Worker、回到 idle', async () => {
    const { engine, deps } = setup();
    const controller = new AbortController();
    const loading = engine.load(source, { signal: controller.signal });
    const seeking = engine.seek(2);
    const worker = deps.workers.last;
    await worker.next('load');

    // reason 不是 AbortError 時也一律以 AbortError reject（等同被取代），App 用 isAbortError() 判斷。
    controller.abort(new Error('App 取消'));
    await expect(rejection(loading)).resolves.toEqual(abortError);
    await expect(rejection(seeking)).resolves.toEqual(abortError);
    expect(worker.terminated).toBe(true);
    expect(engine.state).toBe('idle');
    expect(engine.paused).toBe(true);
    expect(engine.media).toBeNull();
    expect(engine.error).toBeNull();
    expect((await engine.getStats()).resources).toEqual(noResources);

    // 之後的 Worker 回報被丟棄。
    await worker.probe(audioMedia());
    expect(engine.state).toBe('idle');
  });

  it('probe 之後、worklet 補滿之前 abort：同樣回到 idle', async () => {
    const { engine, deps } = setup();
    const controller = new AbortController();
    const loading = engine.load(source, { signal: controller.signal });
    const worker = deps.workers.last;
    await worker.probe(audioMedia());
    await worker.next('start');

    controller.abort();
    await expect(rejection(loading)).resolves.toEqual(abortError);
    deps.audio.reply({ type: 'paused', epoch: (await worker.next('start')).epoch });
    expect(engine.state).toBe('idle');
    expect(engine.media).toBeNull();
  });

  it('load 完成後 abort 沒有作用；reload 不沿用這個 signal', async () => {
    const controller = new AbortController();
    const { engine, deps } = setup();
    const loading = engine.load(source, { signal: controller.signal });
    await deps.workers.last.probe(audioMedia());
    await deps.workers.last.next('start');
    deps.audio.reply({ type: 'paused' });
    await loading;

    controller.abort();
    expect(engine.state).toBe('ready');
    expect(deps.workers.last.terminated).toBe(false);

    const reloading = engine.reload();
    await deps.workers.last.probe(audioMedia());
    await deps.workers.last.next('start');
    deps.audio.reply({ type: 'paused' });
    await expect(reloading).resolves.toMatchObject({ duration: 10 });
  });

  it('被下一個 load 取代之後 abort：不影響新的 load', async () => {
    const { engine, deps } = setup();
    const controller = new AbortController();
    const first = rejection(engine.load(source, { signal: controller.signal }));
    const second = engine.load(source);
    await expect(first).resolves.toEqual(abortError);

    controller.abort();
    const worker = deps.workers.last;
    expect(worker.terminated).toBe(false);
    expect(engine.state).toBe('loading');
    await worker.probe(audioMedia());
    await worker.next('start');
    deps.audio.reply({ type: 'paused' });
    await second;
    expect(engine.state).toBe('ready');
  });

  it('不在 signal 上留下 listener', async () => {
    const { engine, deps } = setup();
    const signal = new AbortController().signal;
    let listeners = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args: Parameters<typeof add>) => {
      listeners++;
      add(...args);
    };
    signal.removeEventListener = (...args: Parameters<typeof remove>) => {
      listeners--;
      remove(...args);
    };
    const loading = engine.load(source, { signal });
    await deps.workers.last.probe(audioMedia());
    await deps.workers.last.next('start');
    deps.audio.reply({ type: 'paused' });
    await loading;
    expect(listeners).toBe(0);
  });
});

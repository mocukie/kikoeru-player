// Engine 的指令、狀態與佇列：以假 media Worker 與假音訊輸出驅動 createEngineWith()。

import { describe, expect, it } from 'vitest';
import { createFakeDeps, type FakeEngineDeps } from '../../test/fakes/engine-deps.js';
import { audioMedia } from '../../test/fakes/media-worker.js';
import { createEngineWith } from './engine.js';
import type { StateChangeEvent } from './events.js';
import type { Engine, Source } from './types.js';

const source: Source = { kind: 'http', url: 'https://example.test/a.m4a' };

function setup(): { engine: Engine; deps: FakeEngineDeps } {
  const deps = createFakeDeps();
  return { engine: createEngineWith(deps), deps };
}

/** 依 Engine 的事件記錄 `type:state` 或 `type`，用來檢查順序。 */
function recordEvents(engine: Engine): string[] {
  const log: string[] = [];
  for (const type of [
    'statechange',
    'durationchange',
    'trackschange',
    'seeked',
    'ended',
    'error',
  ]) {
    engine.addEventListener(type, (event) => {
      log.push('state' in event ? `${type}:${String(event.state)}` : type);
    });
  }
  return log;
}

describe('load', () => {
  it('probe 後送出 start，worklet 補滿後進入 ready；resolve 時 getter 與事件已就緒', async () => {
    const { engine, deps } = setup();
    const events = recordEvents(engine);

    const loading = engine.load(source);
    expect(engine.state).toBe('loading');

    const worker = deps.workers.last;
    const init = await worker.next('init');
    expect(init.sampleRate).toBe(48_000);
    expect(init.module).toBeInstanceOf(WebAssembly.Module);
    expect(init.retry).toEqual({ attempts: 3, baseDelayMs: 500 });
    expect((await worker.next('load')).source).toEqual({ kind: 'http', url: source.url });

    await worker.probe(audioMedia());
    const start = await worker.next('start');
    expect(start).toMatchObject({ time: 0, audio: 0 });

    let settled = false;
    void loading.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    deps.audio.reply({ type: 'paused' });
    const info = await loading;

    expect(info.duration).toBe(10);
    expect(engine.state).toBe('ready');
    expect(engine.paused).toBe(true);
    expect(engine.duration).toBe(10);
    expect(engine.media).toBe(info);
    expect(engine.tracks).toHaveLength(1);
    expect(engine.selectedTracks).toEqual({
      audio: engine.tracks[0]?.id,
      video: null,
      subtitle: null,
    });
    expect(events).toEqual([
      'statechange:loading',
      'durationchange',
      'trackschange',
      'statechange:ready',
    ]);
  });

  it('init 帶著補上預設值的 retry，http 來源的 credentials、headers、size 原樣送到 Worker', async () => {
    const deps = createFakeDeps();
    const engine = createEngineWith(deps, { retry: { attempts: 1 } });
    void engine.load({
      kind: 'http',
      url: new URL('https://example.test/a.m4a'),
      credentials: 'include',
      headers: { Authorization: 'Bearer t' },
      size: 1234,
    });
    const worker = deps.workers.last;
    expect((await worker.next('init')).retry).toEqual({ attempts: 1, baseDelayMs: 500 });
    expect((await worker.next('load')).source).toEqual({
      kind: 'http',
      url: 'https://example.test/a.m4a',
      credentials: 'include',
      headers: { Authorization: 'Bearer t' },
      size: 1234,
    });
  });
});

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

/** 讓目前排隊中的 microtask 都跑完。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

describe('seek', () => {
  it('連續 seek 只執行最後一個：排隊中的不送出，其餘 AbortError', async () => {
    const { engine, deps, worker } = await loaded({ paused: false });
    void engine.pause(); // 佔住佇列，讓之後的 seek 排隊
    const first = engine.seek(1);
    const second = engine.seek(2);
    const last = engine.seek(3);

    deps.audio.reply({ type: 'paused' });
    await expect(rejection(first)).resolves.toEqual(abortError);
    await expect(rejection(second)).resolves.toEqual(abortError);

    await worker.next('seek');
    expect(worker.messages('seek').map((m) => m.time)).toEqual([3]);
    deps.audio.reply({ type: 'paused' });
    await expect(last).resolves.toBe(3);
  });

  it('執行中的 seek 被取代：Worker 收到新的 epoch，舊 epoch 的回報被丟棄', async () => {
    const { engine, deps, worker } = await loaded();
    const first = engine.seek(1);
    const oldEpoch = deps.audio.epoch;
    const second = engine.seek(2);

    await expect(rejection(first)).resolves.toEqual(abortError);
    const seeks = worker.messages('seek');
    expect(seeks.map((m) => m.time)).toEqual([1, 2]);
    expect(seeks[1]?.epoch).toBeGreaterThan(oldEpoch);

    deps.audio.reply({ type: 'paused', epoch: oldEpoch });
    await flush();
    expect(engine.state).toBe('seeking');

    deps.audio.reply({ type: 'paused' });
    await expect(second).resolves.toBe(2);
    expect(engine.state).toBe('ready');
  });

  it('落點夾在 [0, duration]；resolve 時 currentTime 已是落點，seeked 已發出', async () => {
    const { engine, deps } = await loaded({ paused: false });
    const events = recordEvents(engine);
    const seeking = engine.seek(99);
    expect(engine.state).toBe('seeking');

    deps.audio.reply({ type: 'playing' });
    const landing = await seeking;

    expect(landing).toBe(10);
    expect(engine.currentTime).toBe(10);
    expect(engine.state).toBe('playing');
    expect(events).toEqual(['statechange:seeking', 'statechange:playing', 'seeked']);
  });
});

describe('load 的取代', () => {
  it('新的 load 取代執行中的 load，舊的 Worker 被 terminate，它的訊息被丟棄', async () => {
    const { engine, deps } = setup();
    const first = engine.load(source);
    const oldWorker = deps.workers.last;
    await oldWorker.next('load');

    const second = engine.load({ kind: 'bytes', data: new Uint8Array(4) });
    await expect(rejection(first)).resolves.toEqual(abortError);
    expect(oldWorker.terminated).toBe(true);
    expect(deps.workers.created).toHaveLength(2);

    await oldWorker.probe(audioMedia({ duration: 99 }));
    oldWorker.crash();
    expect(engine.state).toBe('loading');
    expect(engine.error).toBeNull();
    const worker = deps.workers.last;
    await worker.probe(audioMedia());
    await worker.next('start');
    deps.audio.reply({ type: 'paused' });

    await expect(second).resolves.toMatchObject({ duration: 10 });
    expect(oldWorker.messages('start')).toEqual([]);
  });

  it('新的 load 取代執行中與排隊中的指令', async () => {
    const { engine, deps, worker } = await loaded();
    const seeking = engine.seek(5);
    const playing = engine.play();

    const loading = engine.load(source);
    await expect(rejection(seeking)).resolves.toEqual(abortError);
    await expect(rejection(playing)).resolves.toEqual(abortError);
    expect(worker.terminated).toBe(true);
    expect(engine.state).toBe('loading');
    expect(engine.paused).toBe(true);

    await deps.workers.last.probe(audioMedia());
    await deps.workers.last.next('start');
    deps.audio.reply({ type: 'paused' });
    await loading;
    expect(engine.state).toBe('ready');
  });

  it('loading 期間、start 之前的 seek 改寫起點，與 load 一起 resolve', async () => {
    const { engine, deps } = setup();
    const loading = engine.load(source);
    const first = engine.seek(3);
    const second = engine.seek(4);
    await expect(rejection(first)).resolves.toEqual(abortError);

    const worker = deps.workers.last;
    await worker.probe(audioMedia());
    expect((await worker.next('start')).time).toBe(4);
    expect(worker.messages('seek')).toEqual([]);

    let loadDone = false;
    void loading.then(() => (loadDone = true));
    deps.audio.reply({ type: 'paused' });
    await expect(second).resolves.toBe(4);
    expect(loadDone).toBe(true);
    expect(engine.currentTime).toBe(4);
    expect(engine.state).toBe('ready');
  });

  it('loading 期間、start 之後的 seek 以新的 epoch 送給 Worker 與 worklet', async () => {
    const { engine, deps } = setup();
    const loading = engine.load(source);
    const worker = deps.workers.last;
    await worker.probe(audioMedia());
    const start = await worker.next('start');

    const seeking = engine.seek(6);
    const seek = await worker.next('seek');
    expect(seek).toEqual({ type: 'seek', epoch: start.epoch + 1, time: 6 });
    expect(deps.audio.epoch).toBe(seek.epoch);

    deps.audio.reply({ type: 'paused', epoch: start.epoch });
    await flush();
    expect(engine.state).toBe('loading');

    deps.audio.reply({ type: 'paused' });
    await expect(seeking).resolves.toBe(6);
    await loading;
    expect(engine.state).toBe('ready');
  });
});

describe('過期的 epoch', () => {
  it('Worker 舊 epoch 的錯誤被丟棄', async () => {
    const { engine, deps, worker } = await loaded();
    const oldEpoch = deps.audio.epoch;
    const seeking = engine.seek(2);

    worker.reply({
      type: 'error',
      epoch: oldEpoch,
      error: { code: 'SOURCE_NETWORK', fatal: true, message: '被中止的讀取' },
    });
    deps.audio.reply({ type: 'paused' });
    await seeking;
    expect(engine.state).toBe('ready');
    expect(engine.error).toBeNull();
  });

  it('worklet 舊 epoch 的 clock 與 ended 被丟棄', async () => {
    const { engine, deps } = await loaded({ paused: false });
    const oldEpoch = deps.audio.epoch;
    const seeking = engine.seek(2);
    deps.audio.reply({
      type: 'clock',
      epoch: oldEpoch,
      position: 9,
      frame: 0,
      buffered: 0,
      underruns: 0,
    });
    deps.audio.reply({ type: 'ended', epoch: oldEpoch });
    expect(engine.currentTime).toBe(2);

    deps.audio.reply({ type: 'playing' });
    await seeking;
    deps.audio.reply({ type: 'ended', epoch: oldEpoch });
    expect(engine.state).toBe('playing');
  });
});

describe('destroy', () => {
  it('load 執行中 destroy：AbortError → terminate Worker → 斷開 worklet → 關閉 AudioContext', async () => {
    const { engine, deps } = setup();
    const loading = engine.load(source);
    const seeking = engine.seek(3);
    const worker = deps.workers.last;
    await worker.next('load');

    const destroying = engine.destroy();
    expect(engine.destroy()).toBe(destroying);
    await expect(rejection(loading)).resolves.toEqual(abortError);
    await expect(rejection(seeking)).resolves.toEqual(abortError);
    await destroying;

    expect(worker.terminated).toBe(true);
    expect(deps.audio.calls).toEqual(['connect', 'disconnect', 'close']);
    expect(engine.state).toBe('idle');
  });

  it('seek 執行中 destroy：seek 以 AbortError reject，之後 worklet 的回報不改變狀態', async () => {
    const { engine, deps, worker } = await loaded();
    const seeking = engine.seek(3);
    await engine.destroy();

    await expect(rejection(seeking)).resolves.toEqual(abortError);
    expect(worker.terminated).toBe(true);
    deps.audio.reply({ type: 'playing' });
    expect(engine.state).toBe('idle');
  });

  it('destroy 之後的指令都 reject DESTROYED，play／pause 不改變播放意圖', async () => {
    const { engine } = await loaded();
    await engine.destroy();
    const events = recordEvents(engine);

    for (const command of [
      () => engine.load(source),
      () => engine.play(),
      () => engine.pause(),
      () => engine.seek(1),
    ]) {
      await expect(rejection(command())).resolves.toMatchObject({
        name: 'EngineError',
        code: 'DESTROYED',
      });
    }
    expect(engine.paused).toBe(true);
    expect(events).toEqual([]);
  });
});

describe('播放中的讀取錯誤', () => {
  it('fatal：state 進入 error，error 帶 code、detail 與發生時的 position', async () => {
    const { engine, deps, worker } = await loaded({ paused: false });
    deps.audio.reply({ type: 'clock', position: 3.25, frame: 0, buffered: 0, underruns: 0 });
    const errors: unknown[] = [];
    engine.addEventListener('error', (event) => errors.push(event.error));

    worker.reply({
      type: 'error',
      epoch: deps.audio.epoch,
      error: {
        code: 'SOURCE_UNAUTHORIZED',
        fatal: true,
        message: 'HTTP 401',
        detail: { status: 401, url: 'https://example.test/a.m4a' },
      },
    });

    expect(engine.state).toBe('error');
    expect(engine.error).toMatchObject({
      name: 'EngineError',
      code: 'SOURCE_UNAUTHORIZED',
      fatal: true,
      position: 3.25,
      detail: { status: 401, url: 'https://example.test/a.m4a' },
    });
    expect(errors).toEqual([engine.error]);
  });
});

describe('Worker 崩潰', () => {
  it('播放中 onerror：state 進入 error，回報帶 position 的 fatal INTERNAL，不自動 reload', async () => {
    const { engine, deps, worker } = await loaded({ paused: false });
    deps.audio.reply({ type: 'clock', position: 4.5, frame: 0, buffered: 0, underruns: 0 });
    const errors: unknown[] = [];
    engine.addEventListener('error', (event) => errors.push(event.error));
    const pausing = engine.pause();

    worker.crash();

    expect(engine.state).toBe('error');
    expect(engine.error).toMatchObject({ code: 'INTERNAL', fatal: true, position: 4.5 });
    expect(errors).toEqual([engine.error]);
    expect(worker.terminated).toBe(true);
    expect(deps.workers.created).toHaveLength(1);
    await expect(rejection(pausing)).resolves.toBe(engine.error);
  });

  it('load 執行中的 crash 訊息讓 load 以 INTERNAL reject', async () => {
    const { engine, deps } = setup();
    const loading = engine.load(source);
    const worker = deps.workers.last;
    await worker.next('load');

    worker.reply({ type: 'crash', reason: 'out-of-memory', message: 'MAXIMUM_MEMORY' });

    await expect(rejection(loading)).resolves.toMatchObject({ code: 'INTERNAL', fatal: true });
    expect(engine.state).toBe('error');
  });

  it('Worker 回報 fatal 錯誤時以原錯誤碼 reject load', async () => {
    const { engine, deps } = setup();
    const loading = engine.load(source);
    const worker = deps.workers.last;
    const load = await worker.next('load');

    worker.reply({
      type: 'error',
      epoch: load.epoch,
      error: { code: 'FORMAT_UNSUPPORTED', fatal: true, message: 'probe 失敗' },
    });

    await expect(rejection(loading)).resolves.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
    expect(engine.error?.code).toBe('FORMAT_UNSUPPORTED');
  });

  it('error 之後可以重新 load', async () => {
    const { engine, deps, worker } = await loaded();
    worker.crash();
    const loading = engine.load(source);
    expect(engine.error).toBeNull();

    await deps.workers.last.probe(audioMedia());
    await deps.workers.last.next('start');
    deps.audio.reply({ type: 'paused' });
    await loading;
    expect(engine.state).toBe('ready');
  });
});

describe('播放意圖', () => {
  it('play()／pause() 在呼叫內同步發出 statechange（state 沒變時 state === previous）', async () => {
    const { engine, deps } = await loaded();
    const changes: StateChangeEvent[] = [];
    engine.addEventListener('statechange', (event) => changes.push(event));

    const playing = engine.play();
    expect(engine.paused).toBe(false);
    expect(changes).toMatchObject([
      { state: 'ready', previous: 'ready', paused: false, reason: 'command' },
    ]);
    // AudioContext 開始之後才叫 worklet 播放。
    await flush();
    expect(deps.audio.received.at(-1)).toEqual({ type: 'play', epoch: deps.audio.epoch });

    deps.audio.reply({ type: 'playing' });
    await playing;
    expect(engine.state).toBe('playing');

    const pausing = engine.pause();
    expect(changes.at(-1)).toMatchObject({
      state: 'playing',
      previous: 'playing',
      paused: true,
      reason: 'command',
    });
    deps.audio.reply({ type: 'paused' });
    await pausing;
    expect(engine.state).toBe('paused');
  });

  it('play 與 pause 互相取代', async () => {
    const { engine, deps } = await loaded();
    const playing = engine.play();
    const pausing = engine.pause();

    await expect(rejection(playing)).resolves.toEqual(abortError);
    await pausing;
    expect(engine.state).toBe('ready');
    // AudioContext 開始時播放意圖已經是暫停：worklet 不曾被叫去播放。
    expect(deps.audio.received.map((m) => m.type)).not.toContain('play');
    expect(deps.audio.intent).toBe('pause');

    const playingAgain = engine.play();
    const pausingAgain = engine.pause();
    const lastPlay = engine.play();
    await expect(rejection(playingAgain)).resolves.toEqual(abortError);
    await expect(rejection(pausingAgain)).resolves.toEqual(abortError);
    deps.audio.reply({ type: 'playing' });
    await lastPlay;
    expect(engine.state).toBe('playing');
  });

  it('load({ paused: false }) resolve 時已在 playing', async () => {
    const { engine } = await loaded({ paused: false });
    expect(engine.state).toBe('playing');
    expect(engine.paused).toBe(false);
  });

  it('seek 期間 pause()：seek 結束於 paused，pause 接著 resolve', async () => {
    const { engine, deps } = await loaded({ paused: false });
    const order: string[] = [];
    void engine.seek(3).then(() => order.push('seek'));
    void engine.pause().then(() => order.push('pause'));

    deps.audio.reply({ type: 'paused' });
    await flush();
    expect(order).toEqual(['seek', 'pause']);
    expect(engine.state).toBe('paused');
  });

  it('沒有媒體時 play() 與 seek() reject InvalidStateError，pause() 立即 resolve', async () => {
    const { engine } = setup();
    await expect(rejection(engine.play())).resolves.toMatchObject({ name: 'InvalidStateError' });
    await expect(rejection(engine.seek(1))).resolves.toMatchObject({ name: 'InvalidStateError' });
    await expect(engine.pause()).resolves.toBeUndefined();
  });

  it('worklet starved 時進入 buffering，補回後回到 playing', async () => {
    const { engine, deps } = await loaded({ paused: false });
    deps.audio.reply({ type: 'starved' });
    expect(engine.state).toBe('buffering');
    deps.audio.reply({ type: 'playing' });
    expect(engine.state).toBe('playing');
  });
});

describe('ended', () => {
  it('播到結尾時 paused 維持 false，並發出 ended', async () => {
    const { engine, deps } = await loaded({ paused: false });
    const events = recordEvents(engine);

    deps.audio.reply({ type: 'ended' });

    expect(engine.state).toBe('ended');
    expect(engine.paused).toBe(false);
    expect(engine.currentTime).toBe(10);
    expect(events).toEqual(['statechange:ended', 'ended']);
  });

  it('ended 時 play() 從頭播放', async () => {
    const { engine, deps, worker } = await loaded({ paused: false });
    deps.audio.reply({ type: 'ended' });

    const playing = engine.play();
    const seek = await worker.next('seek');
    expect(seek.time).toBe(0);
    expect(engine.state).toBe('seeking');

    deps.audio.reply({ type: 'playing' });
    await playing;
    expect(engine.state).toBe('playing');
    expect(engine.currentTime).toBe(0);
  });

  it('ended 時 pause() 只改變播放意圖', async () => {
    const { engine, deps } = await loaded({ paused: false });
    deps.audio.reply({ type: 'ended' });
    await engine.pause();
    expect(engine.state).toBe('ended');
    expect(engine.paused).toBe(true);
  });
});

describe('review 發現的競態', () => {
  it('load 完成後、resolve 前的 microtask 內呼叫 load()：新的 load 不受舊 load 的後續影響', async () => {
    const { engine, deps } = setup();
    const first = engine.load(source);
    let second: Promise<unknown> | undefined;
    engine.addEventListener('statechange', (event) => {
      if (event.state === 'ready' && !second) {
        queueMicrotask(() => {
          second = engine.load(source);
        });
      }
    });
    await deps.workers.last.probe(audioMedia());
    await deps.workers.last.next('start');
    deps.audio.reply({ type: 'paused' });
    await first.catch(() => undefined);

    const worker = deps.workers.last;
    expect(deps.workers.created).toHaveLength(2);
    const seeking = engine.seek(3);
    await worker.probe(audioMedia());
    expect((await worker.next('start')).time).toBe(3);
    deps.audio.reply({ type: 'paused' });
    await expect(second).resolves.toMatchObject({ duration: 10 });
    await expect(seeking).resolves.toBe(3);
  });

  it('ready 的 statechange listener 內呼叫 seek()：照一般的 seek 執行', async () => {
    const { engine, deps } = setup();
    const loading = engine.load(source);
    let seeking: Promise<number> | undefined;
    engine.addEventListener('statechange', (event) => {
      if (event.state === 'ready' && !seeking) seeking = engine.seek(5);
    });
    const worker = deps.workers.last;
    await worker.probe(audioMedia());
    await worker.next('start');
    deps.audio.reply({ type: 'paused' });
    await loading;

    expect(engine.state).toBe('seeking');
    expect((await worker.next('seek')).time).toBe(5);
    deps.audio.reply({ type: 'paused' });
    await expect(seeking).resolves.toBe(5);
  });

  it('取代排隊中的 seek 時，新的 seek 排在佇列尾端，維持呼叫順序', async () => {
    const { engine, deps } = await loaded();
    const order: string[] = [];
    void engine.play().then(() => order.push('play 1'));
    engine.seek(1).catch(() => order.push('seek 1 aborted'));
    void engine.play().then(() => order.push('play 2'));
    void engine.seek(2).then(() => order.push('seek 2'));

    deps.audio.reply({ type: 'playing' });
    await flush();
    deps.audio.reply({ type: 'playing' });
    await flush();
    expect(order).toEqual(['seek 1 aborted', 'play 1', 'play 2', 'seek 2']);
  });

  it('destroy 之後媒體鏡像清空', async () => {
    const { engine, worker } = await loaded();
    worker.crash();
    await engine.destroy();
    expect(engine.state).toBe('idle');
    expect(engine.error).toBeNull();
    expect(engine.media).toBeNull();
    expect(engine.tracks).toEqual([]);
    expect(engine.duration).toBeNaN();
    expect(engine.selectedTracks).toEqual({ audio: null, video: null, subtitle: null });
  });
});

describe('其餘指令的競態', () => {
  it('play、pause 執行中 destroy：以 AbortError reject', async () => {
    const { engine } = await loaded({ paused: false });
    const pausing = engine.pause();
    await engine.destroy();
    await expect(rejection(pausing)).resolves.toEqual(abortError);

    const other = await loaded();
    const playing = other.engine.play();
    await other.engine.destroy();
    await expect(rejection(playing)).resolves.toEqual(abortError);
  });

  it('seek、play 執行中 Worker 崩潰：以 INTERNAL reject', async () => {
    const { engine, worker } = await loaded();
    const seeking = engine.seek(4);
    const playing = engine.play();
    worker.crash();
    await expect(rejection(seeking)).resolves.toMatchObject({ code: 'INTERNAL' });
    await expect(rejection(playing)).resolves.toMatchObject({ code: 'INTERNAL' });
  });
});

describe('同步事件 listener 內的重入', () => {
  it('loading 的 statechange listener 內 destroy()：不再建立 Worker 與音訊輸出', async () => {
    const { engine, deps } = setup();
    engine.addEventListener('statechange', (event) => {
      if (event.state === 'loading') void engine.destroy();
    });

    const loading = engine.load(source);

    await expect(rejection(loading)).resolves.toEqual(abortError);
    expect(engine.state).toBe('idle');
    expect(deps.workers.created).toEqual([]);
    expect(deps.audioCreated).toBe(0);
  });

  it('load 完成時的 durationchange listener 內 load(B)：B 不被舊 load 的完成覆寫', async () => {
    const { engine, deps } = setup();
    const first = engine.load(source);
    let second: Promise<unknown> | undefined;
    engine.addEventListener('durationchange', (event) => {
      if (event.duration === 10 && !second) second = engine.load(source);
    });
    const oldWorker = deps.workers.last;
    await oldWorker.probe(audioMedia());
    await oldWorker.next('start');

    deps.audio.reply({ type: 'paused' });

    await expect(rejection(first)).resolves.toEqual(abortError);
    expect(engine.state).toBe('loading');
    const worker = deps.workers.last;
    expect(worker).not.toBe(oldWorker);
    await worker.probe(audioMedia({ duration: 20 }));
    await worker.next('start');
    deps.audio.reply({ type: 'paused' });
    await expect(second).resolves.toMatchObject({ duration: 20 });
    expect(engine.state).toBe('ready');
    expect(engine.media?.duration).toBe(20);
  });

  it('play() 的 statechange listener 內 pause()：較新的 pause 取代 play', async () => {
    const { engine, deps } = await loaded();
    let inner: Promise<void> | undefined;
    engine.addEventListener('statechange', (event) => {
      if (!event.paused && !inner) inner = engine.pause();
    });

    const outer = engine.play();

    await expect(rejection(outer)).resolves.toEqual(abortError);
    await expect(inner).resolves.toBeUndefined();
    expect(engine.paused).toBe(true);
    expect(deps.audio.received.map((m) => m.type)).not.toContain('play');
    expect(deps.audio.intent).toBe('pause');
  });

  it('pause() 的 statechange listener 內 play()：較新的 play 取代 pause', async () => {
    const { engine, deps } = await loaded({ paused: false });
    let inner: Promise<void> | undefined;
    engine.addEventListener('statechange', (event) => {
      if (event.paused && !inner) inner = engine.play();
    });

    const outer = engine.pause();

    await expect(rejection(outer)).resolves.toEqual(abortError);
    await expect(inner).resolves.toBeUndefined();
    expect(engine.paused).toBe(false);
    expect(deps.audio.received.slice(-2).map((m) => m.type)).toEqual(['pause', 'play']);
  });

  it('seek 完成的 statechange listener 內再 seek：不以新的目標提前發出 seeked', async () => {
    const { engine, deps } = await loaded();
    const seeked: number[] = [];
    engine.addEventListener('seeked', (event) => seeked.push(event.currentTime));
    const first = engine.seek(2);
    let second: Promise<number> | undefined;
    engine.addEventListener('statechange', (event) => {
      if (event.previous === 'seeking' && !second) second = engine.seek(7);
    });

    deps.audio.reply({ type: 'paused' });

    await expect(rejection(first)).resolves.toEqual(abortError);
    expect(engine.state).toBe('seeking');
    expect(seeked).toEqual([]);
    deps.audio.reply({ type: 'paused' });
    await expect(second).resolves.toBe(7);
    expect(seeked).toEqual([7]);
  });

  it('ended 的 statechange listener 內 load()：不再為舊媒體發出 ended', async () => {
    const { engine, deps } = await loaded({ paused: false });
    const ended: Event[] = [];
    engine.addEventListener('ended', (event) => ended.push(event));
    engine.addEventListener('statechange', (event) => {
      if (event.state === 'ended') void engine.load(source).catch(() => undefined);
    });

    deps.audio.reply({ type: 'ended' });

    expect(ended).toEqual([]);
    expect(engine.state).toBe('loading');
  });

  it('error 的 statechange listener 內 load()：不再為舊媒體發出 error，新的 load 不被覆寫', async () => {
    const { engine, worker } = await loaded();
    const errors: unknown[] = [];
    engine.addEventListener('error', (event) => errors.push(event.error));
    engine.addEventListener('statechange', (event) => {
      if (event.state === 'error') void engine.load(source).catch(() => undefined);
    });

    worker.crash();

    expect(errors).toEqual([]);
    expect(engine.state).toBe('loading');
    expect(engine.error).toBeNull();
  });
});

describe('音訊輸出', () => {
  it('以補上預設值的 audioBuffer 與 workletUrl 建立', async () => {
    const deps = createFakeDeps();
    const engine = createEngineWith(deps, {
      audioBuffer: { targetMs: 200 },
      assets: { workletUrl: '/worklet.js' },
    });
    void engine.load(source);
    await deps.workers.last.next('load');
    expect(deps.audio.config).toEqual({
      audioBuffer: { targetMs: 200, refillMs: 75, capacityMs: 400 },
      audioFadeMs: 10,
      workletUrl: '/worklet.js',
    });
  });

  it('probe 之後、start 之前把 duration 告訴 worklet', async () => {
    const { engine, deps } = setup();
    void engine.load(source, { startTime: 30 });
    const worker = deps.workers.last;
    await worker.probe(audioMedia({ duration: 10 }));
    const start = await worker.next('start');
    // 起點被 duration 夾住而換了 epoch：duration 帶新的 epoch，排在 flush 之後。
    expect(deps.audio.received.slice(-2)).toEqual([
      { type: 'flush', epoch: start.epoch, position: 10 },
      { type: 'duration', epoch: start.epoch, duration: 10 },
    ]);
  });
});

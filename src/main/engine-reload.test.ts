// reload() 與 seek 的其餘行為（#37）：以假 media Worker 與假音訊輸出驅動 createEngineWith()。

import { describe, expect, it } from 'vitest';
import { createFakeDeps, type FakeEngineDeps } from '../../test/fakes/engine-deps.js';
import { audioMedia } from '../../test/fakes/media-worker.js';
import type { ProbedMedia } from '../protocol/index.js';
import { createEngineWith } from './engine.js';
import type { TimeUpdateEvent } from './events.js';
import type { Engine, Source } from './types.js';

const source: Source = { kind: 'http', url: 'https://example.test/a.mkv' };

/** 兩條音軌（stream 0 英語、stream 1 日語）的媒體。 */
function twoAudioTracks(overrides: Partial<ProbedMedia> = {}): ProbedMedia {
  const base = audioMedia();
  const [track] = base.tracks;
  if (track?.kind !== 'audio') throw new Error('unreachable');
  return {
    ...base,
    format: 'matroska,webm',
    tracks: [
      { ...track, streamIndex: 0, language: 'en' },
      { ...track, streamIndex: 1, codec: 'opus', language: 'ja', default: false },
    ],
    ...overrides,
  };
}

/** load 到 ready（`paused: false` 時到 playing）；預設選日語音軌。 */
async function loaded(options: { paused?: boolean; media?: ProbedMedia } = {}) {
  const deps = createFakeDeps();
  const engine = createEngineWith(deps, { preferredLanguages: { audio: ['ja'] } });
  const loading = engine.load(source, { paused: options.paused ?? true });
  const worker = deps.workers.last;
  await worker.probe(options.media ?? twoAudioTracks());
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

function clock(deps: FakeEngineDeps, position: number): void {
  deps.audio.reply({ type: 'clock', position, frame: 0, buffered: 0, underruns: 0 });
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

describe('reload', () => {
  it('以同一份來源開新的 Worker，保留位置、paused、軌道選擇與 track id，不發出 trackschange', async () => {
    const { engine, deps, worker } = await loaded();
    const seeking = engine.seek(4);
    deps.audio.reply({ type: 'paused' });
    await seeking;
    const tracks = engine.tracks;
    const selected = engine.selectedTracks;
    expect(selected.audio).toBe(tracks[1]?.id);
    const events = recordEvents(engine);

    const reloading = engine.reload();
    expect(engine.state).toBe('loading');
    expect(worker.terminated).toBe(true);
    const next = deps.workers.last;
    expect(next).not.toBe(worker);
    expect((await next.next('load')).source).toEqual({ kind: 'http', url: source.url });
    await next.probe(twoAudioTracks());
    expect(await next.next('start')).toMatchObject({ time: 4, audio: 1 });
    deps.audio.reply({ type: 'paused' });
    const info = await reloading;

    expect(info.tracks).toBe(tracks);
    expect(engine.tracks).toBe(tracks);
    expect(engine.selectedTracks).toEqual(selected);
    expect(engine.currentTime).toBe(4);
    expect(engine.paused).toBe(true);
    expect(engine.state).toBe('ready');
    expect(events).toEqual(['statechange:loading', 'statechange:ready']);
  });

  it('播放中 reload：從原本的位置接續播放', async () => {
    const { engine, deps } = await loaded({ paused: false });
    clock(deps, 3.25);

    const reloading = engine.reload();
    expect(engine.paused).toBe(false);
    const worker = deps.workers.last;
    await worker.probe(twoAudioTracks());
    expect((await worker.next('start')).time).toBe(3.25);
    expect(deps.audio.received.filter((m) => m.type === 'flush').at(-1)).toMatchObject({
      position: 3.25,
    });
    deps.audio.reply({ type: 'playing' });
    await reloading;
    expect(engine.state).toBe('playing');
  });

  it('error 之後 reload：從 error.position 接續，error 清掉', async () => {
    const { engine, deps, worker } = await loaded({ paused: false });
    clock(deps, 4.5);
    worker.crash();
    expect(engine.error?.position).toBe(4.5);

    const reloading = engine.reload();
    expect(engine.error).toBeNull();
    const next = deps.workers.last;
    await next.probe(twoAudioTracks());
    expect((await next.next('start')).time).toBe(4.5);
    deps.audio.reply({ type: 'playing' });
    await reloading;
    expect(engine.state).toBe('playing');
  });

  it('沒有完成過的 load 失敗之後 reload：以同樣的來源與選項重新 load', async () => {
    const deps = createFakeDeps();
    const engine = createEngineWith(deps);
    const loading = engine.load(source, { startTime: 2 });
    const worker = deps.workers.last;
    const load = await worker.next('load');
    worker.reply({
      type: 'error',
      epoch: load.epoch,
      error: { code: 'SOURCE_UNAUTHORIZED', fatal: true, message: '401' },
    });
    await expect(rejection(loading)).resolves.toMatchObject({ code: 'SOURCE_UNAUTHORIZED' });

    const reloading = engine.reload();
    const next = deps.workers.last;
    expect((await next.next('load')).source).toEqual({ kind: 'http', url: source.url });
    await next.probe(audioMedia());
    expect((await next.next('start')).time).toBe(2);
    deps.audio.reply({ type: 'paused' });
    await expect(reloading).resolves.toMatchObject({ duration: 10 });
    expect(engine.tracks).toHaveLength(1);
  });

  it('軌道的組成與先前不同時 reject 致命的 SOURCE_CHANGED', async () => {
    const { engine, deps } = await loaded();
    const tracks = engine.tracks;

    const reloading = engine.reload();
    await deps.workers.last.probe(audioMedia());

    await expect(rejection(reloading)).resolves.toMatchObject({
      name: 'EngineError',
      code: 'SOURCE_CHANGED',
      fatal: true,
    });
    expect(engine.state).toBe('error');
    expect(engine.error?.code).toBe('SOURCE_CHANGED');
    expect(engine.tracks).toBe(tracks);
    expect(deps.workers.last.terminated).toBe(true);
  });

  it('codec 不同也是 SOURCE_CHANGED', async () => {
    const { engine, deps } = await loaded();
    const reloading = engine.reload();
    const media = twoAudioTracks();
    await deps.workers.last.probe({
      ...media,
      tracks: media.tracks.map((t) => (t.streamIndex === 1 ? { ...t, codec: 'vorbis' } : t)),
    });
    await expect(rejection(reloading)).resolves.toMatchObject({ code: 'SOURCE_CHANGED' });
  });

  it('duration 改變時更新並發出 durationchange，track id 仍不變', async () => {
    const { engine, deps } = await loaded();
    const tracks = engine.tracks;
    const events = recordEvents(engine);
    const reloading = engine.reload();
    await deps.workers.last.probe(twoAudioTracks({ duration: 10.5 }));
    await deps.workers.last.next('start');
    deps.audio.reply({ type: 'paused' });
    await reloading;
    expect(engine.duration).toBe(10.5);
    expect(engine.tracks).toBe(tracks);
    expect(events).toEqual(['statechange:loading', 'durationchange', 'statechange:ready']);
  });

  it('reload 期間的 seek 改寫起點，與 reload 一起 resolve', async () => {
    const { engine, deps } = await loaded();
    const reloading = engine.reload();
    const seeking = engine.seek(7);
    expect(engine.currentTime).toBe(7);
    const worker = deps.workers.last;
    await worker.probe(twoAudioTracks());
    expect((await worker.next('start')).time).toBe(7);
    deps.audio.reply({ type: 'paused' });
    await expect(seeking).resolves.toBe(7);
    await reloading;
    expect(engine.currentTime).toBe(7);
  });

  it('reload 取代執行中與排隊中的指令', async () => {
    const { engine, deps } = await loaded();
    const seeking = engine.seek(5);
    const playing = engine.play();
    const reloading = engine.reload();
    await expect(rejection(seeking)).resolves.toEqual(abortError);
    await expect(rejection(playing)).resolves.toEqual(abortError);
    // play() 已經把播放意圖改為播放：reload 保留它。
    expect(engine.paused).toBe(false);
    await deps.workers.last.probe(twoAudioTracks());
    deps.audio.reply({ type: 'playing' });
    await reloading;
    expect(engine.state).toBe('playing');
  });

  it('被新的 load 取代時 reject AbortError', async () => {
    const { engine, deps } = await loaded();
    const reloading = engine.reload();
    const reloadWorker = deps.workers.last;
    const loading = engine.load({ kind: 'bytes', data: new Uint8Array(4) });
    await expect(rejection(reloading)).resolves.toEqual(abortError);
    expect(reloadWorker.terminated).toBe(true);
    await deps.workers.last.probe(audioMedia());
    deps.audio.reply({ type: 'paused' });
    await loading;
    // 之後的 reload 用新的來源。
    void engine.reload();
    expect((await deps.workers.last.next('load')).source).toEqual({
      kind: 'bytes',
      data: new Uint8Array(4),
    });
  });

  it('執行中 destroy：reject AbortError，Worker 被 terminate', async () => {
    const { engine, deps } = await loaded();
    const reloading = engine.reload();
    const worker = deps.workers.last;
    await worker.next('load');
    await engine.destroy();
    await expect(rejection(reloading)).resolves.toEqual(abortError);
    expect(worker.terminated).toBe(true);
    expect(engine.state).toBe('idle');
    await expect(rejection(engine.reload())).resolves.toMatchObject({ code: 'DESTROYED' });
  });

  it('執行中 Worker 崩潰：reject INTERNAL，state 進入 error', async () => {
    const { engine, deps } = await loaded();
    const reloading = engine.reload();
    const worker = deps.workers.last;
    await worker.next('load');
    worker.crash();
    await expect(rejection(reloading)).resolves.toMatchObject({ code: 'INTERNAL', fatal: true });
    expect(engine.state).toBe('error');
  });

  it('沒有載入過媒體時 reject InvalidStateError', async () => {
    const engine = createEngineWith(createFakeDeps());
    await expect(rejection(engine.reload())).resolves.toMatchObject({
      name: 'InvalidStateError',
    });
  });
});

describe('seek 的其餘行為', () => {
  it('ended 之後 seek：從新的位置播放', async () => {
    const { engine, deps, worker } = await loaded({ paused: false });
    deps.audio.reply({ type: 'ended' });
    const seeking = engine.seek(3);
    expect((await worker.next('seek')).time).toBe(3);
    expect(engine.state).toBe('seeking');
    deps.audio.reply({ type: 'playing' });
    await expect(seeking).resolves.toBe(3);
    expect(engine.state).toBe('playing');
    expect(engine.currentTime).toBe(3);
  });

  it('seeked 之後補發一次落點的 timeupdate', async () => {
    const { engine, deps } = await loaded();
    const log: string[] = [];
    engine.addEventListener('seeked', (event) => log.push(`seeked ${String(event.currentTime)}`));
    engine.addEventListener('timeupdate', (event: TimeUpdateEvent) =>
      log.push(`timeupdate ${String(event.currentTime)}`),
    );
    const seeking = engine.seek(6);
    deps.audio.reply({ type: 'paused' });
    await seeking;
    expect(log).toEqual(['seeked 6', 'timeupdate 6']);
  });
});

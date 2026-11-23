// 外掛音軌與音軌 offset（#53）：addExternalAudio()、removeExternalAudio()、setAudioOffset() 的協定、選軌、4 條上限、
// reload() 的保留，以及被取代、執行中 destroy、Worker 崩潰的競態。以假 media Worker 驅動 createEngineWith()。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeDeps, type FakeEngineDeps } from '../../test/fakes/engine-deps.js';
import { audioMedia, type FakeMediaWorker } from '../../test/fakes/media-worker.js';
import { frame, videoTrack } from '../../test/fakes/video.js';
import type { ProbedAudioTrack, ProbedMedia } from '../protocol/index.js';
import { createEngineWith } from './engine.js';
import { EngineError } from './errors.js';
import type { TracksChangeEvent } from './events.js';
import type { Engine, LoadOptions, Source } from './types.js';

const source: Source = { kind: 'http', url: 'https://example.test/a.mkv' };
const dub: Source = { kind: 'http', url: 'https://example.test/dub.flac' };

const [firstAudio] = audioMedia().tracks as [ProbedAudioTrack];
/** stream 0：AAC（default）；stream 1：H.264；stream 2：Opus。 */
const audioMain: ProbedAudioTrack = { ...firstAudio, language: 'ja' };
const audioSecond: ProbedAudioTrack = {
  ...firstAudio,
  streamIndex: 2,
  codec: 'opus',
  default: false,
};
const media: ProbedMedia = audioMedia({ tracks: [audioMain, videoTrack, audioSecond] });
/** track id 依 probe 的順序：a:1、v:2、a:3；之後的外掛音軌接著編號。 */
const id = { audioMain: 'a:1', video: 'v:2', audioSecond: 'a:3' };

/** 外掛來源 probe 到的音軌（FLAC，在它自己的來源內是 stream 0）。 */
const externalTrack: ProbedAudioTrack = {
  kind: 'audio',
  streamIndex: 0,
  codec: 'flac',
  supported: true,
  default: false,
  forced: false,
  sampleRate: 48_000,
  channels: 2,
  title: 'from file',
};

interface Loaded {
  engine: Engine;
  deps: FakeEngineDeps;
  worker: FakeMediaWorker;
  changes: TracksChangeEvent[];
}

async function loaded(options: LoadOptions = {}): Promise<Loaded> {
  const deps = createFakeDeps();
  const engine = createEngineWith(deps);
  const loading = engine.load(source, options);
  const worker = deps.workers.last;
  await worker.probe(media);
  await worker.next('start');
  frame(worker, 0);
  deps.audio.reply({ type: options.paused === false ? 'playing' : 'paused' });
  await loading;
  const changes: TracksChangeEvent[] = [];
  engine.addEventListener('trackschange', (e) => changes.push(e));
  return { engine, deps, worker, changes };
}

/** 新的輸出備妥：影片的第一張 frame 與 worklet 的回報。 */
function outputReady(loaded: Loaded, output: 'paused' | 'playing' = 'paused'): void {
  frame(loaded.worker, loaded.engine.currentTime);
  loaded.deps.audio.reply({ type: output });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** 指令的結果，不讓 rejection 變成 unhandled。 */
function outcome<T>(promise: Promise<T>): { value: () => T | Error | undefined } {
  let result: T | Error | undefined;
  promise.then(
    (v) => (result = v),
    (e: unknown) => (result = e as Error),
  );
  return { value: () => result };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('setAudioOffset()', () => {
  it('沒有選用的軌：只記下 offset 並發出 trackschange，不重新供料', async () => {
    const { engine, worker, changes } = await loaded();
    await engine.setAudioOffset(id.audioSecond, 0.5);
    expect(engine.tracks.find((t) => t.id === id.audioSecond)).toMatchObject({ offset: 0.5 });
    expect(engine.tracks.find((t) => t.id === id.audioMain)).toMatchObject({ offset: 0 });
    expect(changes).toHaveLength(1);
    expect(worker.messages('select')).toHaveLength(0);
    expect(engine.state).toBe('ready');
  });

  it('選用中的軌：以新的 epoch 從目前位置重新供料，短暫 seeking；生效之後才改 tracks 並發出 trackschange', async () => {
    const l = await loaded();
    const { engine, deps, worker, changes } = l;
    const states: string[] = [];
    engine.addEventListener('statechange', (e) => states.push(e.state));

    const setting = outcome(engine.setAudioOffset(id.audioMain, -0.25));
    const select = await worker.next('select');
    expect(select).toMatchObject({ time: 0, audio: 0, video: 1, audioOffset: -0.25 });
    expect(select.audioSource).toBeUndefined();
    expect(deps.audio.epoch).toBe(select.epoch);
    expect(engine.state).toBe('seeking');
    expect(engine.tracks.find((t) => t.id === id.audioMain)).toMatchObject({ offset: 0 });

    outputReady(l);
    await settle();
    expect(setting.value()).toBeUndefined();
    expect(engine.state).toBe('ready');
    expect(states).toEqual(['seeking', 'ready']);
    expect(engine.tracks.find((t) => t.id === id.audioMain)).toMatchObject({ offset: -0.25 });
    expect(changes).toHaveLength(1);

    // 之後的 seek 沿用 offset（Worker 記住 select 的選擇）；換到這條軌時也帶著它。
    await engine.setAudioOffset(id.audioSecond, 1);
    const selecting = engine.selectTracks({ audio: id.audioSecond });
    expect(await worker.next('select', 2)).toMatchObject({ audio: 2, audioOffset: 1 });
    outputReady(l);
    await selecting;
  });

  it('offset 為 0 時 select 不帶 audioOffset；值與目前相同時什麼都不做', async () => {
    const l = await loaded();
    await l.engine.setAudioOffset(id.audioMain, 0);
    expect(l.worker.messages('select')).toHaveLength(0);
    expect(l.changes).toHaveLength(0);
  });

  it('不是有限數時 reject TypeError；不存在或不是音軌的 id 時 reject RangeError', async () => {
    const { engine } = await loaded();
    await expect(engine.setAudioOffset(id.audioMain, Number.NaN)).rejects.toThrow(TypeError);
    await expect(engine.setAudioOffset(id.audioMain, Infinity)).rejects.toThrow(TypeError);
    await expect(engine.setAudioOffset('a:99', 1)).rejects.toThrow(RangeError);
    await expect(engine.setAudioOffset(id.video, 1)).rejects.toThrow(RangeError);
  });

  it('沒有媒體：reject InvalidStateError', async () => {
    const engine = createEngineWith(createFakeDeps());
    await expect(engine.setAudioOffset(id.audioMain, 1)).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
  });
});

/** 回覆第 `count` 個 `addaudio`（probe 成功），回傳它的 id。 */
async function probeExternal(
  worker: FakeMediaWorker,
  count = 1,
  track: ProbedAudioTrack = externalTrack,
): Promise<string> {
  const add = await worker.next('addaudio', count);
  worker.reply({ type: 'audioprobe', id: add.id, track });
  return add.id;
}

describe('addExternalAudio()', () => {
  it('在 Worker 內開新的來源並 probe，resolve origin external 的 AudioTrack；不自動選用', async () => {
    const { engine, worker, changes } = await loaded();
    const adding = engine.addExternalAudio(dub, { offset: 0.5, label: '日配' });
    const add = await worker.next('addaudio');
    expect(add).toMatchObject({ id: 'ext:4', source: { kind: 'http', url: dub.url } });
    worker.reply({ type: 'audioprobe', id: add.id, track: externalTrack });
    const track = await adding;
    expect(track).toMatchObject({
      kind: 'audio',
      id: 'ext:4',
      origin: 'external',
      streamIndex: 0,
      codec: 'flac',
      offset: 0.5,
      title: '日配',
    });
    expect(engine.tracks.at(-1)).toEqual(track);
    expect(engine.selectedTracks.audio).toBe(id.audioMain);
    expect(changes).toHaveLength(1);
    expect(worker.messages('select')).toHaveLength(0);
  });

  it('沒有 label 時沿用來源的 title，offset 預設 0', async () => {
    const { engine, worker } = await loaded();
    const adding = engine.addExternalAudio(dub);
    await probeExternal(worker);
    expect(await adding).toMatchObject({ title: 'from file', offset: 0 });
  });

  it('selectTracks() 切過去：select 帶外掛音軌的 id 與 offset', async () => {
    const l = await loaded();
    const adding = l.engine.addExternalAudio(dub, { offset: -0.3 });
    await probeExternal(l.worker);
    const track = await adding;
    const selecting = l.engine.selectTracks({ audio: track.id });
    expect(await l.worker.next('select')).toMatchObject({
      audio: 0,
      audioSource: track.id,
      audioOffset: -0.3,
      video: 1,
    });
    outputReady(l);
    await selecting;
    expect(l.engine.selectedTracks.audio).toBe(track.id);
  });

  it('載入失敗：reject 非致命的 EngineError，軌道不變、主媒體繼續', async () => {
    const { engine, worker, changes } = await loaded();
    const adding = engine.addExternalAudio(dub);
    const add = await worker.next('addaudio');
    worker.reply({
      type: 'audioerror',
      id: add.id,
      error: { code: 'SOURCE_NOT_FOUND', fatal: true, message: 'HTTP 404' },
    });
    const error = await adding.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ code: 'SOURCE_NOT_FOUND', fatal: false });
    expect(engine.tracks).toHaveLength(3);
    expect(changes).toHaveLength(0);
    expect(engine.state).toBe('ready');
    expect(engine.error).toBeNull();
  });

  it('每份媒體最多 4 條：第 5 條 reject 非致命的 MEMORY_LIMIT，不送給 Worker', async () => {
    const { engine, worker } = await loaded();
    for (let i = 1; i <= 4; i++) {
      const adding = engine.addExternalAudio(dub);
      await probeExternal(worker, i);
      await adding;
    }
    const error = await engine.addExternalAudio(dub).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ code: 'MEMORY_LIMIT', fatal: false });
    expect(worker.messages('addaudio')).toHaveLength(4);
    expect(engine.tracks.filter((t) => t.origin === 'external')).toHaveLength(4);
  });

  it('offset 不是有限數時 reject TypeError；沒有媒體時 reject InvalidStateError', async () => {
    const { engine } = await loaded();
    await expect(engine.addExternalAudio(dub, { offset: Number.NaN })).rejects.toThrow(TypeError);
    const idle = createEngineWith(createFakeDeps());
    await expect(idle.addExternalAudio(dub)).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
  });

  it('外掛音軌屬於當前媒體：下一次 load() 時移除', async () => {
    const { engine, deps, worker } = await loaded();
    const adding = engine.addExternalAudio(dub);
    await probeExternal(worker);
    await adding;
    const loading = engine.load(source);
    const next = deps.workers.last;
    await next.probe(media);
    await next.next('start');
    frame(next, 0);
    deps.audio.reply({ type: 'paused' });
    await loading;
    expect(engine.tracks.some((t) => t.origin === 'external')).toBe(false);
    expect(next.messages('addaudio')).toHaveLength(0);
  });
});

/** 加入一條外掛音軌並 resolve 它的 track id。 */
async function addExternal(l: Loaded, offset = 0): Promise<string> {
  const count = l.worker.messages('addaudio').length + 1;
  const adding = l.engine.addExternalAudio(dub, { offset });
  await probeExternal(l.worker, count);
  return (await adding).id;
}

describe('removeExternalAudio()', () => {
  it('沒有選用的軌：Worker 丟掉它的 instance，tracks 移除並發出 trackschange，不重新供料', async () => {
    const l = await loaded();
    const ext = await addExternal(l);
    l.changes.length = 0;
    await l.engine.removeExternalAudio(ext);
    expect(l.worker.messages('removeaudio')).toEqual([{ type: 'removeaudio', id: ext }]);
    expect(l.engine.tracks.some((t) => t.id === ext)).toBe(false);
    expect(l.changes).toHaveLength(1);
    expect(l.worker.messages('select')).toHaveLength(0);
  });

  it('選用中的軌：切回容器內的預設音軌，生效之後才移除（一次 trackschange），再丟掉 instance', async () => {
    const l = await loaded();
    const ext = await addExternal(l);
    const selecting = l.engine.selectTracks({ audio: ext });
    await l.worker.next('select');
    outputReady(l);
    await selecting;
    l.changes.length = 0;

    const removing = outcome(l.engine.removeExternalAudio(ext));
    const select = await l.worker.next('select', 2);
    expect(select).toMatchObject({ audio: 0, video: 1 });
    expect(select.audioSource).toBeUndefined();
    await settle();
    expect(l.worker.messages('removeaudio')).toHaveLength(0);
    expect(l.engine.selectedTracks.audio).toBe(ext);

    outputReady(l);
    await settle();
    expect(removing.value()).toBeUndefined();
    expect(l.engine.selectedTracks.audio).toBe(id.audioMain);
    expect(l.engine.tracks.some((t) => t.id === ext)).toBe(false);
    expect(l.changes).toHaveLength(1);
    expect(l.changes[0]?.selected.audio).toBe(id.audioMain);
    expect(l.worker.received.at(-1)).toEqual({ type: 'removeaudio', id: ext });
  });

  it('容器內的軌或不存在的 id：reject RangeError', async () => {
    const { engine } = await loaded();
    await expect(engine.removeExternalAudio(id.audioMain)).rejects.toThrow(RangeError);
    await expect(engine.removeExternalAudio('ext:99')).rejects.toThrow(RangeError);
  });

  it('移除後可以再加入，不超過 4 條的上限', async () => {
    const l = await loaded();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await addExternal(l));
    await l.engine.removeExternalAudio(ids[0] ?? '');
    await addExternal(l);
    expect(l.engine.tracks.filter((t) => t.origin === 'external')).toHaveLength(4);
  });
});

describe('reload()', () => {
  /** 加入兩條外掛音軌、選用第一條並設 offset，再 reload。 */
  async function withExternals() {
    const l = await loaded();
    const first = await addExternal(l, 0.5);
    const second = await addExternal(l);
    const selecting = l.engine.selectTracks({ audio: first });
    await l.worker.next('select');
    outputReady(l);
    await selecting;
    await l.engine.setAudioOffset(second, -1);
    const tracks = l.engine.tracks;
    l.changes.length = 0;
    const reloading = l.engine.reload();
    const next = l.deps.workers.last;
    return { ...l, first, second, tracks, reloading, next };
  }

  it('保留外掛音軌、它們的 offset 與選擇：新的 Worker 重新加入同一個 id 的來源，probe 完才開始輸出', async () => {
    const r = await withExternals();
    expect(r.next).not.toBe(r.worker);
    await r.next.next('addaudio', 2);
    const adds = r.next.messages('addaudio');
    expect(adds.map((m) => m.id)).toEqual([r.first, r.second]);
    expect(adds[0]?.source).toMatchObject({ kind: 'http', url: dub.url });

    await r.next.probe(media);
    await settle();
    expect(r.next.messages('start')).toHaveLength(0);
    for (const add of adds) r.next.reply({ type: 'audioprobe', id: add.id, track: externalTrack });
    expect(await r.next.next('start')).toMatchObject({
      audio: 0,
      audioSource: r.first,
      audioOffset: 0.5,
    });
    frame(r.next, 0);
    r.deps.audio.reply({ type: 'paused' });
    await r.reloading;
    expect(r.engine.tracks).toEqual(r.tracks);
    expect(r.engine.selectedTracks.audio).toBe(r.first);
    expect(r.changes).toHaveLength(0);
  });

  it('選用中的外掛音軌重新開檔失敗：非致命的 error，該軌移除、改選容器內的預設音軌，reload 照常完成', async () => {
    const r = await withExternals();
    const errors: EngineError[] = [];
    r.engine.addEventListener('error', (e) => errors.push(e.error));
    await r.next.probe(media);
    const [first, second] = r.next.messages('addaudio');
    r.next.reply({
      type: 'audioerror',
      id: first?.id ?? '',
      error: { code: 'SOURCE_UNAUTHORIZED', fatal: true, message: 'HTTP 401' },
    });
    r.next.reply({ type: 'audioprobe', id: second?.id ?? '', track: externalTrack });
    const start = await r.next.next('start');
    expect(start).toMatchObject({ audio: 0, video: 1 });
    expect(start.audioSource).toBeUndefined();
    frame(r.next, 0);
    r.deps.audio.reply({ type: 'paused' });
    const info = await r.reloading;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'SOURCE_UNAUTHORIZED', fatal: false });
    expect(errors[0]?.detail).toMatchObject({ trackId: r.first });
    expect(info.tracks.some((t) => t.id === r.first)).toBe(false);
    expect(r.engine.tracks.map((t) => t.id)).toEqual([
      id.audioMain,
      id.video,
      id.audioSecond,
      r.second,
    ]);
    expect(r.engine.selectedTracks.audio).toBe(id.audioMain);
    expect(r.engine.state).toBe('ready');
    expect(r.engine.error).toBeNull();
    expect(r.changes.at(-1)?.selected.audio).toBe(id.audioMain);
    // 之後再 reload 不再加入移除的軌。
    const again = r.engine.reload();
    const third = r.deps.workers.last;
    await third.probe(media);
    expect(third.messages('addaudio').map((m) => m.id)).toEqual([r.second]);
    third.reply({ type: 'audioprobe', id: r.second, track: externalTrack });
    await third.next('start');
    frame(third, 0);
    r.deps.audio.reply({ type: 'paused' });
    await again;
  });

  it('外掛音軌的組成改變：非致命的 SOURCE_CHANGED，該軌移除，reload 照常完成', async () => {
    const r = await withExternals();
    const errors: EngineError[] = [];
    r.engine.addEventListener('error', (e) => errors.push(e.error));
    await r.next.probe(media);
    for (const add of r.next.messages('addaudio')) {
      r.next.reply({ type: 'audioprobe', id: add.id, track: { ...externalTrack, codec: 'mp3' } });
    }
    await r.next.next('start');
    frame(r.next, 0);
    r.deps.audio.reply({ type: 'paused' });
    await r.reloading;
    expect(errors.map((e) => [e.code, e.fatal])).toEqual([
      ['SOURCE_CHANGED', false],
      ['SOURCE_CHANGED', false],
    ]);
    expect(r.engine.tracks.some((t) => t.origin === 'external')).toBe(false);
    expect(r.engine.selectedTracks.audio).toBe(id.audioMain);
  });

  it('unload() 之後外掛音軌一併移除', async () => {
    const l = await loaded();
    await addExternal(l);
    await l.engine.unload();
    expect(l.engine.tracks).toEqual([]);
  });
});

describe('播放中外掛音軌失敗', () => {
  /** 加入外掛音軌並選用它。 */
  async function withSelected() {
    const l = await loaded();
    const ext = await addExternal(l);
    const selecting = l.engine.selectTracks({ audio: ext });
    const select = await l.worker.next('select');
    outputReady(l);
    await selecting;
    l.changes.length = 0;
    const errors: EngineError[] = [];
    l.engine.addEventListener('error', (e) => errors.push(e.error));
    return { ...l, ext, epoch: select.epoch, errors };
  }

  it('選用中的軌讀取或解碼失敗：非致命的 error，移除該軌並切回容器內的預設音軌（一次 trackschange），主媒體繼續', async () => {
    const l = await withSelected();
    l.worker.reply({
      type: 'audiofailed',
      epoch: l.epoch,
      source: l.ext,
      error: { code: 'FORMAT_CORRUPT', fatal: false, message: 'demux 失敗' },
    });
    expect(l.errors).toHaveLength(1);
    expect(l.errors[0]).toMatchObject({ code: 'FORMAT_CORRUPT', fatal: false });
    expect(l.errors[0]?.detail).toMatchObject({ trackId: l.ext });
    expect(l.engine.state).toBe('ready');
    expect(l.engine.error).toBeNull();

    const select = await l.worker.next('select', 2);
    expect(select).toMatchObject({ audio: 0, video: 1 });
    expect(select.audioSource).toBeUndefined();
    outputReady(l);
    await settle();
    expect(l.engine.selectedTracks.audio).toBe(id.audioMain);
    expect(l.engine.tracks.some((t) => t.id === l.ext)).toBe(false);
    expect(l.changes).toHaveLength(1);
    expect(l.worker.received.at(-1)).toEqual({ type: 'removeaudio', id: l.ext });
  });

  it('過期 epoch 的 audiofailed 不處理', async () => {
    const l = await withSelected();
    const seeking = l.engine.seek(1);
    await l.worker.next('seek');
    l.worker.reply({
      type: 'audiofailed',
      epoch: l.epoch,
      source: l.ext,
      error: { code: 'FORMAT_CORRUPT', fatal: false, message: 'demux 失敗' },
    });
    outputReady(l);
    await seeking;
    await settle();
    expect(l.errors).toHaveLength(0);
    expect(l.engine.selectedTracks.audio).toBe(l.ext);
  });

  it('切換到外掛音軌途中失敗：reject 非致命的錯誤，保留原本的軌，該軌移除', async () => {
    const l = await loaded();
    const ext = await addExternal(l);
    l.changes.length = 0;
    const selecting = l.engine.selectTracks({ audio: ext });
    const result = selecting.catch((e: unknown) => e);
    const select = await l.worker.next('select');
    l.worker.reply({
      type: 'audiofailed',
      epoch: select.epoch,
      source: ext,
      error: { code: 'CODEC_UNSUPPORTED', fatal: false, message: '無法開啟音訊 decoder' },
    });
    const revert = await l.worker.next('select', 2);
    expect(revert).toMatchObject({ audio: 0, video: 1 });
    expect(revert.audioSource).toBeUndefined();
    outputReady(l);
    const error = await result;
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ code: 'CODEC_UNSUPPORTED', fatal: false });
    expect(l.engine.selectedTracks.audio).toBe(id.audioMain);
    expect(l.engine.tracks.some((t) => t.id === ext)).toBe(false);
    expect(l.changes).toHaveLength(1);
    expect(l.worker.messages('removeaudio')).toEqual([{ type: 'removeaudio', id: ext }]);
    expect(l.engine.state).toBe('ready');
  });
});

/** 三個新指令執行到等待 Worker（或 worklet）的那一步：回傳它的 Promise（包一層，await 時才不會等它）。 */
const running: Record<string, (l: Loaded) => Promise<{ command: Promise<unknown> }>> = {
  'addExternalAudio()': async (l) => {
    const adding = l.engine.addExternalAudio(dub);
    await l.worker.next('addaudio');
    return { command: adding };
  },
  'removeExternalAudio()（切回預設音軌中）': async (l) => {
    const ext = await addExternal(l);
    const selecting = l.engine.selectTracks({ audio: ext });
    await l.worker.next('select');
    outputReady(l);
    await selecting;
    const removing = l.engine.removeExternalAudio(ext);
    await l.worker.next('select', 2);
    return { command: removing };
  },
  'setAudioOffset()（重新同步中）': async (l) => {
    const setting = l.engine.setAudioOffset(id.audioMain, 0.5);
    await l.worker.next('select');
    return { command: setting };
  },
};

describe('競態', () => {
  for (const [name, start] of Object.entries(running)) {
    describe(name, () => {
      it('被 load() 取代：reject AbortError，新的媒體沒有外掛音軌', async () => {
        const l = await loaded();
        const { command } = await start(l);
        const loading = l.engine.load(source);
        await expect(command).rejects.toMatchObject({ name: 'AbortError' });
        expect(l.worker.terminated).toBe(true);
        const next = l.deps.workers.last;
        await next.probe(media);
        await next.next('start');
        frame(next, 0);
        l.deps.audio.reply({ type: 'paused' });
        await loading;
        expect(l.engine.tracks.some((t) => t.origin === 'external')).toBe(false);
        expect(next.messages('addaudio')).toHaveLength(0);
        expect(next.messages('removeaudio')).toHaveLength(0);
      });

      it('執行中 destroy：reject AbortError，之後的呼叫 reject DESTROYED', async () => {
        const l = await loaded();
        const { command } = await start(l);
        await l.engine.destroy();
        await expect(command).rejects.toMatchObject({ name: 'AbortError' });
        await expect(l.engine.addExternalAudio(dub)).rejects.toMatchObject({ code: 'DESTROYED' });
        await expect(l.engine.removeExternalAudio('ext:4')).rejects.toMatchObject({
          code: 'DESTROYED',
        });
        await expect(l.engine.setAudioOffset(id.audioMain, 1)).rejects.toMatchObject({
          code: 'DESTROYED',
        });
      });

      it('執行中 Worker 崩潰：reject 致命的 INTERNAL，state 進入 error', async () => {
        const l = await loaded();
        const { command } = await start(l);
        l.worker.crash();
        await expect(command).rejects.toMatchObject({ code: 'INTERNAL', fatal: true });
        expect(l.engine.state).toBe('error');
      });
    });
  }

  it('Worker 被 terminate 之後才送到的 audioprobe 不影響新的媒體', async () => {
    const l = await loaded();
    const adding = outcome(l.engine.addExternalAudio(dub));
    const add = await l.worker.next('addaudio');
    const loading = l.engine.load(source);
    l.worker.reply({ type: 'audioprobe', id: add.id, track: externalTrack });
    const next = l.deps.workers.last;
    await next.probe(media);
    await next.next('start');
    frame(next, 0);
    l.deps.audio.reply({ type: 'paused' });
    await loading;
    await settle();
    expect(adding.value()).toMatchObject({ name: 'AbortError' });
    expect(l.engine.tracks).toHaveLength(3);
  });

  it('setAudioOffset() 重新同步完成時 seeked 的 listener 換檔：reject AbortError，新的媒體不受影響', async () => {
    const l = await loaded();
    l.engine.addEventListener(
      'seeked',
      () => {
        void l.engine.load(source).catch(() => undefined);
      },
      { once: true },
    );
    const setting = outcome(l.engine.setAudioOffset(id.audioMain, 0.5));
    await l.worker.next('select');
    outputReady(l);
    await settle();
    expect(setting.value()).toMatchObject({ name: 'AbortError' });
    expect(l.engine.state).toBe('loading');
    expect(l.engine.tracks).toEqual([]);
  });

  it('外掛音軌的 offset 被較新的 setAudioOffset() 改寫時依呼叫順序生效，最後一個勝出', async () => {
    const l = await loaded();
    const first = l.engine.setAudioOffset(id.audioMain, 0.5);
    const second = l.engine.setAudioOffset(id.audioMain, -0.5);
    expect(await l.worker.next('select')).toMatchObject({ audioOffset: 0.5 });
    outputReady(l);
    await first;
    expect(await l.worker.next('select', 2)).toMatchObject({ audioOffset: -0.5 });
    outputReady(l);
    await second;
    expect(l.engine.tracks[0]).toMatchObject({ offset: -0.5 });
  });

  it('HTTP 主來源收到 end: Infinity（本機外掛音軌）：buffered 夾到媒體 duration，duration 未知時不輸出 Infinity', async () => {
    const l = await loaded();
    const [start] = l.worker.messages('start');
    l.worker.reply({
      type: 'buffer',
      epoch: start?.epoch ?? NaN,
      end: Infinity,
      eof: true,
      fetching: false,
    });
    expect(l.engine.buffered).toEqual([{ start: 0, end: media.duration }]);

    const unknown = l.engine.load(source);
    const next = l.deps.workers.last;
    await next.probe({ ...media, duration: NaN });
    const nextStart = await next.next('start');
    frame(next, 0, nextStart.epoch);
    l.deps.audio.reply({ type: 'paused' });
    await unknown;
    next.reply({
      type: 'buffer',
      epoch: nextStart.epoch,
      end: Infinity,
      eof: true,
      fetching: false,
    });
    expect(l.engine.buffered).toEqual([]);
  });
});

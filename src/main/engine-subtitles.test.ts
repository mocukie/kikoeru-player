// 內嵌字幕 cue（#49）：初始字幕軌的選擇送進 Worker、Worker 的 cue 轉成 `cues` 事件（補上 trackId）、過期 epoch 的
// cue 丟掉、load 完成前的 cue 留到軌道公布之後。以假 media Worker 驅動 createEngineWith()。

import { describe, expect, it } from 'vitest';
import { createFakeDeps } from '../../test/fakes/engine-deps.js';
import { audioMedia, type FakeMediaWorker } from '../../test/fakes/media-worker.js';
import type { ProbedMedia, ProbedSubtitleTrack, WireCue } from '../protocol/index.js';
import { createEngineWith } from './engine.js';
import type { CuesEvent } from './events.js';
import type { Engine, LoadOptions, Source } from './types.js';

const source: Source = { kind: 'http', url: 'https://example.test/a.mkv' };

const srt: ProbedSubtitleTrack = {
  kind: 'subtitle',
  streamIndex: 1,
  codec: 'subrip',
  supported: true,
  default: false,
  forced: false,
  language: 'ja',
  format: 'subrip',
};
const ass: ProbedSubtitleTrack = {
  ...srt,
  streamIndex: 2,
  codec: 'ass',
  language: 'zh',
  format: 'ass',
  header: '[Script Info]\n',
};
const pgs: ProbedSubtitleTrack = {
  ...srt,
  streamIndex: 3,
  codec: 'hdmv_pgs_subtitle',
  format: 'bitmap',
  supported: false,
  unsupportedReason: 'bitmap-subtitle',
};

const media: ProbedMedia = audioMedia({ tracks: [...audioMedia().tracks, srt, ass, pgs] });

const cue = (start: number, text = `cue ${String(start)}`): WireCue => ({
  format: 'subrip',
  id: `${String(start * 1e6)}:x`,
  start,
  end: start + 0.5,
  text,
});

function latestEpoch(worker: FakeMediaWorker): number {
  const latest = [...worker.received]
    .reverse()
    .find((m) => m.type === 'start' || m.type === 'seek');
  if (!latest || !('epoch' in latest)) throw new Error('還沒有 start');
  return latest.epoch;
}

function sendCues(worker: FakeMediaWorker, cues: WireCue[], epoch = latestEpoch(worker)): void {
  worker.reply({ type: 'cues', epoch, cues });
}

async function startLoad(options: LoadOptions = {}) {
  const deps = createFakeDeps();
  const engine = createEngineWith(deps);
  const events: CuesEvent[] = [];
  engine.addEventListener('cues', (e) => events.push(e));
  const loading = engine.load(source, options);
  const worker = deps.workers.last;
  await worker.probe(media);
  await worker.next('start');
  return { engine, deps, worker, loading, events };
}

async function loaded(options: LoadOptions = {}) {
  const t = await startLoad(options);
  t.deps.audio.reply({ type: 'paused' });
  await t.loading;
  return t;
}

function subtitleId(engine: Engine, streamIndex: number): string {
  const track = engine.tracks.find((t) => t.kind === 'subtitle' && t.streamIndex === streamIndex);
  if (!track) throw new Error('沒有字幕軌');
  return track.id;
}

describe('初始字幕軌', () => {
  it('LoadOptions.tracks.subtitle 選中的軌以 stream index 送進 start', async () => {
    // 新的 Engine 依 probe 的順序指派 id：a:1、s:2（SRT）、s:3（ASS）、s:4（PGS）。
    const { engine, worker } = await loaded({ tracks: { subtitle: 's:3' } });
    expect(subtitleId(engine, ass.streamIndex)).toBe('s:3');
    expect(worker.messages('start')[0]).toMatchObject({ subtitle: ass.streamIndex });
    expect(engine.selectedTracks.subtitle).toBe('s:3');
  });

  it('不支援的字幕軌（圖形字幕）即使指定也不選', async () => {
    const { engine, worker } = await loaded({ tracks: { subtitle: 's:4' } });
    expect(worker.messages('start')[0]).toMatchObject({ subtitle: null });
    expect(engine.selectedTracks.subtitle).toBeNull();
  });

  it('沒有指定、也沒有偏好語言時不選字幕，start 的 subtitle 為 null', async () => {
    const { worker, engine } = await loaded();
    expect(worker.messages('start')[0]).toMatchObject({ subtitle: null });
    expect(engine.selectedTracks.subtitle).toBeNull();
  });

  it('命中偏好語言的字幕軌', async () => {
    const { worker } = await loaded({ preferredLanguages: { subtitle: ['zh'] } });
    expect(worker.messages('start')[0]).toMatchObject({ subtitle: ass.streamIndex });
  });
});

describe('cues 事件', () => {
  it('Worker 的 cue 以 cues 事件送出，帶上選中字幕軌的 trackId', async () => {
    const { engine, worker, events } = await loaded({ preferredLanguages: { subtitle: ['ja'] } });
    sendCues(worker, [cue(0), cue(1)]);
    const trackId = subtitleId(engine, srt.streamIndex);
    expect(events).toHaveLength(1);
    expect(events[0]?.trackId).toBe(trackId);
    expect(events[0]?.cues).toEqual([
      { ...cue(0), trackId },
      { ...cue(1), trackId },
    ]);
  });

  it('load 完成前收到的 cue 留到 trackschange 之後才送出', async () => {
    const { engine, deps, worker, loading, events } = await startLoad({
      preferredLanguages: { subtitle: ['ja'] },
    });
    const order: string[] = [];
    engine.addEventListener('trackschange', () => order.push('trackschange'));
    engine.addEventListener('cues', (e) => order.push(`cues ${String(e.cues.length)}`));
    sendCues(worker, [cue(0)]);
    sendCues(worker, [cue(1), cue(2)]);
    expect(events).toEqual([]);

    deps.audio.reply({ type: 'paused' });
    await loading;
    expect(order).toEqual(['trackschange', 'cues 1', 'cues 2']);
  });

  it('過期 epoch 的 cue 丟掉', async () => {
    const { engine, worker, events } = await loaded({ preferredLanguages: { subtitle: ['ja'] } });
    const before = latestEpoch(worker);
    const seeking = engine.seek(5);
    await worker.next('seek');
    sendCues(worker, [cue(0)], before);
    expect(events).toEqual([]);

    sendCues(worker, [cue(5)]);
    expect(events.map((e) => e.cues.map((c) => c.start))).toEqual([[5]]);
    void seeking.catch(() => undefined);
  });

  it('loading 中 seek 之後，舊 epoch 留著的 cue 不送出', async () => {
    const { engine, deps, worker, loading, events } = await startLoad({
      preferredLanguages: { subtitle: ['ja'] },
    });
    sendCues(worker, [cue(0)]);
    const seeking = engine.seek(8);
    await worker.next('seek');
    sendCues(worker, [cue(8)]);
    deps.audio.reply({ type: 'paused' });
    await Promise.all([loading, seeking]);
    expect(events.map((e) => e.cues.map((c) => c.start))).toEqual([[8]]);
  });

  it('換檔、unload 與 destroy 之後，舊的 Worker 送來的 cue 不送出', async () => {
    const { engine, worker, events } = await loaded({ preferredLanguages: { subtitle: ['ja'] } });
    void engine.load(source).catch(() => undefined);
    sendCues(worker, [cue(0)]);
    await engine.unload();
    sendCues(worker, [cue(1)]);
    await engine.destroy();
    sendCues(worker, [cue(2)]);
    expect(events).toEqual([]);
  });

  it('沒有選字幕軌時 Worker 的 cue 不送出', async () => {
    const { worker, events } = await loaded();
    sendCues(worker, [cue(0)]);
    expect(events).toEqual([]);
  });
});

describe('播放位置轉送給 Worker', () => {
  it('worklet 的 clock 以 position 轉送（Worker 以它節流只為字幕的 demux）；過期 epoch 的 clock 不轉送', async () => {
    const { engine, deps, worker } = await loaded({ preferredLanguages: { subtitle: ['ja'] } });
    const epoch = latestEpoch(worker);
    deps.audio.reply({ type: 'clock', position: 3.5, frame: 1, buffered: 0, underruns: 0 });
    expect(worker.messages('position')).toEqual([{ type: 'position', epoch, time: 3.5 }]);
    const seeking = engine.seek(8);
    await worker.next('seek');
    deps.audio.reply({ type: 'clock', epoch, position: 4, frame: 2, buffered: 0, underruns: 0 });
    expect(worker.messages('position')).toHaveLength(1);
    deps.audio.reply({ type: 'paused' });
    await seeking;
  });
});

// 播放中切換軌道（#52）：selectTracks() 的換軌、同一 kind 的取代、失敗時保留原軌，以及被取代、執行中 destroy、Worker 崩潰
// 的競態。以假 media Worker 驅動 createEngineWith()。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeDeps, type FakeEngineDeps } from '../../test/fakes/engine-deps.js';
import { audioMedia, type FakeMediaWorker } from '../../test/fakes/media-worker.js';
import { frame, videoTrack } from '../../test/fakes/video.js';
import type {
  ProbedAudioTrack,
  ProbedMedia,
  ProbedSubtitleTrack,
  ProbedVideoTrack,
  WireCue,
} from '../protocol/index.js';
import { createEngineWith } from './engine.js';
import { EngineError } from './errors.js';
import type { CuesEvent, TracksChangeEvent } from './events.js';
import type { Engine, LoadOptions, Source } from './types.js';

const source: Source = { kind: 'http', url: 'https://example.test/a.mkv' };

const [firstAudio] = audioMedia().tracks as [ProbedAudioTrack];
/** stream 0：AAC（ja，default）；stream 2：Opus（zh）；stream 7：不支援的音軌。 */
const audioJa: ProbedAudioTrack = { ...firstAudio, language: 'ja' };
const audioZh: ProbedAudioTrack = {
  ...firstAudio,
  streamIndex: 2,
  codec: 'opus',
  language: 'zh',
  default: false,
};
const audioBad: ProbedAudioTrack = {
  ...firstAudio,
  streamIndex: 7,
  codec: 'dts',
  default: false,
  supported: false,
  unsupportedReason: 'codec',
};
/** stream 1：H.264 320×180（default）；stream 3：640×360；stream 4：不支援。 */
const video1: ProbedVideoTrack = videoTrack;
const video2: ProbedVideoTrack = {
  ...videoTrack,
  streamIndex: 3,
  default: false,
  codedWidth: 640,
  codedHeight: 360,
  display: { width: 640, height: 360, rotation: 0 },
};
const videoBad: ProbedVideoTrack = {
  ...videoTrack,
  streamIndex: 4,
  codec: 'hevc',
  default: false,
  supported: false,
  unsupportedReason: 'platform',
};
/** stream 5：SRT（ja）；stream 6：ASS（zh）。 */
const srt: ProbedSubtitleTrack = {
  kind: 'subtitle',
  streamIndex: 5,
  codec: 'subrip',
  supported: true,
  default: false,
  forced: false,
  language: 'ja',
  format: 'subrip',
};
const ass: ProbedSubtitleTrack = {
  ...srt,
  streamIndex: 6,
  codec: 'ass',
  language: 'zh',
  format: 'ass',
  header: '[Script Info]\n',
};

const media: ProbedMedia = audioMedia({
  tracks: [audioJa, video1, audioZh, video2, videoBad, srt, ass, audioBad],
});
/** track id 依 probe 的順序：a:1、v:2、a:3、v:4、v:5、s:6、s:7、a:8。 */
const id = {
  audioJa: 'a:1',
  video1: 'v:2',
  audioZh: 'a:3',
  video2: 'v:4',
  videoBad: 'v:5',
  srt: 's:6',
  ass: 's:7',
  audioBad: 'a:8',
};

const cue = (start: number): WireCue => ({
  format: 'subrip',
  id: `${String(start * 1e6)}:x`,
  start,
  end: start + 0.5,
  text: `cue ${String(start)}`,
});

interface Loaded {
  engine: Engine;
  deps: FakeEngineDeps;
  worker: FakeMediaWorker;
  changes: TracksChangeEvent[];
  cues: CuesEvent[];
}

async function loaded(options: LoadOptions & { probed?: ProbedMedia } = {}): Promise<Loaded> {
  const deps = createFakeDeps();
  const engine = createEngineWith(deps);
  const { probed = media, ...loadOptions } = options;
  const loading = engine.load(source, loadOptions);
  const worker = deps.workers.last;
  await worker.probe(probed);
  const start = await worker.next('start');
  if (start.video !== null) frame(worker, 0);
  deps.audio.reply({ type: loadOptions.paused === false ? 'playing' : 'paused' });
  await loading;
  const changes: TracksChangeEvent[] = [];
  const cues: CuesEvent[] = [];
  engine.addEventListener('trackschange', (e) => changes.push(e));
  engine.addEventListener('cues', (e) => cues.push(e));
  return { engine, deps, worker, changes, cues };
}

async function statsOf(engine: Engine, worker: FakeMediaWorker) {
  const stats = engine.getStats();
  await worker.stats(1);
  return stats;
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

describe('偏好語言', () => {
  /** 以 `options` 建立 Engine、load，回傳 start 選用的 stream。 */
  async function started(
    options: Parameters<typeof createEngineWith>[1],
    loadOptions: LoadOptions = {},
  ) {
    const deps = createFakeDeps();
    const engine = createEngineWith(deps, options);
    const loading = engine.load(source, loadOptions);
    const worker = deps.workers.last;
    await worker.probe(media);
    const start = await worker.next('start');
    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    await loading;
    return { engine, start };
  }

  it('createEngine() 的 preferredLanguages 是預設值：音軌與字幕依它選', async () => {
    const { engine, start } = await started({
      preferredLanguages: { audio: ['zh'], subtitle: ['zh'] },
    });
    expect(start).toMatchObject({ audio: 2, subtitle: 6 });
    expect(engine.selectedTracks).toEqual({
      audio: id.audioZh,
      video: id.video1,
      subtitle: id.ass,
    });
  });

  it('load() 的 preferredLanguages 依 kind 覆蓋預設值，沒給的 kind 沿用預設值', async () => {
    const { engine, start } = await started(
      { preferredLanguages: { audio: ['zh'], subtitle: ['zh'] } },
      { preferredLanguages: { audio: ['ja'] } },
    );
    expect(start).toMatchObject({ audio: 0, subtitle: 6 });
    expect(engine.selectedTracks).toEqual({
      audio: id.audioJa,
      video: id.video1,
      subtitle: id.ass,
    });
  });

  it('load() 給空的偏好語言：不依語言選，音軌回到 default 旗標、字幕關閉', async () => {
    const { engine } = await started(
      { preferredLanguages: { audio: ['zh'], subtitle: ['zh'] } },
      { preferredLanguages: { audio: [], subtitle: [] } },
    );
    expect(engine.selectedTracks).toEqual({ audio: id.audioJa, video: id.video1, subtitle: null });
  });
});

describe('切換音軌', () => {
  it('以新的 epoch 從目前位置重新供料；新軌出聲之前 selectedTracks 不變，之後才更新並發出 trackschange', async () => {
    const { engine, deps, worker, changes } = await loaded();
    const before = deps.audio.epoch;

    const selecting = engine.selectTracks({ audio: id.audioZh });
    const select = await worker.next('select');
    expect(select).toMatchObject({ time: 0, audio: 2, video: 1, subtitle: null });
    expect(select.epoch).toBeGreaterThan(before);
    expect(deps.audio.epoch).toBe(select.epoch);
    expect(engine.selectedTracks.audio).toBe(id.audioJa);
    expect(changes).toHaveLength(0);

    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    await selecting;
    expect(engine.selectedTracks).toEqual({ audio: id.audioZh, video: id.video1, subtitle: null });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.selected.audio).toBe(id.audioZh);
    expect(engine.state).toBe('ready');
  });
});

describe('播放中切換', () => {
  it('state 維持 playing、currentTime 停在切換的位置不跳；被要求播放時等新軌開始輸出才生效', async () => {
    const { engine, deps, worker } = await loaded({ paused: false });
    deps.audio.reply({ type: 'clock', position: 0, frame: 0, buffered: 0, underruns: 0 });
    deps.audio.frameNow = 48_000 * 3;
    const states: string[] = [];
    engine.addEventListener('statechange', (e) => states.push(e.state));

    const selecting = outcome(engine.selectTracks({ audio: id.audioZh }));
    const select = await worker.next('select');
    expect(select.time).toBeCloseTo(3, 6);
    expect(engine.currentTime).toBeCloseTo(3, 6);
    expect(deps.audio.received.findLast((m) => m.type === 'flush')).toMatchObject({
      epoch: select.epoch,
      position: select.time,
    });

    frame(worker, 3);
    expect(deps.audio.intent).toBe('play');
    await settle();
    expect(selecting.value()).toBeUndefined();
    expect(engine.selectedTracks.audio).toBe(id.audioJa);
    deps.audio.reply({ type: 'playing' });
    await settle();
    expect(engine.selectedTracks.audio).toBe(id.audioZh);
    expect(engine.state).toBe('playing');
    expect(states).toEqual([]);
  });

  it('audio: null：Worker 不輸出音訊（worklet 以靜音推進時鐘）', async () => {
    const { engine, deps, worker } = await loaded();
    const selecting = engine.selectTracks({ audio: null });
    expect(await worker.next('select')).toMatchObject({ audio: null, video: 1 });
    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    await selecting;
    expect(engine.selectedTracks.audio).toBeNull();
  });

  it('選擇與目前相同：不重新供料，直接 resolve', async () => {
    const { engine, worker, changes } = await loaded();
    await engine.selectTracks({ audio: id.audioJa, subtitle: null });
    await engine.selectTracks({});
    expect(worker.messages('select')).toHaveLength(0);
    expect(changes).toHaveLength(0);
  });
});

describe('切換影片軌', () => {
  it('等新軌的第一張 frame 才生效；舊 epoch 的 frame close，畫面上的那張留到新軌的第一張畫出', async () => {
    const { engine, deps, worker, changes } = await loaded();
    const shown = frame(worker, 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const late = frame(worker, 1 / 30);

    const selecting = outcome(engine.selectTracks({ video: id.video2 }));
    const select = await worker.next('select');
    expect(select).toMatchObject({ audio: 0, video: 3 });
    expect(late.closed).toBe(true);
    expect(frame(worker, 0, select.epoch - 1).closed).toBe(true);
    deps.audio.reply({ type: 'paused' });
    await settle();
    expect(selecting.value()).toBeUndefined();
    expect(shown.closed).toBe(false);

    const first = frame(worker, 0);
    await settle();
    expect(selecting.value()).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(engine.selectedTracks.video).toBe(id.video2);
    expect(changes).toHaveLength(1);
    expect(first.closed).toBe(false);
    expect(shown.closed).toBe(true);
  });

  it('新軌的第一張 frame 晚於時鐘：收到 frame 不等於畫出，畫出之前不生效（超過 2 秒不再等）', async () => {
    const { engine, deps, worker, changes } = await loaded();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sizes: unknown[] = [];
    engine.addEventListener('videoresize', (e) => sizes.push(e.size));
    let done = false;
    const promise = engine.selectTracks({ video: id.video2 }).then(() => {
      done = true;
    });
    await worker.next('select');
    // 暫停在 0 秒，新軌的第一張在 1 秒：時鐘到之前不畫。
    const first = frame(worker, 1);
    deps.audio.reply({ type: 'paused' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(false);
    expect(engine.selectedTracks.video).toBe(id.video1);
    expect(changes).toHaveLength(0);
    expect(sizes).toEqual([]);
    expect(first.closed).toBe(false);

    await vi.advanceTimersByTimeAsync(900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await promise;
    expect(engine.selectedTracks.video).toBe(id.video2);
  });

  it('播放中新軌的第一張晚於時鐘：時鐘推進到它、畫出之後才生效', async () => {
    const { engine, deps, worker } = await loaded({ paused: false });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let done = false;
    const promise = engine.selectTracks({ video: id.video2 }).then(() => {
      done = true;
    });
    await worker.next('select');
    frame(worker, 0.5);
    deps.audio.reply({ type: 'playing' });
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toBe(false);
    expect(engine.selectedTracks.video).toBe(id.video1);
    deps.audio.frameNow = 48_000 * 0.5;
    deps.audio.reply({
      type: 'clock',
      position: 0.5,
      frame: 48_000 * 0.5,
      buffered: 0,
      underruns: 0,
    });
    await vi.advanceTimersByTimeAsync(50);
    await promise;
    expect(engine.selectedTracks.video).toBe(id.video2);
  });

  it('videoresize listener 同步換軌：舊 epoch 畫出不會結束新軌的畫面等待', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, deps, worker, changes } = await loaded({
      paused: false,
      tracks: { video: null },
    });
    const first = outcome(engine.selectTracks({ video: id.video1 }));
    const v1 = await worker.next('select');
    let latest: Promise<void> | undefined;
    engine.addEventListener(
      'videoresize',
      () => {
        latest = engine.selectTracks({ video: id.video2 });
      },
      { once: true },
    );
    const shown = frame(worker, 0, v1.epoch);
    const v2 = await worker.next('select', 2);
    expect(v2.epoch).toBeGreaterThan(v1.epoch);
    expect(v2.video).toBe(3);
    expect(deps.audio.intent).toBe('pause');

    const next = frame(worker, 1, v2.epoch);
    expect(deps.audio.intent).toBe('play');
    deps.audio.reply({ type: 'playing' });
    await vi.advanceTimersByTimeAsync(50);
    expect(first.value()).toMatchObject({ name: 'AbortError' });
    expect(engine.state).toBe('playing');
    expect(engine.currentTime).toBe(0);
    expect(engine.selectedTracks.video).toBeNull();
    expect(changes).toHaveLength(0);
    expect(shown.closed).toBe(false);

    deps.audio.frameNow = deps.audio.sampleRate;
    deps.audio.reply({
      type: 'clock',
      position: 1,
      frame: deps.audio.frameNow,
      buffered: 0,
      underruns: 0,
    });
    await vi.advanceTimersByTimeAsync(50);
    await expect(latest).resolves.toBeUndefined();
    expect(shown.closed).toBe(true);
    expect(next.closed).toBe(false);
    expect(engine.selectedTracks.video).toBe(id.video2);
    expect(changes).toHaveLength(1);
    await engine.destroy();
  });

  it('部分取代後從新的 epoch 收到 frame 才重新計算等畫面的 2 秒', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, deps, worker, changes } = await loaded();
    const first = engine.selectTracks({ audio: id.audioZh, video: id.video2 });
    const before = await worker.next('select');
    expect(before).toMatchObject({ audio: 2, video: 3 });
    const queued = frame(worker, 1, before.epoch);
    deps.audio.reply({ type: 'paused' });
    await vi.advanceTimersByTimeAsync(1700);
    expect(engine.selectedTracks.video).toBe(id.video1);

    const audio = engine.selectTracks({ audio: id.audioJa });
    const restarted = await worker.next('select', 2);
    expect(restarted).toMatchObject({ audio: 0, video: 3 });
    expect(restarted.epoch).toBeGreaterThan(before.epoch);
    expect(queued.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    frame(worker, 1, restarted.epoch);
    deps.audio.reply({ type: 'paused' });

    await vi.advanceTimersByTimeAsync(1999);
    expect(deps.audio.intent).toBe('pause');
    expect(engine.state).toBe('ready');
    expect(engine.currentTime).toBe(0);
    expect(engine.selectedTracks.video).toBe(id.video1);
    expect(changes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await first;
    await audio;
    expect(engine.selectedTracks).toEqual({ audio: id.audioJa, video: id.video2, subtitle: null });
    expect(changes).toHaveLength(1);
    await engine.destroy();
  });

  it('video: null：不再解碼影片，生效時 videoSize 回到 null', async () => {
    const { engine, deps, worker } = await loaded();
    frame(worker, 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(engine.videoSize).not.toBeNull();
    const sizes: unknown[] = [];
    engine.addEventListener('videoresize', (e) => sizes.push(e.size));
    const selecting = engine.selectTracks({ video: null });
    expect(await worker.next('select')).toMatchObject({ audio: 0, video: null });
    deps.audio.reply({ type: 'paused' });
    await selecting;
    expect(engine.selectedTracks.video).toBeNull();
    expect(engine.videoSize).toBeNull();
    expect(sizes).toEqual([null]);
    expect((await statsOf(engine, worker)).video).toBeNull();
  });

  it('播放中以關掉影片取代換軌：解除 worklet 的等待，不中斷音訊時鐘', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, deps, worker } = await loaded({ paused: false });
    deps.audio.reply({ type: 'clock', position: 2, frame: 0, buffered: 0, underruns: 0 });
    const states: string[] = [];
    engine.addEventListener('statechange', ({ state }) => states.push(state));

    const pending = outcome(engine.selectTracks({ video: id.video2 }));
    expect(await worker.next('select')).toMatchObject({ video: 3, time: 2 });
    expect(deps.audio.intent).toBe('pause');
    const closing = engine.selectTracks({ video: null });
    const close = await worker.next('select', 2);
    expect(close).toMatchObject({ video: null, time: 2 });
    expect(deps.audio.received.slice(-2)).toEqual([
      { type: 'flush', epoch: close.epoch, position: 2 },
      { type: 'play', epoch: close.epoch },
    ]);
    expect(deps.audio.intent).toBe('play');
    expect(engine.currentTime).toBe(2);

    // PCM 可能先於 play 到達 worklet：這次 paused 回報不是使用者的暫停，也不能拿來完成換軌。
    deps.audio.reply({ type: 'paused' });
    await settle();
    expect(pending.value()).toMatchObject({ name: 'AbortError' });
    expect(engine.state).toBe('playing');
    expect(engine.selectedTracks.video).toBe(id.video1);

    deps.audio.reply({ type: 'playing' });
    await closing;
    deps.audio.frameNow = deps.audio.sampleRate / 2;
    deps.audio.reply({ type: 'clock', position: 2, frame: 0, buffered: 0, underruns: 0 });
    expect(engine.currentTime).toBe(2.5);
    expect(engine.selectedTracks.video).toBeNull();
    expect(engine.state).toBe('playing');
    expect(engine.paused).toBe(false);
    expect(states).toEqual([]);
    await engine.destroy();
  });

  it('新軌 configure 或首個 keyframe 失敗：該軌改為不支援並發出 trackschange，換回原本的軌，reject 非致命的 CODEC_UNSUPPORTED', async () => {
    const { engine, deps, worker, changes } = await loaded();
    const selecting = engine.selectTracks({ video: id.video2, audio: id.audioZh });
    const result = selecting.catch((e: unknown) => e);
    const select = await worker.next('select');
    worker.reply({
      type: 'videoerror',
      epoch: select.epoch,
      beforeFirstFrame: true,
      error: { code: 'CODEC_UNSUPPORTED', fatal: false, message: 'configure 失敗' },
    });
    // 換回原本生效的選擇。
    const revert = await worker.next('select', 2);
    expect(revert).toMatchObject({ audio: 0, video: 1 });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.tracks.find((t) => t.id === id.video2)).toMatchObject({
      supported: false,
      unsupportedReason: 'platform',
    });
    expect(changes[0]?.selected).toEqual({ audio: id.audioJa, video: id.video1, subtitle: null });

    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    const error = await result;
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ code: 'CODEC_UNSUPPORTED', fatal: false });
    expect(engine.selectedTracks).toEqual({ audio: id.audioJa, video: id.video1, subtitle: null });
    expect(engine.tracks.find((t) => t.id === id.video2)?.supported).toBe(false);
    expect(engine.state).toBe('ready');
    await expect(engine.selectTracks({ video: id.video2 })).rejects.toMatchObject({
      code: 'CODEC_UNSUPPORTED',
    });
  });

  it('新音軌的 decoder 開啟失敗：該軌改為不支援並發出 trackschange，換回原本的軌，reject 非致命的 CODEC_UNSUPPORTED', async () => {
    const { engine, deps, worker, changes } = await loaded();
    const errors: unknown[] = [];
    engine.addEventListener('error', (e) => errors.push(e.error));
    const result = engine.selectTracks({ audio: id.audioZh }).catch((e: unknown) => e);
    const select = await worker.next('select');
    worker.reply({
      type: 'audiofailed',
      epoch: select.epoch,
      source: null,
      error: { code: 'CODEC_UNSUPPORTED', fatal: false, message: '無法開啟音訊 decoder' },
    });
    const revert = await worker.next('select', 2);
    expect(revert).toMatchObject({ audio: 0, video: 1 });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.tracks.find((t) => t.id === id.audioZh)).toMatchObject({
      supported: false,
      unsupportedReason: 'codec',
    });
    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    const error = await result;
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ code: 'CODEC_UNSUPPORTED', fatal: false });
    expect(engine.selectedTracks.audio).toBe(id.audioJa);
    expect(engine.state).toBe('ready');
    expect(engine.error).toBeNull();
    expect(errors).toHaveLength(0);
  });

  it('只換音軌時目前的影片軌播放中解碼失敗：照常退回只播音訊，換軌生效時 video 為 null', async () => {
    const { engine, deps, worker } = await loaded();
    const selecting = engine.selectTracks({ audio: id.audioZh });
    const select = await worker.next('select');
    worker.reply({
      type: 'videoerror',
      epoch: select.epoch,
      beforeFirstFrame: false,
      error: { code: 'DECODE_FAILED', fatal: false, message: '解碼失敗' },
    });
    deps.audio.reply({ type: 'paused' });
    await selecting;
    expect(engine.selectedTracks).toEqual({ audio: id.audioZh, video: null, subtitle: null });
    expect(worker.messages('select')).toHaveLength(1);
  });
});

describe('主來源音軌的 decoder 開不起來（不是換軌）', () => {
  const failure = {
    code: 'CODEC_UNSUPPORTED' as const,
    fatal: false,
    message: '無法開啟音訊 decoder',
  };

  /** load 到第一個 start 送出，Worker 回報這個 epoch 的主來源音軌 decoder 開不起來。 */
  async function failOnLoad(probed: ProbedMedia = media) {
    const deps = createFakeDeps();
    const engine = createEngineWith(deps);
    const errors: EngineError[] = [];
    engine.addEventListener('error', (e) => errors.push(e.error));
    const loading = engine.load(source);
    const worker = deps.workers.last;
    await worker.probe(probed);
    const start = await worker.next('start');
    worker.reply({ type: 'audiofailed', epoch: start.epoch, source: null, error: failure });
    return { engine, deps, worker, loading, start, errors };
  }

  it('有可播的影片軌：該音軌標為不支援（codec），以新的 epoch、audio: null 送出 select，load 成功、只播影片', async () => {
    const { engine, deps, worker, loading, start, errors } = await failOnLoad();
    const restart = await worker.next('select');
    expect(restart.epoch).toBeGreaterThan(start.epoch);
    expect(restart).toMatchObject({ audio: null, video: 1, time: 0 });
    expect(worker.messages('start')).toHaveLength(1);
    frame(worker, 0, restart.epoch);
    deps.audio.reply({ type: 'paused' });
    const info = await loading;
    expect(engine.state).toBe('ready');
    // 不自動改選另一條音軌（audioZh 可播）。
    expect(engine.selectedTracks).toEqual({ audio: null, video: id.video1, subtitle: null });
    expect(info.tracks.find((t) => t.id === id.audioJa)).toMatchObject({
      supported: false,
      unsupportedReason: 'codec',
    });
    expect(engine.tracks.find((t) => t.id === id.audioJa)?.supported).toBe(false);
    // load 完成之前的退回不發出 error（與影片在第一張 frame 之前失敗相同）。
    expect(errors).toEqual([]);
    expect(engine.error).toBeNull();
    // App 可以自己換到另一條音軌。
    const selecting = engine.selectTracks({ audio: id.audioZh });
    const select = await worker.next('select', 2);
    expect(select).toMatchObject({ audio: 2, video: 1 });
    frame(worker, 0, select.epoch);
    deps.audio.reply({ type: 'paused' });
    await selecting;
    expect(engine.selectedTracks.audio).toBe(id.audioZh);
  });

  it('只有音軌（沒有可播的影片軌）：load() 以致命的 CODEC_UNSUPPORTED reject，state 是 error', async () => {
    const { engine, worker, loading } = await failOnLoad(audioMedia());
    await expect(loading).rejects.toMatchObject({ code: 'CODEC_UNSUPPORTED', fatal: true });
    expect(engine.state).toBe('error');
    expect(worker.messages('start')).toHaveLength(1);
    expect(worker.messages('select')).toHaveLength(0);
  });

  it('退回途中 load() 換檔：舊的 load 以 AbortError reject，新的 load 照常完成', async () => {
    const { engine, deps, worker, loading } = await failOnLoad();
    await worker.next('select');
    const rejected = loading.catch((error: unknown) => error);
    const next = engine.load(source);
    expect(await rejected).toMatchObject({ name: 'AbortError' });
    const fresh = deps.workers.last;
    expect(fresh).not.toBe(worker);
    await fresh.probe(media);
    const start = await fresh.next('start');
    expect(start).toMatchObject({ audio: 0, video: 1 });
    frame(fresh, 0, start.epoch);
    deps.audio.reply({ type: 'paused' });
    await next;
    // 新的媒體：第一條音軌照常選用、可播。
    const audio = engine.tracks.find((t) => t.id === engine.selectedTracks.audio);
    expect(audio).toMatchObject({ kind: 'audio', streamIndex: 0, supported: true });
    expect(engine.state).toBe('ready');
  });

  it('退回途中 destroy：load 以 AbortError reject，不再送出 start', async () => {
    const { engine, worker, loading } = await failOnLoad();
    await worker.next('select');
    const rejected = loading.catch((error: unknown) => error);
    await engine.destroy();
    expect(await rejected).toMatchObject({ name: 'AbortError' });
    expect(worker.messages('start')).toHaveLength(1);
    expect(worker.messages('select')).toHaveLength(1);
  });

  it('已經發布媒體之後：標為不支援並發出 trackschange，以 audio: null 重新輸出，發出非致命的 CODEC_UNSUPPORTED', async () => {
    const { engine, worker, changes } = await loaded();
    const errors: EngineError[] = [];
    engine.addEventListener('error', (e) => errors.push(e.error));
    const [start] = worker.messages('start');
    worker.reply({ type: 'audiofailed', epoch: start?.epoch ?? NaN, source: null, error: failure });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.selected).toEqual({ audio: null, video: id.video1, subtitle: null });
    expect(changes[0]?.tracks.find((t) => t.id === id.audioJa)).toMatchObject({
      supported: false,
      unsupportedReason: 'codec',
    });
    expect(worker.messages('select').at(-1)).toMatchObject({ audio: null, video: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'CODEC_UNSUPPORTED',
      fatal: false,
      detail: { trackId: id.audioJa },
    });
    expect(engine.state).toBe('ready');
    expect(engine.error).toBeNull();
  });

  it('已經發布媒體之後、trackschange 的 listener 內改選另一條音軌：不被 audio: null 覆寫', async () => {
    const { engine, deps, worker } = await loaded();
    const fallback: Promise<void>[] = [];
    engine.addEventListener(
      'trackschange',
      () => {
        fallback.push(engine.selectTracks({ audio: id.audioZh }));
      },
      { once: true },
    );
    const [start] = worker.messages('start');
    worker.reply({ type: 'audiofailed', epoch: start?.epoch ?? NaN, source: null, error: failure });
    expect(worker.messages('select')).toHaveLength(1);
    expect(worker.messages('select')[0]).toMatchObject({ audio: 2, video: 1 });
    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    await fallback[0];
    expect(engine.selectedTracks).toEqual({ audio: id.audioZh, video: id.video1, subtitle: null });
  });

  it('只換影片軌途中原本的音軌失敗：更新換軌中的選擇為 audio: null，保留新的影片軌', async () => {
    const { engine, deps, worker } = await loaded();
    const selecting = engine.selectTracks({ video: id.video2 });
    const first = await worker.next('select');
    expect(first).toMatchObject({ audio: 0, video: 3 });
    worker.reply({ type: 'audiofailed', epoch: first.epoch, source: null, error: failure });
    const retry = await worker.next('select', 2);
    expect(retry).toMatchObject({ audio: null, video: 3 });
    frame(worker, 0, retry.epoch);
    deps.audio.reply({ type: 'paused' });
    await selecting;
    expect(engine.selectedTracks).toEqual({ audio: null, video: id.video2, subtitle: null });
    expect(engine.tracks.find((t) => t.id === id.audioJa)?.supported).toBe(false);
  });

  it('已經發布媒體之後、trackschange 的 listener 內 destroy：不再重新輸出，也不發出 error', async () => {
    const { engine, worker } = await loaded();
    const errors: EngineError[] = [];
    engine.addEventListener('error', (e) => errors.push(e.error));
    engine.addEventListener('trackschange', () => void engine.destroy());
    const [start] = worker.messages('start');
    worker.reply({ type: 'audiofailed', epoch: start?.epoch ?? NaN, source: null, error: failure });
    await settle();
    expect(worker.messages('select')).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('load 後只換音軌不殘留影片畫面等待', () => {
  it('load 時影片首張 frame 晚於起點，load 完成後只換音軌不等 2 秒逾時即 resolve', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const deps = createFakeDeps();
    const engine = createEngineWith(deps);
    const loading = engine.load(source);
    const worker = deps.workers.last;
    await worker.probe(media);
    const start = await worker.next('start');
    // 起點是 0，第一張 frame 晚於時鐘（1 秒），尚未畫出。
    frame(worker, 1, start.epoch);
    deps.audio.reply({ type: 'paused' });
    await loading;
    expect(engine.videoSize).toBeNull();

    const selecting = engine.selectTracks({ audio: id.audioZh });
    const select = await worker.next('select');
    frame(worker, 1, select.epoch);
    deps.audio.reply({ type: 'paused' });
    await selecting;
    expect(engine.selectedTracks.audio).toBe(id.audioZh);
  });
});

describe('切換字幕軌', () => {
  it('新 epoch 的 cue 帶新軌的 id，留到 trackschange 之後才送出；舊 epoch 的 cue 丟掉', async () => {
    const { engine, deps, worker, cues } = await loaded({ tracks: { subtitle: id.srt } });
    const start = worker.messages('start')[0];
    if (!start) throw new Error('沒有 start');
    worker.reply({ type: 'cues', epoch: start.epoch, cues: [cue(1)] });
    expect(cues.map((e) => e.trackId)).toEqual([id.srt]);

    const order: string[] = [];
    engine.addEventListener('trackschange', () => order.push('trackschange'));
    engine.addEventListener('cues', (e) => order.push(`cues ${e.trackId}`));
    const selecting = engine.selectTracks({ subtitle: id.ass });
    const select = await worker.next('select');
    expect(select).toMatchObject({ subtitle: 6 });
    worker.reply({ type: 'cues', epoch: start.epoch, cues: [cue(2)] });
    worker.reply({ type: 'cues', epoch: select.epoch, cues: [cue(0.5)] });
    expect(order).toEqual([]);
    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    await selecting;
    expect(order).toEqual(['trackschange', `cues ${id.ass}`]);
    expect(cues.at(-1)?.cues).toMatchObject([{ trackId: id.ass, start: 0.5 }]);

    worker.reply({ type: 'cues', epoch: select.epoch, cues: [cue(3)] });
    expect(cues.at(-1)?.cues).toMatchObject([{ trackId: id.ass, start: 3 }]);
  });

  it('subtitle: null：不再送 cue', async () => {
    const { engine, deps, worker, cues } = await loaded({ tracks: { subtitle: id.srt } });
    const selecting = engine.selectTracks({ subtitle: null });
    const select = await worker.next('select');
    expect(select).toMatchObject({ subtitle: null });
    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    await selecting;
    worker.reply({ type: 'cues', epoch: select.epoch, cues: [cue(3)] });
    expect(cues).toHaveLength(0);
  });
});

describe('不能選的軌', () => {
  it('supported: false：reject 非致命的 CODEC_UNSUPPORTED，保留原本的軌，不重新供料', async () => {
    const { engine, worker, changes } = await loaded();
    for (const selection of [{ audio: id.audioBad }, { video: id.videoBad }]) {
      const error = await engine.selectTracks(selection).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EngineError);
      expect(error).toMatchObject({ code: 'CODEC_UNSUPPORTED', fatal: false });
    }
    expect(worker.messages('select')).toHaveLength(0);
    expect(engine.selectedTracks).toEqual({ audio: id.audioJa, video: id.video1, subtitle: null });
    expect(engine.state).toBe('ready');
    expect(changes).toHaveLength(0);
  });

  it('不存在的 id 或 kind 不符：reject RangeError；同一個呼叫的其他 kind 也不生效', async () => {
    const { engine, worker } = await loaded();
    await expect(engine.selectTracks({ audio: 'a:99' })).rejects.toThrow(RangeError);
    await expect(engine.selectTracks({ subtitle: id.srt, audio: id.video2 })).rejects.toThrow(
      RangeError,
    );
    expect(worker.messages('select')).toHaveLength(0);
    expect(engine.selectedTracks.subtitle).toBeNull();
  });

  it('沒有媒體：reject InvalidStateError', async () => {
    const deps = createFakeDeps();
    const engine = createEngineWith(deps);
    await expect(engine.selectTracks({ audio: null })).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
  });
});

describe('取代', () => {
  it('同一 kind 連續呼叫只保留最後一個：執行中的被取代、reject AbortError，只有最後一個生效', async () => {
    const { engine, deps, worker, changes } = await loaded();
    const first = engine.selectTracks({ audio: id.audioZh });
    const firstResult = first.catch((e: unknown) => e);
    await worker.next('select');
    const second = engine.selectTracks({ audio: id.audioJa });
    expect(await firstResult).toMatchObject({ name: 'AbortError' });

    // 第一個已經改了輸出，所以即使選回原本的軌也要重新供料。
    expect(await worker.next('select', 2)).toMatchObject({ audio: 0 });
    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    await second;
    expect(engine.selectedTracks.audio).toBe(id.audioJa);
    expect(changes).toHaveLength(0);
  });

  it('排隊中的呼叫要改的 kind 都被較新的呼叫接手時被取代；還有自己負責的 kind 時照常執行', async () => {
    const { engine, deps, worker } = await loaded();
    const running = engine.selectTracks({ subtitle: id.srt });
    const runningResult = running.catch((e: unknown) => e);
    await worker.next('select');
    const queued = engine.selectTracks({ audio: id.audioZh, subtitle: id.ass });
    const queuedResult = queued.catch((e: unknown) => e);
    // running 的 subtitle 被 queued 接手：被取代，queued 接著開始。
    expect(await runningResult).toMatchObject({ name: 'AbortError' });
    expect(await worker.next('select', 2)).toMatchObject({ audio: 2, subtitle: 6 });

    const partly = engine.selectTracks({ audio: id.audioZh });
    // queued 的 audio 被 partly 接手，subtitle 還是它的：不被取代，只以 subtitle 重新輸出（音軌回到已生效的）。
    expect(await worker.next('select', 3)).toMatchObject({ audio: 0, subtitle: 6 });
    const last = engine.selectTracks({ subtitle: null });
    // 這時 queued 的 subtitle 也被接手：被取代，last 接著開始（輸出換回沒有字幕、原本的音軌）。
    expect(await queuedResult).toMatchObject({ name: 'AbortError' });
    expect(await worker.next('select', 4)).toMatchObject({ audio: 0, subtitle: null });
    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    await last;
    // partly 最後才換音軌。
    expect(await worker.next('select', 5)).toMatchObject({ audio: 2, subtitle: null });
    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    await partly;
    expect(engine.selectedTracks).toEqual({ audio: id.audioZh, video: id.video1, subtitle: null });
  });

  it('執行中的換軌被取代、最後一個呼叫的 id 不存在：reject RangeError，輸出換回已生效的軌', async () => {
    const { engine, deps, worker, changes } = await loaded();
    const first = engine.selectTracks({ audio: id.audioZh }).catch((e: unknown) => e);
    expect(await worker.next('select')).toMatchObject({ audio: 2 });
    const second = engine.selectTracks({ audio: 'a:999' }).catch((e: unknown) => e);
    expect(await first).toMatchObject({ name: 'AbortError' });
    // 第一個已經把輸出改成 a:3：Worker 要回到已生效的 a:1。
    expect(await worker.next('select', 2)).toMatchObject({ audio: 0 });
    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    expect(await second).toBeInstanceOf(RangeError);
    expect(engine.selectedTracks.audio).toBe(id.audioJa);
    expect(changes).toHaveLength(0);
    // 之後選回 a:1 不必再重新供料。
    await engine.selectTracks({ audio: id.audioJa });
    expect(worker.messages('select')).toHaveLength(2);
  });

  it('回復關閉影片時，videoresize listener 的新選擇不會被舊指令覆寫', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, deps, worker, changes } = await loaded({ tracks: { video: null } });
    const first = outcome(engine.selectTracks({ video: id.video1 }));
    const firstEpoch = (await worker.next('select')).epoch;
    const shown = frame(worker, 0, firstEpoch);
    // 畫面已畫出，但 worklet 還沒回報，因此第一個選擇還沒生效。
    expect(engine.videoSize).not.toBeNull();
    expect(engine.selectedTracks.video).toBeNull();
    let latest: Promise<void> | undefined;
    engine.addEventListener(
      'videoresize',
      ({ size }) => {
        if (size === null) latest = engine.selectTracks({ video: id.video2 });
      },
      { once: true },
    );

    const invalid = outcome(engine.selectTracks({ video: 'v:999' }));
    await settle();
    expect(first.value()).toMatchObject({ name: 'AbortError' });
    expect(invalid.value()).toMatchObject({ name: 'AbortError' });
    expect(shown.closed).toBe(true);
    const selections = worker.messages('select');
    expect(selections.map((m) => m.video)).toEqual([1, 3]);
    expect(deps.audio.epoch).toBe(selections[1]?.epoch);
    expect(changes).toHaveLength(0);

    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    await expect(latest).resolves.toBeUndefined();
    expect(engine.selectedTracks.video).toBe(id.video2);
    expect(changes).toHaveLength(1);
    await engine.destroy();
  });

  it('執行中的呼叫的部分 kind 被接手：只以它仍負責的 kind 重新輸出，不以舊的選擇發布', async () => {
    const { engine, deps, worker, changes } = await loaded();
    const first = engine.selectTracks({ audio: id.audioZh, subtitle: id.srt });
    expect(await worker.next('select')).toMatchObject({ audio: 2, subtitle: 5 });
    const second = engine.selectTracks({ audio: id.audioJa });
    // first 的 audio 被接手、subtitle 還是它的：音軌回到已生效的 a:1，字幕照它的選擇。
    expect(await worker.next('select', 2)).toMatchObject({ audio: 0, subtitle: 5 });
    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    await first;
    await second;
    expect(changes.map((c) => c.selected)).toEqual([
      { audio: id.audioJa, video: id.video1, subtitle: id.srt },
    ]);
    expect(engine.selectedTracks).toEqual({
      audio: id.audioJa,
      video: id.video1,
      subtitle: id.srt,
    });
    expect(worker.messages('select')).toHaveLength(2);
  });

  it('不同 kind 的呼叫依序都生效', async () => {
    const { engine, deps, worker } = await loaded();
    const audio = engine.selectTracks({ audio: id.audioZh });
    const subtitle = engine.selectTracks({ subtitle: id.ass });
    await worker.next('select');
    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    await audio;
    expect(await worker.next('select', 2)).toMatchObject({ audio: 2, subtitle: 6 });
    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    await subtitle;
    expect(engine.selectedTracks).toEqual({
      audio: id.audioZh,
      video: id.video1,
      subtitle: id.ass,
    });
  });

  it('load 取代執行中的 selectTracks', async () => {
    const { engine, deps, worker } = await loaded();
    const selecting = engine.selectTracks({ audio: id.audioZh });
    await worker.next('select');
    const loading = engine.load(source);
    await expect(selecting).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
    const next = deps.workers.last;
    await next.probe(media);
    expect(await next.next('start')).toMatchObject({ audio: 0, video: 1 });
    frame(next, 0);
    deps.audio.reply({ type: 'paused' });
    await loading;
    expect(engine.selectedTracks.audio).toBe('a:9');
  });
});

describe('競態', () => {
  it('執行中 destroy：reject AbortError', async () => {
    const { engine, worker } = await loaded();
    const selecting = engine.selectTracks({ audio: id.audioZh });
    await worker.next('select');
    await engine.destroy();
    await expect(selecting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(engine.selectTracks({ audio: id.audioJa })).rejects.toMatchObject({
      code: 'DESTROYED',
    });
  });

  it('執行中 Worker 崩潰：reject 致命的 INTERNAL，state 進入 error', async () => {
    const { engine, worker } = await loaded();
    const selecting = engine.selectTracks({ audio: id.audioZh });
    await worker.next('select');
    worker.crash();
    await expect(selecting).rejects.toMatchObject({ code: 'INTERNAL', fatal: true });
    expect(engine.state).toBe('error');
  });

  it('trackschange 的 listener 內 seek：selectTracks 照常 resolve，seek 從新的選擇開始', async () => {
    const { engine, deps, worker } = await loaded();
    const seeking: Promise<number>[] = [];
    engine.addEventListener(
      'trackschange',
      () => {
        seeking.push(engine.seek(5));
      },
      { once: true },
    );
    const selecting = engine.selectTracks({ audio: id.audioZh });
    await worker.next('select');
    frame(worker, 0);
    deps.audio.reply({ type: 'paused' });
    await selecting;
    expect(engine.selectedTracks.audio).toBe(id.audioZh);
    const seek = await worker.next('seek');
    expect(seek.time).toBe(5);
    frame(worker, 5);
    deps.audio.reply({ type: 'paused' });
    expect(await seeking[0]).toBe(5);
  });
});

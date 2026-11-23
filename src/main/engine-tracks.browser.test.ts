// 播放中切換軌道（#52）：真實的 AudioContext、AudioWorklet、media Worker 與 WebCodecs。換軌時 currentTime 不跳、state
// 不變，生效之後的輸出只有新軌的資料（聲音的頻率、frame 的尺寸、cue 的軌道）。
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { captureDestination, type DestinationCapture } from '../../test/audio-capture.js';
import { amplitudeAt, beepOnsets, mediaUrl } from '../../test/media-worker-harness.js';
import { createEngine } from './engine.js';
import type { CuesEvent, StateChangeEvent } from './events.js';
import type { Engine } from './types.js';
import { until } from '../../test/until.js';

let capture: DestinationCapture;
let engine: Engine | null = null;

beforeEach(() => {
  capture = captureDestination();
});

afterEach(async () => {
  await engine?.destroy();
  engine = null;
  capture.restore();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** `promise` 進行中每 10 ms 記下 currentTime。 */
async function sampleTimes(target: Engine, promise: Promise<unknown>): Promise<number[]> {
  const times = [target.currentTime];
  const state = { done: false };
  void promise.finally(() => (state.done = true));
  const pending = () => !state.done;
  while (pending()) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    times.push(target.currentTime);
  }
  await promise;
  times.push(target.currentTime);
  return times;
}

/** 播放 `path`；AudioContext 無法開始（沒有 autoplay）時回傳 null。 */
async function playing(path: string, canvas: HTMLCanvasElement | null = null) {
  const target = (engine = createEngine({ canvas }));
  const info = await target.load({ kind: 'http', url: mediaUrl(path) }, { paused: false });
  if (target.state !== 'playing') return null;
  return { engine: target, info };
}

test('切換音軌：state 維持 playing、currentTime 不跳；生效之後只聽到新軌（440 Hz）的 beep', async () => {
  const started = await playing('video/multi-track.mkv');
  if (!started) return;
  const { engine: target, info } = started;
  const audio = info.tracks.filter((t) => t.kind === 'audio');
  expect(target.selectedTracks.audio).toBe(audio[0]?.id);
  await until(() => target.currentTime > 1.3);
  const states: StateChangeEvent[] = [];
  target.addEventListener('statechange', (e) => states.push(e));

  const before = target.currentTime;
  const times = await sampleTimes(target, target.selectTracks({ audio: audio[1]?.id ?? null }));
  expect(target.selectedTracks.audio).toBe(audio[1]?.id);
  expect(states).toEqual([]);
  expect(target.state).toBe('playing');
  // 不往回跳、不往前跳：換軌期間時鐘停在切換的位置附近，之後照常前進。
  expect(Math.abs((times[1] ?? NaN) - before)).toBeLessThan(0.05);
  for (let i = 1; i < times.length; i++) {
    expect(times[i] ?? NaN).toBeGreaterThanOrEqual((times[i - 1] ?? NaN) - 1e-3);
  }
  expect((times.at(-1) ?? NaN) - before).toBeLessThan(0.5);

  // 生效之後錄 2.2 秒：每個 beep 都是 440 Hz，沒有 880 Hz 的舊軌。
  const from = capture.frames;
  const sampleRate = capture.context?.sampleRate ?? 48_000;
  await until(() => capture.frames > from + sampleRate * 2.2);
  const [left] = capture.channels();
  const after = left.subarray(from);
  const onsets = beepOnsets(after, sampleRate);
  expect(onsets.length).toBeGreaterThanOrEqual(2);
  for (const onset of onsets) {
    const start = Math.round(onset * sampleRate) + 240;
    expect(amplitudeAt(after, sampleRate, 440, start, 2400)).toBeGreaterThan(0.2);
    expect(amplitudeAt(after, sampleRate, 880, start, 2400)).toBeLessThan(0.02);
  }
});

test('切換影片軌：生效時畫出新軌的 frame（640×360），之後只畫新軌；currentTime 不跳', async () => {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const started = await playing('video/multi-video.mkv', canvas);
  if (!started) return;
  const { engine: target, info } = started;
  const [h264, vp9] = info.tracks.filter((t) => t.kind === 'video');
  if (!h264?.supported || !vp9?.supported) return;
  expect(target.videoSize).toEqual({ width: 320, height: 180, rotation: 0 });
  await until(() => target.currentTime > 1.2);

  const draws: number[] = [];
  const drawImage = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'drawImage')
    ?.value as (...args: unknown[]) => void;
  vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation(function (
    this: CanvasRenderingContext2D,
    ...args: unknown[]
  ) {
    const [image] = args;
    if (image instanceof VideoFrame) draws.push(image.displayWidth);
    drawImage.apply(this, args);
  });
  const before = target.currentTime;
  const times = await sampleTimes(target, target.selectTracks({ video: vp9.id }));
  expect(target.selectedTracks.video).toBe(vp9.id);
  expect(target.state).toBe('playing');
  expect(target.videoSize).toEqual({ width: 640, height: 360, rotation: 0 });
  expect([canvas.width, canvas.height]).toEqual([640, 360]);
  expect(Math.abs((times[1] ?? NaN) - before)).toBeLessThan(0.05);
  expect((times.at(-1) ?? NaN) - before).toBeLessThan(0.5);
  const drawnAt = draws.length;
  expect(draws.at(-1)).toBe(640);
  await until(() => draws.length > drawnAt + 10);
  expect(draws.slice(drawnAt).every((width) => width === 640)).toBe(true);

  // 關掉影片：videoSize 回到 null，聲音照常。
  await target.selectTracks({ video: null });
  expect(target.videoSize).toBeNull();
  const at = target.currentTime;
  await until(() => target.currentTime > at + 0.3);
  expect((await target.getStats()).video).toBeNull();
});

test('切換字幕軌：生效之後只收到新軌的 cue，從目前位置附近開始', async () => {
  const started = await playing('video/multi-track.mkv');
  if (!started) return;
  const { engine: target, info } = started;
  const [srt, ass] = info.tracks.filter((t) => t.kind === 'subtitle');
  if (!srt || !ass) throw new Error('multi-track.mkv 應該有兩條字幕軌');
  await target.selectTracks({ subtitle: srt.id });
  await until(() => target.currentTime > 1.2);
  const cues: CuesEvent[] = [];
  target.addEventListener('cues', (e) => cues.push(e));
  const at = target.currentTime;
  const switching = target.selectTracks({ subtitle: ass.id });
  // 生效（resolve）之前不送新軌的 cue。
  const switched = cues.length;
  await switching;
  const effective = cues.length;
  await until(() => target.currentTime > at + 2.5);
  // 生效之後隨 demux 的進度繼續送出。
  expect(cues.length).toBeGreaterThan(effective);
  const after = cues.slice(switched).flatMap((e) => e.cues);
  expect(after.length).toBeGreaterThan(0);
  expect(after.every((c) => c.trackId === ass.id && c.format === 'ass')).toBe(true);
  // 從切換位置之前的 keyframe（每秒一個）開始 demux。
  expect(after[0]?.start).toBeGreaterThanOrEqual(Math.floor(at) - 1);
  expect(after[0]?.start).toBeLessThanOrEqual(Math.ceil(at));
});

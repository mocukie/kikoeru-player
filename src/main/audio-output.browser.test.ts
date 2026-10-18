// 真實的 AudioContext 與 AudioWorklet：測試扮演 media Worker 經 MessagePort 供料，錄下 destination 的輸出比對。

import { afterEach, beforeEach, expect, test } from 'vitest';
import { captureDestination, type DestinationCapture } from '../../test/audio-capture.js';
import type {
  WorkerToWorkletMessage,
  WorkletToMainMessage,
  WorkletToWorkerMessage,
} from '../protocol/index.js';
import { createWebAudioOutput } from './audio-output.js';
import { AssetLoadError, type AudioOutput, type AudioOutputHandlers } from './deps.js';

const audioBuffer = { targetMs: 150, refillMs: 75, capacityMs: 400 };

let capture: DestinationCapture;
let output: AudioOutput | null = null;
let reports: WorkletToMainMessage[];

beforeEach(() => {
  capture = captureDestination();
  reports = [];
});

afterEach(async () => {
  await output?.close();
  output = null;
  capture.restore();
});

function handlers(): AudioOutputHandlers {
  return {
    message: (message) => reports.push(message),
    statechange: () => undefined,
  };
}

/** 預設硬切（`audioFadeMs` 0），讓逐 sample 的比對不受淡入淡出影響。 */
function open(audioFadeMs = 0): AudioOutput {
  output = createWebAudioOutput(handlers(), { audioBuffer, audioFadeMs });
  return output;
}

/** 每個 sample 都不是 0、且能以 float32 精確表示的 stereo PCM：左聲道 (k + 1) / 1024，右聲道是相反數。 */
function testPcm(frames: number): [Float32Array, Float32Array] {
  const left = Float32Array.from({ length: frames }, (_, i) => ((i % 512) + 1) / 1024);
  return [left, left.map((v) => -v)];
}

/** 一律為 `value` 的 stereo PCM。 */
function constantPcm(frames: number, value: number): [Float32Array, Float32Array] {
  return [new Float32Array(frames).fill(value), new Float32Array(frames).fill(value)];
}

/**
 * 測試用的 feeder：扮演 media Worker，依 worklet 的 `need` 以 2048–4096 frame 的 chunk 送出各 epoch 的 PCM，
 * 送完就送 `eof`。
 */
function feed(
  port: MessagePort,
  sampleRate: number,
  sources: Record<number, [Float32Array, Float32Array]>,
): void {
  const sent = new Map<number, number>();
  const credit = new Map<number, number>();
  const post = (message: WorkerToWorkletMessage, transfer: Transferable[] = []) => {
    port.postMessage(message, transfer);
  };
  port.onmessage = ({ data }: MessageEvent<WorkletToWorkerMessage>) => {
    if (data.type !== 'need') return;
    const source = sources[data.epoch];
    if (!source) return;
    credit.set(data.epoch, (credit.get(data.epoch) ?? 0) + data.frames);
    let offset = sent.get(data.epoch) ?? 0;
    const total = source[0].length;
    if (offset >= total) return;
    while ((credit.get(data.epoch) ?? 0) > 0 && offset < total) {
      const want = Math.min(Math.max(credit.get(data.epoch) ?? 0, 2048), 4096, total - offset);
      const channels = source.map((c) => c.slice(offset, offset + want));
      post({ type: 'pcm', epoch: data.epoch, time: offset / sampleRate, channels }, [
        ...channels.map((c) => c.buffer),
      ]);
      offset += want;
      credit.set(data.epoch, (credit.get(data.epoch) ?? 0) - want);
    }
    sent.set(data.epoch, offset);
    if (offset >= total) post({ type: 'eof', epoch: data.epoch });
  };
}

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('等待逾時');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const reported = (type: WorkletToMainMessage['type'], epoch: number) => () =>
  reports.some((r) => r.type === type && r.epoch === epoch);

/** 第一個不一致的 index；完全一致時為 -1。 */
function firstMismatch(actual: Float32Array, start: number, expected: Float32Array): number {
  for (let i = 0; i < expected.length; i++) {
    if (actual[start + i] !== expected[i]) return i;
  }
  return -1;
}

/** 錄完 ended 之後的一段，確認之後是靜音。 */
async function settle(): Promise<void> {
  const frames = capture.frames;
  await until(() => capture.frames > frames + 4096);
}

test('經 MessagePort 送入的 PCM 在 destination 逐 sample 一致，播完後在 duration 判定 ended', async () => {
  const audio = open();
  const pcm = testPcm(Math.round(audio.sampleRate * 0.5));
  const duration = pcm[0].length / audio.sampleRate;
  audio.post({ type: 'flush', epoch: 1, position: 0 });
  audio.post({ type: 'duration', epoch: 1, duration });
  audio.post({ type: 'play', epoch: 1 });
  feed(await audio.connect(), audio.sampleRate, { 1: pcm });
  await audio.resume();

  await until(reported('ended', 1));
  await settle();
  const ended = reports.findLastIndex((r) => r.type === 'clock');
  expect(reports[ended]).toMatchObject({ position: duration });

  const [left, right] = capture.channels();
  const start = left.findIndex((v) => v !== 0);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(firstMismatch(left, start, pcm[0])).toBe(-1);
  expect(firstMismatch(right, start, pcm[1])).toBe(-1);
  expect(left.subarray(start + pcm[0].length).every((v) => v === 0)).toBe(true);
});

test('新的 epoch 讓 ring 內的舊資料不被播出；暫停時時鐘不前進', async () => {
  const audio = open();
  const stale = constantPcm(Math.round(audio.sampleRate * 0.3), 0.75);
  const pcm = testPcm(Math.round(audio.sampleRate * 0.3));
  audio.post({ type: 'flush', epoch: 1, position: 0 });
  audio.post({ type: 'duration', epoch: 1, duration: 1 });
  feed(await audio.connect(), audio.sampleRate, { 1: stale, 2: pcm });
  await audio.resume();

  // epoch 1 補滿、暫停中：ring 內是舊資料。
  await until(reported('paused', 1));
  await until(() => capture.frames > audio.sampleRate * 0.2);
  expect(reports.filter((r) => r.type === 'clock').every((r) => r.position === 0)).toBe(true);

  audio.post({ type: 'flush', epoch: 2, position: 0 });
  audio.post({ type: 'duration', epoch: 2, duration: pcm[0].length / audio.sampleRate });
  audio.post({ type: 'play', epoch: 2 });
  await until(reported('ended', 2));
  await settle();

  const [left] = capture.channels();
  expect(left.includes(0.75)).toBe(false);
  const start = left.findIndex((v) => v !== 0);
  expect(firstMismatch(left, start, pcm[0])).toBe(-1);
});

test('worklet 載入失敗時 connect() 以 AssetLoadError reject', async () => {
  output = createWebAudioOutput(handlers(), {
    audioBuffer,
    audioFadeMs: 0,
    workletUrl: new URL('/does-not-exist/worklet.js', location.href),
  });
  await expect(output.connect()).rejects.toBeInstanceOf(AssetLoadError);
});

/** 相鄰 sample 差的最大值。 */
function maxStep(samples: Float32Array): number {
  let max = 0;
  for (let i = 1; i < samples.length; i++) {
    max = Math.max(max, Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0)));
  }
  return max;
}

/** 落在 (low, high) 之間（不含兩端）的 sample 數：淡入淡出途中的 sample。 */
function countBetween(samples: Float32Array, low: number, high: number): number {
  const eps = 1e-6;
  return samples.filter((v) => v > low + eps && v < high - eps).length;
}

/** 以 `sources` 供料、開始播放 epoch 1（長 3 秒），等到 worklet 回報 playing。 */
async function startPlaying(
  audio: AudioOutput,
  sources: (sampleRate: number) => Record<number, [Float32Array, Float32Array]>,
): Promise<void> {
  audio.post({ type: 'flush', epoch: 1, position: 0 });
  audio.post({ type: 'duration', epoch: 1, duration: 3 });
  audio.post({ type: 'play', epoch: 1 });
  feed(await audio.connect(), audio.sampleRate, sources(audio.sampleRate));
  await audio.resume();
  await until(reported('playing', 1));
}

/** 再錄 `seconds` 秒。 */
async function record(seconds: number, sampleRate: number): Promise<void> {
  const from = capture.frames;
  await until(() => capture.frames > from + sampleRate * seconds);
}

test('audioFadeMs：開始播放時淡入、pause 時淡出，長度符合設定，沒有不連續的跳點', async () => {
  const audio = open(10);
  const fade = Math.round(audio.sampleRate / 100);
  await startPlaying(audio, (sr) => ({ 1: constantPcm(sr * 3, 0.5) }));
  await record(0.2, audio.sampleRate);
  audio.post({ type: 'pause', epoch: 1 });
  await until(reported('paused', 1));
  await settle();

  const [left] = capture.channels();
  // 淡入與淡出各有 fade − 1 個介於 0 與 0.5 之間的 sample。
  expect(countBetween(left, 0, 0.5)).toBe(2 * (fade - 1));
  expect(maxStep(left)).toBeLessThanOrEqual(0.5 / fade + 1e-6);
  expect(left.at(-1)).toBe(0);
  // 時鐘停在淡出結束的位置：淡出的 sample 也算進去。
  const played = left.filter((v) => v !== 0).length + 1;
  const stopped = reports.findLast((r) => r.type === 'clock');
  expect(stopped?.position).toBeCloseTo(played / audio.sampleRate, 4);
});

test('audioFadeMs：seek（新的 epoch）時舊資料淡出、新資料淡入，沒有不連續的跳點', async () => {
  const audio = open(10);
  const fade = Math.round(audio.sampleRate / 100);
  await startPlaying(audio, (sr) => ({ 1: constantPcm(sr * 3, 0.5), 2: constantPcm(sr, -0.25) }));
  await record(0.2, audio.sampleRate);
  audio.post({ type: 'flush', epoch: 2, position: 1 });
  await until(reported('playing', 2));
  await record(0.1, audio.sampleRate);

  const [left] = capture.channels();
  // 舊資料的淡出與新資料的淡入可能重疊（新的 epoch 很快就補滿），兩者相加仍然連續。
  expect(maxStep(left)).toBeLessThanOrEqual(0.75 / fade + 1e-6);
  const fadeOutFrom = left.lastIndexOf(0.5) + 1;
  const lastOld = left.findLastIndex((v) => v > 0);
  const firstNew = left.indexOf(-0.25);
  // 舊資料在 audioFadeMs 內淡完；新資料淡入 audioFadeMs 才到原本的音量。
  expect(lastOld - fadeOutFrom).toBeLessThan(fade);
  expect(firstNew - fadeOutFrom).toBeGreaterThanOrEqual(fade - 1);
  expect(left.subarray(firstNew).every((v) => v === -0.25)).toBe(true);
});

test('audioFadeMs 0：硬切', async () => {
  const audio = open(0);
  await startPlaying(audio, (sr) => ({ 1: constantPcm(sr * 3, 0.5) }));
  await record(0.1, audio.sampleRate);
  audio.post({ type: 'pause', epoch: 1 });
  await until(reported('paused', 1));
  await settle();

  const [left] = capture.channels();
  expect(countBetween(left, 0, 0.5)).toBe(0);
  expect(maxStep(left)).toBe(0.5);
});

test('setGain：以 setTargetAtTime 平滑地改變音量', async () => {
  const audio = open(0);
  await startPlaying(audio, (sr) => ({ 1: constantPcm(sr * 3, 0.5) }));
  await record(0.1, audio.sampleRate);
  audio.setGain(0.25, true);
  await record(0.3, audio.sampleRate);

  const [left] = capture.channels();
  const start = left.findIndex((v) => v !== 0);
  const steady = left.subarray(start + 1);
  // time constant 10 ms：每個 sample 最多變化 (0.5 − 0.125) / 480 左右。
  expect(maxStep(steady)).toBeLessThan(0.002);
  expect(left.at(-1)).toBeCloseTo(0.125, 3);
  expect(countBetween(steady, 0.125 + 1e-3, 0.5 - 1e-3)).toBeGreaterThan(audio.sampleRate / 200);
});

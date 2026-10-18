// 真實的 AudioContext 與 AudioWorklet：測試扮演 media Worker 經 MessagePort 供料，錄下 destination 的輸出比對。

import { afterEach, beforeEach, expect, test } from 'vitest';
import { captureDestination, type DestinationCapture } from '../../test/audio-capture.js';
import type {
  WorkerToWorkletMessage,
  WorkletToMainMessage,
  WorkletToWorkerMessage,
} from '../protocol/index.js';
import { createWebAudioOutput } from './audio-output.js';
import type { AudioOutput } from './deps.js';

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

function open(): AudioOutput {
  output = createWebAudioOutput((message) => reports.push(message), { audioBuffer });
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
  expect(await audio.unlock()).toBe(true);

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
  expect(await audio.unlock()).toBe(true);

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

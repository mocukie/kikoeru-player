// Engine 與真實的 AudioContext、AudioWorklet、media Worker（#41）：Engine 以外的 suspend／resume、watchdog 重建 context，
// 以及 beforeaudiostart 在 user gesture 的同步段內發出。

import { afterEach, beforeEach, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { captureDestination, type DestinationCapture } from '../../test/audio-capture.js';
import { beepWav, mediaUrl } from '../../test/media-worker-harness.js';
import { createWebAudioOutput } from './audio-output.js';
import type { EngineDeps } from './deps.js';
import { createEngine, createEngineWith } from './engine.js';
import type { StateChangeEvent } from './events.js';
import { createWebMediaWorker } from './media-worker.js';
import { detectPlatform } from './platform.js';
import type { Engine } from './types.js';
import { loadWasmAssets } from './wasm.js';

const source = { kind: 'http', url: mediaUrl('audio/flac.flac') } as const;

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
});

async function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('等待逾時');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function recordChanges(target: Engine): StateChangeEvent[] {
  const changes: StateChangeEvent[] = [];
  target.addEventListener('statechange', (event) => changes.push(event));
  return changes;
}

/** 振幅的最大值。 */
function peak(samples: Float32Array): number {
  return samples.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
}

/** 經 Demo 頁之外的方式取得 Engine 的 AudioContext：錄音 helper 記下了接到 destination 的 context。 */
function context(): AudioContext {
  const ctx = capture.context;
  if (!(ctx instanceof AudioContext)) throw new Error('還沒有 AudioContext');
  return ctx;
}

test('Engine 以外 suspend()／resume() AudioContext：statechange 的 reason 為 external，播放跟著停止與恢復', async () => {
  engine = createEngine();
  const changes = recordChanges(engine);
  await engine.load(source, { paused: false });
  expect(engine.state).toBe('playing');

  await context().suspend();
  await until(() => engine?.state === 'paused');
  expect(engine.paused).toBe(true);
  expect(changes.find((c) => c.paused && c.reason === 'external')).toBeDefined();

  const at = engine.currentTime;
  await context().resume();
  await until(() => engine?.state === 'playing');
  expect(changes.at(-1)).toMatchObject({ state: 'playing', paused: false, reason: 'external' });
  await until(() => (engine?.currentTime ?? 0) > at + 0.3);
});

test('worklet 停止回報 frame：watchdog 重建 AudioContext，從原本的位置繼續播放', async () => {
  // 第一個音訊輸出在開始播放後不再轉送 clock，模擬停住的 context。
  let created = 0;
  let mute = false;
  const createAudioOutput: EngineDeps['createAudioOutput'] = (handlers, config) => {
    const index = ++created;
    return createWebAudioOutput(
      {
        ...handlers,
        message: (message) => {
          if (index === 1 && mute && message.type === 'clock') return;
          handlers.message(message);
        },
      },
      config,
    );
  };
  engine = createEngineWith({
    platform: detectPlatform(navigator),
    loadWasm: () => loadWasmAssets(),
    createWorker: createWebMediaWorker,
    createAudioOutput,
  });
  const changes = recordChanges(engine);
  await engine.load(source, { paused: false });
  await until(() => (engine?.currentTime ?? 0) > 0.5);
  mute = true;
  const position = engine.currentTime;

  await until(() => created === 2);
  await until(() => engine?.state === 'playing' && engine.currentTime > position + 0.5);
  expect(changes.map((c) => c.state)).toContain('buffering');
  expect(engine.error).toBeNull();
  // 重新供料的位置不早於停住時的位置。
  expect(changes.filter((c) => c.state === 'playing')).toHaveLength(2);
});

test('beforeaudiostart 在 gesture 的同步段內發出：listener 內可以同步啟動 <audio>', async () => {
  const target = (engine = createEngine());
  const audio = document.createElement('audio');
  audio.src = URL.createObjectURL(
    new Blob([beepWav({ sampleRate: 48_000, channels: 1, seconds: 1 })], { type: 'audio/wav' }),
  );
  audio.muted = true;
  const button = document.createElement('button');
  button.textContent = 'unlock';
  document.body.append(audio, button);

  let started: Promise<void> | null = null;
  let activeInListener: boolean | undefined;
  target.addEventListener('beforeaudiostart', (event) => {
    expect(event.cause).toBe('unlock');
    if ('userActivation' in navigator) activeInListener = navigator.userActivation.isActive;
    started = audio.play();
  });
  let returned = false;
  button.addEventListener('click', () => {
    target.unlockAudio();
    // listener 在 unlockAudio() 內同步執行完畢。
    returned = started !== null;
  });

  await userEvent.click(button);

  expect(returned).toBe(true);
  if (activeInListener !== undefined) expect(activeInListener).toBe(true);
  await expect(started).resolves.toBeUndefined();
  await until(() => target.audioUnlocked);
  audio.pause();
});

test('muted：輸出變為靜音，currentTime 照常前進；取消後恢復出聲', async () => {
  engine = createEngine();
  await engine.load(source, { paused: false });
  await until(() => (engine?.currentTime ?? 0) > 0.2);

  engine.muted = true;
  const at = engine.currentTime;
  // GainNode 以 time constant 10 ms 趨近 0：等 100 ms 之後才開始錄。
  await new Promise((resolve) => setTimeout(resolve, 100));
  const from = capture.frames;
  await until(() => (engine?.currentTime ?? 0) > at + 0.5);
  expect(engine.state).toBe('playing');
  const [left] = capture.channels();
  expect(peak(left.subarray(from))).toBeLessThan(1e-3);

  engine.muted = false;
  const unmuted = capture.frames;
  // flac.flac 每秒一個 beep：再錄 1.2 秒一定會聽到。
  await until(() => capture.frames > unmuted + context().sampleRate * 1.2);
  const [after] = capture.channels();
  expect(peak(after.subarray(unmuted))).toBeGreaterThan(0.2);
});

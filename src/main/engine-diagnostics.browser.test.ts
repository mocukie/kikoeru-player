// 診斷（#45）：真實的 media Worker 與 AudioWorklet 的 log 經主執行緒送進 hook（scope 與時基），沒有 hook 時不跨執行緒送
// log；getStats() 的每個欄位都有值且型別正確。

import { afterEach, expect, test } from 'vitest';
import type { WireLogLevel } from '../protocol/index.js';
import { mediaUrl } from '../../test/media-worker-harness.js';
import { createWebAudioOutput } from './audio-output.js';
import type { EngineDeps } from './deps.js';
import { createEngine, createEngineWith } from './engine.js';
import { createWebMediaWorker } from './media-worker.js';
import { detectPlatform } from './platform.js';
import type { Engine, EngineOptions, LogEntry } from './types.js';
import { loadWasmAssets } from './wasm.js';

const source = { kind: 'http', url: mediaUrl('audio/flac.flac') } as const;
const scopes = ['io', 'demux', 'audio', 'video', 'subtitle', 'command', 'worker', 'background'];

/** worklet 的 log 時間的容差（ms）：主執行緒的 `AudioContext.currentTime` 以 render 區塊為單位更新。 */
const WORKLET_TIME_SLACK_MS = 50;

let engine: Engine | null = null;

afterEach(async () => {
  await engine?.destroy();
  engine = null;
});

async function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('等待逾時');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 真實的 deps，另外記下 media Worker 送到主執行緒的 log 訊息的等級（跨執行緒傳送的量）。 */
function countingEngine(options: EngineOptions) {
  const crossed: WireLogLevel[] = [];
  const createWorker: EngineDeps['createWorker'] = (handlers) =>
    createWebMediaWorker({
      ...handlers,
      message: (message) => {
        if (message.type === 'log') crossed.push(message.entry.level);
        handlers.message(message);
      },
    });
  const created = createEngineWith(
    {
      platform: detectPlatform(navigator),
      loadWasm: () => loadWasmAssets(),
      createWorker,
      createAudioOutput: createWebAudioOutput,
    },
    options,
  );
  return { engine: created, crossed };
}

test('真實 Worker 的 log：帶正確的 scope，time 是主執行緒的 performance.now()', async () => {
  const entries: LogEntry[] = [];
  const started = performance.now();
  engine = createEngine({ logLevel: 'debug', log: (entry) => entries.push(entry) });
  await engine.load(source, { paused: false });
  await until(() => (engine?.currentTime ?? 0) > 0.3);
  const ended = performance.now();

  for (const entry of entries) {
    expect(scopes).toContain(entry.scope);
    expect(entry.message.length).toBeGreaterThan(0);
    // worklet 的 log 以 AudioContext 的時間換算，誤差約為 audio 的一個 render 區塊。
    const slack = entry.scope === 'audio' ? WORKLET_TIME_SLACK_MS : 1;
    expect(entry.time).toBeGreaterThanOrEqual(started - slack);
    expect(entry.time).toBeLessThanOrEqual(ended + slack);
  }
  // Worker 送來的：Range 請求、開檔完成、開始供料。
  const request = entries.find((e) => e.scope === 'io' && e.message === 'Range 請求');
  expect(request?.data).toMatchObject({ url: source.url });
  expect(
    entries.find((e) => e.scope === 'demux' && e.message.startsWith('開檔完成')),
  ).toBeDefined();
  expect(entries.find((e) => e.scope === 'audio' && e.message === '開始供料')).toBeDefined();
  // 主執行緒的：load 指令在 Worker 的請求之前。
  const load = entries.find((e) => e.scope === 'command' && e.message === 'load');
  expect(load?.time).toBeLessThanOrEqual(request?.time ?? -Infinity);
});

test('沒有 log hook 時 Worker 不送 log；warn 時只有 warn 以上會跨執行緒', async () => {
  const silent = countingEngine({});
  engine = silent.engine;
  await engine.load(source, { paused: false });
  await until(() => (engine?.currentTime ?? 0) > 0.3);
  expect(silent.crossed).toEqual([]);
  await engine.destroy();

  const warn = countingEngine({ logLevel: 'warn', log: () => undefined });
  engine = warn.engine;
  await engine.load(source, { paused: false });
  await until(() => (engine?.currentTime ?? 0) > 0.3);
  expect(warn.crossed.every((level) => level === 'warn' || level === 'error')).toBe(true);
});

test('getStats()：播放中每個欄位都有值且型別正確；沒有影片時 video 為 null', async () => {
  engine = createEngine();
  await engine.load(source, { paused: false });
  await until(() => (engine?.currentTime ?? 0) > 0.5);
  const stats = await engine.getStats();

  expect(stats.bufferAhead).toBeGreaterThan(0);
  expect(stats.audio.ringMs).toBeGreaterThan(0);
  expect(stats.audio.underruns).toBeGreaterThanOrEqual(0);
  expect(stats.audio.outputLatencyMs).toBeGreaterThanOrEqual(0);
  expect(stats.audio.targetMs).toBeGreaterThan(0);
  expect(stats.video).toBeNull();
  expect(stats.packetQueue.audioSeconds).toBeGreaterThan(0);
  expect(stats.packetQueue.videoSeconds).toBe(0);
  expect(stats.packetQueue.bytes).toBeGreaterThan(0);
  expect(stats.cache.bytes).toBeGreaterThan(0);
  expect(stats.cache.limitBytes).toBeGreaterThan(stats.cache.bytes);
  expect(stats.cache.aheadBytes).toBeGreaterThanOrEqual(0);
  expect(stats.cache.readaheadTarget).toBeGreaterThan(0);
  expect(typeof stats.cache.fetching).toBe('boolean');
  expect(stats.cache.hits + stats.cache.misses).toBeGreaterThan(0);
  expect(stats.network.bytesLoaded).toBeGreaterThan(0);
  expect(Array.isArray(stats.network.inflight)).toBe(true);
  for (const request of stats.network.inflight) {
    expect(request).toEqual({
      url: source.url,
      start: expect.any(Number) as number,
      end: expect.any(Number) as number,
      elapsedMs: expect.any(Number) as number,
    });
  }
  // wasm 的 linear memory 至少有初始的大小（以 64 KiB 的 page 為單位）。
  expect(stats.wasmHeapBytes).toBeGreaterThan(0);
  expect(stats.wasmHeapBytes % 65_536).toBe(0);
  expect(stats.resources).toEqual({ workers: 1, libavInstances: 1, openVideoFrames: 0 });

  await engine.destroy();
  const after = await engine.getStats();
  expect(after.wasmHeapBytes).toBe(0);
  expect(after.resources).toEqual({ workers: 0, libavInstances: 0, openVideoFrames: 0 });
});

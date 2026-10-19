// 預讀與 buffering（#39）：starved 的 250 ms 門檻、因網路不足進入 buffering 後要 bufferAhead ≥ 3 秒才恢復、
// buffered 與 bufferedchange、卡住偵測與自動恢復、getStats() 的快取與網路。以假 media Worker 與假音訊輸出驅動。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDeps } from '../../test/fakes/engine-deps.js';
import { audioMedia, type FakeMediaWorker } from '../../test/fakes/media-worker.js';
import { createEngineWith } from './engine.js';
import type {
  BufferedChangeEvent,
  StallEvent,
  StallRecoveredEvent,
  StateChangeEvent,
} from './events.js';
import type { EngineOptions, Source } from './types.js';

const http: Source = { kind: 'http', url: 'https://example.test/a.flac' };
const SR = 48_000;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** load、play，以 worklet 的身分回報 playing；時鐘在 `position`。 */
async function playing(engineOptions?: EngineOptions, source: Source = http) {
  const deps = createFakeDeps();
  const engine = createEngineWith(deps, engineOptions);
  const loading = engine.load(source, { paused: false });
  const worker = deps.workers.last;
  await vi.advanceTimersByTimeAsync(0);
  await worker.probe(audioMedia({ duration: 60 }));
  await worker.next('start');
  deps.audio.reply({ type: 'clock', position: 0, frame: 0, buffered: 0, underruns: 0 });
  deps.audio.reply({ type: 'playing' });
  await loading;
  const states: string[] = [];
  engine.addEventListener('statechange', (event: StateChangeEvent) => {
    if (event.state !== event.previous) states.push(`${event.state}:${event.reason}`);
  });
  const starve = (position: number) => {
    deps.audio.reply({ type: 'clock', position, frame: position * SR, buffered: 0, underruns: 1 });
    deps.audio.reply({ type: 'starved' });
  };
  /** Worker 回報資料備妥到 `end`。 */
  const buffer = (end: number, flags: { eof?: boolean; fetching?: boolean } = {}) => {
    worker.reply({
      type: 'buffer',
      epoch: deps.audio.epoch,
      end,
      eof: flags.eof ?? false,
      fetching: flags.fetching ?? true,
    });
  };
  return { engine, deps, worker, states, starve, buffer };
}

describe('starved 的門檻', () => {
  it('starved 不到 250 ms 就補回來：維持 playing，只計入 underrun', async () => {
    const { engine, deps, states, starve } = await playing();
    starve(5);
    await vi.advanceTimersByTimeAsync(200);
    deps.audio.reply({ type: 'playing' });
    await vi.advanceTimersByTimeAsync(500);
    expect(engine.state).toBe('playing');
    expect(states).toEqual([]);
  });

  it('starved 超過 250 ms 進入 buffering（reason media）', async () => {
    const { engine, states, starve } = await playing();
    starve(5);
    await vi.advanceTimersByTimeAsync(249);
    expect(engine.state).toBe('playing');
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.state).toBe('buffering');
    expect(states).toEqual(['buffering:media']);
  });

  it('starved 的期間 currentTime 停在時鐘停住的位置', async () => {
    const { engine, deps, starve } = await playing();
    starve(5);
    deps.audio.frameNow = 6 * SR;
    expect(engine.currentTime).toBe(5);
  });
});

describe('因網路不足進入 buffering 之後的恢復', () => {
  async function buffering() {
    const setup = await playing();
    setup.starve(5);
    await vi.advanceTimersByTimeAsync(250);
    return setup;
  }

  it('要 bufferAhead ≥ 3 秒才讓 worklet 恢復輸出', async () => {
    const { engine, deps, buffer } = await buffering();
    expect(deps.audio.intent).toBe('pause');
    // worklet 停住而回報的 paused 不讓 Engine 離開 buffering。
    deps.audio.reply({ type: 'paused' });
    expect(engine.state).toBe('buffering');

    buffer(7.9);
    expect(deps.audio.intent).toBe('pause');
    buffer(8);
    expect(deps.audio.intent).toBe('play');
    deps.audio.reply({ type: 'playing' });
    expect(engine.state).toBe('playing');
  });

  it('已讀到檔尾時不足 3 秒也恢復', async () => {
    const { deps, buffer } = await buffering();
    buffer(6, { eof: true });
    expect(deps.audio.intent).toBe('play');
  });

  it('預讀已達目標（不再抓取）時不足 3 秒也恢復', async () => {
    const { deps, buffer } = await buffering();
    buffer(6, { fetching: false });
    expect(deps.audio.intent).toBe('play');
  });

  it('舊 epoch 的進度不算', async () => {
    const { deps, worker } = await buffering();
    worker.reply({
      type: 'buffer',
      epoch: deps.audio.epoch - 1,
      end: 60,
      eof: true,
      fetching: false,
    });
    expect(deps.audio.intent).toBe('pause');
  });

  it('等待中 seek()：worklet 恢復播放，落點後進入 playing', async () => {
    const { engine, deps } = await buffering();
    expect(deps.audio.intent).toBe('pause');
    void engine.seek(20);
    expect(deps.audio.intent).toBe('play');
    deps.audio.reply({ type: 'playing' });
    expect(engine.state).toBe('playing');
    expect(engine.paused).toBe(false);
  });

  it('等待中 pause()：進入 paused', async () => {
    const { engine, deps } = await buffering();
    deps.audio.reply({ type: 'paused' });
    const pausing = engine.pause();
    deps.audio.reply({ type: 'paused' });
    await pausing;
    expect(engine.state).toBe('paused');
  });
});

describe('buffered 與 bufferedchange', () => {
  it('http 來源：從 currentTime 到 Worker 回報的終點，一段', async () => {
    const { engine, buffer } = await playing();
    expect(engine.buffered).toEqual([]);
    buffer(12.5);
    expect(engine.buffered).toEqual([{ start: 0, end: 12.5 }]);
  });

  it('bytes 來源：[0, duration]', async () => {
    const { engine } = await playing(undefined, { kind: 'bytes', data: new Uint8Array(8) });
    expect(engine.buffered).toEqual([{ start: 0, end: 60 }]);
  });

  it('unload() 之後為空，並發出 bufferedchange', async () => {
    const { engine, buffer } = await playing();
    buffer(12.5);
    const changes: BufferedChangeEvent[] = [];
    engine.addEventListener('bufferedchange', (event: BufferedChangeEvent) => changes.push(event));
    await vi.advanceTimersByTimeAsync(250);
    await engine.unload();
    await vi.advanceTimersByTimeAsync(250);
    expect(engine.buffered).toEqual([]);
    expect(changes.at(-1)?.buffered).toEqual([]);
  });

  it('idle 時為空', () => {
    const engine = createEngineWith(createFakeDeps());
    expect(engine.buffered).toEqual([]);
  });

  it('終點變動 ≥ 0.5 秒才發出，並受 timeUpdateInterval 節流', async () => {
    const { engine, buffer } = await playing({ timeUpdateInterval: 250 });
    const ends: number[] = [];
    engine.addEventListener('bufferedchange', (event: BufferedChangeEvent) =>
      ends.push(event.buffered[0]?.end ?? NaN),
    );
    buffer(10);
    expect(ends).toEqual([10]);
    buffer(10.4);
    buffer(11);
    buffer(12);
    expect(ends).toEqual([10]);
    await vi.advanceTimersByTimeAsync(250);
    expect(ends).toEqual([10, 12]);
    buffer(12.3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ends).toEqual([10, 12]);
  });
});

describe('卡住', () => {
  async function stalled(options: EngineOptions = {}) {
    const setup = await playing({ stallTimeout: 1000, stallAttempts: 2, ...options });
    const stalls: StallEvent[] = [];
    const recovered: StallRecoveredEvent[] = [];
    setup.engine.addEventListener('stall', (event: StallEvent) => stalls.push(event));
    setup.engine.addEventListener('stallrecovered', (event: StallRecoveredEvent) =>
      recovered.push(event),
    );
    setup.starve(5);
    await vi.advanceTimersByTimeAsync(250);
    return { ...setup, stalls, recovered };
  }

  it('buffering 超過 stallTimeout：發出 stall，中止讀取並從目前位置重新 seek', async () => {
    const { engine, deps, worker, stalls } = await stalled();
    const since = performance.now();
    const seeks = worker.messages('seek').length;
    await vi.advanceTimersByTimeAsync(999);
    expect(stalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({ since, position: 5 });
    const seek = worker.messages('seek').at(-1);
    expect(worker.messages('seek')).toHaveLength(seeks + 1);
    expect(seek).toMatchObject({ time: 5, epoch: deps.audio.epoch });
    expect(engine.state).toBe('buffering');
  });

  it('恢復後發出 stallrecovered，帶卡住的時間與嘗試次數', async () => {
    const { engine, deps, buffer, recovered } = await stalled();
    await vi.advanceTimersByTimeAsync(1000);
    deps.audio.reply({ type: 'paused' });
    await vi.advanceTimersByTimeAsync(500);
    buffer(20);
    deps.audio.reply({ type: 'playing' });
    expect(engine.state).toBe('playing');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ stalledMs: 1500, attempts: 1 });
  });

  it('沒有卡住的 buffering 恢復時不發出 stallrecovered', async () => {
    const { deps, buffer, recovered } = await stalled();
    buffer(20);
    deps.audio.reply({ type: 'playing' });
    expect(recovered).toEqual([]);
  });

  it('用完 stallAttempts 仍卡住：以最後一次的讀取錯誤進入 error（reason stall）', async () => {
    const { engine, worker, stalls, states } = await stalled();
    worker.reply({
      type: 'readerror',
      error: { code: 'SOURCE_SERVER', fatal: false, message: '503', detail: { status: 503 } },
    });
    worker.reply({
      type: 'readerror',
      error: { code: 'SOURCE_NETWORK', fatal: false, message: '斷線', detail: { url: 'u' } },
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(stalls).toHaveLength(2);
    expect(engine.state).toBe('buffering');
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.state).toBe('error');
    expect(states.at(-1)).toBe('error:stall');
    expect(engine.error).toMatchObject({
      code: 'SOURCE_NETWORK',
      fatal: true,
      position: 5,
      detail: { url: 'u' },
    });
  });

  it('沒有讀取錯誤（請求停住）時以 SOURCE_NETWORK 進入 error', async () => {
    const { engine } = await stalled({ stallAttempts: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.error).toMatchObject({
      code: 'SOURCE_NETWORK',
      detail: { url: 'https://example.test/a.flac' },
    });
  });

  it('使用者 pause 結束這次卡住的計數', async () => {
    const { engine, deps, stalls } = await stalled();
    await vi.advanceTimersByTimeAsync(500);
    const pausing = engine.pause();
    deps.audio.reply({ type: 'paused' });
    await pausing;
    await vi.advanceTimersByTimeAsync(5000);
    expect(stalls).toEqual([]);
  });
});

describe('getStats', () => {
  it('bufferAhead 取自 Worker 回報的終點；快取、網路與封包佇列取自 Worker', async () => {
    const { engine, worker, buffer } = await playing();
    buffer(12.5);
    const stats = engine.getStats();
    const cache = {
      bytes: 1000,
      limitBytes: 128 * 1024 * 1024,
      aheadBytes: 500,
      readaheadTarget: 800,
      fetching: true,
      hits: 3,
      misses: 4,
    };
    const network = {
      bytesLoaded: 12_345,
      inflight: [{ url: 'u', start: 0, end: 9, elapsedMs: 5 }],
    };
    const packetQueue = { audioSeconds: 2, videoSeconds: 0, bytes: 64_000 };
    await respondStats(worker, { cache, network, packetQueue });
    expect(await stats).toMatchObject({ bufferAhead: 12.5, cache, network, packetQueue });
  });

  it('沒有 Worker 時 limitBytes 為設定值、其餘為 0', async () => {
    const engine = createEngineWith(createFakeDeps(), { limits: { cacheBytes: 1234 } });
    expect((await engine.getStats()).cache).toMatchObject({ bytes: 0, limitBytes: 1234 });
  });
});

async function respondStats(
  worker: FakeMediaWorker,
  stats: Parameters<FakeMediaWorker['stats']>[1],
): Promise<void> {
  await worker.stats(1, stats);
}

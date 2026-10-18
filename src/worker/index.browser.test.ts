// 真實的 media Worker：以主執行緒的寫法建立，依 src/protocol/ 回覆 probe 結果與 PCM。
import { afterEach, describe, expect, test } from 'vitest';
import {
  audioTracks,
  faultyMediaUrl,
  importOnlyWasm,
  mediaUrl,
  WorkerDriver,
} from '../../test/media-worker-harness.js';
import type { RetryPolicy, WorkerLimits, WorkerToMainMessage } from '../protocol/index.js';

const workers: Worker[] = [];

afterEach(() => {
  for (const worker of workers.splice(0)) worker.terminate();
});

function spawn(
  module?: WebAssembly.Module,
  retry?: RetryPolicy,
  limits?: Partial<WorkerLimits>,
): Promise<WorkerDriver> {
  const worker = new Worker(new URL('./index.js', import.meta.url), { type: 'module' });
  workers.push(worker);
  return WorkerDriver.init(
    {
      post: (message, transfer = []) => {
        worker.postMessage(message, transfer);
      },
      onMessage: (listener) => {
        worker.onmessage = ({ data }: MessageEvent<WorkerToMainMessage>) => {
          listener(data);
        };
      },
    },
    { module, retry, ...(limits && { limits }) },
  );
}

test('http 來源：回覆 probe 結果與帶 epoch 的 PCM，直到 EOF', async () => {
  const driver = await spawn();
  const media = await driver.load({ kind: 'http', url: mediaUrl('audio/flac.flac') }, 3);
  expect(media).toMatchObject({ format: 'flac', duration: 10 });
  const [track] = audioTracks(media);
  expect(track).toMatchObject({ codec: 'flac', supported: true });

  const pcm = await driver.decode(track?.streamIndex ?? -1, { epoch: 4 });
  expect(pcm.chunks.every((c) => c.epoch === 4)).toBe(true);
  expect(pcm.left.length).toBe(10 * 48_000);
  expect(driver.worklet.at(-1)).toEqual({ type: 'eof', epoch: 4 });
  expect(await driver.stats()).toMatchObject({ libavInstances: 1 });
});

test('http 來源：連續 seek 時中止讀取，最後一個 seek 從落點輸出到結尾', async () => {
  const driver = await spawn();
  await driver.load({ kind: 'http', url: mediaUrl('audio/pcm-s16.wav') });
  await driver.decode(0, { frames: 4096 });
  for (let epoch = 2; epoch < 32; epoch++) {
    driver.post({ type: 'seek', epoch, time: (epoch * 1.37) % 9.5 });
    driver.need(epoch, 48_000);
    if (epoch % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const pcm = await driver.seek(7.25, 32);
  expect(pcm.time).toBe(7.25);
  expect(pcm.chunks.every((c) => c.epoch === 32)).toBe(true);
  expect(pcm.left.length).toBe(2.75 * 48_000);
  expect(driver.messages.filter((m) => m.type === 'error' || m.type === 'crash')).toEqual([]);
});

test('bytes 來源以 transfer 傳入；每個聲道的 PCM 各自一個 transfer 過來的 buffer', async () => {
  const driver = await spawn();
  const data = await (await fetch(mediaUrl('audio/opus.opus'))).arrayBuffer();
  driver.post({ type: 'load', epoch: 1, source: { kind: 'bytes', data } }, [data]);
  expect(data.byteLength).toBe(0);
  await driver.waitFor((m) => m.type === 'probe');
  const { chunks } = await driver.decode(0, { frames: 4096 });
  expect(chunks).toHaveLength(1);
  const [left, right] = chunks[0]?.channels ?? [];
  expect(left?.length).toBe(4096);
  expect(left?.buffer).not.toBe(right?.buffer);
});

test('無法辨識的格式回覆 FORMAT_UNSUPPORTED，instance 被丟棄', async () => {
  const driver = await spawn();
  const garbage = new Uint8Array(8192).fill(0x5a);
  await expect(driver.load({ kind: 'bytes', data: garbage })).rejects.toMatchObject({
    code: 'FORMAT_UNSUPPORTED',
  });
  expect(await driver.stats()).toMatchObject({ libavInstances: 0 });
});

test('http 404 回覆 SOURCE_NOT_FOUND', async () => {
  const driver = await spawn();
  await expect(
    driver.load({ kind: 'http', url: mediaUrl('audio/does-not-exist.flac') }),
  ).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND', fatal: true });
  expect(await driver.stats()).toMatchObject({ libavInstances: 0 });
});

test('wasm 與 glue 的 imports 不符：load 回覆 ASSET_LOAD_FAILED，instance 被丟棄', async () => {
  // glue 的 imports 只有 module "a"，其中沒有這個函式：instantiate 以 LinkError reject。
  const driver = await spawn(importOnlyWasm('a', 'kikoeru_missing'));
  const data = await (await fetch(mediaUrl('audio/flac.flac'))).arrayBuffer();
  await expect(driver.load({ kind: 'bytes', data })).rejects.toMatchObject({
    code: 'ASSET_LOAD_FAILED',
    fatal: true,
  });
  expect(await driver.stats()).toMatchObject({ libavInstances: 0 });
});

describe('http 的故障（test/server 的故障注入）', () => {
  const retry: RetryPolicy = { attempts: 2, baseDelayMs: 10 };
  /** 10 秒、48 kHz stereo s16 的 WAV（約 1.8 MiB）：Worker 每次讀 256 KiB，播放中會發出多個請求。 */
  const WAV = 'audio/pcm-s16.wav';
  const FRAMES = 10 * 48_000;

  test.each([
    ['401@1', 'SOURCE_UNAUTHORIZED', 401],
    ['403@1', 'SOURCE_FORBIDDEN', 403],
    ['410@1', 'SOURCE_NOT_FOUND', 410],
    ['200@1', 'SOURCE_RANGE_UNSUPPORTED', 200],
    ['503@1%2B', 'SOURCE_SERVER', 503],
  ])('開檔時 %s 回報 %s，帶 status 與 url', async (fault, code, status) => {
    const driver = await spawn(undefined, retry);
    const url = faultyMediaUrl('audio/flac.flac', `fault=${fault}`);
    await expect(driver.load({ kind: 'http', url })).rejects.toMatchObject({
      code,
      fatal: true,
      detail: { status, url },
    });
    expect(await driver.stats()).toMatchObject({ libavInstances: 0 });
  });

  test('503@2：重試後恢復，解出完整的音訊', async () => {
    const driver = await spawn(undefined, retry);
    const url = faultyMediaUrl('audio/flac.flac', 'fault=503@2');
    await driver.load({ kind: 'http', url });
    const pcm = await driver.decode(0);
    expect(pcm.left.length).toBe(FRAMES);
  });

  test('delay=200：回應變慢仍然完成', async () => {
    const driver = await spawn(undefined, retry);
    const url = faultyMediaUrl('audio/flac.flac', 'delay=200');
    await driver.load({ kind: 'http', url });
    expect((await driver.decode(0)).left.length).toBe(FRAMES);
  });

  test('drop@500KB：播放中斷線，重試後恢復，解出完整的音訊', async () => {
    const driver = await spawn(undefined, retry);
    await driver.load({ kind: 'http', url: faultyMediaUrl(WAV, 'fault=drop@500KB') });
    expect((await driver.decode(0)).left.length).toBe(FRAMES);
  });

  test('drop@500KB+：重試用完，播放中回報 SOURCE_NETWORK', async () => {
    const driver = await spawn(undefined, retry);
    const url = faultyMediaUrl(WAV, 'fault=drop@500KB%2B');
    await driver.load({ kind: 'http', url });
    await expect(driver.decode(0, { epoch: 2 })).rejects.toMatchObject({
      type: 'error',
      epoch: 2,
      error: { code: 'SOURCE_NETWORK', fatal: true, detail: { url } },
    });
  });

  test('播放中 401 不重試，回報 SOURCE_UNAUTHORIZED', async () => {
    // 第 1 個請求探測大小，第 2 個是開檔，之後是預讀：預讀 1 秒（不到 1 個區塊），每個請求 1 個區塊。
    // 預讀遇到 401 之後，播放讀到那裡才回報。
    const driver = await spawn(
      undefined,
      { attempts: 3, baseDelayMs: 2000 },
      { readaheadSeconds: 1 },
    );
    const url = faultyMediaUrl(WAV, 'fault=401@4');
    await driver.load({ kind: 'http', url });
    const started = performance.now();
    await expect(driver.decode(0, { epoch: 2 })).rejects.toMatchObject({
      type: 'error',
      epoch: 2,
      error: { code: 'SOURCE_UNAUTHORIZED', fatal: true, detail: { status: 401, url } },
    });
    // 有重試的話至少要等一次 2 秒的退避。
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test('stall@0：開檔的讀取停住，被新的 load 取代後新的 load 照常完成', async () => {
    const driver = await spawn(undefined, retry);
    driver.post({
      type: 'load',
      epoch: 1,
      source: { kind: 'http', url: faultyMediaUrl('audio/flac.flac', 'fault=stall@0') },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(driver.messages.filter((m) => m.type !== 'stats')).toEqual([]);

    const media = await driver.load({ kind: 'http', url: mediaUrl('audio/flac.flac') }, 2);
    expect(audioTracks(media)).toHaveLength(1);
    expect(await driver.stats()).toMatchObject({ libavInstances: 1 });
    expect(driver.messages.filter((m) => 'epoch' in m && m.epoch === 1)).toEqual([]);
  });
});

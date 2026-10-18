// 真實的 media Worker：以主執行緒的寫法建立，依 src/protocol/ 回覆 probe 結果與 PCM。
import { afterEach, expect, test } from 'vitest';
import {
  audioTracks,
  importOnlyWasm,
  mediaUrl,
  WorkerDriver,
} from '../../test/media-worker-harness.js';
import type { WorkerToMainMessage } from '../protocol/index.js';

const workers: Worker[] = [];

afterEach(() => {
  for (const worker of workers.splice(0)) worker.terminate();
});

function spawn(module?: WebAssembly.Module): Promise<WorkerDriver> {
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
    { module },
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
  expect(await driver.stats()).toEqual({ libavInstances: 1 });
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
  expect(await driver.stats()).toEqual({ libavInstances: 0 });
});

test('http 404 回覆 SOURCE_NOT_FOUND', async () => {
  const driver = await spawn();
  await expect(
    driver.load({ kind: 'http', url: mediaUrl('audio/does-not-exist.flac') }),
  ).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND', fatal: true });
  expect(await driver.stats()).toEqual({ libavInstances: 0 });
});

test('wasm 與 glue 的 imports 不符：load 回覆 ASSET_LOAD_FAILED，instance 被丟棄', async () => {
  // glue 的 imports 只有 module "a"，其中沒有這個函式：instantiate 以 LinkError reject。
  const driver = await spawn(importOnlyWasm('a', 'kikoeru_missing'));
  const data = await (await fetch(mediaUrl('audio/flac.flac'))).arrayBuffer();
  await expect(driver.load({ kind: 'bytes', data })).rejects.toMatchObject({
    code: 'ASSET_LOAD_FAILED',
    fatal: true,
  });
  expect(await driver.stats()).toEqual({ libavInstances: 0 });
});

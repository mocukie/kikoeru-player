// Engine 的影片繪製（#50）：真實的 media Worker、WebCodecs 與 2D canvas。CI 組的影片左上 64×64 的框在每整秒開始的
// 3 個 frame 是白色，其餘時候是黑色（test/media/README.md）；讀 canvas 的 pixel 確認畫出的 frame 與方向。
// Chromium 的 VideoFrame 是 I420、Firefox 是 BGRX，兩種格式都經過同一條 drawImage 路徑。
import { afterEach, expect, test } from 'vitest';
import { mediaUrl } from '../../test/media-worker-harness.js';
import { createEngine } from './engine.js';
import type { Engine, VideoSize } from './types.js';

let engine: Engine | null = null;

afterEach(async () => {
  await engine?.destroy();
  engine = null;
  document.body.replaceChildren();
});

function canvas(): HTMLCanvasElement {
  const element = document.createElement('canvas');
  document.body.append(element);
  return element;
}

/** (x, y) 的亮度（0–255）。 */
function luma(target: HTMLCanvasElement, x: number, y: number): number {
  const context = target.getContext('2d');
  if (!context) throw new Error('沒有 2D context');
  const [r = 0, g = 0, b = 0] = context.getImageData(x, y, 1, 1).data;
  return (r + g + b) / 3;
}

async function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('等待逾時');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 影片軌被瀏覽器支援時才測（Firefox 沒有系統的 H.264 decoder 時標為 platform）。 */
async function load(path: string, target: HTMLCanvasElement | null) {
  engine = createEngine({ canvas: target });
  const sizes: (VideoSize | null)[] = [];
  engine.addEventListener('videoresize', (e) => sizes.push(e.size));
  const info = await engine.load({ kind: 'http', url: mediaUrl(path) });
  const video = info.tracks.find((t) => t.kind === 'video');
  return { engine, sizes, supported: video?.supported === true };
}

test('load 完成時畫出第一張 frame：canvas 為顯示尺寸，左上是白框', async () => {
  const target = canvas();
  const { engine, sizes, supported } = await load('video/h264-aac.mp4', target);
  if (!supported) return;
  expect(engine.selectedTracks.video).not.toBeNull();
  expect(engine.videoSize).toEqual({ width: 320, height: 180, rotation: 0 });
  expect(sizes).toEqual([{ width: 320, height: 180, rotation: 0 }]);
  expect([target.width, target.height]).toEqual([320, 180]);
  expect(luma(target, 10, 10)).toBeGreaterThan(200);
});

test('暫停中 seek：畫出落點的 frame（白框只在每整秒開始的 0.1 秒）', async () => {
  const target = canvas();
  const { engine, supported } = await load('video/vp9-opus.webm', target);
  if (!supported) return;
  await engine.seek(1.5);
  expect(luma(target, 10, 10)).toBeLessThan(50);
  await engine.seek(2.05);
  expect(luma(target, 10, 10)).toBeGreaterThan(200);
});

test('旋轉的影片：canvas 為 180×320，白框轉到左下（逆時針 90°）', async () => {
  const target = canvas();
  const { engine, sizes, supported } = await load('video/rotated-90.mp4', target);
  if (!supported) return;
  expect(engine.videoSize).toEqual({ width: 180, height: 320, rotation: 270 });
  expect(sizes).toEqual([{ width: 180, height: 320, rotation: 270 }]);
  expect([target.width, target.height]).toEqual([180, 320]);
  // 白框（平時是黑框）在左下：0 秒白、1.5 秒黑。
  expect(luma(target, 10, 310)).toBeGreaterThan(200);
  await engine.seek(1.5);
  expect(luma(target, 10, 310)).toBeLessThan(50);
});

test('SAR 2:1 的影片：videoSize 與 canvas 為 640×180，畫面拉寬', async () => {
  const target = canvas();
  const { engine, supported } = await load('video/sar-2-1.mkv', target);
  if (!supported) return;
  expect(engine.videoSize).toEqual({ width: 640, height: 180, rotation: 0 });
  expect([target.width, target.height]).toEqual([640, 180]);
  // 64×64 的白框拉寬成 128×64。
  expect(luma(target, 120, 10)).toBeGreaterThan(200);
});

test('換成不同尺寸的影片時發出 videoresize', async () => {
  const target = canvas();
  const { engine, sizes, supported } = await load('video/h264-aac.mp4', target);
  if (!supported) return;
  await engine.load({ kind: 'http', url: mediaUrl('video/rotated-90.mp4') });
  expect(sizes).toEqual([
    { width: 320, height: 180, rotation: 0 },
    null,
    { width: 180, height: 320, rotation: 270 },
  ]);
});

test('attachCanvas：之後才接上的 canvas 立即畫上目前的 frame；null 之後不再畫，但照樣解碼', async () => {
  const { engine, supported } = await load('video/h264-aac.mp4', null);
  if (!supported) return;
  expect(engine.videoSize).toEqual({ width: 320, height: 180, rotation: 0 });
  const target = canvas();
  engine.attachCanvas(target);
  expect(luma(target, 10, 10)).toBeGreaterThan(200);

  engine.attachCanvas(null);
  await engine.seek(1.5);
  // 沒有繪製：canvas 停在白框。
  expect(luma(target, 10, 10)).toBeGreaterThan(200);
  const stats = await engine.getStats();
  expect(stats.video?.decoded).toBeGreaterThan(0);
});

test('播放：依音訊時鐘前進，stats 有解碼數；destroy 之後 openVideoFrames 為 0', async () => {
  const target = canvas();
  const { engine, supported } = await load('video/av1-opus.webm', target);
  if (!supported) return;
  await engine.play().catch(() => undefined);
  if (engine.state !== 'playing') return;
  await until(() => engine.currentTime > 1.5);
  const stats = await engine.getStats();
  expect(stats.video?.decoded).toBeGreaterThan(30);
  expect(stats.resources.openVideoFrames).toBeGreaterThan(0);
  expect(stats.resources.openVideoFrames).toBeLessThanOrEqual(12);
  await engine.destroy();
  expect((await engine.getStats()).resources.openVideoFrames).toBe(0);
});

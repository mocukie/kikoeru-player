// Demo 頁的影片（#50）：白框對 beep 的同步（docs/testing.md「E2E」的自動同步斷言）。
//
// init script 載入 test/audio-capture.ts 錄下送到 destination 的聲音，並在每個 rAF 讀 Demo 頁 canvas 左上的 pixel，
// 記下白框出現的時刻（`performance.now()`）。錄到的 beep 起點換算成被聽到的時刻（扣掉 Engine 回報的輸出延遲），
// 與白框出現的時刻比較。測試媒體的白框與 beep 同時開始（test/media/README.md）。
import { expect, test, type Page } from '@playwright/test';
import type * as AudioCaptureModule from '../audio-capture.js';
import type { DestinationCapture } from '../audio-capture.js';
import type * as HarnessModule from '../media-worker-harness.js';
import { WHITE_BOX_TO_BEEP_TOLERANCE } from './tolerances.js';

/** 頁面上的 Engine 只用到的部分（Demo 頁以 `engine` 放在 globalThis）。 */
interface PageEngine {
  state: string;
  currentTime: number;
  media: { tracks: { kind: string; supported: boolean }[] } | null;
  videoSize: { width: number; height: number; rotation: number } | null;
  getStats(): Promise<{
    audio: { outputLatencyMs: number };
    video: { decoded: number; dropped: number } | null;
    resources: { openVideoFrames: number };
  }>;
}

interface E2EWindow {
  engine: PageEngine;
  e2eCapture: Promise<DestinationCapture>;
  /** 播放中每個 rAF 的「聽到 context 時間 0 的 `performance.now()`」（ms），取中位數換算 beep 被聽到的時刻。 */
  e2eHeardOrigins: number[];
  /** 白框出現（左上的 pixel 由暗轉亮）的 `performance.now()`（ms）。 */
  e2eWhiteOnsets: number[];
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as E2EWindow;
    // 以變數指定，讓 TypeScript 不把它當成檔案路徑解析；由 Vite 轉成 JS 提供。
    const captureModule = '/test/audio-capture.ts';
    w.e2eCapture = (import(captureModule) as Promise<typeof AudioCaptureModule>).then((m) =>
      m.captureDestination(),
    );
    w.e2eHeardOrigins = [];
    w.e2eWhiteOnsets = [];
    let latencyMs = NaN;
    let latencyAt = -Infinity;
    let white = false;
    let context2d: CanvasRenderingContext2D | null = null;
    const sample = () => {
      const engine = (w as Partial<E2EWindow>).engine;
      const perf = performance.now();
      const canvas = document.getElementById('video');
      if (canvas instanceof HTMLCanvasElement) {
        context2d ??= canvas.getContext('2d', { willReadFrequently: true });
        const [r = 0, g = 0, b = 0] = context2d?.getImageData(10, 10, 1, 1).data ?? [];
        const now = (r + g + b) / 3 > 200;
        if (now && !white && engine?.state === 'playing') w.e2eWhiteOnsets.push(perf);
        white = now;
      }
      void w.e2eCapture.then((capture) => {
        const context = capture.context as AudioContext | null;
        if (!engine || !context || engine.state !== 'playing') return;
        if (perf - latencyAt > 250) {
          latencyAt = perf;
          void engine.getStats().then((stats) => (latencyMs = stats.audio.outputLatencyMs));
        }
        if (Number.isNaN(latencyMs)) return;
        w.e2eHeardOrigins.push(perf - context.currentTime * 1000 + latencyMs);
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto('/demo/?background=0');
  await page.evaluate(async () => {
    await (window as unknown as E2EWindow).e2eCapture;
  });
  await expect(page.locator('#media option')).not.toHaveCount(0);
});

async function load(page: Page, path: string): Promise<boolean> {
  await page.locator('#media').selectOption(path);
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('ready');
  return page.evaluate(
    () =>
      (window as unknown as E2EWindow).engine.media?.tracks.some(
        (t) => t.kind === 'video' && t.supported,
      ) ?? false,
  );
}

function currentTime(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as E2EWindow).engine.currentTime);
}

/** `since`（`performance.now()`，ms）之後的 beep 被聽到的時刻與白框出現的時刻（ms）。 */
function onsets(page: Page, since: number): Promise<{ beeps: number[]; whites: number[] }> {
  return page.evaluate(async (since) => {
    const w = window as unknown as E2EWindow;
    const harness = '/test/media-worker-harness.ts';
    const { beepOnsets } = (await import(harness)) as typeof HarnessModule;
    const capture = await w.e2eCapture;
    const sampleRate = capture.context?.sampleRate ?? NaN;
    const [left] = capture.channels();
    const origins = w.e2eHeardOrigins.slice().sort((a, b) => a - b);
    const heardOrigin = origins[Math.floor(origins.length / 2)] ?? NaN;
    const beeps = beepOnsets(left, sampleRate)
      .map((onset) => heardOrigin + ((capture.startFrame + onset * sampleRate) / sampleRate) * 1000)
      .filter((perf) => perf > since);
    return { beeps, whites: w.e2eWhiteOnsets.filter((perf) => perf > since) };
  }, since);
}

/** 每個 beep 都有一個白框在容差之內出現（beep 至少要 `count` 個）。 */
function expectWhiteBoxesOnBeeps(found: { beeps: number[]; whites: number[] }, count: number) {
  const beeps = found.beeps.slice(0, count);
  expect(beeps).toHaveLength(count);
  for (const beep of beeps) {
    const nearest = Math.min(...found.whites.map((white) => Math.abs(white - beep)));
    expect(nearest / 1000, `beep 在 ${beep.toFixed(0)} ms`).toBeLessThanOrEqual(
      WHITE_BOX_TO_BEEP_TOLERANCE,
    );
  }
}

/** 以 Demo 頁的進度條 seek：設定值並發出拖曳（input）與放開（change）。 */
async function seekBar(page: Page, time: number): Promise<void> {
  await page.locator('#seek').evaluate((input: HTMLInputElement, time) => {
    input.value = String(time);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, time);
}

for (const path of ['video/h264-aac.mp4', 'video/vp9-opus.webm']) {
  test(`白框對 beep ≤ 1 個影片 frame + 1 個 rAF（${path}）`, async ({ page }) => {
    test.skip(!(await load(page, path)), '瀏覽器不支援這個影片 codec');
    // load 完成時畫出第一張 frame（0 秒，白框）。
    await expect
      .poll(() => page.evaluate(() => (window as unknown as E2EWindow).engine.videoSize))
      .toEqual({ width: 320, height: 180, rotation: 0 });
    const before = await page.evaluate(() => performance.now());
    await page.locator('#play').click();
    await expect(page.locator('#state')).toHaveText('playing');
    await expect.poll(() => currentTime(page), { timeout: 5000 }).toBeGreaterThan(3.3);

    // 0 秒的那一聲在開始播放的瞬間（淡入），不拿來比。
    const found = await onsets(page, before);
    expectWhiteBoxesOnBeeps({ ...found, beeps: found.beeps.slice(1) }, 3);
  });
}

test('播放中 seek 之後：白框對 beep 仍 ≤ 1 個影片 frame + 1 個 rAF', async ({ page }) => {
  test.skip(!(await load(page, 'video/h264-aac.mp4')), '瀏覽器不支援這個影片 codec');
  await page.locator('#play').click();
  await expect.poll(() => currentTime(page)).toBeGreaterThan(1.5);

  const before = await page.evaluate(() => performance.now());
  await seekBar(page, 4.5);
  await expect(page.locator('#log li').filter({ hasText: /seeked 4\.500$/ })).toHaveCount(1);
  await expect(page.locator('#state')).toHaveText('playing');
  await expect.poll(() => currentTime(page), { timeout: 5000 }).toBeGreaterThan(7.3);

  expectWhiteBoxesOnBeeps(await onsets(page, before), 3);
  const stats = await page.evaluate(() => (window as unknown as E2EWindow).engine.getStats());
  expect(stats.video?.decoded).toBeGreaterThan(60);
});

test('Demo 頁顯示影片的 videoSize 與 stats', async ({ page }) => {
  test.skip(!(await load(page, 'video/rotated-90.mp4')), '瀏覽器不支援這個影片 codec');
  await expect(page.locator('#video-size')).toHaveText('180×320 rotation=270');
  await expect(page.locator('#log li').filter({ hasText: 'videoresize 180×320' })).toHaveCount(1);
  await expect(page.locator('#wasm-video-stats')).toContainText('video decoded');
});

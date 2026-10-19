// Demo 頁的音量與靜音（#42）：以滑桿與 checkbox 操作，錄下送到 destination 的聲音，確認音量的比例、靜音與恢復。
//
// init script 載入 test/audio-capture.ts（同 playback.spec.ts）。測試媒體每秒一個振幅 0.5 的 beep（長 0.1 秒），
// 錄 1.2 秒一定涵蓋一個完整的 beep，以峰值比較。
import { expect, test, type Page } from '@playwright/test';
import type * as AudioCaptureModule from '../audio-capture.js';
import type { DestinationCapture } from '../audio-capture.js';
import type * as HarnessModule from '../media-worker-harness.js';
import { GAIN_SETTLE_MS, MUTED_PEAK_MAX, VOLUME_RATIO_TOLERANCE } from './tolerances.js';

interface E2EWindow {
  engine: { currentTime: number; volume: number; muted: boolean };
  e2eCapture: Promise<DestinationCapture>;
}

/** 每段錄音的長度（秒）。 */
const WINDOW_SECONDS = 1.2;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as E2EWindow;
    // 以變數指定，讓 TypeScript 不把它當成檔案路徑解析；由 Vite 轉成 JS 提供。
    const captureModule = '/test/audio-capture.ts';
    w.e2eCapture = (import(captureModule) as Promise<typeof AudioCaptureModule>).then((m) =>
      m.captureDestination(),
    );
  });
  await page.goto('/demo/?background=0');
  await page.evaluate(async () => {
    await (window as unknown as E2EWindow).e2eCapture;
  });
  await expect(page.locator('#media option')).not.toHaveCount(0);
});

/** 等音量的變化趨近完成，再錄 `WINDOW_SECONDS` 秒，回傳左聲道的峰值。 */
async function recordPeak(page: Page): Promise<number> {
  await page.waitForTimeout(GAIN_SETTLE_MS);
  return page.evaluate(async (seconds) => {
    const w = window as unknown as E2EWindow;
    const harness = '/test/media-worker-harness.ts';
    const { peak } = (await import(harness)) as typeof HarnessModule;
    const capture = await w.e2eCapture;
    const length = Math.round((capture.context?.sampleRate ?? NaN) * seconds);
    const from = capture.frames;
    while (capture.frames < from + length) await new Promise((r) => setTimeout(r, 50));
    const [left] = capture.channels();
    return peak(left.subarray(from, from + length));
  }, WINDOW_SECONDS);
}

/** 以 Demo 頁的音量滑桿設定 volume（設定值並發出 input 與 change）。 */
async function volumeBar(page: Page, volume: number): Promise<void> {
  await page.locator('#volume').evaluate((input: HTMLInputElement, volume) => {
    input.value = String(volume);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, volume);
  await expect(page.locator('#volume-value')).toHaveText(volume.toFixed(2));
}

function currentTime(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as E2EWindow).engine.currentTime);
}

test('volume 0.5 讓輸出減半；muted 時靜音、currentTime 照常前進，取消後以原本的音量恢復', async ({
  page,
}) => {
  await page.locator('#media').selectOption('audio/flac.flac');
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('ready');
  await page.locator('#play').click();
  await expect(page.locator('#state')).toHaveText('playing');

  const full = await recordPeak(page);
  // 確實錄到這個 Engine 的 beep，否則下面的比例沒有意義。
  expect(full).toBeGreaterThan(0.4);

  await volumeBar(page, 0.5);
  const half = await recordPeak(page);
  expect(Math.abs(half / full - 0.5)).toBeLessThanOrEqual(VOLUME_RATIO_TOLERANCE);

  await page.locator('#muted').check();
  await expect(page.locator('#log li').filter({ hasText: 'muted = true' })).toHaveCount(1);
  const mutedAt = await currentTime(page);
  expect(await recordPeak(page)).toBeLessThan(MUTED_PEAK_MAX);
  // 等待加上錄音至少經過 GAIN_SETTLE_MS + WINDOW_SECONDS 的 context 時間。
  expect(await currentTime(page)).toBeGreaterThanOrEqual(mutedAt + WINDOW_SECONDS);
  await expect(page.locator('#state')).toHaveText('playing');

  await page.locator('#muted').uncheck();
  await expect(page.locator('#log li').filter({ hasText: 'muted = false' })).toHaveCount(1);
  const restored = await recordPeak(page);
  expect(Math.abs(restored / full - 0.5)).toBeLessThanOrEqual(VOLUME_RATIO_TOLERANCE);
  expect(await page.evaluate(() => (window as unknown as E2EWindow).engine.volume)).toBe(0.5);
});

// Demo 頁的純音訊播放（#36）：以 Demo 頁的按鈕操作 Engine，錄下送到 destination 的聲音。
//
// init script 載入 test/audio-capture.ts：包住 `AudioNode.prototype.connect`，在接到 destination 的地方旁接錄音 worklet；
// 並在每個 rAF 記下 Engine 的 `currentTime` 與 `getOutputTimestamp()`。
import { expect, test, type Page } from '@playwright/test';
import type * as AudioCaptureModule from '../audio-capture.js';
import type { DestinationCapture } from '../audio-capture.js';
import type * as HarnessModule from '../media-worker-harness.js';
import { BEEP_ONSET_TOLERANCE } from './tolerances.js';

/** 頁面內的一筆取樣（rAF）。 */
interface Sample {
  /** `performance.now()`（ms）。 */
  perf: number;
  /** Engine 的 `currentTime`（秒）。 */
  time: number;
  /** 依 `getOutputTimestamp()`：聽到 context 時間 0 的 `performance.now()`（ms）；取不到 timestamp 時依 `currentTime`。 */
  heardOrigin: number;
}

/** 頁面上的 Engine 只用到的部分（Demo 頁以 `engine` 放在 globalThis）。 */
interface PageEngine {
  state: string;
  paused: boolean;
  currentTime: number;
  duration: number;
  getStats(): Promise<{ resources: { workers: number } }>;
}

interface E2EWindow {
  engine: PageEngine;
  e2eCapture: Promise<DestinationCapture>;
  e2eSamples: Sample[];
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as E2EWindow;
    // 以變數指定，讓 TypeScript 不把它當成檔案路徑解析；由 Vite 轉成 JS 提供。
    const captureModule = '/test/audio-capture.ts';
    w.e2eCapture = (import(captureModule) as Promise<typeof AudioCaptureModule>).then((m) =>
      m.captureDestination(),
    );
    w.e2eSamples = [];
    const sample = () => {
      const engine = (w as Partial<E2EWindow>).engine;
      void w.e2eCapture.then((capture) => {
        const context = capture.context as AudioContext | null;
        if (!engine || !context || engine.state !== 'playing') return;
        const perf = performance.now();
        const time = engine.currentTime;
        const { contextTime = 0, performanceTime = 0 } = context.getOutputTimestamp();
        const heardOrigin =
          contextTime > 0
            ? performanceTime - contextTime * 1000
            : perf - context.currentTime * 1000;
        w.e2eSamples.push({ perf, time, heardOrigin });
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto('/demo/');
  await page.evaluate(async () => {
    await (window as unknown as E2EWindow).e2eCapture;
  });
  await expect(page.locator('#media option')).not.toHaveCount(0);
});

async function load(page: Page, path: string): Promise<void> {
  await page.locator('#media').selectOption(path);
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('ready');
}

function currentTime(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as E2EWindow).engine.currentTime);
}

for (const path of ['audio/flac.flac', 'audio/pcm-s16.wav']) {
  test(`beep 被聽到的時刻，currentTime 與 beep 的位置相差 ≤ 20 ms（${path}）`, async ({ page }) => {
    await load(page, path);
    await page.locator('#play').click();
    await expect(page.locator('#state')).toHaveText('playing');
    await expect.poll(() => currentTime(page), { timeout: 5000 }).toBeGreaterThan(2.3);

    const result = await page.evaluate(async () => {
      const w = window as unknown as E2EWindow;
      const harness = '/test/media-worker-harness.ts';
      const { beepOnsets } = (await import(harness)) as typeof HarnessModule;
      const capture = await w.e2eCapture;
      const sampleRate = capture.context?.sampleRate ?? NaN;
      const [left] = capture.channels();
      const samples = w.e2eSamples.slice();
      const origins = samples.map((s) => s.heardOrigin).sort((a, b) => a - b);
      const heardOrigin = origins[Math.floor(origins.length / 2)] ?? NaN;
      // 錄到的 beep 起點 → 送進 graph 的 context 時間 → 被聽到的 performance.now()。
      const heardAt = beepOnsets(left, sampleRate).map(
        (onset) => heardOrigin + ((capture.startFrame + onset * sampleRate) / sampleRate) * 1000,
      );
      /** 依前後兩筆取樣內插 `perf` 時的 currentTime。 */
      const timeAt = (perf: number): number => {
        const after = samples.findIndex((s) => s.perf >= perf);
        const a = samples[after - 1];
        const b = samples[after];
        if (!a || !b) return NaN;
        return a.time + ((b.time - a.time) * (perf - a.perf)) / (b.perf - a.perf);
      };
      return { onsets: heardAt.length, times: heardAt.map(timeAt) };
    });

    // 播放從 0 開始，第 k 個 beep 在 k 秒；0 秒的那一聲在開始播放的瞬間，不拿來比。
    expect(result.onsets).toBeGreaterThanOrEqual(3);
    for (const k of [1, 2]) {
      expect(Math.abs((result.times[k] ?? NaN) - k)).toBeLessThanOrEqual(BEEP_ONSET_TOLERANCE);
    }
  });
}

test('CI 組的純音訊檔都能播放與暫停，並輸出聲音', async ({ page, request }) => {
  test.setTimeout(180_000);
  const paths = ((await (await request.get('/media/index.json')).json()) as string[]).filter((p) =>
    p.startsWith('audio/'),
  );
  expect(paths.length).toBeGreaterThan(10);

  for (const path of paths) {
    await test.step(path, async () => {
      await load(page, path);
      const before = await page.evaluate(
        async () => (await (window as unknown as E2EWindow).e2eCapture).frames,
      );
      await page.locator('#play').click();
      await expect(page.locator('#state')).toHaveText('playing');
      await expect.poll(() => currentTime(page)).toBeGreaterThan(0.3);
      await page.locator('#pause').click();
      await expect(page.locator('#state')).toHaveText('paused');

      const paused = await currentTime(page);
      expect(paused).toBeGreaterThan(0.3);
      const peak = await page.evaluate(async (from) => {
        const capture = await (window as unknown as E2EWindow).e2eCapture;
        const [left, right] = capture.channels();
        let max = 0;
        for (let i = from; i < left.length; i++) {
          max = Math.max(max, Math.abs(left[i] ?? 0), Math.abs(right[i] ?? 0));
        }
        return max;
      }, before);
      // 0 秒的 beep 振幅 0.5（5.1 downmix 後各聲道的混合也超過這個值）。
      expect(peak).toBeGreaterThan(0.2);
      expect(await currentTime(page)).toBe(paused);
    });
  }
});

test('播到結尾：發出 ended，state 為 ended，currentTime 等於 duration', async ({ page }) => {
  test.setTimeout(30_000);
  await load(page, 'audio/flac.flac');
  await page.locator('#play').click();
  await expect(page.locator('#state')).toHaveText('ended', { timeout: 15_000 });
  await expect(page.locator('#log li').filter({ hasText: /s ended$/ })).toHaveCount(1);

  const engine = await page.evaluate(() => {
    const { state, paused, currentTime, duration } = (window as unknown as E2EWindow).engine;
    return { state, paused, currentTime, duration };
  });
  expect(engine).toEqual({ state: 'ended', paused: false, currentTime: 10, duration: 10 });
});

test('連續 load 兩個檔案：舊的 Worker 被 terminate', async ({ page }) => {
  await load(page, 'audio/flac.flac');
  await load(page, 'audio/opus.opus');

  const stats = await page.evaluate(() => (window as unknown as E2EWindow).engine.getStats());
  expect(stats.resources.workers).toBe(1);
  await expect.poll(() => page.workers().length).toBe(1);
});

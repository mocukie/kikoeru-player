// Demo 頁的純音訊播放（#36）：以 Demo 頁的按鈕操作 Engine，錄下送到 destination 的聲音。
//
// init script 載入 test/audio-capture.ts：包住 `AudioNode.prototype.connect`，在接到 destination 的地方旁接錄音 worklet；
// 並在每個 rAF 記下 Engine 的 `currentTime` 與 context 的時間。錄音點在 destination 之前，比對時扣掉 Engine 回報的
// 輸出延遲（`getStats().audio.outputLatencyMs`，docs/testing.md「E2E」）。
import { expect, test, type Page } from '@playwright/test';
import type * as AudioCaptureModule from '../audio-capture.js';
import type { DestinationCapture } from '../audio-capture.js';
import type * as HarnessModule from '../media-worker-harness.js';
import {
  BEEP_ONSET_TOLERANCE,
  RELOAD_RESUME_SLACK,
  STRETCHED_BEEP_INTERVAL_TOLERANCE,
  STRETCHED_BEEP_ONSET_TOLERANCE,
} from './tolerances.js';

/** 頁面內的一筆取樣（rAF）。 */
interface Sample {
  /** `performance.now()`（ms）。 */
  perf: number;
  /** Engine 的 `currentTime`（秒）。 */
  time: number;
  /** 聽到 context 時間 0 的 `performance.now()`（ms）：context 的 `currentTime` 扣掉 Engine 回報的輸出延遲。 */
  heardOrigin: number;
}

/** 頁面上的 Engine 只用到的部分（Demo 頁以 `engine` 放在 globalThis）。 */
interface PageEngine {
  state: string;
  paused: boolean;
  currentTime: number;
  duration: number;
  getStats(): Promise<{ resources: { workers: number }; audio: { outputLatencyMs: number } }>;
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
    // Engine 回報的輸出延遲（ms）；getStats() 是非同步的，約每 250 ms 更新一次。
    let latencyMs = NaN;
    let latencyAt = -Infinity;
    const sample = () => {
      const engine = (w as Partial<E2EWindow>).engine;
      void w.e2eCapture.then((capture) => {
        const context = capture.context as AudioContext | null;
        if (!engine || !context || engine.state !== 'playing') return;
        const perf = performance.now();
        if (perf - latencyAt > 250) {
          latencyAt = perf;
          void engine.getStats().then((stats) => (latencyMs = stats.audio.outputLatencyMs));
        }
        if (Number.isNaN(latencyMs)) return;
        const time = engine.currentTime;
        const heardOrigin = perf - context.currentTime * 1000 + latencyMs;
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

/** 被聽到的 beep：聽到的 `performance.now()`（ms）與那一刻 Engine 的 `currentTime`（依前後兩筆取樣內插）。 */
interface HeardBeep {
  perf: number;
  time: number;
}

/**
 * 錄到的 beep 起點換算成被聽到的時刻：錄到的 sample → 送進 graph 的 context 時間 → 被聽到的 `performance.now()`。
 * 只取 `since`（`performance.now()`，ms）之後聽到、前後都有取樣可以內插 `currentTime` 的。
 */
function heardBeeps(page: Page, since = 0): Promise<HeardBeep[]> {
  return page.evaluate(async (since) => {
    const w = window as unknown as E2EWindow;
    const harness = '/test/media-worker-harness.ts';
    const { beepOnsets } = (await import(harness)) as typeof HarnessModule;
    const capture = await w.e2eCapture;
    const sampleRate = capture.context?.sampleRate ?? NaN;
    const [left] = capture.channels();
    const samples = w.e2eSamples.slice();
    const origins = samples.map((s) => s.heardOrigin).sort((a, b) => a - b);
    const heardOrigin = origins[Math.floor(origins.length / 2)] ?? NaN;
    /** 依前後兩筆取樣內插 `perf` 時的 currentTime；中間跨過不在 playing 的期間（間隔超過 100 ms）時為 NaN。 */
    const timeAt = (perf: number): number => {
      const after = samples.findIndex((s) => s.perf >= perf);
      const a = samples[after - 1];
      const b = samples[after];
      if (!a || !b || b.perf - a.perf > 100) return NaN;
      return a.time + ((b.time - a.time) * (perf - a.perf)) / (b.perf - a.perf);
    };
    return beepOnsets(left, sampleRate)
      .map((onset) => heardOrigin + ((capture.startFrame + onset * sampleRate) / sampleRate) * 1000)
      .filter((perf) => perf > since)
      .map((perf) => ({ perf, time: timeAt(perf) }))
      .filter((beep) => !Number.isNaN(beep.time));
  }, since);
}

/**
 * 最先聽到的幾個 beep 依序在 `expected` 秒，被聽到時 `currentTime` 與 beep 的位置相差不超過容差。
 * 之後聽到的不比（取樣到讀取結果之間播放仍在繼續）。
 */
function expectBeepsOnTime(
  beeps: HeardBeep[],
  expected: number[],
  tolerance = BEEP_ONSET_TOLERANCE,
): void {
  const first = beeps.slice(0, expected.length);
  expect(first.map((b) => Math.round(b.time))).toEqual(expected);
  for (const { time } of first) {
    expect(Math.abs(time - Math.round(time))).toBeLessThanOrEqual(tolerance);
  }
}

/**
 * 暫停後 currentTime 停住的位置：淡出結束之後，輸出延遲內聽到的還是之前的 sample，currentTime 會再走一小段才停。
 */
async function settledTime(page: Page): Promise<number> {
  let last = NaN;
  await expect
    .poll(async () => {
      const previous = last;
      last = await currentTime(page);
      return last === previous;
    })
    .toBe(true);
  return last;
}

/**
 * 拿來比的第一個 beep 的秒數：`time` 之後至少 50 ms 的第一個整數秒，緊接在接續點之後的 beep 可能被淡入削掉起點。
 * 比對時以 `next - 0.5` 篩選聽到的 beep，與這裡的選擇一致：`time` 到 `next` 之間（包括那 50 ms 內）的 beep 不比。
 * 只篩 `b.time > time` 不夠：`time` 落在整數秒前 50 ms 內時，那一秒的 beep 會被留下，卻不在預期之內。
 */
function firstBeepAfter(time: number): number {
  return Math.ceil(time + 0.05);
}

function now(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

for (const path of ['audio/flac.flac', 'audio/pcm-s16.wav']) {
  test(`beep 被聽到的時刻，currentTime 與 beep 的位置相差 ≤ 20 ms（${path}）`, async ({ page }) => {
    await load(page, path);
    await page.locator('#play').click();
    await expect(page.locator('#state')).toHaveText('playing');
    await expect.poll(() => currentTime(page), { timeout: 5000 }).toBeGreaterThan(2.3);

    // 播放從 0 開始，第 k 個 beep 在 k 秒；0 秒的那一聲在開始播放的瞬間，不拿來比。
    expectBeepsOnTime(
      (await heardBeeps(page)).filter((b) => b.time > 0.5),
      [1, 2],
    );
  });
}

/** 以 Demo 頁的進度條 seek：設定值並發出拖曳（input）與放開（change）。 */
async function seekBar(page: Page, time: number): Promise<void> {
  await page.locator('#seek').evaluate((input: HTMLInputElement, time) => {
    input.value = String(time);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, time);
}

test('播放中以進度條 seek：beep 起點對 currentTime ≤ 20 ms', async ({ page }) => {
  await load(page, 'audio/flac.flac');
  await page.locator('#play').click();
  await expect.poll(() => currentTime(page)).toBeGreaterThan(0.5);

  const before = await now(page);
  await seekBar(page, 4.5);
  await expect(page.locator('#log li').filter({ hasText: /seeked 4\.500$/ })).toHaveCount(1);
  await expect(page.locator('#state')).toHaveText('playing');
  await expect.poll(() => currentTime(page), { timeout: 5000 }).toBeGreaterThan(6.3);

  expectBeepsOnTime(await heardBeeps(page, before), [5, 6]);
});

test('暫停中 seek 再播放：從落點開始，beep 起點對 currentTime ≤ 20 ms', async ({ page }) => {
  await load(page, 'audio/pcm-s16.wav');
  await seekBar(page, 6.75);
  await expect(page.locator('#log li').filter({ hasText: /seeked 6\.750$/ })).toHaveCount(1);
  await expect(page.locator('#state')).toHaveText('ready');
  expect(await currentTime(page)).toBe(6.75);

  const before = await now(page);
  await page.locator('#play').click();
  await expect.poll(() => currentTime(page), { timeout: 5000 }).toBeGreaterThan(8.3);
  expectBeepsOnTime(await heardBeeps(page, before), [7, 8]);
});

test('pause 後 resume：beep 起點對 currentTime 仍 ≤ 20 ms', async ({ page }) => {
  await load(page, 'audio/flac.flac');
  await page.locator('#play').click();
  await expect.poll(() => currentTime(page)).toBeGreaterThan(1.3);
  await page.locator('#pause').click();
  await expect(page.locator('#state')).toHaveText('paused');
  const paused = await settledTime(page);

  const before = await now(page);
  await page.locator('#play').click();
  await expect(page.locator('#state')).toHaveText('playing');
  const next = firstBeepAfter(paused);
  await expect.poll(() => currentTime(page), { timeout: 5000 }).toBeGreaterThan(next + 1.3);
  expectBeepsOnTime(
    (await heardBeeps(page, before)).filter((b) => b.time > next - 0.5),
    [next, next + 1],
  );
});

test('播放中 reload：從原本的位置接續播放，舊的 Worker 被 terminate', async ({ page }) => {
  await load(page, 'audio/flac.flac');
  await page.locator('#play').click();
  await expect.poll(() => currentTime(page)).toBeGreaterThan(1.3);

  const before = await now(page);
  const position = await currentTime(page);
  await page.locator('#reload').click();
  await expect(page.locator('#log li').filter({ hasText: /← reload resolve/ })).toHaveCount(1);
  await expect(page.locator('#state')).toHaveText('playing');
  // reload 期間 currentTime 停在按下時的位置附近，之後從那裡接續。
  const resumed = await currentTime(page);
  expect(resumed).toBeGreaterThanOrEqual(position);
  expect(resumed).toBeLessThan(position + RELOAD_RESUME_SLACK);
  const next = firstBeepAfter(resumed);
  await expect.poll(() => currentTime(page), { timeout: 5000 }).toBeGreaterThan(next + 1.3);

  expectBeepsOnTime(
    (await heardBeeps(page, before)).filter((b) => b.time > next - 0.5),
    [next, next + 1],
  );
  const stats = await page.evaluate(() => (window as unknown as E2EWindow).engine.getStats());
  expect(stats.resources.workers).toBe(1);
  await expect.poll(() => page.workers().length).toBe(1);
});

/** 以 Demo 頁的速度滑桿設定 playbackRate（設定值並發出 input 與 change）。 */
async function rateBar(page: Page, rate: number): Promise<void> {
  await page.locator('#rate').evaluate((input: HTMLInputElement, rate) => {
    input.value = String(rate);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, rate);
  await expect(
    page.locator('#log li').filter({ hasText: `playbackRate = ${rate.toFixed(2)}` }),
  ).not.toHaveCount(0);
}

test('atempo 1.25x：beep 的間隔為 0.8 s ± 10 ms，currentTime 依 1.25 倍前進', async ({ page }) => {
  await load(page, 'audio/flac.flac');
  await rateBar(page, 1.25);
  const before = await now(page);
  await page.locator('#play').click();
  await expect(page.locator('#state')).toHaveText('playing');
  await expect.poll(() => currentTime(page), { timeout: 5000 }).toBeGreaterThan(5.3);

  const beeps = (await heardBeeps(page, before)).filter((b) => b.time > 0.5).slice(0, 4);
  expect(beeps.map((b) => Math.round(b.time))).toEqual([1, 2, 3, 4]);
  for (let i = 1; i < beeps.length; i++) {
    const interval = ((beeps[i]?.perf ?? NaN) - (beeps[i - 1]?.perf ?? NaN)) / 1000;
    expect(Math.abs(interval - 0.8)).toBeLessThanOrEqual(STRETCHED_BEEP_INTERVAL_TOLERANCE);
  }
});

test('變速中 seek：beep 起點對 currentTime 在變速的容差內', async ({ page }) => {
  await load(page, 'audio/flac.flac');
  await rateBar(page, 1.25);
  await page.locator('#play').click();
  // 1 秒的 beep 聽完之後才 seek：beepOnsets 以 0.5 秒的靜音分開 beep，太接近會與落點之後的 beep 併在一起。
  await expect.poll(() => currentTime(page)).toBeGreaterThan(1.5);

  const before = await now(page);
  await seekBar(page, 4.5);
  await expect(page.locator('#log li').filter({ hasText: /seeked 4\.500$/ })).toHaveCount(1);
  await expect(page.locator('#state')).toHaveText('playing');
  await expect.poll(() => currentTime(page), { timeout: 5000 }).toBeGreaterThan(7.3);

  expectBeepsOnTime(await heardBeeps(page, before), [5, 6, 7], STRETCHED_BEEP_ONSET_TOLERANCE);
});

test('播放中改速度再回到 1.0x：beep 起點對 currentTime ≤ 20 ms', async ({ page }) => {
  await load(page, 'audio/flac.flac');
  await page.locator('#play').click();
  await expect.poll(() => currentTime(page)).toBeGreaterThan(0.3);
  await rateBar(page, 1.5);
  await expect.poll(() => currentTime(page), { timeout: 5000 }).toBeGreaterThan(3.3);
  await page.locator('#rate-reset').click();
  const reset = await currentTime(page);

  const before = await now(page);
  const next = firstBeepAfter(reset + 0.3);
  await expect.poll(() => currentTime(page), { timeout: 5000 }).toBeGreaterThan(next + 1.3);
  expectBeepsOnTime(
    (await heardBeeps(page, before)).filter((b) => b.time > next - 0.5),
    [next, next + 1],
  );
});

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

      const paused = await settledTime(page);
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

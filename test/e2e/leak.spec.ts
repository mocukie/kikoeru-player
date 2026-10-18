// leak 測試（#40，docs/testing.md「E2E」）：以 CI 組的短檔連續 load 100 次，混入被取代的 load、播放中換檔與播放中
// destroy。每次換檔後 resources 為 1 個 Worker、1 個 libav instance，進行中的請求都屬於目前的媒體（預讀），
// destroy 後全為 0、沒有進行中的請求；
// 最後數 Worker target，並在 GC 後量 JS heap（Chromium 的 CDP）。Firefox 跑不了 CDP 的部分。
import { expect, test, type Page } from '@playwright/test';
import { LEAK_HEAP_GROWTH_BYTES } from './tolerances.js';

/** 頁面上的 Engine 只用到的部分（Demo 頁以 `engine` 放在 globalThis）。 */
interface PageEngine {
  state: string;
  currentTime: number;
  load(source: { kind: 'http'; url: string }, options?: { paused?: boolean }): Promise<unknown>;
  seek(time: number): Promise<number>;
  destroy(): Promise<void>;
  getStats(): Promise<{
    resources: { workers: number; libavInstances: number; openVideoFrames: number };
    network: { inflight: { url: string }[] };
  }>;
}

interface E2EWindow {
  engine: PageEngine;
}

/** 一次換檔的方式。 */
type Step = 'load' | 'play' | 'superseded' | 'seek-then-load' | 'destroy-while-playing';

const FILES = [
  'audio/flac.flac',
  'audio/mp3.mp3',
  'audio/opus.opus',
  'audio/aac.m4a',
  'audio/vorbis.ogg',
  'audio/pcm-s16.wav',
];

const LOADS = 100;

/** 第 `i` 次換檔的方式：每 25 次一次播放中 destroy，每 10 次一次被取代的 load，其餘輪流停在 ready 與播放中換檔。 */
function stepOf(i: number): Step {
  if (i % 25 === 24) return 'destroy-while-playing';
  if (i % 10 === 5) return 'superseded';
  if (i % 10 === 8) return 'seek-then-load';
  return i % 2 === 0 ? 'load' : 'play';
}

interface StepResult {
  resources: { workers: number; libavInstances: number; openVideoFrames: number };
  inflight: { url: string }[];
  superseded: string[];
  state: string;
}

/** 在頁面內執行一次換檔，回傳之後的 resources 與被取代的指令的錯誤名稱。 */
function runStep(page: Page, step: Step, file: string, next: string): Promise<StepResult> {
  return page.evaluate(
    async ({ step, file, next }) => {
      const w = window as unknown as E2EWindow;
      const engine = w.engine;
      const source = (path: string) =>
        ({ kind: 'http', url: new URL(`/media/${path}`, location.href).href }) as const;
      const errorName = (promise: Promise<unknown>) =>
        promise.then(
          () => 'resolved',
          (error: unknown) => (error instanceof Error ? error.name : String(error)),
        );
      const until = async (predicate: () => boolean) => {
        const deadline = performance.now() + 8000;
        while (!predicate()) {
          if (performance.now() > deadline) throw new Error(`等待逾時，state=${engine.state}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      const superseded: string[] = [];
      switch (step) {
        case 'load':
          await engine.load(source(file));
          break;
        case 'play':
          await engine.load(source(file), { paused: false });
          await until(() => engine.currentTime > 0.1);
          break;
        case 'superseded': {
          const first = errorName(engine.load(source(file), { paused: false }));
          await new Promise((resolve) => setTimeout(resolve, 5));
          await engine.load(source(next));
          superseded.push(await first);
          break;
        }
        case 'seek-then-load': {
          await engine.load(source(file), { paused: false });
          const seeking = errorName(engine.seek(5));
          await engine.load(source(next));
          superseded.push(await seeking);
          break;
        }
        case 'destroy-while-playing': {
          await engine.load(source(file), { paused: false });
          await until(() => engine.currentTime > 0.1);
          await engine.destroy();
          break;
        }
      }
      const stats = await engine.getStats();
      return {
        resources: stats.resources,
        inflight: stats.network.inflight,
        superseded,
        state: engine.state,
      };
    },
    { step, file, next },
  );
}

/** Chromium：GC 之後主執行緒的 JS heap（bytes）。 */
async function heapAfterGc(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const { usedSize } = await cdp.send('Runtime.getHeapUsage');
    return usedSize;
  } finally {
    await cdp.detach();
  }
}

/** 以 CDP 數 dedicated Worker 的 target（Firefox 以 Playwright 追蹤的 Worker 代替）。 */
async function workerTargets(page: Page, browserName: string): Promise<number> {
  if (browserName !== 'chromium') return page.workers().length;
  const cdp = await page.context().newCDPSession(page);
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'worker').length;
  } finally {
    await cdp.detach();
  }
}

test('Demo 的 unload：播放中回到 idle、terminate Worker；之後的 load 照常播放', async ({
  page,
  browserName,
}) => {
  await page.goto('/demo/');
  await expect(page.locator('#media option')).not.toHaveCount(0);
  await page.locator('#autoplay').check();
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('playing');

  await page.locator('#unload').click();
  await expect(page.locator('#state')).toHaveText('idle');
  await expect(page.locator('#paused')).toHaveText('true');
  await expect(page.locator('#media-info')).toHaveText('—');
  await expect.poll(() => workerTargets(page, browserName)).toBe(0);
  await expect(page.locator('#resources')).toHaveText(
    'workers 0，libavInstances 0，openVideoFrames 0',
  );

  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('playing');
  await expect.poll(() => workerTargets(page, browserName)).toBe(1);
});

test('連續 load 100 次：resources 與 Worker 不累積，destroy 後全為 0，heap 不增長', async ({
  page,
  browserName,
}) => {
  test.setTimeout(240_000);
  await page.goto('/demo/');
  await expect(page.locator('#media option')).not.toHaveCount(0);

  const one = { workers: 1, libavInstances: 1, openVideoFrames: 0 };
  const none = { workers: 0, libavInstances: 0, openVideoFrames: 0 };
  let baseline: number | null = null;

  for (let i = 0; i < LOADS; i++) {
    const step = stepOf(i);
    const file = FILES[i % FILES.length] ?? 'audio/flac.flac';
    const next = FILES[(i + 1) % FILES.length] ?? 'audio/flac.flac';
    const result = await runStep(page, step, file, next);
    const where = `第 ${String(i)} 次（${step}，${file}）`;
    // 預讀會在換檔後繼續抓目前的媒體；之前（含被取代）的媒體不能留下請求。
    const current = step === 'superseded' || step === 'seek-then-load' ? next : file;
    const stale = result.inflight.filter((r) => !r.url.endsWith(`/media/${current}`));
    expect(stale, where).toEqual([]);
    if (step === 'destroy-while-playing') {
      expect(result.resources, where).toEqual(none);
      expect(result.state, where).toBe('idle');
      await expect.poll(() => workerTargets(page, browserName), { message: where }).toBe(0);
      await page.locator('#recreate').click();
    } else {
      expect(result.resources, where).toEqual(one);
      expect(result.superseded, where).toEqual(
        step === 'superseded' || step === 'seek-then-load' ? ['AbortError'] : [],
      );
      await expect.poll(() => workerTargets(page, browserName), { message: where }).toBe(1);
    }
    // 熱身幾次之後才記下基準：第一次 load 會 compile wasm、建立 AudioContext 與 worklet。
    if (i === 9 && browserName === 'chromium') baseline = await heapAfterGc(page);
  }

  await page.locator('#destroy').click();
  await expect(page.locator('#log li').filter({ hasText: /← destroy resolve/ })).not.toHaveCount(0);
  const final = await page.evaluate(async () => {
    const stats = await (window as unknown as E2EWindow).engine.getStats();
    return { resources: stats.resources, inflight: stats.network.inflight };
  });
  expect(final).toEqual({ resources: none, inflight: [] });
  await expect.poll(() => workerTargets(page, browserName)).toBe(0);

  if (baseline !== null) {
    const growth = (await heapAfterGc(page)) - baseline;
    expect(growth).toBeLessThan(LEAK_HEAP_GROWTH_BYTES);
  }
});

// Demo 頁的預讀與 buffering（#39）：網路不足時進入 buffering、補足後回到 playing，以及 bufferedchange 的節流。
// 網路以 test/server 的 `delay` 變慢；Demo 頁的 query `readahead` 縮短預讀，讓每個請求只有一兩個區塊。
import { expect, test, type Page } from '@playwright/test';
import { THROTTLE_SLACK_MS } from './tolerances.js';

/** 頁面上的 Engine 只用到的部分（Demo 頁以 `engine` 放在 globalThis）。 */
interface PageEngine {
  state: string;
  paused: boolean;
  currentTime: number;
  error: unknown;
  addEventListener(
    type: 'statechange',
    listener: (event: { state: string; previous: string; reason: string }) => void,
  ): void;
  addEventListener(
    type: 'bufferedchange',
    listener: (event: { buffered: { start: number; end: number }[] }) => void,
  ): void;
}

interface E2EWindow {
  engine: PageEngine;
  e2eStates: string[];
  e2eBuffered: { at: number; end: number | null }[];
}

/** 10 秒、48 kHz stereo s16 的 WAV（約 1.8 MiB，每秒約 188 KiB）。 */
const WAV = 'audio/pcm-s16.wav';

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/demo/${query}`);
  await expect(page.locator('#media option')).not.toHaveCount(0);
  await page.evaluate(() => {
    const w = window as unknown as E2EWindow;
    w.e2eStates = [];
    w.e2eBuffered = [];
    w.engine.addEventListener('statechange', (event) => {
      if (event.state !== event.previous) w.e2eStates.push(`${event.state}:${event.reason}`);
    });
    w.engine.addEventListener('bufferedchange', (event) => {
      w.e2eBuffered.push({ at: performance.now(), end: event.buffered[0]?.end ?? null });
    });
  });
}

function states(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as E2EWindow).e2eStates);
}

async function loadAndPlay(page: Page, faults: string): Promise<void> {
  await page.locator('#media').selectOption(WAV);
  await page.locator('#fault-custom').fill(faults);
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('ready', { timeout: 30_000 });
  await page.locator('#play').click();
}

test('網路比位元率慢：進入 buffering，補足之後回到 playing', async ({ page }) => {
  // 預讀 0.5 秒：同時最多兩三個 1 個區塊（約 1.4 秒的音訊）的請求，每個回應慢 4 秒，網路跟不上播放。
  test.setTimeout(90_000);
  await open(page, '?readahead=0.5&stallTimeout=60000');
  await loadAndPlay(page, 'delay=4000');

  await expect
    .poll(() => states(page), { timeout: 20_000 })
    .toEqual(expect.arrayContaining(['buffering:media']));
  const atBuffering = (await states(page)).lastIndexOf('buffering:media');
  await expect
    .poll(async () => (await states(page)).slice(atBuffering + 1), { timeout: 20_000 })
    .toContain('playing:media');
  expect(await page.evaluate(() => (window as unknown as E2EWindow).engine.paused)).toBe(false);
  expect(await page.evaluate(() => (window as unknown as E2EWindow).engine.error)).toBeNull();
  await expect(
    page.locator('#log li').filter({ hasText: /statechange buffering → playing/ }),
  ).not.toHaveCount(0);
});

test('bufferedchange：終點變動 ≥ 0.5 秒才發出，相鄰兩次至少隔 timeUpdateInterval', async ({
  page,
}) => {
  // 預讀 2 秒、每個回應慢 300 ms：終點以每次一兩個區塊往後跳，變動比 timeUpdateInterval（250 ms）頻繁。
  await open(page, '?readahead=2');
  await loadAndPlay(page, 'delay=300');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as E2EWindow).engine.currentTime), {
      timeout: 20_000,
    })
    .toBeGreaterThan(6);

  const events = await page.evaluate(() => (window as unknown as E2EWindow).e2eBuffered);
  expect(events.length).toBeGreaterThan(3);
  for (let i = 1; i < events.length; i++) {
    const previous = events[i - 1];
    const current = events[i];
    if (!previous || !current) continue;
    expect(current.at - previous.at).toBeGreaterThanOrEqual(250 - THROTTLE_SLACK_MS);
    if (previous.end !== null && current.end !== null) {
      expect(Math.abs(current.end - previous.end)).toBeGreaterThanOrEqual(0.5);
    }
  }
  await expect(page.locator('#log li').filter({ hasText: /bufferedchange \[/ })).not.toHaveCount(0);
});

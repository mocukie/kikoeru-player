// Demo 頁的背景播放模組（#44，`/demo/?background=1`）：開關模組、anchor 跟著播放意圖、外部操作 anchor 的鏡像、destroy 時自動 detach。
//
// anchor 不掛進 DOM：init script 包住 `window.Audio`，把模組建立的 `<audio>` 記在 `e2eAnchors`。
import { expect, test, type Page } from '@playwright/test';

interface E2EWindow {
  e2eAnchors: HTMLAudioElement[];
  engine: { state: string; paused: boolean };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as E2EWindow;
    w.e2eAnchors = [];
    const RealAudio = window.Audio;
    window.Audio = function Audio() {
      const element = new RealAudio();
      w.e2eAnchors.push(element);
      return element;
    } as unknown as typeof window.Audio;
  });
});

/** Demo 頁載入完成（媒體清單已列出），選好 `audio/flac.flac`。 */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('#media option')).not.toHaveCount(0);
  await page.locator('#media').selectOption('audio/flac.flac');
}

/** 最後建立的 anchor 的狀態；沒有時為 null。 */
function anchor(page: Page) {
  return page.evaluate(() => {
    const element = (window as unknown as E2EWindow).e2eAnchors.at(-1);
    return element ? { paused: element.paused, src: element.getAttribute('src') } : null;
  });
}

async function anchorPaused(page: Page): Promise<boolean | undefined> {
  return (await anchor(page))?.paused;
}

test('沒有 query 時預設不 attach，勾選後才建立 anchor', async ({ page }) => {
  await open(page, '/demo/');
  await expect(page.locator('#background')).not.toBeChecked();
  await expect(page.locator('#background-state')).toHaveText('detached');
  expect(await anchor(page)).toBeNull();

  await page.locator('#background').check();
  await expect(page.locator('#background-state')).toHaveText('attached');
  expect(await anchor(page)).toMatchObject({ paused: true });
});

test('query background=1 時一開始就 attach：anchor 跟著 play／pause 播放與停止', async ({
  page,
}) => {
  await open(page, '/demo/?background=1');
  await expect(page.locator('#background')).toBeChecked();
  await expect(page.locator('#background-state')).toHaveText('attached');
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('ready');
  expect(await anchorPaused(page)).toBe(true);

  await page.locator('#play').click();
  await expect(page.locator('#state')).toHaveText('playing');
  await expect.poll(() => anchorPaused(page)).toBe(false);

  await page.locator('#pause').click();
  await expect(page.locator('#state')).toHaveText('paused');
  await expect.poll(() => anchorPaused(page)).toBe(true);
  await expect(page.locator('#log li').filter({ hasText: '[background]' })).toHaveCount(0);
});

test('外部暫停 anchor：Engine 跟著暫停（reason command）；外部播放：Engine 跟著播放', async ({
  page,
}) => {
  await open(page, '/demo/?background=1');
  await page.locator('#autoplay').check();
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('playing');
  await expect.poll(() => anchorPaused(page)).toBe(false);

  await page.evaluate(() => (window as unknown as E2EWindow).e2eAnchors.at(-1)?.pause());
  await expect(page.locator('#state')).toHaveText('paused');
  await expect(page.locator('#paused')).toHaveText('true');
  await expect(
    page.locator('#log li').filter({ hasText: /paused=true reason=command$/ }),
  ).not.toHaveCount(0);

  await page.evaluate(() => (window as unknown as E2EWindow).e2eAnchors.at(-1)?.play());
  await expect(page.locator('#state')).toHaveText('playing');
  await expect(page.locator('#paused')).toHaveText('false');
});

test('關掉模組：detach，anchor 停止且不再跟著；重新打開再 attach', async ({ page }) => {
  await open(page, '/demo/?background=1');
  await page.locator('#autoplay').check();
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('playing');
  await expect.poll(() => anchorPaused(page)).toBe(false);

  await page.locator('#background').uncheck();
  await expect(page.locator('#background-state')).toHaveText('detached');
  expect(await anchor(page)).toMatchObject({ paused: true, src: null });
  await page.locator('#pause').click();
  await page.locator('#play').click();
  await expect(page.locator('#state')).toHaveText('playing');
  expect(await anchorPaused(page)).toBe(true);

  await page.locator('#background').check();
  await expect(page.locator('#background-state')).toHaveText('attached');
  // attach 時已經在播放：新的 anchor 立即開始。
  await expect
    .poll(() => page.evaluate(() => (window as unknown as E2EWindow).e2eAnchors.length))
    .toBe(2);
  await expect.poll(() => anchorPaused(page)).toBe(false);
});

test('destroy：模組自動 detach；建立新的 Engine 時重新 attach', async ({ page }) => {
  await open(page, '/demo/?background=1');
  await page.locator('#autoplay').check();
  await page.locator('#load').click();
  await expect.poll(() => anchorPaused(page)).toBe(false);

  await page.locator('#destroy').click();
  await expect(page.locator('#background-state')).toHaveText('detached');
  expect(await anchor(page)).toMatchObject({ paused: true, src: null });

  await page.locator('#recreate').click();
  await expect(page.locator('#background-state')).toHaveText('attached');
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('playing');
  await expect.poll(() => anchorPaused(page)).toBe(false);
});

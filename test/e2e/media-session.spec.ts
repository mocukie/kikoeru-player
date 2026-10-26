// Demo 頁扮演 App 設定 Media Session（#70，預設勾選，`/demo/?mediasession=0` 時不勾選）：metadata 與 playbackState
// 跟著載入與 play／pause 改變，取消勾選時清掉，不設任何 action handler。position state 讀不回來，留給實機清單。
//
// init script 包住 `setActionHandler` 記下呼叫；頁面的例外（例如 `setPositionState` 的 TypeError）記在 `pageErrors`。
import { expect, test, type Page } from '@playwright/test';

interface E2EWindow {
  e2eActionHandlers: string[];
}

let pageErrors: Error[];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.addInitScript(() => {
    const w = window as unknown as E2EWindow;
    w.e2eActionHandlers = [];
    const session = navigator.mediaSession;
    const real = session.setActionHandler.bind(session);
    session.setActionHandler = (action, handler) => {
      w.e2eActionHandlers.push(action);
      real(action, handler);
    };
  });
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => (window as unknown as E2EWindow).e2eActionHandlers)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

/** Demo 頁載入完成（媒體清單已列出），選好 `audio/flac.flac`。 */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('#media option')).not.toHaveCount(0);
  await page.locator('#media').selectOption('audio/flac.flac');
}

function session(page: Page) {
  return page.evaluate(() => ({
    title: navigator.mediaSession.metadata?.title ?? null,
    playbackState: navigator.mediaSession.playbackState,
  }));
}

test('預設勾選：metadata 是檔名，playbackState 跟著 play／pause', async ({ page }) => {
  await open(page, '/demo/');
  await expect(page.locator('#media-session')).toBeChecked();
  expect(await session(page)).toEqual({ title: null, playbackState: 'paused' });

  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('ready');
  expect(await session(page)).toEqual({ title: 'flac.flac', playbackState: 'paused' });

  await page.locator('#play').click();
  await expect(page.locator('#state')).toHaveText('playing');
  await expect.poll(() => session(page)).toEqual({ title: 'flac.flac', playbackState: 'playing' });

  await page.locator('#pause').click();
  await expect(page.locator('#state')).toHaveText('paused');
  await expect.poll(() => session(page)).toEqual({ title: 'flac.flac', playbackState: 'paused' });

  // 換檔：title 跟著新的媒體。
  await page.locator('#media').selectOption('audio/opus.opus');
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('ready');
  await expect.poll(() => session(page)).toEqual({ title: 'opus.opus', playbackState: 'paused' });

  await page.locator('#unload').click();
  await expect(page.locator('#state')).toHaveText('idle');
  await expect.poll(() => session(page)).toEqual({ title: null, playbackState: 'paused' });
});

test('query mediasession=0 時不勾選；勾選後才設定', async ({ page }) => {
  await open(page, '/demo/?mediasession=0');
  await expect(page.locator('#media-session')).not.toBeChecked();
  await page.locator('#autoplay').check();
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('playing');
  expect(await session(page)).toEqual({ title: null, playbackState: 'none' });

  await page.locator('#media-session').check();
  expect(await session(page)).toEqual({ title: 'flac.flac', playbackState: 'playing' });
});

test('取消勾選時清掉 metadata 與 playbackState', async ({ page }) => {
  await open(page, '/demo/');
  await page.locator('#autoplay').check();
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('playing');
  await expect.poll(() => session(page)).toEqual({ title: 'flac.flac', playbackState: 'playing' });

  await page.locator('#media-session').uncheck();
  expect(await session(page)).toEqual({ title: null, playbackState: 'none' });
  // 不再跟著 Engine。
  await page.locator('#pause').click();
  await expect(page.locator('#state')).toHaveText('paused');
  expect(await session(page)).toEqual({ title: null, playbackState: 'none' });
});

test('建立新的 Engine 後跟著新的 Engine', async ({ page }) => {
  await open(page, '/demo/');
  await page.locator('#autoplay').check();
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('playing');

  await page.locator('#recreate').click();
  await expect(page.locator('#state')).toHaveText('idle');
  await expect.poll(() => session(page)).toEqual({ title: null, playbackState: 'paused' });

  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('playing');
  await expect.poll(() => session(page)).toEqual({ title: 'flac.flac', playbackState: 'playing' });
  await page.locator('#pause').click();
  await expect.poll(() => session(page)).toEqual({ title: 'flac.flac', playbackState: 'paused' });
});

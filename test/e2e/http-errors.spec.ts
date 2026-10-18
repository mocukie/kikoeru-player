// Demo 頁的 http 錯誤（#38）：以 Demo 頁的故障注入選項讓 test/server 在播放中回應錯誤或斷線。
import { expect, test, type Page } from '@playwright/test';

/** 頁面上的 Engine 只用到的部分（Demo 頁以 `engine` 放在 globalThis）。 */
interface PageEngine {
  state: string;
  currentTime: number;
  error: { code: string; fatal: boolean; position: number; detail: { status?: number } } | null;
  addEventListener(type: 'error', listener: (event: { error: PageEngine['error'] }) => void): void;
  getStats(): Promise<{ resources: { workers: number } }>;
}

interface E2EWindow {
  engine: PageEngine;
  e2eErrors: NonNullable<PageEngine['error']>[];
}

/** 10 秒的 WAV（約 1.8 MiB）：Worker 每次讀 256 KiB，播放中會陸續發出請求。 */
const WAV = 'audio/pcm-s16.wav';

test.beforeEach(async ({ page }) => {
  await page.goto('/demo/');
  await expect(page.locator('#media option')).not.toHaveCount(0);
  await page.evaluate(() => {
    const w = window as unknown as E2EWindow;
    w.e2eErrors = [];
    w.engine.addEventListener('error', (event) => {
      // Error 物件傳回 Playwright 時只剩 message，先取出要比對的欄位。
      if (!event.error) return;
      const { code, fatal, position, detail } = event.error;
      w.e2eErrors.push({ code, fatal, position, detail });
    });
  });
});

function currentTime(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as E2EWindow).engine.currentTime);
}

async function loadAndPlay(page: Page, path: string, fault: string): Promise<void> {
  await page.locator('#media').selectOption(path);
  await page.locator('#fault').selectOption(fault);
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('ready');
  await page.locator('#play').click();
  await expect(page.locator('#state')).toHaveText('playing');
}

test('播放中 401：error 事件帶 SOURCE_UNAUTHORIZED 與 position，reload() 從該位置接續播放', async ({
  page,
}) => {
  // 第 1 個請求探測大小、第 2 個開檔，第 4 個是播放到約 2.7 秒時的讀取。
  await loadAndPlay(page, WAV, 'fault=401@4');
  await expect(page.locator('#state')).toHaveText('error', { timeout: 10_000 });

  const errors = await page.evaluate(() => (window as unknown as E2EWindow).e2eErrors);
  expect(errors).toHaveLength(1);
  const [error] = errors;
  expect(error).toMatchObject({
    code: 'SOURCE_UNAUTHORIZED',
    fatal: true,
    detail: { status: 401 },
  });
  const position = error?.position ?? NaN;
  expect(position).toBeGreaterThan(1);
  expect(position).toBeLessThan(5);
  await expect(
    page.locator('#log li').filter({ hasText: /error SOURCE_UNAUTHORIZED（fatal）/ }),
  ).toHaveCount(1);

  // App 處理完 session 失效後 reload()：同一個 URL 之後的請求都成功。
  await page.locator('#reload').click();
  await expect(page.locator('#log li').filter({ hasText: /← reload resolve/ })).toHaveCount(1);
  await expect(page.locator('#state')).toHaveText('playing');
  const resumed = await currentTime(page);
  expect(resumed).toBeGreaterThanOrEqual(position);
  expect(resumed).toBeLessThan(position + 0.5);
  await expect.poll(() => currentTime(page), { timeout: 5000 }).toBeGreaterThan(position + 1);
  expect(await page.evaluate(() => (window as unknown as E2EWindow).engine.error)).toBeNull();
  await expect.poll(() => page.workers().length).toBe(1);
});

test('播放中斷線一次：自動重試後繼續播放，不發出 error', async ({ page }) => {
  await loadAndPlay(page, WAV, 'fault=drop@500KB');
  // 500 KiB 約在 2.7 秒；播過那裡仍然是 playing。
  await expect.poll(() => currentTime(page), { timeout: 8000 }).toBeGreaterThan(4);
  await expect(page.locator('#state')).toHaveText('playing');
  expect(await page.evaluate(() => (window as unknown as E2EWindow).e2eErrors)).toEqual([]);
});

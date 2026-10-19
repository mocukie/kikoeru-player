// Demo 頁的診斷（#45）：log 等級選單（改變時換新的 Engine）把 Engine 的 log 記進事件 log；stats 面板每秒更新。
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/demo/?background=0');
  await expect(page.locator('#media option')).not.toHaveCount(0);
});

async function loadAndPlay(page: Page): Promise<void> {
  await page.locator('#media').selectOption('audio/flac.flac');
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('ready');
  await page.locator('#play').click();
  await expect(page.locator('#state')).toHaveText('playing');
}

const lines = (page: Page, pattern: RegExp) => page.locator('#log li').filter({ hasText: pattern });

test('logLevel debug：Worker 的請求與開檔、主執行緒的指令都記進事件 log', async ({ page }) => {
  await page.locator('#log-level').selectOption('debug');
  await expect(lines(page, /建立新的 Engine（logLevel debug）/)).toHaveCount(1);
  await loadAndPlay(page);

  await expect(lines(page, /\[io\] debug Range 請求/)).not.toHaveCount(0);
  await expect(lines(page, /\[demux\] info 開檔完成：flac/)).toHaveCount(1);
  await expect(lines(page, /\[command\] debug load /)).toHaveCount(1);
  await expect(lines(page, /\[command\] debug state loading → ready/)).toHaveCount(1);
});

test('logLevel 不設定 hook：沒有任何 Engine 的 log', async ({ page }) => {
  await page.locator('#log-level').selectOption('off');
  await expect(lines(page, /建立新的 Engine（logLevel off）/)).toHaveCount(1);
  await loadAndPlay(page);
  await expect(page.locator('#current-time')).not.toHaveText('0.000');
  await expect(lines(page, /^\S+s \[/)).toHaveCount(0);
});

test('stats 面板：每秒更新，播放中的 wasm heap 與完整的 getStats() 快照', async ({ page }) => {
  await page.locator('#stats-panel summary').click();
  await loadAndPlay(page);

  await expect(page.locator('#wasm-video-stats')).toHaveText(/wasm heap [1-9]\d*\.\d MiB.*video —/);
  const snapshot = async () =>
    JSON.parse((await page.locator('#stats-json').textContent()) ?? 'null') as {
      wasmHeapBytes: number;
      video: unknown;
      resources: { workers: number; libavInstances: number };
      network: { bytesLoaded: number };
    } | null;
  await expect.poll(async () => (await snapshot())?.wasmHeapBytes ?? 0).toBeGreaterThan(0);
  const stats = await snapshot();
  expect(stats?.video).toBeNull();
  expect(stats?.resources).toMatchObject({ workers: 1, libavInstances: 1 });
  expect(stats?.network.bytesLoaded).toBeGreaterThan(0);
  // 定時更新：ring 的水位與 bufferAhead 隨播放改變，快照的內容會換。
  const first = await page.locator('#stats-json').textContent();
  await expect(page.locator('#stats-json')).not.toHaveText(first ?? '', { timeout: 3000 });
});

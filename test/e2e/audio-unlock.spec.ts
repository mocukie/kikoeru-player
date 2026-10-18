// Demo 頁的音訊解鎖（#41）：unlockAudio 的操作、audioUnlocked 的顯示與 load({ paused: false })。
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/demo/');
  await expect(page.locator('#media option')).not.toHaveCount(0);
});

test('按 unlockAudio：發出 beforeaudiostart（unlock），audioUnlocked 變為 true', async ({
  page,
}) => {
  await expect(page.locator('#audio-unlocked')).toHaveText('false');
  await page.locator('#unlock').click();

  await expect(page.locator('#audio-unlocked')).toHaveText('true');
  await expect(
    page.locator('#log li').filter({ hasText: /beforeaudiostart cause=unlock$/ }),
  ).toHaveCount(1);
});

test('解鎖之後 load（paused: false）直接進入 playing；暫停再播放不再發出 beforeaudiostart', async ({
  page,
}) => {
  await page.locator('#unlock').click();
  await expect(page.locator('#audio-unlocked')).toHaveText('true');
  await page.locator('#media').selectOption('audio/flac.flac');
  await page.locator('#autoplay').check();
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('playing');

  await page.locator('#pause').click();
  await expect(page.locator('#state')).toHaveText('paused');
  await page.locator('#play').click();
  await expect(page.locator('#state')).toHaveText('playing');
  await expect(page.locator('#log li').filter({ hasText: /beforeaudiostart/ })).toHaveCount(1);
});

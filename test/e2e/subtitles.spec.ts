// Demo 頁的內嵌字幕（#49）：選中的字幕軌隨播放送出 cue，Demo 頁依 `currentTime` 顯示目前的 cue；seek 之後重送的 cue
// 以 id 去重。multi-track.mkv 的 cue 每整秒開始、長 0.5 秒（test/media/README.md）。
import { expect, test, type Page } from '@playwright/test';
import { CUE_EDGE_MARGIN } from './tolerances.js';

/** 頁面上的 Engine 只用到的部分（Demo 頁以 `engine` 放在 globalThis）。 */
interface PageEngine {
  state: string;
  currentTime: number;
  selectedTracks: { subtitle: string | null };
  tracks: { id: string; kind: string; language?: string }[];
}

interface E2EWindow {
  engine: PageEngine;
}

async function loadWithSubtitle(page: Page, language: string): Promise<void> {
  await page.goto(`/demo/?background=0&subtitleLang=${language}`);
  await expect(page.locator('#media option')).not.toHaveCount(0);
  await page.locator('#media').selectOption('video/multi-track.mkv');
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('ready');
}

/**
 * 播放中，等 `currentTime` 落在某個整秒 n 之後的 `[n + from, n + to)`，回傳 n 與那時 Demo 頁顯示的目前的 cue。
 */
async function cueWhile(
  page: Page,
  from: number,
  to: number,
): Promise<{ n: number; text: string }> {
  const handle = await page.waitForFunction(
    ({ from, to }) => {
      const time = (window as unknown as E2EWindow).engine.currentTime;
      const n = Math.floor(time);
      const offset = time - n;
      if (offset < from || offset >= to) return null;
      return { n, text: document.getElementById('current-cue')?.textContent ?? '' };
    },
    { from, to },
    { polling: 'raf', timeout: 5000 },
  );
  return (await handle.jsonValue()) as { n: number; text: string };
}

async function seekBar(page: Page, time: number): Promise<void> {
  await page.locator('#seek').evaluate((input: HTMLInputElement, time) => {
    input.value = String(time);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, time);
}

test('SRT：播放中依 currentTime 顯示目前的 cue，cue 之間沒有字幕', async ({ page }) => {
  await loadWithSubtitle(page, 'ja');
  const selected = await page.evaluate(() => {
    const { engine } = window as unknown as E2EWindow;
    return engine.tracks.find((t) => t.id === engine.selectedTracks.subtitle)?.language;
  });
  expect(selected).toBe('ja');
  await page.locator('#play').click();
  await expect(page.locator('#state')).toHaveText('playing');

  for (let i = 0; i < 2; i++) {
    const shown = await cueWhile(page, CUE_EDGE_MARGIN, 0.5 - CUE_EDGE_MARGIN);
    expect(shown.text).toBe(`[embedded srt] ${String(shown.n)}秒目、ビープ音が鳴りました。`);
    const hidden = await cueWhile(page, 0.5 + CUE_EDGE_MARGIN, 1 - CUE_EDGE_MARGIN);
    expect(hidden.text).toBe('');
  }
  await expect(page.locator('#log')).toContainText('cues s:');
});

test('ASS：seek 之後從新位置繼續送出 cue，重送的 cue 以 id 去重', async ({ page }) => {
  await loadWithSubtitle(page, 'zh');
  // load 時 demux 到約 2 秒之後：0、1、2 秒的 cue 已經送出。
  await expect(page.locator('#cue-log li').first()).toContainText('[embedded ass] 第0秒');

  await seekBar(page, 12.2);
  await expect(page.locator('#state')).toHaveText('ready');
  await expect(page.locator('#cue-log')).toContainText('[embedded ass] 第12秒');
  await expect(page.locator('#current-cue')).toHaveText(
    /^Dialogue: 0,0:00:12\.\d\d,0:00:12\.\d\d,Default,,0,0,0,,\{\\fad\(50,50\)\}\[embedded ass\] 第12秒，聽到嗶聲了。$/,
  );

  // 回到開頭：0 秒起的 cue 重新送出，id 與之前相同，所以 cue log 中每個開始時間只有一個 cue。
  await seekBar(page, 0);
  await expect(page.locator('#state')).toHaveText('ready');
  await expect(page.locator('#cue-count')).toContainText(/重送 [1-9]/);
  const starts = await page
    .locator('#cue-log li')
    .evaluateAll((items) => items.map((li) => (li as HTMLElement).dataset.start));
  expect(new Set(starts).size).toBe(starts.length);
});

// 證明 E2E 的音訊環境可用：頁面自己的程式建立的 AudioContext 不需要 gesture 就能輸出 oscillator 的聲音。
// 頁面以 route 提供、結果經 console 回傳，不用 evaluate，因為 evaluate 會自帶 gesture。
import { expect, test } from '@playwright/test';

const PAGE_URL = 'https://e2e.test/audio-smoke';
const RESULT_PREFIX = 'audio-smoke ';

const html = `<!doctype html>
<script type="module">
  const context = new AudioContext();
  const analyser = new AnalyserNode(context, { fftSize: 2048 });
  const oscillator = new OscillatorNode(context, { frequency: 440 });
  oscillator.connect(analyser).connect(context.destination);
  oscillator.start();
  await context.resume();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
  console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ currentTime: context.currentTime, peak }));
</script>`;

interface Result {
  currentTime: number;
  peak: number;
}

test('頁面沒有 gesture 也能輸出 oscillator 的聲音', async ({ page }) => {
  await page.route(PAGE_URL, (route) => route.fulfill({ contentType: 'text/html', body: html }));
  const message = page.waitForEvent('console', (msg) => msg.text().startsWith(RESULT_PREFIX));
  await page.goto(PAGE_URL);

  const result = JSON.parse((await message).text().slice(RESULT_PREFIX.length)) as Result;
  expect(result.peak).toBeGreaterThan(0.9);
  expect(result.currentTime).toBeGreaterThan(0.4);
});

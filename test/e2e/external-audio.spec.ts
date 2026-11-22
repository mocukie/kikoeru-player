// Demo 頁的外掛音軌與音軌 offset（#53）：加入、選用、移除外掛音軌，以及 offset ±500 ms 時 beep 被聽到的時刻
//（docs/testing.md「E2E」：方向正確、誤差 ≤ 20 ms）。方向以每 10 秒加倍頻率的那一聲判斷：來源 10 秒的 beep 在
// offset +0.5 時於媒體 10.5 秒被聽到，−0.5 時於 9.5 秒。
//
// init script 與 playback.spec.ts 相同：錄下送到 destination 的聲音，每個 rAF 記下 Engine 的 `currentTime` 與聽到
// context 時間 0 的時刻（扣掉 Engine 回報的輸出延遲）。
import { expect, test, type Page } from '@playwright/test';
import type * as AudioCaptureModule from '../audio-capture.js';
import type { DestinationCapture } from '../audio-capture.js';
import type * as HarnessModule from '../media-worker-harness.js';
import { BEEP_ONSET_TOLERANCE } from './tolerances.js';

interface Sample {
  perf: number;
  time: number;
  heardOrigin: number;
}

/** 頁面上的 Engine 只用到的部分（Demo 頁以 `engine` 放在 globalThis）。 */
interface PageEngine {
  state: string;
  currentTime: number;
  tracks: { id: string; kind: string; origin: string; offset?: number; language?: string }[];
  selectedTracks: { audio: string | null };
  getStats(): Promise<{
    audio: { outputLatencyMs: number };
    resources: { libavInstances: number };
  }>;
}

interface E2EWindow {
  engine: PageEngine;
  e2eCapture: Promise<DestinationCapture>;
  e2eSamples: Sample[];
}

const EXTERNAL = 'video/external-audio-440.flac';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as E2EWindow;
    const captureModule = '/test/audio-capture.ts';
    w.e2eCapture = (import(captureModule) as Promise<typeof AudioCaptureModule>).then((m) =>
      m.captureDestination(),
    );
    w.e2eSamples = [];
    let latencyMs = NaN;
    let latencyAt = -Infinity;
    const sample = () => {
      const engine = (w as Partial<E2EWindow>).engine;
      const perf = performance.now();
      void w.e2eCapture.then((capture) => {
        const context = capture.context as AudioContext | null;
        if (!engine || !context || engine.state !== 'playing') return;
        if (perf - latencyAt > 250) {
          latencyAt = perf;
          void engine.getStats().then((stats) => (latencyMs = stats.audio.outputLatencyMs));
        }
        if (Number.isNaN(latencyMs)) return;
        w.e2eSamples.push({
          perf,
          time: engine.currentTime,
          heardOrigin: perf - context.currentTime * 1000 + latencyMs,
        });
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto('/demo/?background=0');
  await page.evaluate(async () => {
    await (window as unknown as E2EWindow).e2eCapture;
  });
  await expect(page.locator('#media option')).not.toHaveCount(0);
});

async function load(page: Page, path: string): Promise<PageEngine['tracks']> {
  await page.locator('#media').selectOption(path);
  await page.locator('#load').click();
  await expect(page.locator('#state')).toHaveText('ready');
  return page.evaluate(() => (window as unknown as E2EWindow).engine.tracks);
}

function currentTime(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as E2EWindow).engine.currentTime);
}

function logLine(page: Page, text: string | RegExp) {
  return page.locator('#log li').filter({ hasText: text });
}

/** 以 Demo 頁加入外掛音軌，回傳它的 track id。 */
async function addExternal(page: Page, offset: number): Promise<string> {
  await page.locator('#external-media').selectOption(EXTERNAL);
  await page.locator('#external-offset').fill(String(offset));
  await page.locator('#add-external').click();
  const resolved = logLine(page, /addExternalAudio\(external-audio-440\.flac, .*\) resolve "/);
  await expect(resolved).toHaveCount(1);
  const text = (await resolved.textContent()) ?? '';
  return JSON.parse(text.slice(text.lastIndexOf(' ') + 1)) as string;
}

async function selectAudio(page: Page, id: string): Promise<void> {
  await page.locator('#select-audio').selectOption(id);
  await expect(logLine(page, `selectTracks({ audio: "${id}" }) resolve`)).toHaveCount(1);
}

/** 以 Demo 頁的進度條 seek（拖曳後放開），等到 seeked。 */
async function seekBar(page: Page, time: number): Promise<void> {
  await page.locator('#seek').evaluate((input: HTMLInputElement, time) => {
    input.value = String(time);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, time);
  await expect(
    logLine(page, new RegExp(`seeked ${time.toFixed(3).replace('.', '\\.')}$`)),
  ).toHaveCount(1);
}

/** 播放到 `until` 秒，回傳按下 play 時的 `performance.now()`。 */
async function playUntil(page: Page, until: number): Promise<number> {
  const since = await page.evaluate(() => performance.now());
  await page.locator('#play').click();
  await expect(page.locator('#state')).toHaveText('playing');
  await expect.poll(() => currentTime(page), { timeout: 8000 }).toBeGreaterThan(until);
  return since;
}

/** `since` 之後被聽到的 beep：被聽到時內插的 `currentTime`，與基準頻率、加倍頻率的振幅。 */
function heardBeeps(page: Page, since: number, base: number) {
  return page.evaluate(
    async ({ since, base }) => {
      const w = window as unknown as E2EWindow;
      const harness = '/test/media-worker-harness.ts';
      const { amplitudeAt, beepOnsets } = (await import(harness)) as typeof HarnessModule;
      const capture = await w.e2eCapture;
      const sampleRate = capture.context?.sampleRate ?? NaN;
      const [left] = capture.channels();
      const samples = w.e2eSamples.slice();
      const origins = samples.map((s) => s.heardOrigin).sort((a, b) => a - b);
      const heardOrigin = origins[Math.floor(origins.length / 2)] ?? NaN;
      const timeAt = (perf: number): number => {
        const after = samples.findIndex((s) => s.perf >= perf);
        const a = samples[after - 1];
        const b = samples[after];
        if (!a || !b || b.perf - a.perf > 100) return NaN;
        return a.time + ((b.time - a.time) * (perf - a.perf)) / (b.perf - a.perf);
      };
      return beepOnsets(left, sampleRate)
        .map((onset) => {
          const perf =
            heardOrigin + ((capture.startFrame + onset * sampleRate) / sampleRate) * 1000;
          const start = Math.round(onset * sampleRate) + Math.round(sampleRate * 0.005);
          const length = Math.round(sampleRate * 0.05);
          return {
            perf,
            time: timeAt(perf),
            base: amplitudeAt(left, sampleRate, base, start, length),
            doubled: amplitudeAt(left, sampleRate, base * 2, start, length),
          };
        })
        .filter((beep) => beep.perf > since && !Number.isNaN(beep.time));
    },
    { since, base },
  );
}

/**
 * 從媒體 8.8 秒播到 11.8 秒，聽到的三聲 beep：被聽到時 `currentTime − offset` 與來源的整秒相差 ≤ 20 ms，來源 10 秒
 * 的那一聲頻率加倍（方向）。
 */
async function expectOffsetBeeps(page: Page, offset: number, base: number): Promise<void> {
  await seekBar(page, 8.8);
  const since = await playUntil(page, 11.8);
  const beeps = (await heardBeeps(page, since, base)).slice(0, 3);
  expect(beeps.map((b) => Math.round(b.time - offset))).toEqual(
    offset > 0 ? [9, 10, 11] : [10, 11, 12],
  );
  for (const beep of beeps) {
    const source = beep.time - offset;
    expect(Math.abs(source - Math.round(source))).toBeLessThanOrEqual(BEEP_ONSET_TOLERANCE);
    const doubled = Math.round(source) === 10;
    expect(doubled ? beep.doubled : beep.base, `來源 ${source.toFixed(3)} 秒`).toBeGreaterThan(0.2);
    expect(doubled ? beep.base : beep.doubled, `來源 ${source.toFixed(3)} 秒`).toBeLessThan(0.05);
  }
}

for (const offset of [0.5, -0.5]) {
  test(`外掛音軌 offset ${String(offset)} 秒：方向正確，被聽到時 currentTime − offset 與來源的整秒 ≤ 20 ms`, async ({
    page,
  }) => {
    await load(page, 'video/multi-track.mkv');
    const id = await addExternal(page, offset);
    await expect(page.locator('#select-audio option')).toHaveCount(4);
    await expect(page.locator(`#track-list li[data-id="${id}"]`)).toContainText('外掛');
    await selectAudio(page, id);
    await expectOffsetBeeps(page, offset, 440);
  });
}

test('容器內音軌以 Demo 頁設定 offset 0.5 秒：短暫 seeking 之後 beep 晚 0.5 秒被聽到', async ({
  page,
}) => {
  const tracks = await load(page, 'video/multi-track.mkv');
  const ja = tracks.find((t) => t.kind === 'audio' && t.language === 'ja');
  if (!ja) throw new Error('multi-track.mkv 應該有 ja 的音軌');
  await page.locator('#offset-track').selectOption(ja.id);
  await page.locator('#offset-value').fill('0.5');
  await page.locator('#set-offset').click();
  await expect(logLine(page, `setAudioOffset("${ja.id}", 0.5) resolve`)).toHaveCount(1);
  await expect(page.locator(`#track-list li[data-id="${ja.id}"]`)).toContainText('offset 0.5 s');
  await expectOffsetBeeps(page, 0.5, 880);
});

test('Demo 頁移除選用中的外掛音軌：切回容器內的音軌，instance 只剩主來源的', async ({ page }) => {
  const tracks = await load(page, 'video/multi-track.mkv');
  const id = await addExternal(page, 0);
  expect(
    await page.evaluate(async () => {
      const stats = await (window as unknown as E2EWindow).engine.getStats();
      return stats.resources.libavInstances;
    }),
  ).toBe(2);
  await selectAudio(page, id);
  await page.locator('#offset-track').selectOption(id);
  await page.locator('#remove-external').click();
  await expect(logLine(page, `removeExternalAudio("${id}") resolve`)).toHaveCount(1);
  await expect(page.locator('#select-audio option')).toHaveCount(3);
  const container = tracks.find((t) => t.kind === 'audio');
  await expect(page.locator('#select-audio')).toHaveValue(container?.id ?? '');
  await expect(page.locator('#resources')).toContainText('libavInstances 1');
});

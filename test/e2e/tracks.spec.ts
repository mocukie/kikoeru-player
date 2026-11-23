// Demo 頁的選軌（#52）：以軌道選單在播放中切換音軌與影片軌，換軌之後 beep 對 currentTime、白框對 beep 的同步仍成立
//（docs/testing.md「E2E」的自動同步斷言），以及軌道清單與不支援的軌。
//
// init script 與 playback.spec.ts、video.spec.ts 相同：錄下送到 destination 的聲音，每個 rAF 記下 Engine 的
// `currentTime`、聽到 context 時間 0 的時刻（扣掉 Engine 回報的輸出延遲），以及 canvas 左上白框出現的時刻。
import { expect, test, type Page } from '@playwright/test';
import type * as AudioCaptureModule from '../audio-capture.js';
import type { DestinationCapture } from '../audio-capture.js';
import type * as HarnessModule from '../media-worker-harness.js';
import { BEEP_ONSET_TOLERANCE, WHITE_BOX_TO_BEEP_TOLERANCE } from './tolerances.js';

interface Sample {
  perf: number;
  time: number;
  heardOrigin: number;
}

/** 頁面上的 Engine 只用到的部分（Demo 頁以 `engine` 放在 globalThis）。 */
interface PageEngine {
  state: string;
  currentTime: number;
  tracks: { id: string; kind: string; supported: boolean; codec: string; language?: string }[];
  selectedTracks: { audio: string | null; video: string | null; subtitle: string | null };
  videoSize: { width: number; height: number; rotation: number } | null;
  getStats(): Promise<{ audio: { outputLatencyMs: number } }>;
}

interface E2EWindow {
  engine: PageEngine;
  e2eCapture: Promise<DestinationCapture>;
  e2eSamples: Sample[];
  e2eWhiteOnsets: number[];
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as E2EWindow;
    const captureModule = '/test/audio-capture.ts';
    w.e2eCapture = (import(captureModule) as Promise<typeof AudioCaptureModule>).then((m) =>
      m.captureDestination(),
    );
    w.e2eSamples = [];
    w.e2eWhiteOnsets = [];
    let latencyMs = NaN;
    let latencyAt = -Infinity;
    let white = false;
    let context2d: CanvasRenderingContext2D | null = null;
    const sample = () => {
      const engine = (w as Partial<E2EWindow>).engine;
      const perf = performance.now();
      const canvas = document.getElementById('video');
      if (canvas instanceof HTMLCanvasElement) {
        context2d ??= canvas.getContext('2d', { willReadFrequently: true });
        const [r = 0, g = 0, b = 0] = context2d?.getImageData(10, 10, 1, 1).data ?? [];
        const now = (r + g + b) / 3 > 200;
        if (now && !white && engine?.state === 'playing') w.e2eWhiteOnsets.push(perf);
        white = now;
      }
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

async function play(page: Page, after: number): Promise<void> {
  await page.locator('#play').click();
  await expect(page.locator('#state')).toHaveText('playing');
  await expect.poll(() => currentTime(page)).toBeGreaterThan(after);
}

/** 以 Demo 頁的軌道選單切換，等到 selectTracks() resolve；回傳 resolve 時的 `performance.now()`。 */
async function select(page: Page, kind: string, id: string): Promise<number> {
  const resolved = page
    .locator('#log li')
    .filter({ hasText: `selectTracks({ ${kind}: "${id}" }) resolve` });
  await page.locator(`#select-${kind}`).selectOption(id);
  await expect(resolved).toHaveCount(1);
  return page.evaluate(() => performance.now());
}

/** `since` 之後被聽到的 beep：聽到時的 `performance.now()`、內插的 `currentTime`，與 440／880 Hz 的振幅。 */
function heardBeeps(page: Page, since: number) {
  return page.evaluate(async (since) => {
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
        const perf = heardOrigin + ((capture.startFrame + onset * sampleRate) / sampleRate) * 1000;
        const start = Math.round(onset * sampleRate) + Math.round(sampleRate * 0.005);
        const length = Math.round(sampleRate * 0.05);
        return {
          perf,
          time: timeAt(perf),
          a440: amplitudeAt(left, sampleRate, 440, start, length),
          a880: amplitudeAt(left, sampleRate, 880, start, length),
        };
      })
      .filter((beep) => beep.perf > since && !Number.isNaN(beep.time));
  }, since);
}

function whiteOnsets(page: Page, since: number): Promise<number[]> {
  return page.evaluate(
    (since) => (window as unknown as E2EWindow).e2eWhiteOnsets.filter((perf) => perf > since),
    since,
  );
}

test('Demo 頁列出所有軌道；選了不支援的軌時 reject CODEC_UNSUPPORTED，選單回到生效的軌', async ({
  page,
}) => {
  const tracks = await load(page, 'video/multi-video.mkv');
  await expect(page.locator('#track-list li')).toHaveCount(4);
  await expect(page.locator('#select-video option')).toHaveCount(4);
  const hevc = tracks.find((t) => t.codec === 'hevc');
  expect(hevc?.supported).toBe(false);
  const before = await page.locator('#select-video').inputValue();
  await page.locator('#select-video').selectOption(hevc?.id ?? '');
  await expect(
    page.locator('#log li').filter({ hasText: /selectTracks.*reject CODEC_UNSUPPORTED/ }),
  ).toHaveCount(1);
  await expect(page.locator('#select-video')).toHaveValue(before);

  await load(page, 'video/multi-track.mkv');
  await expect(page.locator('#track-list li')).toHaveCount(5);
  await expect(page.locator('#track-list li').first()).toContainText('h264');
  await expect(page.locator('#select-audio option')).toHaveCount(3);
  await expect(page.locator('#select-subtitle')).toHaveValue('');
});

test('播放中切換音軌：之後聽到的 beep 都是新軌（440 Hz），被聽到時 currentTime 與 beep 的位置 ≤ 20 ms', async ({
  page,
}) => {
  const tracks = await load(page, 'video/multi-track.mkv');
  const zh = tracks.find((t) => t.kind === 'audio' && t.language === 'zh');
  if (!zh) throw new Error('multi-track.mkv 應該有 zh 的音軌');
  await play(page, 1.3);
  const resolvedAt = await select(page, 'audio', zh.id);
  await expect(page.locator('#state')).toHaveText('playing');
  const from = await currentTime(page);
  await expect.poll(() => currentTime(page), { timeout: 6000 }).toBeGreaterThan(from + 3.3);

  const beeps = (await heardBeeps(page, resolvedAt)).slice(0, 3);
  expect(beeps).toHaveLength(3);
  for (const beep of beeps) {
    expect(Math.abs(beep.time - Math.round(beep.time))).toBeLessThanOrEqual(BEEP_ONSET_TOLERANCE);
    expect(beep.a440).toBeGreaterThan(0.2);
    expect(beep.a880).toBeLessThan(0.05);
  }
});

test('播放中切換影片軌：畫面換成新軌（640×360），白框對 beep 仍 ≤ 1 個影片 frame + 1 個 rAF', async ({
  page,
}) => {
  const tracks = await load(page, 'video/multi-video.mkv');
  const [h264, vp9] = tracks.filter((t) => t.kind === 'video');
  test.skip(!h264?.supported || !vp9?.supported, '瀏覽器不支援這個影片 codec');
  await play(page, 1.3);
  const resolvedAt = await select(page, 'video', vp9?.id ?? '');
  await expect(page.locator('#video-size')).toHaveText('640×360 rotation=0');
  await expect(page.locator('#state')).toHaveText('playing');
  const from = await currentTime(page);
  await expect.poll(() => currentTime(page), { timeout: 6000 }).toBeGreaterThan(from + 3.3);

  const beeps = (await heardBeeps(page, resolvedAt)).slice(0, 3);
  expect(beeps).toHaveLength(3);
  const whites = await whiteOnsets(page, resolvedAt);
  for (const beep of beeps) {
    const nearest = Math.min(...whites.map((white) => Math.abs(white - beep.perf)));
    expect(nearest / 1000, `beep 在 ${beep.perf.toFixed(0)} ms`).toBeLessThanOrEqual(
      WHITE_BOX_TO_BEEP_TOLERANCE,
    );
    expect(Math.abs(beep.time - Math.round(beep.time))).toBeLessThanOrEqual(BEEP_ONSET_TOLERANCE);
  }
});

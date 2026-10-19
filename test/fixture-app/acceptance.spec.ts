// Vite fixture App 的驗收（ADR-0005）：以 pnpm pack 的 tgz 安裝的套件，經 App 的 Vite build 之後
// license header 完整、.wasm 以 application/wasm 提供且 compileStreaming 成功、Worker 與 worklet 的 URL 正確而能播放。
// 由 test/fixture-app/run.sh 執行（先 build）。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Engine, ThirdPartyNotice } from '../../src/index.js';

declare global {
  var fixture: {
    engine: Engine;
    load(url: string): Promise<void>;
    errors: string[];
    thirdPartyNotices: readonly ThirdPartyNotice[];
  };
  var compileStreamingResults: string[];
}

const app = fileURLToPath(new URL('.', import.meta.url));
const packageDir = join(app, 'node_modules/kikoeru-player');
const assetsDir = join(app, 'dist/assets');

interface WasmManifest {
  tag: string;
  releaseUrl: string;
  files: Record<string, string>;
}
const manifest = JSON.parse(
  readFileSync(join(packageDir, 'dist/wasm/wasm.json'), 'utf8'),
) as WasmManifest;

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** build 輸出中與套件內 `dist/wasm/<file>` 的 bytes 完全相同的檔案（檔名被 Vite 加上 hash）。 */
function builtCopyOf(file: string): string | undefined {
  const expected = manifest.files[file];
  return readdirSync(assetsDir).find(
    (name) => sha256(readFileSync(join(assetsDir, name))) === expected,
  );
}

const glue = Object.keys(manifest.files).find((f) => f.endsWith('.wasm.mjs'));
const wasm = Object.keys(manifest.files).find((f) => f.endsWith('.wasm'));

test('套件內附的 wasm 對應 wasm/dist/ 的 wasm Release，thirdPartyNotices 指向它', async ({
  page,
}) => {
  const stamp = readFileSync(join(app, '../../wasm/dist/.stamp'), 'utf8').trim();
  expect(manifest.tag).toBe(stamp);
  expect(manifest.releaseUrl).toBe(
    `https://github.com/mocukie/kikoeru-player/releases/tag/${stamp}`,
  );
  for (const [file, hash] of Object.entries(manifest.files)) {
    expect(sha256(readFileSync(join(packageDir, 'dist/wasm', file))), file).toBe(hash);
  }

  await page.goto('/');
  await expect(page.locator('#about')).toContainText(manifest.releaseUrl);
  expect(await page.evaluate(() => globalThis.fixture.thirdPartyNotices)).toEqual([
    {
      name: 'FFmpeg',
      license: 'LGPL-2.1-or-later',
      sourceUrl: manifest.releaseUrl,
      noticeText: readFileSync(join(packageDir, 'NOTICE'), 'utf8'),
    },
  ]);
});

test('Vite build 後 glue 與 .wasm 原封不動，glue 的 license header 完整', () => {
  expect(glue).toBeDefined();
  expect(wasm).toBeDefined();
  if (glue === undefined || wasm === undefined) return;
  const builtGlue = builtCopyOf(glue);
  expect(builtGlue, `build 輸出沒有與 ${glue} 相同的檔案`).toBeDefined();
  expect(builtCopyOf(wasm), `build 輸出沒有與 ${wasm} 相同的檔案`).toBeDefined();
  if (builtGlue === undefined) return;
  const header = readFileSync(join(assetsDir, builtGlue), 'utf8');
  expect(header.startsWith('/*!')).toBe(true);
  expect(header.slice(0, header.indexOf('*/'))).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
});

test('wasm 以 application/wasm 提供並 streaming compile，Worker 與 worklet 載入後能播放', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const results: string[] = [];
    globalThis.compileStreamingResults = results;
    const original = WebAssembly.compileStreaming.bind(WebAssembly);
    WebAssembly.compileStreaming = (source) =>
      original(source).then(
        (module) => {
          results.push('ok');
          return module;
        },
        (error: unknown) => {
          results.push(`error: ${String(error)}`);
          throw error;
        },
      );
  });
  const wasmResponse = page.waitForResponse((response) => response.url().endsWith('.wasm'));

  await page.goto('/');
  await page.waitForFunction(() => 'fixture' in globalThis);
  await page.evaluate(() => globalThis.fixture.load('/media/audio/flac.flac'));

  const response = await wasmResponse;
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^application\/wasm\b/);
  expect(await page.evaluate(() => globalThis.compileStreamingResults)).toEqual(['ok']);

  await page.locator('#play').click();
  await expect(page.locator('#state')).toHaveText('playing');
  await page.waitForFunction(() => globalThis.fixture.engine.currentTime > 1);
  expect(await page.evaluate(() => globalThis.fixture.errors)).toEqual([]);
  const stats = await page.evaluate(() => globalThis.fixture.engine.getStats());
  expect(stats.resources.workers).toBe(1);
});

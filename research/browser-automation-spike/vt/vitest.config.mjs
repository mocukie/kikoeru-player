import { defineConfig } from 'vitest/config';
const P = process.env.PROVIDER || 'playwright';
const browsers = (process.env.BROWSERS || 'chromium,firefox,webkit').split(',');
let provider, instances;
if (P === 'playwright') {
  const { playwright } = await import('@vitest/browser-playwright');
  const launchOptions = { ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL, executablePath: process.env.PW_EXE } : {}), ...(process.env.PW_ARGS ? { args: process.env.PW_ARGS.split(' ') } : {}), ...(process.env.PW_FXPREFS ? { firefoxUserPrefs: JSON.parse(process.env.PW_FXPREFS) } : {}) };
  provider = playwright({ launchOptions });
  instances = browsers.map(browser => ({ browser }));
} else {
  const { webdriverio } = await import('@vitest/browser-webdriverio');
  const prefs = process.env.FX_PREFS ? JSON.parse(process.env.FX_PREFS) : {};
  provider = webdriverio({ capabilities: { 'moz:firefoxOptions': { binary: process.env.FX_BIN, args: ['-headless'], prefs }, 'wdio:geckodriverOptions': process.env.GECKO ? { binary: process.env.GECKO } : undefined } });
  instances = browsers.map(browser => ({ browser }));
}
export default defineConfig({
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }, fs: { allow: ['..'] } },
  test: { root: '.', include: ['vt/**/*.test.js'], browser: { enabled: true, headless: true, provider, instances, fileParallelism: false } },
});

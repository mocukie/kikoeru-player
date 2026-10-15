import { defineConfig } from '@playwright/test';
import { browsers } from './test/browser-launch.ts';

// E2E 只跑 Chromium 與 Firefox（docs/testing.md「瀏覽器」）。
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  projects: browsers.map(({ name, launchOptions }) => ({
    name,
    use: { browserName: name, launchOptions },
  })),
});

import { defineConfig } from '@playwright/test';
import { browsers } from './test/browser-launch.ts';

/** E2E 專用的 dev server port；與 `pnpm dev` 的預設 port 分開，兩者可以同時開著。 */
const E2E_PORT = 5273;
const baseURL = `https://localhost:${String(E2E_PORT)}`;

// E2E 只跑 Chromium 與 Firefox（docs/testing.md「瀏覽器」），對 Demo 頁的 dev server 執行。
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  webServer: {
    command: `pnpm exec vite --port ${String(E2E_PORT)} --strictPort`,
    url: `${baseURL}/demo/`,
    // dev server 的憑證是自簽的。
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL, ignoreHTTPSErrors: true },
  projects: browsers.map(({ name, launchOptions }) => ({
    name,
    use: { browserName: name, launchOptions },
  })),
});

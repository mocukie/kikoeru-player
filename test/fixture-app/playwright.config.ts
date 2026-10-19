import { defineConfig } from '@playwright/test';
import { browsers } from '../browser-launch.ts';

/**
 * `vite preview` 的 port。多個 worktree 同時跑時以 `FIXTURE_PORT` 指定；沒有時由 `E2E_PORT` 加 1000 推得，
 * 讓只設 E2E_PORT 的 `pnpm verify` 也不會互相沿用 server。
 */
const port = Number(process.env.FIXTURE_PORT ?? Number(process.env.E2E_PORT ?? 5273) + 1000);
const baseURL = `http://localhost:${String(port)}`;

// fixture App 的驗收（test/fixture-app/run.sh 先 vite build），Chromium 與 Firefox 都跑。
export default defineConfig({
  testDir: '.',
  testMatch: 'acceptance.spec.ts',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  webServer: {
    // localhost 是 secure context，不需要 HTTPS。build 由 run.sh 負責，這裡只 preview。
    command: `pnpm exec vite preview test/fixture-app --port ${String(port)} --strictPort`,
    cwd: '../..',
    url: baseURL,
    reuseExistingServer: false,
  },
  use: { baseURL },
  projects: browsers.map(({ name, launchOptions }) => ({
    name,
    use: { browserName: name, launchOptions },
  })),
});

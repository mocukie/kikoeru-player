// Vitest browser mode 與 Playwright E2E 共用的瀏覽器啟動設定（docs/testing.md「瀏覽器」）。
// 不依賴 Playwright evaluate 自帶的 gesture：沒有 gesture 也要能出聲。
import type { LaunchOptions } from 'playwright';

export const chromiumLaunchOptions: LaunchOptions = {
  args: ['--autoplay-policy=no-user-gesture-required'],
};

/**
 * Firefox 沒有 sound server 時 `AudioContext.resume()` 永遠不會完成。
 * test/docker/run.sh 在 container 內起 PulseAudio，並以 `FIREFOX_PULSE_SERVER` 只讓 Firefox 連上；
 * Chromium 接上 PulseAudio 的 null sink 時鐘會亂，所以不給它。
 */
const firefoxPulseServer = process.env.FIREFOX_PULSE_SERVER;

export const firefoxLaunchOptions: LaunchOptions = {
  firefoxUserPrefs: { 'media.autoplay.default': 0 },
  ...(firefoxPulseServer && { env: { ...process.env, PULSE_SERVER: firefoxPulseServer } }),
};

/** Vitest 的 browser instance 與 Playwright 的 project 都以 `name` 命名，`--project chromium` 在兩邊都能用。 */
export const browsers = [
  { name: 'chromium', launchOptions: chromiumLaunchOptions },
  { name: 'firefox', launchOptions: firefoxLaunchOptions },
] as const;

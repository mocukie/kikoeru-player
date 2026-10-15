import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { browsers } from './test/browser-launch.ts';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['**/*.browser.test.ts', 'test/lint/fixtures/**'],
        },
      },
      {
        test: {
          name: 'browser',
          include: ['src/**/*.browser.test.ts', 'test/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            instances: browsers.map(({ name, launchOptions }) => ({
              browser: name,
              name,
              provider: playwright({ launchOptions }),
            })),
          },
        },
      },
    ],
  },
});

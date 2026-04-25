import { defineConfig, devices } from '@playwright/test';

const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEBSERVER === '1';
const browserProject = process.env.PLAYWRIGHT_BROWSER === 'firefox' ? 'firefox' : 'chromium';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects:
    browserProject === 'firefox'
      ? [
          {
            name: 'firefox',
            use: {
              ...devices['Desktop Firefox'],
            },
          },
        ]
      : [
          {
            name: 'chromium',
            use: {
              ...devices['Desktop Chrome'],
            },
          },
        ],
  ...(skipWebServer
    ? {}
    : {
        webServer: {
          command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
          url: 'http://127.0.0.1:4173',
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      }),
});

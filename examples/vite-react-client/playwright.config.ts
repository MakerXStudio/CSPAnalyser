import { defineConfig, devices } from 'playwright/test';

const baseURL = 'http://127.0.0.1:4173';
const crossOriginFixtureURL = 'http://localhost:4174';
const artifactsDir = 'examples/vite-react-client/test-results/csp-analyser';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.pw.ts',
  outputDir: './test-results/playwright',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'npm run example:vite-react:preview -- --host 127.0.0.1 --port 4173 --strictPort',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node scripts/cross-origin-fixture.mjs',
      url: crossOriginFixtureURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  reporter: [
    ['list'],
    [
      './tests/csp-reporter.ts',
      {
        artifactsDir,
        outputDir: artifactsDir,
        targetUrl: baseURL,
        useHashes: true,
        collapseHashThreshold: 40,
      },
    ],
  ],
  projects: [
    {
      name: 'chromium-csp',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

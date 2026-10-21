import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dashboardDataDir = mkdtempSync(path.join(os.tmpdir(), 'gleefull-dashboard-qa-'));
process.on('exit', () => rmSync(dashboardDataDir, { recursive: true, force: true }));

export default defineConfig({
  testDir: './tests',
  testMatch: '**/dashboard.spec.js',
  fullyParallel: false,
  reporter: [['list'], ['html', { outputFolder: 'test-results/playwright-report', open: 'never' }]],
  outputDir: 'test-results/playwright-artifacts',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'node server.js',
    env: { PORT: '4174', QA_DATA_DIR: dashboardDataDir },
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
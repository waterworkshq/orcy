import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `node ${path.resolve(__dirname, '../api/dist/index.js')}`,
      url: 'http://127.0.0.1:3000/health',
      reuseExistingServer: true,
      timeout: 30_000,
      env: {
        DB_PATH: path.resolve(__dirname, '../../.e2e-db/orcy.db'),
      },
    },
    {
      command: `node ${path.resolve(__dirname, 'node_modules/vite/bin/vite.js')}`,
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
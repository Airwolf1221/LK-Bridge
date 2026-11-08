import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8799);

/**
 * A small browser smoke test of the real dashboard against the real bridge (`npm run test:e2e`). It is not part of
 * `npm run ci`, which must not need a browser; run it when the dashboard changes.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
    ...(process.env.CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } } : {}),
  },
  webServer: {
    command: 'npm run build:ui && npx tsx test/e2e/server.ts',
    cwd: new URL('../..', import.meta.url).pathname,
    url: `http://127.0.0.1:${PORT + 1}/ready`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { E2E_PORT: String(PORT) },
  },
});

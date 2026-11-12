import { defineConfig } from 'vitest/config';

/**
 * Opt-in: talks to a real LegendKeeper sandbox project. Never run in public CI.
 *
 * On the server it runs as the service user (`lkbridge`), which cannot write to `node_modules` (it belongs to the build
 * user, ADR 0020). So nothing here may write there (C2d, the owner's run of 11 November 2026):
 * - `npm run test:sandbox` loads this file with `--configLoader runner`, which evaluates it in memory; the default
 *   loader writes a bundled copy to `node_modules/.vite-temp` and failed with EACCES;
 * - `fsModuleCache: false`: no transformed-module cache in `node_modules/.vitest-cache` ("could not create
 *   .vitest-cache");
 * - `cache: false`: no results file in Vite's cache directory (it only orders reruns, which a one-off run has none of).
 * test/tools/sandbox-config-readonly.test.ts runs this config with every write outside a temporary directory refused.
 *
 * `fileParallelism: false` (the owner's run of 12 November 2026): the sandbox files run one after another. In parallel
 * they shared the test project's 120 writes a minute, the smoke test's writes were parked, and it left its throwaway
 * page and image behind.
 */
export default defineConfig({
  test: {
    include: ['test/sandbox/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    disableConsoleIntercept: true,
    testTimeout: 120_000,
    fsModuleCache: false,
    cache: false,
  },
});

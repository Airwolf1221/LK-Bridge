import { defineConfig } from 'vitest/config';

/**
 * Opt-in: talks to a real LegendKeeper sandbox project. Never run in public CI.
 *
 * It runs on the server as the service user, who cannot write into the release's node_modules: the package script
 * loads this file with `--configLoader runner` (no bundled copy of the config written beside it), and `fsModuleCache`
 * is off (no transformed-module cache written under node_modules).
 */
export default defineConfig({
  test: {
    include: ['test/sandbox/**/*.test.ts'],
    fsModuleCache: false,
    environment: 'node',
    disableConsoleIntercept: true,
    testTimeout: 120_000,
  },
});

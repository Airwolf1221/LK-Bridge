import { defineConfig } from 'vitest/config';

/** Opt-in: talks to a real LegendKeeper sandbox project. Never run in public CI. */
export default defineConfig({
  test: {
    include: ['test/sandbox/**/*.test.ts'],
    environment: 'node',
    disableConsoleIntercept: true,
    testTimeout: 120_000,
  },
});

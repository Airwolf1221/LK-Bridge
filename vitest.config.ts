import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/unit/**/*.test.ts',
      'test/contract/**/*.test.ts',
      'test/auth/**/*.test.ts',
      'test/jobs/**/*.test.ts',
      'test/policy/**/*.test.ts',
      'test/tools/**/*.test.ts',
      'test/admin/**/*.test.ts',
      'test/ui/**/*.test.{ts,tsx}',
    ],
    environment: 'node',
    // test/ui/*.tsx run in jsdom (a docblock in each file); the JSX needs no plugin to compile.
    setupFiles: [],
  },
});

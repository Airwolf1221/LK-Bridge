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
      'test/maintenance/**/*.test.ts', // chunk 6 (its UI component tests are in test/ui)
      'test/mappings/**/*.test.ts',
      'test/markdown/**/*.test.ts', // v2 B1: the Markdown converter
      'test/projects/**/*.test.ts', // v2 A1: several LegendKeeper projects in one bridge
      'test/ui/**/*.test.{ts,tsx}',
    ],
    environment: 'node',
    // test/ui/*.tsx run in jsdom (a docblock in each file); the JSX needs no plugin to compile.
    setupFiles: [],
  },
});

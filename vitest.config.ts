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
    ],
    environment: 'node',
  },
});

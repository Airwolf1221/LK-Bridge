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
      'test/tree/**/*.test.ts', // v2 A2: the repository tree
      'test/secrets/**/*.test.ts', // OPS2: the encrypted secret store, keys and the owner account on the dashboard
      'test/registry/**/*.test.ts', // v2 A3: the type registry, taxonomy, resolution and ordering
      'test/assets/**/*.test.ts', // v2 A4: the asset tree
      'test/discover/**/*.test.ts', // v2 B2: the Discover and Read tools
      'test/pages/**/*.test.ts', // v2 C1: write_page
      'test/facts/**/*.test.ts',
      'test/resources/**/*.test.ts',
      'test/lifecycle/**/*.test.ts', // v2 C2c: the page lifecycle
      'test/calendar/**/*.test.ts', // v2 D1: the calendar engine
      'test/chronology/**/*.test.ts', // v2 D1: chronology sync and the timeline tools
      'test/maps/**/*.test.ts', // v2 D2: the map-feature tools
      'test/images/**/*.test.ts', // v2 D3: the image pipeline
      'test/snapshots/**/*.test.ts', // v2 E1a: snapshots, restore and the rehearsal
      'test/offsite/**/*.test.ts', // v2 E1b: the encrypted Google Drive copy
      'test/ui/**/*.test.{ts,tsx}',
    ],
    environment: 'node',
    // test/ui/*.tsx run in jsdom (a docblock in each file); the JSX needs no plugin to compile.
    setupFiles: [],
  },
});

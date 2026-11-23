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
      'test/audits/**/*.test.ts', // v2 E2: the audits (findings only, read from the snapshots)
      'test/evaluation/**/*.test.ts', // v2 E3: the Evaluation helper (scenarios, windows, grading, results table, compare)
      'test/e4/**/*.test.ts', // v2 E4: the second independent review's regression tests (docs/reviews/E4-2026-11.md)
      'test/lmr/**/*.test.ts', // v3 F2: Last Major Revision on every substantial edit (ADR 0049)
      'test/packs/**/*.test.ts', // v3 F3a: setting packs and the Arkona character tool (ADR 0050)
      'test/appraisal/**/*.test.ts', // v3 F3c: the appraisal tools and the full-text search (ADR 0054)
      'test/consistency/**/*.test.ts', // v3 F4b: the consistency check and "as of a date" (ADR 0064)
      'test/narrative/**/*.test.ts', // v3 F4c: the narrative layout, tools and audit (ADR 0065)
      'test/review/**/*.test.ts', // v3 F3.4: write scope: the review of direct writes, Revert, the rails (ADR 0055)
      'test/blockids/**/*.test.ts', // v3 F3.5: the block-id sweep, an approved narrow automation (ADR 0056)
      'test/automation/**/*.test.ts', // v3 F5b: automatic actions for audits, one finding code at a time (ADR 0068)
      'test/f7/**/*.test.ts', // v3 F7: guided character art (ADR 0070)
      'test/f7b/**/*.test.ts', // v3 F7b: seeing character art, arkona_get_art (ADR 0071)
      'test/sandbox-mock/**/*.test.ts', // CR-2026-11-R4 (S): every sandbox check, run against the mock in the ordinary suite
      'test/ui/**/*.test.{ts,tsx}',
    ],
    environment: 'node',
    // v2 E4 (backlog 2): realistic defaults. Most files start the real server, runtime, mock LegendKeeper and MCP client;
    // under the full suite's load (4 workers) a test that takes 2 s alone took more than Vitest's 5-second default (seen
    // in C2d.1, D3, E1a and E3b), and a world's set-up more than the 10-second hook default. Tests that are long by
    // design (sandbox dry runs that wait for budget, property tests) keep their own, longer timeouts.
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // test/ui/*.tsx run in jsdom (a docblock in each file); the JSX needs no plugin to compile.
    setupFiles: [],
  },
});

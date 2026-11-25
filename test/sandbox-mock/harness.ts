/**
 * CR-2026-11-R4 (the owner's request S): every sandbox check runs in the ordinary suite against the mock LegendKeeper,
 * through the same runtime and harness as the real run (`createSoakRuntime` pointed at the mock, `copyBridgeState`
 * from the mock world's database, the raw client of `f4b-probe.ts`), so a check that would reach the owner broken (Y2's
 * table shape, consistency-f4b's governed create, narrative-f4c's missing calendar and N3) fails the build here first.
 * Any failing item fails the test, and the whole report is printed, every tool answer in full. Nothing here can reach
 * a real LegendKeeper: the runtime is given the mock's address and the mock's throwaway key only.
 */
import { Writable } from 'node:stream';
import { expect } from 'vitest';
import { ProjectStore } from '../../src/projects/index.js';
import { rawLk, type RawLk } from '../sandbox/f4b-probe.js';
import { createSoakRuntime, type SoakRuntime } from '../sandbox/soak.js';
import { API_KEY, PROJECT, type Stack } from '../tools/helpers.js';

/** Generous limits for the run on the mock (the governor and the mock both): the check's logic is under test, not pacing. */
export const MOCK_LIMITS = { 'key-min': 5000, 'write-min': 2000 } as const;

const quiet = new Writable({
  write(_chunk: Buffer, _enc, done) {
    done();
  },
});

export interface OnMock {
  readonly sb: SoakRuntime;
  readonly raw: RawLk;
  /** The mock world's database: what `copyBridgeState` copies from, read-only, as from the bridge's on the server. */
  readonly bridgeDbPath: string;
  close(): Promise<void>;
}

/** The sandbox runtime and raw client of the real run, pointed at the mock world's LegendKeeper. */
export async function sandboxOnMock(
  stack: Stack,
  o: { readonly chronologyCheckDelayMs?: number } = {},
): Promise<OnMock> {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(stack.mock.url))
    throw new Error(`the mock LegendKeeper must be on loopback, not ${stack.mock.url}`);
  new ProjectStore(stack.db).setSandbox(PROJECT, true);
  const sb = await createSoakRuntime({
    logStream: quiet,
    apiKey: API_KEY,
    project: 'test',
    baseUrl: stack.mock.url,
    env: {
      WRITE_SPACING_MS: '0',
      WRITE_SPACING_STRETCHED_MS: '0',
      LK_TIER_LIMITS: JSON.stringify(MOCK_LIMITS),
    },
    ...(o.chronologyCheckDelayMs !== undefined ? { chronologyCheckDelayMs: o.chronologyCheckDelayMs } : {}),
  });
  const raw = rawLk({ lk: sb.lk, projectId: sb.projectId, apiKey: API_KEY, baseUrl: stack.mock.url });
  return { sb, raw, bridgeDbPath: stack.dbPath, close: () => sb.close() };
}

/** Fails on any item that did not pass (or that the check says must not be INCONCLUSIVE), the whole report printed. */
export function expectEveryItemPasses(
  items: readonly { readonly id: string; readonly verdict: string; readonly detail: string }[],
  report: string,
  o: { readonly allow?: readonly string[] } = {},
): void {
  const ok = new Set(['pass', 'noted', ...(o.allow ?? [])]);
  const bad = items.filter((i) => !ok.has(i.verdict.toLowerCase()));
  if (bad.length > 0) process.stdout.write(report);
  expect(
    bad.map((i) => `${i.id} [${i.verdict}]: ${i.detail}`),
    'a sandbox check item that does not pass on the mock (the report above has every answer in full)',
  ).toEqual([]);
  expect(items.length, 'the check reported no item at all').toBeGreaterThan(0);
}

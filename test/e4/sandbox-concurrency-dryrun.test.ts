/**
 * The concurrency sandbox script's own logic (test/sandbox/concurrency.ts), dry-run against the mock LegendKeeper: the
 * guard, the set-up, the three checks and the clean-up. The mock answers one request at a time, so it behaves as an
 * atomic compare-and-swap (C1 and C2 PASS); the real API is what the owner's run records.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatConcurrencyReport, runConcurrencySandbox } from '../sandbox/concurrency.js';
import { SandboxGuardError } from '../sandbox/smoke.js';
import { pagesWorld, type PagesWorld } from '../pages/world.js';
import { API_KEY, PROJECT } from '../tools/helpers.js';

let w: PagesWorld;
beforeAll(async () => {
  w = await pagesWorld();
}, 60_000);
afterAll(() => w.close());

const target = () => ({
  engine: w.stack.runtime.engine,
  lk: w.stack.runtime.projects.client(PROJECT)!,
  projectId: PROJECT,
  baseUrl: w.stack.mock.url,
  apiKey: API_KEY,
});

describe('the concurrency sandbox script (dry run against the mock)', () => {
  it('refuses another project before writing anything', async () => {
    const before = w.stack.mock.calls.filter((c) => c.method !== 'GET').length;
    await expect(runConcurrencySandbox(target(), 'proj_somebody_else')).rejects.toBeInstanceOf(
      SandboxGuardError,
    );
    expect(w.stack.mock.calls.filter((c) => c.method !== 'GET').length).toBe(before);
  });

  it('runs every check to an answer and deletes its page', async () => {
    const { findings } = await runConcurrencySandbox(target(), PROJECT, { sleep: () => Promise.resolve() });
    process.stdout.write(formatConcurrencyReport(findings));
    const by = Object.fromEntries(findings.map((f) => [f.id, f]));
    for (const id of ['setup', 'C1', 'C2', 'C3', 'cleanup'])
      expect(by[id]?.verdict, `${id}: ${by[id]?.detail}`).toBe('pass');
    const left = [...w.repo.res.values()].filter(
      (r) => r.deletedAt === null && /^lk-bridge concurrency /.test(r.name),
    );
    expect(left).toEqual([]);
  });
});

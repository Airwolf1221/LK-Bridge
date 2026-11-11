/**
 * CR-2026-11: the sandbox assumptions script's own logic (test/sandbox/assumptions.ts), run against the mock
 * LegendKeeper of the lifecycle test world (no real LegendKeeper involved). The mock models some of the assumptions
 * and not others, so this checks that the script runs every check to an answer, refuses another project, and cleans up
 * after itself; and that the checks the mock does model pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatAssumptionsReport, runAssumptions } from '../sandbox/assumptions.js';
import { SandboxGuardError, type SmokeTarget } from '../sandbox/smoke.js';
import { lifecycleWorld, type LifecycleWorld } from '../lifecycle/world.js';
import { API_KEY, PROJECT } from './helpers.js';

let w: LifecycleWorld;
const target = (): SmokeTarget => ({
  engine: w.stack.runtime.engine,
  lk: w.stack.runtime.projects.client(PROJECT)!,
  projectId: PROJECT,
  baseUrl: w.stack.mock.url,
  apiKey: API_KEY,
});

beforeAll(async () => {
  // The real limits would make the dry run wait for the key's minute; LegendKeeper's mock and the governor get more.
  w = await lifecycleWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  // saveResourceAsTemplate, as the spec describes it (the world's model has none): a template with the page's name
  // (or the one given) and a copy of its sidebar, outside the tree.
  w.overrides.set(/\/resources\/[^/]+\/save-as-template$/, (req) => {
    if (req.method !== 'POST') return undefined;
    const src = /\/resources\/([^/]+)\/save-as-template$/.exec(req.path.replace(/\/$/, ''))![1]!;
    const s = w.repo.live(src);
    if (!s) return { status: 404, body: { code: 'NOT_FOUND', message: 'not found' } };
    const body = (req.body ?? {}) as { id?: string; name?: string };
    const id = body.id ?? `tpl${Date.now().toString(36)}`.slice(0, 8);
    const t = w.repo.seed({ id, name: body.name ?? s.name, parentId: null, props: false });
    const sb = w.sidebars.pages.get(src);
    if (sb) w.sidebars.pages.set(id, structuredClone(sb));
    return { status: 201, body: w.repo.resourceView(t) };
  });
});
afterAll(async () => w.close());

describe('sandbox assumptions script (dry run)', () => {
  it('refuses to run against any project other than the one it was given', async () => {
    const writes = w.stack.mock.calls.filter((c) => c.method !== 'GET').length;
    await expect(runAssumptions(target(), 'proj_somebody_else')).rejects.toBeInstanceOf(SandboxGuardError);
    expect(w.stack.mock.calls.filter((c) => c.method !== 'GET').length).toBe(writes);
  });

  it('runs every check to an answer and deletes what it made', async () => {
    const before = w.stack.mock.calls.length;
    const findings = await runAssumptions(target(), PROJECT, {
      searchWaitMs: 0,
      searchPollMs: 1,
      sleep: async () => {},
    });
    const report = formatAssumptionsReport(findings);
    const calls = w.stack.mock.calls.slice(before);
    const writes = calls.filter((c) => c.method !== 'GET').length;
    const reads = calls.length - writes;
    process.stdout.write(`${report}\nrequests against the mock: ${reads} reads, ${writes} writes\n`);
    // The cost the review documents for the owner (docs/reviews/CR-2026-11.md, section 6; test/sandbox/README.md):
    // about 100 writes and up to about 500 reads. The reads here include the test world's repository tree re-reading
    // every page the script writes (the sandbox runtime has no tree), and the clean-up's guard reads: the canon guard
    // lists and reads every page of a cascade at entry and again inside the lock (CR-09).
    expect(writes).toBeLessThanOrEqual(110);
    expect(reads).toBeLessThanOrEqual(520);
    const ids = findings.map((f) => f.id);
    for (const id of [
      'A1',
      'A2',
      'A3',
      'A4',
      'A5',
      'A6',
      'A8',
      'A9',
      'A10',
      'B11',
      'B12',
      'B13',
      'B14',
      'B15',
      'B16',
      'B17',
      'H2',
      'C18',
      'G30b',
      'D23',
      'D24',
      'D21',
      'D22',
      'D25',
      'E27',
      'G30a',
      'H1',
      'F29',
    ])
      expect(ids, report).toContain(id);
    expect(
      findings.filter((f) => f.id === 'cleanup').map((f) => f.verdict),
      report,
    ).toEqual(['pass']);
    // Nothing the script made is left: no live page or template named as its own.
    const left = [...w.repo.res.values()].filter(
      (r) => r.deletedAt === null && r.name.startsWith('lk-bridge assumptions'),
    );
    expect(
      left.map((r) => r.name),
      report,
    ).toEqual([]);
  }, 120_000);
});

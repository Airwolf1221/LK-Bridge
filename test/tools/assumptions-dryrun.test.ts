/**
 * CR-2026-11: the sandbox assumptions script's own logic (test/sandbox/assumptions.ts), run against the mock
 * LegendKeeper of the lifecycle test world (no real LegendKeeper involved). The mock models some of the assumptions
 * and not others, so this checks that the script runs every check to an answer, refuses another project, and cleans up
 * after itself; and that the checks the mock does model pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatAssumptionsReport, runAssumptions } from '../sandbox/assumptions.js';
import { SandboxGuardError, type SmokeTarget } from '../sandbox/smoke.js';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
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
    expect(reads).toBeLessThanOrEqual(530); // v2 E4: a delete reads the page first (its pre-image, RV2-1);
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

/**
 * C2d, Part 0: the checks corrected after the owner's first server run (11 November 2026), against a mock that answers
 * as the real API did: a template copy REUSES the template's property, row and item ids (A1: a note, not a failure);
 * leading and trailing breaks in a row value are trimmed (B16: the trimmed form is expected); B12 makes its own create
 * and update; and a page an earlier cascade already deleted answers "… is already deleted" (clean-up: cleaned).
 */
describe('sandbox assumptions script (dry run, as the real API answered on 11 November 2026)', () => {
  let r: LifecycleWorld;
  const alreadyDeleted: string[] = [];
  beforeAll(async () => {
    r = await lifecycleWorld({
      env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
      limits: { 'key-min': 5000, 'write-min': 2000 },
    });
    const sb = r.sidebars;
    // B12/B13 (11 November 2026): a row write answers no version in its body, but an ETag header (on a 204 too).
    sb.rowVersions = 'etag';
    // The pages whose sidebars the checks build get the faithful sidebar model (trimming included).
    r.overrides.set(/\/resources$/, (req: MockRequest): MockResponse | undefined => {
      if (req.method !== 'POST') return undefined;
      const res = r.repo.respond(req);
      const name = (req.body as { name?: string } | undefined)?.name ?? '';
      if (res?.status === 201 && /^(A1 source|B rows|B12 rows)$/.test(name))
        sb.page((res.body as { id: string }).id, []);
      return res;
    });
    // saveResourceAsTemplate and createResourceFromTemplate keep every id of the sidebar (LegendKeeper reuses them).
    r.overrides.set(/\/resources\/[^/]+\/save-as-template$/, (req) => {
      if (req.method !== 'POST') return undefined;
      const src = /\/resources\/([^/]+)\/save-as-template$/.exec(req.path.replace(/\/$/, ''))![1]!;
      const s0 = r.repo.live(src);
      if (!s0) return { status: 404, body: { code: 'NOT_FOUND', message: 'not found' } };
      const body = (req.body ?? {}) as { id?: string; name?: string };
      const id = body.id ?? `tpl${Date.now().toString(36)}`.slice(0, 8);
      const t = r.repo.seed({ id, name: body.name ?? s0.name, parentId: null, props: false });
      const page = sb.pages.get(src);
      if (page) sb.pages.set(id, structuredClone(page));
      return { status: 201, body: r.repo.resourceView(t) };
    });
    // A delete of a page an earlier cascade removed: LegendKeeper's answer on the owner's run.
    // A soft-deleted page still reads back, with its deletedAt (so the canon guard lets the delete through).
    r.overrides.set(/\/resources\/[^/]+$/, (req) => {
      if (req.method !== 'DELETE' && req.method !== 'GET') return undefined;
      const id = /\/resources\/([^/]+)$/.exec(req.path.replace(/\/$/, ''))![1]!;
      const any = r.repo.res.get(id);
      if (!any || any.deletedAt === null) return undefined;
      if (req.method === 'GET')
        return { status: 200, body: { ...r.repo.resourceView(any), deletedAt: any.deletedAt } };
      alreadyDeleted.push(id);
      return {
        status: 409,
        body: { code: 'ALREADY_DELETED', message: `${id} is already deleted`, requestId: 'model-ad' },
      };
    });
  });
  afterAll(async () => r.close());

  it('A1 notes reused ids, B12 and B16 pass, and the clean-up counts an already-deleted page as cleaned', async () => {
    const t: SmokeTarget = {
      engine: r.stack.runtime.engine,
      lk: r.stack.runtime.projects.client(PROJECT)!,
      projectId: PROJECT,
      baseUrl: r.stack.mock.url,
      apiKey: API_KEY,
    };
    const findings = await runAssumptions(t, PROJECT, {
      searchWaitMs: 0,
      searchPollMs: 1,
      sleep: async () => {},
    });
    const report = formatAssumptionsReport(findings);
    const f = (id: string) => findings.find((x) => x.id === id)!;
    expect(f('A1').verdict, report).toBe('pass');
    expect(f('A1').detail, report).toMatch(/the template's ids reused/);
    expect(f('B12').verdict, report).toBe('pass');
    expect(f('B12').detail, report).toMatch(/ETag equals the next listPropertyRows version/);
    expect(f('B12').detail, report).toMatch(/accepted as If-Match/);
    expect(f('B12').detail, report).toMatch(/none answered a version in its body/);
    expect(f('B16').verdict, report).toBe('pass');
    expect(f('B16').detail, report).toMatch(/trimmed/);
    expect(f('cleanup').verdict, report).toBe('pass');
    // The page F29 deleted itself was met again by the clean-up, answered "already deleted", and counted as cleaned.
    expect(alreadyDeleted.length, report).toBeGreaterThan(0);
  }, 120_000);

  it('B12 FAILs, saying plainly which half did not hold, when there is no ETag or it is not the next version', async () => {
    const sb = r.sidebars;
    const t: SmokeTarget = {
      engine: r.stack.runtime.engine,
      lk: r.stack.runtime.projects.client(PROJECT)!,
      projectId: PROJECT,
      baseUrl: r.stack.mock.url,
      apiKey: API_KEY,
    };
    const b12 = async () => {
      const findings = await runAssumptions(t, PROJECT, {
        searchWaitMs: 0,
        searchPollMs: 1,
        sleep: async () => {},
      });
      return findings.find((x) => x.id === 'B12')!;
    };
    try {
      // The spec's way: a version in the body and no ETag. The bridge uses an ETag only; this is reported, not passed.
      sb.rowVersions = 'body';
      const none = await b12();
      expect(none.verdict).toBe('fail');
      expect(none.detail).toMatch(/createPropertyRow sent no ETag header/);
      expect(none.detail).toMatch(/useEtagVersions off/);
      // An ETag that is not the next read's version and that LegendKeeper would not accept as If-Match.
      sb.rowVersions = 'etag-wrong';
      const wrong = await b12();
      expect(wrong.verdict).toBe('fail');
      expect(wrong.detail).toMatch(/is not the next listPropertyRows version/);
      expect(wrong.detail).toMatch(/refused the create's ETag/);
    } finally {
      sb.rowVersions = 'etag';
    }
  }, 120_000);

  it('B16 fails, naming what to report, when LegendKeeper trims only one break at each end', async () => {
    const sb = r.sidebars;
    sb.trimBreaks = false;
    const one = (content: Record<string, unknown>[]) => {
      const out = [...content];
      if (out[0]?.break === true) out.shift();
      if (out[out.length - 1]?.break === true) out.pop();
      return out;
    };
    sb.mangle = (req, s0) => {
      const body = req.body as { content?: Record<string, unknown>[] } | undefined;
      if (req.method !== 'PATCH' || !Array.isArray(body?.content)) return;
      for (const p of s0.props)
        for (const row of p.rows ?? [])
          if (JSON.stringify(row.content) === JSON.stringify(body.content)) row.content = one(row.content);
    };
    try {
      const t: SmokeTarget = {
        engine: r.stack.runtime.engine,
        lk: r.stack.runtime.projects.client(PROJECT)!,
        projectId: PROJECT,
        baseUrl: r.stack.mock.url,
        apiKey: API_KEY,
      };
      const findings = await runAssumptions(t, PROJECT, {
        searchWaitMs: 0,
        searchPollMs: 1,
        sleep: async () => {},
      });
      const b16 = findings.find((x) => x.id === 'B16')!;
      expect(b16.verdict).toBe('fail');
      expect(b16.detail).toMatch(/only ONE leading and ONE trailing break/);
    } finally {
      sb.trimBreaks = true;
      sb.mangle = null;
    }
  }, 120_000);
});

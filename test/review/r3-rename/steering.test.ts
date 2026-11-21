/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- parsed JSON tool results */
/**
 * CR-2026-11 round 3 (renames): agents steered to `arkona_rename` on every route (ADR 0058 amendment C,
 * src/packs/rename/guard.ts): `update_resource`, `updateResource` through `lk_api_write`, `lk_op_updateResource` and
 * `lk_api_batch`, and the pack tools; `plainRename: { reason }` recorded with the proposal, or for a direct write on the
 * Review page (the job's title) AND in the journal entry. Against the mock LegendKeeper only. Every test asserts the
 * SAFE behaviour; a failing test is a finding.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { packWorld, C as PC, type PackWorld } from '../../packs/world.js';
import { C, P, PROJECT, R, renameWorld, type RenameWorld } from '../../packs/rename-world.js';
import { NEW } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const code = (r: { body: any }) => (r.body.error?.code as string | undefined) ?? null;

describe('RN steering: the subject’s own index', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-50 a culture’s index renamed with update_resource is refused (USE_ARKONA_RENAME)', async () => {
    const before = w.requests().writes;
    const r = await w.call('update_resource', { page: R.velaranIndex, name: 'Velarine' });
    expect({ code: code(r), writes: w.requests().writes - before }).toEqual({
      code: 'USE_ARKONA_RENAME',
      writes: 0,
    });
  });

  it('RN-51 a race’s index (its characters’ navigation) renamed with update_resource is refused', async () => {
    const r = await w.call('update_resource', { page: C.qishen, name: 'Qishani' });
    expect(code(r)).toBe('USE_ARKONA_RENAME');
  });

  it('RN-52 a character’s index renamed with update_resource is refused', async () => {
    const r = await w.call('update_resource', { page: C.nadiraIndex, name: NEW });
    expect(code(r)).toBe('USE_ARKONA_RENAME');
  });
});

describe('RN steering: the low-level routes', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-59 move_resource never renames a page (no name parameter reaches LegendKeeper)', async () => {
    const before = w.repo.live(P.nadiraBio)!.name;
    const r = await w.call('move_resource', {
      page: P.nadiraBio,
      to: C.nadiraIndex,
      name: `${NEW} - Biography`,
    });
    void r;
    expect(w.repo.live(P.nadiraBio)!.name).toBe(before);
  });

  // CR-2026-11-R3 (R3-58): built (docs/reviews/CR-2026-11-R3.md section 7; ADR 0058's second amendment): with the tree's stored sidebar unknown, the steering reads the page live once, as update_resource does, counted in the call's cost.
  it('RN-54 lk_api_write refuses a subject’s rename although the tree has not read the page’s sidebar yet (modelled)', async () => {
    // update_resource reads the page live: an owner page with a Subject fact (no owner tag) is refused.
    const live = await w.call('update_resource', {
      page: P.untagged,
      name: 'Orskhaven - Polity Reference',
    });
    expect(code(live)).toBe('USE_ARKONA_RENAME');
    // The tree holds a page's sidebar only once its properties pass has read it ("null when its properties have not
    // been read", src/tree/queries.ts): a page made or changed since the last pass.
    w.stack.db
      .prepare('UPDATE tree_nodes SET sidebar = NULL WHERE project_id = ? AND id = ?')
      .run(PROJECT, P.untagged);
    const low = await w.call('lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: P.untagged }, body: { name: '[BSRC] Orskhaven - Polity Reference' } },
    });
    expect(code(low), low.text.slice(0, 300)).toBe('USE_ARKONA_RENAME');
  });

  it('RN-55 plainRename through lk_api_write (a direct write) is in the job’s title and in its journal entry', async () => {
    const reason = 'a typo in this one page only';
    const writer = w.stack.newToken('rn55-writer', 'write');
    const wc = await w.stack.connect(writer.token);
    const run = await w.stack.call(wc, 'lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: C.working }, body: { name: '[BWRK] Tamsin Reid - Character Core' } },
      plainRename: { reason },
    });
    expect(['written', 'succeeded', 'queued'], run.text.slice(0, 300)).toContain(run.body.status);
    const jobId = String(run.body.jobId ?? run.body.job?.id ?? '');
    const job = w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!;
    const entries = w.stack.runtime.engine.queries.journalLookup(PROJECT, { jobId });
    expect({
      title: (job?.title ?? '').includes(reason),
      journal: entries.some((e) => JSON.stringify(e.operation ?? {}).includes(reason)),
    }).toEqual({ title: true, journal: true });
  });

  it('RN-56 plainRename through lk_api_batch (a direct write) is in the job’s title and in its journal entry', async () => {
    const reason = 'one page, a typo';
    const writer = w.stack.newToken('rn56-writer', 'write');
    const wc = await w.stack.connect(writer.token);
    const run = await w.stack.call(wc, 'lk_api_batch', {
      calls: [
        {
          operationId: 'updateResource',
          params: { path: { resourceId: C.working }, body: { name: '[BWRK] Tamzin Reid - Character Core' } },
          plainRename: { reason },
        },
      ],
    });
    const jobId = String(run.body.jobId ?? '');
    expect(jobId, run.text.slice(0, 300)).not.toBe('');
    const job = await w.stack.runtime.engine.wait(PROJECT, jobId, 30_000);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    const entries = w.stack.runtime.engine.queries.journalLookup(PROJECT, { jobId });
    expect({
      title: (job.title ?? '').includes(reason),
      journal: entries.some((e) => JSON.stringify(e.operation ?? {}).includes(reason)),
    }).toEqual({ title: true, journal: true });
  });

  it('RN-58 plainRename through lk_api_write on canon: the reason is shown with the proposal', async () => {
    const reason = 'fixing a typo in the Biography only';
    const r = await w.call('lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: P.nadiraBio }, body: { name: '[BSRC] Nadira al-Khalidh - Biography' } },
      plainRename: { reason },
    });
    expect(r.body.status, r.text.slice(0, 300)).toBe('proposal_captured');
    const p = w.stack.runtime.policy.proposals.detail(String(r.body.proposalId))!;
    expect(`${p.summary} ${p.title} ${JSON.stringify(p.operations ?? [])}`).toContain(reason);
  });
});

describe('RN steering: lk_op_updateResource (MCP_EXPOSE_PER_OP_TOOLS=true)', () => {
  let w: PackWorld;
  beforeAll(async () => {
    w = await packWorld({ env: { MCP_EXPOSE_PER_OP_TOOLS: 'true' } });
  });
  afterAll(() => w?.close());

  it('RN-53 lk_op_updateResource refuses a subject’s rename (and has no way round it)', async () => {
    const before = w.stack.mock.calls.filter((c) => c.method !== 'GET').length;
    const r = await w.call('lk_op_updateResource', {
      path: { resourceId: PC.nadira },
      body: { name: '[BSRC] Laila al-Khalid - Character Core' },
    });
    expect(code(r), r.text.slice(0, 300)).toBe('USE_ARKONA_RENAME');
    // An agent cannot pass plainRename here (the per-op schema has no such field): it is refused all the same.
    const r2 = await w.call('lk_op_updateResource', {
      path: { resourceId: PC.nadira },
      body: { name: '[BSRC] Laila al-Khalid - Character Core' },
      plainRename: { reason: 'x' },
    });
    expect(r2.isError).toBe(true);
    expect(w.stack.mock.calls.filter((c) => c.method !== 'GET').length).toBe(before);
  });
});

describe('RN steering: a pack tool that renames a page', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  // CR-2026-11-R3 (R3-59): built (docs/reviews/CR-2026-11-R3.md section 7; ADR 0054's amendment): a name fix that changes a subject's name stays the owner's proposal and says it is a plain rename, with its reason.
  it('RN-57 arkona_appraisal_fix’s name fix never changes a subject’s name without USE_ARKONA_RENAME or a reason', async () => {
    const d = await w.call('arkona_appraise_owner', { under: P.desk, limit: 200, project: 'test' });
    const v = await w.call('arkona_visual_hygiene', { limit: 200, project: 'test' });
    const f = [...(d.body.findings ?? []), ...(v.body.findings ?? [])].find(
      (x: any) => x.check === 'em_dash_name' && x.page?.id === P.dashName,
    );
    expect(f, 'the em-dash name finding').toBeTruthy();
    const r = await w.call('arkona_appraisal_fix', { findingId: f.id, project: 'test' });
    if (code(r) === 'USE_ARKONA_RENAME') return; // steered: held
    expect(r.body.status, r.text.slice(0, 300)).toBe('proposal_captured');
    const p = w.stack.runtime.policy.proposals.detail(String(r.body.proposalId))!;
    const ops = p.ops
      .filter((o) => o.op === 'updateResource')
      .map((o) => String((o.params as { body?: { name?: unknown } }).body?.name));
    // The subject part of “Gata—Lund - Polity Reference” is “Gata—Lund”; the fix makes it “Gata” (descriptor “Lund - …”).
    expect(ops).toEqual(['[BSRC] Gata - Lund - Polity Reference']);
    expect(
      `${p.summary} ${JSON.stringify(p.operations ?? [])}`,
      'a plain-rename reason shown to the owner',
    ).toMatch(/plain rename/i);
  });
});

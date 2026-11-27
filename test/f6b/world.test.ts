/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- tool JSON and mock rows */
/**
 * v3 F6b (ADR 0079; design T11, T12) end to end, against the mock LegendKeeper (the retag world, never fetched):
 *
 * - the pack: the f6b seed approved while its "Navigation and Subject Index Tags" section is missing (unpublished: the
 *   approval not refused, `index_tags` silent); the section written as the report gives it, then read as a new version;
 * - `arkona_index_classify`: rows, rules, paging; the owner's decisions;
 * - `index_prefix`: a prefix rename keeping the display name, the id and the links; ONE write; FIX_STALE after a change;
 * - `index_tags`: before and after shown, through the retag engine's write path (ONE write, read back);
 * - `out_of_order`: T11's order only under the approved rule (`[NAV]` first);
 * - the automation: both codes proposal-first, Apply allowed, default Propose; Apply submits a job the guards judge;
 * - `create_index`: `role` required with the pack; `[NAV]` from "[NAV] AI Navigation" by name; a missing template refused
 *   with TEMPLATE_MISSING; `[INDEX]` as before.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { approve } from '../packs/world.js';
import { PROJECT, retagWorld, type RetagWorld } from '../packs/retag-world.js';
import { PINNED } from '../packs/owners-world.js';
import { ROOT } from '../discover/world.js';
import { entryOf } from '../../src/automation/registry.js';
import { indexTagSectionText } from '../../src/packs/indextax/rules.js';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { withAutomationGovernance } from '../automation/world.js';

vi.setConfig({ testTimeout: 180_000 });

const D = {
  desk: 'nvdesk01',
  group: 'nvgroup1', // [INDEX] Zeta Group → approved nav
  person: 'nvpers01', // [INDEX] Alpha Person → subject (character)
  source: 'nvsrc001', // [BSRC] Desk Notes
  linker: 'nvlink01', // a page linking to the group
} as const;

/** F6d follow-up: a CANON index (not in D: the earlier sections' findings are D's). */
const KAPPA = 'nvkappa1';
/** F6d follow-up: another CANON index, for the Propose check. */
const LAMBDA = 'nvlamda1';

let w: RetagWorld;
const rt = () => w.stack.runtime;
const svc = () => rt().indexClassify;
const live = (id: string) => w.repo.live(id) as any;
const findings = (code: string) =>
  rt()
    .audits.store.list(PROJECT, { code: [code as never], state: 'open', limit: 500 })
    .findings.filter((f) => Object.values(D).includes(f.pageId as never));
const tagging = () =>
  rt()
    .packs.get('arkona')!
    .governance.find((g) => g.key === 'tagging-standard')!;

beforeAll(async () => {
  // Several full snapshots in one file: limits well above the mock's hour (bulk reads keep the night's floor).
  const big = { 'key-min': 100_000, 'key-hour': 1_000_000, 'key-day': 10_000_000, 'project-hour': 1_000_000 };
  w = await retagWorld({
    env: { LK_TIER_LIMITS: JSON.stringify(big) },
    limits: big,
    seed: (world) => {
      const r = world.repo;
      r.seed({ id: D.desk, name: '[INDEX] Navigation Desk', parentId: ROOT });
      r.seed({ id: D.person, name: '[INDEX] Alpha Person', parentId: D.desk, tags: ['CANON', 'Character'] });
      r.seed({ id: D.group, name: '[INDEX] Zeta Group', parentId: D.desk, tags: ['Species', 'Navigation'] });
      r.seed({ id: D.source, name: '[BSRC] Desk Notes', parentId: D.desk, tags: ['CANON', 'Culture'] });
      r.seed({ id: D.linker, name: '[BSRC] Linker', parentId: D.desk, tags: ['CANON', 'Culture'] });
      // F6d follow-up: a CANON index, Authoritative by its Status: its prefix and tags fixed at the automation's Apply.
      r.seed({ id: KAPPA, name: '[INDEX] Kappa Group', parentId: D.desk, tags: ['CANON', 'Species'] });
      r.outside.setRow(KAPPA, 'Status', 'Authoritative');
      r.seed({ id: LAMBDA, name: '[NAV] Lambda Group', parentId: D.desk, tags: ['CANON', 'Navigation'] });
      r.outside.setRow(LAMBDA, 'Status', 'Authoritative');
    },
  });
  // The Tagging Standard pins the new section (as the f6b seed does); it is not on the page yet.
  const packs = rt().packs;
  packs.store.setGovernance(
    'arkona',
    packs
      .get('arkona')!
      .governance.map((g) =>
        g.key === 'tagging-standard'
          ? { ...g, sections: [...PINNED.tagging, 'Navigation and Subject Index Tags'] }
          : g,
      ),
  );
  await packs.commands.approve('owner', 'arkona');
  await w.snapshot();
});
afterAll(async () => w?.close());

describe('the pack while the tag section is unpublished', () => {
  it('approves with the section unpublished; T11’s order in force, the tag rule a draft', async () => {
    const g = await rt().packs.governance('arkona');
    const src = g.sources.find((s) => s.key === 'tagging-standard')!;
    expect(src.sections?.find((s) => s.heading === 'Navigation and Subject Index Tags')?.state).toBe(
      'unpublished',
    );
    expect(g.indexTags?.state).toBe('draft');
    expect(rt().packs.approvedRules('arkona')!.indexTaxonomy).toMatchObject({ status: 'draft' });
    expect(svc().auditInput(PROJECT)).toMatchObject({ navOrdering: true, tagsInForce: false });
    expect(ARKONA_PACK.seed).toBe('arkona-2026-11-29-f6d'); // v3 F6d (ADR 0082): -f6d supersedes -f12
  });
});

describe('the report and the decisions', () => {
  it('arkona_index_classify lists the desk’s indexes, read-only and free', async () => {
    const before = w.requests().all;
    const r = await w.callRead('arkona_index_classify', { project: 'test', under: D.desk });
    expect(r.isError, r.text).toBe(false);
    const ids = (r.body.rows as any[]).map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining([D.desk, D.group, D.person]));
    expect(ids).not.toContain(D.source);
    expect(r.body.rules).toMatchObject({ approved: true, tagSection: 'draft', orderingInForce: true });
    expect(w.requests().all).toBe(before);
  });

  it('the owner decides: Zeta Group navigation, Alpha Person a character', async () => {
    await svc().prepare(PROJECT);
    svc().decide('owner', PROJECT, { pageId: D.group, action: 'change', role: 'nav' });
    svc().decide('owner', PROJECT, {
      pageId: D.person,
      action: 'change',
      role: 'subject',
      subject: 'character',
    });
    expect(svc().row(PROJECT, D.group)).toMatchObject({
      status: 'changed',
      approvedRole: 'nav',
      currentRole: 'subject',
    });
  });
});

describe('index_prefix, and no index_tags while unpublished', () => {
  beforeAll(async () => {
    await w.snapshot();
  });

  it('finds the prefix that disagrees; no tag finding while the section is a draft', () => {
    const f = findings('index_prefix');
    expect(f.map((x) => x.pageId)).toEqual([D.group]);
    expect(f[0]!.fix).toMatchObject({
      kind: 'index_prefix',
      args: { pageId: D.group, name: '[INDEX] Zeta Group', to: '[NAV] Zeta Group', role: 'nav' },
    });
    expect(findings('index_tags')).toEqual([]);
  });

  it('the automation knows both codes: proposal-first, Apply allowed, default Propose', () => {
    for (const code of ['index_prefix', 'index_tags']) {
      expect(entryOf(code)).toMatchObject({
        automatable: 'propose',
        applyDirect: true,
        defaultMode: 'propose',
      });
      const view = rt()
        .automation.codes(PROJECT)
        .find((c) => c.code === code)!;
      expect(view.mode).toBe('propose');
      expect(view.modes).toEqual(['off', 'propose', 'apply']);
    }
  });

  it('the fix renames the prefix only: ONE write; the display name, the id and the links stay', async () => {
    const f = findings('index_prefix')[0]!;
    const before = w.stack.mock.calls.length;
    const r = await rt().audits.proposeFix('owner', PROJECT, f.id, {});
    expect(r.status).toBe('proposal_captured');
    if (r.status !== 'proposal_captured') return;
    const p = rt().policy.proposals.get(r.proposalId)!;
    expect(JSON.stringify(p)).toContain('[NAV] Zeta Group');
    expect(rt().policy.proposals.itemsOf(p.id)!.items[0]).toMatchObject({
      kind: 'index_prefix',
      diff: { before: '[INDEX] Zeta Group', after: '[NAV] Zeta Group' },
    });
    const done = await approve(w, r.proposalId);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const writes = w.stack.mock.calls.slice(before).filter((c) => c.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toContain(`/resources/${D.group}`);
    const g = live(D.group);
    expect(g.name).toBe('[NAV] Zeta Group');
    expect(g.id).toBe(D.group);
    expect(g.parentId).toBe(D.desk);
    expect(g.tags).toEqual(['Species', 'Navigation']);
    expect(rt().tree.queries.node(PROJECT, D.group).data).toMatchObject({
      displayName: 'Zeta Group',
      indexRole: 'nav',
    });
  });

  it('T11’s order under the approved rule: the [NAV] belongs first', async () => {
    await w.snapshot();
    const order = findings('out_of_order').filter((x) => x.pageId === D.group || x.pageId === D.person);
    expect(
      order.length,
      JSON.stringify([
        [...w.repo.children(D.desk)].map((c: any) => [c.name, c.rank]),
        rt()
          .audits.store.list(PROJECT, { code: ['out_of_order'], limit: 50 })
          .findings.map((f) => f.message),
      ]),
    ).toBeGreaterThan(0);
    expect(order[0]!.message).toMatch(/\[NAV\] first/);
    expect(order[0]!.fix?.args).toMatchObject({ order: 'nav' });
    const f = order[0]!;
    const r = await rt().audits.proposeFix('owner', PROJECT, f.id, {});
    expect(r.status).toBe('proposal_captured');
    if (r.status !== 'proposal_captured') return;
    const done = await approve(w, r.proposalId);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const kids = [...w.repo.children(D.desk)].map((c: any) => c.name);
    expect(kids.indexOf('[NAV] Zeta Group')).toBeLessThan(kids.indexOf('[INDEX] Alpha Person'));
  });
});

describe('the tag section published, then index_tags', () => {
  beforeAll(async () => {
    const doc = w.repo.blocks.get(tagging().documentId)!;
    doc.blocks.push(
      { id: 'nvtag000', kind: 'heading', level: 2, content: [{ text: 'Navigation and Subject Index Tags' }] },
      ...indexTagSectionText(ARKONA_PACK.rules.indexTaxonomy!).map((text, i) => ({
        id: `nvtag${String(i + 1).padStart(3, '0')}`,
        kind: 'paragraph',
        content: [{ text }],
      })),
    );
    doc.version++;
    const g = await rt().packs.governance('arkona');
    expect(['offered', 'same']).toContain(g.indexTags?.state);
    await rt()
      .packs.commands.approve('owner', 'arkona')
      .catch(async () => rt().packs.commands.approve('owner', 'arkona'));
    await w.snapshot();
  });

  it('the pack reads the rule from the section after re-approval', () => {
    expect(rt().packs.approvedRules('arkona')!.indexTaxonomy).toMatchObject({
      status: 'published',
      // The owner's ruling: the section's Narratives line, recorded.
      narrativeGrammar: true,
      navTag: 'Navigation',
    });
    expect(svc().auditInput(PROJECT)).toMatchObject({ tagsInForce: true });
  });

  it('index_tags: before and after; the fix through the retag write path, read back', async () => {
    const f = findings('index_tags');
    const byPage = new Map(f.map((x) => [x.pageId, x]));
    expect(byPage.get(D.group)!.fix?.args).toMatchObject({
      current: ['Species', 'Navigation'],
      proposed: ['Navigation'],
    });
    expect(byPage.get(D.person)!.fix?.args).toMatchObject({
      current: ['CANON', 'Character'],
      proposed: ['Character'],
    });
    const before = w.stack.mock.calls.length;
    const r = await rt().audits.proposeFix('owner', PROJECT, byPage.get(D.person)!.id, {});
    expect(r.status).toBe('proposal_captured');
    if (r.status !== 'proposal_captured') return;
    expect(rt().policy.proposals.itemsOf(r.proposalId)!.items[0]).toMatchObject({
      kind: 'index_tags',
      diff: { before: 'CANON, Character', after: 'Character' },
    });
    const done = await approve(w, r.proposalId);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const writes = w.stack.mock.calls.slice(before).filter((c) => c.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(live(D.person).tags).toEqual(['Character']);
    expect(live(D.person).name).toBe('[INDEX] Alpha Person');
  });

  it('a page changed since the finding: the fix is stale, nothing proposed', async () => {
    const f = findings('index_tags').find((x) => x.pageId === D.group)!;
    live(D.group).tags = ['Navigation', 'Extra'];
    await expect(rt().audits.proposeFix('owner', PROJECT, f.id, {})).rejects.toMatchObject({
      code: 'FIX_STALE',
    });
    live(D.group).tags = ['Species', 'Navigation'];
  });

  it('the automation’s Apply: the same fix as a job every guard judges', async () => {
    const f = findings('index_tags').find((x) => x.pageId === D.group)!;
    const r = await rt().audits.proposeFix('automation', PROJECT, f.id, { direct: true });
    expect(['proposal_captured', 'job_submitted']).toContain(r.status);
    if (r.status === 'job_submitted') {
      const job = await rt().engine.wait(PROJECT, r.jobId, 20_000);
      expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
      expect(live(D.group).tags).toEqual(['Navigation']);
    }
  });
});

describe('create_index', () => {
  it('requires a role with the pack, never guessing it', async () => {
    const r = await w.call('create_index', {
      project: 'test',
      name: 'Beta Group',
      parent: D.desk,
      dryRun: true,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/ROLE_REQUIRED/);
  });

  it('role nav makes [NAV] from "[NAV] AI Navigation", by name, first among the indexes', async () => {
    const r = await w.call('create_index', {
      project: 'test',
      name: 'Beta Group',
      parent: D.desk,
      role: 'nav',
      dryRun: true,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain('[NAV] Beta Group');
    expect(r.text).toMatch(/AI Navigation/);
  });

  it('a missing [NAV] template is refused with TEMPLATE_MISSING, naming it; nothing is written', async () => {
    const re = [...w.overrides.keys()].find((k) => k.source === '\\/templates$')!;
    const had = w.overrides.get(re)!;
    w.overrides.set(re, (req: any) => {
      const out = had(req) as any;
      return out?.body?.data
        ? { ...out, body: { ...out.body, data: out.body.data.filter((t: any) => !/NAV/.test(t.name)) } }
        : out;
    });
    await rt().registry.forProject(PROJECT).commands.refreshTemplates('owner');
    const before = w.stack.mock.calls.filter((c) => c.method !== 'GET').length;
    const r = await w.call('create_index', {
      project: 'test',
      name: 'Gamma Group',
      parent: D.desk,
      role: 'nav',
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/TEMPLATE_MISSING/);
    expect(r.text).toContain('[NAV] AI Navigation');
    expect(w.stack.mock.calls.filter((c) => c.method !== 'GET').length).toBe(before);
    w.overrides.set(re, had);
    await rt().registry.forProject(PROJECT).commands.refreshTemplates('owner');
  });

  it('role subject makes [INDEX] as before', async () => {
    const r = await w.call('create_index', {
      project: 'test',
      name: 'Delta Person',
      role: 'subject',
      type: 'Character',
      dryRun: true,
    });
    expect(r.text).toContain('[INDEX] Delta Person');
  });
});

describe('the owner’s ruling (F6d follow-up): index_prefix and index_tags on a CANON page at Apply are direct', () => {
  const run = (code: string, page = KAPPA) =>
    rt().automation.run(PROJECT, 'manual', { onlyPages: new Set([page]), codes: new Set([code]) });
  const item = (runId: string, code: string) =>
    rt()
      .automation.store.items(runId)
      // A proposal-first code's items are keyed by their finding: the run acted on this page only (onlyPages).
      .find((i) => i.code === code);
  beforeAll(async () => {
    await svc().prepare(PROJECT);
    svc().decide('owner', PROJECT, { pageId: KAPPA, action: 'change', role: 'nav' });
    const lambda = svc().row(PROJECT, LAMBDA);
    svc().decide(
      'owner',
      PROJECT,
      lambda?.proposed === 'nav'
        ? { pageId: LAMBDA, action: 'approve' }
        : { pageId: LAMBDA, action: 'change', role: 'nav' },
    );
    await withAutomationGovernance(w);
    await w.snapshot();
  });

  it('index_prefix: ONE direct job (no proposal), read back, on the Review page', async () => {
    const f = rt()
      .audits.store.list(PROJECT, { code: ['index_prefix'], state: 'open', limit: 500 })
      .findings.find((x) => x.pageId === KAPPA);
    expect(f?.fix).toMatchObject({ kind: 'index_prefix', args: { to: '[NAV] Kappa Group' } });
    await rt().automation.setMode('owner', PROJECT, 'index_prefix', 'apply');
    const r = await run('index_prefix');
    const it0 = item(r.id, 'index_prefix');
    expect(it0, r.summary ?? '').toMatchObject({ outcome: 'applied', proposalId: null });
    expect(live(KAPPA).name).toBe('[NAV] Kappa Group');
    const job = rt().engine.queries.getJob(PROJECT, it0!.jobId!)!;
    expect(job.origin).toMatchObject({ automationApply: true });
    expect(rt().review.store.get(PROJECT, job.id)).toMatchObject({ principalId: 'automation' });
    await rt().automation.setMode('owner', PROJECT, 'index_prefix', 'off');
  });

  it('index_tags: CANON taken off at Apply in ONE direct job (no canonical proposal), read back', async () => {
    await w.snapshot();
    const f = rt()
      .audits.store.list(PROJECT, { code: ['index_tags'], state: 'open', limit: 500 })
      .findings.find((x) => x.pageId === KAPPA);
    expect(f?.fix?.args).toMatchObject({ current: ['CANON', 'Species'], proposed: ['Navigation'] });
    await rt().automation.setMode('owner', PROJECT, 'index_tags', 'apply');
    const r = await run('index_tags');
    const it1 = item(r.id, 'index_tags');
    expect(it1, r.summary ?? '').toMatchObject({ outcome: 'applied', proposalId: null });
    expect(live(KAPPA).tags).toEqual(['Navigation']);
    const job = rt().engine.queries.getJob(PROJECT, it1!.jobId!)!;
    expect(job.origin).toMatchObject({ automationApply: true });
    expect(rt().review.store.get(PROJECT, job.id)).toMatchObject({ principalId: 'automation' });
    await rt().automation.setMode('owner', PROJECT, 'index_tags', 'off');
  });

  it('at Propose nothing changes: the canonical change is a canonical proposal', async () => {
    await rt().automation.setMode('owner', PROJECT, 'index_tags', 'propose');
    const r = await run('index_tags', LAMBDA);
    const it2 = item(r.id, 'index_tags');
    expect(it2, r.summary ?? '').toMatchObject({ outcome: 'proposed' });
    expect(rt().policy.proposals.get(it2!.proposalId!)!.requiresCanonicalApproval).toBe(true);
    expect(live(LAMBDA).tags).toEqual(['CANON', 'Navigation']);
    rt().policy.commands.reject('owner', it2!.proposalId!, 'test');
  });

  it('the marker is the automation’s own: on any other principal or origin the engine refuses it', async () => {
    await expect(
      rt().engine.submit({
        kind: 'batch_ops',
        project: PROJECT,
        steps: [
          { op: 'updateResource', params: { path: { resourceId: KAPPA }, body: { name: '[NAV] Kappa X' } } },
        ],
        onError: 'stop',
        origin: { kind: 'ui', client: 'owner', tool: 'test', automationApply: true },
      } as never),
    ).rejects.toThrow(/automationApply can only be set by the automation engine/);
    expect(live(KAPPA).name).toBe('[NAV] Kappa Group');
  });
});

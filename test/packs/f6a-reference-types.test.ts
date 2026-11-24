/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- tool JSON and mock rows */
/**
 * v3 F6a (ADR 0076; design T1 to T3) end to end, against the mock LegendKeeper (the retag world, never fetched):
 *
 * - the f6a seed's vocabulary pinned on Source Formatting, "unpublished" while a draft (the approval not refused);
 * - `arkona_reference_types`: counts, statuses, suggestions, filters, paging, coverage, the out-of-scope areas left out;
 * - the owner's decisions: accept, edit (a canonical value, a new one with its role word), reject, specialist, bulk
 *   accept, undo (refused once applied), the audit log;
 * - the two checks: noncanonical with and without a mapping, its fix (one field, If-Match, the decision journalled),
 *   the category mismatch, rejected and specialist values silent; the automation's catalogue entry (default Off);
 * - the creation tools: a warning while a draft, refused once published, a specialist type accepted;
 * - publish: the exact section, the pack reading it after re-approval, publishing again in place, a hand-edited section
 *   winning with the conflicting decision marked;
 * - promote_page's preview warning.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { approve } from './world.js';
import { PROJECT, retagWorld, type RetagWorld } from './retag-world.js';
import { PINNED } from './owners-world.js';
import { ROOT } from '../discover/world.js';
import { entryOf } from '../../src/automation/registry.js';
import { ReferenceTypeError } from '../../src/packs/reftypes/service.js';

vi.setConfig({ testTimeout: 180_000 });

const DESK = 'rtydesk1';
const D = {
  cultA: 'rtycult1',
  cultB: 'rtycult2',
  twoRole: 'rtytwor1',
  mismatch: 'rtymism1',
  calendar: 'rtycale1',
  sovereign: 'rtysove1',
  regional: 'rtyregi1',
  naming: 'rtynami1',
  working: 'rtywork1',
  canonical: 'rtycano1',
} as const;
const CANON_ROWS: [string, string][] = [
  ['Status', 'Authoritative'],
  ['Continuity Type', 'CANON'],
  ['Continuity', 'Main'],
  ['Inheritance', 'None'],
];

let w: RetagWorld;
const rt = () => w.stack.runtime;
const svc = () => rt().referenceTypes;
const textOf = (b: any) => ((b.content ?? []) as any[]).map((r) => r.text ?? r.mention?.text ?? '').join('');
const rowOf = (id: string, key: string): string | undefined =>
  (w.repo.live(id) as any).props
    .find((p: any) => p.kind === 'keyValue' && p.title === 'PROPERTIES')
    ?.rows.find((r: any) => r.key === key)?.text;
const findings = (code: string) =>
  rt()
    .audits.store.list(PROJECT, { code: [code as never], state: 'open', limit: 500 })
    .findings.filter((f) => Object.values(D).includes(f.pageId as never));
const report = async (args: Record<string, unknown> = {}) => {
  const r = await w.callRead('arkona_reference_types', { project: 'test', under: DESK, ...args });
  expect(r.isError, r.text).toBe(false);
  return r.body;
};
const rowFor = (body: any, value: string) => (body.rows as any[]).find((x) => x.value === value);

beforeAll(async () => {
  w = await retagWorld({
    seed: (world) => {
      const r = world.repo;
      r.seed({ id: DESK, name: '[INDEX] Reference Type Desk', parentId: ROOT });
      const page = (id: string, name: string, tags: string[], referenceType: string, rows = CANON_ROWS) => {
        r.seed({ id, name, parentId: DESK, tags, referenceType });
        for (const [k, v] of rows) r.outside.setRow(id, k, v);
      };
      page(
        D.cultA,
        '[BSRC] Menkheti - Culture Reference',
        ['CANON', 'Culture'],
        'Historical Cultural Reference',
      );
      page(
        D.cultB,
        '[BSRC] Velaran - Culture Reference',
        ['CANON', 'Culture'],
        'Historical Cultural Reference',
      );
      page(
        D.twoRole,
        '[BSRC] Tarim Crown - Reference',
        ['CANON', 'Polity'],
        'Historical Polity and Institution Reference',
      );
      page(D.mismatch, '[BSRC] Saba Court - Polity Reference', ['CANON', 'Polity'], 'Culture Reference');
      page(D.calendar, '[BSRC] Arkonan Calendar', ['CANON', 'Event'], 'Arkonan Calendar Reference');
      page(
        D.sovereign,
        '[BSRC] Gata Lund - Reference',
        ['CANON', 'Polity'],
        'Sovereign State and Historical Development Reference',
      );
      page(
        D.regional,
        '[BSRC] Kanthan Coast - Culture Reference',
        ['CANON', 'Culture'],
        'Regional Culture Reference',
      );
      page(
        D.naming,
        '[BSRC] Fujimatsu Names - Reference',
        ['CANON', 'Culture'],
        'Culture & Naming Reference',
      );
      page(D.canonical, '[BSRC] Drevin - Polity Reference', ['CANON', 'Polity'], 'Polity Reference');
      page(D.working, '[BWRK] Salt Toll Customs', ['Working', 'Culture'], 'Historical Cultural Reference', [
        ['Status', 'Working'],
      ]);
    },
  });
  // Source Formatting gains "Sidebar Metadata"; the vocabulary's section is pinned as the f6a seed pins it.
  const packs = rt().packs;
  const pack = packs.get('arkona')!;
  const src = pack.governance.find((g) => g.key === 'source-formatting')!;
  const doc = w.repo.blocks.get(src.documentId)!;
  doc.blocks.push(
    { id: 'rtysbm01', kind: 'heading', level: 2, content: [{ text: 'Sidebar Metadata' }] },
    { id: 'rtysbm02', kind: 'paragraph', content: [{ text: 'Every page carries PROPERTIES.' }] },
  );
  doc.version++;
  packs.store.setGovernance(
    'arkona',
    pack.governance.map((g) =>
      g.key === 'source-formatting'
        ? { ...g, sections: [...PINNED.formatting, 'Reference Type Vocabulary'] }
        : g,
    ),
  );
  await packs.commands.approve('owner', 'arkona');
  await w.snapshot();
});
afterAll(async () => w?.close());

describe('the vocabulary’s governance pin', () => {
  it('is “unpublished” while a draft, and the approval is not refused', async () => {
    const g = await rt().packs.governance('arkona');
    expect(g.state).toBe('current');
    expect(g.referenceTypes).toEqual({ state: 'draft' });
    const formatting = g.sources.find((s) => s.key === 'source-formatting')!;
    expect(formatting.sections?.find((s) => s.heading === 'Reference Type Vocabulary')?.state).toBe(
      'unpublished',
    );
    expect(rt().packs.approvedRules('arkona')?.referenceTypes?.status).toBe('draft');
  });
});

describe('arkona_reference_types', () => {
  it('counts, statuses and suggestions, by rules only', async () => {
    const b = await report();
    expect(b.vocabulary.status).toBe('draft');
    const hcr = rowFor(b, 'Historical Cultural Reference');
    expect(hcr).toMatchObject({
      category: 'Culture',
      count: 2,
      status: 'open',
      suggestion: 'Culture Reference',
    });
    expect(hcr.moved.time).toEqual(['Historical']);
    expect(hcr.pages.map((p: any) => p.id).sort()).toEqual([D.cultA, D.cultB]);
    expect(hcr.pages[0]).toMatchObject({ lifecycle: 'Authoritative', category: 'Culture' });
    const two = rowFor(b, 'Historical Polity and Institution Reference');
    expect(two).toMatchObject({ status: 'open', suggestion: null });
    expect(two.reason).toMatch(/^no confident suggestion/);
    expect(two.candidates.sort()).toEqual([
      'Institution Reference (Institution)',
      'Polity Reference (Polity)',
    ]);
    expect(rowFor(b, 'Polity Reference')).toMatchObject({ status: 'canonical' });
    expect(rowFor(b, 'Culture Reference')).toMatchObject({ status: 'canonical', category: 'Polity' });
    expect(rowFor(b, 'Culture & Naming Reference')).toMatchObject({ status: 'open', suggestion: null });
  });

  it('leaves out Working pages (and the other areas), and says so', async () => {
    const b = await report();
    expect(rowFor(b, 'Historical Cultural Reference').count).toBe(2);
    expect(b.excluded.Working).toBeGreaterThanOrEqual(1);
    const all = await w.callRead('arkona_reference_types', { project: 'test', limit: 200 });
    expect(all.body.excluded['Legacy Canon Archive']).toBeGreaterThanOrEqual(1);
  });

  it('coverage: the stored sidebars’ age, never silent', async () => {
    const b = await report();
    expect(b.coverage.source).toBe('the repository tree’s stored sidebars');
    expect(b.coverage.pages).toBeGreaterThanOrEqual(9);
    expect(b.coverage.ok + b.coverage.stale + b.coverage.missing).toBe(b.coverage.pages);
    expect(typeof b.coverage.oldestRead).toBe('string');
    expect(b.coverage.tree.status).toBe('ready');
    expect(b.cost).toBe('none');
  });

  it('filters and paging', async () => {
    const culture = await report({ category: 'Culture' });
    expect((culture.rows as any[]).every((r) => r.category === 'Culture')).toBe(true);
    const open = await report({ status: 'open' });
    expect((open.rows as any[]).every((r) => r.status === 'open')).toBe(true);
    expect(rowFor(open, 'Polity Reference')).toBeUndefined();
    const two = await report({ minCount: 2 });
    expect((two.rows as any[]).map((r) => r.value)).toEqual(['Historical Cultural Reference']);
    const p1 = await report({ limit: 2 });
    expect(p1.returned).toBe(2);
    expect(p1.nextOffset).toBe(2);
    const p2 = await report({ limit: 2, offset: 2 });
    expect(p2.offset).toBe(2);
    expect(p2.rows[0].value).not.toBe(p1.rows[0].value);
  });
});

describe('the checks, before any decision', () => {
  it('noncanonical: a judgement with a link to the mapping row, no fix', () => {
    const f = findings('reference_type_noncanonical').filter((x) => x.pageId === D.cultA);
    expect(f).toHaveLength(1);
    expect(f[0]!.fix).toBeNull();
    expect(f[0]!.severity).toBe('info');
    expect(f[0]!.category).toBe('taxonomy');
    expect(f[0]!.evidence).toMatchObject({ status: 'open', suggestion: 'Culture Reference' });
    expect(String(f[0]!.evidence.link)).toContain(
      '/ui/reference-types?value=Historical%20Cultural%20Reference',
    );
    expect(findings('reference_type_noncanonical').some((x) => x.pageId === D.working)).toBe(false);
    expect(findings('reference_type_noncanonical').some((x) => x.pageId === D.canonical)).toBe(false);
  });

  it('category mismatch: both shown, no fix', () => {
    const f = findings('reference_type_category_mismatch');
    expect(f.map((x) => x.pageId)).toEqual([D.mismatch]);
    expect(f[0]!.fix).toBeNull();
    expect(f[0]!.evidence).toMatchObject({ typeCategory: 'Culture', pageCategory: 'Polity' });
  });
});

describe('the owner’s decisions', () => {
  it('only the owner decides; a value not in use, or canonical, is refused', () => {
    expect(() =>
      svc().decide('agent', PROJECT, {
        value: 'Historical Cultural Reference',
        category: 'Culture',
        action: 'accept',
      }),
    ).toThrow(ReferenceTypeError);
    expect(() =>
      svc().decide('owner', PROJECT, { value: 'Nothing Like It', category: 'Culture', action: 'reject' }),
    ).toThrow(/VALUE_NOT_IN_USE|No page/);
    expect(() =>
      svc().decide('owner', PROJECT, { value: 'Polity Reference', category: 'Polity', action: 'reject' }),
    ).toThrow(/already canonical/);
  });

  it('accept, edit, reject, specialist; each in the audit log; a value decided once', () => {
    const accepted = svc().decide('owner', PROJECT, {
      value: 'Historical Cultural Reference',
      category: 'Culture',
      action: 'accept',
    });
    expect(accepted).toMatchObject({ action: 'map', target: 'Culture Reference', via: 'accept' });
    expect(() =>
      svc().decide('owner', PROJECT, {
        value: 'Historical Cultural Reference',
        category: 'Culture',
        action: 'reject',
      }),
    ).toThrow(/already decided/);
    expect(() =>
      svc().decide('owner', PROJECT, {
        value: 'Historical Polity and Institution Reference',
        category: 'Polity',
        action: 'accept',
      }),
    ).toThrow(/no confident suggestion/);
    expect(() =>
      svc().decide('owner', PROJECT, {
        value: 'Historical Polity and Institution Reference',
        category: 'Polity',
        action: 'edit',
        target: 'Culture Reference',
      }),
    ).toThrow(/canonical in Culture/);
    const edited = svc().decide('owner', PROJECT, {
      value: 'Historical Polity and Institution Reference',
      category: 'Polity',
      action: 'edit',
      target: 'Polity Reference',
    });
    expect(edited).toMatchObject({
      action: 'map',
      target: 'Polity Reference',
      targetNew: false,
      via: 'edit',
    });
    expect(() =>
      svc().decide('owner', PROJECT, {
        value: 'Culture & Naming Reference',
        category: 'Culture',
        action: 'edit',
        target: 'Naming Custom Reference',
      }),
    ).toThrow(/role word/);
    const fresh = svc().decide('owner', PROJECT, {
      value: 'Culture & Naming Reference',
      category: 'Culture',
      action: 'edit',
      target: 'Naming Custom Reference',
      role: 'Naming Custom',
    });
    expect(fresh).toMatchObject({ targetNew: true, role: 'Naming Custom' });
    const rejected = svc().decide('owner', PROJECT, {
      value: 'Sovereign State and Historical Development Reference',
      category: 'Polity',
      action: 'reject',
      reason: 'a specialist history page; leave it',
    });
    expect(rejected.action).toBe('reject');
    const specialist = svc().decide('owner', PROJECT, {
      value: 'Arkonan Calendar Reference',
      category: 'Event',
      action: 'specialist',
      scope: 'category',
    });
    expect(specialist).toMatchObject({ action: 'specialist', pages: null });
    const log = rt().policy.store.listAudit({ action: 'reftypes.decide', limit: 20 });
    expect(log.length).toBeGreaterThanOrEqual(5);
    expect(log.find((a) => JSON.stringify(a.after).includes('Naming Custom Reference'))).toBeDefined();
    // The new canonical value is in the vocabulary in force (not published yet), with its role word.
    const eff = svc().effective(PROJECT);
    expect(eff.pending).toContain(fresh.id);
    expect(
      eff.lists.categories
        .find((c) => c.category === 'Culture')!
        .types.find((t) => t.name === 'Naming Custom Reference'),
    ).toEqual({ name: 'Naming Custom Reference', role: 'Naming Custom' });
  });

  it('bulk accept takes every confident suggestion of the filter', () => {
    const r = svc().bulkAccept('owner', PROJECT, { category: 'Culture' });
    expect(r.accepted.map((d) => d.value)).toEqual(['Regional Culture Reference']);
    expect(r.accepted[0]).toMatchObject({ via: 'bulk', target: 'Culture Reference' });
  });

  it('undo before applied; the report shows each status', async () => {
    const d = svc().store.decisionFor(PROJECT, 'Regional Culture Reference', 'Culture')!;
    expect(svc().undo('owner', PROJECT, d.id).id).toBe(d.id);
    expect(rt().policy.store.listAudit({ action: 'reftypes.undo', limit: 5 })).toHaveLength(1);
    svc().decide('owner', PROJECT, {
      value: 'Regional Culture Reference',
      category: 'Culture',
      action: 'accept',
    });
    const b = await report();
    expect(rowFor(b, 'Historical Cultural Reference').status).toBe('mapped');
    expect(rowFor(b, 'Sovereign State and Historical Development Reference').status).toBe('rejected');
    expect(rowFor(b, 'Arkonan Calendar Reference').status).toBe('specialist');
    expect(rowFor(b, 'Historical Cultural Reference').decision).toMatchObject({
      action: 'map',
      target: 'Culture Reference',
    });
  });
});

describe('the checks after the decisions, and the fix', () => {
  beforeAll(async () => {
    await w.snapshot();
  });

  it('a mapping gives the fix; rejected and specialist values give no finding', () => {
    const mapped = findings('reference_type_noncanonical').filter((x) => x.pageId === D.cultA)[0]!;
    expect(mapped.fix).toMatchObject({
      kind: 'reference_type',
      args: { pageId: D.cultA, facts: { 'Reference Type': 'Culture Reference' } },
    });
    expect(findings('reference_type_noncanonical').some((x) => x.pageId === D.sovereign)).toBe(false);
    expect(findings('reference_type_noncanonical').some((x) => x.pageId === D.calendar)).toBe(false);
  });

  it('the automation knows the code: proposal-only, Apply allowed, default Off', () => {
    const e = entryOf('reference_type_noncanonical')!;
    expect(e).toMatchObject({ automatable: 'propose', applyDirect: true, source: 'audit' });
    expect(e.defaultMode).toBeUndefined();
    const view = rt()
      .automation.codes(PROJECT)
      .find((c) => c.code === 'reference_type_noncanonical')!;
    expect(view.mode).toBe('off');
    expect(view.modes).toEqual(['off', 'propose', 'apply']);
  });

  it('the fix: ONE field through the facts path, If-Match chained, the decision journalled; then undo is refused', async () => {
    const f = findings('reference_type_noncanonical').filter((x) => x.pageId === D.cultA)[0]!;
    const before = w.stack.mock.calls.length;
    const r = await rt().audits.proposeFix('owner', PROJECT, f.id, {});
    expect(r.status).toBe('proposal_captured');
    if (r.status !== 'proposal_captured') return;
    const p = rt().policy.proposals.get(r.proposalId)!;
    const done = await approve(w, r.proposalId);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(rowOf(D.cultA, 'Reference Type')).toBe('Culture Reference');
    const writes = w.stack.mock.calls.slice(before).filter((c) => c.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toMatch(/\/properties\/[^/]+\/rows\//);
    expect(writes[0]!.ifMatch).toBeTruthy();
    expect(p.requiresCanonicalApproval === true || p.requiresCanonicalApproval === false).toBe(true);
    const d = svc().store.decisionFor(PROJECT, 'Historical Cultural Reference', 'Culture')!;
    expect(() => svc().undo('owner', PROJECT, d.id)).toThrow(/applied/);
    expect(svc().store.decision(PROJECT, d.id)!.appliedCount).toBeGreaterThanOrEqual(1);
  });

  it('the automation’s Apply: the same fix as a job the guards judge (the canon guard on an Authoritative page)', async () => {
    const f = findings('reference_type_noncanonical').filter((x) => x.pageId === D.cultB)[0]!;
    const r = await rt().audits.proposeFix('automation', PROJECT, f.id, { direct: true });
    expect(['proposal_captured', 'job_submitted']).toContain(r.status);
    if (r.status === 'job_submitted') {
      const job = await rt().engine.wait(PROJECT, r.jobId, 20_000);
      expect(job.status).toBe('succeeded');
      expect(rowOf(D.cultB, 'Reference Type')).toBe('Culture Reference');
    } else expect(rowOf(D.cultB, 'Reference Type')).toBe('Historical Cultural Reference');
  });

  it('a mapping undone after the audit: its fix is stale, nothing proposed', async () => {
    const f = findings('reference_type_noncanonical').filter((x) => x.pageId === D.regional)[0]!;
    expect(f.fix?.kind).toBe('reference_type');
    const d = svc().store.decisionFor(PROJECT, 'Regional Culture Reference', 'Culture')!;
    svc().undo('owner', PROJECT, d.id);
    await expect(rt().audits.proposeFix('owner', PROJECT, f.id, {})).rejects.toMatchObject({
      code: 'FIX_STALE',
    });
    svc().decide('owner', PROJECT, {
      value: 'Regional Culture Reference',
      category: 'Culture',
      action: 'accept',
    });
  });
});

describe('the creation tools while the vocabulary is a draft', () => {
  it('create_resource: a warning only', async () => {
    const r = await w.call('create_resource', {
      project: 'test',
      name: 'Glass Hollow',
      template: 'AI General Source',
      tags: ['Culture'],
      facts: { 'Reference Type': 'Historical Cultural Reference' },
      dryRun: true,
    });
    if (r.isError) expect(r.body.error.code).not.toBe('REFERENCE_TYPE_NOT_IN_VOCABULARY');
    else expect(JSON.stringify(r.body)).toContain('REFERENCE_TYPE_NOT_IN_VOCABULARY');
  });
});

describe('promote_page warns on a non-canonical Reference Type', () => {
  it('the preview flags it', async () => {
    const r = await w.call('promote_page', {
      project: 'test',
      page: D.working,
      destination: DESK,
      dryRun: true,
    });
    expect(JSON.stringify(r.body)).toContain('Historical Cultural Reference');
    expect(JSON.stringify(r.body)).toContain('is not in the vocabulary');
  });
});

describe('publishing the vocabulary', () => {
  const sectionText = () => {
    const pack = rt().packs.get('arkona')!;
    const doc = w.repo.blocks.get(pack.governance.find((g) => g.key === 'source-formatting')!.documentId)!;
    const at = (doc.blocks as any[]).findIndex(
      (b) => b.kind === 'heading' && textOf(b) === 'Reference Type Vocabulary',
    );
    if (at < 0) return null;
    const out: string[] = [];
    for (let i = at; i < doc.blocks.length; i++) {
      const b = (doc.blocks as any[])[i];
      if (i > at && b.kind === 'heading' && (b.level ?? 1) <= (doc.blocks as any[])[at].level) break;
      out.push(textOf(b));
    }
    return out;
  };

  it('the preview gives the exact text and says the pack must be approved again; nothing is written', async () => {
    const before = w.stack.mock.calls.filter((c) => c.method !== 'GET').length;
    const dry = await svc().publish('owner', PROJECT, { dryRun: true });
    expect(dry.replaced).toBe(false);
    expect(dry.lines[0]).toBe('Reference Type Vocabulary');
    expect(dry.lines).toContain(
      'Culture: Culture Reference (Culture); Language & Naming Reference (Language & Naming); Naming Custom Reference (Naming Custom).',
    );
    expect(dry.lines).toContain(
      'Specialist type: Arkonan Calendar Reference (Event), any page in this category.',
    );
    expect(dry.confirmation).toContain('approve the Arkona pack again');
    expect(w.stack.mock.calls.filter((c) => c.method !== 'GET').length).toBe(before);
  });

  it('publishes ONE write under Sidebar Metadata; the pack reads the vocabulary from it after re-approval', async () => {
    const dry = await svc().publish('owner', PROJECT, { dryRun: true });
    const r = await svc().publish('owner', PROJECT);
    expect(r.jobId).toBeTruthy();
    const job = await rt().engine.wait(PROJECT, r.jobId!, 20_000);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(sectionText()).toEqual(dry.lines);
    expect(svc().store.publications(PROJECT)[0]!.state).toBe('succeeded');
    expect(
      svc().store.decisionFor(PROJECT, 'Culture & Naming Reference', 'Culture')!.publishedAt,
    ).not.toBeNull();
    // The governance check offers the section as a new version; the owner approves it.
    const g = await rt().packs.governance('arkona');
    expect(['offered', 'same']).toContain(g.referenceTypes?.state);
    await rt()
      .packs.commands.approve('owner', 'arkona')
      .catch(async () => rt().packs.commands.approve('owner', 'arkona'));
    const approved = rt().packs.approvedRules('arkona')!.referenceTypes!;
    expect(approved.status).toBe('published');
    expect(approved.specialist).toEqual([
      { type: 'Arkonan Calendar Reference', category: 'Event', pages: null },
    ]);
    expect(approved.categories.find((c) => c.category === 'Culture')!.types.map((t) => t.name)).toContain(
      'Naming Custom Reference',
    );
    expect((await report()).vocabulary.status).toBe('published');
    expect(svc().effective(PROJECT).pending).toEqual([]);
    // A published decision cannot be undone.
    const d = svc().store.decisionFor(PROJECT, 'Arkonan Calendar Reference', 'Event')!;
    expect(() => svc().undo('owner', PROJECT, d.id)).toThrow(/published/);
  });

  it('the creation tools refuse a type outside it, naming the nearest; a specialist type is accepted', async () => {
    const bad = await w.call('create_resource', {
      project: 'test',
      name: 'Glass Hollow',
      template: 'AI General Source',
      tags: ['Culture'],
      facts: { 'Reference Type': 'Historical Cultural Reference' },
      dryRun: true,
    });
    expect(bad.isError).toBe(true);
    expect(bad.body.error.code).toBe('REFERENCE_TYPE_NOT_IN_VOCABULARY');
    expect(bad.body.error.nearest).toBe('Culture Reference');
    const good = await w.call('create_resource', {
      project: 'test',
      name: 'Glass Hollow Calendar',
      template: 'AI General Source',
      tags: ['Event'],
      facts: { 'Reference Type': 'Arkonan Calendar Reference' },
      dryRun: true,
    });
    if (good.isError) expect(good.body.error.code).not.toBe('REFERENCE_TYPE_NOT_IN_VOCABULARY');
    const owner = await w.call('arkona_create_owner', {
      project: 'test',
      type: 'Culture',
      name: 'Glass Hollow Folk',
      home: 'Salahad Cultures',
      referenceType: 'Historical Cultural Reference',
      scope: 'A culture',
      temporalScope: '4A 100 - 4A 400',
      dryRun: true,
    });
    expect(JSON.stringify(owner.body)).toContain('REFERENCE_TYPE_NOT_IN_VOCABULARY');
    expect(owner.isError).toBe(true);
  });

  it('publishing again replaces the section in place', async () => {
    const r = await svc().publish('owner', PROJECT);
    expect(r.replaced).toBe(true);
    await rt().engine.wait(PROJECT, r.jobId!, 20_000);
    const pack = rt().packs.get('arkona')!;
    const doc = w.repo.blocks.get(pack.governance.find((g) => g.key === 'source-formatting')!.documentId)!;
    expect(
      (doc.blocks as any[]).filter((b) => b.kind === 'heading' && textOf(b) === 'Reference Type Vocabulary'),
    ).toHaveLength(1);
    expect((doc.blocks as any[]).some((b) => b.id === 'rtysbm02')).toBe(true);
  });

  it('a hand-edited section wins: the conflicting decision is marked', async () => {
    const pack = rt().packs.get('arkona')!;
    const doc = w.repo.blocks.get(pack.governance.find((g) => g.key === 'source-formatting')!.documentId)!;
    // The owner removes the new type from the Culture line by hand.
    const i = (doc.blocks as any[]).findIndex((b) => textOf(b).startsWith('Culture:'));
    (doc.blocks as any[])[i] = {
      ...(doc.blocks as any[])[i],
      content: [
        { text: 'Culture: Culture Reference (Culture); Language & Naming Reference (Language & Naming).' },
      ],
    };
    doc.version++;
    const g = await rt().packs.governance('arkona');
    expect(g.referenceTypes?.state).toBe('offered');
    await rt().packs.commands.approve('owner', 'arkona');
    const eff = svc().effective(PROJECT);
    const d = svc().store.decisionFor(PROJECT, 'Culture & Naming Reference', 'Culture')!;
    expect(eff.conflicts.get(d.id)).toMatch(/section wins/);
    const b = await report();
    expect(rowFor(b, 'Culture & Naming Reference').conflict).toMatch(/section wins/);
    await w.snapshot();
    const f = findings('reference_type_noncanonical').filter((x) => x.pageId === D.naming)[0]!;
    expect(f.fix).toBeNull();
    expect(f.evidence.status).toBe('conflict');
  });
});

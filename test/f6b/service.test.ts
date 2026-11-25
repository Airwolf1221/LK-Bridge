/**
 * v3 F6b (ADR 0079; design T12 step 1): the classification service over a migrated database and the pure rules, the tree
 * and registry faked (the world tests use the real ones).
 *
 * - the report: statuses and counts, filters, paging; out-of-scope rows reported, never decided;
 * - cached: a reload, a decision and a bulk approve rebuild nothing; a change to the tree's version rebuilds;
 * - decisions: approve (as proposed), change (nav, or subject with its kind), leave undecided; refused for an
 *   out-of-scope row, for "approve" with nothing proposed, for anyone but the owner; audited;
 * - bulk approve: ONE call by ids, ONE transaction, bounded by INDEX_CLASSIFY_BULK_MAX (BULK_TOO_LARGE above it; a filter
 *   takes the first max and says how many remain), idempotent;
 * - the audits' input: only the approved pack version's rule and the owner's approved rows.
 */
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import type { IndexClassifyError } from '../../src/packs/indextax/service.js';
import { IndexClassifyService } from '../../src/packs/indextax/service.js';
import type { Pack, PackRules } from '../../src/packs/types.js';
import type { NodeScanRow } from '../../src/tree/index.js';
import { classifyName, roleOfClassified } from '../../src/tree/classify.js';

const P = 'proj1';

function nodes(extraIndexes = 0): NodeScanRow[] {
  const out: NodeScanRow[] = [];
  const add = (id: string, raw: string, parent: NodeScanRow | null) => {
    const c = classifyName(raw);
    const n: NodeScanRow = {
      id,
      rawName: raw,
      displayName: parent ? c.displayName : raw,
      kind: parent ? c.kind : 'root',
      indexRole: parent ? roleOfClassified(c) : null,
      parentId: parent?.id ?? null,
      depth: parent ? parent.depth + 1 : 0,
      pathIds: [...(parent?.pathIds ?? []), id],
      pathNames: [...(parent?.pathNames ?? []), parent ? c.displayName : raw],
      tags: [],
      referenceType: null,
      canonicalDisplayName: null,
      isLocked: null,
    };
    out.push(n);
    return n;
  };
  const root = add('root', 'AI REPOSITORY', null);
  const arkona = add('arkona', '[INDEX] Arkona', root);
  const continents = add('conts', '[INDEX] Arkona’s Continents', arkona);
  const salahad = add('salahad', '[INDEX] Salahad', continents);
  add('polities', '[INDEX] Salahad Polities', salahad);
  add('odd', '[INDEX] Odd Things', arkona);
  const working = add('working', '[INDEX] Working', root);
  add('wset', '[INDEX] Draft Set', working);
  for (let i = 0; i < extraIndexes; i++)
    add(`c${String(i).padStart(4, '0')}`, `[INDEX] Continent ${i}`, continents);
  return out;
}

function rig(o: { extra?: number; approved?: boolean; bulkMax?: number } = {}) {
  const db = openDatabase(':memory:');
  runMigrations(db);
  let version = 1;
  let scans = 0;
  const scan = nodes(o.extra ?? 0);
  const rules: PackRules = ARKONA_PACK.rules;
  const pack = {
    id: 'arkona',
    name: 'Arkona',
    version: 3,
    rules,
    approved: o.approved === false ? null : { version: 3, at: 0, by: 'owner', sources: [] },
  } as unknown as Pack;
  const audited: { action: string; after: unknown }[] = [];
  const replaced: PackRules[] = [];
  const svc = new IndexClassifyService({
    db,
    packs: {
      forProject: () => [pack],
      approvedRules: () => (o.approved === false ? null : rules),
      get: () => pack,
      commands: {
        replaceRules: (_a: string, _id: string, r: PackRules) => {
          replaced.push(r);
          return { ...pack, version: pack.version + 1, rules: r };
        },
      },
    },
    tree: {
      queries: {
        version: () => version,
        status: () => ({ rootId: 'root', status: 'ready', confirmedAt: 1 }),
        nodeScan: () => {
          scans++;
          return scan;
        },
      },
    } as never,
    registry: { forProject: () => ({ store: { listTypes: () => [], entries: () => [] } }) } as never,
    audit: (_actor, action, _t, _b, after) => audited.push({ action, after }),
    now: () => 1_000,
    ...(o.bulkMax ? { bulkMax: () => o.bulkMax } : {}),
  });
  return {
    svc,
    audited,
    replaced,
    scans: () => scans,
    bump: () => version++,
  };
}

describe('the report', () => {
  it('lists every index with its proposal, status and rule; out of scope reported, never proposed', async () => {
    const r = rig();
    await r.svc.prepare(P);
    const rep = r.svc.report(P);
    const row = (id: string) => rep.rows.find((x) => x.id === id)!;
    expect(row('arkona')).toMatchObject({
      proposed: 'nav',
      rule: 'top_level',
      status: 'proposed',
      currentRole: 'subject',
    });
    expect(row('salahad')).toMatchObject({ proposed: 'subject', subject: 'place', rule: 'continent' });
    expect(row('odd')).toMatchObject({ proposed: 'undecided', status: 'undecided' });
    expect(row('wset')).toMatchObject({ status: 'out_of_scope', area: 'Working', scope: 'out' });
    expect(rep.counts).toMatchObject({ out_of_scope: 1, undecided: 1 });
    expect(rep.rules).toMatchObject({ approved: true, tagSection: 'draft', orderingInForce: true });
    expect(r.svc.report(P, { status: ['undecided'] }).rows.map((x) => x.id)).toEqual(['odd']);
    expect(r.svc.report(P, { proposed: 'subject' }).rows.map((x) => x.id)).toEqual(['salahad']);
    expect(r.svc.report(P, { nameContains: 'polit' }).rows.map((x) => x.id)).toEqual(['polities']);
    expect(
      r.svc
        .report(P, { underId: 'working' })
        .rows.map((x) => x.id)
        .sort(),
    ).toEqual(['working', 'wset']);
  });

  it('is cached and paged: a reload and a decision rebuild nothing; a tree change rebuilds', async () => {
    const r = rig({ extra: 250 });
    await r.svc.prepare(P);
    expect(r.scans()).toBe(1);
    const p1 = r.svc.report(P, {}, { offset: 0, limit: 100 });
    const p2 = r.svc.report(P, {}, { offset: 100, limit: 100 });
    expect(p1.rows).toHaveLength(100);
    expect(p2.rows).toHaveLength(100);
    expect(p1.totalRows).toBe(257);
    expect(new Set([...p1.rows, ...p2.rows].map((x) => x.id)).size).toBe(200);
    await r.svc.prepare(P);
    r.svc.decide('owner', P, { pageId: 'salahad', action: 'approve' });
    r.svc.report(P);
    expect(r.scans()).toBe(1);
    r.bump();
    await r.svc.prepare(P);
    expect(r.scans()).toBe(2);
  });
});

describe('decisions', () => {
  it('approve, change and leave undecided; audited; refused where they cannot apply', async () => {
    const r = rig();
    await r.svc.prepare(P);
    const a = r.svc.decide('owner', P, { pageId: 'arkona', action: 'approve' });
    expect(a.decision).toMatchObject({ action: 'approve', role: 'nav', rule: 'top_level' });
    expect(a.row).toMatchObject({ status: 'approved', approvedRole: 'nav' });
    const c = r.svc.decide('owner', P, {
      pageId: 'odd',
      action: 'change',
      role: 'subject',
      subject: 'culture',
    });
    expect(c.row).toMatchObject({ status: 'changed', approvedRole: 'subject', approvedSubject: 'culture' });
    const u = r.svc.decide('owner', P, { pageId: 'polities', action: 'undecided' });
    expect(u.row).toMatchObject({ status: 'left_undecided', approvedRole: null });
    // Deciding again replaces the decision.
    expect(r.svc.decide('owner', P, { pageId: 'polities', action: 'approve' }).row.status).toBe('approved');
    expect(r.audited.filter((x) => x.action === 'indexclassify.decide')).toHaveLength(4);
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as IndexClassifyError).code;
      }
      return null;
    };
    expect(code(() => r.svc.decide('owner', P, { pageId: 'wset', action: 'approve' }))).toBe('OUT_OF_SCOPE');
    expect(code(() => r.svc.decide('owner', P, { pageId: 'odd', action: 'approve' }))).toBe(
      'NOTHING_PROPOSED',
    );
    expect(code(() => r.svc.decide('agent', P, { pageId: 'arkona', action: 'approve' }))).toBe('NOT_OWNER');
    expect(code(() => r.svc.decide('owner', P, { pageId: 'nope', action: 'approve' }))).toBe('NOT_AN_INDEX');
    expect(code(() => r.svc.decide('owner', P, { pageId: 'odd', action: 'change' }))).toBe('ROLE_REQUIRED');
  });

  it('bulk approve: by ids, one transaction, bounded, idempotent; a filter takes the first max', async () => {
    const r = rig({ extra: 30, bulkMax: 10 });
    await r.svc.prepare(P);
    const proposed = r.svc.approvable(P);
    expect(proposed.length).toBe(35);
    expect(() => r.svc.bulkApprove('owner', P, { ids: proposed })).toThrow(/at most 10/);
    const first = r.svc.bulkApprove('owner', P, { ids: proposed.slice(0, 10) });
    expect(first.approved).toHaveLength(10);
    expect(first.rows.every((x) => x.status === 'approved')).toBe(true);
    // Again: nothing new (already decided), nothing changed.
    const again = r.svc.bulkApprove('owner', P, { ids: proposed.slice(0, 10) });
    expect(again.approved).toHaveLength(0);
    expect(again.skipped.every((s) => s.reason === 'already_decided')).toBe(true);
    // Rows no rule proposes, out of scope or unknown are skipped with their reason.
    const mixed = r.svc.bulkApprove('owner', P, { ids: ['odd', 'wset', 'nope'] });
    expect(mixed.skipped.map((s) => s.reason)).toEqual(['undecided', 'out_of_scope', 'not_an_index']);
    // By filter: the first max, the rest counted.
    const byFilter = r.svc.bulkApprove('owner', P, {});
    expect(byFilter.approved).toHaveLength(10);
    expect(byFilter.remaining).toBe(15);
    expect(r.audited.filter((x) => x.action === 'indexclassify.bulk_approve')).toHaveLength(2);
  });

  it('a failure inside the transaction writes nothing', async () => {
    const r = rig({ extra: 5 });
    await r.svc.prepare(P);
    const ids = r.svc.approvable(P);
    const store = r.svc.store;
    const put = store.put.bind(store);
    let n = 0;
    store.put = (...a: Parameters<typeof put>) => {
      if (++n === 3) throw new Error('disk full');
      return put(...a);
    };
    expect(() => r.svc.bulkApprove('owner', P, { ids })).toThrow('disk full');
    expect(store.decisions(P)).toHaveLength(0);
  });
});

describe('the structural lists and the audits’ input', () => {
  it('the owner’s lists become a new pack version; nothing changes when they are the same', () => {
    const r = rig();
    expect(
      r.svc.setStructural('owner', P, {
        structural: { topLevel: [...ARKONA_PACK.rules.indexTaxonomy!.structural.topLevel] },
      }).changed,
    ).toBe(false);
    const x = r.svc.setStructural('owner', P, { structural: { named: ['Odd Things', ' odd things '] } });
    expect(x.changed).toBe(true);
    expect(r.replaced[0]!.indexTaxonomy!.structural.named).toEqual(['Odd Things']);
  });

  it('only the approved version’s rule and only approved rows; none before approval', async () => {
    const none = rig({ approved: false });
    expect(none.svc.auditInput(P)).toBeNull();
    const r = rig();
    await r.svc.prepare(P);
    r.svc.decide('owner', P, { pageId: 'arkona', action: 'approve' });
    r.svc.decide('owner', P, { pageId: 'salahad', action: 'approve' });
    r.svc.decide('owner', P, { pageId: 'polities', action: 'undecided' });
    const input = r.svc.auditInput(P)!;
    expect(input.navOrdering).toBe(true);
    expect(input.tagsInForce).toBe(false);
    expect([...input.approved.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))).toEqual([
      ['arkona', { role: 'nav', subject: null }],
      ['salahad', { role: 'subject', subject: 'place' }],
    ]);
  });
});

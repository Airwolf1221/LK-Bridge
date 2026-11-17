/**
 * v3 F3.5 (ADR 0056): the block-id sweep's pure rules, its candidates from the snapshot overlay, and the canon guard's
 * one narrow exception. No LegendKeeper (not even the mock).
 */
import { describe, expect, it } from 'vitest';
import {
  isBlockIdSweepRequest,
  isLegacy,
  legacyProblems,
  scanCandidates,
  verifyAssigned,
  withoutBlockIds,
  type SnapshotOverlay,
} from '../../src/blockids/index.js';
import { CanonicalGuard } from '../../src/facts/canonical.js';
import { EXPECT_STEP, VERIFY_STEP } from '../../src/jobs/internal-steps.js';
import { SYSTEM_PRINCIPAL, type JobEngine } from '../../src/jobs/index.js';
import { planBlockwise } from '../../src/pages/blockwise.js';
import type { WriteGuardEntry } from '../../src/jobs/write-guard.js';

type Obj = Record<string, unknown>;
const p = (id: string | undefined, text: string): Obj => ({
  ...(id !== undefined ? { id } : {}),
  kind: 'paragraph',
  content: [{ text }],
});

describe('legacy documents (the rule block-by-block writes refuse on)', () => {
  const missing = [
    p('a', 'one'),
    { kind: 'bulletList', id: 'l', children: [{ kind: 'listItem', children: [] }] },
  ];
  const duplicate = [p('a', 'one'), p('a', 'two')];
  const clean = [
    p('a', 'one'),
    { id: 'u', kind: 'unsupported' },
    { id: 'l', kind: 'quote', children: [p('b', 'x')] },
  ];

  it('a block without an id, at any depth, is legacy', () => {
    expect(legacyProblems(missing)).toMatchObject({ blocks: 3, missing: 1, duplicates: [] });
    expect(isLegacy(missing)).toBe(true);
  });

  it('an id used twice is legacy', () => {
    expect(legacyProblems(duplicate)).toMatchObject({ missing: 0, duplicates: ['a'] });
    expect(isLegacy(duplicate)).toBe(true);
  });

  it('a clean document is left alone', () => {
    expect(legacyProblems(clean)).toMatchObject({ blocks: 4, missing: 0, duplicates: [], unsupported: 1 });
    expect(isLegacy(clean)).toBe(false);
  });

  it('agrees with planBlockwise: it refuses for ids exactly on the documents the sweep calls legacy', () => {
    for (const doc of [missing, duplicate, clean, [], [{ kind: 'unsupported' }]]) {
      const plan = planBlockwise(doc, doc);
      const refusedForIds = !plan.ok && plan.refusal.reason === 'ids';
      expect(refusedForIds, JSON.stringify(doc)).toBe(isLegacy(doc));
    }
  });
});

describe('the verification (everything but block ids)', () => {
  const before = [
    p(undefined, 'one'),
    { kind: 'bulletList', children: [{ kind: 'listItem', children: [p(undefined, 'item')] }] },
    { id: 'u1', kind: 'unsupported' },
  ];
  const assigned = (): Obj[] => [
    p('n1', 'one'),
    { id: 'n2', kind: 'bulletList', children: [{ id: 'n3', kind: 'listItem', children: [p('n4', 'item')] }] },
    { id: 'u1', kind: 'unsupported', version: 'v9' },
  ];

  it('passes when only ids (and the read-only per-block versions) changed', () => {
    const v = verifyAssigned(before, assigned());
    expect(v).toMatchObject({ ok: true, differences: [] });
    expect(withoutBlockIds(assigned())).toEqual(withoutBlockIds(before));
  });

  it('fails on a changed text run or mark', () => {
    const a = assigned();
    (a[0] as { content: Obj[] }).content = [{ text: 'one', bold: true }];
    const v = verifyAssigned(before, a);
    expect(v.ok).toBe(false);
    expect(v.differences[0]!.path).toBe('blocks[0].content[0].bold');
  });

  it('fails on a dropped unsupported block (counted, and the tree differs)', () => {
    const v = verifyAssigned(before, assigned().slice(0, 2));
    expect(v.ok).toBe(false);
    expect(v.differences[0]).toEqual({ path: 'unsupported blocks', expected: 1, actual: 0 });
  });

  it('fails on another order, nesting or kind', () => {
    const a = assigned();
    expect(verifyAssigned(before, [a[1]!, a[0]!, a[2]!]).ok).toBe(false);
    const b = assigned();
    (b[1] as { kind: string }).kind = 'orderedList';
    expect(verifyAssigned(before, b).differences[0]!.path).toBe('blocks[1].kind');
  });

  it('fails when a block is still without an id, or an id is used twice', () => {
    const a = assigned();
    delete a[0]!.id;
    expect(verifyAssigned(before, a).differences).toEqual([
      { path: 'block ids', expected: 'every block has an id', actual: '1 without one' },
    ]);
    const b = assigned();
    b[0]!.id = 'n2';
    expect(verifyAssigned(before, b).differences[0]!.actual).toMatch(/used more than once: n2/);
  });
});

describe('the candidates, from the snapshot overlay (no request)', () => {
  const pieces = new Map<string, unknown>([
    ['sha-missing', { settings: {}, blocks: [p(undefined, 'old')] }],
    ['sha-dup', { settings: {}, blocks: [p('a', 'x'), p('a', 'y')] }],
    ['sha-clean', { settings: {}, blocks: [p('a', 'x')] }],
    ['sha-map', { settings: {}, blocks: [p(undefined, 'a map piece never read')] }],
    ['sha-root', { settings: {}, blocks: [p(undefined, 'the root itself')] }],
  ]);
  const page = (
    id: string,
    name: string,
    parentId: string | null,
    docs: [string, string, string][],
    kind = 'bsrc',
  ) => ({
    id,
    parentId,
    rawName: name,
    displayName: name,
    kind,
    sourceTakenAt: 1000,
    documents: docs.map(([did, type, sha]) => ({ id: did, type, name: 'Main', sha256: sha })),
  });
  const overlay: SnapshotOverlay = {
    ensure: () => Promise.resolve({ snapshotId: 'snap1', takenAt: 1000, stamp: 's1' }),
    pages: () =>
      new Map([
        ['root', page('root', 'AI REPOSITORY', null, [['rootdoc', 'page', 'sha-root']], 'root')],
        ['p1', page('p1', 'Missing', 'root', [['d1', 'page', 'sha-missing']])],
        [
          'p2',
          page('p2', 'Duplicate', 'root', [
            ['d2', 'page', 'sha-dup'],
            ['m2', 'map', 'sha-map'],
          ]),
        ],
        ['p3', page('p3', 'Clean', 'root', [['d3', 'page', 'sha-clean']])],
      ]),
    piece: (sha) => Promise.resolve(pieces.get(sha) ?? null),
  };

  it('finds a missing id and a duplicate id; leaves the clean page, maps and the root alone', async () => {
    const scan = await scanCandidates(overlay, 'proj');
    expect(scan.snapshot).toEqual({ id: 'snap1', takenAt: 1000, stamp: 's1' });
    expect(scan.candidates.map((c) => [c.documentId, c.path, c.missing, c.duplicates])).toEqual([
      ['d2', 'AI REPOSITORY / Duplicate', 0, 1],
      ['d1', 'AI REPOSITORY / Missing', 1, 0],
    ]);
    expect(scan.documents).toBe(3); // the three page documents inside the root; the map is never read
  });

  it('reports no candidates (and no snapshot) before the first full snapshot', async () => {
    const none = await scanCandidates({ ...overlay, ensure: () => Promise.resolve(null) }, 'proj');
    expect(none).toEqual({ snapshot: null, candidates: [], documents: 0, unreadable: 0 });
  });
});

describe('the canon guard’s exception (decision 6): explicit and narrow', () => {
  const sweepOrigin = {
    kind: 'maintenance' as const,
    client: 'maintenance',
    tool: 'assign-block-ids-sweep',
    principal: SYSTEM_PRINCIPAL,
  };
  const agent = { principalId: 'pat_agent', profile: 'writer', label: 'agent' };
  const agentOrigin = { kind: 'mcp' as const, client: 'claude', tool: 'lk_api_write', principal: agent };
  const assign = {
    op: 'assignBlockIds',
    params: { path: { resourceId: 'canon001', documentId: 'doc1' } },
    options: {},
  };
  const checks = [
    { op: EXPECT_STEP, params: { body: { checks: [] } }, options: {} },
    assign,
    { op: VERIFY_STEP, params: { body: { targets: [] } }, options: {} },
  ];
  /** Status Working → Authoritative on the page: a protected change. */
  const toCanon = {
    op: 'updatePropertyRow',
    params: {
      path: { resourceId: 'canon001', propertyId: 'kv1', rowId: 'r1' },
      body: { content: [{ text: 'Authoritative' }] },
    },
    options: {},
  };
  let reads = 0;
  const engine = {
    internalRead: () => {
      reads++;
      return Promise.resolve({
        data: [
          {
            id: 'kv1',
            kind: 'keyValue',
            title: 'PROPERTIES',
            rows: [{ id: 'r1', key: 'Status', content: [{ text: 'Working' }] }],
          },
        ],
      });
    },
  } as unknown as Pick<JobEngine, 'internalRead'>;
  const guard = new CanonicalGuard({ settings: () => ({}), engine });
  const entry = (o: Partial<WriteGuardEntry>): WriteGuardEntry => ({
    project: 'proj',
    principal: SYSTEM_PRINCIPAL,
    origin: sweepOrigin,
    jobKind: 'batch_ops',
    items: checks,
    gate: 'allow',
    ...o,
  });

  it('the sweep’s own job passes, without a read', async () => {
    reads = 0;
    expect(isBlockIdSweepRequest(entry({}))).toBe(true);
    expect(await guard.entry(entry({}))).toEqual({ decision: 'allow' });
    expect(reads).toBe(0);
  });

  it('is not the exception with anything else in the request, another maintenance job, or another principal', () => {
    expect(isBlockIdSweepRequest(entry({ items: [...checks, toCanon] }))).toBe(false);
    expect(isBlockIdSweepRequest(entry({ origin: { ...sweepOrigin, tool: 'tree-check' } }))).toBe(false);
    expect(isBlockIdSweepRequest(entry({ principal: agent }))).toBe(false);
    expect(isBlockIdSweepRequest(entry({ origin: { ...sweepOrigin, kind: 'ui' } }))).toBe(false);
    expect(isBlockIdSweepRequest(entry({ items: checks.filter((c) => c.op !== 'assignBlockIds') }))).toBe(
      false,
    );
  });

  it('a maintenance request that also changes canon is judged as ever (the system is refused)', async () => {
    const v = await guard.entry(entry({ items: [assign, toCanon] }));
    expect(v.decision).toBe('deny');
  });

  it('an agent’s assignBlockIds through lk_api_write keeps today’s treatment', async () => {
    const alone = entry({ principal: agent, origin: agentOrigin, jobKind: 'single_op', items: [assign] });
    expect(isBlockIdSweepRequest(alone)).toBe(false);
    // No protected fact changes: allowed, as before (the gate and the rails decide the rest).
    expect(await guard.entry(alone)).toEqual({ decision: 'allow' });
    // With a canon change beside it: a canonical proposal, as before.
    const mixed = await guard.entry(
      entry({ principal: agent, origin: agentOrigin, items: [assign, toCanon] }),
    );
    expect(mixed.decision).toBe('propose_canonical');
  });
});

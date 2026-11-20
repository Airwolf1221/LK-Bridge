/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * CR-2026-11-R3, R3-66 (the owner's split fix 1, found on the test world): a character with an index and several owners
 * has a Character Core (Character Architecture). Splitting Zahra al-Rashid's Compact Character Reference into several
 * owners made `[INDEX] Zahra al-Rashid` and moved her Reference under it, still a Compact Character Reference at the head
 * of a multi-owner index. Now the same canonical proposal upgrades the surviving source in place (F3a's upgradeToCore:
 * renamed "<Name> - Character Core", Reference Type "Character Core", the Core template recorded; its id, documents,
 * identity facts and text kept), and a destination map that would leave a multi-owner character without a Core any other
 * way is refused (`SPLIT_CORE_REQUIRED`). Each test asserts the SAFE behaviour; the mock LegendKeeper only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SidebarModel } from '../../resources/world.js';
import { OWNER_KEYS } from '../../packs/owners-world.js';
import { TPL } from '../../packs/world.js';
import { C, PROJECT, S, splitWorld, type SplitWorld } from '../../packs/split-world.js';
import { ANSWERED, zahraSplit } from '../../packs/split-inputs.js';
import { approveSplit, named, recordOf, refusal, rowsOf, settle, split } from '../../packs/split-helpers.js';
import { heading, para, propose, setBody } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const IDENTITY_ROWS = [
  'Subject',
  'Canonical Display Name',
  'Personal / Given Name',
  'Family / Surname',
  'Naming Culture',
  'Race / Species',
  'Life State',
  'Temporal Scope',
];

describe('R3-66: a Compact Character Reference split into several owners becomes the Character Core', () => {
  let w: SplitWorld;
  let jobId = '';
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('the same canonical proposal upgrades the surviving source in place', async () => {
    const before = rowsOf(w, S.zahra);
    const p = await propose(w, zahraSplit());
    // The preview lists the upgrade with her move under the new index; every new owner needs it (so a partial approval
    // never leaves her several owners and no Core).
    const items = p.r.body.items.list as any[];
    const up = items.find((i) => i.id === `existing:${S.zahra}`);
    expect(up?.label ?? '', JSON.stringify(items.map((i) => i.label))).toMatch(
      /Zahra al-Rashid - Character Core/,
    );
    for (const i of items.filter((x) => x.kind === 'split_new_owner'))
      expect(i.dependsOn, i.label).toContain(`existing:${S.zahra}`);
    const done = await approveSplit(w, p.proposalId);
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    jobId = done.jobId;
    // On the reviewed code: still "[BSRC] Zahra al-Rashid - Character Reference" (Compact) under her new index.
    const res = w.repo.live(S.zahra)!;
    expect(res.name).toBe('[BSRC] Zahra al-Rashid - Character Core');
    expect(res.parentId).toBe(named(w, '[INDEX] Zahra al-Rashid')!.id);
    const rows = rowsOf(w, S.zahra);
    expect(rows['Reference Type']).toBe('Character Core');
    for (const k of IDENTITY_ROWS) expect(rows[k], k).toBe(before[k]);
    expect(w.stack.runtime.tree.queries.node(PROJECT, S.zahra).data?.templateId).toBe(TPL.core);
    expect(res.tags).toEqual(['CANON', 'Character', 'Qishen', 'Menkheti']);
    // The job verified it (its read-back includes the new name), and the split's record says so.
    const rec = await recordOf(w, done.jobId, (r) => r.state === 'verified');
    expect(rec.state).toBe('verified');
  });

  it('Revert: her Compact Character Reference comes back with the deletion of the pages the split made', async () => {
    const rv = await w.stack.runtime.reverts.revert('owner', PROJECT, jobId);
    expect(rv.status, JSON.stringify(rv)).toBe('submitted');
    if (rv.status !== 'submitted') return;
    const job = await settle(w, rv.revertJobId);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    // The revert job never renames an Authoritative page (canon): she is back under Qishen, still her Core, while her
    // index and the pages the split made still stand.
    expect(w.repo.live(S.zahra)!.name).toBe('[BSRC] Zahra al-Rashid - Character Core');
    expect(w.repo.live(S.zahra)!.parentId).toBe(C.qishen);
    const rec = await recordOf(w, jobId, (r) => r.state === 'reverted');
    expect(rec.revert.core).toEqual({ back: true });
    const del = w.stack.runtime.policy.proposals.get(rec.revert.deletionProposalId)!;
    expect(del.requiresCanonicalApproval).toBe(true);
    expect(del.summary).toContain(
      'then [BSRC] Zahra al-Rashid - Character Core back to [BSRC] Zahra al-Rashid - Character Reference (Reference Type Compact Character Reference)',
    );
    // The owner approves it as canon: the pages go, then she is her Compact Character Reference again.
    const d = await approveSplit(w, del.id);
    expect(d.job.status, JSON.stringify(d.job.lastError)).toBe('succeeded');
    expect(named(w, '[INDEX] Zahra al-Rashid')).toBeFalsy();
    expect(w.repo.live(S.zahra)!.name).toBe('[BSRC] Zahra al-Rashid - Character Reference');
    expect(rowsOf(w, S.zahra)['Reference Type']).toBe('Compact Character Reference');
    expect(w.stack.runtime.tree.queries.node(PROJECT, S.zahra).data?.templateId).toBe(TPL.compact);
  });
});

// Thin Lamp's set: his Compact Character Reference already at the head of [INDEX] Thin Lamp, beside a Chronicle.
const THIN_INDEX = 'thinidx1';
const THIN_CHRON = 'thinchr1';

async function thinSet(): Promise<SplitWorld> {
  const w = await splitWorld({
    seed: (world) => {
      const r = world.repo;
      r.seed({ id: THIN_INDEX, name: '[INDEX] Thin Lamp', parentId: C.qishen });
      r.res.get(S.thin)!.parentId = THIN_INDEX;
      r.seed({
        id: THIN_CHRON,
        name: '[BSRC] Thin Lamp - Chronicle',
        parentId: THIN_INDEX,
        referenceType: 'Character Biography',
        tags: ['CANON', 'Character', 'Biography'],
      });
    },
  });
  const rows = OWNER_KEYS.map(
    (k) =>
      [
        k,
        (
          {
            Status: 'Authoritative',
            'Continuity Type': 'CANON',
            Continuity: 'Main',
            Inheritance: 'None',
            Subject: 'Thin Lamp',
            'Reference Type': 'Character Biography',
            Scope: 'Thin Lamp: his life',
            'Temporal Scope': '5A 880 - 5A 931',
            'Last Major Revision': '2026-11-01',
            Supersedes: 'None',
          } as Record<string, string>
        )[k] ?? '',
      ] as [string, string],
  );
  w.sidebars.page(THIN_CHRON, [
    SidebarModel.kv('kvthinch', 'PROPERTIES', rows),
    SidebarModel.links('dpthinch', 'Dependencies', []),
    SidebarModel.links('rlthinch', 'Related Sources', []),
    { id: 'tgthinch', kind: 'unsupported' as const, title: 'TAGS' },
  ]);
  setBody(w, THIN_CHRON, [
    heading('tc1', 2, 'Purpose'),
    para('tc2', 'The chronicle of Thin Lamp’s life.'),
    heading('tc3', 2, 'Early Life'),
    para('tc4', 'Thin Lamp lit the lamps of the lower market for forty years.'),
    heading('tc5', 2, 'Powers'),
    para('tc6', 'He could keep a flame alight in any wind, a knack he never explained.'),
    heading('tc7', 2, 'Unresolved Material'),
    para('tc8', 'Who taught him the knack.'),
  ]);
  setBody(w, THIN_INDEX, [
    heading('ti1', 2, 'How to Use This Index'),
    para('ti2', 'The pages of Thin Lamp.'),
  ]);
  await w.snapshot();
  return w;
}

describe('R3-66: a character already headed by a Compact Character Reference with several owners', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await thinSet();
  });
  afterAll(() => w?.close());

  it('a split of another of its owners is refused: the Compact cannot be upgraded by it', async () => {
    const writes = w.requests().writes;
    const r = await split(w, {
      source: THIN_CHRON,
      destinations: [
        {
          key: 'powers',
          kind: 'new',
          role: 'specialist',
          title: 'Powers & Mechanics',
          referenceType: 'Character Powers & Mechanics Reference',
          scope: 'Thin Lamp: his knack with flame',
          purpose: 'What Thin Lamp can do with a flame.',
          ...ANSWERED,
        },
      ],
      map: [
        { section: 'Purpose', to: 'stays' },
        { section: 'Early Life', to: 'stays' },
        { section: 'Powers', to: 'powers', summary: 'His knack has its own page.' },
        { section: 'Unresolved Material', to: 'stays' },
      ],
    });
    // On the reviewed code: proposed, the set growing to three owners under a Compact Character Reference.
    const hit = refusal(r, 'SPLIT_CORE_REQUIRED');
    expect(hit.message).toContain('upgradeToCore');
    expect(hit.identity).toEqual({ id: S.thin, name: '[BSRC] Thin Lamp - Character Reference' });
    expect(w.requests().writes).toBe(writes);
  });

  it('a split of the Compact itself upgrades it in place, even when it makes no new page', async () => {
    const before = rowsOf(w, S.thin);
    const p = await propose(w, {
      source: S.thin,
      destinations: [{ key: 'chron', kind: 'existing', page: THIN_CHRON, under: 'Unresolved Material' }],
      map: [
        { section: 'Purpose', to: 'stays' },
        { section: 'Identity', to: 'stays' },
        { section: 'Source Boundaries', to: 'stays' },
        { section: 'Unresolved Material', to: 'chron', summary: 'His open questions are on his Chronicle.' },
      ],
    });
    const done = await approveSplit(w, p.proposalId);
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    // On the reviewed code: still his Compact Character Reference, heading two owners.
    const res = w.repo.live(S.thin)!;
    expect(res.name).toBe('[BSRC] Thin Lamp - Character Core');
    expect(res.parentId).toBe(THIN_INDEX);
    const rows = rowsOf(w, S.thin);
    expect(rows['Reference Type']).toBe('Character Core');
    for (const k of IDENTITY_ROWS) expect(rows[k], k).toBe(before[k]);
    const rec = await recordOf(w, done.jobId, (r) => r.state === 'verified');
    expect(rec.state).toBe('verified');
  });
});

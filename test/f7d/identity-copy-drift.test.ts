/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- parsed JSON evidence */
/**
 * v3 F7d (ADR 0077, A10): the audit's `owner_identity_copy_drift` (category `taxonomy`), on the snapshots, against the
 * mock LegendKeeper: an Iuno-like Art page (its copies empty) is found and fixed; a renamed identity page puts the copies
 * out of step again (found, fixed); a differing Temporal Scope is no finding; fields the page's template lacks are
 * ignored; the automation's default is Propose, Apply the owner's switch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { automationWorld } from '../automation/world.js';
import { approve, C, GENERAL_KEYS, IDENTITY_KEYS } from '../packs/world.js';
import { PROJECT, type OwnersWorld } from '../packs/owners-world.js';
import { SidebarModel } from '../resources/world.js';
import { ART_KEYS, rowOf, setRowOf } from './world.js';

const I = {
  index: 'iunoidx1',
  core: 'iunocore',
  art: 'iunoart1',
  bio: 'iunobio1',
  rel: 'iunorel1',
  teoIndex: 'teoidx01',
  teo: 'teocore1',
  teoArt: 'teoart01',
} as const;

let x: OwnersWorld;
const kv = (id: string, keys: readonly string[], v: Record<string, string>) => [
  SidebarModel.kv(
    `kv${id}`.slice(0, 8),
    'PROPERTIES',
    keys.map((k) => [k, v[k] ?? ''] as [string, string]),
  ),
  SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
  SidebarModel.links(`rl${id}`.slice(0, 8), 'Related Sources', []),
];
const canon = {
  Status: 'Authoritative',
  'Continuity Type': 'CANON',
  Continuity: 'Main',
  Inheritance: 'None',
};

beforeAll(async () => {
  x = await automationWorld({
    artCodes: true,
    seed: (world) => {
      const r = world.repo;
      r.seed({ id: I.index, name: '[INDEX] Iuno', parentId: C.qishen });
      r.seed({
        id: I.core,
        name: '[BSRC] Iuno - Character Core',
        parentId: I.index,
        referenceType: 'Character Core',
      });
      r.seed({
        id: I.art,
        name: '[BSRC] Iuno - Character Art',
        parentId: I.index,
        referenceType: 'Character Art',
      });
      r.seed({
        id: I.bio,
        name: '[BSRC] Iuno - Biography',
        parentId: I.index,
        referenceType: 'Character Biography',
      });
      r.seed({
        id: I.rel,
        name: '[BSRC] Iuno & Teo - Relationship',
        parentId: I.index,
        referenceType: 'Joint Character Relationship Reference',
      });
      r.seed({ id: I.teoIndex, name: '[INDEX] Teo Varr', parentId: C.qishen });
      r.seed({
        id: I.teo,
        name: '[BSRC] Teo Varr - Character Core',
        parentId: I.teoIndex,
        referenceType: 'Character Core',
      });
      r.seed({
        id: I.teoArt,
        name: '[BSRC] Teo Varr - Character Art',
        parentId: I.teoIndex,
        referenceType: 'Character Art',
      });
    },
  });
  const sb = x.sidebars;
  // Her Core, as the owner's evidence has it (24 November 2026).
  sb.page(
    I.core,
    kv(I.core, IDENTITY_KEYS, {
      ...canon,
      Subject: 'Iuno',
      'Canonical Display Name': 'Iuno',
      'Family / Surname': 'Aela',
      'Personal / Given Name': 'Iunoreuna',
      'Naming Culture': 'Vitran',
      Aliases: 'Iunoreuna Aela',
      'Reference Type': 'Character Core',
      'Temporal Scope': '5A 880 - 5A 931',
    }),
  );
  // Iuno - Character Art, made by the bridge before F7d: every copy empty (and Temporal Scope, which is not a copy).
  sb.page(I.art, kv(I.art, ART_KEYS, { ...canon, Subject: 'Iuno', 'Reference Type': 'Character Art' }));
  // A page whose template has only the general rows: its Subject agrees, the copies it lacks are not judged.
  sb.page(
    I.bio,
    kv(I.bio, GENERAL_KEYS, { ...canon, Subject: 'Iuno', 'Reference Type': 'Character Biography' }),
  );
  // A relationship (two characters'): not a copy of one identity.
  sb.page(
    I.rel,
    kv(I.rel, GENERAL_KEYS, {
      ...canon,
      Subject: 'Iuno & Teo',
      'Reference Type': 'Joint Character Relationship Reference',
    }),
  );
  // Teo: every copy in step, only Temporal Scope differing (not a copy): no finding.
  const teo = {
    ...canon,
    Subject: 'Teo Varr',
    'Canonical Display Name': 'Teo Varr',
    'Family / Surname': 'Varr',
    'Personal / Given Name': 'Teo',
    'Naming Culture': 'Vitran',
  };
  sb.page(
    I.teo,
    kv(I.teo, IDENTITY_KEYS, {
      ...teo,
      'Reference Type': 'Character Core',
      'Temporal Scope': '5A 900 - 5A 931',
    }),
  );
  sb.page(
    I.teoArt,
    kv(I.teoArt, ART_KEYS, {
      ...teo,
      'Reference Type': 'Character Art',
      'Temporal Scope': '5A 925 - 5A 930',
    }),
  );
  await audit();
});
afterAll(async () => x?.close());

async function audit(): Promise<void> {
  const r = await x.stack.runtime.snapshots.full(PROJECT, 'manual');
  expect(r.summary ?? '', r.summary).not.toMatch(/MISSING/);
  await x.stack.runtime.audits.settled();
  const run = await x.stack.runtime.audits.run(PROJECT, 'manual');
  expect(run.state, run.summary).toBe('succeeded');
}
const open = () =>
  x.stack.runtime.audits.store.list(PROJECT, {
    code: ['owner_identity_copy_drift'],
    state: 'open',
    limit: 100,
  }).findings;

describe('A10: owner_identity_copy_drift', () => {
  it('finds the Iuno-like Art page (each field with both values), and nothing else', () => {
    const f = open();
    expect(f.map((y) => y.pageId)).toEqual([I.art]);
    const art = f[0]!;
    expect(art.category).toBe('taxonomy');
    expect(art.fix?.kind).toBe('identity_copy');
    expect((art.evidence as any).fields).toEqual([
      { key: 'Canonical Display Name', page: '', identity: 'Iuno' },
      { key: 'Family / Surname', page: '', identity: 'Aela' },
      { key: 'Personal / Given Name', page: '', identity: 'Iunoreuna' },
      { key: 'Naming Culture', page: '', identity: 'Vitran' },
      { key: 'Aliases', page: '', identity: 'Iunoreuna Aela' },
    ]);
    expect(JSON.stringify(art.evidence)).not.toMatch(/Temporal Scope|Race|Life State/);
  });

  it('the automation’s default is Propose, and Apply is the owner’s switch', () => {
    const code = x.stack.runtime.automation
      .codes(PROJECT)
      .find((c) => c.code === 'owner_identity_copy_drift');
    expect(code).toMatchObject({ mode: 'propose', modes: ['off', 'propose', 'apply'] });
  });

  it('its fix is one governed set_facts copying the identity page’s values; then the finding clears', async () => {
    const f = open()[0]!;
    const r = await x.stack.runtime.audits.proposeFix('owner', PROJECT, f.id);
    expect(r.status).toBe('proposal_captured');
    if (r.status !== 'proposal_captured') return;
    const d = await approve(x, r.proposalId);
    expect(d.job?.status, JSON.stringify(d.job?.lastError)).toBe('succeeded');
    expect(rowOf(x, I.art, 'Canonical Display Name')).toBe('Iuno');
    expect(rowOf(x, I.art, 'Family / Surname')).toBe('Aela');
    expect(rowOf(x, I.art, 'Personal / Given Name')).toBe('Iunoreuna');
    expect(rowOf(x, I.art, 'Naming Culture')).toBe('Vitran');
    expect(rowOf(x, I.art, 'Aliases')).toBe('Iunoreuna Aela');
    expect(rowOf(x, I.art, 'Temporal Scope')).toBe('');
    // Its writes are journalled (the governed facts path).
    const journal = x.stack.runtime.engine.queries.journalLookup(PROJECT, { jobId: d.jobId!, limit: 50 });
    expect(journal.length).toBeGreaterThanOrEqual(5);
    await audit();
    expect(open()).toEqual([]);
  });

  it('a renamed identity: the copies are out of step again (found, FIX_STALE once the page changed, fixed)', async () => {
    setRowOf(x, I.core, 'Canonical Display Name', 'Iuno Aela');
    await audit();
    const f = open();
    expect(f.map((y) => y.pageId)).toEqual([I.art]);
    expect((f[0]!.evidence as any).fields).toEqual([
      { key: 'Canonical Display Name', page: 'Iuno', identity: 'Iuno Aela' },
    ]);
    // The identity page changes again after the audit: the fix refuses.
    setRowOf(x, I.core, 'Canonical Display Name', 'Iuno of Vitra');
    await expect(x.stack.runtime.audits.proposeFix('owner', PROJECT, f[0]!.id)).rejects.toMatchObject({
      code: 'FIX_STALE',
    });
    await audit();
    const g = open()[0]!;
    const r = await x.stack.runtime.audits.proposeFix('owner', PROJECT, g.id);
    expect(r.status).toBe('proposal_captured');
    if (r.status !== 'proposal_captured') return;
    expect((await approve(x, r.proposalId)).job?.status).toBe('succeeded');
    expect(rowOf(x, I.art, 'Canonical Display Name')).toBe('Iuno of Vitra');
  });
});

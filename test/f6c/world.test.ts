/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- tool JSON and mock rows */
/**
 * v3 F6c (ADR 0080) end to end, against the mock LegendKeeper (the retag world, never fetched):
 *
 * - seeding the five structural types from APPROVED classification rows only ("classify first" for the rest), Nation
 *   refused before Territory, the Territory and Nation role bindings, "Add missing" for each type;
 * - the Nation Subindexes report: the three name forms, variants, unmatched children, a collision, a subject index
 *   excluded, a grandchild never a row, content spanning two roles, the short name and its fallback; the decisions
 *   (accept, map, map for every page of the name, specialist, not a subindex, undo; refused once applied);
 * - F6b's classifier agreeing (a mapped name proposed nav);
 * - the three checks and their fixes (contract: the rename's job is ONE write; the category's creation job with the
 *   binding recorded after; the move proposal's job), the stale refusals, "keep it here", the per-project switches;
 * - placement by role (a home found by its binding, with its level), the name rules before seeding; `create_index`'s
 *   role form; a promoted nation recording its Nation entry; the two automation codes default Off.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { approve } from '../packs/world.js';
import { PROJECT, retagWorld, type RetagWorld } from '../packs/retag-world.js';
import { ROOT } from '../discover/world.js';
import { ownerText } from '../packs/owners-world.js';
import { ownerHttp, type OwnerHttp } from '../automation/helpers.js';
import { RegistryError } from '../../src/registry/types.js';

vi.setConfig({ testTimeout: 180_000 });

const D = {
  continents: 'f6ccnts1',
  zarvia: 'f6czarv1',
  zPolities: 'f6czpol1',
  zCultures: 'f6czcul1',
  zEvents: 'f6czhe01',
  zInstitutions: 'f6czins1',
  zRegions: 'f6czreg1',
  zSettlements: 'f6czset1',
  zFamily: 'f6czfam1',
  cantha: 'f6ccant1',
  cGov: 'f6ccgov1', // [NAV] Government & Institutions → variant (spans two roles)
  cCouncil: 'f6cccou1', // an institution page inside it
  cLaw: 'f6cclaw1', // a law page inside it
  cInst: 'f6ccins1', // [NAV] Cantha - Institutions → matched once the short name is set (dash form)
  cMil: 'f6ccmil1', // [NAV] Military & Naval Affairs → unmatched
  cPalace: 'f6ccpal1', // [INDEX] Cantha Palace → approved subject: not a candidate
  cSet: 'f6ccset1', // [NAV] Settlements & Locations → bare
  cFalak: 'f6ccfal1', // [INDEX] Al-Falak inside it: a grandchild, never a row
  jabal: 'f6cjaba1',
  jMil: 'f6cjmil1', // [NAV] Jabal al-Noor Military & Technology → standard already
  jMil2: 'f6cjmi21', // [NAV] Military & Technology → collision with jMil
  jNav: 'f6cjnav1', // [NAV] Military & Naval Affairs → same name as cMil
  vash: 'f6cvash1', // [BSRC] Emirate of Vash - Polity Reference (a compact polity)
  song: 'f6csong1', // [BSRC] Wandering Song - Culture Reference: a Culture source in Polities
  hymn: 'f6chymn1', // [BSRC] River Hymn - Culture Reference: likewise, kept here by the owner
  realmships: 'f6crlms1',
  naglfar: 'f6cnagl1',
  lost: 'f6clost1',
  oldArk: 'f6coark1',
} as const;

let w: RetagWorld;
let http: OwnerHttp;
const rt = () => w.stack.runtime;
const svc = () => rt().nationTaxonomy;
const reg = () => rt().registry.forProject(PROJECT).store;
const live = (id: string) => w.repo.live(id) as any;
const findings = (code: string) =>
  rt().audits.store.list(PROJECT, { code: [code], state: 'open', limit: 500 }).findings;
const decideClass = (pageId: string, action: 'approve' | 'change', more: Record<string, unknown> = {}) =>
  rt().indexClassify.decide('owner', PROJECT, { pageId, action, ...more });
const rows = async (nationId?: string) => {
  await svc().prepare(PROJECT);
  return svc().report(PROJECT, nationId ? { nationId } : {}, { limit: 500 }).rows;
};
const rowOf = async (id: string) => (await rows()).find((r) => r.id === id)!;

beforeAll(async () => {
  w = await retagWorld({
    seed: (world) => {
      const r = world.repo;
      const idx = (id: string, name: string, parentId: string, tags: string[] = []) =>
        r.seed({ id, name, parentId, tags });
      idx(D.continents, '[NAV] Arkona’s Continents', ROOT, ['Navigation']);
      idx(D.zarvia, '[INDEX] Zarvia', D.continents, ['Place']);
      idx(D.zPolities, '[NAV] Zarvia Polities', D.zarvia, ['Navigation']);
      idx(D.zCultures, '[NAV] Zarvia Cultures', D.zarvia, ['Navigation']);
      idx(D.zEvents, '[NAV] Zarvia Historical Events', D.zarvia, ['Navigation']);
      idx(D.zInstitutions, '[NAV] Zarvia Institutions', D.zarvia, ['Navigation']);
      idx(D.zRegions, '[NAV] Zarvia Regions', D.zarvia, ['Navigation']);
      idx(D.zSettlements, '[NAV] Zarvia Settlements & Locations', D.zarvia, ['Navigation']);
      idx(D.zFamily, '[INDEX] Zarvish Peoples', D.zCultures, ['Culture']);
      idx(D.cantha, '[INDEX] Kingdom of Cantha', D.zPolities, ['Polity']);
      idx(D.cGov, '[NAV] Government & Institutions', D.cantha, ['Navigation']);
      r.seed({
        id: D.cCouncil,
        name: '[BSRC] Royal Council - Institution Reference',
        parentId: D.cGov,
        tags: ['CANON', 'Institution'],
      });
      r.seed({
        id: D.cLaw,
        name: '[BSRC] Throne Law - Law Reference',
        parentId: D.cGov,
        tags: ['CANON', 'Law'],
      });
      idx(D.cInst, '[NAV] Cantha - Institutions', D.cantha, ['Navigation']);
      idx(D.cMil, '[NAV] Military & Naval Affairs', D.cantha, ['Navigation']);
      idx(D.cPalace, '[INDEX] Cantha Palace', D.cantha, ['Place']);
      idx(D.cSet, '[NAV] Settlements & Locations', D.cantha, ['Navigation']);
      idx(D.cFalak, '[INDEX] Al-Falak', D.cSet, ['Place']);
      idx(D.jabal, '[INDEX] Jabal al-Noor', D.zPolities, ['Polity']);
      idx(D.jMil, '[NAV] Jabal al-Noor Military & Technology', D.jabal, ['Navigation']);
      idx(D.jMil2, '[NAV] Military & Technology', D.jabal, ['Navigation']);
      idx(D.jNav, '[NAV] Military & Naval Affairs', D.jabal, ['Navigation']);
      r.seed({
        id: D.vash,
        name: '[BSRC] Emirate of Vash - Polity Reference',
        parentId: D.zPolities,
        tags: ['CANON', 'Polity'],
        referenceType: 'Polity Reference',
      });
      r.seed({
        id: D.song,
        name: '[BSRC] Wandering Song - Culture Reference',
        parentId: D.zPolities,
        tags: ['CANON', 'Culture'],
      });
      r.seed({
        id: D.hymn,
        name: '[BSRC] River Hymn - Culture Reference',
        parentId: D.zPolities,
        tags: ['CANON', 'Culture'],
      });
      idx(D.realmships, '[NAV] Arkona’s Realmships', ROOT, ['Navigation']);
      idx(D.naglfar, '[INDEX] Naglfar', D.realmships, ['Place']);
      idx(D.lost, '[NAV] Lost Realmships', ROOT, ['Navigation']);
      idx(D.oldArk, '[INDEX] Old Ark', D.lost, ['Place']);
    },
  });
  await rt().packs.commands.approve('owner', 'arkona');
  await w.snapshot();
  http = ownerHttp(w);
  http.stepUp();
});
afterAll(async () => w?.close());

describe('the f6c seed', () => {
  it('the approved pack carries the nation roles and the ruling', () => {
    const rules = rt().packs.approvedRules('arkona')!;
    expect(rules.indexTaxonomy?.nationRoles).toHaveLength(10);
    expect(rules.rulings?.find((r) => r.key === 'nation-subindex-roles')).toMatchObject({
      date: '2026-11-26',
    });
    expect(rules.rulings?.find((r) => r.key === 'nation-subindex-roles')?.summary).toMatch(
      /Not yet recorded in Source Formatting’s Nation-Centred Territorial Navigation: the owner’s reviewer writes it after deploy\.$/,
    );
  });

  it('the two codes are proposal-first, Apply allowed, default Off; category_home_mismatch is never automatic', () => {
    const codes = rt().automation.codes(PROJECT);
    for (const code of ['nation_subindex_nonstandard', 'territory_category_missing']) {
      const v = codes.find((c) => c.code === code)!;
      expect(v.mode, code).toBe('off');
      expect(v.modes).toEqual(['off', 'propose', 'apply']);
    }
    expect(codes.find((c) => c.code === 'category_home_mismatch')).toBeUndefined();
  });
});

describe('placement before seeding: the name rules, unchanged', () => {
  it('a bare “Settlements & Locations” in a nation is no home by name', async () => {
    const r = await w.call('arkona_create_owner', place({ home: D.cSet }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/HOME_NOT_ALLOWED/);
  });
});

describe('seeding the structural types', () => {
  it('Nation is refused until Territory is seeded', () => {
    expect(() => svc().seed('owner', PROJECT, 'nation', 'seed')).toThrow(RegistryError);
    try {
      svc().seed('owner', PROJECT, 'nation', 'seed');
    } catch (e) {
      expect((e as RegistryError).code).toBe('SEED_TERRITORY_FIRST');
    }
  });

  it('Territory: approved rows only, the rest “classify first”; Lost Realmships never; the categories by exact name', async () => {
    decideClass(D.zarvia, 'approve');
    await rt().indexClassify.prepare(PROJECT);
    const r = svc().seed('owner', PROJECT, 'territory', 'seed');
    expect(r.created.map((e) => e.plural)).toEqual(['Zarvia']);
    expect(r.classifyFirst.map((c) => c.id)).toContain(D.naglfar);
    expect(r.classifyFirst.map((c) => c.id)).not.toContain(D.oldArk);
    const z = reg().entryBySource(D.zarvia)!;
    const b = new Map(
      reg()
        .bindings(z.id)
        .map((x) => [x.role, x.nodeId]),
    );
    expect(Object.fromEntries(b)).toEqual({
      Polities: D.zPolities,
      Cultures: D.zCultures,
      'Historical Events': D.zEvents,
      Institutions: D.zInstitutions,
      Regions: D.zRegions,
      'Settlements & Locations': D.zSettlements,
    });
    expect(() => svc().seed('owner', PROJECT, 'territory', 'seed')).toThrow(/seeded already/);
  });

  it('Add missing (Territory): a newly approved Realmship; existing entries unchanged', async () => {
    decideClass(D.naglfar, 'approve');
    await rt().indexClassify.prepare(PROJECT);
    const r = svc().seed('owner', PROJECT, 'territory', 'add_missing');
    expect(r.created.map((e) => e.plural)).toEqual(['Naglfar']);
    expect(r.unchanged).toBe(1);
  });

  it('Nation: entries with their Territory parent; roles by C2’s matching; a collision bound to nothing and reviewed', async () => {
    decideClass(D.cantha, 'approve');
    decideClass(D.jabal, 'approve');
    decideClass(D.cPalace, 'change', { role: 'subject', subject: 'place' });
    decideClass(D.cGov, 'approve');
    await rt().indexClassify.prepare(PROJECT);
    const r = svc().seed('owner', PROJECT, 'nation', 'seed');
    expect(r.created.map((e) => e.plural).sort()).toEqual(['Jabal al-Noor', 'Kingdom of Cantha']);
    const z = reg().entryBySource(D.zarvia)!;
    const c = reg().entryBySource(D.cantha)!;
    expect(c.parentId).toBe(z.id);
    const cb = reg().bindings(c.id);
    expect(cb.map((x) => [x.role, x.nodeId, x.status])).toEqual([
      ['Government & Administration', D.cGov, 'ok'],
      // Its classification is not approved as [NAV] yet: bound, for review.
      ['Settlements & Locations', D.cSet, 'needs_review'],
    ]);
    const j = reg().entryBySource(D.jabal)!;
    expect(reg().bindings(j.id)).toEqual([]);
    expect(
      reg()
        .requireEntry(j.id)
        .review.map((x) => x.code),
    ).toContain('role_collision:Military & Technology');
  });

  it('Culture family, Religion family and Divine Realm: each its own type; the family’s parent its Territory', async () => {
    decideClass(D.zFamily, 'approve');
    await rt().indexClassify.prepare(PROJECT);
    const cf = svc().seed('owner', PROJECT, 'culture_family', 'seed');
    expect(cf.created.map((e) => e.plural)).toEqual(['Zarvish Peoples']);
    expect(cf.created[0]!.parentId).toBe(reg().entryBySource(D.zarvia)!.id);
    for (const kind of ['religion_family', 'divine_realm'] as const) {
      const r = svc().seed('owner', PROJECT, kind, 'seed');
      expect(r.created).toEqual([]);
      expect(svc().seed('owner', PROJECT, kind, 'add_missing').created).toEqual([]);
    }
    expect(svc().seed('owner', PROJECT, 'culture_family', 'add_missing').unchanged).toBe(1);
    const status = svc().typeStatus(PROJECT);
    expect(status.map((s) => [s.kind, s.type?.seededAt != null])).toEqual([
      ['territory', true],
      ['nation', true],
      ['divine_realm', true],
      ['culture_family', true],
      ['religion_family', true],
    ]);
  });

  it('the dashboard routes: the types’ state and one type’s entries with their bindings', async () => {
    const s = await http.get('/registry/structural');
    expect(s.status).toBe(200);
    expect(s.json.types.find((t: any) => t.kind === 'territory').entries).toBe(2);
    const n = await http.get('/registry/structural/nation');
    expect(n.json.entries.find((e: any) => e.sourceNodeId === D.cantha).bindings).toHaveLength(2);
  });
});

describe('the Nation Subindexes report', () => {
  it('rows: the forms, the variants, unmatched, a collision; a subject index and a grandchild are not rows', async () => {
    const cantha = await rows(D.cantha);
    expect(cantha.map((r) => r.id).sort()).toEqual([D.cGov, D.cInst, D.cMil, D.cSet].sort());
    const gov = cantha.find((r) => r.id === D.cGov)!;
    expect(gov).toMatchObject({
      status: 'proposed',
      role: 'Government & Administration',
      proposedName: 'Kingdom of Cantha Government & Administration',
      match: { via: 'variant', form: 'bare' },
      children: 2,
      classification: 'nav',
    });
    // It names two roles: its pages are listed with their primary categories.
    expect(gov.spans?.roles).toEqual(['Government & Administration', 'Institutions']);
    expect(gov.spans?.pages.map((p) => p.category).sort()).toEqual(['Institution', 'Law']);
    expect(cantha.find((r) => r.id === D.cMil)).toMatchObject({
      status: 'unmatched',
      match: null,
      role: null,
    });
    expect(cantha.find((r) => r.id === D.cMil)!.classification).toBe('unapproved');
    // The dash form needs the nation's own name: "Cantha" is not its display name yet.
    expect(cantha.find((r) => r.id === D.cInst)!.status).toBe('unmatched');
    const jabal = await rows(D.jabal);
    expect(jabal.find((r) => r.id === D.jMil)).toMatchObject({ standard: true, match: { form: 'nation' } });
    expect(jabal.find((r) => r.id === D.jMil)!.collision.map((c) => c.id)).toEqual([D.jMil2]);
  });

  it('the short name: the dash form matches, and the proposed names use it; cleared, the display name again', async () => {
    const c = reg().entryBySource(D.cantha)!;
    rt().registry.forProject(PROJECT).commands.updateEntry('owner', c.id, { shortName: 'Cantha' });
    const inst = await rowOf(D.cInst);
    expect(inst).toMatchObject({
      status: 'proposed',
      match: { form: 'dash', role: 'Institutions' },
      proposedName: 'Cantha Institutions',
    });
    expect((await rowOf(D.cGov)).proposedName).toBe('Cantha Government & Administration');
    rt().registry.forProject(PROJECT).commands.updateEntry('owner', c.id, { shortName: '' });
    expect((await rowOf(D.cGov)).proposedName).toBe('Kingdom of Cantha Government & Administration');
    rt().registry.forProject(PROJECT).commands.updateEntry('owner', c.id, { shortName: 'Cantha' });
  });

  it('Accept all matched: only matched rows with no collision and an approved classification; ONE request; idempotent; undo per row', async () => {
    await svc().prepare(PROJECT);
    const eligible = svc()
      .acceptable(PROJECT)
      .map((r) => r.id);
    expect(eligible).toContain(D.cGov);
    // Unmatched (cMil), not approved as [NAV] (cSet, cInst), a collision (jMil, jMil2), unmatched (jNav): never.
    for (const id of [D.cMil, D.cSet, D.cInst, D.jMil, D.jMil2, D.jNav]) expect(eligible).not.toContain(id);
    const g = await http.get('/nation-subindexes');
    expect(g.json.acceptable).toEqual({ count: eligible.length, ids: eligible });
    const r = await http.post('/nation-subindexes/accept-all', {
      ids: [...eligible, D.cMil, D.jMil, D.cSet],
      confirm: true,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.accepted).toBe(eligible.length);
    expect(
      Object.fromEntries((r.json.skipped as { id: string; reason: string }[]).map((x) => [x.id, x.reason])),
    ).toEqual({
      [D.cMil]: 'unmatched',
      [D.jMil]: 'collision',
      [D.cSet]: 'classification_not_approved',
    });
    expect((await rowOf(D.cGov)).decision).toMatchObject({ action: 'accept', via: 'accept_all' });
    const again = await http.post('/nation-subindexes/accept-all', { ids: eligible, confirm: true });
    expect(again.json.accepted).toBe(0);
    // Undo works per row, as for a single accept.
    for (const id of eligible) svc().undo('owner', PROJECT, id);
    expect((await rowOf(D.cGov)).status).toBe('proposed');
  });

  it('decisions: accept; accept of an unmatched row refused; map for every page of the name in one request', async () => {
    const a = svc().decide('owner', PROJECT, { pageId: D.cGov, action: 'accept' });
    expect(a.row.status).toBe('accepted');
    expect(() => svc().decide('owner', PROJECT, { pageId: D.cMil, action: 'accept' })).toThrow(
      /matches no nation role/,
    );
    expect(() => svc().decide('owner', PROJECT, { pageId: D.cMil, action: 'map', role: 'Navy' })).toThrow(
      /Say which role/,
    );
    const r = await http.post('/nation-subindexes/map-all', {
      pageId: D.cMil,
      role: 'Military & Technology',
      confirm: true,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.mapped).toBe(2);
    expect((await rowOf(D.cMil)).status).toBe('mapped');
    expect((await rowOf(D.jNav)).decision?.via).toBe('map_all');
    // Again: nothing new.
    const again = await http.post('/nation-subindexes/map-all', {
      pageId: D.jNav,
      role: 'Military & Technology',
      confirm: true,
    });
    expect(again.json.skipped.map((x: any) => x.id)).toEqual([D.cMil]);
    // Specialist and not-a-subindex; then undo.
    svc().decide('owner', PROJECT, { pageId: D.jMil2, action: 'not_subindex' });
    svc().decide('owner', PROJECT, { pageId: D.cInst, action: 'specialist' });
    expect((await rowOf(D.cInst)).status).toBe('specialist');
    const u = await http.post('/nation-subindexes/undo', { pageId: D.cInst, confirm: true });
    expect(u.status).toBe(200);
    expect(u.json.row.status).toBe('proposed');
    svc().decide('owner', PROJECT, { pageId: D.cInst, action: 'accept' });
  });

  it('F6b’s classifier agrees: the mapped name is proposed as a nation subindex ([NAV])', async () => {
    await rt().indexClassify.prepare(PROJECT);
    const row = rt().indexClassify.row(PROJECT, D.cMil)!;
    expect(row.proposed).toBe('nav');
    expect(row.rule).toBe('nation_subindex');
  });

  it('the page’s GET: paged, filtered, under F11’s bound', async () => {
    const t0 = Date.now();
    const r = await http.get(`/nation-subindexes?nation=${D.cantha}&limit=2`);
    expect(r.status).toBe(200);
    expect(r.json.report.rows).toHaveLength(2);
    expect(r.json.report.totalRows).toBe(4);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('placement by role (C5)', () => {
  it('a nation’s bound role is a home, with the level and why; the short name finds the nation', async () => {
    const r = await w.call('arkona_create_owner', place({ home: D.cSet, nation: 'Cantha' }));
    expect(r.isError, r.text).toBe(false);
    expect(r.body.home.placement).toMatchObject({ level: 'role' });
    expect(r.body.home.placement.why).toMatch(/Settlements & Locations/);
  });

  it('create_index’s role form: named, placed, [NAV], the binding recorded once the job succeeds; then ROLE_BOUND', async () => {
    const dry = await w.call('create_index', {
      project: 'test',
      roleFor: { territory: 'Zarvia', category: 'Unique Magic & Technologies' },
      dryRun: true,
    });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.text).toContain('[NAV] Zarvia Unique Magic & Technologies');
    const r = await w.call('create_index', {
      project: 'test',
      roleFor: { nation: 'Cantha', role: 'Household & Court' },
    });
    expect(r.isError, r.text).toBe(false);
    const jobId = String(r.body.jobId);
    const job = await rt().engine.wait(PROJECT, jobId, 20_000);
    expect(job?.status, JSON.stringify(job?.lastError)).toBe('succeeded');
    const made = w.repo.children(D.cantha).find((x: any) => x.name === '[NAV] Cantha Household & Court');
    expect(made).toBeDefined();
    const c = reg().entryBySource(D.cantha)!;
    expect(reg().binding(c.id, 'Household & Court')?.nodeId).toBe(made!.id);
    const again = await w.call('create_index', {
      project: 'test',
      roleFor: { nation: 'Cantha', role: 'Household & Court' },
      dryRun: true,
    });
    expect(again.text).toMatch(/ROLE_BOUND/);
    const wrong = await w.call('create_index', {
      project: 'test',
      name: 'Cantha Court',
      roleFor: { nation: 'Cantha', role: 'Institutions' },
      dryRun: true,
    });
    expect(wrong.text).toMatch(/NAME_NOT_GOVERNED/);
  });

  it('a promoted nation records its Nation entry, its parent the Territory whose Polities holds it', async () => {
    const p = await w.call('arkona_create_owner', {
      type: 'Institution',
      name: 'Court of Vash',
      descriptor: 'Institution Reference',
      nation: 'Emirate of Vash',
      home: 'Emirate of Vash',
      promoteNation: true,
      status: 'authoritative',
      referenceType: 'Institution Reference',
      scope: 'The emirate’s court',
      temporalScope: '4A 100 - 4A 300',
      markdown: ownerText('The court of Vash.'),
      project: 'test',
    });
    expect(p.body.status, p.text).toBe('proposal_captured');
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const index = w.repo.children(D.zPolities).find((x: any) => x.name === '[INDEX] Emirate of Vash')!;
    const e = reg().entryBySource(index.id)!;
    expect(e).toMatchObject({ plural: 'Emirate of Vash', parentId: reg().entryBySource(D.zarvia)!.id });
    expect(reg().type(e.typeId)?.taxonomyKind).toBe('nation');
  });
});

describe('the three checks', () => {
  it('nation_subindex_nonstandard: accepted and mapped rows only; never into a sibling’s name; a collision never', async () => {
    await w.snapshot();
    const f = findings('nation_subindex_nonstandard');
    const byPage = new Map(f.map((x) => [x.pageId, x]));
    expect(byPage.get(D.cGov)?.fix?.args).toMatchObject({ to: '[NAV] Cantha Government & Administration' });
    expect(byPage.get(D.cMil)?.fix?.args).toMatchObject({ to: '[NAV] Cantha Military & Technology' });
    expect(byPage.get(D.cInst)?.fix?.args).toMatchObject({ to: '[NAV] Cantha Institutions' });
    // Jabal's mapped child would take jMil's name: not renamed. Undecided rows: never reported.
    expect(byPage.has(D.jNav)).toBe(false);
    expect(byPage.has(D.cSet)).toBe(false);
  });

  it('the rename’s job: ONE write, the display name only; the decision then cannot be undone', async () => {
    const f = findings('nation_subindex_nonstandard').find((x) => x.pageId === D.cGov)!;
    const before = w.stack.mock.calls.length;
    const r = await rt().audits.proposeFix('owner', PROJECT, f.id, {});
    expect(r.status).toBe('proposal_captured');
    if (r.status !== 'proposal_captured') return;
    expect(rt().policy.proposals.itemsOf(r.proposalId)!.items[0]).toMatchObject({
      kind: 'nation_subindex_name',
      diff: { before: '[NAV] Government & Institutions', after: '[NAV] Cantha Government & Administration' },
    });
    const done = await approve(w, r.proposalId);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const writes = w.stack.mock.calls.slice(before).filter((c) => c.method !== 'GET');
    expect(writes).toHaveLength(1);
    const g = live(D.cGov);
    expect(g).toMatchObject({ name: '[NAV] Cantha Government & Administration', parentId: D.cantha });
    expect(g.tags).toEqual(['Navigation']);
    expect(() => svc().undo('owner', PROJECT, D.cGov)).toThrow(/cannot be undone/);
  });

  it('stale: the decision changed, or the page was renamed, since the finding', async () => {
    const f = findings('nation_subindex_nonstandard').find((x) => x.pageId === D.cMil)!;
    svc().decide('owner', PROJECT, { pageId: D.cMil, action: 'map', role: 'Military & Technology' });
    await expect(rt().audits.proposeFix('owner', PROJECT, f.id, {})).rejects.toMatchObject({
      code: 'FIX_STALE',
    });
    const g = findings('nation_subindex_nonstandard').find((x) => x.pageId === D.cInst)!;
    w.repo.res.get(D.cInst)!.name = '[NAV] Cantha Institutions and Schools';
    await expect(rt().audits.proposeFix('owner', PROJECT, g.id, {})).rejects.toMatchObject({
      code: 'FIX_STALE',
    });
    w.repo.res.get(D.cInst)!.name = '[NAV] Cantha - Institutions';
  });

  it('territory_category_missing: the categories unbound with no index; Conflicts inside Historical Events', () => {
    const f = findings('territory_category_missing');
    const z = f.filter((x) => x.pageId === D.zarvia).map((x) => x.evidence.category);
    // The governance's required categories only: Religions is recognised but never required.
    expect(z.sort()).toEqual(['Conflicts', 'Unique Magic & Technologies']);
    const conflicts = f.find((x) => x.pageId === D.zarvia && x.evidence.category === 'Conflicts')!;
    expect(conflicts.fix?.args).toMatchObject({ parentId: D.zEvents, name: 'Zarvia Conflicts' });
    // Naglfar has none of them; its Conflicts waits for its Historical Events.
    const n = f.filter((x) => x.pageId === D.naglfar).map((x) => x.evidence.category);
    expect(n).toHaveLength(7);
    expect(n).not.toContain('Conflicts');
    expect(n).not.toContain('Religions');
    expect(f.some((x) => x.pageId === D.oldArk)).toBe(false);
  });

  it('its fix: a proposal through create_index’s nav path; the binding recorded once the job succeeds', async () => {
    const f = findings('territory_category_missing').find(
      (x) => x.pageId === D.zarvia && x.evidence.category === 'Conflicts',
    )!;
    const r = await rt().audits.proposeFix('owner', PROJECT, f.id, {});
    expect(r.status).toBe('proposal_captured');
    if (r.status !== 'proposal_captured') return;
    const z = reg().entryBySource(D.zarvia)!;
    expect(reg().binding(z.id, 'Conflicts')).toBeUndefined();
    const done = await approve(w, r.proposalId);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const made = w.repo.children(D.zEvents).find((x: any) => x.name === '[NAV] Zarvia Conflicts')!;
    expect(made).toBeDefined();
    expect(reg().binding(z.id, 'Conflicts')).toMatchObject({ nodeId: made.id, origin: 'job' });
    // The automation's Apply: a job, the binding recorded likewise.
    const g = findings('territory_category_missing').find(
      (x) => x.pageId === D.zarvia && x.evidence.category === 'Unique Magic & Technologies',
    )!;
    const a = await rt().audits.proposeFix('automation', PROJECT, g.id, { direct: true });
    expect(a.status).toBe('job_submitted');
    if (a.status !== 'job_submitted') return;
    const job = await rt().engine.wait(PROJECT, a.jobId, 20_000);
    expect(job?.status, JSON.stringify(job?.lastError)).toBe('succeeded');
    expect(reg().binding(z.id, 'Unique Magic & Technologies')?.nodeId).toBeDefined();
  });

  it('category_home_mismatch: a Culture source in Polities, with a move proposal to the nearest allowed home', async () => {
    const f = findings('category_home_mismatch').find((x) => x.pageId === D.song)!;
    expect(f.severity).toBe('info');
    expect(f.message).toMatch(/Keep it here/);
    const to = String(f.fix!.args.to);
    // The nearest allowed home: the territory's Cultures, or a nation index with no Cultures bound (T4's second level).
    const nations = new Set(
      reg()
        .entries(reg().typeByKind('nation')!.id)
        .map((e) => e.sourceNodeId),
    );
    expect(to === D.zCultures || nations.has(to), JSON.stringify(f.fix!.args)).toBe(true);
    const r = await rt().audits.proposeFix('owner', PROJECT, f.id, {});
    expect(r.status).toBe('proposal_captured');
    if (r.status !== 'proposal_captured') return;
    const done = await approve(w, r.proposalId);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(live(D.song).parentId).toBe(to);
  });

  it('“Keep it here” silences it until the page’s tags or parent change', async () => {
    const f = findings('category_home_mismatch').find((x) => x.pageId === D.hymn)!;
    const k = await http.post(`/audits/findings/${f.id}/keep-home`, {
      reason: 'an anthem of the polities',
      confirm: true,
    });
    expect(k.status, JSON.stringify(k.json)).toBe(200);
    await w.snapshot();
    expect(findings('category_home_mismatch').some((x) => x.pageId === D.hymn)).toBe(false);
    w.repo.res.get(D.hymn)!.tags = ['CANON', 'Culture', 'Language'];
    await w.snapshot();
    expect(findings('category_home_mismatch').some((x) => x.pageId === D.hymn)).toBe(true);
  });

  it('each check switched off per project reports nothing', async () => {
    const projects = rt().projects;
    for (const k of ['checkNationSubindexNames', 'checkTerritoryCategories', 'checkCategoryHomes'])
      projects.setSetting(PROJECT, k, false);
    await w.snapshot();
    for (const code of [
      'nation_subindex_nonstandard',
      'territory_category_missing',
      'category_home_mismatch',
    ])
      expect(findings(code), code).toEqual([]);
    for (const k of ['checkNationSubindexNames', 'checkTerritoryCategories', 'checkCategoryHomes'])
      projects.setSetting(PROJECT, k, true);
  });
});

function place(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'Place',
    name: 'Port Selas',
    descriptor: 'Settlement Reference',
    referenceType: 'Settlement Reference',
    scope: 'A harbour town',
    temporalScope: '4A 100 - 4A 300',
    markdown: ownerText('The harbour town of Selas.'),
    dryRun: true,
    project: 'test',
    ...over,
  };
}

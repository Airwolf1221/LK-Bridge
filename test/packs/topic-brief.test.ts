/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- parsed JSON tool results */
/**
 * v3 F4a (ADR 0063): `arkona_brief`, the brief on any subject, against the REAL stack on the mock LegendKeeper
 * (test/packs/f4a-world.ts): a nation index with three owners; a single owner; a character, delegated to
 * `arkona_character_brief`; a Dependency on a Working page flagged; chronology rows found by an alias; the non-current
 * areas left out and brought in; an ambiguous name refused; work in progress; no LegendKeeper read without `live`, one
 * with it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { C, F, O, P, f4aWorld, type F4aWorld } from './f4a-world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: F4aWorld;
beforeAll(async () => {
  w = await f4aWorld();
  await w.snapshot();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const brief = async (args: Record<string, unknown>) => {
  const r = await w.call('arkona_brief', { project: 'test', ...args });
  expect(r.isError, r.text).toBe(false);
  return r.body;
};
const owner = (b: Record<string, any>, id: string) => (b.owners as any[]).find((x) => x.id === id);

describe('arkona_brief', () => {
  it('a nation index with three owners, each with its lifecycle, Reference Type, Scope, Last Major Revision and tags: free', async () => {
    const before = w.reads();
    const b = await brief({ subject: 'Al-Tibr' });
    expect(w.reads()).toBe(before);
    expect(b.subject.resolvedTo).toEqual({ id: O.alTibr, name: '[INDEX] Al-Tibr', kind: 'index' });
    expect((b.owners as any[]).map((x) => x.name).sort()).toEqual([
      '[BSRC] Al-Tibr - Glass-Coast Customs',
      '[BSRC] Al-Tibr - Polity Reference',
      '[BSRC] Living Mercury-Glass - Al-Tibr Defensive Material',
    ]);
    expect(owner(b, O.alTibrReference)).toMatchObject({
      lifecycle: 'Authoritative',
      referenceType: 'Polity Reference',
      lastMajorRevision: '2026-11-01',
      factsFrom: { source: 'tree' },
      dependencies: [
        { id: O.salahadReference, name: '[BSRC] Salahad - Continent Reference', lifecycle: 'Authoritative' },
      ],
      sourceBoundaries: { markdown: expect.stringMatching(/^## Source Boundaries\n\nOnly the reference/) },
      unresolvedMaterial: { markdown: expect.stringMatching(/The founding year is disputed/) },
    });
    expect(owner(b, O.alTibrReference).dependencies[0].flag).toBeUndefined();
    expect(b.cost).toMatch(/^free/);
    expect(b.rule).toMatch(/never merged/);
    expect(b.freshness.snapshots.newest).toBeDefined();
  });

  it('flags a Dependency on a Working page, and quotes Project Navigation’s rule', async () => {
    const b = await brief({ subject: 'Al-Tibr' });
    const glass = owner(b, O.mercuryGlass);
    const draft = (glass.dependencies as any[]).find((d) => d.id === C.draft);
    expect(draft).toMatchObject({ name: '[BWRK] Draft Notes', lifecycle: 'Working' });
    expect(draft.flag).toMatch(/a Dependency on a Working page/);
    expect(draft.flag).toMatch(/Current authority must not depend on Working/);
    // A single owner, found by its subject: Lumen Strand depends on the same Working page.
    const single = await brief({ subject: 'Lumen Strand' });
    expect(single.subject).toMatchObject({
      resolvedTo: { id: P.workingDep, kind: 'owner' },
      via: 'its subject',
    });
    expect(single.owners).toHaveLength(1);
    expect(single.owners[0].dependencies[0]).toMatchObject({ id: C.draft, lifecycle: 'Working' });
    expect(single.owners[0].dependencies[0].flag).toMatch(/Working page/);
  });

  it('finds the chronology rows naming the subject by an alias or in the possessive, with their KCY and age table', async () => {
    const b = await brief({ subject: 'Al-Tibr' });
    expect(b.chronology.rows).toEqual([
      expect.objectContaining({
        age: 'Fourth Age',
        table: 'Main',
        row: 'farow3',
        event: 'The Glass Coast seals the tide charter',
        date: 'Azah 3rd, 4A 902',
        kcy: '1251209',
        matchedBy: 'its name “Glass Coast”',
      }),
      expect.objectContaining({
        row: 'farow4',
        event: 'Al-Tibr’s fleet escorts the charter home',
        kcy: '1251209',
        matchedBy: 'its name “Al-Tibr”',
      }),
    ]);
    expect(b.chronology.count).toBe(2);
    // The rows' page, with its lifecycle (the chronology is one page, so one label serves every row).
    expect(b.chronology.from).toMatchObject({ page: expect.any(String), lifecycle: expect.any(String) });
  });

  it('leaves the non-current areas out unless include names them', async () => {
    const out = await brief({ subject: 'Al-Tibr' });
    const ref = owner(out, O.alTibrReference);
    // Apple Reach and its own Mercury-Glass (current) depend on it; the Legacy Canon Archive's Old Tide Charter too, but
    // is left out.
    expect(ref.incomingDependencies.count).toBe(2);
    expect((ref.incomingDependencies.first as any[]).map((x) => x.id).sort()).toEqual(
      [P.apple, O.mercuryGlass].sort(),
    );
    expect(ref.incomingDependencies.first[0]).toMatchObject({ lifecycle: 'Authoritative' });
    expect((ref.relatedSources as any[]).map((x) => x.id)).toEqual([O.qasr]);
    // The Old Tide Charter is counted once, though it is both a Related Source and an incoming Dependency.
    expect(out.leftOut['the Legacy Canon Archive']).toBe(1);
    const included = await brief({ subject: 'Al-Tibr', include: ['legacy'] });
    const ref2 = owner(included, O.alTibrReference);
    expect(ref2.incomingDependencies.count).toBe(3);
    expect((ref2.incomingDependencies.first as any[]).map((x) => x.id)).toContain(P.legacyPage);
    expect((ref2.relatedSources as any[]).find((x) => x.id === P.legacyPage)).toMatchObject({
      area: 'the Legacy Canon Archive',
    });
    expect(included.leftOut).toBeUndefined();
    // A subject only in a non-current area is refused unless asked for.
    const refused = await w.call('arkona_brief', { subject: 'Old Tide Charter', project: 'test' });
    expect(refused.isError).toBe(true);
    expect(refused.body.error.code).toBe('SUBJECT_NOT_CURRENT');
    expect(refused.body.error.message).toMatch(/include: \["legacy"\]/);
    const legacy = await brief({ subject: 'Old Tide Charter', include: ['legacy'] });
    expect(legacy.subject.resolvedTo.id).toBe(P.legacyPage);
  });

  it('lists the work in progress: Working pages that mention it, and pending proposals touching its pages', async () => {
    // A proposal (scope propose) touching one of Al-Tibr's owners.
    const proposer = w.stack.newToken('brief-proposer', 'propose');
    const client = await w.stack.connect(proposer.token);
    const p = await w.stack.call(client, 'update_resource', {
      page: O.mercuryGlass,
      aliases: { add: ['Mercury Glass'] },
      project: 'test',
    });
    expect(p.isError, p.text).toBe(false);
    expect(p.body.status).toBe('proposal_captured');
    const b = await brief({ subject: 'Al-Tibr' });
    expect(b.workInProgress.workingPages).toEqual([
      expect.objectContaining({ id: C.draft, lifecycle: 'Working', how: ['mentions it'] }),
    ]);
    expect(b.workInProgress.proposals).toEqual([
      expect.objectContaining({ id: p.body.proposalId, state: 'pending' }),
    ]);
  });

  it('delegates a character to arkona_character_brief', async () => {
    const b = await brief({ subject: 'Nadira al-Khalid' });
    expect(b.delegated).toMatchObject({ from: 'arkona_brief', to: 'arkona_character_brief' });
    expect(b.character).toMatchObject({ subject: 'Nadira al-Khalid', lifecycle: 'Authoritative' });
    expect(b.identity['Naming Culture']).toBe('Menkheti');
  });

  it('refuses a name meaning several subjects, with the candidates, as get_resource does', async () => {
    const r = await w.call('arkona_brief', { subject: 'Mehrana al-Khalid', project: 'test' });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('AMBIGUOUS');
    const ids = (r.body.error.candidates as any[]).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([C.mehrana1, C.mehrana2]));
    const g = await w.call('get_resource', { resource: 'Mehrana al-Khalid', project: 'test' });
    expect(g.body.error.code).toBe('AMBIGUOUS');
  });

  it('reads nothing from LegendKeeper without live, and exactly one sidebar with it', async () => {
    const a = w.reads();
    await brief({ subject: 'Al-Tibr' });
    await brief({ subject: 'Fujimatsuan' });
    expect(w.reads()).toBe(a);
    const b = await brief({ subject: 'Al-Tibr', live: true });
    expect(w.reads()).toBe(a + 1);
    const live = (b.owners as any[]).find((x) => x.factsFrom.source === 'live');
    expect(live).toBeDefined();
    expect(b.cost).toMatch(/one read/);
    expect(b.freshness.live).toMatch(/read now/);
  });

  it('cuts a long section with a handle unless detail is full', async () => {
    const b = await brief({ subject: 'Fujimatsuan' });
    expect(b.subject.resolvedTo.id).toBe(F.fujimatsuan);
    expect(b.owners[0].unresolvedMaterial.markdown).toMatch(/northern dialect/);
    expect(b.owners[0].sourceBoundaries.markdown).toMatch(/This culture only/);
  });
});

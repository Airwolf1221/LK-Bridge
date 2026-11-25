/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * v3 F3b (ADR 0052; design 1.3): a nation's three scalable levels. A compact polity is only its Reference in a Polities
 * index; a second developed owner needs `[INDEX] <Nation>` (NATION_NEEDS_INDEX), which `promoteNation` makes in the
 * SAME proposal: the index (drafted routing text), the Reference moved into it with its id, Dependencies and tags kept,
 * the new owner beside it, the sibling order checked again; a canonical proposal, because it moves an Authoritative page.
 * A national subindex is made only when `createSubindex` names it. The job checks again that no nation index appeared.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approve } from './world.js';
import { O, ownerText, ownersWorld, type OwnersWorld } from './owners-world.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await ownersWorld();
});
afterAll(async () => {
  await w?.close();
});

const call = (args: Record<string, unknown>) => w.call('arkona_create_owner', { project: 'test', ...args });
const pageNamed = (name: string) =>
  [...w.repo.res.values()].find((r) => r.deletedAt === null && r.name === name);
const childNames = (id: string) => w.repo.children(id).map((r) => r.name);

const institution = (over: Record<string, unknown> = {}) => ({
  type: 'Institution',
  name: 'Court of Pearls',
  descriptor: 'Institution Reference',
  nation: 'Sultanate of Tarim',
  home: 'Sultanate of Tarim',
  status: 'authoritative',
  referenceType: 'Institution Reference',
  scope: 'The pearl-divers’ court of the sultanate',
  temporalScope: '4A 100 - 4A 300',
  markdown: ownerText('The pearl court of Tarim.'),
  ...over,
});

describe('a compact polity and promoteNation', () => {
  it('a nation that is only a compact Reference needs its index: NATION_NEEDS_INDEX describes the change', async () => {
    const r = await call({ ...institution({ home: 'Salahad Institutions' }), dryRun: true });
    expect(r.body.error.code).toBe('NATION_NEEDS_INDEX');
    expect(r.body.error.message).toMatch(/\[INDEX\] Sultanate of Tarim made in \[INDEX\] Salahad Polities/);
    expect(r.body.error.message).toMatch(/promoteNation: true/);
    expect(r.body.error.nation.reference.id).toBe(O.tarim);
  });

  it('promoteNation previews the index, the Reference moved with its id, the owner beside it', async () => {
    const r = await call({ ...institution({ promoteNation: true }), dryRun: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.tree.map((t: { page: string; parent: string }) => [t.page, t.parent])).toEqual([
      ['[INDEX] Sultanate of Tarim', '[INDEX] Salahad Polities'],
      ['[BSRC] Court of Pearls - Institution Reference', '[INDEX] Sultanate of Tarim'],
    ]);
    expect(r.body.existing).toEqual([
      {
        page: '[BSRC] Sultanate of Tarim - Historical Polity Reference',
        change: 'moved under [INDEX] Sultanate of Tarim (id kept)',
      },
    ]);
    expect(r.body.promoteNation.moves).toMatchObject({ id: O.tarim, idKept: true });
    const index = r.body.pages.find((p: { name: string }) => p.name === '[INDEX] Sultanate of Tarim');
    expect(index.indexText).toMatch(/## How to Use This Index/);
    // v3 F3f (ADR 0060, D): routing lines are plain mentions (the page's current name, never a custom label).
    expect(index.indexText).toContain(
      '- [](lk://resources/tarimref): A coastal sultanate of eastern Salahad',
    );
    expect(index.indexText).toMatch(/- \[\]\(lk:\/\/resources\/[a-z0-9]+\): /);
    // The Polities index itself as home stands for the new nation index.
    const viaPolities = await call({
      ...institution({ promoteNation: true, home: 'Salahad Polities' }),
      dryRun: true,
    });
    expect(viaPolities.isError, viaPolities.text).toBe(false);
    expect(viaPolities.body.tree[1].parent).toBe('[INDEX] Sultanate of Tarim');
  });

  it('end to end: one canonical proposal; the index made, the Reference moved (same id), the owner beside it, order checked', async () => {
    const tagsBefore = [...w.repo.res.get(O.tarim)!.tags];
    const p = await call(institution({ promoteNation: true }));
    expect(p.body.status, p.text).toBe('proposal_captured');
    expect(p.body.requiresCanonicalApproval).toBe(true);
    expect(String(p.body.reason)).toMatch(/moves the Authoritative page \[BSRC\] Sultanate of Tarim/);
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified).toBe(true);
    const index = pageNamed('[INDEX] Sultanate of Tarim')!;
    expect(index.parentId).toBe(O.salahadPolities);
    const ref = w.repo.res.get(O.tarim)!;
    expect(ref.name).toBe('[BSRC] Sultanate of Tarim - Historical Polity Reference');
    expect(ref.parentId).toBe(index.id);
    expect(ref.tags).toEqual(tagsBefore);
    expect(childNames(index.id)).toEqual([
      '[BSRC] Court of Pearls - Institution Reference',
      '[BSRC] Sultanate of Tarim - Historical Polity Reference',
    ]);
    // Salahad Polities: indexes first, then pages, each alphabetical.
    expect(childNames(O.salahadPolities)).toEqual([
      '[INDEX] Al-Tibr',
      '[INDEX] Menkhet',
      '[INDEX] Sultanate of Tarim',
      '[BSRC] Emirate of Qasr - Polity Reference',
    ]);
    // Now the nation has its index: promoting again is refused, and the index is a home.
    const again = await call({
      ...institution({ name: 'Court of Tides', promoteNation: true }),
      dryRun: true,
    });
    expect(again.body.error.code).toBe('NATION_ALREADY_INDEXED');
    const home = await call({ ...institution({ name: 'Court of Tides' }), dryRun: true });
    expect(home.isError, home.text).toBe(false);
    expect(home.body.tree[0].parent).toBe('[INDEX] Sultanate of Tarim');
  });

  it('a Working owner with promoteNation: the restructure is canon (a canonical proposal), the owner drafted in Working', async () => {
    const r = await call({
      ...institution({
        nation: 'Emirate of Qasr',
        home: 'Emirate of Qasr',
        name: 'Qasr Guard',
        promoteNation: true,
        status: 'working',
      }),
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.requiresCanonicalApproval).toBe(true);
    const prop = w.stack.runtime.policy.proposals.get(String(r.body.proposalId))!;
    expect(prop.pages.join('\n')).toMatch(/\[BWRK\] Qasr Guard - Institution Reference/);
    w.stack.runtime.policy.commands.reject('owner', prop.id, 'test');
  });
});

describe('national subindexes: only when named', () => {
  it('createSubindex makes the named subindex as its own step, with the owner in it', async () => {
    // v3 F6b (ADR 0079): a national subindex only routes, so it is [NAV] (the nation's own index stays [INDEX]).
    const pkg = {
      type: 'Military',
      name: 'Glass Guard',
      descriptor: 'Military Reference',
      nation: 'Al-Tibr',
      home: 'Al-Tibr Institutions',
      createSubindex: 'Al-Tibr Institutions',
      status: 'authoritative',
      referenceType: 'Military Reference',
      scope: 'The mercury-glass guard',
      temporalScope: '4A 200 - 4A 400',
      markdown: ownerText('The guard of Al-Tibr.'),
    };
    const r = await call({ ...pkg, dryRun: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.tree.map((t: { page: string; parent: string }) => [t.page, t.parent])).toEqual([
      ['[NAV] Al-Tibr Institutions', '[INDEX] Al-Tibr'],
      ['[BSRC] Glass Guard - Military Reference', '[NAV] Al-Tibr Institutions'],
    ]);
    const sub = r.body.pages.find((p: { name: string }) => p.name === '[NAV] Al-Tibr Institutions');
    expect(sub.notes.join(' ')).toMatch(/national subindex \(createSubindex\)/);
    const p = await call(pkg);
    const prop = w.stack.runtime.policy.proposals.get(String(p.body.proposalId))!;
    expect(prop.pages.join('\n')).toMatch(/\[NAV\] Al-Tibr Institutions.*national subindex/);
    const done = await approve(w, prop.id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(childNames(O.alTibr)).toEqual([
      '[NAV] Al-Tibr Institutions',
      '[BSRC] Al-Tibr - Polity Reference',
      '[BSRC] Living Mercury-Glass - Al-Tibr Defensive Material',
    ]);
  });

  it('refuses a subindex the type does not live in, one that exists, and never makes one unnamed', async () => {
    const base = {
      type: 'Military',
      name: 'Sand Guard',
      descriptor: 'Military Reference',
      nation: 'Menkhet',
      status: 'authoritative',
      referenceType: 'Military Reference',
      scope: 'A guard',
      temporalScope: '4A',
      markdown: ownerText('A guard.'),
      dryRun: true,
    };
    const wrong = await call({ ...base, home: 'Menkhet Cultures', createSubindex: 'Menkhet Cultures' });
    expect(wrong.body.error.code).toBe('SUBINDEX_NOT_ALLOWED');
    const exists = await call({
      ...base,
      home: 'Menkhet Institutions',
      createSubindex: 'Menkhet Institutions',
    });
    expect(exists.body.error.code).toBe('SUBINDEX_EXISTS');
    // Without createSubindex a missing subindex is not a home: the nation index or an existing subindex is.
    const missing = await call({ ...base, home: 'Menkhet Cultures' });
    expect(missing.body.error.code).toBe('HOME_NOT_FOUND');
    const nationIndex = await call({ ...base, home: 'Menkhet' });
    expect(nationIndex.isError, nationIndex.text).toBe(false);
  });

  it('promoteNation with createSubindex: the nation index, then the subindex, then the owner', async () => {
    const r = await call({
      type: 'Culture',
      name: 'Qasr Pearl-Song',
      descriptor: 'Cultural Reference',
      nation: 'Emirate of Qasr',
      home: 'Emirate of Qasr Cultures',
      promoteNation: true,
      createSubindex: 'Emirate of Qasr Cultures',
      status: 'authoritative',
      referenceType: 'Regional Cultural Reference',
      scope: 'The songs of the pearl coast',
      temporalScope: '4A',
      markdown: ownerText('The pearl-songs.'),
      dryRun: true,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.tree.map((t: { page: string; parent: string }) => [t.page, t.parent])).toEqual([
      ['[INDEX] Emirate of Qasr', '[INDEX] Salahad Polities'],
      ['[NAV] Emirate of Qasr Cultures', '[INDEX] Emirate of Qasr'],
      ['[BSRC] Qasr Pearl-Song - Cultural Reference', '[NAV] Emirate of Qasr Cultures'],
    ]);
  });
});

describe('the job checks again before it writes (design section 5)', () => {
  it('a nation index made between planning and the job: promoteNation stops cleanly, nothing written', async () => {
    const pkg = {
      ...institution({
        nation: 'Emirate of Qasr',
        home: 'Emirate of Qasr',
        name: 'Qasr Court',
        promoteNation: true,
      }),
    };
    const p = await call(pkg);
    expect(p.body.status, p.text).toBe('proposal_captured');
    // Someone makes the index in the app meanwhile.
    const made = w.repo.outside.create('[INDEX] Emirate of Qasr', O.salahadPolities);
    const writesBefore = w.seen.filter((l) => !l.startsWith('GET')).length;
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status).toBe('failed');
    expect(done.job?.lastError?.code).toBe('NATION_INDEX_EXISTS');
    expect(w.seen.filter((l) => !l.startsWith('GET')).length).toBe(writesBefore);
    expect(w.repo.res.get(O.qasr)!.parentId).toBe(O.salahadPolities);
    expect(pageNamed('[BSRC] Qasr Court - Institution Reference')).toBeUndefined();
    w.repo.outside.delete(made.id);
  });

  it('the Reference moved elsewhere meanwhile: stops cleanly', async () => {
    const p = await call({
      ...institution({
        nation: 'Emirate of Qasr',
        home: 'Emirate of Qasr',
        name: 'Qasr Archive',
        promoteNation: true,
      }),
    });
    expect(p.body.status, p.text).toBe('proposal_captured');
    // Moved before the approval: the proposal's own re-read finds the change (conflicted), nothing runs.
    w.repo.outside.move(O.qasr, O.salahadInstitutions);
    const conflicted = await approve(w, String(p.body.proposalId));
    expect(conflicted.state).toBe('conflicted');
    expect(pageNamed('[INDEX] Emirate of Qasr')).toBeUndefined();
    w.repo.outside.move(O.qasr, O.salahadPolities);
    // Moved after the approval, before the job's first write: the job's own check stops it.
    const q = await call({
      ...institution({
        nation: 'Emirate of Qasr',
        home: 'Emirate of Qasr',
        name: 'Qasr Records',
        promoteNation: true,
      }),
    });
    // The move happens when the job reads the governance (its first check), just before its in-lock re-checks.
    let moved = false;
    const hook = new RegExp(`/docs/${w.governanceDocs.formatting}/blocks$`);
    w.overrides.set(hook, () => {
      if (!moved) {
        moved = true;
        w.repo.outside.move(O.qasr, O.salahadInstitutions);
      }
      return undefined;
    });
    const done = await approve(w, String(q.body.proposalId));
    w.overrides.delete(hook);
    const job = done.job;
    expect(job?.status).toBe('failed');
    expect(job?.lastError?.code).toBe('NATION_REFERENCE_MOVED');
    expect(pageNamed('[INDEX] Emirate of Qasr')).toBeUndefined();
    w.repo.outside.move(O.qasr, O.salahadPolities);
  });
});

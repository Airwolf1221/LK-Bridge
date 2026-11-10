/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON replies */
/**
 * v2 A3: the registry's dashboard API on the real bridge with two projects and mock LegendKeepers: the Character
 * seed (the templates read through the governor, and nothing written), types and taxonomy edited and audited, the
 * read-only "Try it" routes, the drift report made by the tree's real daily check, and project isolation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { until } from '../admin/helpers.js';
import { IDS, startTwoProjects, type TwoProjects } from '../projects/helpers.js';

let t: TwoProjects;
afterEach(async () => t?.close());

const waitFor = async (fn: () => Promise<boolean>, ms = 8000) => {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > ms) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function built(): Promise<void> {
  t = await startTwoProjects();
  const m = t.models.alpha;
  m.seedResource('arepo001', { name: 'AI REPOSITORY' });
  m.seedResource('achars01', { name: '[INDEX] Characters', parentId: 'arepo001' });
  m.seedResource('ahuman01', { name: '[INDEX] Humans', parentId: 'achars01' });
  m.seedResource('anote001', { name: '[BSRC] Human customs', parentId: 'ahuman01' });
  m.seedResource('adwarf01', { name: '[INDEX] Dwarves', parentId: 'achars01' });
  m.seedResource('adnote01', { name: '[BSRC] Dwarf holds', parentId: 'adwarf01' });
  m.seedResource('aunkn001', { name: '[INDEX] Undetermined / Unknown', parentId: 'achars01' });
  m.seedResource('azeta001', { name: '[BSRC] Zeta', parentId: 'arepo001' });
  await until(() => t.stack.runtime.projects.activeIds().length === 2);
  expect(
    (await t.admin.put('/projects/alpha/settings', { key: 'aiRepositoryRootId', value: 'arepo001' })).status,
  ).toBe(200);
  expect((await t.admin.post('/tree/build?project=alpha')).status).toBe(202);
  await waitFor(
    async () =>
      (await t.admin.get('/tree?project=alpha')).json.activePass?.status === 'awaiting_confirmation',
  );
  expect((await t.admin.post('/tree/build/confirm?project=alpha', { confirm: true })).status).toBe(200);
  await waitFor(async () => (await t.admin.get('/tree?project=alpha')).json.tree.status === 'ready');
}

describe('the registry on the dashboard', () => {
  it('seeds, edits (audited), answers Try it, and never writes to LegendKeeper', async () => {
    await built();
    const writesBefore = t.writesAt('alpha');
    const empty = await t.admin.get('/registry?project=alpha');
    expect(empty.status).toBe(200);
    expect(empty.json).toMatchObject({ types: [], tree: { status: 'ready' }, templates: { readAt: null } });
    expect(empty.json.seedDefaults.pageTemplates[0]).toEqual({
      role: 'core',
      templateName: '[BSRC] AI Character Core',
    });

    // The seed reads the templates (the mock has none to offer, so the read fails and the seed says so).
    const seeded = await t.admin.post('/registry/seed-character?project=alpha', {});
    expect(seeded.status).toBe(201);
    const type = seeded.json.type;
    expect(type).toMatchObject({ singular: 'Character', rootIndexId: 'achars01', status: 'needs_review' });
    expect(type.review.map((r: any) => r.code)).toEqual([
      'template_not_found',
      'template_not_found',
      'template_not_found',
    ]);
    expect((await t.admin.post('/registry/seed-character?project=alpha', {})).status).toBe(409);
    expect(t.stack.audit('registry.type_seed')[0]).toMatchObject({
      target: type.id,
      after: { project: IDS.alpha },
    });

    const upd = await t.admin.put(`/registry/types/${type.id}?project=alpha`, {
      indexTemplateId: 'tplindex',
      pageTemplates: [
        { role: 'core', templateId: 'tplcore1' },
        { role: 'compact', templateId: 'tplcomp1' },
      ],
      reviewed: true,
    });
    expect(upd.status).toBe(200);
    expect(upd.json.type.status).toBe('ok');
    expect((await t.admin.put(`/registry/types/${type.id}?project=alpha`, { bogus: 1 })).status).toBe(400);

    // The taxonomy: the seed needs a confirmation, then is done once.
    expect((await t.admin.post(`/registry/types/${type.id}/taxonomy/seed?project=alpha`, {})).status).toBe(
      400,
    );
    const seed = await t.admin.post(`/registry/types/${type.id}/taxonomy/seed?project=alpha`, {
      confirm: true,
    });
    expect(seed.status).toBe(200);
    expect(seed.json.result.created.map((e: any) => e.plural).sort()).toEqual(['Dwarves', 'Humans']);
    expect(seed.json.result.reserved.map((x: any) => x.id)).toEqual(['aunkn001']);
    const again = await t.admin.post(`/registry/types/${type.id}/taxonomy/seed?project=alpha`, {
      confirm: true,
    });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('ALREADY_SEEDED');
    const tax = await t.admin.get(`/registry/types/${type.id}/taxonomy?project=alpha`);
    expect(tax.json.entries.map((e: any) => e.plural)).toEqual(['Dwarves', 'Humans']);
    const humans = tax.json.entries.find((e: any) => e.plural === 'Humans');
    expect(humans).toMatchObject({ singular: 'Human', status: 'ok', source: { id: 'ahuman01' } });
    const edit = await t.admin.put(`/registry/taxonomy/${humans.id}?project=alpha`, { aliases: ['Mankind'] });
    expect(edit.json.entry.aliases).toEqual(['Mankind']);
    expect(t.stack.audit('registry.entry_update')).toHaveLength(1);
    expect(
      (await t.admin.post(`/registry/types/${type.id}/taxonomy/add-missing?project=alpha`)).json.result
        .created,
    ).toEqual([]);

    // Try it: read-only answers, typed refusals with their details.
    // (Taxonomy aliases name races for placement; the resolver answers from the tree's own names.)
    const res = await t.admin.get(
      '/registry/try/resolve?project=alpha&query=%5BINDEX%5D%20humans&type=Character',
    );
    expect(res.json.result).toMatchObject({ status: 'resolved', matchedBy: 'raw', node: { id: 'ahuman01' } });
    expect((await t.admin.get('/registry/try/resolve?project=alpha&query=Mankind')).json.result.status).toBe(
      'not_found',
    );
    const amb = await t.admin.get(
      '/registry/try/resolve?project=alpha&query=Nothing%20here&kinds=index,bsrc',
    );
    expect(amb.json.result.status).toBe('not_found');
    const plan = await t.admin.get('/registry/try/placement?project=alpha&characterName=Nobody&kind=compact');
    expect(plan.json.plan).toMatchObject({
      raceIndex: { id: 'aunkn001' },
      species: { value: 'Unestablished' },
      page: { action: 'create', parentId: 'aunkn001' },
    });
    const bad = await t.admin.get(
      '/registry/try/placement?project=alpha&characterName=Kai&race=Atlanteans&kind=core',
    );
    expect(bad.status).toBe(409);
    expect(bad.json.error).toMatchObject({
      code: 'RACE_NOT_FOUND',
      available: ['Dwarf', 'Dwarves', 'Human', 'Humans', 'Mankind'],
    });
    const slot = await t.admin.get(
      '/registry/try/ordering?project=alpha&parentId=achars01&name=Elves&kind=index',
    );
    expect(slot.json.slot).toEqual({ after: 'adwarf01' });
    expect(
      (await t.admin.get('/registry/try/ordering?project=alpha&parentId=achars01&name=X&kind=nope')).status,
    ).toBe(400);

    // Drift on request (audited), and by the tree's real daily check.
    t.models.alpha.seedResource('aelve001', { name: '[INDEX] Elves', parentId: 'achars01' });
    t.models.alpha.seedResource('aelvn001', { name: '[BSRC] Elf ways', parentId: 'aelve001' });
    const run = await t.admin.post('/registry/drift/run?project=alpha');
    expect(run.json.report.findings).toEqual([]); // the tree has not seen Elves yet
    await t.stack.runtime.tree.check(IDS.alpha, 'test');
    const drift = await t.admin.get('/registry/drift?project=alpha');
    expect(drift.json.latest).toMatchObject({ source: 'check', count: 1 });
    expect(drift.json.latest.findings[0]).toMatchObject({ code: 'unmapped_index', nodeId: 'aelve001' });
    expect(t.stack.audit('registry.drift_run')).toHaveLength(1);

    // Nothing above wrote to LegendKeeper (the template read and the tree's reads are GETs).
    expect(t.writesAt('alpha')).toBe(writesBefore);
  });

  it("keeps projects apart: another project's ids are not found", async () => {
    await built();
    const type = (
      await t.admin.post('/registry/types?project=alpha', { singular: 'Place', plural: 'Places' })
    ).json.type;
    expect((await t.admin.get(`/registry/types/${type.id}?project=alpha`)).status).toBe(200);
    expect((await t.admin.get(`/registry/types/${type.id}?project=beta`)).status).toBe(404);
    expect((await t.admin.put(`/registry/types/${type.id}?project=beta`, { notes: 'x' })).status).toBe(404);
    expect((await t.admin.get('/registry?project=beta')).json.types).toEqual([]);
    const notReady = await t.admin.get('/registry/try/resolve?project=beta&query=Humans');
    expect(notReady.status).toBe(409);
    expect(notReady.json.error.code).toBe('TREE_NOT_READY');
    expect(
      (await t.admin.post(`/registry/types/${type.id}/delete?project=alpha`, { confirm: true })).status,
    ).toBe(200);
  });
});

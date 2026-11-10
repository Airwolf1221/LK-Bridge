/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON tool results */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverWorld, type DiscoverWorld } from './world.js';

let w: DiscoverWorld;
let c: Client;
const call = (name: string, args: Record<string, unknown> = {}) => w.stack.call(c, name, args);

beforeAll(async () => {
  w = await discoverWorld();
  c = await w.stack.connect();
});
afterAll(() => w.close());

const names = (nodes: any[]) => nodes.map((n) => n.name);

describe('every tool: access, annotations and the budget footer', () => {
  const NEW = [
    'browse_repository_tree',
    'browse_asset_tree',
    'search',
    'get_resource',
    'get_resources',
    'list_tags',
    'list_templates',
    'list_calendars',
    'list_assets',
    'read_document',
    'get_markdown_guide',
    'get_bridge_guide',
  ];
  it('are read tools, annotated read-only, with a stated cost and an example', async () => {
    const { tools } = await c.listTools();
    for (const n of NEW) {
      const t = tools.find((x) => x.name === n)!;
      expect(t, n).toBeDefined();
      expect(t.annotations, n).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(t.description, n).toMatch(/Cost/);
      expect(t.inputSchema.properties, n).toHaveProperty('project');
    }
    for (const n of NEW.filter((x) => !x.includes('guide'))) {
      expect(tools.find((x) => x.name === n)!.description, n).toMatch(/Example:/);
    }
  });
  it('every answer ends with the project’s budget line and names the project', async () => {
    for (const [n, args] of [
      ['browse_repository_tree', {}],
      ['search', { query: 'miyabi' }],
      ['list_tags', {}],
      ['list_assets', {}],
      ['browse_asset_tree', {}],
      ['get_bridge_guide', {}],
    ] as const) {
      const r = await call(n, args);
      expect(r.isError, `${n}: ${r.text}`).toBe(false);
      expect(r.footer, n).toMatch(/^budget \(test\): /);
      expect(r.body.project, n).toBe('test');
    }
  });
  it('a bad project argument is refused like any tool’s', async () => {
    const r = await call('search', { query: 'x', project: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('UNKNOWN_PROJECT');
  });
});

describe('browse_repository_tree', () => {
  it('shows the root two levels deep by default, with the tree’s status and age', async () => {
    const r = await call('browse_repository_tree');
    expect(r.body.tree).toMatchObject({ status: 'ready' });
    expect(r.body.tree.confirmedAt).toBeTruthy();
    expect(r.body.node.name).toBe('AI REPOSITORY');
    expect(names(r.body.node.children)).toEqual([
      'Characters',
      'Locations',
      'Universal Chronology',
      'World Maps',
      'Plot Board',
      'Loose notes about nothing',
      'Sources',
    ]);
    const characters = r.body.node.children[0];
    expect(characters).toMatchObject({ kind: 'index', childCount: 4 });
    expect(names(characters.children)).toEqual(['Beastkin', 'Elves', 'Undetermined / Unknown', 'Humans']);
    // Depth 2 stops there: the grandchildren show only a count.
    expect(characters.children[0].children).toBeUndefined();
    expect(characters.children[0].childCount).toBe(2);
  });
  it('browses by name, id and path, with kind, Reference Type, Scope (shortened) and tags', async () => {
    const byName = await call('browse_repository_tree', { path: 'Foxians', depth: 2 });
    const byId = await call('browse_repository_tree', { path: 'foxian01', depth: 2 });
    const byPath = await call('browse_repository_tree', {
      path: 'Characters / Beastkin / Foxians',
      depth: 2,
    });
    const byRootedPath = await call('browse_repository_tree', {
      path: 'AI REPOSITORY / Characters / Beastkin / Foxians',
      depth: 2,
    });
    for (const r of [byName, byId, byPath, byRootedPath]) {
      expect(r.isError, r.text).toBe(false);
      expect(r.body.node.id).toBe('foxian01');
    }
    expect(byName.body.path).toBe('AI REPOSITORY / Characters / Beastkin / Foxians');
    const [idx, kaede] = byName.body.node.children;
    expect(idx).toMatchObject({ name: 'Asagiri Miyabi', kind: 'index', childCount: 1 });
    expect(idx.children[0]).toMatchObject({
      name: 'Asagiri Miyabi',
      kind: 'bsrc',
      type: 'Character Core',
      tags: ['canon', 'elder'],
    });
    expect(idx.children[0].scope).toBe('Foxian shrine maiden of the Hollow Court');
    expect(kaede).toMatchObject({ name: 'Asagiri Kaede', type: 'Compact Character Reference' });
  });
  it('shortens a long Scope', async () => {
    const r = await call('browse_repository_tree', { path: 'Great Chronicles', depth: 1, limit: 3 });
    const scope = r.body.node.children[0].scope as string;
    expect(scope.length).toBeLessThanOrEqual(60);
    expect(scope.endsWith('…')).toBe(true);
  });
  it('finds a name that contains a slash before reading it as a path', async () => {
    const r = await call('browse_repository_tree', { path: 'Undetermined / Unknown', depth: 0 });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.node.id).toBe('unknown1');
  });
  it('limits depth (0 to 6), filters by kind and pages the first level', async () => {
    const zero = await call('browse_repository_tree', { path: 'Characters', depth: 0 });
    expect(zero.body.node.children).toBeUndefined();
    expect(zero.body.node.childCount).toBe(4);
    const deep = await call('browse_repository_tree', { path: 'Characters', depth: 6 });
    expect(JSON.stringify(deep.body.node)).toContain('Mehrana al-Khalid');
    expect((await call('browse_repository_tree', { depth: 7 })).isError).toBe(true);
    const indexes = await call('browse_repository_tree', { path: 'Foxians', depth: 3, kinds: ['index'] });
    expect(names(indexes.body.node.children)).toEqual(['Asagiri Miyabi']);
    expect(indexes.body.node.matchingChildren).toBe(1);
    expect(indexes.body.node.childCount).toBe(2);
    const first = await call('browse_repository_tree', { path: 'Characters', depth: 1, limit: 2 });
    expect(first.body.truncated).toBe(true);
    expect(first.body.nextOffset).toBe(2);
    const second = await call('browse_repository_tree', { path: 'Characters', depth: 1, offset: 2 });
    expect(names(second.body.node.children)).toEqual(['Undetermined / Unknown', 'Humans']);
  });
  it('lists the unclassified page as unclassified', async () => {
    const r = await call('browse_repository_tree', { depth: 1, kinds: ['unclassified'] });
    expect(r.body.node.children).toEqual([
      { id: 'loose001', name: 'Loose notes about nothing', kind: 'unclassified', childCount: 0 },
    ]);
  });
  it('refuses a page outside the AI REPOSITORY, saying the low-level tools can still reach it', async () => {
    const byId = await call('browse_repository_tree', { path: 'outside1' });
    expect(byId.isError).toBe(true);
    expect(byId.body.error.code).toBe('NOT_IN_REPOSITORY');
    expect(byId.body.error.message).toMatch(/lk_api_read/);
    const byName = await call('browse_repository_tree', { path: 'Outside page' });
    expect(byName.body.error.code).toBe('NOT_FOUND');
    expect(byName.body.error.message).toMatch(/AI REPOSITORY/);
    expect(byName.body.error.message).toMatch(/lk_api_read/);
  });
  it('lists the candidates, with their paths, when a name is ambiguous', async () => {
    const r = await call('browse_repository_tree', { path: 'Ashgate' });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('AMBIGUOUS');
    expect(r.body.error.candidates.map((x: any) => x.path).sort()).toEqual([
      'AI REPOSITORY / Locations / Isar / Ashgate',
      'AI REPOSITORY / Locations / Kumikas / Ashgate',
    ]);
    // The id picks one.
    expect((await call('browse_repository_tree', { path: 'ashg0002', depth: 0 })).body.node.id).toBe(
      'ashg0002',
    );
  });
  it('says not found with near names as a hint, and cleans a stray prefix', async () => {
    const r = await call('browse_repository_tree', { path: 'Asagiri Miyabo' });
    expect(r.body.error.code).toBe('NOT_FOUND');
    expect(r.body.error.near.map((n: any) => n.name)).toContain('Asagiri Miyabi');
    expect((await call('browse_repository_tree', { path: '[INDEX] Humans', depth: 0 })).body.node.id).toBe(
      'humans01',
    );
  });
  it('costs nothing', async () => {
    const before = w.stack.mock.calls.length;
    await call('browse_repository_tree', { depth: 3 });
    await call('search', { query: 'miyabi' });
    await call('list_tags');
    expect(w.stack.mock.calls.length).toBe(before);
  });
});

describe('search (tree)', () => {
  it('ranks and explains', async () => {
    const r = await call('search', { query: 'miyabi' });
    expect(r.body.tree.status).toBe('ready');
    const rows = r.body.results as any[];
    expect(rows[0]).toMatchObject({ name: 'Asagiri Miyabi', matched: expect.any(Array) });
    // "Asagiri Miyabi" the index and the page have the word in their names; the alias hit ranks below name hits.
    const top = rows.slice(0, 2).map((x) => x.name);
    expect(top).toEqual(['Asagiri Miyabi', 'Asagiri Miyabi']);
    expect(rows[0].matched).toEqual(['name (word)']);
    expect(rows[0].path).toBe('AI REPOSITORY / Characters / Beastkin / Foxians'); // the index
    expect(rows[1].path).toBe('AI REPOSITORY / Characters / Beastkin / Foxians / Asagiri Miyabi'); // the page
    expect(rows.some((x) => x.matched.some((m: string) => m.startsWith('alias')))).toBe(false); // (the alias is not "miyabi" alone…)
  });
  it('exact name beats prefix beats word', async () => {
    const r = await call('search', { query: 'ashgate' });
    const how = r.body.results.map((x: any) => x.matched[0]);
    expect(how.slice(0, 2)).toEqual(['name (exact)', 'name (exact)']);
    expect(new Set(how.slice(2))).toEqual(new Set(['name (word)'])); // "Source 7 of the Ashgate cycle"…
    const q = await call('search', { query: 'asagiri' });
    expect(q.body.results.every((x: any) => x.matched[0] === 'name (prefix)')).toBe(true);
  });
  it('combines words, phrases, OR, NOT, - and parentheses with the filters', async () => {
    const ids = async (query: string) =>
      ((await call('search', { query })).body.results as any[]).map((x) => x.id).sort();
    expect(await ids('asagiri tag:elder')).toEqual(['miyabi01']);
    expect(await ids('tag:elder -tag:draft kind:bsrc')).toEqual(['kumi0001', 'miyabi01']);
    expect(await ids('"quiet maiden"')).toEqual(['miyabi01']);
    expect(await ids('type:"Character Core" under:Characters')).toEqual(['inae0001', 'mehran01', 'miyabi01']);
    expect(await ids('type:character under:Foxians')).toEqual(['kaede001', 'miyabi01']);
    expect(await ids('(mehrana OR inae) NOT tag:draft')).toEqual(['inae0001']);
    expect(await ids('kind:unclassified')).toEqual(['loose001']);
    expect(await ids('scope:qishen kind:index')).toEqual(['qishen01']);
    expect(await ids('"miyabi (foxian)"')).toEqual(['miyabi01']); // the Canonical Display Name
    const canon = (await call('search', { query: '"miyabi (foxian)"' })).body.results[0];
    expect(canon.matched).toEqual(['canonical name "Asagiri Miyabi (Foxian)"']);
    const alias = (await call('search', { query: 'quiet maiden' })).body.results[0];
    expect(alias.matched[0]).toBe('alias "The Quiet Maiden"');
    expect(await ids('under:"Sources" tag:draft name:"Source 13"')).toEqual(['bk00000d', 'bk00003m']);
  });
  it('resolves under: like any name: ambiguity and misses are typed errors', async () => {
    const amb = await call('search', { query: 'under:Ashgate' });
    expect(amb.body.error.code).toBe('AMBIGUOUS');
    expect(amb.body.error.candidates).toHaveLength(2);
    const none = await call('search', { query: 'under:Nowhere' });
    expect(none.body.error.code).toBe('NOT_FOUND');
  });
  it('refuses a malformed query with an explanation and a position, and spends nothing', async () => {
    const before = w.stack.mock.calls.length;
    for (const [q, text] of [
      ['(miyabi', /never closed/],
      ['"miyabi', /never closed/],
      ['miyabi OR', /needs a term/],
      ['colour:red', /not a search filter/],
    ] as const) {
      const r = await call('search', { query: q });
      expect(r.isError, q).toBe(true);
      expect(r.body.error.code).toBe('SEARCH_SYNTAX');
      expect(r.body.error.message).toMatch(text);
      expect(r.body.error.position).toBeGreaterThan(0);
    }
    expect(w.stack.mock.calls.length).toBe(before);
  });
  it('pages results', async () => {
    const a = await call('search', { query: 'source', limit: 10 });
    expect(a.body.count).toBe(10);
    expect(a.body.total).toBeGreaterThan(1000);
    expect(a.body.nextOffset).toBe(10);
    const b = await call('search', { query: 'source', limit: 10, offset: 10 });
    expect(b.body.results[0].id).not.toBe(a.body.results[0].id);
    expect(b.body.offset).toBe(10);
  });
  it('never returns the page outside the root', async () => {
    const r = await call('search', { query: 'outside' });
    expect(r.body.results).toEqual([]);
  });
});

describe('search with content: true', () => {
  it('asks LegendKeeper once, applies the operators to the combined results and removes duplicates', async () => {
    const before = w.seen.length;
    const r = await call('search', { query: 'quietly OR kaede', content: true });
    expect(r.isError, r.text).toBe(false);
    const reads = w.seen.slice(before).filter((l) => l.startsWith('GET /search'));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain('q=quietly+kaede'); // no operators go to LegendKeeper
    expect(r.body.content).toMatchObject({ searched: true, foundByLegendKeeper: 2 });
    expect(r.body.content.note).toMatch(/incomplete/i);
    const ids = r.body.results.map((x: any) => x.id);
    // kaede001 is found by its name AND by its text (and LegendKeeper listed it twice): once. mehran01 only through its
    // text. The page outside the root, which LegendKeeper also returned, is dropped.
    expect(ids.filter((x: string) => x === 'kaede001')).toHaveLength(1);
    expect(ids).toContain('mehran01');
    expect(ids).not.toContain('outside1');
    const mehrana = r.body.results.find((x: any) => x.id === 'mehran01');
    expect(mehrana).toMatchObject({ foundBy: 'page text', matched: ['page text'] });
    const kaede = r.body.results.find((x: any) => x.id === 'kaede001');
    expect(kaede.foundBy).toBeUndefined();
    expect(kaede.matched.length).toBeGreaterThan(0);
    // Pages found by name rank before the page found only by its text.
    expect(ids.indexOf('mehran01')).toBeGreaterThan(ids.indexOf('kaede001'));
  });
  it('applies the operators to the page-text results (a filter removes them)', async () => {
    const r = await call('search', { query: 'quietly tag:draft', content: true });
    expect(r.body.results.map((x: any) => x.id)).toEqual(['mehran01']); // Mehrana carries the draft tag
    expect(r.body.results[0].matched).toEqual(['page text', 'tag draft']);
    const none = await call('search', { query: 'quietly -tag:draft', content: true });
    expect(none.body.results.map((x: any) => x.id)).toEqual(['kaede001']);
  });
  it('does not ask LegendKeeper when the query has no words to search for, and says so', async () => {
    const before = w.seen.length;
    const r = await call('search', { query: 'tag:elder', content: true });
    expect(w.seen.slice(before).filter((l) => l.startsWith('GET /search'))).toHaveLength(0);
    expect(r.body.content).toMatchObject({ searched: false });
    expect(r.body.results.length).toBeGreaterThan(0);
  });
  it('says in its description that content search is incomplete', async () => {
    const t = (await c.listTools()).tools.find((x) => x.name === 'search')!;
    expect(t.description).toMatch(/INCOMPLETE/);
    expect(t.description).toMatch(/no operators/);
  });
});

describe('get_resource', () => {
  it('combines the tree’s data with a live read of the whole sidebar', async () => {
    const before = w.seen.length;
    const r = await call('get_resource', {
      resource: 'Asagiri Miyabi [BSRC]'.replace(' [BSRC]', ''),
      live: true,
    }).catch(() => null);
    // "Asagiri Miyabi" is both an index and a page: ambiguous, with candidates.
    expect(r!.body.error.code).toBe('AMBIGUOUS');
    expect(r!.body.error.candidates.map((x: any) => x.kind).sort()).toEqual(['bsrc', 'index']);
    expect(w.seen.slice(before).filter((l) => l.startsWith('GET /resources'))).toHaveLength(0);

    const got = await call('get_resource', { resource: '[BSRC] Asagiri Miyabi' });
    expect(got.isError, got.text).toBe(false);
    const res = got.body.resource;
    expect(res).toMatchObject({
      id: 'miyabi01',
      name: 'Asagiri Miyabi',
      kind: 'bsrc',
      path: 'AI REPOSITORY / Characters / Beastkin / Foxians / Asagiri Miyabi / Asagiri Miyabi',
      tags: ['canon', 'elder'],
      aliases: ['Miyabi-sama', 'The Quiet Maiden'],
      referenceType: 'Character Core',
      canonicalDisplayName: 'Asagiri Miyabi (Foxian)',
    });
    expect(res.documents).toEqual([{ id: w.docs.miyabiMain, name: 'Main', type: 'page' }]);
    expect(res.liveRead).toMatchObject({ updatedAt: '2026-11-09T10:00:00Z' });
    expect(w.seen.slice(before).filter((l) => l === 'GET /resources/miyabi01')).toHaveLength(1);
    // The sidebar in order: facts (with a mention), a collection with document-level items, a link, unsupported.
    const [facts, deps, rel, tags] = res.sidebar;
    expect(facts).toMatchObject({ kind: 'facts', title: 'PROPERTIES', version: 'pv3' });
    expect(facts.facts.map((f: any) => f.key)).toEqual(['Reference Type', 'Scope', 'Sister']);
    expect(facts.facts[2]).toMatchObject({
      value: 'Asagiri Kaede',
      mentions: [{ resourceId: 'kaede001', text: 'Asagiri Kaede' }],
    });
    expect(deps).toMatchObject({
      kind: 'links',
      collection: 'collection',
      title: 'Dependencies',
      itemCount: 3,
    });
    expect(deps.items[0]).toMatchObject({
      resourceId: 'age40001',
      documentId: w.docs.ageMain,
      name: 'Fourth Age - Table',
      document: 'Main',
    });
    expect(deps.items[1]).toMatchObject({ resourceId: 'kaede001', name: 'Asagiri Kaede' });
    expect(deps.items[2]).toMatchObject({ resourceId: 'outside1', name: null, outsideRepository: true });
    expect(rel).toMatchObject({ kind: 'links', collection: 'link', title: 'Related Sources' });
    expect(rel.items[0]).toMatchObject({ name: 'Mehrana al-Khalid' });
    expect(tags).toMatchObject({ kind: 'unsupported', title: 'TAGS', readOnly: true, unsupported: true });
  });
  it('costs nothing with live: false', async () => {
    const before = w.stack.mock.calls.length;
    const r = await call('get_resource', { resource: 'miyabi01', live: false });
    expect(w.stack.mock.calls.length).toBe(before);
    expect(r.body.resource.sidebar).toBeUndefined();
    expect(r.body.resource.liveRead).toBe(false);
  });
  it('refuses outside the root, ambiguity and not found, as every tool does', async () => {
    expect((await call('get_resource', { resource: 'outside1' })).body.error.code).toBe('NOT_IN_REPOSITORY');
    expect((await call('get_resource', { resource: 'Ashgate' })).body.error.code).toBe('AMBIGUOUS');
    expect((await call('get_resource', { resource: 'No Such Page' })).body.error.code).toBe('NOT_FOUND');
  });
  it('says so when LegendKeeper no longer has a page the tree still lists', async () => {
    w.overrides.set(/\/resources\/kaede001$/, () => ({
      status: 404,
      body: { code: 'NOT_FOUND', message: 'gone' },
    }));
    const r = await call('get_resource', { resource: 'kaede001' });
    w.overrides.clear();
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatchObject({ code: 'LK_ERROR', status: 404 });
  });
});

describe('get_resources', () => {
  it('reads several pages as one job, summarised, and reports each failure on its own', async () => {
    const before = w.stack.runtime.engine.queries.listJobs?.length;
    void before;
    const r = await call('get_resources', {
      resources: ['miyabi01', 'Kaede', 'Ashgate', 'No Such', 'outside1', 'miyabi01'],
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.count).toBe(5); // the repeated id once
    const by = Object.fromEntries(r.body.resources.map((x: any) => [x.asked, x]));
    expect(by.miyabi01).toMatchObject({ ok: true, id: 'miyabi01' });
    expect(by.miyabi01.sidebar[0].facts).toHaveLength(3);
    expect(by.Kaede).toMatchObject({ ok: false });
    expect(by.Kaede.error.code).toBe('NOT_FOUND'); // "Kaede" alone is not a name; the page is "Asagiri Kaede"
    expect(by.Ashgate.error.code).toBe('AMBIGUOUS');
    expect(by['No Such'].error.code).toBe('NOT_FOUND');
    expect(by.outside1.error.code).toBe('NOT_IN_REPOSITORY');
    const job = w.stack.runtime.engine.queries.getJob(
      w.stack.runtime.projects.defaultProject().id!,
      r.body.jobId,
    );
    expect(job?.kind).toBe('batch_ops');
    expect(job?.steps).toHaveLength(1); // one read: only miyabi01 resolved
  });
  it('shows an estimate first when large and runs on confirm', async () => {
    const list = Array.from({ length: 12 }, (_, i) => `bk${i.toString(36).padStart(6, '0')}`);
    const before = w.stack.mock.calls.length;
    const est = await call('get_resources', { resources: list });
    expect(est.isError).toBe(false);
    expect(est.body).toMatchObject({ status: 'estimate', pages: 12, reads: 12 });
    expect(est.body.hint).toMatch(/confirm: true/);
    expect(w.stack.mock.calls.length).toBe(before); // nothing was read
    const run = await call('get_resources', { resources: list, confirm: true });
    expect(run.body.count).toBe(12);
    expect(run.body.resources.every((x: any) => x.ok)).toBe(true);
    expect(w.stack.mock.calls.length - before).toBe(12);
    // Beyond 25 is refused by the schema.
    expect(
      (await call('get_resources', { resources: Array.from({ length: 26 }, (_, i) => `x${i}`) })).isError,
    ).toBe(true);
  });
  it('is free with live: false', async () => {
    const before = w.stack.mock.calls.length;
    const list = Array.from({ length: 20 }, (_, i) => `bk${i.toString(36).padStart(6, '0')}`);
    const r = await call('get_resources', { resources: list, live: false });
    expect(r.body.count).toBe(20);
    expect(w.stack.mock.calls.length).toBe(before);
  });
});

describe('lists', () => {
  it('list_tags counts tags in use under the root', async () => {
    const r = await call('list_tags');
    const by = Object.fromEntries(r.body.tags.map((t: any) => [t.tag, t.count]));
    expect(by.canon).toBeGreaterThan(100);
    expect(by.elder).toBe(2);
    expect(by.draft).toBeGreaterThan(50);
    expect(r.body.tags[0].count).toBeGreaterThanOrEqual(r.body.tags[1].count);
    expect((await call('list_tags', { query: 'ELD' })).body.tags).toEqual([{ tag: 'elder', count: 2 }]);
  });
  it('list_templates reads the project’s templates once, then says which type and role use them', async () => {
    const types = w.stack.runtime.registry.forProject(w.stack.runtime.projects.defaultProject().id!);
    const before = w.seen.length;
    const r = await call('list_templates');
    expect(r.body.count).toBe(14);
    expect(r.body.source.from).toMatch(/LegendKeeper/);
    expect(w.seen.slice(before).filter((l) => l.startsWith('GET /templates'))).toHaveLength(1);
    // Once the registry holds a type that uses one, it says so (and a held copy costs nothing).
    types.store.saveTemplates({
      templates: [{ id: 'tpl00000', name: '[BSRC] AI Template 0', parentId: null }],
      error: null,
    });
    types.commands.createType('owner', {
      singular: 'Thing',
      plural: 'Things',
      indexTemplateId: 'tpl00000',
      pageTemplates: [{ role: 'core', templateId: 'tpl00000' }],
    });
    const again = await call('list_templates');
    expect(again.body.source.from).toMatch(/copy/);
    expect(again.body.templates).toEqual([
      {
        id: 'tpl00000',
        name: '[BSRC] AI Template 0',
        usedBy: [
          { type: 'Thing', role: 'index' },
          { type: 'Thing', role: 'core' },
        ],
      },
    ]);
  });
  it('list_calendars summarises months and eras with one read', async () => {
    const before = w.stack.mock.calls.length;
    const r = await call('list_calendars');
    expect(w.stack.mock.calls.length - before).toBe(1);
    expect(r.body.calendars[0]).toMatchObject({
      id: 'rp86pkdr',
      name: 'Kumikan Epochal',
      months: { count: 5, names: ['Kumikas', 'Isar', 'Selaphos', 'Azah', 'Selyros'] },
      daysInRegularYear: 150,
      hoursInDay: 30,
      eras: [
        { name: 'Before Epoch', abbr: 'AA' },
        { name: 'First Age', abbr: '1A', startsAt: 0 },
      ],
      format: { day: 'MMMM D^, E YYYY' },
    });
  });
});

describe('the asset tools', () => {
  it('browse_asset_tree shows folders, counts and (on request) assets', async () => {
    const r = await call('browse_asset_tree', { depth: 2 });
    expect(r.body.assetTree.status).toBe('ready');
    const top = r.body.folder;
    expect(names(top.folders)).toEqual(expect.arrayContaining(['Characters', 'Maps to get started']));
    const characters = top.folders.find((f: any) => f.name === 'Characters');
    expect(names(characters.folders)).toEqual(
      expect.arrayContaining(['Beastkin', 'Elves', 'Undetermined / Unknown']),
    );
    const withAssets = await call('browse_asset_tree', {
      folder: 'Characters / Beastkin / Qishen / Mehrana al-Khalid',
      depth: 0,
      includeAssets: true,
      assetsPerFolder: 5,
    });
    expect(withAssets.body.folder).toMatchObject({
      name: 'Mehrana al-Khalid',
      assetCount: 12,
      assetsShown: 5,
    });
    expect(withAssets.body.folder.assets[0]).toMatchObject({ type: 'IMAGE' });
    expect(withAssets.body.path).toBe('Characters / Beastkin / Qishen / Mehrana al-Khalid');
  });
  it('resolves folders by id, name and path, and lists ambiguity', async () => {
    const byName = await call('browse_asset_tree', { folder: 'Qishen', depth: 0 });
    expect(byName.body.folder.name).toBe('Qishen');
    const amb = await call('browse_asset_tree', { folder: 'Characters' });
    expect(amb.body.error.code).toBe('AMBIGUOUS'); // the library has a "Characters" at the top and one in the recovery folder
    expect(amb.body.error.candidates.map((x: any) => x.path).sort()).toEqual([
      'Characters',
      'Recovery originals 2026-11 / Characters',
    ]);
    expect((await call('browse_asset_tree', { folder: 'Nope' })).body.error.code).toBe('NOT_FOUND');
    const id = amb.body.error.candidates.find((x: any) => x.path === 'Characters').id;
    expect((await call('browse_asset_tree', { folder: id, depth: 0 })).body.folder.name).toBe('Characters');
  });
  it('list_assets pages a folder, with sizes where known, dimensions and urls', async () => {
    const r = await call('list_assets', { folder: 'Foxians', limit: 8 });
    expect(r.body).toMatchObject({ total: 20, count: 8, offset: 0, nextOffset: 8 });
    expect(r.body.assets[0]).toMatchObject({ name: 'Foxian 001', type: 'IMAGE' });
    expect(r.body.assets[0].url).toMatch(/^https:\/\/assets\.legendkeeper\.com\//);
    const next = await call('list_assets', { folder: 'Foxians', limit: 8, offset: 16 });
    expect(next.body).toMatchObject({ count: 4, nextOffset: null });
    expect((await call('list_assets', { folder: 'Foxians', type: 'MAP' })).body.total).toBe(0);
  });
});

describe('the guides', () => {
  it('get_bridge_guide and get_markdown_guide return the guides, whole or by section', async () => {
    const bridge = await call('get_bridge_guide');
    expect(bridge.body.markdown).toMatch(/^# The LK-Bridge guide for agents/);
    const sec = await call('get_bridge_guide', { section: 'Budget rules' });
    expect(sec.body.markdown).toMatch(/^## Budget rules/);
    expect(sec.body.markdown).not.toMatch(/Proposals and the owner/);
    const md = await call('get_markdown_guide');
    expect(md.body.markdown).toMatch(/^# Writing LegendKeeper pages in Markdown/);
    const keep = await call('get_markdown_guide', { section: 'Keep regions' });
    expect(keep.body.markdown).toMatch(/^## Keep regions/);
    const bad = await call('get_markdown_guide', { section: 'No such heading' });
    expect(bad.body.error.code).toBe('SECTION_NOT_FOUND');
    expect(bad.body.error.headings).toContain('Writing LegendKeeper pages in Markdown > Keep regions');
  });
  it('are also published as MCP resources', async () => {
    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      'lk-bridge://guides/bridge',
      'lk-bridge://guides/markdown',
    ]);
    const read = await c.readResource({ uri: 'lk-bridge://guides/bridge' });
    expect((read.contents[0] as { text: string }).text).toMatch(/^# The LK-Bridge guide for agents/);
    expect(resources.every((r) => r.mimeType === 'text/markdown')).toBe(true);
  });
  it('the server instructions are short and point to the bridge guide', () => {
    const ins = c.getInstructions()!;
    expect(ins.length).toBeLessThan(1500);
    expect(ins).toMatch(/get_bridge_guide/);
  });
});

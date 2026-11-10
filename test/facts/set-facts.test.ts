/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- parsed JSON tool results */
/**
 * set_facts (v2 C2a) end to end through the REAL server and the official MCP client at scope `write`: every fact case,
 * every link case, an unknown template, an empty plan and a dry run; the compare-and-swap inside the lock, the chained
 * versions and the verify step (matching, and a mangled write); the journal and the tree.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { CORE_TEMPLATE, factsWorld, kvText, P, SidebarModel, type FactsWorld } from './world.js';

let w: FactsWorld;
let client: Client;
const call = (args: Record<string, unknown>) => w.stack.call(client, 'set_facts', args);
const sb = () => w.sidebars;
const lk = (method: string, re: RegExp) =>
  sb().requests.filter((r) => r.method === method && re.test(r.path));
let mark = 0;
const since = () => sb().requests.slice(mark);

beforeAll(async () => {
  w = await factsWorld();
  client = await w.stack.connect();
});
afterAll(async () => w.close());
beforeEach(() => {
  mark = sb().requests.length;
  sb().mangle = null;
});

describe('set_facts: facts', () => {
  it('changes a fact in place: one read to plan, the check in the lock, one write with If-Match, the verify read', async () => {
    const r = await call({ page: '[BSRC] Asagiri Miyabi', facts: { notes: 'Second notes' } });
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      verified: true,
      page: { id: P.miyabi, name: 'Asagiri Miyabi' },
      property: 'PROPERTIES',
      facts: { changed: [{ key: 'Notes', before: 'First notes', after: 'Second notes' }] },
    });
    expect(r.footer).toMatch(/^budget \(test\)/);
    // The existing row keeps its key, its id and its place.
    const rows = sb().rows(P.miyabi);
    expect(rows.find((x) => x.key === 'Notes')).toMatchObject({ id: 'kvmiya01r8', text: 'Second notes' });
    expect(
      since().map((x) => `${x.method} ${x.path.replace(/\/$/, '')}${x.ifMatch ? ` [${x.ifMatch}]` : ''}`),
    ).toEqual([
      'GET /resources/miyabi01/properties',
      'GET /resources/miyabi01/properties/kvmiya01/rows',
      'PATCH /resources/miyabi01/properties/kvmiya01/rows/kvmiya01r8 [v1]',
      'GET /resources/miyabi01', // verify
      'GET /resources/miyabi01', // the tree's one re-read
    ]);
  });

  it('removes a fact with null; a key that is not there is reported, not refused', async () => {
    const r = await call({ page: P.miyabi, facts: { Notes: null, 'No Such Key': null } });
    expect(r.body).toMatchObject({
      status: 'written',
      verified: true,
      facts: { removed: [{ key: 'Notes', before: 'Second notes' }], notPresent: ['No Such Key'] },
    });
    expect(kvText(sb().rows(P.miyabi))).not.toContain('Notes=Second notes');
  });

  it('adds a template fact in template order (the middle), a non-template fact at the bottom', async () => {
    // Mehrana: Reference Type, Status, Scope, Notes; the template: Reference Type, Subject, Race / Species, Status,
    // Continuity Type, Continuity, Scope, Canonical Display Name.
    const r = await call({ page: P.mehrana, facts: { 'Continuity Type': 'AU', 'Favourite Food': 'Dates' } });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(
      sb()
        .rows(P.mehrana)
        .map((x) => x.key),
    ).toEqual(['Reference Type', 'Status', 'Continuity Type', 'Scope', 'Notes', 'Favourite Food']);
    // The template was read once (and cached for a day).
    expect(lk('GET', new RegExp(`/resources/${CORE_TEMPLATE}/properties`))).toHaveLength(1);
    const posts = lk('POST', /\/rows\/?$/).slice(-2);
    expect(posts[0]!.body).toMatchObject({ key: 'Continuity Type', after: 'kvmehr01r2' });
    expect(posts[1]!.body).not.toHaveProperty('after');
  });

  it('adds several template facts with one anchor in template order, and the last template fact before the extras', async () => {
    const r = await call({
      page: P.mehrana,
      facts: {
        'Race / Species': 'Qishen',
        Subject: 'Mehrana al-Khalid',
        'Canonical Display Name': 'Mehrana',
      },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(
      sb()
        .rows(P.mehrana)
        .map((x) => x.key),
    ).toEqual([
      'Reference Type',
      'Subject',
      'Race / Species',
      'Status',
      'Continuity Type',
      'Scope',
      'Canonical Display Name',
      'Notes',
      'Favourite Food',
    ]);
    // Cached: no second read of the template.
    expect(since().filter((x) => x.path.includes(CORE_TEMPLATE))).toHaveLength(0);
  });

  it('adds the first template fact before its nearest following one (a recorded template)', async () => {
    sb().page('kumi0001', [
      SidebarModel.kv('kvkumi01', 'PROPERTIES', [
        ['Status', 'Outline'],
        ['Notes', 'x'],
      ]),
    ]);
    w.stack.db
      .prepare('UPDATE tree_nodes SET template_id = ? WHERE project_id = ? AND id = ?')
      .run(CORE_TEMPLATE, PROJECT, 'kumi0001');
    const r = await call({
      page: 'Kumi the Elder',
      facts: { 'Reference Type': 'Compact Character Reference' },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(
      sb()
        .rows('kumi0001')
        .map((x) => x.key),
    ).toEqual(['Reference Type', 'Status', 'Notes']);
    expect(lk('POST', /kvkumi01\/rows\/?$/)[0]!.body).toMatchObject({ before: 'kvkumi01r1' });
  });

  it('puts a new fact at the bottom with a note when the template cannot be determined', async () => {
    const r = await call({ page: 'ashg0001', facts: { Population: '4,000' } });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(r.body.notes.join(' ')).toMatch(/template could not be determined/);
    expect(
      sb()
        .rows(P.ashgate)
        .map((x) => x.key),
    ).toEqual(['Reference Type', 'Scope', 'Population']);
  });

  it('converts inline Markdown: marks and a [[mention]] resolved inside the repository', async () => {
    const r = await call({
      page: P.miyabi,
      facts: { Title: { markdown: '**Head** maiden, *sister* of [[Asagiri Kaede]]' } },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    const p = sb().pages.get(P.miyabi)!.props[0]!;
    const row = p.rows!.find((x) => x.key === 'Title')!;
    expect(row.content).toEqual([
      { text: 'Head', bold: true },
      { text: ' maiden, ' },
      { text: 'sister', italic: true },
      { text: ' of ' },
      { mention: { resourceId: 'kaede001' } },
    ]);
    // A plain string is plain text, exactly: no Markdown is read into it.
    await call({ page: P.miyabi, facts: { Title: '**not bold** [[not a mention]]' } });
    expect(
      sb()
        .pages.get(P.miyabi)!
        .props[0]!.rows!.find((x) => x.key === 'Title')!.content,
    ).toEqual([{ text: '**not bold** [[not a mention]]' }]);
  });

  it('refuses an ambiguous or unknown mention, and block Markdown, before reading anything', async () => {
    const amb = await call({ page: P.miyabi, facts: { Home: { markdown: 'Lives in [[Ashgate]]' } } });
    expect(amb.body.error).toMatchObject({ code: 'MENTION_AMBIGUOUS', key: 'Home' });
    expect(JSON.stringify(amb.body.error)).toMatch(/ashg0001/);
    const none = await call({ page: P.miyabi, facts: { Home: { markdown: '[[Nowhere At All]]' } } });
    expect(none.body.error).toMatchObject({ code: 'MENTION_NOT_FOUND' });
    const block = await call({ page: P.miyabi, facts: { Home: { markdown: '# A heading' } } });
    expect(block.body.error).toMatchObject({ code: 'FACT_VALUE_NOT_INLINE' });
    expect(since()).toHaveLength(0);
  });

  it('writes nothing for an empty plan, and a dry run shows the plan and writes nothing', async () => {
    const same = await call({ page: P.miyabi, facts: { Status: 'Outline' } });
    expect(same.body).toMatchObject({ status: 'no_change', facts: { unchanged: ['Status'] } });
    const dry = await call({
      page: P.miyabi,
      facts: { Scope: 'Shrine maiden', Mood: 'Calm' },
      links: { Dependencies: { add: ['Mehrana al-Khalid'] } },
      dryRun: true,
    });
    expect(dry.body, dry.text).toMatchObject({
      status: 'dry_run',
      facts: { changed: [{ key: 'Scope' }], added: [{ key: 'Mood', value: 'Calm' }] },
      links: { Dependencies: { added: ['Mehrana al-Khalid'] } },
    });
    expect(dry.body.writes).toEqual(['Scope: changed', 'Mood: added', 'Dependencies: 1 added']);
    expect(since().filter((x) => x.method !== 'GET')).toHaveLength(0);
    expect(since().filter((x) => x.method === 'GET').length).toBeLessThanOrEqual(3);
  });

  it('refuses duplicated keys, a missing property, and names a property that exists', async () => {
    const dup = await call({ page: P.miyabi, facts: { Status: 'A', status: 'B' } });
    expect(dup.body.error.code).toBe('INVALID_FACTS');
    const prop = await call({ page: P.miyabi, facts: { X: 'y' }, property: 'NOT THERE' });
    expect(prop.body.error).toMatchObject({ code: 'FACTS_PROPERTY_NOT_FOUND', available: ['PROPERTIES'] });
  });
});

describe('set_facts: links', () => {
  it('adds pages and a document link at the end, reports what is already linked, keeps ids, order and the filter', async () => {
    const before = sb().items(P.miyabi, 'Dependencies');
    const filter = structuredClone(sb().pages.get(P.miyabi)!.props[1]!.filter);
    const r = await call({
      page: P.miyabi,
      links: {
        Dependencies: {
          add: [
            'Mehrana al-Khalid',
            'Asagiri Kaede',
            { page: 'Fourth Age - Table', document: 'Main' },
            { page: 'Fourth Age - Timeline', document: 'Fourth Age - Timeline' },
          ],
        },
      },
    });
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      verified: true,
      links: {
        Dependencies: {
          added: ['Mehrana al-Khalid', 'Fourth Age - Timeline / Fourth Age - Timeline'],
          alreadyLinked: ['Asagiri Kaede', 'Fourth Age - Table / Main'],
        },
      },
    });
    const after = sb().items(P.miyabi, 'Dependencies');
    expect(after.slice(0, 2)).toEqual(before);
    expect(after.slice(2).map((i) => [i.resourceId, i.documentId ?? null])).toEqual([
      ['mehran01', null],
      ['age4tl01', w.docs.timeline],
    ]);
    expect(sb().pages.get(P.miyabi)!.props[1]!.filter).toEqual(filter);
    // ONE updateProperty with the full list; the filter is never sent; existing items keep id and rank.
    const patch = lk('PATCH', /properties\/depmiya1\/?$/).at(-1)!;
    expect(patch.body).not.toHaveProperty('filter');
    expect((patch.body as { items: unknown[] }).items.slice(0, 2)).toEqual(
      before.map((i) => ({
        id: i.id,
        rank: i.rank,
        resourceId: i.resourceId,
        ...(i.documentId ? { documentId: i.documentId } : {}),
      })),
    );
  });

  it('removes by page (every item of it) and by document; a page not linked is reported', async () => {
    const r = await call({
      page: P.miyabi,
      links: {
        Dependencies: {
          remove: ['Asagiri Kaede', { page: 'Fourth Age - Timeline', document: 'Fourth Age - Timeline' }],
        },
        'related sources': { remove: ['Asagiri Kaede'] },
      },
    });
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      verified: true,
      links: {
        Dependencies: { removed: ['Asagiri Kaede', 'Fourth Age - Timeline / Fourth Age - Timeline'] },
        'Related Sources': { notLinked: ['Asagiri Kaede'] },
      },
    });
    expect(
      sb()
        .items(P.miyabi, 'Dependencies')
        .map((i) => i.resourceId),
    ).toEqual(['age40001', 'mehran01']);
  });

  it('works on a resourceLink collection too', async () => {
    const r = await call({ page: P.miyabi, links: { 'Related Sources': { add: ['Inae Mikumo'] } } });
    expect(r.body).toMatchObject({ status: 'written', verified: true });
    expect(
      sb()
        .items(P.miyabi, 'Related Sources')
        .map((i) => i.resourceId),
    ).toEqual(['mehran01', 'inae0001']);
  });

  it('refuses an unknown or duplicated collection, a page outside the repository, and a missing document', async () => {
    const none = await call({ page: P.miyabi, links: { Allies: { add: ['Asagiri Kaede'] } } });
    expect(none.body.error).toMatchObject({ code: 'LINK_COLLECTION_NOT_FOUND' });
    expect(none.body.error.available).toEqual(['Dependencies', 'Related Sources']);
    sb().outside(P.miyabi, (s) =>
      s.props.push({ ...SidebarModel.links('dup00001', 'Dependencies', []), rank: 'r99999999' }),
    );
    const dup = await call({ page: P.miyabi, links: { Dependencies: { add: ['Asagiri Kaede'] } } });
    expect(dup.body.error).toMatchObject({ code: 'LINK_COLLECTION_AMBIGUOUS' });
    sb().outside(P.miyabi, (s) => (s.props = s.props.filter((p) => p.id !== 'dup00001')));
    const outside = await call({ page: P.miyabi, links: { Dependencies: { add: ['outside1'] } } });
    expect(outside.body.error).toMatchObject({ code: 'NOT_IN_REPOSITORY' });
    const doc = await call({
      page: P.miyabi,
      links: { Dependencies: { add: [{ page: 'Asagiri Kaede', document: 'Appendix' }] } },
    });
    expect(doc.body.error).toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  });
});

describe('set_facts: the compare-and-swap inside the lock, chained versions, verify', () => {
  it('chains each write’s new version into the next If-Match', async () => {
    const v = sb().pages.get(P.mehrana)!.version;
    const r = await call({
      page: P.mehrana,
      facts: { Status: 'Draft', Scope: 'Qishen scholar of the Archive', Notes: null, Mood: 'Stern' },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    const writes = since().filter((x) => x.method !== 'GET');
    expect(writes.map((x) => `${x.method} ${x.ifMatch}`)).toEqual([
      `PATCH v${v}`,
      `PATCH v${v + 1}`,
      `POST v${v + 2}`,
      `DELETE v${v + 3}`,
    ]);
  });

  it('two removals: the second, with no version to chain from, reads in the lock and checks the rows first', async () => {
    const v0 = sb().pages.get(P.mehrana)!.version;
    const r = await call({ page: P.mehrana, facts: { Mood: null, 'Favourite Food': null } });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    const lines = since().map(
      (x) =>
        `${x.method} ${x.path.replace(/\/$/, '').split('/').slice(-2).join('/')}${x.ifMatch ? ` [${x.ifMatch}]` : ''}`,
    );
    expect(lines.filter((l) => l.startsWith('DELETE'))).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith('DELETE'))[0]).toMatch(new RegExp(`\\[v${v0}\\]$`));
    expect(lines.filter((l) => l.startsWith('DELETE'))[1]).toMatch(new RegExp(`\\[v${v0 + 1}\\]$`));
  });

  it('a change made after the plan read, before the lock, is a conflict: nothing is written', async () => {
    sb().after(/^GET \/resources\/miyabi01\/properties\/?$/, 0, () =>
      sb().outside(P.miyabi, (s) => {
        s.props[0]!.rows!.find((x) => x.key === 'Scope')!.content = [{ text: 'Changed in the app' }];
      }),
    );
    const r = await call({ page: P.miyabi, facts: { Status: 'Draft' } });
    expect(r.body.error, r.text).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(r.body.error.hint).toMatch(/Nothing was written/);
    expect(since().filter((x) => x.method !== 'GET')).toHaveLength(0);
    expect(kvText(sb().rows(P.miyabi))).toContain('Status=Outline');
  });

  it('a collection that changed before its write (in the lock) is a conflict too, before any write', async () => {
    sb().after(/^GET \/resources\/miyabi01\/properties\/?$/, 0, () =>
      sb().outside(P.miyabi, (s) => s.props[1]!.items!.pop()),
    );
    const r = await call({
      page: P.miyabi,
      facts: { Status: 'Draft' },
      links: { Dependencies: { add: ['Inae Mikumo'] } },
    });
    expect(r.body.error, r.text).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(since().filter((x) => x.method !== 'GET')).toHaveLength(0);
  });

  it('a write LegendKeeper stores differently is "written but not as planned", recorded and never retried', async () => {
    sb().mangle = (req, s) => {
      if (req.method === 'PATCH')
        s.props[0]!.rows!.find((x) => x.key === 'Status')!.content = [{ text: 'Mangled' }];
    };
    const r = await call({ page: P.miyabi, facts: { Status: 'Draft' } });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: false });
    expect(r.body.warning).toMatch(/written but not as planned/);
    expect(JSON.stringify(r.body.verification)).toMatch(/Mangled/);
    expect(since().filter((x) => x.method === 'PATCH')).toHaveLength(1);
    const errs = w.stack.runtime.engine.queries.listErrors(PROJECT, { limit: 5 });
    expect(errs.some((e) => e.code === 'VERIFY_MISMATCH' && e.jobId === r.body.jobId)).toBe(true);
    const job = w.stack.runtime.engine.queries.getJob(PROJECT, String(r.body.jobId))!;
    expect(job.result).toMatchObject({ verified: false, verification: { status: 'mismatch' } });
  });

  it('journals every write with the high-level operation, the property’s pre-image on the first', async () => {
    const r = await call({ page: P.miyabi, facts: { Status: 'Outline', Mood: 'Calm' } });
    expect(r.body.status, r.text).toBe('written');
    const entries = w.stack.runtime.engine.queries
      .journalLookup(PROJECT, { jobId: r.body.jobId, includePreImage: true })
      .sort((a, b) => (a.stepNo ?? 0) - (b.stepNo ?? 0));
    expect(entries.map((e) => e.opId)).toEqual(['updatePropertyRow', 'createPropertyRow']);
    expect(entries[0]!.operation).toMatchObject({
      tool: 'set_facts',
      page: { id: P.miyabi },
      property: 'PROPERTIES',
    });
    expect(JSON.stringify(entries[0]!.preImage)).toMatch(/"Status"/);
    expect(entries.every((e) => e.outcome === 'applied')).toBe(true);
  });

  it('the tree follows: a changed Reference Type and Scope show in the tree after one re-read', async () => {
    const r = await call({ page: P.ashgate, facts: { Scope: 'A walled town on the river' } });
    expect(r.body.status, r.text).toBe('written');
    const node = w.stack.runtime.tree.queries.node(PROJECT, P.ashgate).data!;
    expect(node.scope).toBe('A walled town on the river');
  });
});

describe('set_facts: versions, capture and holds', () => {
  it('a version on listProperties (if LegendKeeper gives one) is never sent as a row write’s If-Match', async () => {
    sb().propertyVersions = true;
    try {
      const v = sb().pages.get(P.ashgate)!.version;
      const r = await call({ page: P.ashgate, facts: { Scope: 'A walled town by the ford' } });
      expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
      expect(
        since()
          .filter((x) => x.method === 'PATCH')
          .map((x) => x.ifMatch),
      ).toEqual([`v${v}`]);
    } finally {
      sb().propertyVersions = false;
    }
  });

  it('a proposal reads each property once to capture it, however many writes touch it', async () => {
    const proposer = await w.stack.connect(w.stack.newToken('facts-capture', 'propose').token);
    const r = await w.stack.call(proposer, 'set_facts', {
      page: P.mehrana,
      facts: { Status: 'Draft', Scope: 'Archivist', Notes: 'x', Region: 'North' },
    });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured' });
    expect(
      lk('GET', /mehran01\/properties\/kvmehr01\/rows\/?$/).filter((x) => sb().requests.indexOf(x) >= mark),
    ).toHaveLength(1);
    expect(since().filter((x) => x.method !== 'GET')).toHaveLength(0);
  });

  it('while writes are paused it answers at once that the change is queued, and it runs when they resume', async () => {
    const engine = w.stack.runtime.engine;
    engine.controls.pauseWrites('test');
    let jobId: string;
    try {
      const started = Date.now();
      const r = await call({ page: P.ashgate, facts: { Scope: 'Paused and resumed' } });
      expect(r.body, r.text).toMatchObject({ status: 'queued' });
      expect(Date.now() - started).toBeLessThan(5000);
      jobId = String(r.body.jobId);
      expect(since().filter((x) => x.method !== 'GET')).toHaveLength(0);
    } finally {
      engine.controls.resumeWrites('test');
    }
    const job = await engine.wait(PROJECT, jobId, 10_000);
    expect(job.status).toBe('succeeded');
    expect(
      sb()
        .rows(P.ashgate)
        .find((x) => x.key === 'Scope')!.text,
    ).toBe('Paused and resumed');
  });
});

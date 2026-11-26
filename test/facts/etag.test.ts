/**
 * Versions from the ETag (v2 D1.1, ADR 0039; sandbox B12 and B13). The test world's LegendKeeper answers a property row
 * write with no version in the body but an `ETag` header (a delete answers 204 with one too). The bridge uses that ETag
 * (unquoted) as the write's new version for the next chained If-Match, so a chained row write no longer reads the
 * property again; with neither a body version nor an ETag it still reads (the safe fallback); and the project setting
 * `useEtagVersions` switches the ETag off without a deploy.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { factsWorld, P, type FactsWorld } from './world.js';

let w: FactsWorld;
let client: Client;
const sb = () => w.sidebars;
let mark = 0;
const since = () => sb().requests.slice(mark);
const reads = () => since().filter((x) => x.method === 'GET').length;
const writes = () => since().filter((x) => x.method !== 'GET');

/** Mehrana's PROPERTIES as the world seeds them, whatever earlier runs did. */
function reset() {
  sb().outside(P.mehrana, (s) => {
    s.props[0]!.rows = [
      ['Reference Type', 'Character Core'],
      ['Status', 'Outline'],
      ['Scope', 'Qishen scholar'],
      ['Notes', 'Loose'],
    ].map(([key, text], i) => ({
      id: `kvmehr01r${i + 1}`,
      rank: `r${((i + 1) * 100).toString(36).padStart(8, '0')}`,
      key: key!,
      content: [{ text: text! }],
    }));
  });
  mark = sb().requests.length;
}

/** A change, an addition and a removal in one call: PATCH, PATCH, POST, DELETE. */
const run = () =>
  w.stack.call(client, 'set_facts', {
    page: P.mehrana,
    facts: { Status: 'Draft', Scope: 'Qishen scholar of the Archive', Notes: null, Mood: 'Stern' },
  });

const setting = (value: boolean | null) =>
  w.stack.runtime.projects.setSetting(PROJECT, 'useEtagVersions', value);

beforeAll(async () => {
  w = await factsWorld();
  client = await w.stack.connect();
});
afterAll(async () => w.close());
beforeEach(() => {
  setting(null);
  sb().rowVersions = 'body';
  reset();
});

describe('the ETag as the version of the next chained write', () => {
  it('body version (the spec): the chain and its reads, the baseline', async () => {
    const v = sb().pages.get(P.mehrana)!.version;
    const r = await run();
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(writes().map((x) => `${x.method} ${x.ifMatch}`)).toEqual([
      `PATCH v${v}`,
      `PATCH v${v + 1}`,
      `POST v${v + 2}`,
      `DELETE v${v + 3}`,
    ]);
    // plan (listProperties), the check (listPropertyRows), verify, the tree's one re-read; the DELETE answers 204 in
    // this mode, but the chain stopped needing a read before it (the POST's body version).
    console.log(`set_facts, version in the body: ${reads()} reads, ${writes().length} writes`);
  });

  it('ETag only (what LegendKeeper does): the same chain with the same reads, the ETag unquoted', async () => {
    sb().rowVersions = 'body';
    const base = await run();
    expect(base.body.status, base.text).toBe('written');
    const baseline = reads();

    reset();
    sb().rowVersions = 'etag';
    const v = sb().pages.get(P.mehrana)!.version;
    const r = await run();
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(writes().map((x) => `${x.method} ${x.ifMatch}`)).toEqual([
      `PATCH v${v}`,
      `PATCH v${v + 1}`,
      `POST v${v + 2}`,
      `DELETE v${v + 3}`,
    ]);
    expect(reads()).toBe(baseline);
    console.log(`set_facts, version in the ETag: ${reads()} reads, ${writes().length} writes`);
  });

  it('with the ETag a chained addition saves its in-lock read; with neither a body version nor an ETag the bridge re-reads, correctly', async () => {
    sb().rowVersions = 'etag';
    const withEtag = await run();
    expect(withEtag.body.status, withEtag.text).toBe('written');
    const etagReads = reads();

    // Neither a body version nor an ETag: the fallback reads the property inside the lock before each chained write.
    reset();
    sb().rowVersions = 'none';
    const v = sb().pages.get(P.mehrana)!.version;
    const without = await run();
    expect(without.body, without.text).toMatchObject({ status: 'written', verified: true });
    expect(writes().map((x) => `${x.method} ${x.ifMatch}`)).toEqual([
      `PATCH v${v}`,
      `PATCH v${v + 1}`,
      `POST v${v + 2}`,
      `DELETE v${v + 3}`,
    ]);
    const noneReads = reads();
    // Four row writes: the first chains from the check. v3 F12 (ADR 0081, op-meta): a row change reads the row for its
    // journal pre-image either way, and that read gives the next write its version too, so only the addition after it
    // reads inside the lock without an ETag; the DELETE reads for its journal pre-image either way.
    expect(noneReads - etagReads).toBe(1);
    console.log(`set_facts, four row writes: ${etagReads} reads with the ETag, ${noneReads} without`);
  });

  it('a typical set_facts (two facts changed): 5 reads and 2 writes, with a version in the body, an ETag or neither', async () => {
    const two = () =>
      w.stack.call(client, 'set_facts', {
        page: P.mehrana,
        facts: { Status: 'Draft', Scope: 'Qishen scholar of the Archive' },
      });
    const counts: Record<string, [number, number]> = {};
    for (const mode of ['body', 'etag', 'none'] as const) {
      reset();
      sb().rowVersions = mode;
      const r = await two();
      expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
      counts[mode] = [reads(), writes().length];
    }
    // The template's keys were cached by earlier runs; each count is plan, check, verify and the tree's re-read, plus
    // (v3 F12, op-meta) the second change's read for its journal pre-image, which also gives it its version, so a
    // missing version costs nothing more here.
    expect(counts.body).toEqual([5, 2]);
    expect(counts.etag).toEqual([5, 2]);
    expect(counts.none).toEqual([5, 2]);
  });

  it('a delete’s 204 ETag chains one removal to the next; a removal reads for its pre-image either way', async () => {
    sb().outside(P.mehrana, (s) => {
      s.props[0]!.rows!.push(
        { id: 'xtra0001', rank: 'r000000zz', key: 'Mood', content: [{ text: 'Calm' }] },
        { id: 'xtra0002', rank: 'r000000zzz', key: 'Favourite Food', content: [{ text: 'Dates' }] },
      );
    });
    mark = sb().requests.length;
    sb().rowVersions = 'etag';
    const v = sb().pages.get(P.mehrana)!.version;
    const r = await w.stack.call(client, 'set_facts', {
      page: P.mehrana,
      facts: { Mood: null, 'Favourite Food': null },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(writes().map((x) => `${x.method} ${x.ifMatch}`)).toEqual([`DELETE v${v}`, `DELETE v${v + 1}`]);
    const withEtag = reads();

    sb().outside(P.mehrana, (s) => {
      s.props[0]!.rows!.push(
        { id: 'xtra0003', rank: 'r000000zy', key: 'Mood', content: [{ text: 'Calm' }] },
        { id: 'xtra0004', rank: 'r000000zyy', key: 'Favourite Food', content: [{ text: 'Dates' }] },
      );
    });
    mark = sb().requests.length;
    sb().rowVersions = 'none';
    const r2 = await w.stack.call(client, 'set_facts', {
      page: P.mehrana,
      facts: { Mood: null, 'Favourite Food': null },
    });
    expect(r2.body.status, r2.text).toBe('written');
    // The second DELETE reads the row for its journal pre-image whether or not a version was chained.
    expect(reads()).toBe(withEtag);
    const lines = writes().map((x) => `${x.method} ${x.ifMatch}`);
    expect(lines).toHaveLength(2);
  });

  it('useEtagVersions off: the ETag is ignored and the bridge reads again, correctly', async () => {
    sb().rowVersions = 'etag';
    setting(true);
    const on = await run();
    expect(on.body.status, on.text).toBe('written');
    const onReads = reads();

    reset();
    setting(false);
    const v = sb().pages.get(P.mehrana)!.version;
    const off = await run();
    expect(off.body, off.text).toMatchObject({ status: 'written', verified: true });
    expect(writes().map((x) => `${x.method} ${x.ifMatch}`)).toEqual([
      `PATCH v${v}`,
      `PATCH v${v + 1}`,
      `POST v${v + 2}`,
      `DELETE v${v + 3}`,
    ]);
    // As without an ETag above: only the addition reads again (v3 F12, op-meta).
    expect(reads() - onReads).toBe(1);
  });

  it('the setting defaults to on and is editable as a project setting', () => {
    expect(w.stack.runtime.projects.setSetting(PROJECT, 'useEtagVersions', false)).toBeDefined();
    setting(null);
  });

  it('an ETag does not stand in for a write LegendKeeper does not version (updateProperty)', async () => {
    // A link collection's write is never versioned: its answer is not a version, so nothing is chained from it.
    sb().rowVersions = 'etag';
    const r = await w.stack.call(client, 'set_facts', {
      page: P.mehrana,
      facts: { Status: 'Draft' },
      links: { Dependencies: { add: ['Inae Mikumo'] } },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written' });
    const put = writes().find((x) => /\/properties\/depmehr1\/?$/.test(x.path))!;
    expect(put.ifMatch).toBeUndefined();
  });
});

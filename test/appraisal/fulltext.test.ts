/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F3c, A1 (ADR 0054): the full-text index over the snapshots and the `search` tool's `content: true` on it. Against
 * the mock LegendKeeper and the appraisal world's fixtures; nothing is fetched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ftsQueryOf } from '../../src/appraisal/fts.js';
import { parseQuery, positiveTerms, textTerms } from '../../src/discover/search.js';
import { appraisalWorld, C, O, P, PROJECT, type AppraisalWorld } from './world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: AppraisalWorld;
beforeAll(async () => {
  w = await appraisalWorld();
  await w.snapshot();
});
afterAll(async () => w?.close());

const search = (query: string, more: Record<string, unknown> = {}) =>
  w.call('search', { query, content: true, project: 'test', limit: 100, ...more });
const ids = (r: { body: any }) => (r.body.results as any[]).map((x) => x.id as string);

describe('the index', () => {
  it('is built from the full snapshot by its own hook, and states its snapshots, size and timings', () => {
    const st = w.stack.runtime.appraisal.index.state(PROJECT)!;
    const full = w.stack.runtime.snapshots.index.snapshots(PROJECT, { kind: 'full', limit: 1 })[0]!;
    expect(st.baseSnapshotId).toBe(full.id);
    expect(st.newestSnapshotId).toBe(full.id);
    expect(st.changes).toBe(0);
    expect(st.pages).toBe(full.pages);
    expect(st.units).toBeGreaterThan(st.pages); // names, facts and blocks
    expect(st.refs).toBeGreaterThan(0);
    expect(st.sizeBytes).toBeGreaterThan(0);
    expect(st.buildMs).toBeGreaterThanOrEqual(0);
  });
});

describe('search with content: true', () => {
  it('finds a page by a phrase in its text, with its document, section path and a snippet, and says how fresh it is', async () => {
    const before = w.requests();
    const r = await search('"opens the reading room"');
    expect(r.isError, r.text).toBe(false);
    expect(ids(r)).toEqual([P.fourthAge]);
    const hit = r.body.results[0];
    expect(hit).toMatchObject({
      foundBy: 'page text',
      lifecycle: 'Authoritative',
      branch: 'Universal Chronology Desk',
    });
    expect(hit.text[0]).toMatchObject({ document: w.mainOf(P.fourthAge), section: 'Purpose', unit: 'row' });
    expect(hit.text[0].snippet).toContain('«opens the reading room»');
    expect(r.body.content).toMatchObject({ searched: true });
    expect(r.body.content.index.base.id).toBe(w.stack.runtime.appraisal.index.state(PROJECT)!.baseSnapshotId);
    expect(r.body.content.index.age).toMatch(/s$|min$/);
    expect(r.body.content.note).toMatch(/complete as of the newest snapshot/);
    // Free: no request to LegendKeeper at all (no GET /search).
    expect(w.requests()).toEqual(before);
  });

  it('honours a word as the start of a word, a phrase exactly, and the sidebar facts and aliases', async () => {
    expect(ids(await search('catalogu'))).toContain(O.qasr); // "catalogued"
    expect(ids(await search('"catalogued the emirate"'))).toEqual([O.qasr]);
    expect(ids(await search('"catalogued emirate"'))).toEqual([]);
    // A fact's value (Temporal Scope) and an alias.
    expect(ids(await search('"5A 880"'))).toEqual([C.nadira]);
    const alias = await search('"Mehrana al-Khalid"');
    expect(ids(alias)).toEqual(expect.arrayContaining([C.mehrana1, C.mehrana2]));
  });

  it('applies OR, NOT and brackets to the text of whole pages', async () => {
    const either = ids(await search('"reading room" OR "charters in her youth"'));
    expect(either).toEqual(expect.arrayContaining([P.fourthAge, O.qasr]));
    // NOT excludes a page whose TEXT holds the word, not only its name.
    const all = ids(await search('merchant'));
    expect(all).toContain(P.clean);
    expect(all).toContain(P.headingLink);
    const without = ids(await search('merchant -Tarim'));
    expect(without).toContain(P.clean);
    expect(without).not.toContain(P.headingLink); // its heading's link reads "Tarim"
    const both = ids(await search('(merchant AND rivals) OR "reading room"'));
    expect(both.sort()).toEqual([P.fourthAge, P.headingLink].sort());
    // A filter still applies on the tree: only the desk's pages.
    const desk = ids(await search(`merchant under:"Appraisal Desk"`));
    expect(desk.length).toBeGreaterThan(5);
    expect(desk.every((id) => id.startsWith('ap'))).toBe(true);
  });

  it('leaves the Legacy Canon Archive and the Design References out by default; include brings each in, labelled', async () => {
    const r = await search('"tide charter"');
    expect(ids(r)).toEqual([]);
    expect(r.body.content).toMatchObject({ leftOut: 2 });
    expect(r.body.content.leftOutNote).toMatch(/include: \["legacy", "design"\]/);
    const legacy = await search('"tide charter"', { include: ['legacy'] });
    expect(ids(legacy)).toEqual([P.legacyPage]);
    expect(legacy.body.results[0]).toMatchObject({
      branch: 'Legacy Canon Archive',
      lifecycle: 'Authoritative',
    });
    const both = await search('"tide charter"', { include: ['legacy', 'design'] });
    expect(ids(both).sort()).toEqual([P.designPage, P.legacyPage].sort());
    // A name search without content is unchanged: no scope rule, no labels.
    const names = await w.call('search', { query: 'Tide Charter', project: 'test' });
    expect(ids(names)).toContain(P.legacyPage);
    expect(names.body.results[0].lifecycle).toBeUndefined();
  });

  it('labels each result by lifecycle and branch', async () => {
    const r = await search('"contradicts the Salahad chronicle"');
    expect(r.body.results[0]).toMatchObject({ id: P.hollowWorking, lifecycle: 'Working', branch: 'Working' });
  });

  it('content: "live" is LegendKeeper’s own search (one read), as before', async () => {
    const before = w.requests();
    const r = await w.call('search', { query: 'reading room', content: 'live', project: 'test' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.content).toMatchObject({ searched: true });
    expect(r.body.content.note).toMatch(/incomplete/i);
    expect(w.requests().all).toBe(before.all + 1);
  });
});

describe('updates from change snapshots', () => {
  it('a page the bridge edits is found by its new text, and no longer by its old, with no full snapshot', async () => {
    const st0 = w.stack.runtime.appraisal.index.state(PROJECT)!;
    expect(ids(await search('"toll courts"'))).toContain(P.clean);
    const r = await w.call('write_page', {
      page: P.clean,
      mode: 'replace_section',
      section: 'Overview',
      markdown: 'A merchant republic famed for its basalt lighthouse.',
      project: 'test',
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.status, r.text).toBe('written');
    // The change snapshot the job took is laid over the index at the next search.
    const found = await search('"basalt lighthouse"');
    expect(ids(found)).toEqual([P.clean]);
    expect(ids(await search('"toll courts"'))).not.toContain(P.clean);
    const st = w.stack.runtime.appraisal.index.state(PROJECT)!;
    expect(st.baseSnapshotId).toBe(st0.baseSnapshotId);
    expect(st.changes).toBe(st0.changes + 1);
    expect(st.newestTakenAt).toBeGreaterThan(st0.newestTakenAt);
    expect(st.lastUpdateMs).not.toBeNull();
    expect(found.body.content.index.changeSnapshots).toBe(st.changes);
  });

  it('a newer full snapshot rebuilds it from that snapshot', async () => {
    const before = w.stack.runtime.appraisal.index.state(PROJECT)!;
    await w.snapshot();
    const after = w.stack.runtime.appraisal.index.state(PROJECT)!;
    expect(after.baseSnapshotId).not.toBe(before.baseSnapshotId);
    expect(after.changes).toBe(0);
    expect(ids(await search('"basalt lighthouse"'))).toEqual([P.clean]);
  });
});

describe('the query parts (pure)', () => {
  it('a word is a prefix, a phrase exact; punctuation alone matches nothing', () => {
    expect(ftsQueryOf({ value: 'fox', phrase: false })).toBe('"fox"*');
    expect(ftsQueryOf({ value: 'sea gate', phrase: true })).toBe('"sea gate"');
    expect(ftsQueryOf({ value: 'say "hi"', phrase: true })).toBe('"say ""hi"""');
    expect(ftsQueryOf({ value: '—', phrase: false })).toBeNull();
  });
  it('every free-text term, and the positive ones', () => {
    const e = parseQuery('fox -"sea gate" (hollow OR court) tag:x');
    expect(textTerms(e).map((t) => t.value)).toEqual(['fox', 'sea gate', 'hollow', 'court']);
    expect(positiveTerms(e).map((t) => t.value)).toEqual(['fox', 'hollow', 'court']);
  });
});

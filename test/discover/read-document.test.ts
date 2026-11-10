/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON tool results */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverWorld, type DiscoverWorld } from './world.js';

let w: DiscoverWorld;
let c: Client;
const call = (name: string, args: Record<string, unknown> = {}) => w.stack.call(c, name, args);
const reads = (since: number) => w.seen.slice(since).filter((l) => l.startsWith('GET /resources'));

beforeAll(async () => {
  w = await discoverWorld();
  c = await w.stack.connect();
});
afterAll(() => w.close());

describe('read_document: a page', () => {
  it('returns B1’s Markdown, the document version and the keep regions, for one read', async () => {
    const before = w.seen.length;
    const r = await call('read_document', { resource: 'miyabi01' });
    expect(r.isError, r.text).toBe(false);
    expect(reads(before)).toEqual([`GET /resources/miyabi01/docs/${w.docs.miyabiMain}/blocks`]);
    expect(r.body).toMatchObject({
      format: 'markdown',
      version: 'v3',
      document: { id: w.docs.miyabiMain, name: 'Main', type: 'page' },
      page: { id: 'miyabi01', name: 'Asagiri Miyabi' },
      tree: { status: 'ready' },
    });
    expect(r.body.markdown).toMatch(/^# Asagiri Miyabi\n\nA Foxian shrine maiden\./);
    expect(r.body.markdown).toContain('## Biography\n\n### Early Life\n\nBorn on Kumikas 1st, 4A 881.');
    // The unsupported block is a keep region, listed with why Markdown cannot show it.
    expect(r.body.markdown).toContain('<!-- lk:keep id="unsup1" kind="unsupported" -->');
    expect(r.body.regions).toEqual([expect.objectContaining({ id: 'unsup1', kind: 'unsupported' })]);
    expect(r.body.blockCount).toBe(11);
  });
  it('takes the document by name or id (default "Main"), and by page name', async () => {
    const byName = await call('read_document', { resource: '[BSRC] Asagiri Miyabi', document: 'main' });
    const byId = await call('read_document', { resource: 'miyabi01', document: w.docs.miyabiMain });
    expect(byName.body.markdown).toBe(byId.body.markdown);
    const unknown = await call('read_document', { resource: 'miyabi01', document: 'Nope' });
    expect(unknown.body.error).toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    expect(unknown.body.error.documents).toEqual([{ id: w.docs.miyabiMain, name: 'Main', type: 'page' }]);
  });
  it('outline: true returns just the headings with their section paths', async () => {
    const r = await call('read_document', { resource: 'miyabi01', outline: true });
    expect(r.body.format).toBe('outline');
    expect(r.body.markdown).toBeUndefined();
    expect(r.body.headings).toEqual([
      { level: 1, text: 'Asagiri Miyabi', path: 'Asagiri Miyabi' },
      { level: 2, text: 'Biography', path: 'Asagiri Miyabi > Biography' },
      { level: 3, text: 'Early Life', path: 'Asagiri Miyabi > Biography > Early Life' },
      { level: 3, text: 'Notes', path: 'Asagiri Miyabi > Biography > Notes' },
      { level: 2, text: 'Relations', path: 'Asagiri Miyabi > Relations' },
      { level: 3, text: 'Notes', path: 'Asagiri Miyabi > Relations > Notes' },
    ]);
    expect(r.body.keepRegions).toBe(1);
  });
  it('section returns just that section, with the regions inside it', async () => {
    const r = await call('read_document', { resource: 'miyabi01', section: 'Biography > Early Life' });
    expect(r.body).toMatchObject({ section: 'Asagiri Miyabi > Biography > Early Life', level: 3 });
    expect(r.body.markdown).toBe('### Early Life\n\nBorn on Kumikas 1st, 4A 881.\n');
    expect(r.body.regions).toEqual([]);
    const whole = await call('read_document', { resource: 'miyabi01', section: 'Biography' });
    expect(whole.body.markdown).toContain('### Notes\n\nFirst notes.');
    expect(whole.body.markdown).not.toContain('Second notes.');
    const last = await call('read_document', { resource: 'miyabi01', section: 'Relations' });
    expect(last.body.regions.map((x: any) => x.id)).toEqual(['unsup1']); // the region sits at the end of that section
  });
  it('refuses a duplicate heading with the options listed, and [n] picks one', async () => {
    const dup = await call('read_document', { resource: 'miyabi01', section: 'Notes' });
    expect(dup.isError).toBe(true);
    expect(dup.body.error.code).toBe('SECTION_AMBIGUOUS');
    expect(dup.body.error.message).toMatch(/Notes \[1\].*Notes \[2\]/s);
    expect(dup.body.error.options.map((o: any) => o.path)).toEqual([
      'Asagiri Miyabi > Biography > Notes',
      'Asagiri Miyabi > Relations > Notes',
    ]);
    const pick = await call('read_document', { resource: 'miyabi01', section: 'Notes [2]' });
    expect(pick.body.markdown).toBe(
      '### Notes\n\nSecond notes.\n\n' + pick.body.markdown.split('Second notes.\n\n')[1],
    );
    expect(pick.body.markdown).toContain('Second notes.');
    expect(
      (await call('read_document', { resource: 'miyabi01', section: 'Relations > Notes' })).body.markdown,
    ).toContain('Second notes.');
    const missing = await call('read_document', { resource: 'miyabi01', section: 'Nowhere' });
    expect(missing.body.error.code).toBe('SECTION_NOT_FOUND');
    expect(missing.body.error.available.length).toBe(6);
  });
  it('format: "json" returns the raw blocks, and combining options is refused', async () => {
    const r = await call('read_document', { resource: 'miyabi01', format: 'json' });
    expect(r.body.format).toBe('json');
    expect(r.body.content.version).toBe('v3');
    expect(r.body.content.blocks[0]).toMatchObject({ id: 'mh1', kind: 'heading', level: 1 });
    expect(r.body.markdown).toBeUndefined();
    const both = await call('read_document', { resource: 'miyabi01', outline: true, section: 'Biography' });
    expect(both.body.error.code).toBe('INVALID_PARAMS');
    expect(
      (await call('read_document', { resource: 'miyabi01', format: 'json', outline: true })).isError,
    ).toBe(true);
  });
  it('refuses a page outside the root, an ambiguous name and a missing page, like every tool', async () => {
    const before = w.stack.mock.calls.length;
    expect((await call('read_document', { resource: 'outside1' })).body.error.code).toBe('NOT_IN_REPOSITORY');
    expect((await call('read_document', { resource: 'Ashgate' })).body.error.code).toBe('AMBIGUOUS');
    expect((await call('read_document', { resource: 'Nobody' })).body.error.code).toBe('NOT_FOUND');
    expect(w.stack.mock.calls.length).toBe(before);
  });
  it('says so when the document has changed under the tree (LegendKeeper answers 404)', async () => {
    w.overrides.set(/\/blocks$/, () => ({ status: 404, body: { code: 'NOT_FOUND', message: 'gone' } }));
    const r = await call('read_document', { resource: 'miyabi01' });
    w.overrides.clear();
    expect(r.body.error).toMatchObject({ code: 'LK_ERROR', status: 404 });
  });
});

describe('read_document: maps, timelines and boards', () => {
  it('renders a map with B1’s read-only renderer', async () => {
    const before = w.seen.length;
    const r = await call('read_document', { resource: 'World Maps', document: 'Arkona map' });
    expect(r.isError, r.text).toBe(false);
    expect(reads(before)).toHaveLength(1);
    expect(r.body.document.type).toBe('map');
    expect(r.body.markdown).toContain('# Map: Arkona map');
    expect(r.body.markdown).toContain(
      '- **Ashgate** (pin) at (12.5, 40.25) → [link](lk://resources/ashg0001)',
    );
    expect(r.body.markdown).toContain('- **The Weeping Sea** (region)');
    expect(r.body.regions).toEqual([]);
  });
  it('renders a timeline: lanes, then events in calendar order with formatted dates', async () => {
    const before = w.seen.length;
    const r = await call('read_document', { resource: 'Fourth Age - Timeline', document: w.docs.timeline });
    expect(r.isError, r.text).toBe(false);
    expect(reads(before)).toHaveLength(2); // the lanes, then one page of events
    expect(r.body.markdown).toContain('# Timeline: Fourth Age - Timeline');
    expect(r.body.markdown).toContain('## Historical Events');
    const lines = (r.body.markdown as string).split('\n').filter((l) => l.startsWith('- '));
    expect(lines[0]).toContain('The Long Winter'); // minute 100 before minute 200, though listed second
    expect(lines[0]).toContain('Azah 18th, 4A 1 – Kumikas 3rd, 4A 3');
    expect(lines[1]).toContain('Fall of Ashgate');
    expect(lines[1]).toContain('→ [link](lk://resources/age40001)');
  });
  it('renders a board: shapes with their text, then the connections', async () => {
    const r = await call('read_document', { resource: 'Plot Board', document: 'Plot board' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.markdown).toContain('# Board: Plot board');
    expect(r.body.markdown).toContain('- rectangle "Miyabi"');
    expect(r.body.markdown).toContain('- rectangle "Miyabi" → ellipse "Kaede" ("sisters")');
  });
  it('takes outline and section on these too, and json gives the raw API data', async () => {
    const o = await call('read_document', { resource: 'World Maps', document: 'Arkona map', outline: true });
    expect(o.body.headings).toEqual([{ level: 1, text: 'Map: Arkona map', path: 'Map: Arkona map' }]);
    const j = await call('read_document', { resource: 'World Maps', document: 'Arkona map', format: 'json' });
    expect(j.body.content.data).toHaveLength(2);
  });
  it('uses the only document when the page has none named Main, and says so', async () => {
    const r = await call('read_document', { resource: 'World Maps' });
    expect(r.body.document.name).toBe('Arkona map');
    expect(r.body.note).toMatch(/only document/);
    const several = await call('read_document', { resource: 'Plot Board' });
    expect(several.body.document).toMatchObject({ name: 'Main', type: 'page' }); // it has a Main page and the board
  });
});

describe('read_document: a large page', () => {
  it('comes back as a handle with a preview, and bridge_result_page returns every character of it', async () => {
    const r = await call('read_document', { resource: 'age40001' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.status).toBe('stored');
    expect(r.body.handle).toMatch(/^[a-z0-9]{8,}$/);
    expect(r.body.chars).toBeGreaterThan(40_000);
    expect(r.text.length).toBeLessThan(10_000); // the handle and a preview, not the page
    expect(r.body.preview.start).toContain('# Fourth Age - Table');
    expect(r.body.preview.version).toBe('v7');
    expect(r.body.preview.outline).toEqual(['Fourth Age - Table']);
    expect(r.body.tree.status).toBe('ready');
    let offset = 0;
    let text = '';
    for (let page = 0; page < 40; page++) {
      const p = await call('bridge_result_page', { handle: r.body.handle, offset });
      expect(p.isError, p.text).toBe(false);
      text += p.body.text ?? p.body.data ?? '';
      if (p.body.nextOffset === null || p.body.nextOffset === undefined) break;
      offset = p.body.nextOffset;
    }
    const whole = JSON.parse(text);
    expect(whole.markdown).toMatch(/\| Historical Event/);
    expect(whole.markdown).toContain('Event 600');
    expect(whole.version).toBe('v7');
  });
  it('an outline of the same page is small and inline', async () => {
    const r = await call('read_document', { resource: 'age40001', outline: true });
    expect(r.body.headings).toHaveLength(1);
    expect(r.text.length).toBeLessThan(2_000);
  });
});

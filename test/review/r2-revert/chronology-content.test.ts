/**
 * R2-revert, attacks (a)/(c): a chronology row and its event are compared with what the job left by their TEXT and five
 * event fields only, at the preview (src/review/revert-chronology.ts `same`, `jobEvents`) and inside the revert job's
 * lock (src/chronology/checkers.ts, ops `delete` and `replace`: `same(row, texts)`; the event check's EVENT_FIELDS).
 *
 * The owner's edits in the app that keep the words (a link on a word, bold, an event's colour or icon) are therefore
 * "nothing changed since the job", and Revert writes over them: the row the job changed is replaced whole by its old
 * block, the row and event the job added are deleted with the owner's additions. ADR 0055 B4: "A target that differs
 * from what the job left is not reverted ... An outside edit is never overwritten."
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chronologyWorld, type ChronologyWorld } from '../../chronology/world.js';
import { PROJECT, jobOf, revertAndWait, writeAgent } from './helpers.js';

type Obj = Record<string, unknown>;
let w: ChronologyWorld;
let client: Client;
const FOURTH = 'Fourth Arkonan Age';

beforeAll(async () => {
  w = await chronologyWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  client = (await writeAgent(w.stack, 'r2-chronology-agent')).client;
});
afterAll(async () => w.close());

const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const rt = () => w.stack.runtime;
const runsText = (c: unknown) =>
  (Array.isArray(c) ? (c as Obj[]) : []).map((r) => (typeof r.text === 'string' ? r.text : '')).join('');

/** The paragraph (inside the age table) whose text is `text`, as LegendKeeper stores it (not a copy). */
function paragraphWith(doc: string, text: string): Obj | null {
  const walk = (list: Obj[]): Obj | null => {
    for (const b of list) {
      if (b.kind === 'paragraph' && runsText(b.content) === text) return b;
      if (Array.isArray(b.children)) {
        const hit = walk(b.children as Obj[]);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(w.repo.blocks.get(doc)!.blocks as Obj[]);
}

/** An edit in the LegendKeeper app: the owner links a word of a row's description (same words). */
function ownerLinksAWord(doc: string, description: string, word: string): Obj[] {
  const p = paragraphWith(doc, description)!;
  expect(p, `a paragraph reading “${description}”`).toBeTruthy();
  const at = description.lastIndexOf(word);
  p.content = [
    { text: description.slice(0, at) },
    { text: word, link: 'https://example.com/the-owners-note' },
    ...(at + word.length < description.length ? [{ text: description.slice(at + word.length) }] : []),
  ];
  (w.repo.blocks.get(doc) as { version: number }).version++;
  return structuredClone(p.content as Obj[]);
}

describe('chronology rows and events compared by more than their text', () => {
  it('a row the job changed, then linked by the owner: Revert must not replace it', async () => {
    const r = await call('update_timeline_event', {
      event: { date: '4A 881 - 4A 900', description: 'The Quiet Years' },
      description: 'The Quiet Years of the north',
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    const table = w.ages[FOURTH]!.table;
    const linked = ownerLinksAWord(table, 'The Quiet Years of the north', 'north');

    const { r: rv, job } = await revertAndWait(w.stack, jobId);
    const now =
      paragraphWith(table, 'The Quiet Years of the north') ?? paragraphWith(table, 'The Quiet Years');
    expect({ revert: rv.status, content: now?.content ?? null }, `revert job ${job?.status ?? '-'}`).toEqual({
      revert: 'refused',
      content: linked,
    });
  });

  it('a row and event the job added, the row then linked by the owner: Revert must not delete them', async () => {
    const r = await call('create_timeline_event', {
      date: 'Kumikas 7th, 4A 881',
      name: 'Watchfires lit',
      description: 'The watchfires of Ashgate are lit',
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    const table = w.ages[FOURTH]!.table;
    const linked = ownerLinksAWord(table, 'The watchfires of Ashgate are lit', 'Ashgate');

    const { r: rv } = await revertAndWait(w.stack, jobId);
    expect({
      revert: rv.status,
      content: paragraphWith(table, 'The watchfires of Ashgate are lit')?.content,
    }).toEqual({ revert: 'refused', content: linked });
  });

  it('a row the job changed, then given an inline icon by the owner: Revert must not replace it (the API cannot write an icon back)', async () => {
    const r = await call('update_timeline_event', {
      event: { date: 'Kumikas - Azaakh, 4A 180', description: 'The famine months of the south' },
      description: 'The famine months of the southern plains',
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    const table = w.ages[FOURTH]!.table;
    const p = paragraphWith(table, 'The famine months of the southern plains')!;
    // The owner adds an inline icon after the words in the app (as the age's intro paragraph holds one).
    p.content = [{ text: 'The famine months of the southern plains' }, { icon: { glyph: 'wheat' } }];
    (w.repo.blocks.get(table) as { version: number }).version++;

    const { r: rv } = await revertAndWait(w.stack, jobId);
    const icons = JSON.stringify(w.repo.blocks.get(table)!.blocks).includes('"glyph":"wheat"');
    expect({ revert: rv.status, iconKept: icons }).toEqual({ revert: 'refused', iconKept: true });
  });

  it('rows shifted by another event added after the job: the other row, its event and the count stay right (control)', async () => {
    const a = await call('create_timeline_event', {
      date: 'Kumikas 9th, 4A 881',
      name: 'Gulls counted',
      description: 'The gulls of Ashgate are counted',
    });
    expect(a.body.status, a.text).toBe('written');
    const job1 = jobOf(a);
    await rt().engine.wait(PROJECT, job1, 25_000);
    const count1 = Number(w.count(FOURTH));
    // A second event the same day, placed before the first one's row.
    const b = await call('create_timeline_event', {
      date: 'Kumikas 9th, 4A 881',
      name: 'Bells tolled',
      description: 'The bells of Ashgate are tolled at dawn',
    });
    expect(b.body.status, b.text).toBe('written');
    await rt().engine.wait(PROJECT, jobOf(b), 25_000);
    const { r: rv } = await revertAndWait(w.stack, job1);
    const rows = w.rows(FOURTH);
    const events = w.events(w.ages[FOURTH]!.timeline).map((e) => String(e.name));
    expect(rows.some((x) => x.includes('bells of Ashgate are tolled'))).toBe(true);
    expect(events).toContain('Bells tolled');
    if (rv.status === 'submitted') {
      expect(rows.some((x) => x.includes('gulls of Ashgate'))).toBe(false);
      expect(Number(w.count(FOURTH))).toBe(count1); // +1 (job 2), -1 (the revert)
    } else expect(Number(w.count(FOURTH))).toBe(count1 + 1);
  });

  it('an event the job added, then coloured and given an icon by the owner: Revert must not delete it', async () => {
    const r = await call('create_timeline_event', {
      date: 'Kumikas 8th, 4A 881',
      name: 'Banners raised',
      description: 'The banners of Ashgate are raised',
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    const timeline = w.ages[FOURTH]!.timeline;
    const ev = w.liveEvents(timeline).find((e) => e.name === 'Banners raised')!;
    expect(ev).toBeTruthy();
    // The owner, in the app: a colour, an icon and an image on the event.
    Object.assign(ev, {
      color: '#aa3322',
      iconGlyph: 'flag',
      imageUrl: 'https://assets.legendkeeper.com/x.webp',
    });

    const { r: rv } = await revertAndWait(w.stack, jobId);
    const after = w.events(timeline).find((e) => e.name === 'Banners raised') ?? null;
    expect({ revert: rv.status, color: after?.color ?? null }).toEqual({
      revert: 'refused',
      color: '#aa3322',
    });
  });
});

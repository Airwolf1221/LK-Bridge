/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- tool results and the mock's state are JSON */
/**
 * CR-2026-11-R4 (the owner's request S): narrative-f4c's N3 failed on the owner's run although `arkona_chapter_save` made
 * "Chapter 1 - First" with its dateline; the check's 400-character slice of the answer cut off `readBack`, which comes
 * last. N3 passes on the mock as it was, because the mock's template copy got a fresh, empty Main: LegendKeeper copies a
 * template's documents with their content, "in an order it does not state" (ADR 0050). Each way a new chapter's
 * read-back can then go wrong, reproduced on the mock (`copyTemplateDocuments`), and N5's:
 *
 * - NR-1: the Chapter template has a second page document, listed before Main: the job writes Main (by name), the
 *   read-back read the first page document listed, so it compared the wrong document; its first difference falls on the
 *   dateline (the other document does not start with it).
 * - NR-2: the template's Main holds a block the bridge keeps (a column layout with a note): the job writes it back with
 *   the chapter, before the dateline; the read-back compared only the Markdown's own blocks, so its first difference
 *   falls on the dateline too.
 * - NR-3: `arkona_chapter_check` on a project with no full snapshot yet (the sandbox runtime always starts so): it answered
 *   CHAPTER_UNREADABLE (“could not be read”) and suggested `live: true`, which it already was.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { narrativeWorld, NT, type NarrativeWorld } from '../../narrative/world.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let open: NarrativeWorld | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const story = 'Readback Shore';
async function world(): Promise<NarrativeWorld> {
  const w = (open = await narrativeWorld());
  expect((await w.tool('arkona_story_create', { continuity: 'Main CANON', title: story })).status).toBe(
    'written',
  );
  await w.tool('arkona_chapter_plan', { story, number: 1, questionGate: 'closed' });
  return w;
}
const save = (w: NarrativeWorld) =>
  w.tool('arkona_chapter_save', {
    story,
    number: 1,
    title: 'First',
    inWorldDate: '5A 931',
    place: 'the test harbour',
    pov: 'Harun al-Saffar',
    charactersPresent: ['Harun al-Saffar'],
    locations: [],
    draftStatus: 'Draft',
    markdown: 'The probe chapter 1, written by the sandbox check.',
  });
const docsOf = (w: NarrativeWorld, id: string) =>
  (w.repo.live(id) as any).docs.map((d: string) => ({ id: d, name: (w.repo as any).docs.get(d).name }));
const chapterId = (w: NarrativeWorld, name: string) => {
  for (const r of (w.repo as any).res.values()) if (r.name === name && r.deletedAt === null) return r.id as string;
  throw new Error(`no ${name}`);
};

describe('a new chapter’s read-back (narrative-f4c N3)', () => {
  it('NR-1: a second page document listed before Main: the read-back reads the document the job wrote, and matches', async () => {
    const w = await world();
    w.repo.outside.addDocument(NT.chapter, 'Draft Notes', 'page');
    const notes = docsOf(w, NT.chapter).find((d: any) => d.name === 'Draft Notes').id;
    w.repo.blocks.set(notes, {
      version: 1,
      blocks: [{ id: 'dn1', kind: 'paragraph', content: [{ text: 'Notes for the next draft.' }] }],
    });
    w.repo.copyTemplateDocuments = 'reversed';
    const b = await save(w);
    expect(b.status, JSON.stringify(b)).toBe('written');
    const id = chapterId(w, 'Chapter 1 - First');
    const main = docsOf(w, id).find((d: any) => d.name === 'Main').id;
    // The job wrote Main, its dateline first.
    expect(JSON.stringify(w.repo.blocks.get(main)?.blocks)).toContain('5A 931 · the test harbour');
    expect(b.readBack, JSON.stringify(b.readBack)).toMatchObject({ matches: true, documentId: main });
  });

  it('NR-2: the template’s Main holds a block the bridge keeps: the read-back compares what was sent, and matches', async () => {
    const w = await world();
    w.repo.blocks.set(w.mainOf(NT.chapter), {
      version: 1,
      blocks: [
        {
          id: 'lay1',
          kind: 'layout',
          children: [
            {
              id: 'col1',
              kind: 'layoutColumn',
              children: [
                { id: 'lp1', kind: 'paragraph', content: [{ text: 'Editor’s note: under 5,000 words.' }] },
              ],
            },
          ],
        },
      ],
    });
    w.repo.copyTemplateDocuments = 'as-template';
    const b = await save(w);
    expect(b.status, JSON.stringify(b)).toBe('written');
    expect(b.readBack, JSON.stringify(b.readBack)).toMatchObject({ matches: true });
  });
});

describe('arkona_chapter_check without a full snapshot (narrative-f4c N5)', () => {
  it('NR-3: says the first full snapshot is missing, never “could not be read”', async () => {
    const w = await world();
    const b = await save(w);
    expect(b.status, JSON.stringify(b)).toBe('written');
    // The project as the sandbox runtime starts it: no full snapshot (its own temporary database).
    for (const t of ['snapshot_objects', 'snapshots'])
      try {
        w.stack.db.prepare(`DELETE FROM ${t}`).run();
      } catch {
        // a table this version does not have
      }
    (w.stack.runtime as any).appraisal?.index?.reset?.('proj_mock');
    const c = await w.tool('arkona_chapter_check', { story, number: 1 });
    expect(JSON.stringify(c)).not.toMatch(/CHAPTER_UNREADABLE/);
    expect(c.error?.code ?? c.status, JSON.stringify(c)).toBe('NO_SNAPSHOT');
  });
});

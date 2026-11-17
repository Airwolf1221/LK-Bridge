/**
 * v3 F3c, A1 (ADR 0054): the overlay's base. Unlike the audits, the appraisal takes a **partial** full snapshot as its
 * base (one image whose bytes could not be taken must not leave it a day behind); the pieces the snapshot lacks are
 * recorded on their pages (and reported as blocked cases), never guessed. A full snapshot still being taken is never
 * listed (a snapshot is indexed only once its manifest is written), so it cannot be picked up half-made.
 */
import { afterAll, expect, it } from 'vitest';
import type { SnapshotSource } from '../../src/audits/reader.js';
import { AppraisalIndex } from '../../src/appraisal/overlay.js';
import { FullText } from '../../src/appraisal/fts.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import type { Manifest, PageEntry } from '../../src/snapshots/manifest.js';

const PROJECT = 'prj_overlay';
const db = openDatabase(':memory:');
runMigrations(db);
afterAll(() => db.close());

const pieces = new Map<string, unknown>([
  ['res-root', { name: '[INDEX] AI REPOSITORY', tags: [] }],
  ['res-a', { name: '[BSRC] Tide Gate - Place Reference', tags: ['CANON'], aliases: ['the Gate'] }],
  ['res-b', { name: '[BSRC] Salt Court - Polity Reference', tags: ['CANON'] }],
  [
    'doc-a',
    {
      settings: { name: 'Main', type: 'page' },
      blocks: [{ id: 'a1', kind: 'paragraph', content: [{ text: 'The tide gate never closes.' }] }],
    },
  ],
  [
    'doc-b',
    {
      settings: { name: 'Main', type: 'page' },
      blocks: [{ id: 'b1', kind: 'paragraph', content: [{ text: 'The salt court sits at dusk.' }] }],
    },
  ],
]);
const ref = (sha: string) => ({ sha256: sha, size: 1 });
const entry = (id: string, name: string, more: Partial<PageEntry> = {}): PageEntry =>
  ({
    id,
    parentId: id === 'root0001' ? null : 'root0001',
    rank: id,
    name,
    kind: 'bsrc',
    ...more,
  }) as PageEntry;

/** The only full snapshot is partial: page B's sidebar could not be read, so it is listed as missing. */
const partial = {
  format: 'lk-bridge-snapshot',
  version: 1,
  id: 'F1',
  project: { id: PROJECT, name: 'overlay' },
  kind: 'full',
  takenAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  rootId: 'root0001',
  complete: false,
  trigger: {},
  pages: [
    entry('root0001', '[INDEX] AI REPOSITORY', {
      kind: 'index',
      resource: ref('res-root'),
    } as Partial<PageEntry>),
    entry('pagea001', '[BSRC] Tide Gate - Place Reference', {
      resource: ref('res-a'),
      documents: [{ id: 'doca', type: 'page', name: 'Main', ...ref('doc-a') }],
    } as Partial<PageEntry>),
    entry('pageb001', '[BSRC] Salt Court - Polity Reference', {
      resource: ref('res-b'),
      documents: [{ id: 'docb', type: 'page', name: 'Main', ...ref('doc-b') }],
      missing: [{ piece: 'sidebar', reason: 'LegendKeeper answered 500' }],
    } as Partial<PageEntry>),
  ],
  library: null,
  counts: { pages: 3, pieces: 5, logicalBytes: 0, missing: 1 },
} as unknown as Manifest;

const source: SnapshotSource = {
  fulls: () => [{ id: 'F1', takenAt: Date.now() - 60_000 }],
  changesAfter: () => [],
  manifest: (id) => Promise.resolve(id === 'F1' ? partial : null),
  piece: (sha) => Promise.resolve(pieces.get(sha) ?? null),
};

it('a partial full snapshot is the base; the piece it lacks is recorded on its page, never guessed', async () => {
  const index = new AppraisalIndex({
    db,
    source: () => source,
    propertiesName: () => 'PROPERTIES',
    now: Date.now,
  });
  const out = await index.ensure(PROJECT);
  expect(out.built).toBe(true);
  expect(out.state).toMatchObject({ baseSnapshotId: 'F1', pages: 3, unreadable: 1 });
  const b = index.pages(PROJECT).get('pageb001')!;
  expect(b.unreadable).toEqual(['sidebar (not in the snapshot: LegendKeeper answered 500)']);
  expect(index.pages(PROJECT).get('pagea001')!.unreadable).toEqual([]);
  // Its text is searchable all the same: what the snapshot holds is indexed, what it lacks is said.
  const ft = new FullText(db);
  expect([...ft.pagesFor(PROJECT, { value: 'salt court', phrase: true }).keys()]).toEqual(['pageb001']);
  expect([...ft.pagesFor(PROJECT, { value: 'the Gate', phrase: true }).keys()]).toEqual(['pagea001']);
});

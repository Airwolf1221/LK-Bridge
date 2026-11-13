/**
 * v2 E2 (ADR 0044): extraction (src/audits/model.ts) and the reader (src/audits/reader.ts): a page's pieces into what the
 * checks need, and the newest full snapshot with later change snapshots laid over it, from an in-memory store.
 */
import { describe, expect, it } from 'vitest';
import { extractSidebar, scanDocument, splitRunsAtBreaks } from '../../src/audits/model.js';
import { buildModel, type SnapshotSource } from '../../src/audits/reader.js';
import type { Manifest, PageEntry } from '../../src/snapshots/manifest.js';

const doc = { id: 'd1', name: 'Main' };

describe('extraction', () => {
  it('finds paragraphs with line breaks inside a text run (not break runs), icons, unsupported blocks and collections', () => {
    const blocks = [
      { id: 'h', kind: 'heading', level: 1, content: [{ text: 'Title' }] },
      { id: 'p1', kind: 'paragraph', content: [{ text: 'one\ntwo' }, { text: ' three', bold: true }] },
      { id: 'p2', kind: 'paragraph', content: [{ text: 'a' }, { break: true }, { text: 'b' }] }, // a real break run: fine
      { id: 'p3', kind: 'paragraph', content: [{ text: 'bell\u0007' }] }, // another character Markdown cannot carry
      { id: 'p4', kind: 'paragraph', content: [{ text: 'icon ' }, { icon: 'fa-star' }] },
      { id: 'u1', kind: 'unsupported' },
      {
        id: 't',
        kind: 'table',
        children: [
          {
            id: 'tr',
            kind: 'tableRow',
            children: [
              {
                id: 'tc',
                kind: 'tableCell',
                children: [
                  {
                    id: 'p5',
                    kind: 'paragraph',
                    content: [
                      { mention: { resourceId: 'xyz12345', documentId: 'dd', text: 'X' } },
                      { text: 'x\r\ny' },
                    ],
                  },
                  { id: 'u2', kind: 'unsupported' },
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'c1',
        kind: 'resourceCollection',
        title: 'Links',
        items: [{ resourceId: 'lnk12345', documentId: 'ld' }],
      },
      { id: 'cd', kind: 'code', language: 'json', text: '{"a":1}' },
    ];
    const { scan, refs } = scanDocument(doc, blocks, { keepCode: true });
    expect(scan.lineBreaks.map((l) => [l.blockId, l.characters, l.splittable, l.parts])).toEqual([
      ['p1', ['\\n'], true, 2],
      ['p3', ['\\u0007'], false, 0],
      ['p5', ['\\n', '\\r'], true, 2],
    ]);
    expect(scan.iconBlocks).toEqual(['p4']);
    expect(scan.unsupported).toEqual({ count: 2, blockIds: ['u1', 'u2'] });
    expect(scan.collectionBlocks).toBe(1);
    expect(scan.codeBlocks).toEqual([{ blockId: 'cd', language: 'json', text: '{"a":1}' }]);
    expect(refs.map((r) => [r.resourceId, r.documentId, r.via.kind])).toEqual([
      ['xyz12345', 'dd', 'mention'],
      ['lnk12345', 'ld', 'collection'],
    ]);
    // The evidence changes when the paragraph does.
    const again = scanDocument(doc, [{ id: 'p1', kind: 'paragraph', content: [{ text: 'one\nTWO' }] }]).scan;
    expect(again.lineBreaks[0]!.runsHash).not.toBe(scan.lineBreaks[0]!.runsHash);
  });

  it('keeps json code blocks only when asked', () => {
    const blocks = [{ id: 'cd', kind: 'code', language: 'json', text: '{}' }];
    expect(scanDocument(doc, blocks).scan.codeBlocks).toEqual([]);
  });

  it('splits runs at breaks: marks and mentions kept, empty parts left to the caller', () => {
    const m = { mention: { resourceId: 'r1234567', text: 'R' } };
    const parts = splitRunsAtBreaks([{ text: 'a\nb', italic: true }, m, { text: 'c\r\n\r\nd' }]);
    expect(parts).toEqual([
      [{ text: 'a', italic: true }],
      [{ text: 'b', italic: true }, m, { text: 'c' }],
      [],
      [{ text: 'd' }],
    ]);
  });

  it('reads the sidebar: structure, facts (the first PROPERTIES row wins; duplicates counted), mentions and collection items', () => {
    const side = extractSidebar(
      {
        properties: [
          {
            id: 'k',
            kind: 'keyValue',
            title: 'PROPERTIES',
            rows: [
              { id: 'r1', key: 'Reference Type', content: [{ text: 'Character Core' }] },
              { id: 'r2', key: 'Spouse', content: [{ mention: { resourceId: 'sp123456', text: 'Sp' } }] },
              { id: 'r3', key: 'reference type', content: [{ text: 'again' }] },
            ],
          },
          {
            id: 'c',
            kind: 'resourceCollection',
            title: 'Dependencies',
            items: [{ resourceId: 'dep12345' }],
            isTitleHidden: true,
          },
          { id: 't', kind: 'unsupported', title: 'TAGS' },
        ],
      },
      'PROPERTIES',
    );
    expect(side.hasProperties).toBe(true);
    expect(side.facts.get('reference type')).toMatchObject({ text: 'Character Core', count: 2 });
    expect(side.properties.map((p) => [p.title, p.kind, p.isTitleHidden])).toEqual([
      ['PROPERTIES', 'keyValue', false],
      ['Dependencies', 'resourceCollection', true],
      ['TAGS', 'unsupported', false],
    ]);
    expect(side.refs.map((r) => [r.resourceId, r.via.kind])).toEqual([
      ['sp123456', 'mention'],
      ['dep12345', 'collection'],
    ]);
  });
});

// ============================================================================================ the reader

const sha = (s: string) => s.padEnd(64, '0');

function manifest(
  id: string,
  kind: 'full' | 'change',
  pages: PageEntry[],
  o: Partial<Manifest> = {},
): Manifest {
  return {
    format: 'lk-bridge-snapshot',
    version: 1,
    id,
    project: { id: 'prj', name: 'prj' },
    kind,
    takenAt: '2026-11-13T00:00:00Z',
    startedAt: '2026-11-13T00:00:00Z',
    rootId: 'root',
    complete: true,
    trigger: {},
    pages,
    library: null,
    counts: {
      pages: pages.length,
      pieces: 0,
      reads: 0,
      downloads: 0,
      newObjects: 0,
      newBytes: 0,
      logicalBytes: 0,
      missing: 0,
    },
    ...o,
  };
}

const entry = (id: string, name: string, parentId: string | null, o: Partial<PageEntry> = {}): PageEntry => ({
  id,
  parentId,
  rank: id,
  name,
  kind: 'bsrc',
  ...o,
});

function source(
  fulls: { id: string; takenAt: number }[],
  changes: { id: string; takenAt: number }[],
  manifests: Record<string, Manifest>,
  pieces: Record<string, unknown>,
): SnapshotSource {
  return {
    fulls: () => fulls,
    changesAfter: (_p, after) => changes.filter((c) => c.takenAt > after),
    manifest: (id) => Promise.resolve(manifests[id] ?? null),
    piece: (h) => Promise.resolve(h in pieces ? pieces[h] : null),
  };
}

describe('the reader', () => {
  const T = (h: number) => Date.UTC(2026, 10, 13, h);
  const sidebar = (status: string) => ({
    properties: [
      {
        id: 'k',
        kind: 'keyValue',
        title: 'PROPERTIES',
        rows: [{ id: 'r', key: 'Status', content: [{ text: status }] }],
      },
    ],
  });
  const base = manifest(
    'F1',
    'full',
    [
      entry('root', 'AI REPOSITORY', null, { kind: 'root' }),
      entry('a', '[BSRC] A', 'root', {
        resource: { sha256: sha('ra'), size: 1 },
        sidebar: { sha256: sha('sa'), size: 1 },
        documents: [
          { id: 'da', type: 'page', name: 'Main', sha256: sha('da'), size: 1 },
          { id: 'ma', type: 'map', name: 'Map', sha256: sha('ma'), size: 1 },
        ],
      }),
      entry('b', '[BSRC] B', 'root', { resource: { sha256: sha('rb'), size: 1 } }),
      entry('c', '[BSRC] C', 'root'),
    ],
    {
      templates: [
        entry('t1', '[BSRC] Tpl', 'templates', {
          kind: 'template',
          resource: { sha256: sha('rt'), size: 1 },
        }),
      ],
    },
  );
  const pieces = {
    [sha('ra')]: { tags: ['one'], aliases: ['Ay'] },
    [sha('sa')]: sidebar('Authoritative'),
    [sha('da')]: {
      settings: {},
      blocks: [{ id: 'p', kind: 'paragraph', content: [{ mention: { resourceId: 'b' } }] }],
    },
    [sha('rb')]: { tags: [] },
    [sha('rt')]: { tags: ['tpl'] },
  };

  it('reads the newest complete full snapshot, its pieces, its templates, and says where each page came from', async () => {
    const r = await buildModel(
      source(
        [
          { id: 'F1', takenAt: T(0) },
          { id: 'F0', takenAt: T(-24) },
        ],
        [],
        { F1: base },
        pieces,
      ),
      'prj',
      { propertiesName: 'PROPERTIES' },
    );
    if (!r.ok) throw new Error('no model');
    const m = r.model;
    expect(m.base).toEqual({ id: 'F1', takenAt: T(0) });
    expect([...m.pages.keys()]).toEqual(['a', 'b', 'c', 'root']);
    const a = m.pages.get('a')!;
    expect(a).toMatchObject({ tags: ['one'], aliases: ['Ay'], kind: 'bsrc', sourceSnapshotId: 'F1' });
    expect(a.facts.get('status')!.text).toBe('Authoritative');
    expect(a.documents.map((d) => [d.id, d.type])).toEqual([
      ['da', 'page'],
      ['ma', 'map'],
    ]);
    expect(a.refs.map((x) => x.resourceId)).toEqual(['b']);
    expect(m.pages.get('root')!.kind).toBe('root');
    expect(m.templates!.get('t1')!.tags).toEqual(['tpl']);
    // A page with no pieces in the manifest has no sidebar (null), not an empty one.
    expect(m.pages.get('c')!.properties).toBeNull();
  });

  it('no complete full snapshot: not ok', async () => {
    expect((await buildModel(source([], [], {}, {}), 'prj', { propertiesName: 'PROPERTIES' })).ok).toBe(
      false,
    );
  });

  it('lays change snapshots over it in time order: replaced pieces, moved pages, new pages, deleted pages and documents', async () => {
    const c1 = manifest('C1', 'change', [
      entry('a', '[BSRC] A renamed', 'b', {
        sidebar: { sha256: sha('sa2'), size: 1 },
        deletedDocuments: ['ma'],
      }),
      entry('n', '[BSRC] New', 'root', {
        resource: { sha256: sha('rn'), size: 1 },
        documents: [{ id: 'dn', type: 'page', name: 'Main', sha256: sha('dn'), size: 1 }],
      }),
      { ...entry('b', '[BSRC] B', 'root'), deleted: true },
    ]);
    const c2 = manifest('C2', 'change', [
      entry('c', '[BWRK] C', 'root', { resource: { sha256: sha('rc'), size: 1 } }),
    ]);
    const more = {
      ...pieces,
      [sha('sa2')]: sidebar('Working'),
      [sha('rn')]: { tags: ['new'] },
      [sha('dn')]: { blocks: [] },
      [sha('rc')]: { tags: ['c'] },
    };
    const r = await buildModel(
      source(
        [{ id: 'F1', takenAt: T(0) }],
        [
          { id: 'C1', takenAt: T(1) },
          { id: 'C2', takenAt: T(2) },
          { id: 'OLD', takenAt: T(-1) },
        ],
        { F1: base, C1: c1, C2: c2 },
        more,
      ),
      'prj',
      { propertiesName: 'PROPERTIES' },
    );
    if (!r.ok) throw new Error('no model');
    const m = r.model;
    expect(m.changes.map((c) => c.id)).toEqual(['C1', 'C2']);
    expect(m.newest.id).toBe('C2');
    const a = m.pages.get('a')!;
    expect(a).toMatchObject({ rawName: '[BSRC] A renamed', parentId: 'b', sourceSnapshotId: 'C1' });
    expect(a.facts.get('status')!.text).toBe('Working'); // the newer sidebar
    expect(a.tags).toEqual(['one']); // the resource piece the change did not take is kept
    expect(a.documents.map((d) => d.id)).toEqual(['da']); // the map was deleted
    expect(m.pages.has('b')).toBe(false);
    expect(m.deleted.get('b')).toMatchObject({ snapshotId: 'C1', name: '[BSRC] B' });
    expect(m.pages.get('n')).toMatchObject({ tags: ['new'], sourceSnapshotId: 'C1' });
    expect(m.pages.get('c')).toMatchObject({ kind: 'bwrk', rawName: '[BWRK] C', sourceSnapshotId: 'C2' });
    // A change that only moved a page leaves its pieces' source alone.
    expect(m.pages.get('root')!.sourceSnapshotId).toBe('F1');
  });

  it('a piece the store cannot give is noted on its page, not fatal', async () => {
    const lonely = manifest('F1', 'full', [
      entry('root', 'AI REPOSITORY', null, { kind: 'root' }),
      entry('a', '[BSRC] A', 'root', { sidebar: { sha256: sha('gone'), size: 1 } }),
    ]);
    const r = await buildModel(source([{ id: 'F1', takenAt: T(0) }], [], { F1: lonely }, {}), 'prj', {
      propertiesName: 'PROPERTIES',
    });
    if (!r.ok) throw new Error('no model');
    expect(r.model.pages.get('a')!.unreadable).toEqual(['sidebar']);
    expect(r.model.unreadable).toBe(1);
  });
});

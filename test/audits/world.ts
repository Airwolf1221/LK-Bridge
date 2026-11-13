/**
 * The audits' test world (v2 E2): the E1a snapshots world (the REAL server, runtime, policy, engine, tree, snapshot store
 * and MCP transport against the mock LegendKeeper) with pages seeded for the audits to find: the old bridge's cases, the
 * owner's first findings (Kamigawa Miyuki, Mehrana al-Khalid, Founder) and the paragraphs the line-break fix splits.
 */
import { SidebarModel, T } from '../resources/world.js';
import { PROJECT } from '../tools/helpers.js';
import { ROOT } from '../discover/world.js';
import { snapshotsWorld, type SnapshotsWorld } from '../snapshots/world.js';

export const A = {
  zoo: 'zoo00001',
  apple: 'apple001',
  cherry: 'cherry01',
  banana: 'banana01',
  loose: 'loose001',
  kami: 'kami0001',
  mehrana: 'mehra001',
  breaks: 'breaks01',
  icons: 'icons001',
  linker: 'linker01',
  tagdef: 'tagdef01',
} as const;

/** A block of a mock document, as the tests read it. */
export interface MockBlock {
  id: string;
  kind: string;
  content?: { text?: string; bold?: boolean }[];
  text?: string;
  [k: string]: unknown;
}

export interface AuditsWorld extends SnapshotsWorld {
  /** The Main document id of a seeded page. */
  mainOf(pageId: string): string;
  /** The blocks of a seeded page's Main document. */
  blocksOf(pageId: string): MockBlock[];
  /** Requests the mock LegendKeeper has answered so far. */
  requests(): number;
  /** A full snapshot, and the audit that follows it (the runtime's own hook). */
  snapshotAndAudit(): Promise<void>;
}

export async function auditsWorld(o: Parameters<typeof snapshotsWorld>[0] = {}): Promise<AuditsWorld> {
  const w = (await snapshotsWorld({
    ...o,
    seed: (world) => {
      const r = world.repo;
      r.seed({ id: A.zoo, name: '[INDEX] Audit Zoo', parentId: ROOT });
      // Created in this order, so their ranks put Cherry before Banana (out of alphabetical order).
      for (const [id, name] of [
        [A.apple, '[BSRC] Apple'],
        [A.cherry, '[BSRC] Cherry'],
        [A.banana, '[BSRC] Banana'],
      ] as const)
        r.seed({ id, name, parentId: A.zoo, referenceType: 'General Source' });
      r.seed({ id: A.loose, name: 'Loose notes', parentId: ROOT, referenceType: 'General Source' });
      r.seed({
        id: A.kami,
        name: '[BSRC] Kamigawa Miyuki - Character Reference',
        parentId: A.zoo,
        referenceType: 'Character Reference',
      });
      r.seed({
        id: A.mehrana,
        name: '[BSRC] Mehrana al-Khalid, Founder - Character Core',
        parentId: A.zoo,
        referenceType: 'Historical Character Reference',
      });
      r.seed({ id: A.breaks, name: '[BSRC] Many Lines', parentId: A.zoo, referenceType: 'General Source' });
      r.seed({
        id: A.icons,
        name: '[BSRC] Icons And Lines',
        parentId: A.zoo,
        referenceType: 'General Source',
      });
      r.seed({ id: A.linker, name: '[BSRC] Linker', parentId: A.zoo, referenceType: 'General Source' });
      r.seed({
        id: A.tagdef,
        name: '[BSRC] Tag definitions',
        parentId: ROOT,
        referenceType: 'General Source',
      });
      const main = (id: string) => r.liveDocs(r.live(id)!).find((d) => d.name === 'Main')!.id;
      r.blocks.set(main(A.breaks), {
        version: 1,
        blocks: [
          { id: 'bh', kind: 'heading', level: 1, content: [{ text: 'Many lines' }] },
          {
            id: 'bp1',
            kind: 'paragraph',
            content: [
              { text: 'first line\nsecond ' },
              { text: 'line', bold: true },
              { text: '\nthird line' },
            ],
          },
          { id: 'bp2', kind: 'paragraph', content: [{ text: 'a tidy paragraph' }] },
          { id: 'bp3', kind: 'paragraph', content: [{ text: 'one\r\ntwo' }] },
        ],
      });
      r.blocks.set(main(A.icons), {
        version: 1,
        blocks: [
          { id: 'ip1', kind: 'paragraph', content: [{ text: 'Pinned ' }, { icon: 'star' }] },
          { id: 'ip2', kind: 'paragraph', content: [{ text: 'before\nafter' }] },
          { id: 'ip3', kind: 'paragraph', content: [{ text: 'untouched' }] },
          { id: 'iun', kind: 'unsupported' },
        ],
      });
      r.blocks.set(main(A.tagdef), {
        version: 1,
        blocks: [
          { id: 'tdp', kind: 'paragraph', content: [{ text: 'The tags each rule requires.' }] },
          {
            id: 'tdj',
            kind: 'code',
            language: 'json',
            text: JSON.stringify({
              schema: 1,
              rules: [{ id: 'zoo', required_tags: ['fruit'], allowed_tags: ['sweet', 'atlas'] }],
            }),
          },
        ],
      });
      r.blocks.set(main(A.linker), {
        version: 1,
        blocks: [
          {
            id: 'lp1',
            kind: 'paragraph',
            content: [
              { text: 'See ' },
              { mention: { resourceId: 'ghost001', text: 'a ghost' } },
              { text: ' and ' },
              { mention: { resourceId: T.general, text: 'a template' } },
              { text: ' and ' },
              {
                mention: {
                  resourceId: A.apple,
                  documentId: 'nodoc001',
                  text: 'Apple, a tab that is not there',
                },
              },
            ],
          },
        ],
      });
      o.seed?.(world);
    },
  })) as AuditsWorld;
  const sb = w.sidebars;
  sb.page(A.kami, [
    SidebarModel.kv('kvkami01', 'PROPERTIES', [
      ['Reference Type', 'Character Reference'],
      ['Subject', 'Kamigawa Miyuki'],
      ['Scope', 'A courier of the Hollow Court'],
    ]),
  ]);
  sb.page(A.mehrana, [
    SidebarModel.kv('kvmehra1', 'PROPERTIES', [
      ['Reference Type', 'Historical Character Reference'],
      ['Subject', 'Mehrana al-Khalid'],
      ['Status', 'Working'],
    ]),
  ]);
  const mainOf = (id: string) => w.repo.liveDocs(w.repo.live(id)!).find((d) => d.name === 'Main')!.id;
  Object.assign(w, {
    mainOf,
    blocksOf: (id: string) => w.repo.blocks.get(mainOf(id))!.blocks as MockBlock[],
    requests: () => w.stack.mock.calls.length,
    snapshotAndAudit: async () => {
      await w.stack.runtime.snapshots.full(PROJECT, 'manual');
      await w.stack.runtime.audits.settled();
    },
  });
  return w;
}

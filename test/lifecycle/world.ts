/**
 * The test world for the page lifecycle (v2 C2c, ADR 0035): C2b's resources world (with `[INDEX] Working` and
 * `[INDEX] Archived` found by name and confirmed, C2a.1's real row ordering in the sidebar model), plus:
 *
 * - `[BSRC] Old Harbour`: an Authoritative page under Locations with the five lifecycle facts but Last Major Revision
 *   (added in template order), the CANON tag and another, and a Main page holding an inline icon (content the whole-page
 *   write cannot take back, so the note must go in block by block);
 * - `[BWRK] Sky Ferry`: a Working page under [INDEX] Working, with an empty Continuity Type;
 * - `[BSRC] Harbour Guild`: a page that links to Old Harbour from its Dependencies collection and mentions it in text;
 * - `[BSRC] Tide Tables`: a page whose text names Old Harbour without a mention (found only by the content search);
 * - the template they come from, with every lifecycle fact in its order.
 */
import { PROJECT } from '../tools/helpers.js';
import { factsWorld } from '../facts/world.js';
import { asCanon, LIFECYCLE, resourcesWorld, SidebarModel, type ResourcesWorld } from '../resources/world.js';
import type { ToolCall } from '../tools/helpers.js';

export { asCanon, LIFECYCLE };
void factsWorld;

export const L = {
  harbour: 'harbour1',
  ferry: 'skyferr1',
  guild: 'guild001',
  tides: 'tides001',
  template: 'tplsrce1',
} as const;

export const SOURCE_KEYS = [
  'Reference Type',
  'Status',
  'Continuity Type',
  'Scope',
  'Temporal Scope',
  'Last Major Revision',
];

export interface LifecycleWorld extends ResourcesWorld {
  /** The Main document of a page (its id). */
  main(pageId: string): string;
  /** The blocks of a document, as the model holds them. */
  blocks(docId: string): Record<string, unknown>[];
}

export async function lifecycleWorld(o: Parameters<typeof resourcesWorld>[0] = {}): Promise<LifecycleWorld> {
  const w = (await resourcesWorld({
    ...o,
    seed: (world) => {
      world.repo.seed({
        id: L.harbour,
        name: '[BSRC] Old Harbour',
        parentId: 'locs0001',
        referenceType: 'General Source',
        scope: 'A harbour town on the Weeping Sea',
        tags: ['CANON', 'port'],
      });
      world.repo.seed({
        id: L.ferry,
        name: '[BWRK] Sky Ferry',
        parentId: LIFECYCLE.working,
        tags: ['Working'],
      });
      world.repo.seed({ id: L.guild, name: '[BSRC] Harbour Guild', parentId: 'locs0001', tags: ['CANON'] });
      world.repo.seed({ id: L.tides, name: '[BSRC] Tide Tables', parentId: 'locs0001', tags: ['CANON'] });
      world.repo.seed({ id: L.template, name: '[BSRC] AI Source', parentId: null, props: false });
      o.seed?.(world);
    },
  })) as LifecycleWorld;
  const sb = w.sidebars;
  sb.page(L.harbour, [
    SidebarModel.kv('kvharb01', 'PROPERTIES', [
      ['Reference Type', 'General Source'],
      ['Status', 'Authoritative'],
      ['Continuity Type', 'CANON'],
      ['Scope', 'A harbour town on the Weeping Sea'],
      ['Temporal Scope', 'Fourth Age'],
    ]),
    SidebarModel.links('depharb1', 'Dependencies', []),
  ]);
  sb.page(L.ferry, [
    SidebarModel.kv('kvferr01', 'PROPERTIES', [
      ['Reference Type', 'General Source'],
      ['Status', 'Working'],
      ['Continuity Type', ''],
      ['Scope', 'A flying ferry'],
      ['Temporal Scope', ''],
      ['Last Major Revision', '2026-11-01'],
    ]),
  ]);
  sb.page(L.guild, [
    SidebarModel.kv('kvguil01', 'PROPERTIES', [
      ['Reference Type', 'General Source'],
      ['Status', 'Authoritative'],
    ]),
    SidebarModel.links('depguil1', 'Dependencies', [{ resourceId: L.harbour }]),
  ]);
  sb.page(L.tides, [SidebarModel.kv('kvtide01', 'PROPERTIES', [['Status', 'Authoritative']])]);
  sb.page(L.template, [
    SidebarModel.kv(
      'kvtplsrc',
      'PROPERTIES',
      SOURCE_KEYS.map((k) => [k, ''] as [string, string]),
    ),
  ]);
  const main = (id: string) => w.repo.liveDocs(w.repo.res.get(id)!).find((d) => d.name === 'Main')!.id;
  w.repo.blocks.set(main(L.harbour), {
    version: 4,
    blocks: [
      { id: 'hb1', kind: 'heading', level: 1, content: [{ text: 'Old Harbour' }] },
      // An inline icon: content LegendKeeper's whole-document write has no form for (C1's PAGE_NOT_WRITABLE).
      {
        id: 'hb2',
        kind: 'paragraph',
        content: [{ text: 'The lighthouse ' }, { icon: { glyph: 'tower' } }, { text: ' stands.' }],
      },
      { id: 'hb3', kind: 'paragraph', content: [{ text: 'Ships call twice a season.' }] },
    ],
  });
  w.repo.blocks.set(main(L.ferry), {
    version: 2,
    blocks: [{ id: 'fb1', kind: 'paragraph', content: [{ text: 'A ferry that sails the clouds.' }] }],
  });
  w.repo.blocks.set(main(L.guild), {
    version: 2,
    blocks: [
      {
        id: 'gb1',
        kind: 'paragraph',
        content: [
          { text: 'The guild meets at ' },
          { mention: { resourceId: L.harbour, text: 'Old Harbour' } },
          { text: '.' },
        ],
      },
    ],
  });
  w.repo.blocks.set(main(L.tides), {
    version: 2,
    blocks: [{ id: 'tb1', kind: 'paragraph', content: [{ text: 'High water at Old Harbour is at dawn.' }] }],
  });
  // The template the sources were made from, recorded in the tree (as C2b records it).
  for (const id of [L.harbour, L.ferry]) {
    w.stack.db
      .prepare('UPDATE tree_nodes SET template_id = ? WHERE project_id = ? AND id = ?')
      .run(L.template, PROJECT, id);
  }
  w.main = main;
  w.blocks = (docId: string) => (w.repo.blocks.get(docId)?.blocks ?? []) as Record<string, unknown>[];
  return w;
}

/** The text of a block's runs. */
export const textOf = (b: Record<string, unknown> | undefined) =>
  ((b?.content ?? []) as { text?: string }[]).map((r) => r.text ?? '').join('');

/** A lifecycle tool's proposal, accepted as canon by the owner and run (as `asCanon`). */
export async function accept(w: LifecycleWorld, r: ToolCall): Promise<ToolCall> {
  return asCanon(w, r);
}

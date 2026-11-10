/**
 * The test world for set_facts and the protected canonical facts (v2 C2a): B2's discover world (the REAL server,
 * runtime, MCP transport, policy and engine, with chunk 1's mock LegendKeeper behind it and the repository tree built),
 * plus a faithful model of the sidebars of a few pages, consulted before everything else:
 *
 * - properties with their kinds: key-value (rows with ids, ranks, keys and runs), link collections (`resourceCollection`
 *   with items and a filter, `resourceLink`), and `unsupported` ones;
 * - ONE sidebar version per page, as LegendKeeper's "document version": `listPropertyRows` gives it, every row write
 *   checks If-Match against it and answers the new one, any property write moves it on. `listProperties` and
 *   `getProperty` give no version (as the spec says; `propertyVersions: true` adds one, to show it is never confused
 *   with the rows' version);
 * - row placement with `after` / `before`; `content` wins over `text`; `content: null` clears a value; new items of a
 *   collection get an id and a rank after the last one; `getResource` returns the same properties;
 * - hooks: what was asked (`requests`), a change made by "someone else" at an exact moment (`after`), and a write that
 *   LegendKeeper stores differently from what was sent (`mangle`), for the verify step;
 * - LegendKeeper's row ORDERS (the hotfix of 10 November 2026): `listPropertyRows` gives rows sorted by rank, while
 *   `listProperties`, `getProperty` and `getResource` give them in stored order; `createPropertyRow` ranks a new row
 *   between its anchor and the anchor's rank-sorted neighbour and appends it to the stored order. Rheashira Aela's
 *   PROPERTIES are seeded exactly as read on the test world, where the two orders differ.
 */
import { buildModels, discoverWorld, type DiscoverWorld } from '../discover/world.js';
import { PROJECT } from '../tools/helpers.js';

export { SidebarModel, type MItem, type MProp, type MRow, type MSidebar } from './sidebar-model.js';
import { SidebarModel } from './sidebar-model.js';

export interface FactsWorld extends DiscoverWorld {
  readonly sidebars: SidebarModel;
}

/** The templates of the Character type: their PROPERTIES keys, in template order. */
export const CORE_TEMPLATE = 'tplcore1';
export const CORE_KEYS = [
  'Reference Type',
  'Subject',
  'Race / Species',
  'Status',
  'Continuity Type',
  'Continuity',
  'Scope',
  'Canonical Display Name',
];

/**
 * Rheashira Aela's PROPERTIES exactly as LegendKeeper stored them on the test world (read on 10 November 2026: page
 * `kzwy5zrs`, property `hnocyl8o`), in STORED order with their real ranks. Rank-sorted (code-unit order) they read
 * O V X \ a aR af b c d dZ do e g i l m: Life State and Race / Species were inserted after Subject long after the
 * rows below them, so every row from Canonical Display Name on stands at a different position in the two orders. The
 * values are the fixture's own.
 */
export const RHEASHIRA = { page: 'kzwy5zrs', property: 'hnocyl8o', template: 'tplbio01' } as const;
export const RHEASHIRA_ROWS: [string, string, string, string][] = [
  ['Status', 'Working', 'O', 'rhea0001'],
  ['Continuity Type', 'CANON', 'V', 'rhea0002'],
  ['Continuity', 'Main', 'X', 'rhea0003'],
  ['Inheritance', 'Paternal', '\\', 'rhea0004'],
  ['Subject', 'Rheashira Aela', 'a', 'rhea0005'],
  ['Canonical Display Name', 'Rheashira Aela', 'b', 'rhea0006'],
  ['Family / Surname', 'Aela', 'c', 'rhea0007'],
  ['Personal / Given Name', 'Rheashira', 'd', 'rhea0008'],
  ['Reference Type', 'Character Biography', 'e', 'rhea0009'],
  ['Naming Culture', 'Sylvan', 'dZ', 'rhea0010'],
  ['Aliases', 'Rhea', 'do', 'rhea0011'],
  ['Scope', 'Moon elf envoy to the Hollow Court', 'g', 'rhea0012'],
  ['Last Major Revision', '9 November 2026', 'l', 'rhea0013'],
  ['Supersedes', '', 'm', 'rhea0014'],
  ['Race / Species', 'Moon Elf', 'af', 'rhea0015'],
  ['Life State', 'Living', 'aR', 'rhea0016'],
  ['Temporal Scope', 'Fourth Age', 'i', 'rhea0017'],
];
/** The Character Biography template's keys, in template order (Epithet and Mood are the ones Rheashira lacks). */
export const BIO_KEYS = [
  'Status',
  'Continuity Type',
  'Continuity',
  'Inheritance',
  'Subject',
  'Epithet',
  'Canonical Display Name',
  'Family / Surname',
  'Personal / Given Name',
  'Reference Type',
  'Naming Culture',
  'Aliases',
  'Scope',
  'Mood',
  'Last Major Revision',
  'Supersedes',
  'Race / Species',
  'Life State',
  'Temporal Scope',
];

/** The pages the facts tests write to. */
export const P = {
  /** [BSRC] Asagiri Miyabi: a Character Core with the full sidebar layout (PROPERTIES, two link collections, TAGS). */
  miyabi: 'miyabi01',
  /** [BSRC] Mehrana al-Khalid: a Character Core whose PROPERTIES lacks most template keys. */
  mehrana: 'mehran01',
  /** [BSRC] Inae Mikumo: a Character Core that is canon (Status Authoritative, Continuity Main). */
  inae: 'inae0001',
  /** [BSRC] Ashgate (General Source): no template can be determined. */
  ashgate: 'ashg0001',
} as const;

export async function factsWorld(o: Parameters<typeof discoverWorld>[0] = {}): Promise<FactsWorld> {
  const world = (await discoverWorld({ bulk: 20, ageRows: 20, ...o, build: false })) as FactsWorld;
  // Rheashira Aela, under Moon Elves, before the tree is built from the models.
  world.repo.seed({
    id: RHEASHIRA.page,
    name: '[BSRC] Rheashira Aela',
    parentId: 'moonelf1',
    referenceType: 'Character Biography',
    scope: 'Moon elf envoy to the Hollow Court',
  });
  if (o.build !== false) buildModels(world.stack, world.repo, world.assets);
  const sb = new SidebarModel((id) => world.repo.live(id)?.name);
  (world as { sidebars: SidebarModel }).sidebars = sb;
  world.overrides.set(/\/resources\/[^/]+(\/properties.*)?$/, (req) =>
    sb.respond(req, (id) => {
      const r = world.repo.live(id);
      return r ? world.repo.resourceView(r) : undefined;
    }),
  );
  const mention = (resourceId: string, text: string) => [{ mention: { resourceId, text } }];
  sb.page(P.miyabi, [
    SidebarModel.kv('kvmiya01', 'PROPERTIES', [
      ['Reference Type', 'Character Core'],
      ['Subject', 'Asagiri Miyabi'],
      ['Status', 'Working'],
      ['Continuity Type', 'CANON'],
      ['Continuity', 'Main'],
      ['Scope', 'Foxian shrine maiden of the Hollow Court'],
      ['Sister', mention('kaede001', 'Asagiri Kaede')],
      ['Notes', 'First notes'],
    ]),
    SidebarModel.links(
      'depmiya1',
      'Dependencies',
      [{ resourceId: 'age40001', documentId: world.docs.ageMain! }, { resourceId: 'kaede001' }],
      { filter: { kind: 'tag', tag: 'canon' } },
    ),
    SidebarModel.links('relmiya1', 'Related Sources', [{ resourceId: 'mehran01' }], { kind: 'resourceLink' }),
    { id: 'tagsmiya', kind: 'unsupported', title: 'TAGS' },
  ]);
  sb.page(P.mehrana, [
    SidebarModel.kv('kvmehr01', 'PROPERTIES', [
      ['Reference Type', 'Character Core'],
      ['Status', 'Working'],
      ['Scope', 'Qishen scholar'],
      ['Notes', 'Loose'],
    ]),
    SidebarModel.links('depmehr1', 'Dependencies', []),
  ]);
  sb.page(P.inae, [
    SidebarModel.kv('kvinae01', 'PROPERTIES', [
      ['Reference Type', 'Character Core'],
      ['Status', 'Authoritative'],
      ['Continuity Type', 'CANON'],
      ['Continuity', 'Main'],
      ['Scope', 'Moon elf archer'],
    ]),
  ]);
  sb.page(P.ashgate, [
    SidebarModel.kv('kvashg01', 'PROPERTIES', [
      ['Reference Type', 'General Source'],
      ['Scope', 'A walled town'],
    ]),
    SidebarModel.links('depashg1', 'Dependencies', []),
  ]);
  sb.page(RHEASHIRA.page, [SidebarModel.kvRanked(RHEASHIRA.property, 'PROPERTIES', RHEASHIRA_ROWS)]);
  // Its template, recorded on the page (as C2b records it), in rank order like any template.
  world.repo.seed({
    id: RHEASHIRA.template,
    name: '[BSRC] AI Character Biography',
    parentId: null,
    props: false,
  });
  sb.page(RHEASHIRA.template, [
    SidebarModel.kv(
      'kvtplbio',
      'PROPERTIES',
      BIO_KEYS.map((k) => [k, ''] as [string, string]),
    ),
  ]);
  if (o.build !== false)
    world.stack.db
      .prepare('UPDATE tree_nodes SET template_id = ? WHERE project_id = ? AND id = ?')
      .run(RHEASHIRA.template, PROJECT, RHEASHIRA.page);
  // The Character Core template (outside the root, as templates are).
  world.repo.seed({ id: CORE_TEMPLATE, name: '[BSRC] AI Character Core', parentId: null, props: false });
  sb.page(CORE_TEMPLATE, [
    SidebarModel.kv(
      'kvtplcor',
      'PROPERTIES',
      CORE_KEYS.map((k) => [k, ''] as [string, string]),
    ),
  ]);
  // The Character type maps the Reference Type "Character Core" to that template (A3's registry).
  world.stack.runtime.registry.forProject(PROJECT).commands.createType('owner', {
    singular: 'Character',
    plural: 'Characters',
    rootIndexId: 'chars001',
    placementKind: 'character',
    pageTemplates: [{ role: 'core', templateId: CORE_TEMPLATE }],
  });
  return world;
}

/** The text of a rows list, `key=value` each. */
export const kvText = (rows: { key: string; text: string }[]) => rows.map((r) => `${r.key}=${r.text}`);

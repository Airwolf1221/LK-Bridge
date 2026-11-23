/**
 * v3 F7.1 (ADR 0072): the owners world with the characters the Compact → Core rule is tested on (mock LegendKeeper):
 *
 * - **Emine al-Noor**: a standalone Compact Character Reference under [INDEX] Qishen (no index), holding a portrait in its
 *   visual section and the live wording the owner found ("Compact Main CANON reference for…", "this compact character
 *   reference embeds…", "This compact reference owns…") and one more sentence saying "compact" (listed, never edited);
 * - **Kamigawa Aya**: a Compact Character Reference already at the head of [INDEX] Kamigawa Aya, beside a Chronicle,
 *   with no Art page and no Core;
 * - **Kamigawa Shirahime**: the broken shape (its index, its Compact Character Reference and its Character Art, no Core),
 *   the Reference embedding the same portrait as the Art page;
 * - **Tomo Reed**: a Working Compact Character Reference flat under [INDEX] Working (a direct job at scope write, so
 *   Revert applies).
 */
import { ownersWorld, type OwnersWorld } from '../packs/owners-world.js';
import { C, IDENTITY_KEYS, GENERAL_KEYS, LIFECYCLE } from '../packs/world.js';
import { SidebarModel } from '../resources/world.js';

export const F = {
  emine: 'eminecmp',
  ayaIndex: 'ayaindex',
  aya: 'ayacmp01',
  ayaChron: 'ayachron',
  shiraIndex: 'shiraidx',
  shira: 'shiracmp',
  shiraArt: 'shiraart',
  tomo: 'tomowkcp',
} as const;

export const URL_EMINE = 'https://assets.legendkeeper.com/0b7f3a52-9c1e-4d7e-8f43-6a1d2b3c4d5e.webp';
export const URL_SHIRA = 'https://assets.legendkeeper.com/5aa52e7d-b052-48b2-a5f6-566a113b391f.webp';

const heading = (id: string, level: number, text: string) => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});
const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });
const image = (id: string, url: string, alt: string) => ({ id, kind: 'image', url, alt });

export async function coreWorld(
  o: Parameters<typeof ownersWorld>[0] = {},
  /** The world to build on (the owners world; the audit tests use the automation world, whose snapshots complete). */
  base: (o: Parameters<typeof ownersWorld>[0]) => Promise<OwnersWorld> = ownersWorld,
  /** Whether the portraits are seeded as assets (the audit world leaves them out: its snapshot reads every file). */
  portraits = true,
): Promise<OwnersWorld> {
  const w = await base({
    toolModes: 'seed',
    ...o,
    seed: (world) => {
      const r = world.repo;
      const page = (id: string, name: string, parentId: string, more: Record<string, unknown> = {}) =>
        r.seed({ id, name, parentId, ...more });
      page(F.emine, '[BSRC] Emine al-Noor - Character Reference', C.qishen, {
        referenceType: 'Compact Character Reference',
        canonical: 'Emine al-Noor',
        scope: 'A courier of the Noor house',
        tags: ['CANON', 'Character', 'Qishen'],
      });
      page(F.ayaIndex, '[INDEX] Kamigawa Aya', C.humans);
      page(F.aya, '[BSRC] Kamigawa Aya - Character Reference', F.ayaIndex, {
        referenceType: 'Compact Character Reference',
        canonical: 'Kamigawa Aya',
        scope: 'A shrine maiden',
        tags: ['CANON', 'Character', 'Human'],
      });
      page(F.ayaChron, '[BSRC] Kamigawa Aya - Chronicle', F.ayaIndex, {
        referenceType: 'Character Biography',
        scope: 'Her life',
        tags: ['CANON', 'Character', 'Biography'],
      });
      page(F.shiraIndex, '[INDEX] Kamigawa Shirahime', C.humans);
      page(F.shira, '[BSRC] Kamigawa Shirahime - Character Reference', F.shiraIndex, {
        referenceType: 'Compact Character Reference',
        canonical: 'Kamigawa Shirahime',
        scope: 'A princess of the moon court',
        tags: ['CANON', 'Character', 'Human'],
      });
      page(F.shiraArt, '[BSRC] Kamigawa Shirahime - Character Art', F.shiraIndex, {
        referenceType: 'Character Art',
        scope: 'Her approved visual references',
        tags: ['CANON', 'Character', 'Character Art'],
      });
      page(F.tomo, '[BWRK] Tomo Reed - Character Reference', LIFECYCLE.working, {
        referenceType: 'Compact Character Reference',
        canonical: 'Tomo Reed',
        scope: 'A ferryman',
        tags: ['Working', 'Character', 'Human'],
      });
      for (const [id, race] of [
        [F.emine, 'Qishen'],
        [F.aya, 'Human'],
        [F.shira, 'Human'],
        [F.tomo, 'Human'],
      ] as const)
        r.outside.setRow(id, 'Race / Species', race);
      const body = (id: string, blocks: unknown[]) => {
        const main = r.liveDocs(r.live(id)!).find((d) => d.name === 'Main')!;
        r.blocks.set(main.id, { version: 2, blocks });
      };
      body(F.emine, [
        heading('em1', 2, 'Purpose'),
        para('em2', 'Compact Main CANON reference for Emine al-Noor, a courier of the Noor house.'),
        heading('em3', 2, 'Visual Disposition'),
        para('em4', 'This compact character reference embeds the image below.'),
        image('em5', URL_EMINE, 'Primary Reference - Portrait'),
        para('em6', 'Her green scarf and the courier’s satchel.'),
        heading('em7', 2, 'Source Boundaries'),
        para('em8', 'This compact reference owns her identity. A compact build, light on her feet.'),
      ]);
      body(F.aya, [
        heading('ay1', 2, 'Purpose'),
        para('ay2', 'The compact reference for Kamigawa Aya.'),
        heading('ay3', 2, 'Source Boundaries'),
        para('ay4', 'Identity only.'),
      ]);
      body(F.ayaChron, [heading('ac1', 2, 'Purpose'), para('ac2', 'The chronicle of Kamigawa Aya.')]);
      body(F.shira, [
        heading('sh1', 2, 'Purpose'),
        para('sh2', 'The Compact Character Reference for Kamigawa Shirahime.'),
        heading('sh3', 2, 'Visual Disposition'),
        image('sh4', URL_SHIRA, 'Primary Reference - Portrait'),
        para('sh5', 'Silver hair, the moon court’s white.'),
        heading('sh6', 2, 'Source Boundaries'),
        para('sh7', 'Identity only.'),
      ]);
      body(F.shiraArt, [
        heading('sa1', 2, 'Purpose'),
        para('sa2', 'Her approved visual references; her character reference owns her identity.'),
        heading('sa3', 2, 'Reference Images'),
        heading('sa4', 3, 'Primary Reference - Portrait'),
        image('sa5', URL_SHIRA, 'Primary Reference - Portrait'),
        para('sa6', 'Silver hair.'),
        heading('sa7', 2, 'Source Boundaries'),
        para('sa8', 'Visual references only; the character reference images stay here.'),
      ]);
      body(F.tomo, [
        heading('tm1', 2, 'Purpose'),
        para('tm2', 'The compact reference for Tomo Reed.'),
        heading('tm3', 2, 'Source Boundaries'),
        para('tm4', 'Identity only.'),
      ]);
      o.seed?.(world);
    },
  });
  // The identity pages' sidebars, as the fixtures' own.
  const identity = (id: string, v: Record<string, string>) =>
    w.sidebars.page(id, [
      SidebarModel.kv(
        `kv${id}`.slice(0, 8),
        'PROPERTIES',
        IDENTITY_KEYS.map((k) => [k, v[k] ?? '']),
      ),
      SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
      SidebarModel.links(`rl${id}`.slice(0, 8), 'Related Sources', []),
      { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
    ]);
  const general = (id: string, v: Record<string, string>) =>
    w.sidebars.page(id, [
      SidebarModel.kv(
        `kv${id}`.slice(0, 8),
        'PROPERTIES',
        GENERAL_KEYS.map((k) => [k, v[k] ?? '']),
      ),
      SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
      SidebarModel.links(`rl${id}`.slice(0, 8), 'Related Sources', []),
      { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
    ]);
  const canon = {
    Status: 'Authoritative',
    'Continuity Type': 'CANON',
    Continuity: 'Main',
    Inheritance: 'None',
  };
  const person = (
    subject: string,
    given: string,
    surname: string,
    culture: string,
    race: string,
    scope: string,
  ) => ({
    Subject: subject,
    'Canonical Display Name': subject,
    'Personal / Given Name': given,
    'Family / Surname': surname,
    'Naming Culture': culture,
    'Reference Type': 'Compact Character Reference',
    Scope: scope,
    'Race / Species': race,
    'Life State': 'Alive at 5A 931',
    'Temporal Scope': '5A 900 - 5A 931',
    'Last Major Revision': '2026-11-01',
    Supersedes: 'None',
  });
  identity(F.emine, {
    ...canon,
    ...person('Emine al-Noor', 'Emine', 'al-Noor', 'Menkheti', 'Qishen', 'A courier of the Noor house'),
  });
  identity(F.aya, {
    ...canon,
    ...person('Kamigawa Aya', 'Aya', 'Kamigawa', 'Fujimatsuan', 'Human', 'A shrine maiden'),
  });
  identity(F.shira, {
    ...canon,
    ...person(
      'Kamigawa Shirahime',
      'Shirahime',
      'Kamigawa',
      'Fujimatsuan',
      'Human',
      'A princess of the moon court',
    ),
  });
  identity(F.tomo, {
    Status: 'Working',
    'Continuity Type': 'CANON',
    Continuity: 'Main',
    Inheritance: 'None',
    ...person('Tomo Reed', 'Tomo', 'Reed', 'Velaran', 'Human', 'A ferryman'),
  });
  general(F.ayaChron, {
    ...canon,
    Subject: 'Kamigawa Aya',
    'Reference Type': 'Character Biography',
    Scope: 'Her life',
    Supersedes: 'None',
  });
  general(F.shiraArt, {
    ...canon,
    Subject: 'Kamigawa Shirahime',
    'Reference Type': 'Character Art',
    Scope: 'Her approved visual references',
    Supersedes: 'None',
  });
  // The portraits are assets of the project (the asset tree knows them).
  if (portraits) {
    w.assets.image('Emine al-Noor - Primary Reference - Portrait', null, { url: URL_EMINE });
    w.assets.image('Kamigawa Shirahime - Primary Reference - Portrait', null, { url: URL_SHIRA });
  }
  return w;
}

/** A Biography package page (a specialist owner). */
export const biography = (scope = 'Her life') => ({
  role: 'specialist',
  title: 'Biography',
  specialistTag: 'Biography',
  referenceType: 'Character Biography',
  scope,
  markdown:
    '## Purpose\n\nHer life.\n\n## Early Life\n\nThe house.\n\n## Source Boundaries\n\nThis page only.\n\n## Unresolved Material\n\nNone yet.\n',
});

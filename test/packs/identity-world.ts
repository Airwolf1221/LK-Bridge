/**
 * v3 F5c (ADR 0069, H6): `arkona_identity_reconcile`'s test world, modelled on the Menkheti culture split ChatGPT met
 * on live Arkona (its report after several days at write scope): several characters' Naming Culture changes, each with
 * its culture token in the pack's maps, built from the shapes the report quotes, never fetched. The retag world (the
 * REAL server, runtime, MCP transport, policy and engine against the mock LegendKeeper, the Arkona pack approved with
 * its retag rules), plus:
 *
 * - **Al-Mansur XII** (an [INDEX] with his Character Core and a Biography restating his Naming Culture, so a consistency
 *   follow-up appears once the Core changes): Menkheti → Ancient Menkheti; his Core carries a Last Major Revision row;
 * - **Arin al-Jamail**: Menkheti → Orzheni;
 * - **Azar al-Nafir**, a Genie whose tags are out of grammar order and carry the Approved Supplementary Tag Cosmology:
 *   Menkheti → Khayali, so the tags come out CANON, Character, Genie, Khayali, Cosmology (H3's ordering, H1's tag kept);
 * - **Zahira al-Rachid**, whose Race / Species (Shadeborn) has no race token: her tags are a hold (the facts are still
 *   written);
 * - **Daryan Sefet**, reached through his [INDEX] (to his Core), and **Khepri Nadu**, a Compact Character Reference;
 * - twelve plain characters of the Menkheti desk (`bulk`), for the rails (10 run directly, 11 are a proposal).
 *
 * The approved pack version maps Ancient Menkheti, Orzheni and Khayali (culture) and Genie (race), as the owner would add
 * them on the Packs page.
 */
import { ROOT } from '../discover/world.js';
import { PROJECT } from '../tools/helpers.js';
import { retagWorld, type RetagWorld } from './retag-world.js';

export { PROJECT };

export const M = {
  desk: 'mkdesk01',
  mansurIndex: 'mkmanidx',
  mansur: 'mkmansur',
  mansurBio: 'mkmanbio',
  arin: 'mkarin01',
  azar: 'mkazar01',
  zahira: 'mkzahira',
  daryanIndex: 'mkdaridx',
  daryan: 'mkdaryan',
  khepri: 'mkkhepri',
  /** An AU character (Continuity Type AU, Continuity Shattered Crown), for query_facts' continuity. */
  auChar: 'mkauchar',
} as const;

/** The bulk characters' ids (`mkbulk01` …). */
export const BULK = Array.from({ length: 12 }, (_, i) => `mkbulk${String(i + 1).padStart(2, '0')}`);
export const bulkName = (i: number) => `Sefet Ombra ${['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'][i]}`;

const CANON_ROWS: [string, string][] = [
  ['Status', 'Authoritative'],
  ['Continuity Type', 'CANON'],
  ['Continuity', 'Main'],
  ['Inheritance', 'None'],
];

export type IdentityWorld = RetagWorld;

export async function identityWorld(): Promise<IdentityWorld> {
  const w = await retagWorld({
    seed: (world) => {
      const r = world.repo;
      const page = (
        id: string,
        name: string,
        parentId: string,
        tags: string[],
        referenceType: string,
        rows: [string, string][],
      ) => {
        r.seed({ id, name, parentId, tags, referenceType });
        for (const [k, v] of rows) r.outside.setRow(id, k, v);
      };
      const identity = (race: string, culture: string, more: [string, string][] = []): [string, string][] => [
        ...CANON_ROWS,
        ['Race / Species', race],
        ['Naming Culture', culture],
        ['Life State', 'Alive'],
        ...more,
      ];
      r.seed({ id: M.desk, name: '[INDEX] Menkheti Desk', parentId: ROOT });
      r.seed({ id: M.mansurIndex, name: '[INDEX] Al-Mansur XII', parentId: M.desk });
      page(
        M.mansur,
        '[BSRC] Al-Mansur XII - Character Core',
        M.mansurIndex,
        ['CANON', 'Character', 'Human', 'Menkheti'],
        'Character Core',
        identity('Human', 'Menkheti', [
          ['Subject', 'Al-Mansur XII'],
          ['Last Major Revision', '2026-01-01'],
        ]),
      );
      page(
        M.mansurBio,
        '[BSRC] Al-Mansur XII - Biography',
        M.mansurIndex,
        ['CANON', 'Character', 'Biography'],
        'Character Biography',
        [...CANON_ROWS, ['Subject', 'Al-Mansur XII'], ['Naming Culture', 'Menkheti']],
      );
      page(
        M.arin,
        '[BSRC] Arin al-Jamail - Character Core',
        M.desk,
        ['CANON', 'Character', 'Human', 'Menkheti'],
        'Character Core',
        identity('Human', 'Menkheti'),
      );
      page(
        M.azar,
        '[BSRC] Azar al-Nafir - Character Core',
        M.desk,
        ['CANON', 'Cosmology', 'Character', 'Menkheti', 'Genie'],
        'Character Core',
        identity('Genie', 'Menkheti'),
      );
      page(
        M.zahira,
        '[BSRC] Zahira al-Rachid - Character Core',
        M.desk,
        ['CANON', 'Character', 'Menkheti'],
        'Character Core',
        identity('Shadeborn', 'Menkheti'),
      );
      r.seed({ id: M.daryanIndex, name: '[INDEX] Daryan Sefet', parentId: M.desk });
      page(
        M.daryan,
        '[BSRC] Daryan Sefet - Character Core',
        M.daryanIndex,
        ['CANON', 'Character', 'Human', 'Menkheti'],
        'Character Core',
        identity('Human', 'Menkheti'),
      );
      page(
        M.khepri,
        '[BSRC] Khepri Nadu - Character Reference',
        M.desk,
        ['CANON', 'Character', 'Human', 'Menkheti'],
        'Compact Character Reference',
        identity('Human', 'Menkheti'),
      );
      page(M.auChar, '[BSRC] Mehrana Sefet - Character Core', M.desk, ['AU', 'Character', 'Human', 'Menkheti'], 'Character Core', [
        ['Status', 'Authoritative'],
        ['Continuity Type', 'AU'],
        ['Continuity', 'Shattered Crown'],
        ['Inheritance', 'None'],
        ['Race / Species', 'Human'],
        ['Naming Culture', 'Menkheti'],
      ]);
      BULK.forEach((id, i) =>
        page(
          id,
          `[BSRC] ${bulkName(i)} - Character Core`,
          M.desk,
          ['CANON', 'Character', 'Human', 'Menkheti'],
          'Character Core',
          identity('Human', 'Menkheti'),
        ),
      );
    },
  });
  // The owner's new tokens, approved (as on the Packs page).
  const packs = w.stack.runtime.packs;
  const pack = packs.get('arkona')!;
  const next = packs.store.newVersion(
    'arkona',
    {
      ...pack.rules,
      tags: {
        ...pack.rules.tags,
        race: { ...pack.rules.tags.race, Genie: 'Genie' },
        culture: {
          ...pack.rules.tags.culture,
          'Ancient Menkheti': 'Ancient Menkheti',
          Orzheni: 'Orzheni',
          Khayali: 'Khayali',
        },
      },
    },
    'test: the Menkheti split’s tokens',
  );
  packs.store.approve('arkona', {
    version: next.version,
    at: Date.now(),
    by: 'owner',
    sources: pack.approved?.sources ?? [],
  });
  return w;
}

/** A mock page's tags and PROPERTIES rows now. */
export function pageNow(w: IdentityWorld, id: string): { tags: string[]; rows: Record<string, string>; name: string } {
  const r = w.repo.live(id)!;
  const p = r.props.find((x) => x.kind === 'keyValue' && x.title === 'PROPERTIES')!;
  return { tags: [...r.tags], rows: Object.fromEntries(p.rows.map((x) => [x.key, x.text])), name: r.name };
}

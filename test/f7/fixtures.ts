/**
 * v3 F7 (ADR 0070): the owner's live art layouts on 23 November 2026, after the owner's cleanup (from the design's
 * evidence), as a library view: Soraya bint al-Noor and Mehrana al-Khalid.
 */
import type { LibItem, LibFolder, LibraryView } from '../../src/art/layout.js';

export interface FixtureLibrary extends LibraryView {
  readonly folderRows: Map<string, LibFolder & { parentId: string | null }>;
  readonly itemRows: Map<string, LibItem & { folderId: string }>;
  folderId(path: string): string;
}

export function library(tree: Record<string, unknown>): FixtureLibrary {
  const folderRows = new Map<string, LibFolder & { parentId: string | null }>();
  const itemRows = new Map<string, LibItem & { folderId: string }>();
  let n = 0;
  const walk = (node: Record<string, unknown>, parentId: string | null, path: string[]) => {
    for (const [name, v] of Object.entries(node)) {
      if (Array.isArray(v)) {
        // A folder whose value is a list holds those items only.
        const id = `f${++n}`;
        folderRows.set(id, { id, name, parentId });
        for (const it of v as string[]) {
          const iid = `a${++n}`;
          itemRows.set(iid, { id: iid, name: it, folderId: id });
        }
      } else if (typeof v === 'object' && v !== null) {
        const id = `f${++n}`;
        folderRows.set(id, { id, name, parentId });
        const items = (v as { _items?: string[] })._items ?? [];
        for (const it of items) {
          const iid = `a${++n}`;
          itemRows.set(iid, { id: iid, name: it, folderId: id });
        }
        const rest = Object.fromEntries(Object.entries(v).filter(([k]) => k !== '_items'));
        walk(rest, id, [...path, name]);
      }
    }
  };
  walk(tree, null, []);
  const pathOf = (id: string): string[] => {
    const f = folderRows.get(id)!;
    return f.parentId ? [...pathOf(f.parentId), f.name] : [f.name];
  };
  return {
    folderRows,
    itemRows,
    folder: (id) => {
      const f = folderRows.get(id);
      return f ? { id: f.id, name: f.name, path: pathOf(id) } : null;
    },
    folders: (parentId) =>
      [...folderRows.values()]
        .filter((f) => f.parentId === parentId)
        .map((f) => ({ id: f.id, name: f.name })),
    items: (folderId) => [...itemRows.values()].filter((i) => i.folderId === folderId),
    folderId: (path) => {
      const want = path.split(' / ');
      const hit = [...folderRows.keys()].find((id) => pathOf(id).join(' / ') === want.join(' / '));
      if (!hit) throw new Error(`no folder ${path}`);
      return hit;
    },
  };
}

const S = 'Soraya bint al-Noor';
const M = 'Mehrana al-Khalid';

export const SORAYA_WARDROBE_LOOSE = [
  'Autumn Blossom Kimono',
  "Lu'lu'at al-Qamar",
  'Moonflower Yukata',
  'Shadowed Jade Kimono',
  'Sun-Crowned Imperial Kimono',
];

export function sorayaTree(): Record<string, unknown> {
  return {
    Characters: {
      Humans: {
        Rangawan: {
          [S]: {
            _items: [
              `${S} - Primary Reference - Character Portrait`,
              `${S} - Primary Reference - Full Body`,
              `${S} - Primary Reference - Profile`,
              `${S} - Primary Reference - Expression Sheet`,
            ],
            Wardrobe: {
              _items: SORAYA_WARDROBE_LOOSE.map((o) => `${S} - ${o} - Outfit Reference - Front`),
              'Jade Moon Kimono': Array.from(
                { length: 8 },
                (_, i) => `${S} - Jade Moon Kimono - Outfit Reference - View ${i + 1}`,
              ),
            },
          },
        },
      },
    },
  };
}

export function mehranaTree(): Record<string, unknown> {
  const two = (o: string) => [
    `${M} - ${o} - Outfit Reference - Front`,
    `${M} - ${o} - Outfit Reference - Back`,
  ];
  return {
    Characters: {
      Beastkin: {
        Qishen: {
          [M]: {
            _items: [`${M} - Primary Reference`],
            Wardrobe: {
              _items: [
                `${M} - Maid Uniform`,
                `${M} - Military Attire + Sovereign's Measure`,
                `${M} - Rangawan Archer`,
                `${M} - Rangawan Qipao`,
                `${M} - Supreme Imperial Regalia - Magenta Ayullid Ensemble`,
              ],
              'Al-Ghalian Uniform': two('Al-Ghalian Uniform'),
              'Ayullid Harem Attire': two('Ayullid Harem Attire'),
              'Sapphire Rose Gown': two('Sapphire Rose Gown'),
              'Wedding Dress': two('Wedding Dress'),
            },
          },
        },
      },
    },
  };
}

export const SORAYA = S;
export const MEHRANA = M;

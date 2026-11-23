/**
 * v3 F7 (ADR 0070; design G2, G3, G7): a character's art folder as it is laid out:
 *
 * ```
 * Characters / <…> / <Character>/                      design pieces ("<Character> - <Label>")
 * Characters / <…> / <Character>/Wardrobe/             single-piece outfits ("<Character> - <Outfit> - <Label>")
 * Characters / <…> / <Character>/Wardrobe/<Outfit>/    outfits with two or more pieces (the same name pattern)
 * ```
 *
 * plus the legacy Forms, Outfits and Details folders (G6, G7). Read from any view of the asset library (the asset tree,
 * after a live refresh of the character's folder, G9; or the audits' copy of it).
 */
import { looseOutfitOf, outfitKey, type OutfitNames } from './names.js';
import type { SeedOutfit, SeedResult } from './store.js';

export const WARDROBE = 'Wardrobe';
/** The folders F7 retired (G6): never created again, emptied ones deleted on the owner's approval (G7). */
export const LEGACY_FOLDERS: readonly string[] = ['Forms', 'Outfits', 'Details'];

export const isLegacyName = (name: string): boolean =>
  LEGACY_FOLDERS.some((x) => outfitKey(x) === outfitKey(name));
export const isWardrobeName = (name: string): boolean => outfitKey(name) === outfitKey(WARDROBE);

export interface LibItem {
  readonly id: string;
  readonly name: string;
  readonly url?: string | null;
}
export interface LibFolder {
  readonly id: string;
  readonly name: string;
}

/** What the layout reads: a folder's direct subfolders and items (null: the library's root). */
export interface LibraryView {
  folder(id: string): (LibFolder & { readonly path: readonly string[] }) | null;
  folders(parentId: string): readonly LibFolder[];
  items(folderId: string): readonly LibItem[];
}

export interface OutfitFolder {
  readonly id: string;
  readonly name: string;
  readonly items: readonly LibItem[];
  readonly subfolders: readonly LibFolder[];
}

export interface LegacyFolder {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  /** Every item inside it, at any depth. */
  readonly items: readonly LibItem[];
  /** Its folders, deepest first (to delete an empty one after them). */
  readonly folders: readonly { readonly id: string; readonly path: string }[];
}

export interface ArtLayout {
  readonly character: { readonly id: string; readonly name: string; readonly path: readonly string[] };
  readonly root: readonly LibItem[];
  readonly wardrobe: LibFolder | null;
  /** More than one Wardrobe folder (the duplicate-folders audit's): only the first is used. */
  readonly extraWardrobes: readonly LibFolder[];
  readonly loose: readonly LibItem[];
  readonly outfitFolders: readonly OutfitFolder[];
  readonly legacy: readonly LegacyFolder[];
}

function within(lib: LibraryView, id: string, path: string): LegacyFolder['folders'][number][] {
  const out: { id: string; path: string }[] = [];
  for (const f of lib.folders(id)) {
    const p = `${path} / ${f.name}`;
    out.push(...within(lib, f.id, p), { id: f.id, path: p });
  }
  return out;
}

function itemsBelow(lib: LibraryView, id: string): LibItem[] {
  return [...lib.items(id), ...lib.folders(id).flatMap((f) => itemsBelow(lib, f.id))];
}

/** The layout of one character's folder, or null when the view does not hold the folder. */
export function readLayout(lib: LibraryView, characterFolderId: string): ArtLayout | null {
  const top = lib.folder(characterFolderId);
  if (!top) return null;
  const subs = lib.folders(characterFolderId);
  const wardrobes = subs.filter((f) => isWardrobeName(f.name));
  const wardrobe = wardrobes[0] ?? null;
  const base = top.path.join(' / ');
  const legacy: LegacyFolder[] = [];
  const legacyAt = (parent: string, parentPath: string) => {
    for (const f of lib.folders(parent)) {
      if (!isLegacyName(f.name)) continue;
      const path = `${parentPath} / ${f.name}`;
      legacy.push({
        id: f.id,
        name: f.name,
        path,
        items: itemsBelow(lib, f.id),
        folders: within(lib, f.id, path),
      });
    }
  };
  legacyAt(characterFolderId, base);
  if (wardrobe) legacyAt(wardrobe.id, `${base} / ${wardrobe.name}`);
  return {
    character: { id: top.id, name: top.name, path: top.path },
    root: lib.items(characterFolderId),
    wardrobe,
    extraWardrobes: wardrobes.slice(1),
    loose: wardrobe ? lib.items(wardrobe.id) : [],
    outfitFolders: wardrobe
      ? lib
          .folders(wardrobe.id)
          .filter((f) => !isLegacyName(f.name))
          .map((f) => ({ id: f.id, name: f.name, items: lib.items(f.id), subfolders: lib.folders(f.id) }))
      : [],
    legacy,
  };
}

/**
 * G3's seeding rules over a layout (never a guess): a `Wardrobe/<X>` folder is outfit X with its pieces; a loose
 * Wardrobe piece named `<Character> - <Outfit>[ - <Descriptor>]` is that outfit; anything else is listed as ambiguous.
 * `character` is the character's full canonical name (its folder's name by default).
 */
export function seedFromLayout(
  layout: ArtLayout,
  character = layout.character.name,
): Pick<SeedResult, 'outfits' | 'ambiguous' | 'wardrobeFolderId'> {
  const outfits: SeedOutfit[] = [];
  const ambiguous: { assetId: string; name: string; why: string }[] = [];
  const byKey = new Map<string, number>();
  for (const f of layout.outfitFolders) {
    if (byKey.has(outfitKey(f.name))) {
      ambiguous.push({ assetId: f.id, name: f.name, why: 'another Wardrobe folder has the same name' });
      continue;
    }
    for (const sub of f.subfolders)
      ambiguous.push({
        assetId: sub.id,
        name: `${f.name} / ${sub.name}`,
        why: 'a folder inside an outfit folder',
      });
    byKey.set(outfitKey(f.name), outfits.length);
    outfits.push({
      name: f.name,
      folderId: f.id,
      pieces: f.items.map((i) => ({ assetId: i.id, name: i.name })),
      from: `folder ${WARDROBE} / ${f.name}`,
    });
  }
  const loose = new Map<string, { name: string; pieces: { assetId: string; name: string }[] }>();
  for (const it of layout.loose) {
    const o = looseOutfitOf(it.name, character);
    if ('ambiguous' in o) {
      ambiguous.push({ assetId: it.id, name: it.name, why: o.ambiguous });
      continue;
    }
    const k = outfitKey(o.outfit);
    if (byKey.has(k)) {
      ambiguous.push({
        assetId: it.id,
        name: it.name,
        why: `a loose piece of “${o.outfit}”, which also has its folder`,
      });
      continue;
    }
    const cur = loose.get(k) ?? { name: o.outfit, pieces: [] };
    cur.pieces.push({ assetId: it.id, name: it.name });
    loose.set(k, cur);
  }
  for (const v of loose.values())
    outfits.push({
      name: v.name,
      folderId: null,
      pieces: v.pieces,
      from: v.pieces.length === 1 ? `loose piece “${v.pieces[0]!.name}”` : `${v.pieces.length} loose pieces`,
    });
  for (const l of layout.legacy)
    if (l.items.length > 0)
      ambiguous.push({
        assetId: l.id,
        name: l.path,
        why: `a legacy ${l.name} folder holding ${l.items.length} asset(s): not read as outfits`,
      });
  outfits.sort((a, b) => outfitKey(a.name).localeCompare(outfitKey(b.name)));
  return { outfits, ambiguous, wardrobeFolderId: layout.wardrobe?.id ?? null };
}

/** An outfit as placement sees it: the record's, or one read from the layout by the seeding rules. */
export interface KnownOutfit extends OutfitNames {
  readonly recordId: string | null;
  readonly folderId: string | null;
  readonly pieceIds: readonly string[];
}

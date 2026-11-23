/**
 * v3 F7 (ADR 0070; design G1 and G2): where one `arkona_add_character_art` call puts its images. The bridge decides,
 * from the character's folders read live (G9) and its outfit record (G3):
 *
 * - no outfit: a design piece, always in the character's own folder;
 * - an outfit: the pieces already recorded (live) plus those arriving make its total. An outfit with its own folder
 *   takes them there; otherwise a total of 1 goes loose in `Wardrobe`, and 2 or more go in `Wardrobe/<Outfit>`, made
 *   when missing, with the loose piece moved into it in the same job.
 *
 * `Wardrobe` is made on first use. No other folder is ever made, and an outfit can never be named Wardrobe, Forms,
 * Outfits or Details (G6).
 */
import type { ArtLayout, KnownOutfit, LibItem } from './layout.js';
import { isLegacyName, isWardrobeName, seedFromLayout, WARDROBE } from './layout.js';
import { looseOutfitOf, matchOutfit, outfitKey, SEP } from './names.js';
import type { OutfitRecord } from './store.js';

export interface PlacementRequest {
  /** The character's full canonical name (G4). */
  readonly character: string;
  /** The character's folder as read live; null when it does not exist yet. */
  readonly layout: ArtLayout | null;
  readonly records: readonly OutfitRecord[];
  readonly outfit: string | null | undefined;
  readonly newOutfit?: boolean | undefined;
  /** How many images the call adds. */
  readonly arriving: number;
}

export type Placement =
  | { readonly ok: true; readonly kind: 'design'; readonly subfolders: readonly string[] }
  | {
      readonly ok: true;
      readonly kind: 'outfit';
      readonly outfit: {
        readonly name: string;
        readonly aliases: readonly string[];
        readonly recordId: string | null;
        /** Where the outfit was known from: its record, the folders (read by the seeding rules), or new. */
        readonly source: 'record' | 'layout' | 'new';
        /** The name or alias the call matched. */
        readonly via: string | null;
      };
      /** `wardrobe`: loose in Wardrobe; `folder`: in Wardrobe/<Outfit>. */
      readonly into: 'wardrobe' | 'folder';
      /** The folder chain under the character's folder. */
      readonly subfolders: readonly string[];
      /** The outfit's folder, when it exists now. */
      readonly folderId: string | null;
      /** The pieces it already has (live). */
      readonly existing: readonly LibItem[];
      /** The loose pieces moved into the new folder (the total crossed from 1 to 2 or more). */
      readonly moves: readonly LibItem[];
      readonly total: number;
      readonly notes: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly candidates?: readonly { readonly name: string; readonly via: string; readonly why: string }[];
    };

/** The outfits a character has: its records, and those the seeding rules read from its folders that no record names. */
export function knownOutfits(
  layout: ArtLayout | null,
  records: readonly OutfitRecord[],
  character: string,
): KnownOutfit[] {
  const out: KnownOutfit[] = records.map((r) => ({
    id: r.id,
    name: r.name,
    aliases: r.aliases,
    recordId: r.id,
    folderId: r.folderId,
    pieceIds: r.pieces.map((p) => p.assetId),
  }));
  if (!layout) return out;
  const names = (o: KnownOutfit) => [o.name, ...o.aliases].map(outfitKey);
  for (const s of seedFromLayout(layout, character).outfits) {
    const k = outfitKey(s.name);
    if (out.some((o) => names(o).includes(k))) continue;
    out.push({
      id: `layout:${s.folderId ?? k}`,
      name: s.name,
      aliases: [],
      recordId: null,
      folderId: s.folderId,
      pieceIds: s.pieces.map((p) => p.assetId),
    });
  }
  return out;
}

/** Why an outfit name cannot be used, or null. */
export function outfitNameProblem(name: string): string | null {
  const n = name.replace(/\s+/g, ' ').trim();
  if (n === '') return 'an outfit needs a name';
  if (isWardrobeName(n) || isLegacyName(n))
    return `“${n}” is a folder of the art layout (Wardrobe, Forms, Outfits or Details), not an outfit’s name`;
  if (n.includes('/')) return 'an outfit’s name cannot hold “/” (it is one folder, not a path)';
  if (n.includes(SEP))
    return 'an outfit’s name cannot hold “ - ” (it separates the parts of an asset’s name)';
  if (n.length > 100) return 'an outfit’s name is at most 100 characters';
  return null;
}

export function decidePlacement(r: PlacementRequest): Placement {
  if (r.outfit === undefined || r.outfit === null) return { ok: true, kind: 'design', subfolders: [] };
  const given = r.outfit.replace(/\s+/g, ' ').trim();
  const bad = outfitNameProblem(given);
  if (bad) return { ok: false, code: 'OUTFIT_NAME_INVALID', message: `outfit: ${bad}.` };
  const known = knownOutfits(r.layout, r.records, r.character);
  const m = matchOutfit(given, known);
  if (m.kind === 'near' && r.newOutfit !== true)
    return {
      ok: false,
      code: 'OUTFIT_NEAR_MATCH',
      message: `outfit “${given}” is close to ${m.candidates.map((c) => `“${c.outfit.name}”${c.via !== c.outfit.name ? ` (alias “${c.via}”)` : ''}`).join(', ')} but is not the same. Pass that outfit’s exact name (or an alias) to add to it, or newOutfit: true if “${given}” really is another outfit.`,
      candidates: m.candidates.map((c) => ({ name: c.outfit.name, via: c.via, why: c.why })),
    };
  const notes: string[] = [];
  const o = m.kind === 'same' ? m.outfit : null;
  const name = o?.name ?? given;
  const keys = new Set([name, ...(o?.aliases ?? [])].map(outfitKey));
  const layout = r.layout;
  // Its folder, live: the recorded one if it is still under Wardrobe, else a Wardrobe folder of its name or alias.
  const folder =
    (o?.folderId ? layout?.outfitFolders.find((f) => f.id === o.folderId) : undefined) ??
    layout?.outfitFolders.find((f) => keys.has(outfitKey(f.name))) ??
    null;
  if (o?.folderId && folder && folder.id !== o.folderId)
    notes.push(`The recorded folder of “${name}” is gone; its folder “${folder.name}” (read now) is used.`);
  let existing: LibItem[];
  if (folder) existing = [...folder.items];
  else {
    const ids = new Set(o?.pieceIds ?? []);
    existing = (layout?.loose ?? []).filter((it) => {
      if (ids.has(it.id)) return true;
      const lo = looseOutfitOf(it.name, r.character);
      return !('ambiguous' in lo) && keys.has(outfitKey(lo.outfit));
    });
    const gone = [...ids].filter((id) => !existing.some((e) => e.id === id));
    if (gone.length > 0)
      notes.push(
        `${gone.length} recorded piece(s) of “${name}” are no longer loose in Wardrobe (read now); not counted.`,
      );
  }
  const total = existing.length + r.arriving;
  const outfit = {
    name,
    aliases: o?.aliases ?? [],
    recordId: o && 'recordId' in o ? o.recordId : null,
    source: sourceOf(o),
    via: m.kind === 'same' ? m.via : null,
  };
  if (folder)
    return {
      ok: true,
      kind: 'outfit',
      outfit,
      into: 'folder',
      subfolders: [wardrobeName(layout), folder.name],
      folderId: folder.id,
      existing,
      moves: [],
      total,
      notes,
    };
  if (total <= 1)
    return {
      ok: true,
      kind: 'outfit',
      outfit,
      into: 'wardrobe',
      subfolders: [wardrobeName(layout)],
      folderId: null,
      existing,
      moves: [],
      total,
      notes,
    };
  return {
    ok: true,
    kind: 'outfit',
    outfit,
    into: 'folder',
    subfolders: [wardrobeName(layout), name],
    folderId: null,
    existing,
    moves: existing,
    total,
    notes,
  };
}

/** The Wardrobe folder's own name as it is (case as stored), else `Wardrobe`. */
function wardrobeName(layout: ArtLayout | null): string {
  return layout?.wardrobe?.name ?? WARDROBE;
}

/** Where an outfit was known from (G3): its record, the folders read by the seeding rules, or nowhere (new). */
function sourceOf(o: KnownOutfit | null): 'record' | 'layout' | 'new' {
  if (!o) return 'new';
  return o.recordId ? 'record' : 'layout';
}

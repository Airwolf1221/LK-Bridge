/**
 * v3 F7 (ADR 0070; design G7): the art layout check (category `assets`, read-only). Per character asset folder (a
 * folder under the library's Characters folder that holds a Wardrobe, a Forms, Outfits or Details folder, or an asset
 * named after it), against the layout the owner set (src/art/layout.ts):
 *
 * - `art_outfit_folder_single`: an outfit folder with one piece. Fix: move the piece into Wardrobe, delete the folder.
 * - `art_loose_outfit_pieces`: two or more loose Wardrobe pieces of one outfit (by the outfit record, else by name).
 *   Fix: make Wardrobe/<Outfit> (found when it exists) and move them in.
 * - `art_legacy_folder_empty`: an empty Forms, Outfits or Details folder. Fix: delete it (its empty folders first).
 * - `art_legacy_folder_holds_assets`: such a folder that still holds assets. Listed for the owner; no fix.
 * - `art_asset_name`: a name that breaks G4. Fix: the rename, where the bridge can say it without guessing (a file
 *   extension dropped; an outfit folder's piece given its outfit); else listed. A loose `<Character> - <Outfit>` piece
 *   with no label is valid.
 * - `art_stale_folder_ref`: a line on ANY of the character's pages (every page under its repository index, the index
 *   too) naming a folder path under the character's folder that no longer exists, or the id of a folder that is no
 *   longer the character's (deleted, or now elsewhere: its current name and place suggested). Fix: a path's line updated
 *   where it matches exactly and the folder's new place is certain (one folder of the path's last name under the
 *   character's folder now); otherwise listed for the owner with the suggestion.
 *
 * Read from the bridge's asset tree and the snapshots (no LegendKeeper read). Every fix re-reads its targets LIVE
 * (G9) when it is proposed, and is ONE proposal the owner approves (G7: every move, rename or delete the bridge makes on
 * its own initiative is a proposal); the automation's per-code setting can switch a code Off or to Propose, never to
 * Apply.
 */
import {
  readLayout,
  isLegacyName,
  isWardrobeName,
  type ArtLayout,
  type LibraryView,
} from '../../art/layout.js';
import { fixedName, looseOutfitOf, nameProblem, outfitKey } from '../../art/names.js';
import type { OutfitRecord } from '../../art/store.js';
import type { AuditContext } from '../context.js';
import type { FindingDraft } from '../types.js';
import type { AssetLibrary } from './assets.js';

type Obj = Record<string, unknown>;

export const ART_CODES = [
  'art_outfit_folder_single',
  'art_loose_outfit_pieces',
  'art_legacy_folder_empty',
  'art_legacy_folder_holds_assets',
  'art_asset_name',
  'art_stale_folder_ref',
] as const;

/** A library view over the audits' copy of the asset tree. */
export function auditLibraryView(lib: AssetLibrary): LibraryView {
  const byId = new Map(lib.folders.map((f) => [f.id, f]));
  const kids = new Map<string | null, { id: string; name: string }[]>();
  for (const f of lib.folders)
    kids.set(f.parentId, [...(kids.get(f.parentId) ?? []), { id: f.id, name: f.name }]);
  const items = new Map<string | null, { id: string; name: string }[]>();
  for (const i of lib.items)
    items.set(i.folderId, [...(items.get(i.folderId) ?? []), { id: i.id, name: i.name }]);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    folder: (id) => {
      const f = byId.get(id);
      return f ? { id: f.id, name: f.name, path: f.path } : null;
    },
    folders: (parentId) => [...(kids.get(parentId) ?? [])].sort(byName),
    items: (folderId) => [...(items.get(folderId) ?? [])].sort(byName),
  };
}

/** The character folders of a library: under a top-level "Characters" folder, holding the art layout's marks. */
export function characterFolders(lib: AssetLibrary, view: LibraryView): string[] {
  const out: string[] = [];
  for (const f of lib.folders) {
    if (f.path.length < 2 || outfitKey(f.path[0]!) !== 'characters') continue;
    if (isWardrobeName(f.name) || isLegacyName(f.name)) continue;
    const parent = f.parentId ? view.folder(f.parentId) : null;
    if (parent && (isWardrobeName(parent.name) || isLegacyName(parent.name))) continue;
    if (parent && parent.path.some((n) => isWardrobeName(n) || isLegacyName(n))) continue;
    const subs = view.folders(f.id);
    const marked =
      subs.some((s) => isWardrobeName(s.name) || isLegacyName(s.name)) ||
      view.items(f.id).some((i) => outfitKey(i.name).startsWith(outfitKey(`${f.name} - `)));
    if (marked) out.push(f.id);
  }
  return out;
}

/** Everything G7 finds in one character's layout (pure; the audit and the tests call it). */
export function artLayoutFindings(
  layout: ArtLayout,
  o: {
    readonly records?: readonly OutfitRecord[];
    readonly pages?: readonly ArtPageText[];
    readonly view?: LibraryView;
    readonly goneFolder?: (id: string) => boolean;
    /** An asset folder's path now (null: not a folder the asset tree holds). */
    readonly folderPath?: (id: string) => readonly string[] | null;
  } = {},
): FindingDraft[] {
  const out: FindingDraft[] = [];
  const character = layout.character.name;
  const base = layout.character.path.join(' / ');
  const wardrobe = layout.wardrobe;
  const wardrobePath = wardrobe ? `${base} / ${wardrobe.name}` : null;
  const charKey = layout.character.id;

  // 1. An outfit folder with one piece.
  for (const f of layout.outfitFolders) {
    if (f.items.length !== 1 || f.subfolders.length > 0 || !wardrobe) continue;
    const piece = f.items[0]!;
    const taken = layout.loose.some((i) => i.name === piece.name);
    out.push({
      code: 'art_outfit_folder_single',
      key: `${charKey}:${f.id}`,
      message: `${character}’s outfit folder “${f.name}” holds one piece (“${piece.name}”): a single-piece outfit lies loose in Wardrobe.`,
      evidence: { character, folder: `${wardrobePath} / ${f.name}`, piece: piece.name },
      sourceKind: 'bridge',
      fix: taken
        ? null
        : {
            kind: 'art_layout',
            args: {
              action: 'unfold',
              character,
              wardrobeId: wardrobe.id,
              wardrobePath,
              folderId: f.id,
              folderPath: `${wardrobePath} / ${f.name}`,
              moves: [{ assetId: piece.id, name: piece.name, fromId: f.id }],
            },
            summary: `Propose moving “${piece.name}” into Wardrobe and deleting the emptied folder “${f.name}”.`,
          },
    });
  }

  // 2. Loose pieces of one outfit.
  if (wardrobe) {
    const groups = new Map<string, { name: string; pieces: { id: string; name: string }[] }>();
    for (const it of layout.loose) {
      const rec = o.records?.find((r) => r.pieces.some((p) => p.assetId === it.id));
      const parsed = looseOutfitOf(it.name, character);
      const name = rec?.name ?? ('outfit' in parsed ? parsed.outfit : null);
      if (!name) continue;
      const k = outfitKey(name);
      const g = groups.get(k) ?? { name, pieces: [] };
      g.pieces.push({ id: it.id, name: it.name });
      groups.set(k, g);
    }
    for (const g of groups.values()) {
      if (g.pieces.length < 2) continue;
      const existing = layout.outfitFolders.find((f) => outfitKey(f.name) === outfitKey(g.name)) ?? null;
      out.push({
        code: 'art_loose_outfit_pieces',
        key: `${charKey}:${outfitKey(g.name)}`,
        message: `${character} has ${g.pieces.length} loose Wardrobe pieces of “${g.name}”: an outfit of two or more pieces has its folder (Wardrobe / ${g.name}).`,
        evidence: { character, outfit: g.name, pieces: g.pieces.map((p) => p.name), wardrobe: wardrobePath },
        sourceKind: 'bridge',
        fix: {
          kind: 'art_layout',
          args: {
            action: 'fold',
            character,
            outfit: g.name,
            wardrobeId: wardrobe.id,
            wardrobePath,
            folderId: existing?.id ?? null,
            folderName: existing?.name ?? g.name,
            moves: g.pieces.map((p) => ({ assetId: p.id, name: p.name, fromId: wardrobe.id })),
          },
          summary: `Propose ${existing ? 'moving' : `making Wardrobe / ${g.name} and moving`} its ${g.pieces.length} loose pieces into it.`,
        },
      });
    }
  }

  // 3 and 4. Legacy folders.
  for (const l of layout.legacy) {
    if (l.items.length === 0)
      out.push({
        code: 'art_legacy_folder_empty',
        key: `${charKey}:${l.id}`,
        message: `${character}’s ${l.name} folder (${l.path}) is empty: Forms, Outfits and Details are retired.`,
        evidence: { character, folder: l.path, folders: l.folders.map((f) => f.path) },
        sourceKind: 'bridge',
        fix: {
          kind: 'art_layout',
          args: {
            action: 'delete_empty',
            character,
            deletes: [
              ...l.folders.map((f) => ({ folderId: f.id, path: f.path })),
              { folderId: l.id, path: l.path },
            ],
          },
          summary: `Propose deleting the empty ${l.path}${l.folders.length ? ` (and its ${l.folders.length} empty folder(s) first)` : ''}.`,
        },
      });
    else
      out.push({
        code: 'art_legacy_folder_holds_assets',
        key: `${charKey}:${l.id}`,
        message: `${character}’s ${l.name} folder (${l.path}) still holds ${l.items.length} asset(s): where each belongs (a design piece in the character’s folder, or an outfit’s) is the owner’s call.`,
        evidence: { character, folder: l.path, assets: l.items.slice(0, 50).map((i) => i.name) },
        sourceKind: 'bridge',
        fix: null,
      });
  }

  // 5. Names (G4).
  const names = (
    folderId: string,
    items: readonly { id: string; name: string }[],
    outfit: (n: string) => string | null,
    where: string,
  ) => {
    const siblings = new Set(items.map((i) => i.name));
    for (const it of items) {
      const target = outfit(it.name);
      const problem = nameProblem(it.name, character, { outfit: target });
      if (!problem) continue;
      let to = fixedName(it.name, character, { outfit: target });
      if (to && siblings.has(to)) {
        let n = 2;
        const stem = to.replace(/\s\(\d+\)$/, '');
        while (siblings.has(`${stem} (${n})`)) n++;
        to = `${stem} (${n})`;
      }
      out.push({
        code: 'art_asset_name',
        key: `${charKey}:${it.id}`,
        message: `“${it.name}” (${where}) breaks the art naming rule: ${problem}.${to ? ` It would be “${to}”.` : ' The right name is the owner’s call.'}`,
        evidence: { character, asset: it.name, folder: where, problem, ...(to ? { to } : {}) },
        sourceKind: 'bridge',
        fix: to
          ? {
              kind: 'art_layout',
              args: { action: 'rename', character, assetId: it.id, from: it.name, to, folderId },
              summary: `Propose renaming “${it.name}” to “${to}”.`,
            }
          : null,
      });
    }
  };
  names(layout.character.id, layout.root, () => null, base);
  if (wardrobe)
    names(
      wardrobe.id,
      layout.loose,
      (n) => {
        const p = looseOutfitOf(n, character);
        return 'outfit' in p ? p.outfit : null;
      },
      wardrobePath!,
    );
  for (const f of layout.outfitFolders) names(f.id, f.items, () => f.name, `${wardrobePath} / ${f.name}`);

  // 6. Stale folder paths or ids on any of the character's pages.
  if (o.view) out.push(...staleRefs(layout, o.pages ?? [], o.view, o.goneFolder, o.folderPath));
  return out;
}

/** A page of a character's set: its text blocks, as the snapshots hold them. */
export interface ArtPageText {
  readonly pageId: string;
  readonly documentId: string;
  readonly blocks: readonly unknown[];
}

function textOf(b: Obj): string {
  return (Array.isArray(b.content) ? (b.content as Obj[]) : [])
    .map((r) => (typeof r.text === 'string' ? r.text : ''))
    .join('');
}

function* textBlocks(blocks: readonly unknown[]): Generator<Obj> {
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null) continue;
    const o = b as Obj;
    if (typeof o.id === 'string' && Array.isArray(o.content)) yield o;
    for (const v of Object.values(o)) if (Array.isArray(v)) yield* textBlocks(v as unknown[]);
  }
}

/** The folder a chain of names reaches from a folder (null: a name does not exist there). */
function walkPath(view: LibraryView, from: string, names: readonly string[]): string | null {
  let at = from;
  for (const n of names) {
    const next = view.folders(at).find((f) => outfitKey(f.name) === outfitKey(n));
    if (!next) return null;
    at = next.id;
  }
  return at;
}

function staleRefs(
  layout: ArtLayout,
  pages: readonly ArtPageText[],
  view: LibraryView,
  gone?: (id: string) => boolean,
  folderPath?: (id: string) => readonly string[] | null,
): FindingDraft[] {
  const out: FindingDraft[] = [];
  const character = layout.character.name;
  const base = layout.character.path.join(' / ');
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The character's folder path, then " / " and folder names (no further slash), as one path.
  const re = new RegExp(
    `${layout.character.path.map(esc).join('\\s*/\\s*')}((?:\\s*/\\s*[^/\\n“”"()\\[\\]]+?)+?)(?=\\s*(?:$|[.,;:)\\]”"]|\\s—|\\s-\\s))`,
    'g',
  );
  // All folders under the character's folder, for "where is it now".
  const all: { id: string; name: string; path: string[] }[] = [];
  const collect = (id: string, path: string[]) => {
    for (const f of view.folders(id)) {
      all.push({ id: f.id, name: f.name, path: [...path, f.name] });
      collect(f.id, [...path, f.name]);
    }
  };
  collect(layout.character.id, []);
  for (const p of pages) {
    for (const b of textBlocks(p.blocks)) {
      const text = textOf(b);
      for (const m of text.matchAll(re)) {
        const chain = m[1]!
          .split('/')
          .map((s) => s.trim())
          .filter(Boolean);
        if (chain.length === 0 || walkPath(view, layout.character.id, chain) !== null) continue;
        const stalePath = `${base} / ${chain.join(' / ')}`;
        const last = chain[chain.length - 1]!;
        const now = all.filter((f) => outfitKey(f.name) === outfitKey(last) && !f.path.some(isLegacyName));
        const to = now.length === 1 ? `${base} / ${now[0]!.path.join(' / ')}` : null;
        out.push({
          code: 'art_stale_folder_ref',
          key: `${layout.character.id}:${p.pageId}:${String(b.id)}:${stalePath}`,
          pageId: p.pageId,
          documentId: p.documentId,
          blockId: String(b.id),
          message: `A line names ${stalePath}, which no longer exists.${to ? ` The folder “${last}” is now ${to}.` : ' Where it went is the owner’s call.'}`,
          evidence: { character, line: text.slice(0, 500), stale: stalePath, ...(to ? { to } : {}) },
          fix: to
            ? {
                kind: 'art_layout',
                args: {
                  action: 'update_line',
                  character,
                  pageId: p.pageId,
                  documentId: p.documentId,
                  blockId: String(b.id),
                  from: m[0].trim(),
                  to,
                },
                summary: `Propose updating the line to name ${to}.`,
              }
            : null,
        });
      }
      // A folder id in the text that is no longer this character's folder: deleted, or now elsewhere (its current
      // name and place suggested).
      const mine = layout.character.path;
      for (const id of new Set(text.match(/\b[A-Za-z0-9][A-Za-z0-9_-]{7,63}\b/g) ?? [])) {
        const now = folderPath?.(id) ?? null;
        const isGone = now === null && gone?.(id) === true;
        if (!isGone && now === null) continue;
        if (
          now !== null &&
          now.length >= mine.length &&
          mine.every((n, k) => outfitKey(n) === outfitKey(now[k]!))
        )
          continue; // still the character's folder (or one inside it)
        const suggested = now ? now.join(' / ') : null;
        out.push({
          code: 'art_stale_folder_ref',
          key: `${layout.character.id}:${p.pageId}:${String(b.id)}:${id}`,
          pageId: p.pageId,
          documentId: p.documentId,
          blockId: String(b.id),
          message: suggested
            ? `A line names the asset folder ${id}, which is no longer ${character}’s: it is now “${suggested}”. Name the folder meant (suggested: its current name, “${now![now!.length - 1]!}”), or drop the reference.`
            : `A line names the asset folder ${id}, which has been deleted. Where it went is the owner’s call.`,
          evidence: {
            character,
            line: text.slice(0, 500),
            staleId: id,
            ...(suggested ? { suggested, currentName: now![now!.length - 1] } : {}),
          },
          fix: null,
        });
      }
    }
  }
  return out;
}

/** The audit's check: every character folder of the library. */
export function artLayoutCheck(ctx: AuditContext): FindingDraft[] {
  const lib = ctx.assetLibrary;
  if (!lib) return [];
  const view = auditLibraryView(lib);
  const gone = lib.goneIds ? new Set(lib.goneIds) : null;
  const folderPaths = new Map(lib.folders.map((f) => [f.id, f.path]));
  const out: FindingDraft[] = [];
  for (const id of characterFolders(lib, view)) {
    const layout = readLayout(view, id);
    if (!layout) continue;
    out.push(
      ...artLayoutFindings(layout, {
        records: ctx.outfitsOf?.(id) ?? [],
        pages: ctx.characterPages?.(layout.character.name) ?? [],
        view,
        folderPath: (x: string) => folderPaths.get(x) ?? null,
        ...(gone ? { goneFolder: (x: string) => gone.has(x) } : {}),
      }),
    );
  }
  return out;
}

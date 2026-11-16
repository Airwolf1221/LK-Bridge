/**
 * v3 F2 (ADR 0049 decision 9): duplicate asset folders. LegendKeeper accepts two folders of one name under one parent,
 * and before F2 two placements planned while a folder chain was missing each created it (the owner's report of 16
 * November 2026). Read-only: from the bridge's asset tree (no LegendKeeper read). Each set of sibling folders with
 * exactly the same name (byte for byte) is one finding, with each folder's path and how many assets it holds.
 *
 * Its fix ("Propose a fix", ONE proposal): the assets of the later-created duplicates move into the earliest one,
 * matched folder by folder down the chain (a subfolder the earliest also has, by exact name, is merged the same way);
 * then each duplicate that will then be empty is deleted, deepest first. An asset whose name the earliest folder already
 * holds is moved anyway (never deleted), and the proposal says so. A folder that would still hold anything (a subfolder
 * with no match) is never deleted, and each delete is checked again when the job runs: a folder that is not empty then
 * is skipped, never deleted with what is in it.
 */
import type { AuditContext } from '../context.js';
import type { FindingDraft } from '../types.js';

export interface LibraryFolder {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly path: readonly string[];
  /** When the bridge first saw it (the earliest stays). */
  readonly createdAt: number;
}

export interface LibraryItem {
  readonly id: string;
  readonly name: string;
  readonly folderId: string | null;
}

export interface AssetLibrary {
  readonly folders: readonly LibraryFolder[];
  readonly items: readonly LibraryItem[];
}

export interface MergePlan {
  readonly moves: {
    readonly assetId: string;
    readonly name: string;
    readonly from: string;
    readonly to: string;
    /** The folder of the earliest chain it moves into. */
    readonly toId: string;
  }[];
  /** Folders deleted once empty, deepest first. */
  readonly deletes: { readonly folderId: string; readonly path: string }[];
  /** Names the earliest folder already holds (moved anyway, never deleted). */
  readonly sameNames: string[];
  /** Duplicates kept because something would still be in them. */
  readonly kept: { readonly folderId: string; readonly path: string; readonly why: string }[];
}

/** The merge of `dups` into `keep`, folder by folder. */
export function planMerge(lib: AssetLibrary, keep: string, dups: readonly string[]): MergePlan {
  const kids = (id: string) => lib.folders.filter((f) => f.parentId === id);
  const items = (id: string) => lib.items.filter((i) => i.folderId === id);
  const pathOf = (id: string) => lib.folders.find((f) => f.id === id)?.path.join(' / ') ?? id;
  const plan: MergePlan = { moves: [], deletes: [], sameNames: [], kept: [] };
  const depth = (id: string) => lib.folders.find((f) => f.id === id)?.path.length ?? 0;
  const merge = (into: string, from: string): boolean => {
    const taken = new Set(items(into).map((i) => i.name));
    for (const i of items(from)) {
      if (taken.has(i.name)) plan.sameNames.push(`${pathOf(into)} / ${i.name}`);
      plan.moves.push({ assetId: i.id, name: i.name, from: pathOf(from), to: pathOf(into), toId: into });
    }
    let empty = true;
    for (const sub of kids(from)) {
      const match = kids(into).find((k) => k.name === sub.name);
      if (match && merge(match.id, sub.id)) continue;
      if (!match) {
        empty = false;
        plan.kept.push({
          folderId: from,
          path: pathOf(from),
          why: `its folder “${sub.name}” has no match to merge into`,
        });
      } else empty = false;
    }
    if (empty) plan.deletes.push({ folderId: from, path: pathOf(from) });
    return empty;
  };
  for (const d of dups) merge(keep, d);
  plan.deletes.sort((a, b) => depth(b.folderId) - depth(a.folderId));
  return plan;
}

export function duplicateFoldersCheck(ctx: AuditContext): FindingDraft[] {
  const lib = ctx.assetLibrary;
  if (!lib) return [];
  const groups = new Map<string, LibraryFolder[]>();
  for (const f of lib.folders) {
    const k = `${f.parentId ?? ''}\u0000${f.name}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const count = (id: string): number => {
    const own = lib.items.filter((i) => i.folderId === id).length;
    return own + lib.folders.filter((f) => f.parentId === id).reduce((n, f) => n + count(f.id), 0);
  };
  const out: FindingDraft[] = [];
  for (const set of groups.values()) {
    if (set.length < 2) continue;
    const sorted = [...set].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const keep = sorted[0]!;
    const dups = sorted.slice(1);
    const plan = planMerge(
      lib,
      keep.id,
      dups.map((d) => d.id),
    );
    const path = keep.path.join(' / ');
    out.push({
      code: 'duplicate_asset_folders',
      key: `${keep.parentId ?? 'root'}:${keep.name}:${sorted.map((f) => f.id).join(',')}`,
      message: `${set.length} sibling folders are named exactly “${keep.name}” (${path}): ${sorted
        .map((f) => `${f.id} holds ${count(f.id)} asset(s)`)
        .join('; ')}.`,
      evidence: {
        name: keep.name,
        path,
        folders: sorted.map((f, i) => ({
          id: f.id,
          path: f.path.join(' / '),
          assets: count(f.id),
          earliest: i === 0,
        })),
      },
      sourceKind: 'bridge',
      fix: {
        kind: 'merge_asset_folders',
        args: { keep: keep.id, duplicates: dups.map((d) => d.id), ...plan },
        summary: `Propose moving ${plan.moves.length} asset(s) into the earliest “${keep.name}” and deleting ${plan.deletes.length} emptied duplicate folder(s)${plan.sameNames.length ? ` (${plan.sameNames.length} same-named asset(s) moved, never deleted)` : ''}.`,
      },
    });
  }
  return out;
}

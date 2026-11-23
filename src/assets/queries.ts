/**
 * The asset tree's query layer (v2 A4) for later sessions: the Discover tools (B2), the image pipeline (D3), and the
 * placement planner in this folder. No LegendKeeper request is ever made here: everything is answered from the stored
 * model.
 *
 * Every answer is `{ tree, data }`: `tree` states the model's status (`not_built`, `building`, `ready`, `stale`), why
 * it is not ready, and when it was last confirmed, so a caller can decide whether to trust it.
 *
 * Name lookups are EXACT (no fuzzy matching, PLAN-v2 4.4) and return EVERY match. By default they ignore case
 * (Unicode NFC, lower case), like the repository tree's; `caseSensitive: true` compares the stored text as it is.
 * A folder id of `null` means the library's root.
 */
import { nameKey } from './classify.js';
import { AssetStore, type FolderRow, type ItemRow } from './store.js';
import type { AssetAnswer, AssetCounts, AssetFolder, AssetItem, AssetMeta } from './types.js';

export interface SubtreeFolder {
  readonly folder: AssetFolder;
  /** Depth below the subtree's top (1 for its direct subfolders). */
  readonly relativeDepth: number;
}

export class AssetQueries {
  constructor(
    private readonly store: AssetStore,
    private readonly metaOf: (projectId: string) => AssetMeta,
  ) {}

  private get db() {
    return this.store.db;
  }

  private answer<T>(projectId: string, data: () => T): AssetAnswer<T> {
    return { tree: this.metaOf(projectId), data: data() };
  }

  /** The model's status alone. */
  status(projectId: string): AssetMeta {
    return this.metaOf(projectId);
  }

  /** One folder, or null when the model holds no such folder. */
  folder(projectId: string, id: string): AssetAnswer<AssetFolder | null> {
    return this.answer(projectId, () => {
      const r = this.store.folder(projectId, id);
      return r ? AssetStore.folderView(r) : null;
    });
  }

  /** One asset that is not a folder, or null. */
  asset(projectId: string, id: string): AssetAnswer<AssetItem | null> {
    return this.answer(projectId, () => {
      const r = this.store.item(projectId, id);
      return r ? AssetStore.itemView(r) : null;
    });
  }

  /** v3 F7 (G11): the image asset whose file URL is exactly `url`, or null. */
  assetByUrl(projectId: string, url: string): AssetAnswer<AssetItem | null> {
    return this.answer(projectId, () => {
      const r = this.db
        .prepare('SELECT * FROM asset_items WHERE project_id = ? AND url = ? LIMIT 1')
        .get(projectId, url) as ItemRow | undefined;
      return r ? AssetStore.itemView(r) : null;
    });
  }

  /** A folder's ancestors and itself, top first (empty for an unknown folder). */
  path(projectId: string, id: string): AssetAnswer<AssetFolder[]> {
    return this.answer(projectId, () => {
      const f = this.store.folder(projectId, id);
      if (!f) return [];
      const ids = AssetStore.folderView(f).path.ids;
      return ids
        .map((i) => this.store.folder(projectId, i))
        .filter((r): r is FolderRow => r !== undefined)
        .map(AssetStore.folderView);
    });
  }

  /**
   * Every folder reached by following `names` from the library's root, each name matching a folder exactly. All
   * matches are returned (the library does not forbid two folders with one name, so there can be several chains).
   */
  foldersByPath(
    projectId: string,
    names: readonly string[],
    o: { caseSensitive?: boolean } = {},
  ): AssetAnswer<AssetFolder[]> {
    return this.answer(projectId, () => {
      if (names.length === 0) return [];
      let level: FolderRow[] = this.matchIn(projectId, null, names[0]!, o.caseSensitive === true);
      for (const name of names.slice(1)) {
        level = level.flatMap((f) => this.matchIn(projectId, f.id, name, o.caseSensitive === true));
        if (level.length === 0) break;
      }
      return level.map(AssetStore.folderView);
    });
  }

  private matchIn(
    projectId: string,
    parentId: string | null,
    name: string,
    caseSensitive: boolean,
  ): FolderRow[] {
    return this.store
      .children(projectId, parentId)
      .folders.filter((f) => (caseSensitive ? f.name === name : f.name_key === nameKey(name)));
  }

  /** A folder's direct subfolders (null: the root's), by name. */
  children(projectId: string, folderId: string | null): AssetAnswer<AssetFolder[]> {
    return this.answer(projectId, () =>
      this.store.children(projectId, folderId).folders.map(AssetStore.folderView),
    );
  }

  /**
   * The assets that are directly in a folder (null: the root), by name. `types` keeps only those LegendKeeper types
   * (for example `['IMAGE']`); `limit` (default 500) and `offset` page the list.
   */
  assetsIn(
    projectId: string,
    folderId: string | null,
    o: { types?: readonly string[]; limit?: number; offset?: number } = {},
  ): AssetAnswer<{ assets: AssetItem[]; total: number }> {
    return this.answer(projectId, () => {
      const all = this.store
        .children(projectId, folderId)
        .items.filter((i) => !o.types || o.types.includes(i.type));
      const offset = Math.max(0, o.offset ?? 0);
      const limit = Math.max(1, o.limit ?? 500);
      return { assets: all.slice(offset, offset + limit).map(AssetStore.itemView), total: all.length };
    });
  }

  /**
   * A folder (null: the whole library) and every folder below it, depth first with siblings by name, down to `maxDepth`
   * levels below it (1: its direct subfolders; omitted: everything). `limit` caps the entries (default 5,000);
   * `truncated` says when it was reached. The top folder itself is not in the list.
   */
  subtree(
    projectId: string,
    folderId: string | null,
    o: { maxDepth?: number; limit?: number } = {},
  ): AssetAnswer<{ folders: SubtreeFolder[]; truncated: boolean }> {
    return this.answer(projectId, () => {
      let topDepth = 0;
      let rows: FolderRow[];
      if (folderId === null) {
        rows = this.db
          .prepare('SELECT * FROM asset_folders WHERE project_id = ?')
          .all(projectId) as FolderRow[];
      } else {
        const top = this.store.folder(projectId, folderId);
        if (!top) return { folders: [], truncated: false };
        topDepth = top.depth;
        const prefix = `${top.path_ids.slice(0, -1)},`;
        rows = this.db
          .prepare(
            `SELECT * FROM asset_folders WHERE project_id = ? AND depth > ? AND path_ids LIKE ? ESCAPE '\\'`,
          )
          .all(projectId, top.depth, `${likeEscape(prefix)}%`) as FolderRow[];
      }
      const maxDepth = o.maxDepth ?? Number.POSITIVE_INFINITY;
      const views = rows
        .map(AssetStore.folderView)
        .filter((f) => f.depth - topDepth <= maxDepth)
        .sort(byPath);
      const limit = o.limit ?? 5000;
      return {
        folders: views.slice(0, limit).map((folder) => ({ folder, relativeDepth: folder.depth - topDepth })),
        truncated: views.length > limit,
      };
    });
  }

  // ============================================================================================ exact names

  /**
   * Every folder whose name is exactly `name`, wherever it is (`withinFolderId`: only inside that folder, at any depth).
   * All matches are returned, ordered by path.
   */
  findFoldersByName(
    projectId: string,
    name: string,
    o: { caseSensitive?: boolean; withinFolderId?: string } = {},
  ): AssetAnswer<AssetFolder[]> {
    return this.answer(projectId, () => {
      const rows = this.db
        .prepare(
          `SELECT * FROM asset_folders WHERE project_id = ? AND ${o.caseSensitive ? 'name = ?' : 'name_key = ?'}`,
        )
        .all(projectId, o.caseSensitive ? name : nameKey(name)) as FolderRow[];
      return rows
        .filter(
          (r) =>
            o.withinFolderId === undefined ||
            (r.id !== o.withinFolderId && this.store.isWithin(projectId, r.id, o.withinFolderId)),
        )
        .map(AssetStore.folderView)
        .sort(byPath);
    });
  }

  /**
   * Every asset (images, maps, audio; never folders) whose name is exactly `name`, in `folderId` only when that is
   * given (null: the root), else anywhere.
   */
  findAssetsByName(
    projectId: string,
    name: string,
    o: { caseSensitive?: boolean; folderId?: string | null } = {},
  ): AssetAnswer<AssetItem[]> {
    return this.answer(projectId, () => {
      const args: unknown[] = [projectId, o.caseSensitive ? name : nameKey(name)];
      let where = `project_id = ? AND ${o.caseSensitive ? 'name = ?' : 'name_key = ?'}`;
      if (o.folderId === null) where += ' AND folder_id IS NULL';
      else if (o.folderId !== undefined) {
        where += ' AND folder_id = ?';
        args.push(o.folderId);
      }
      const rows = this.db
        .prepare(`SELECT * FROM asset_items WHERE ${where} ORDER BY id`)
        .all(...args) as ItemRow[];
      return rows.map(AssetStore.itemView);
    });
  }

  // ============================================================================================ counts

  counts(projectId: string): AssetAnswer<AssetCounts> {
    return this.answer(projectId, () => this.store.counts(projectId));
  }

  stale(projectId: string, limit = 200): AssetAnswer<{ folders: AssetFolder[]; assets: AssetItem[] }> {
    return this.answer(projectId, () => ({
      folders: (
        this.db
          .prepare('SELECT * FROM asset_folders WHERE project_id = ? AND stale = 1 ORDER BY id LIMIT ?')
          .all(projectId, limit) as FolderRow[]
      ).map(AssetStore.folderView),
      assets: (
        this.db
          .prepare('SELECT * FROM asset_items WHERE project_id = ? AND stale = 1 ORDER BY id LIMIT ?')
          .all(projectId, limit) as ItemRow[]
      ).map(AssetStore.itemView),
    }));
  }
}

/** Tree order by path: a folder before its descendants, siblings by case-folded name (then id). */
function byPath(a: AssetFolder, b: AssetFolder): number {
  const x = a.path.names.map(nameKey);
  const y = b.path.names.map(nameKey);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return x.length - y.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

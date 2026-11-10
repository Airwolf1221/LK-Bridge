/**
 * The asset tree's tables (migration 0900) and the rules for changing them (ADR 0027). Synchronous, like every other
 * store: each method that changes the model runs in one SQLite transaction, so a change is all or nothing.
 *
 * The one rule every change follows (the same as the repository tree's, ADR 0025): **an observation never replaces one
 * made later.** Each row keeps the stamp of the observation it reflects; a removal leaves a tombstone with its stamp. A
 * refresh that listed a folder at time T therefore never undoes an update the bridge's own write made after T, never
 * deletes something the bridge created after T, and never brings back something the bridge deleted after T.
 */
import type { Db } from '../db/open.js';
import { FOLDER_TYPE, nameKey } from './classify.js';
import type {
  AssetBuildEstimate,
  AssetCorrection,
  AssetCounts,
  AssetFolder,
  AssetItem,
  AssetObservation,
  AssetPassKind,
  AssetPassStatus,
  AssetPassView,
  AssetReadBy,
} from './types.js';

export interface FolderRow {
  project_id: string;
  id: string;
  name: string;
  name_key: string;
  parent_id: string | null;
  depth: number;
  path_ids: string;
  path_names: string;
  is_hidden: number;
  observed_at: number;
  last_read_at: number;
  last_read_by: AssetReadBy;
  stale: number;
  stale_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface ItemRow {
  project_id: string;
  id: string;
  name: string;
  name_key: string;
  folder_id: string | null;
  type: string;
  url: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
  sha256: string | null;
  sha256_at: number | null;
  is_hidden: number;
  lk_created_at: string | null;
  observed_at: number;
  last_read_at: number;
  last_read_by: AssetReadBy;
  stale: number;
  stale_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface PassRow {
  id: string;
  project_id: string;
  kind: AssetPassKind;
  trigger: string;
  status: AssetPassStatus;
  snapshot_at: number | null;
  folders_found: number;
  folders_done: number;
  folders_failed: number;
  listed: number;
  pages: number;
  requests: number;
  verified: number;
  added: number;
  removed: number;
  corrected: number;
  estimate: string | null;
  summary: string | null;
  error: string | null;
  job_id: string | null;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
}

export interface StateRow {
  project_id: string;
  built_at: number | null;
  confirmed_at: number | null;
  confirmed_by: AssetPassKind | null;
  updated_at: number;
}

export interface WalkRow {
  seq: number;
  pass_id: string;
  project_id: string;
  folder_id: string;
  status: 'pending' | 'done' | 'failed';
  cursor: string | null;
  pages: number;
  stamp: number | null;
}

export interface PendingRow {
  id: number;
  project_id: string;
  job_id: string | null;
  step_no: number | null;
  op: string;
  asset_ids: string;
  flags: string;
  status: 'in_flight' | 'retry';
  attempts: number;
  last_error: string | null;
  next_at: number | null;
  attempted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ApplyContext {
  readonly projectId: string;
  readonly by: AssetReadBy;
  /** Refreshes and checks log what they correct; builds and after-write updates do not. */
  readonly log?: { readonly source: 'refresh' | 'check'; readonly passId: string } | undefined;
}

/** `orphan`: the folder it claims to be in is not in the model (the caller finds that folder's place first). */
export type ApplyOutcome = 'added' | 'updated' | 'unchanged' | 'skipped' | 'orphan';

export interface MissingChild {
  readonly id: string;
  readonly isFolder: boolean;
}

const j = (v: unknown): string => JSON.stringify(v);
function parse<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** The largest JSON value kept in one correction-log entry; longer values are cut (with a note). */
const LOG_VALUE_MAX = 4096;
/** Correction-log entries kept per project. */
export const ASSET_LOG_KEEP = 10_000;
/** Tombstones are needed only while a pass that listed before them may still apply: kept two days. */
const TOMBSTONE_KEEP_MS = 2 * 86_400_000;
/** A folder deeper than this is a loop or garbage; its path is not followed further. */
const MAX_DEPTH = 64;

export class AssetStore {
  constructor(
    readonly db: Db,
    private readonly now: () => number,
  ) {}

  // ============================================================================================== state

  state(projectId: string): StateRow | undefined {
    return this.db.prepare('SELECT * FROM asset_state WHERE project_id = ?').get(projectId) as
      StateRow | undefined;
  }

  private ensureState(projectId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO asset_state (project_id, updated_at) VALUES (?, ?)')
      .run(projectId, this.now());
  }

  /** A pass completed: the model was confirmed at `at` (the pass's start). The first build also marks it built. */
  setConfirmed(projectId: string, at: number, by: AssetPassKind): void {
    this.ensureState(projectId);
    this.db
      .prepare(
        `UPDATE asset_state SET confirmed_at = ?, confirmed_by = ?, updated_at = ?,
           built_at = CASE WHEN ? = 'build' AND built_at IS NULL THEN ? ELSE built_at END
         WHERE project_id = ?`,
      )
      .run(at, by, this.now(), by, this.now(), projectId);
  }

  /** The largest stamp stored, so a restart (or a clock that went back) never reorders observations. */
  maxStamp(): number {
    const r = this.db
      .prepare(
        `SELECT MAX(m) AS m FROM (
           SELECT MAX(observed_at) AS m FROM asset_folders
           UNION ALL SELECT MAX(observed_at) FROM asset_items
           UNION ALL SELECT MAX(observed_at) FROM asset_tombstones
           UNION ALL SELECT MAX(snapshot_at) FROM asset_passes
           UNION ALL SELECT MAX(stamp) FROM asset_walk)`,
      )
      .get() as { m: number | null };
    return r.m ?? 0;
  }

  // ============================================================================================== rows

  folder(projectId: string, id: string): FolderRow | undefined {
    return this.db
      .prepare('SELECT * FROM asset_folders WHERE project_id = ? AND id = ?')
      .get(projectId, id) as FolderRow | undefined;
  }

  item(projectId: string, id: string): ItemRow | undefined {
    return this.db.prepare('SELECT * FROM asset_items WHERE project_id = ? AND id = ?').get(projectId, id) as
      ItemRow | undefined;
  }

  /** What the model holds under an id: a folder, an asset, or nothing. */
  has(projectId: string, id: string): 'folder' | 'asset' | undefined {
    if (this.folder(projectId, id)) return 'folder';
    if (this.item(projectId, id)) return 'asset';
    return undefined;
  }

  tombstone(projectId: string, id: string): { observed_at: number; reason: string } | undefined {
    return this.db
      .prepare('SELECT observed_at, reason FROM asset_tombstones WHERE project_id = ? AND id = ?')
      .get(projectId, id) as { observed_at: number; reason: string } | undefined;
  }

  countFolders(projectId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM asset_folders WHERE project_id = ?').get(projectId) as {
        n: number;
      }
    ).n;
  }

  countItems(projectId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM asset_items WHERE project_id = ?').get(projectId) as {
        n: number;
      }
    ).n;
  }

  staleCount(projectId: string): number {
    const n = (t: string) =>
      (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ? AND stale = 1`)
          .get(projectId) as {
          n: number;
        }
      ).n;
    return n('asset_folders') + n('asset_items');
  }

  counts(projectId: string): AssetCounts {
    const byType: Record<string, number> = {};
    for (const r of this.db
      .prepare('SELECT type, COUNT(*) AS n FROM asset_items WHERE project_id = ? GROUP BY type')
      .all(projectId) as { type: string; n: number }[]) {
      byType[r.type] = r.n;
    }
    const depth = this.db
      .prepare('SELECT MAX(depth) AS d FROM asset_folders WHERE project_id = ?')
      .get(projectId) as { d: number | null };
    const hashed = this.db
      .prepare('SELECT COUNT(*) AS n FROM asset_items WHERE project_id = ? AND sha256 IS NOT NULL')
      .get(projectId) as { n: number };
    return {
      folders: this.countFolders(projectId),
      assets: this.countItems(projectId),
      byType,
      maxDepth: depth.d ?? 0,
      stale: this.staleCount(projectId),
      withHash: hashed.n,
    };
  }

  /** The direct subfolders and assets of a folder (null: the library's root). */
  children(projectId: string, folderId: string | null): { folders: FolderRow[]; items: ItemRow[] } {
    const where = folderId === null ? 'IS NULL' : '= ?';
    const args = folderId === null ? [projectId] : [projectId, folderId];
    return {
      folders: this.db
        .prepare(
          `SELECT * FROM asset_folders WHERE project_id = ? AND parent_id ${where} ORDER BY name_key, name, id`,
        )
        .all(...args) as FolderRow[],
      items: this.db
        .prepare(
          `SELECT * FROM asset_items WHERE project_id = ? AND folder_id ${where} ORDER BY name_key, name, id`,
        )
        .all(...args) as ItemRow[],
    };
  }

  /** A folder's descendants: every folder below it and every asset in it or below it. The folder itself is excluded. */
  descendants(projectId: string, folderId: string): { folders: FolderRow[]; items: ItemRow[] } {
    const folders: FolderRow[] = [];
    const items: ItemRow[] = [];
    const queue = [folderId];
    const seen = new Set<string>([folderId]);
    while (queue.length > 0) {
      const id = queue.shift()!;
      const c = this.children(projectId, id);
      items.push(...c.items);
      for (const f of c.folders) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        folders.push(f);
        queue.push(f.id);
      }
    }
    return { folders, items };
  }

  /** Whether `id` is `folderId` itself or inside it (at any depth). */
  isWithin(projectId: string, id: string, folderId: string): boolean {
    let cur: string | null = id;
    for (let i = 0; i < MAX_DEPTH + 2 && cur !== null; i++) {
      if (cur === folderId) return true;
      cur = this.folder(projectId, cur)?.parent_id ?? null;
    }
    return false;
  }

  // ============================================================================================== applying observations

  /**
   * Applies what one read showed (at stamp `t`). Never replaces a later observation, never brings back what a later
   * removal took away. A folder is placed under the folder it names; if that folder is not in the model the answer is
   * `orphan` and nothing changes (the caller finds that folder's place first).
   */
  applyObservation(ctx: ApplyContext, obs: AssetObservation, t: number): ApplyOutcome {
    return this.db.transaction(() => this.applyInner(ctx, obs, t))();
  }

  private applyInner(ctx: ApplyContext, obs: AssetObservation, t: number): ApplyOutcome {
    const { projectId } = ctx;
    const tomb = this.tombstone(projectId, obs.id);
    if (tomb && tomb.observed_at >= t) return 'skipped';
    const isFolder = obs.type === FOLDER_TYPE;
    if (obs.folderId !== null && !this.folder(projectId, obs.folderId)) return 'orphan';
    // A folder cannot sit inside itself or its own descendants: such an observation is stale or garbage.
    if (isFolder && obs.folderId !== null && this.isWithin(projectId, obs.folderId, obs.id)) return 'skipped';
    // The id changed kind (never seen in practice): the old row goes first, then the new one is added.
    const other = isFolder ? this.item(projectId, obs.id) : this.folder(projectId, obs.id);
    if (other) {
      if (other.observed_at >= t) return 'skipped';
      if (!isFolder) {
        // A folder became an asset: its contents go with it.
        this.removeFolderRows(projectId, obs.id, t, 'it became an asset');
      } else {
        this.db.prepare('DELETE FROM asset_items WHERE project_id = ? AND id = ?').run(projectId, obs.id);
      }
    }
    return isFolder ? this.applyFolder(ctx, obs, t) : this.applyAsset(ctx, obs, t);
  }

  private applyFolder(ctx: ApplyContext, obs: AssetObservation, t: number): ApplyOutcome {
    const { projectId } = ctx;
    const now = this.now();
    const before = this.folder(projectId, obs.id);
    if (before) {
      if (before.observed_at >= t) return 'skipped';
      const changes: [string, unknown, unknown][] = [];
      if (before.name !== obs.name) changes.push(['name', before.name, obs.name]);
      if (before.parent_id !== obs.folderId) changes.push(['folderId', before.parent_id, obs.folderId]);
      if ((before.is_hidden === 1) !== obs.isHidden)
        changes.push(['isHidden', before.is_hidden === 1, obs.isHidden]);
      this.db
        .prepare(
          `UPDATE asset_folders SET name = ?, name_key = ?, parent_id = ?, is_hidden = ?, observed_at = ?,
             last_read_at = ?, last_read_by = ?, stale = 0, stale_reason = NULL, updated_at = ?
           WHERE project_id = ? AND id = ?`,
        )
        .run(
          obs.name,
          nameKey(obs.name),
          obs.folderId,
          obs.isHidden ? 1 : 0,
          t,
          now,
          ctx.by,
          now,
          projectId,
          obs.id,
        );
      if (changes.some(([f]) => f === 'name' || f === 'folderId')) this.repath(projectId, obs.id);
      for (const [field, o, n] of changes) this.log(ctx, obs.id, obs.name, 'folder', 'updated', field, o, n);
      return changes.length > 0 ? 'updated' : 'unchanged';
    }
    const parent = obs.folderId === null ? undefined : this.folder(projectId, obs.folderId);
    const pathIds = [...(parent ? parse<string[]>(parent.path_ids, []) : []), obs.id];
    const pathNames = [...(parent ? parse<string[]>(parent.path_names, []) : []), obs.name];
    this.db
      .prepare(
        `INSERT INTO asset_folders (project_id, id, name, name_key, parent_id, depth, path_ids, path_names, is_hidden,
           observed_at, last_read_at, last_read_by, stale, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        projectId,
        obs.id,
        obs.name,
        nameKey(obs.name),
        obs.folderId,
        pathIds.length,
        j(pathIds),
        j(pathNames),
        obs.isHidden ? 1 : 0,
        t,
        now,
        ctx.by,
        now,
        now,
      );
    this.log(ctx, obs.id, obs.name, 'folder', 'added', null, null, null);
    return 'added';
  }

  private applyAsset(ctx: ApplyContext, obs: AssetObservation, t: number): ApplyOutcome {
    const { projectId } = ctx;
    const now = this.now();
    const before = this.item(projectId, obs.id);
    if (before) {
      if (before.observed_at >= t) return 'skipped';
      const changes: [string, unknown, unknown][] = [];
      if (before.name !== obs.name) changes.push(['name', before.name, obs.name]);
      if (before.folder_id !== obs.folderId) changes.push(['folderId', before.folder_id, obs.folderId]);
      if (before.type !== obs.type) changes.push(['type', before.type, obs.type]);
      if (before.url !== obs.url) changes.push(['url', before.url, obs.url]);
      if (before.width !== obs.width) changes.push(['width', before.width, obs.width]);
      if (before.height !== obs.height) changes.push(['height', before.height, obs.height]);
      // A size LegendKeeper does not state is not a size of nothing: what E1 recorded stays.
      const size = obs.size ?? before.size;
      if (before.size !== size) changes.push(['size', before.size, size]);
      if ((before.is_hidden === 1) !== obs.isHidden)
        changes.push(['isHidden', before.is_hidden === 1, obs.isHidden]);
      // The hash belongs to the file: a new url is a new file.
      const keepHash = before.url === obs.url;
      this.db
        .prepare(
          `UPDATE asset_items SET name = ?, name_key = ?, folder_id = ?, type = ?, url = ?, width = ?, height = ?,
             size = ?, sha256 = ?, sha256_at = ?, is_hidden = ?, lk_created_at = COALESCE(?, lk_created_at),
             observed_at = ?, last_read_at = ?, last_read_by = ?, stale = 0, stale_reason = NULL, updated_at = ?
           WHERE project_id = ? AND id = ?`,
        )
        .run(
          obs.name,
          nameKey(obs.name),
          obs.folderId,
          obs.type,
          obs.url,
          obs.width,
          obs.height,
          size,
          keepHash ? before.sha256 : null,
          keepHash ? before.sha256_at : null,
          obs.isHidden ? 1 : 0,
          obs.createdAt,
          t,
          now,
          ctx.by,
          now,
          projectId,
          obs.id,
        );
      for (const [field, o, n] of changes) this.log(ctx, obs.id, obs.name, 'asset', 'updated', field, o, n);
      return changes.length > 0 ? 'updated' : 'unchanged';
    }
    this.db
      .prepare(
        `INSERT INTO asset_items (project_id, id, name, name_key, folder_id, type, url, width, height, size,
           is_hidden, lk_created_at, observed_at, last_read_at, last_read_by, stale, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        projectId,
        obs.id,
        obs.name,
        nameKey(obs.name),
        obs.folderId,
        obs.type,
        obs.url,
        obs.width,
        obs.height,
        obs.size,
        obs.isHidden ? 1 : 0,
        obs.createdAt,
        t,
        now,
        ctx.by,
        now,
        now,
      );
    this.log(ctx, obs.id, obs.name, 'asset', 'added', null, null, null);
    return 'added';
  }

  /**
   * Something read as gone (404, or the bridge's own delete confirmed) at stamp `t`. Removes it and, for a folder,
   * everything inside it (LegendKeeper's deleteAsset documents that: "Deleting a folder deletes everything inside it
   * at any depth"). Returns how many rows were removed. Nothing is removed that was observed after `t`: then the
   * thing is marked stale instead and the next pass decides.
   */
  applyGone(ctx: ApplyContext, id: string, t: number, reason: string): number {
    return this.db.transaction(() => {
      const { projectId } = ctx;
      const prior = this.tombstone(projectId, id);
      if (!prior || prior.observed_at < t) {
        this.db
          .prepare(
            `INSERT INTO asset_tombstones (project_id, id, observed_at, reason) VALUES (?, ?, ?, ?)
             ON CONFLICT (project_id, id) DO UPDATE SET observed_at = excluded.observed_at, reason = excluded.reason`,
          )
          .run(projectId, id, t, reason);
      }
      const folder = this.folder(projectId, id);
      if (folder) {
        if (folder.observed_at > t) return 0;
        const d = this.descendants(projectId, id);
        if (d.folders.some((f) => f.observed_at > t) || d.items.some((i) => i.observed_at > t)) {
          this.markStale(projectId, [id], 'it read as gone, but something inside it was seen later');
          return 0;
        }
        const n = this.removeFolderRows(projectId, id, t, reason);
        this.log(
          ctx,
          id,
          folder.name,
          'folder',
          'removed',
          null,
          null,
          null,
          n > 1 ? `${reason}; ${n - 1} ${n === 2 ? 'row' : 'rows'} inside it went with it` : reason,
        );
        return n;
      }
      const item = this.item(projectId, id);
      if (item) {
        if (item.observed_at > t) return 0;
        this.db.prepare('DELETE FROM asset_items WHERE project_id = ? AND id = ?').run(projectId, id);
        this.log(ctx, id, item.name, 'asset', 'removed', null, null, null, reason);
        return 1;
      }
      return 0;
    })();
  }

  /** Removes a folder and everything inside it, children before parents (the foreign keys), leaving tombstones. */
  private removeFolderRows(projectId: string, id: string, t: number, reason: string): number {
    const d = this.descendants(projectId, id);
    const tomb = this.db.prepare(
      `INSERT INTO asset_tombstones (project_id, id, observed_at, reason) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, id) DO UPDATE SET observed_at = MAX(observed_at, excluded.observed_at)`,
    );
    for (const i of d.items) {
      this.db.prepare('DELETE FROM asset_items WHERE project_id = ? AND id = ?').run(projectId, i.id);
      tomb.run(projectId, i.id, t, reason);
    }
    for (const f of [...d.folders].sort((a, b) => b.depth - a.depth)) {
      this.db.prepare('DELETE FROM asset_folders WHERE project_id = ? AND id = ?').run(projectId, f.id);
      tomb.run(projectId, f.id, t, reason);
    }
    this.db.prepare('DELETE FROM asset_folders WHERE project_id = ? AND id = ?').run(projectId, id);
    return 1 + d.items.length + d.folders.length;
  }

  /** Marks rows (folders or assets) as not confirmed, with the reason. Returns how many were marked. */
  markStale(projectId: string, ids: readonly string[], reason: string): number {
    let n = 0;
    for (const id of ids) {
      for (const t of ['asset_folders', 'asset_items']) {
        n += this.db
          .prepare(
            `UPDATE ${t} SET stale = 1, stale_reason = ?, updated_at = ? WHERE project_id = ? AND id = ? AND stale = 0`,
          )
          .run(reason, this.now(), projectId, id).changes;
      }
    }
    return n;
  }

  /** Recomputes the cached path and depth of a folder and everything below it from the parent links. */
  repath(projectId: string, folderId: string): void {
    const queue = [folderId];
    const seen = new Set<string>();
    const upd = this.db.prepare(
      'UPDATE asset_folders SET depth = ?, path_ids = ?, path_names = ? WHERE project_id = ? AND id = ?',
    );
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const f = this.folder(projectId, id);
      if (!f) continue;
      const parent = f.parent_id === null ? undefined : this.folder(projectId, f.parent_id);
      const ids = [...(parent ? parse<string[]>(parent.path_ids, []) : []), f.id];
      const names = [...(parent ? parse<string[]>(parent.path_names, []) : []), f.name];
      upd.run(ids.length, j(ids), j(names), projectId, id);
      for (const c of this.children(projectId, id).folders) queue.push(c.id);
    }
  }

  /**
   * Checks the model's own consistency (used by the nightly check): every folder's cached path and depth agree with
   * its parent chain. Returns the folders whose cached path was wrong (fixed here) and the folders no top folder
   * reaches (a parent loop; reported, not touched).
   */
  audit(projectId: string): { fixedPaths: string[]; unreachable: string[] } {
    return this.db.transaction(() => {
      const cached = (): Map<string, string> =>
        new Map(
          (
            this.db
              .prepare('SELECT id, path_ids, path_names, depth FROM asset_folders WHERE project_id = ?')
              .all(projectId) as { id: string; path_ids: string; path_names: string; depth: number }[]
          ).map((r) => [r.id, `${r.depth}|${r.path_ids}|${r.path_names}`]),
        );
      const before = cached();
      const top = this.children(projectId, null).folders;
      const reached = new Set<string>();
      const queue = top.map((f) => f.id);
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (reached.has(id)) continue;
        reached.add(id);
        for (const c of this.children(projectId, id).folders) queue.push(c.id);
      }
      for (const t of top) this.repath(projectId, t.id);
      const after = cached();
      return {
        fixedPaths: [...after].filter(([id, v]) => before.get(id) !== v).map(([id]) => id),
        unreachable: [...before.keys()].filter((id) => !reached.has(id)),
      };
    })();
  }

  // ============================================================================================== folder listings

  /** Stored children of a folder (null: the root) last observed before `t`, other than the ids in `except`. */
  missingChildren(
    projectId: string,
    folderId: string | null,
    t: number,
    except: ReadonlySet<string>,
  ): MissingChild[] {
    const c = this.children(projectId, folderId);
    return [
      ...c.folders
        .filter((f) => f.observed_at < t && !except.has(f.id))
        .map((f) => ({ id: f.id, isFolder: true })),
      ...c.items
        .filter((i) => i.observed_at < t && !except.has(i.id))
        .map((i) => ({ id: i.id, isFolder: false })),
    ];
  }

  stageItems(passId: string, projectId: string, folderId: string, items: readonly AssetObservation[]): void {
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO asset_listing (pass_id, project_id, folder_id, id, name, type, url, width, height,
         size, is_hidden, lk_created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const o of items) {
      ins.run(
        passId,
        projectId,
        folderId,
        o.id,
        o.name,
        o.type,
        o.url,
        o.width,
        o.height,
        o.size,
        o.isHidden ? 1 : 0,
        o.createdAt,
      );
    }
  }

  stagedItems(passId: string, folderId: string): AssetObservation[] {
    const rows = this.db
      .prepare('SELECT * FROM asset_listing WHERE pass_id = ? AND folder_id = ? ORDER BY id')
      .all(passId, folderId) as {
      id: string;
      name: string;
      type: string;
      url: string | null;
      width: number | null;
      height: number | null;
      size: number | null;
      is_hidden: number;
      lk_created_at: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      folderId: folderId === '' ? null : folderId,
      url: r.url,
      width: r.width,
      height: r.height,
      size: r.size,
      isHidden: r.is_hidden === 1,
      createdAt: r.lk_created_at,
    }));
  }

  clearStaged(passId: string, folderId: string): void {
    this.db.prepare('DELETE FROM asset_listing WHERE pass_id = ? AND folder_id = ?').run(passId, folderId);
  }

  clearListing(passId: string): void {
    this.db.prepare('DELETE FROM asset_listing WHERE pass_id = ?').run(passId);
  }

  /**
   * Applies a completely read folder listing (staged by the pass) in one transaction: every listed item is applied at
   * the listing's stamp `t`, folders are queued for the walk, and the stored children the listing did not show (and
   * that nothing newer vouches for) are returned for verification. Nothing is deleted here: absence from a listing is
   * not proof of deletion.
   */
  applyListing(
    ctx: ApplyContext,
    passId: string,
    folderId: string,
    t: number,
  ): { applied: boolean; added: number; folders: number; assets: number; missing: MissingChild[] } {
    return this.db.transaction(() => {
      const { projectId } = ctx;
      const parent = folderId === '' ? null : folderId;
      if (parent !== null && !this.folder(projectId, parent)) {
        // The folder was removed while it was being listed (the bridge deleted it, or an older observation lost).
        this.clearStaged(passId, folderId);
        return { applied: false, added: 0, folders: 0, assets: 0, missing: [] };
      }
      const staged = this.stagedItems(passId, folderId);
      let added = 0;
      let folders = 0;
      let assets = 0;
      const seen = new Set<string>();
      for (const o of staged) {
        seen.add(o.id);
        const out = this.applyInner(ctx, o, t);
        if (out === 'added') added++;
        if (o.type === FOLDER_TYPE) {
          folders++;
          if (this.folder(projectId, o.id)) this.enqueueWalk(passId, projectId, o.id);
        } else assets++;
      }
      const missing = this.missingChildren(projectId, parent, t, seen);
      this.clearStaged(passId, folderId);
      return { applied: true, added, folders, assets, missing };
    })();
  }

  // ============================================================================================== passes and walk

  createPass(p: {
    id: string;
    projectId: string;
    kind: AssetPassKind;
    trigger: string;
    status: AssetPassStatus;
  }): AssetPassView {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO asset_passes (id, project_id, kind, trigger, status, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.projectId, p.kind, p.trigger, p.status, now, now);
    return this.pass(p.id)!;
  }

  private static passView(this: void, r: PassRow): AssetPassView {
    return {
      id: r.id,
      projectId: r.project_id,
      kind: r.kind,
      trigger: r.trigger,
      status: r.status,
      snapshotAt: r.snapshot_at,
      foldersFound: r.folders_found,
      foldersDone: r.folders_done,
      foldersFailed: r.folders_failed,
      listed: r.listed,
      pages: r.pages,
      requests: r.requests,
      verified: r.verified,
      added: r.added,
      removed: r.removed,
      corrected: r.corrected,
      estimate: parse<AssetBuildEstimate | null>(r.estimate, null),
      summary: r.summary,
      error: r.error,
      jobId: r.job_id,
      startedAt: r.started_at,
      updatedAt: r.updated_at,
      finishedAt: r.finished_at,
    };
  }

  pass(id: string): AssetPassView | undefined {
    const r = this.db.prepare('SELECT * FROM asset_passes WHERE id = ?').get(id) as PassRow | undefined;
    return r ? AssetStore.passView(r) : undefined;
  }

  activePass(projectId: string): AssetPassView | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM asset_passes WHERE project_id = ? AND status IN ('preparing', 'awaiting_confirmation', 'walking')`,
      )
      .get(projectId) as PassRow | undefined;
    return r ? AssetStore.passView(r) : undefined;
  }

  activePasses(): AssetPassView[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM asset_passes WHERE status IN ('preparing', 'awaiting_confirmation', 'walking') ORDER BY started_at`,
        )
        .all() as PassRow[]
    ).map(AssetStore.passView);
  }

  lastPass(projectId: string, kind: AssetPassKind, finishedOnly = true): AssetPassView | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM asset_passes WHERE project_id = ? AND kind = ? ${finishedOnly ? 'AND finished_at IS NOT NULL' : ''}
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(projectId, kind) as PassRow | undefined;
    return r ? AssetStore.passView(r) : undefined;
  }

  recentPasses(projectId: string, limit: number): AssetPassView[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM asset_passes WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?',
        )
        .all(projectId, limit) as PassRow[]
    ).map(AssetStore.passView);
  }

  updatePass(
    id: string,
    patch: Partial<{
      status: AssetPassStatus;
      snapshotAt: number | null;
      foldersFound: number;
      foldersDone: number;
      foldersFailed: number;
      listed: number;
      pages: number;
      requests: number;
      verified: number;
      added: number;
      removed: number;
      corrected: number;
      estimate: AssetBuildEstimate | null;
      summary: string | null;
      error: string | null;
      jobId: string | null;
      finishedAt: number | null;
    }>,
  ): void {
    const cols: Record<string, string> = {
      status: 'status',
      snapshotAt: 'snapshot_at',
      foldersFound: 'folders_found',
      foldersDone: 'folders_done',
      foldersFailed: 'folders_failed',
      listed: 'listed',
      pages: 'pages',
      requests: 'requests',
      verified: 'verified',
      added: 'added',
      removed: 'removed',
      corrected: 'corrected',
      estimate: 'estimate',
      summary: 'summary',
      error: 'error',
      jobId: 'job_id',
      finishedAt: 'finished_at',
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${cols[k]} = ?`);
      vals.push(k === 'estimate' && v !== null ? j(v) : v);
    }
    sets.push('updated_at = ?');
    vals.push(this.now(), id);
    this.db.prepare(`UPDATE asset_passes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  bumpPass(
    id: string,
    d: Partial<
      Record<
        'requests' | 'pages' | 'listed' | 'verified' | 'added' | 'removed' | 'foldersDone' | 'foldersFailed',
        number
      >
    >,
  ): void {
    const cols = {
      requests: 'requests',
      pages: 'pages',
      listed: 'listed',
      verified: 'verified',
      added: 'added',
      removed: 'removed',
      foldersDone: 'folders_done',
      foldersFailed: 'folders_failed',
    } as const;
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(d) as [keyof typeof cols, number][]) {
      if (!v) continue;
      sets.push(`${cols[k]} = ${cols[k]} + ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(this.now(), id);
    this.db.prepare(`UPDATE asset_passes SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals);
  }

  /** Rows whose stored values this pass corrected (each counted once, however many of its values changed). */
  correctedRows(passId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT item_id) AS n FROM asset_log WHERE pass_id = ? AND change = 'updated'`,
        )
        .get(passId) as { n: number }
    ).n;
  }

  // ---- the walk queue

  /** Adds a folder to the pass's walk unless it is already queued ('' is the root). Returns whether it was new. */
  enqueueWalk(passId: string, projectId: string, folderId: string): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO asset_walk (pass_id, project_id, folder_id, status) VALUES (?, ?, ?, 'pending')`,
      )
      .run(passId, projectId, folderId);
    if (r.changes > 0 && folderId !== '') {
      this.db
        .prepare('UPDATE asset_passes SET folders_found = folders_found + 1, updated_at = ? WHERE id = ?')
        .run(this.now(), passId);
    }
    return r.changes > 0;
  }

  /** The next folder to list (breadth first), or undefined when the walk is complete. */
  nextWalk(passId: string): WalkRow | undefined {
    return this.db
      .prepare(`SELECT * FROM asset_walk WHERE pass_id = ? AND status = 'pending' ORDER BY seq LIMIT 1`)
      .get(passId) as WalkRow | undefined;
  }

  walkRow(passId: string, folderId: string): WalkRow | undefined {
    return this.db
      .prepare('SELECT * FROM asset_walk WHERE pass_id = ? AND folder_id = ?')
      .get(passId, folderId) as WalkRow | undefined;
  }

  updateWalk(
    passId: string,
    folderId: string,
    patch: Partial<{
      status: 'pending' | 'done' | 'failed';
      cursor: string | null;
      pages: number;
      stamp: number | null;
    }>,
  ): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(passId, folderId);
    this.db
      .prepare(`UPDATE asset_walk SET ${sets.join(', ')} WHERE pass_id = ? AND folder_id = ?`)
      .run(...vals);
  }

  /** The root-level figures of a walk (the root folder's row), for the build's estimate. */
  rootLevel(projectId: string): { folders: number; assets: number } {
    const c = this.children(projectId, null);
    return { folders: c.folders.length, assets: c.items.length };
  }

  /** Pass rows, listings and walk queues are pruned: the newest 200 passes per project are kept. */
  prune(projectId: string): void {
    this.db
      .prepare(
        `DELETE FROM asset_passes WHERE project_id = ? AND finished_at IS NOT NULL AND id NOT IN (
           SELECT id FROM asset_passes WHERE project_id = ? ORDER BY started_at DESC LIMIT 200)`,
      )
      .run(projectId, projectId);
    this.db
      .prepare('DELETE FROM asset_tombstones WHERE project_id = ? AND observed_at < ?')
      .run(projectId, this.now() - TOMBSTONE_KEEP_MS);
    this.db
      .prepare(
        `DELETE FROM asset_log WHERE project_id = ? AND id NOT IN (
           SELECT id FROM asset_log WHERE project_id = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(projectId, projectId, ASSET_LOG_KEEP);
  }

  // ============================================================================================== owed re-reads

  insertPending(p: {
    projectId: string;
    jobId: string | null;
    stepNo: number | null;
    op: string;
    assetIds: readonly string[];
    flags: Record<string, unknown>;
  }): number {
    const now = this.now();
    return Number(
      this.db
        .prepare(
          `INSERT INTO asset_pending (project_id, job_id, step_no, op, asset_ids, flags, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'in_flight', ?, ?)`,
        )
        .run(p.projectId, p.jobId, p.stepNo, p.op, j(p.assetIds), j(p.flags), now, now).lastInsertRowid,
    );
  }

  pendingForStep(projectId: string, jobId: string, stepNo: number): PendingRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM asset_pending WHERE project_id = ? AND job_id = ? AND step_no = ? ORDER BY id DESC LIMIT 1',
      )
      .get(projectId, jobId, stepNo) as PendingRow | undefined;
  }

  pending(projectId?: string): PendingRow[] {
    return (
      projectId === undefined
        ? this.db.prepare('SELECT * FROM asset_pending ORDER BY id').all()
        : this.db.prepare('SELECT * FROM asset_pending WHERE project_id = ? ORDER BY id').all(projectId)
    ) as PendingRow[];
  }

  pendingCount(projectId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM asset_pending WHERE project_id = ?').get(projectId) as {
        n: number;
      }
    ).n;
  }

  failedPendingCount(projectId: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM asset_pending WHERE project_id = ? AND status = 'retry'`)
        .get(projectId) as { n: number }
    ).n;
  }

  deletePending(id: number): void {
    this.db.prepare('DELETE FROM asset_pending WHERE id = ?').run(id);
  }

  failPending(id: number, error: string, nextAt: number, attemptedAt: number): void {
    this.db
      .prepare(
        `UPDATE asset_pending SET status = 'retry', attempts = attempts + 1, last_error = ?, next_at = ?,
           attempted_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(error, nextAt, attemptedAt, this.now(), id);
  }

  // ============================================================================================== correction log

  private log(
    ctx: ApplyContext,
    itemId: string,
    itemName: string | null,
    itemKind: 'folder' | 'asset',
    change: 'added' | 'removed' | 'updated',
    field: string | null,
    oldValue: unknown,
    newValue: unknown,
    detail: string | null = null,
  ): void {
    if (!ctx.log) return;
    this.insertLog({
      projectId: ctx.projectId,
      source: ctx.log.source,
      passId: ctx.log.passId,
      itemId,
      itemName,
      itemKind,
      change,
      field,
      oldValue,
      newValue,
      detail,
    });
  }

  insertLog(e: {
    projectId: string;
    source: AssetCorrection['source'];
    passId: string | null;
    itemId: string;
    itemName: string | null;
    itemKind: 'folder' | 'asset';
    change: AssetCorrection['change'];
    field: string | null;
    oldValue: unknown;
    newValue: unknown;
    detail: string | null;
  }): void {
    const cut = (v: unknown): string | null => {
      if (v === undefined) return null;
      const s = JSON.stringify(v);
      return s.length > LOG_VALUE_MAX ? JSON.stringify(`${s.slice(0, LOG_VALUE_MAX)}… (cut)`) : s;
    };
    this.db
      .prepare(
        `INSERT INTO asset_log (project_id, at, source, pass_id, item_id, item_name, item_kind, change, field,
           old_value, new_value, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.projectId,
        this.now(),
        e.source,
        e.passId,
        e.itemId,
        e.itemName,
        e.itemKind,
        e.change,
        e.field,
        cut(e.oldValue),
        cut(e.newValue),
        e.detail,
      );
  }

  listLog(
    projectId: string,
    o: {
      limit: number;
      before?: number | undefined;
      source?: AssetCorrection['source'] | undefined;
      passId?: string | undefined;
    },
  ): AssetCorrection[] {
    const where = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (o.before !== undefined) {
      where.push('id < ?');
      args.push(o.before);
    }
    if (o.source) {
      where.push('source = ?');
      args.push(o.source);
    }
    if (o.passId) {
      where.push('pass_id = ?');
      args.push(o.passId);
    }
    args.push(o.limit);
    const rows = this.db
      .prepare(`SELECT * FROM asset_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
      .all(...args) as {
      id: number;
      at: number;
      source: AssetCorrection['source'];
      pass_id: string | null;
      item_id: string;
      item_name: string | null;
      item_kind: 'folder' | 'asset';
      change: AssetCorrection['change'];
      field: string | null;
      old_value: string | null;
      new_value: string | null;
      detail: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      source: r.source,
      passId: r.pass_id,
      itemId: r.item_id,
      itemName: r.item_name,
      itemKind: r.item_kind,
      change: r.change,
      field: r.field,
      oldValue: parse(r.old_value, null),
      newValue: parse(r.new_value, null),
      detail: r.detail,
    }));
  }

  // ============================================================================================== views

  static folderView(this: void, r: FolderRow): AssetFolder {
    return {
      id: r.id,
      name: r.name,
      parentId: r.parent_id,
      depth: r.depth,
      path: { ids: parse<string[]>(r.path_ids, []), names: parse<string[]>(r.path_names, []) },
      isHidden: r.is_hidden === 1,
      lastReadAt: r.last_read_at,
      lastReadBy: r.last_read_by,
      stale: r.stale === 1,
      staleReason: r.stale_reason,
    };
  }

  static itemView(this: void, r: ItemRow): AssetItem {
    return {
      id: r.id,
      name: r.name,
      folderId: r.folder_id,
      type: r.type,
      url: r.url,
      width: r.width,
      height: r.height,
      size: r.size,
      sha256: r.sha256,
      isHidden: r.is_hidden === 1,
      createdAt: r.lk_created_at,
      lastReadAt: r.last_read_at,
      lastReadBy: r.last_read_by,
      stale: r.stale === 1,
      staleReason: r.stale_reason,
    };
  }
}

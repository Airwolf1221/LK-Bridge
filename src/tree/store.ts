/**
 * The repository tree's tables (migration 0700) and the rules for changing them (ADR 0025). Synchronous, like every
 * other store: each method that changes the tree runs in one SQLite transaction, so a change is all or nothing.
 *
 * The one rule every change follows: **an observation never replaces one made later.** Each node keeps when its
 * structure (`struct_observed_at`) and its properties (`props_observed_at`) were observed; a removal leaves a tombstone
 * with its time. A sweep or check that listed at time T therefore never undoes an update that the bridge's own write
 * made after T, never deletes a node the bridge created after T, and never brings back one the bridge deleted after T.
 */
import type { Db } from '../db/open.js';
import { catalogueFrom, classifyName, nameKey, type TreeSettings } from './classify.js';
import type {
  BuildEstimate,
  CorrectionEntry,
  NameField,
  NodeKind,
  Observation,
  PassKind,
  PassStatus,
  PassView,
  ReadBy,
  RootSuggestion,
  SidebarBlock,
  TreeDocument,
  TreeNode,
} from './types.js';

export interface NodeRow {
  project_id: string;
  id: string;
  raw_name: string;
  display_name: string;
  kind: NodeKind;
  parent_id: string | null;
  rank: string | null;
  depth: number;
  path_ids: string;
  path_names: string;
  tags: string;
  aliases: string;
  documents: string;
  is_hidden: number;
  is_locked: number | null;
  reference_type: string | null;
  scope: string | null;
  index_scope: string | null;
  canonical_name: string | null;
  properties_found: number | null;
  sidebar: string | null;
  template_id: string | null;
  template_recorded_at: number | null;
  struct_observed_at: number;
  props_observed_at: number | null;
  props_pass: string | null;
  last_read_at: number;
  last_read_by: ReadBy;
  stale: number;
  stale_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface StateRow {
  project_id: string;
  root_id: string | null;
  built_at: number | null;
  confirmed_at: number | null;
  confirmed_by: PassKind | null;
  suggestion: string | null;
  catalogue_key: string | null;
  updated_at: number;
}

interface PassRow {
  id: string;
  project_id: string;
  kind: PassKind;
  trigger: string;
  status: PassStatus;
  root_id: string;
  snapshot_at: number | null;
  cursor: string | null;
  pages: number;
  listed: number;
  subtree: number | null;
  to_read: number | null;
  read_ok: number;
  read_failed: number;
  requests: number;
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

export interface PendingRow {
  id: number;
  project_id: string;
  job_id: string | null;
  step_no: number | null;
  op: string;
  resource_ids: string;
  flags: string;
  status: 'in_flight' | 'retry';
  attempts: number;
  last_error: string | null;
  next_at: number | null;
  attempted_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Where an apply comes from, and whether its changes are corrections to log. */
export interface ApplyContext {
  readonly projectId: string;
  readonly rootId: string;
  readonly settings: TreeSettings;
  readonly by: ReadBy;
  /** Sweeps and checks log what they correct; builds and after-write updates do not. */
  readonly log?: { readonly source: 'sweep' | 'check'; readonly passId: string } | undefined;
  /** The pass reading properties (marks the node as read by it, so a resumed pass does not read it again). */
  readonly passId?: string | undefined;
}

export type ApplyOutcome = 'added' | 'updated' | 'unchanged' | 'skipped' | 'outside' | 'removed';

const j = (v: unknown): string => JSON.stringify(v);
function parse<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** The fields a correction can name, with how to read each from a stored row. */
const STRUCT_FIELDS: readonly [string, (r: NodeRow) => unknown][] = [
  ['name', (r) => r.raw_name],
  ['parentId', (r) => r.parent_id],
  ['rank', (r) => r.rank],
  ['tags', (r) => parse(r.tags, [])],
  ['aliases', (r) => parse(r.aliases, [])],
  ['documents', (r) => parse(r.documents, [])],
  ['isHidden', (r) => r.is_hidden === 1],
];
const PROP_FIELDS: readonly [string, (r: NodeRow) => unknown][] = [
  ['isLocked', (r) => (r.is_locked === null ? null : r.is_locked === 1)],
  ['referenceType', (r) => r.reference_type],
  ['scope', (r) => r.scope],
  ['indexScope', (r) => r.index_scope],
  ['canonicalDisplayName', (r) => r.canonical_name],
  ['propertiesFound', (r) => (r.properties_found === null ? null : r.properties_found === 1)],
  ['sidebar', (r) => parse(r.sidebar, null)],
];

/** The largest JSON value kept in one correction-log entry; longer values are cut (with a note). */
const LOG_VALUE_MAX = 4096;
/** Correction-log entries kept per project. */
export const LOG_KEEP = 10_000;
/** Tombstones are needed only while a pass that listed before them may still apply: kept two days. */
const TOMBSTONE_KEEP_MS = 2 * 86_400_000;

export class TreeStore {
  constructor(
    readonly db: Db,
    private readonly now: () => number,
  ) {}

  // ============================================================================================== state

  state(projectId: string): StateRow | undefined {
    return this.db.prepare('SELECT * FROM tree_state WHERE project_id = ?').get(projectId) as
      StateRow | undefined;
  }

  /**
   * Makes the stored tree belong to `rootId` (null: none). When the project's root setting changed (on the dashboard or
   * with the CLI), the old tree, its passes, listings and owed re-reads are discarded. Returns whether it discarded.
   */
  ensureRoot(projectId: string, rootId: string | null): boolean {
    return this.db.transaction(() => {
      const s = this.state(projectId);
      const at = this.now();
      if (!s) {
        this.db
          .prepare('INSERT INTO tree_state (project_id, root_id, updated_at) VALUES (?, ?, ?)')
          .run(projectId, rootId, at);
        return false;
      }
      if (s.root_id === rootId) return false;
      this.db.prepare('DELETE FROM tree_nodes WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM tree_tombstones WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM tree_pending WHERE project_id = ?').run(projectId);
      this.db
        .prepare(
          `UPDATE tree_passes SET status = 'cancelled', error = 'The AI REPOSITORY root changed.', finished_at = ?,
             updated_at = ? WHERE project_id = ? AND status IN ('listing', 'awaiting_confirmation', 'reading')`,
        )
        .run(at, at, projectId);
      this.db
        .prepare(
          'DELETE FROM tree_listing WHERE pass_id IN (SELECT id FROM tree_passes WHERE project_id = ?)',
        )
        .run(projectId);
      this.db
        .prepare(
          `UPDATE tree_state SET root_id = ?, built_at = NULL, confirmed_at = NULL, confirmed_by = NULL,
             updated_at = ? WHERE project_id = ?`,
        )
        .run(rootId, at, projectId);
      return true;
    })();
  }

  setConfirmed(projectId: string, at: number, by: PassKind): void {
    const now = this.now();
    this.db
      .prepare(
        `UPDATE tree_state SET confirmed_at = MAX(COALESCE(confirmed_at, 0), ?), confirmed_by = ?,
           built_at = CASE WHEN ? = 'build' THEN COALESCE(built_at, ?) ELSE built_at END, updated_at = ?
         WHERE project_id = ?`,
      )
      .run(at, by, by, now, now, projectId);
  }

  setCatalogueKey(projectId: string, key: string): void {
    this.db
      .prepare('UPDATE tree_state SET catalogue_key = ?, updated_at = ? WHERE project_id = ?')
      .run(key, this.now(), projectId);
  }

  setSuggestion(projectId: string, s: RootSuggestion): void {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO tree_state (project_id, suggestion, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET suggestion = excluded.suggestion, updated_at = excluded.updated_at`,
      )
      .run(projectId, j(s), at);
  }

  suggestion(projectId: string): RootSuggestion | null {
    return parse<RootSuggestion | null>(this.state(projectId)?.suggestion ?? null, null);
  }

  // ============================================================================================== nodes

  node(projectId: string, id: string): NodeRow | undefined {
    return this.db.prepare('SELECT * FROM tree_nodes WHERE project_id = ? AND id = ?').get(projectId, id) as
      NodeRow | undefined;
  }

  has(projectId: string, id: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM tree_nodes WHERE project_id = ? AND id = ?').get(projectId, id) !==
      undefined
    );
  }

  /** Every id in the subtree of `id` (itself included), from the stored tree. */
  subtreeIds(projectId: string, id: string): string[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM tree_nodes WHERE project_id = ? AND id = ?
           UNION ALL
           SELECT n.id FROM tree_nodes n JOIN sub ON n.parent_id = sub.id WHERE n.project_id = ?
         ) SELECT id FROM sub`,
      )
      .all(projectId, id, projectId) as { id: string }[];
    return rows.map((r) => r.id);
  }

  count(projectId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM tree_nodes WHERE project_id = ?').get(projectId) as {
        n: number;
      }
    ).n;
  }

  staleCount(projectId: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM tree_nodes WHERE project_id = ? AND stale = 1')
        .get(projectId) as {
        n: number;
      }
    ).n;
  }

  tombstone(projectId: string, id: string): { observed_at: number; reason: string } | undefined {
    return this.db
      .prepare('SELECT observed_at, reason FROM tree_tombstones WHERE project_id = ? AND id = ?')
      .get(projectId, id) as { observed_at: number; reason: string } | undefined;
  }

  static toView(r: NodeRow): TreeNode {
    return {
      id: r.id,
      rawName: r.raw_name,
      displayName: r.display_name,
      kind: r.kind,
      parentId: r.parent_id,
      rank: r.rank,
      depth: r.depth,
      path: { ids: parse<string[]>(r.path_ids, []), names: parse<string[]>(r.path_names, []) },
      tags: parse<string[]>(r.tags, []),
      aliases: parse<string[]>(r.aliases, []),
      documents: parse<TreeDocument[]>(r.documents, []),
      isHidden: r.is_hidden === 1,
      isLocked: r.is_locked === null ? null : r.is_locked === 1,
      referenceType: r.reference_type,
      scope: r.scope,
      indexScope: r.index_scope,
      canonicalDisplayName: r.canonical_name,
      propertiesFound: r.properties_found === null ? null : r.properties_found === 1,
      templateId: r.template_id,
      lastReadAt: r.last_read_at,
      lastReadBy: r.last_read_by,
      propertiesPending: r.props_observed_at === null,
      stale: r.stale === 1,
      staleReason: r.stale_reason,
    };
  }

  // ============================================================================================== applying

  /**
   * Applies what one read says about a resource, observed at `t`. Structure (and, from getResource, properties) is
   * applied only where nothing newer is stored. A resource whose parent is neither the root nor a node of the tree is
   * outside it: if it was a node, it and its subtree are removed (it was moved out).
   */
  /** v2 C2b: records the template the bridge created a page from (kept by later observations; only C2b sets it). */
  setTemplate(projectId: string, id: string, templateId: string): void {
    this.db
      .prepare('UPDATE tree_nodes SET template_id = ? WHERE project_id = ? AND id = ?')
      .run(templateId, projectId, id);
  }

  applyObservation(ctx: ApplyContext, obs: Observation, t: number): ApplyOutcome {
    return this.db.transaction(() => (this.rootChanged(ctx) ? 'skipped' : this.applyOne(ctx, obs, t)))();
  }

  /** A read made for another root than the stored tree's (the setting changed meanwhile) changes nothing. */
  private rootChanged(ctx: ApplyContext): boolean {
    return this.state(ctx.projectId)?.root_id !== ctx.rootId;
  }

  private applyOne(ctx: ApplyContext, obs: Observation, t: number): ApplyOutcome {
    const { projectId, rootId } = ctx;
    const existing = this.node(projectId, obs.id);
    const isRoot = obs.id === rootId;
    if (!existing) {
      const tomb = this.tombstone(projectId, obs.id);
      if (tomb && tomb.observed_at > t) return 'skipped';
    }
    const inTree =
      isRoot || (obs.parentId !== null && (obs.parentId === rootId || this.has(projectId, obs.parentId)));
    if (!inTree) {
      if (existing && existing.struct_observed_at <= t) {
        this.removeSubtree(ctx, obs.id, t, 'moved outside the root');
        return 'removed';
      }
      return existing ? 'skipped' : 'outside';
    }
    if (!existing) {
      this.insertNode(ctx, obs, t, isRoot);
      if (ctx.log) this.log(ctx, obs.id, obs.name, 'added', null, null, null, 'found under the root');
      return 'added';
    }
    const structNewer = existing.struct_observed_at <= t;
    const propsNewer = obs.props !== undefined && (existing.props_observed_at ?? -Infinity) <= t;
    if (!structNewer && !propsNewer) return 'skipped';
    const changed = this.updateNode(ctx, existing, obs, t, structNewer, propsNewer, isRoot);
    return changed ? 'updated' : 'unchanged';
  }

  private insertNode(ctx: ApplyContext, obs: Observation, t: number, isRoot: boolean): void {
    const at = this.now();
    const c = isRoot ? { kind: 'root' as const, displayName: obs.name } : classifyName(obs.name);
    const cat = obs.props ? catalogueFrom(obs.props.sidebar, ctx.settings) : null;
    this.db
      .prepare(
        `INSERT INTO tree_nodes (project_id, id, raw_name, display_name, kind, parent_id, rank, depth, path_ids,
           path_names, tags, aliases, documents, is_hidden, is_locked, reference_type, scope, index_scope,
           canonical_name, properties_found, sidebar, struct_observed_at, props_observed_at, props_pass, last_read_at,
           last_read_by, stale, stale_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, '[]', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      )
      .run(
        ctx.projectId,
        obs.id,
        obs.name,
        c.displayName,
        c.kind,
        isRoot ? null : obs.parentId,
        obs.rank,
        j(obs.tags),
        j(obs.aliases),
        j(obs.documents),
        obs.isHidden ? 1 : 0,
        obs.props ? (obs.props.isLocked ? 1 : 0) : null,
        cat?.referenceType ?? null,
        cat?.scope ?? null,
        cat?.indexScope ?? null,
        cat?.canonicalDisplayName ?? null,
        cat ? (cat.propertiesFound ? 1 : 0) : null,
        obs.props ? j(obs.props.sidebar) : null,
        t,
        obs.props ? t : null,
        obs.props ? (ctx.passId ?? null) : null,
        t,
        ctx.by,
        at,
        at,
      );
    this.db.prepare('DELETE FROM tree_tombstones WHERE project_id = ? AND id = ?').run(ctx.projectId, obs.id);
    this.writeNames(ctx.projectId, obs.id);
  }

  /** Applies the newer parts of `obs` to a stored node. Returns whether any stored value changed. */
  private updateNode(
    ctx: ApplyContext,
    old: NodeRow,
    obs: Observation,
    t: number,
    structNewer: boolean,
    propsNewer: boolean,
    isRoot: boolean,
  ): boolean {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (structNewer) {
      const c = isRoot ? { kind: 'root' as const, displayName: obs.name } : classifyName(obs.name);
      set('raw_name', obs.name);
      set('display_name', c.displayName);
      set('kind', c.kind);
      set('parent_id', isRoot ? null : obs.parentId);
      set('rank', obs.rank);
      set('tags', j(obs.tags));
      set('aliases', j(obs.aliases));
      set('documents', j(obs.documents));
      set('is_hidden', obs.isHidden ? 1 : 0);
      set('struct_observed_at', t);
    }
    if (propsNewer && obs.props) {
      const cat = catalogueFrom(obs.props.sidebar, ctx.settings);
      set('is_locked', obs.props.isLocked ? 1 : 0);
      set('sidebar', j(obs.props.sidebar));
      set('reference_type', cat.referenceType);
      set('scope', cat.scope);
      set('index_scope', cat.indexScope);
      set('canonical_name', cat.canonicalDisplayName);
      set('properties_found', cat.propertiesFound ? 1 : 0);
      set('props_observed_at', t);
      set('props_pass', ctx.passId ?? null);
    }
    // A read of the whole resource (getResource) settles a stale node; a listing settles only one that was stale
    // because its place in the tree was unknown.
    if (structNewer && propsNewer) {
      set('stale', 0);
      set('stale_reason', null);
    }
    set('last_read_at', Math.max(old.last_read_at, t));
    set('last_read_by', ctx.by);
    set('updated_at', this.now());
    vals.push(ctx.projectId, old.id);
    this.db.prepare(`UPDATE tree_nodes SET ${sets.join(', ')} WHERE project_id = ? AND id = ?`).run(...vals);
    const now = this.node(ctx.projectId, old.id)!;
    let changed = false;
    for (const [field, read] of [...(structNewer ? STRUCT_FIELDS : []), ...(propsNewer ? PROP_FIELDS : [])]) {
      const before = read(old);
      const after = read(now);
      if (j(before) === j(after)) continue;
      // A first read of the properties is not a correction: nothing was known before.
      if (field !== 'isLocked' && PROP_FIELDS.some(([f]) => f === field) && old.props_observed_at === null) {
        changed = true;
        continue;
      }
      if (field === 'isLocked' && old.is_locked === null) {
        changed = true;
        continue;
      }
      changed = true;
      if (ctx.log) this.log(ctx, old.id, now.raw_name, 'updated', field, before, after, null);
    }
    if (
      structNewer &&
      (old.raw_name !== now.raw_name ||
        old.aliases !== now.aliases ||
        old.canonical_name !== now.canonical_name)
    ) {
      this.writeNames(ctx.projectId, old.id);
    } else if (propsNewer && old.canonical_name !== now.canonical_name) {
      this.writeNames(ctx.projectId, old.id);
    }
    return changed;
  }

  /**
   * A resource observed gone at `t` (404, or deleted): removes it and its stored subtree, unless the node was
   * observed after `t`. Returns how many nodes were removed.
   */
  applyGone(ctx: ApplyContext, id: string, t: number, reason: string): number {
    return this.db.transaction(() => {
      if (this.rootChanged(ctx)) return 0;
      const existing = this.node(ctx.projectId, id);
      if (!existing) {
        this.tombstoneAt(ctx.projectId, id, t, reason);
        return 0;
      }
      if (existing.struct_observed_at > t) return 0;
      return this.removeSubtree(ctx, id, t, reason);
    })();
  }

  private tombstoneAt(projectId: string, id: string, t: number, reason: string): void {
    this.db
      .prepare(
        `INSERT INTO tree_tombstones (project_id, id, observed_at, reason) VALUES (?, ?, ?, ?)
         ON CONFLICT (project_id, id) DO UPDATE SET observed_at = excluded.observed_at, reason = excluded.reason
         WHERE excluded.observed_at >= tree_tombstones.observed_at`,
      )
      .run(projectId, id, t, reason);
  }

  /** Removes a node and every stored descendant, each with a tombstone at `t`. */
  private removeSubtree(ctx: ApplyContext, id: string, t: number, reason: string): number {
    const ids = this.subtreeIds(ctx.projectId, id);
    const del = this.db.prepare('DELETE FROM tree_nodes WHERE project_id = ? AND id = ?');
    for (const x of ids) {
      const row = ctx.log ? this.node(ctx.projectId, x) : undefined;
      del.run(ctx.projectId, x);
      this.tombstoneAt(ctx.projectId, x, t, x === id ? reason : `its ancestor was ${reason}`);
      if (ctx.log && row) {
        this.log(
          ctx,
          x,
          row.raw_name,
          'removed',
          null,
          null,
          null,
          x === id ? reason : `its ancestor was ${reason}`,
        );
      }
    }
    return ids.length;
  }

  /** Marks nodes stale (a re-read failed, or their place is unknown). Unknown ids are ignored. */
  markStale(projectId: string, ids: readonly string[], reason: string): number {
    const st = this.db.prepare(
      'UPDATE tree_nodes SET stale = 1, stale_reason = ?, updated_at = ? WHERE project_id = ? AND id = ?',
    );
    let n = 0;
    this.db.transaction(() => {
      for (const id of ids) n += st.run(reason.slice(0, 500), this.now(), projectId, id).changes;
    })();
    return n;
  }

  /** Re-derives every node's catalogue fields from its stored sidebar (after the property or row names changed). */
  recomputeCatalogue(projectId: string, settings: TreeSettings): number {
    this.reclassify(projectId);
    const rows = this.db
      .prepare('SELECT id, sidebar FROM tree_nodes WHERE project_id = ? AND sidebar IS NOT NULL')
      .all(projectId) as { id: string; sidebar: string }[];
    const up = this.db.prepare(
      `UPDATE tree_nodes SET reference_type = ?, scope = ?, index_scope = ?, canonical_name = ?, properties_found = ?
       WHERE project_id = ? AND id = ?`,
    );
    this.db.transaction(() => {
      for (const r of rows) {
        const c = catalogueFrom(parse<SidebarBlock[]>(r.sidebar, []), settings);
        up.run(
          c.referenceType,
          c.scope,
          c.indexScope,
          c.canonicalDisplayName,
          c.propertiesFound ? 1 : 0,
          projectId,
          r.id,
        );
        this.writeNames(projectId, r.id);
      }
    })();
    return rows.length;
  }

  /**
   * v2 C2c (ADR 0035): every node's kind and display name derived again from its raw name (no reads), with its names and
   * the paths below it. A tree stored before `[BWRK]` and `[BARC]` were kinds held them as unclassified. Returns the
   * number of nodes changed.
   */
  reclassify(projectId: string): number {
    const rows = this.db
      .prepare(
        "SELECT id, raw_name, display_name, kind FROM tree_nodes WHERE project_id = ? AND kind <> 'root'",
      )
      .all(projectId) as { id: string; raw_name: string; display_name: string; kind: NodeKind }[];
    const up = this.db.prepare(
      'UPDATE tree_nodes SET kind = ?, display_name = ? WHERE project_id = ? AND id = ?',
    );
    let n = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        const c = classifyName(r.raw_name);
        if (c.kind === r.kind && c.displayName === r.display_name) continue;
        up.run(c.kind, c.displayName, projectId, r.id);
        this.writeNames(projectId, r.id);
        n++;
      }
      const root = this.state(projectId)?.root_id ?? null;
      if (n > 0 && root) this.recomputePaths(projectId, root);
    })();
    return n;
  }

  /** The names a node answers to (exact-name lookups): raw, display, each alias and the Canonical Display Name. */
  private writeNames(projectId: string, id: string): void {
    const r = this.node(projectId, id);
    this.db.prepare('DELETE FROM tree_names WHERE project_id = ? AND node_id = ?').run(projectId, id);
    if (!r) return;
    const ins = this.db.prepare(
      'INSERT INTO tree_names (project_id, node_id, field, name, name_key) VALUES (?, ?, ?, ?, ?)',
    );
    const add = (field: NameField, name: string | null) => {
      if (name === null || name === '') return;
      ins.run(projectId, id, field, name, nameKey(name));
    };
    add('raw', r.raw_name);
    add('display', r.display_name);
    for (const a of parse<string[]>(r.aliases, [])) add('alias', a);
    add('canonical', r.canonical_name);
  }

  /**
   * Recomputes every node's path and depth from the root (display names cached in the path). A node whose parent is
   * not in the tree keeps its old path and is marked stale until a pass places it. Returns the number of rows changed.
   */
  recomputePaths(projectId: string, rootId: string): number {
    const rows = this.db
      .prepare(
        'SELECT id, parent_id, display_name, depth, path_ids, path_names, stale, stale_reason FROM tree_nodes WHERE project_id = ?',
      )
      .all(projectId) as {
      id: string;
      parent_id: string | null;
      display_name: string;
      depth: number;
      path_ids: string;
      path_names: string;
      stale: number;
      stale_reason: string | null;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const children = new Map<string, string[]>();
    for (const r of rows) {
      if (r.id === rootId || r.parent_id === null) continue;
      const list = children.get(r.parent_id) ?? [];
      list.push(r.id);
      children.set(r.parent_id, list);
    }
    const computed = new Map<string, { ids: string[]; names: string[] }>();
    const root = byId.get(rootId);
    if (root) {
      computed.set(rootId, { ids: [rootId], names: [root.display_name] });
      const queue = [rootId];
      for (let qi = 0; qi < queue.length; qi++) {
        const id = queue[qi]!;
        const p = computed.get(id)!;
        for (const c of children.get(id) ?? []) {
          if (computed.has(c)) continue; // a cycle cannot happen at LK; never loop on bad data
          const row = byId.get(c)!;
          computed.set(c, { ids: [...p.ids, c], names: [...p.names, row.display_name] });
          queue.push(c);
        }
      }
    }
    const ORPHAN = 'its parent is not in the tree; the next sweep places it';
    const up = this.db.prepare(
      'UPDATE tree_nodes SET depth = ?, path_ids = ?, path_names = ?, stale = ?, stale_reason = ? WHERE project_id = ? AND id = ?',
    );
    let n = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        const p = computed.get(r.id);
        if (!p) {
          if (r.stale !== 1) {
            up.run(r.depth, r.path_ids, r.path_names, 1, ORPHAN, projectId, r.id);
            n++;
          }
          continue;
        }
        const ids = j(p.ids);
        const names = j(p.names);
        const depth = p.ids.length - 1;
        const clearOrphan = r.stale === 1 && r.stale_reason === ORPHAN;
        if (ids !== r.path_ids || names !== r.path_names || depth !== r.depth || clearOrphan) {
          up.run(
            depth,
            ids,
            names,
            clearOrphan ? 0 : r.stale,
            clearOrphan ? null : r.stale_reason,
            projectId,
            r.id,
          );
          n++;
        }
      }
    })();
    return n;
  }

  // ============================================================================================== listings

  /** Stores listed resources for a pass, observed at `t`; a row observed later is kept. */
  stage(passId: string, projectId: string, items: readonly Observation[], t: number): void {
    const st = this.db.prepare(
      `INSERT INTO tree_listing (pass_id, project_id, id, name, parent_id, rank, tags, aliases, documents, is_hidden,
         observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (pass_id, id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id,
         rank = excluded.rank, tags = excluded.tags, aliases = excluded.aliases, documents = excluded.documents,
         is_hidden = excluded.is_hidden, observed_at = excluded.observed_at
       WHERE excluded.observed_at >= tree_listing.observed_at`,
    );
    for (const o of items) {
      st.run(
        passId,
        projectId,
        o.id,
        o.name,
        o.parentId,
        o.rank,
        j(o.tags),
        j(o.aliases),
        j(o.documents),
        o.isHidden ? 1 : 0,
        t,
      );
    }
  }

  /**
   * An observation made while a pass of `projectId` is still listing goes into its listing too, so the pass's
   * reconciliation sees it (the first build has no stored tree to hold it yet).
   */
  stageIfListing(projectId: string, obs: Observation, t: number): void {
    const p = this.activePass(projectId);
    if (p && (p.status === 'listing' || p.status === 'awaiting_confirmation')) {
      this.stage(p.id, projectId, [obs], t);
    }
  }

  /**
   * Reconciles the stored tree with a pass's listing, snapshot at `T`: adds what is new under the root, updates
   * structure that changed, and removes what the listing shows moved outside the root; everything observed after `T`
   * is left alone. A stored node the listing does not show is marked stale ("unconfirmed"), not removed: the pass
   * reads it, and only a 404 removes it. The root missing from the listing is an error (nothing changes).
   */
  reconcile(
    ctx: ApplyContext,
    passId: string,
    T: number,
  ):
    | { ok: true; added: string[]; removed: number; subtree: number; unconfirmed: number }
    | { ok: false; error: string } {
    return this.db.transaction(() => {
      const { projectId, rootId } = ctx;
      if (this.rootChanged(ctx)) {
        return { ok: false as const, error: 'The AI REPOSITORY root changed while this pass was running.' };
      }
      const staged = this.db.prepare('SELECT * FROM tree_listing WHERE pass_id = ?').all(passId) as {
        id: string;
        name: string;
        parent_id: string | null;
        rank: string | null;
        tags: string;
        aliases: string;
        documents: string;
        is_hidden: number;
        observed_at: number;
      }[];
      const nodes = this.db
        .prepare('SELECT id, parent_id, struct_observed_at FROM tree_nodes WHERE project_id = ?')
        .all(projectId) as { id: string; parent_id: string | null; struct_observed_at: number }[];
      const tombs = new Map(
        (
          this.db
            .prepare('SELECT id, observed_at FROM tree_tombstones WHERE project_id = ?')
            .all(projectId) as {
            id: string;
            observed_at: number;
          }[]
        ).map((r) => [r.id, r.observed_at]),
      );
      const stagedById = new Map(staged.map((s) => [s.id, s]));
      const nodeById = new Map(nodes.map((n) => [n.id, n]));

      // The merged view: per resource, the newest of (listing, stored node), minus what was removed later.
      const parentOf = new Map<string, string | null>();
      const fromListing = new Set<string>();
      const unconfirmed: string[] = [];
      for (const id of new Set([...stagedById.keys(), ...nodeById.keys()])) {
        const s = stagedById.get(id);
        const n = nodeById.get(id);
        let pick: { parent: string | null; at: number; listing: boolean } | null = null;
        if (s && (!n || s.observed_at > n.struct_observed_at)) {
          pick = { parent: s.parent_id, at: s.observed_at, listing: true };
        } else if (n) {
          // A stored node the listing did not show is NOT taken as gone: a listing paged while resources are added or
          // deleted can skip one. It stays where it is, marked stale, and the pass reads it (a 404 removes it).
          if (!s && n.struct_observed_at <= T) unconfirmed.push(id);
          pick = { parent: n.parent_id, at: n.struct_observed_at, listing: false };
        }
        if (!pick) continue;
        const tomb = tombs.get(id);
        if (tomb !== undefined && tomb > pick.at) continue;
        parentOf.set(id, id === rootId ? null : pick.parent);
        if (pick.listing) fromListing.add(id);
      }
      if (!parentOf.has(rootId)) {
        return {
          ok: false as const,
          error: `The AI REPOSITORY root ${rootId} was not in the listing: it was deleted, or the key cannot see it.`,
        };
      }
      const children = new Map<string, string[]>();
      for (const [id, parent] of parentOf) {
        if (parent === null || id === rootId) continue;
        const l = children.get(parent) ?? [];
        l.push(id);
        children.set(parent, l);
      }
      const inSubtree = new Set<string>([rootId]);
      const queue = [rootId];
      for (let qi = 0; qi < queue.length; qi++) {
        const id = queue[qi]!;
        for (const c of children.get(id) ?? []) {
          if (inSubtree.has(c)) continue;
          inSubtree.add(c);
          queue.push(c);
        }
      }

      /** The merged view shows the chain of parents from `id` up to a top-level resource, without the root. */
      const provenOutside = (id: string): boolean => {
        let cur: string | null | undefined = id;
        for (let i = 0; i < 64; i++) {
          if (cur === rootId) return false;
          if (cur === null) return true;
          if (cur === undefined || !parentOf.has(cur)) return false; // a parent the listing did not show
          cur = parentOf.get(cur);
        }
        return false;
      };
      const added: string[] = [];
      // Parents first, so membership tests in applyOne see them.
      const order = [...inSubtree];
      for (const id of order) {
        if (!fromListing.has(id)) continue; // the stored node is newer: leave it
        const s = stagedById.get(id)!;
        const obs: Observation = {
          id,
          name: s.name,
          parentId: s.parent_id,
          rank: s.rank,
          tags: parse<string[]>(s.tags, []),
          aliases: parse<string[]>(s.aliases, []),
          documents: parse<TreeDocument[]>(s.documents, []),
          isHidden: s.is_hidden === 1,
        };
        if (this.applyOne(ctx, obs, s.observed_at) === 'added') added.push(id);
      }
      let removed = 0;
      for (const n of nodes) {
        if (inSubtree.has(n.id)) continue;
        const row = this.node(projectId, n.id);
        if (!row) continue; // removed with an ancestor already
        if (row.struct_observed_at > T || !fromListing.has(n.id) || !provenOutside(n.id)) {
          // Newer than the listing, or under a parent the listing did not show (it may have skipped one): the pass
          // reads it and finds out where it is.
          this.markStaleRow(projectId, n.id, 'not under the root in the last listing; being checked');
          continue;
        }
        // The listing shows its whole chain of parents up to a top-level resource that is not the root: it moved out.
        removed += this.removeSubtree(ctx, n.id, T, 'moved outside the root');
      }
      for (const id of unconfirmed) {
        if (this.has(projectId, id))
          this.markStaleRow(projectId, id, 'not in the last listing; being checked');
      }
      this.recomputePaths(projectId, rootId);
      return { ok: true as const, added, removed, subtree: inSubtree.size, unconfirmed: unconfirmed.length };
    })();
  }

  private markStaleRow(projectId: string, id: string, reason: string): void {
    this.db
      .prepare(
        'UPDATE tree_nodes SET stale = 1, stale_reason = ?, updated_at = ? WHERE project_id = ? AND id = ?',
      )
      .run(reason, this.now(), projectId, id);
  }

  /**
   * Ids of stored nodes whose properties a pass still has to read, parents first: for a sweep, the nodes never read
   * and the stale ones; for a build or check, every node not read since the pass's snapshot `T`.
   */
  idsToRead(projectId: string, passId: string, kind: PassKind, T: number, limit: number): string[] {
    const { where, args } = toReadFilter(projectId, passId, kind, T);
    return (
      this.db
        .prepare(`SELECT id FROM tree_nodes WHERE ${where} ORDER BY depth, id LIMIT ?`)
        .all(...args, limit) as { id: string }[]
    ).map((r) => r.id);
  }

  /** Marks a node as handled by a pass without a change (a read that found it gone, or failed). */
  markPassed(projectId: string, id: string, passId: string): void {
    this.db
      .prepare('UPDATE tree_nodes SET props_pass = ? WHERE project_id = ? AND id = ?')
      .run(passId, projectId, id);
  }

  countToRead(projectId: string, passId: string, kind: PassKind, T: number): number {
    const { where, args } = toReadFilter(projectId, passId, kind, T);
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM tree_nodes WHERE ${where}`).get(...args) as { n: number }
    ).n;
  }

  // ============================================================================================== passes

  createPass(p: {
    id: string;
    projectId: string;
    kind: PassKind;
    trigger: string;
    rootId: string;
  }): PassView {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO tree_passes (id, project_id, kind, trigger, status, root_id, started_at, updated_at)
         VALUES (?, ?, ?, ?, 'listing', ?, ?, ?)`,
      )
      .run(p.id, p.projectId, p.kind, p.trigger, p.rootId, at, at);
    return this.pass(p.id)!;
  }

  updatePass(
    id: string,
    patch: Partial<{
      status: PassStatus;
      snapshotAt: number | null;
      cursor: string | null;
      pages: number;
      listed: number;
      subtree: number | null;
      toRead: number | null;
      readOk: number;
      readFailed: number;
      requests: number;
      added: number;
      removed: number;
      corrected: number;
      estimate: BuildEstimate | null;
      summary: string | null;
      error: string | null;
      jobId: string | null;
      finishedAt: number | null;
    }>,
  ): void {
    const cols: Record<string, string> = {
      status: 'status',
      snapshotAt: 'snapshot_at',
      cursor: 'cursor',
      pages: 'pages',
      listed: 'listed',
      subtree: 'subtree',
      toRead: 'to_read',
      readOk: 'read_ok',
      readFailed: 'read_failed',
      requests: 'requests',
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
    this.db.prepare(`UPDATE tree_passes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  /** Adds to a pass's counters (one statement, so concurrent progress is never lost). */
  bumpPass(
    id: string,
    d: Partial<Record<'requests' | 'readOk' | 'readFailed' | 'added' | 'removed' | 'corrected', number>>,
  ): void {
    const cols = {
      requests: 'requests',
      readOk: 'read_ok',
      readFailed: 'read_failed',
      added: 'added',
      removed: 'removed',
      corrected: 'corrected',
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
    this.db.prepare(`UPDATE tree_passes SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals);
  }

  pass(id: string): PassView | undefined {
    const r = this.db.prepare('SELECT * FROM tree_passes WHERE id = ?').get(id) as PassRow | undefined;
    return r ? toPassView(r) : undefined;
  }

  passCursor(id: string): string | null {
    return (
      (
        this.db.prepare('SELECT cursor FROM tree_passes WHERE id = ?').get(id) as
          { cursor: string | null } | undefined
      )?.cursor ?? null
    );
  }

  activePass(projectId: string): PassView | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM tree_passes WHERE project_id = ? AND status IN ('listing', 'awaiting_confirmation', 'reading')`,
      )
      .get(projectId) as PassRow | undefined;
    return r ? toPassView(r) : undefined;
  }

  /** Every active pass of every project (start-up). */
  activePasses(): PassView[] {
    return (
      this.db
        .prepare(`SELECT * FROM tree_passes WHERE status IN ('listing', 'awaiting_confirmation', 'reading')`)
        .all() as PassRow[]
    ).map(toPassView);
  }

  lastPass(projectId: string, kind: PassKind, finishedOnly = true): PassView | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM tree_passes WHERE project_id = ? AND kind = ? ${finishedOnly ? 'AND finished_at IS NOT NULL' : ''}
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(projectId, kind) as PassRow | undefined;
    return r ? toPassView(r) : undefined;
  }

  recentPasses(projectId: string, limit: number): PassView[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM tree_passes WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?',
        )
        .all(projectId, limit) as PassRow[]
    ).map(toPassView);
  }

  clearListing(passId: string): void {
    this.db.prepare('DELETE FROM tree_listing WHERE pass_id = ?').run(passId);
  }

  /** Keeps the newest 200 passes per project, and tombstones only as long as a pass could need them. */
  prune(projectId: string): void {
    this.db
      .prepare(
        `DELETE FROM tree_passes WHERE project_id = ? AND finished_at IS NOT NULL AND id NOT IN (
           SELECT id FROM tree_passes WHERE project_id = ? ORDER BY started_at DESC LIMIT 200)`,
      )
      .run(projectId, projectId);
    this.db
      .prepare('DELETE FROM tree_tombstones WHERE project_id = ? AND observed_at < ?')
      .run(projectId, this.now() - TOMBSTONE_KEEP_MS);
    this.db
      .prepare(
        `DELETE FROM tree_log WHERE project_id = ? AND id NOT IN (
           SELECT id FROM tree_log WHERE project_id = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(projectId, projectId, LOG_KEEP);
  }

  // ============================================================================================== pending re-reads

  insertPending(p: {
    projectId: string;
    jobId: string | null;
    stepNo: number | null;
    op: string;
    resourceIds: readonly string[];
    flags: Record<string, unknown>;
  }): number {
    const at = this.now();
    return Number(
      this.db
        .prepare(
          `INSERT INTO tree_pending (project_id, job_id, step_no, op, resource_ids, flags, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'in_flight', ?, ?)`,
        )
        .run(p.projectId, p.jobId, p.stepNo, p.op, j(p.resourceIds), j(p.flags), at, at).lastInsertRowid,
    );
  }

  pendingForStep(projectId: string, jobId: string, stepNo: number): PendingRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM tree_pending WHERE project_id = ? AND job_id = ? AND step_no = ? ORDER BY id DESC LIMIT 1',
      )
      .get(projectId, jobId, stepNo) as PendingRow | undefined;
  }

  pending(projectId?: string): PendingRow[] {
    return (
      projectId === undefined
        ? this.db.prepare('SELECT * FROM tree_pending ORDER BY id').all()
        : this.db.prepare('SELECT * FROM tree_pending WHERE project_id = ? ORDER BY id').all(projectId)
    ) as PendingRow[];
  }

  pendingCount(projectId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM tree_pending WHERE project_id = ?').get(projectId) as {
        n: number;
      }
    ).n;
  }

  failedPendingCount(projectId: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM tree_pending WHERE project_id = ? AND status = 'retry'`)
        .get(projectId) as { n: number }
    ).n;
  }

  deletePending(id: number): void {
    this.db.prepare('DELETE FROM tree_pending WHERE id = ?').run(id);
  }

  /** A re-read failed: retried at `nextAt`; `attemptedAt` is the stamp taken when it was tried. */
  failPending(id: number, error: string, nextAt: number, attemptedAt: number): void {
    this.db
      .prepare(
        `UPDATE tree_pending SET status = 'retry', attempts = attempts + 1, last_error = ?, next_at = ?,
           attempted_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(error.slice(0, 1000), nextAt, attemptedAt, this.now(), id);
  }

  // ============================================================================================== correction log

  log(
    ctx: { projectId: string; log?: { source: 'sweep' | 'check'; passId: string } | undefined },
    nodeId: string,
    nodeName: string | null,
    change: CorrectionEntry['change'],
    field: string | null,
    before: unknown,
    after: unknown,
    detail: string | null,
  ): void {
    this.insertLog({
      projectId: ctx.projectId,
      source: ctx.log?.source ?? 'write',
      passId: ctx.log?.passId ?? null,
      nodeId,
      nodeName,
      change,
      field,
      oldValue: before,
      newValue: after,
      detail,
    });
  }

  insertLog(e: {
    projectId: string;
    source: CorrectionEntry['source'];
    passId: string | null;
    nodeId: string;
    nodeName: string | null;
    change: CorrectionEntry['change'];
    field: string | null;
    oldValue: unknown;
    newValue: unknown;
    detail: string | null;
  }): void {
    const cut = (v: unknown): string | null => {
      if (v === undefined) return null;
      const s = j(v);
      return s.length > LOG_VALUE_MAX ? j({ truncated: true, start: s.slice(0, LOG_VALUE_MAX) }) : s;
    };
    this.db
      .prepare(
        `INSERT INTO tree_log (project_id, at, source, pass_id, node_id, node_name, change, field, old_value, new_value,
           detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.projectId,
        this.now(),
        e.source,
        e.passId,
        e.nodeId,
        e.nodeName,
        e.change,
        e.field,
        e.change === 'updated' ? cut(e.oldValue) : null,
        e.change === 'updated' ? cut(e.newValue) : null,
        e.detail,
      );
  }

  listLog(
    projectId: string,
    o: {
      limit: number;
      before?: number | undefined;
      source?: CorrectionEntry['source'] | undefined;
      passId?: string | undefined;
    },
  ): CorrectionEntry[] {
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
      .prepare(`SELECT * FROM tree_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
      .all(...args) as {
      id: number;
      at: number;
      source: CorrectionEntry['source'];
      pass_id: string | null;
      node_id: string;
      node_name: string | null;
      change: CorrectionEntry['change'];
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
      nodeId: r.node_id,
      nodeName: r.node_name,
      change: r.change,
      field: r.field,
      oldValue: parse(r.old_value, null),
      newValue: parse(r.new_value, null),
      detail: r.detail,
    }));
  }
}

function toReadFilter(
  projectId: string,
  passId: string,
  kind: PassKind,
  T: number,
): { where: string; args: unknown[] } {
  const base = 'project_id = ? AND (props_pass IS NULL OR props_pass <> ?)';
  return kind === 'sweep'
    ? { where: `${base} AND (props_observed_at IS NULL OR stale = 1)`, args: [projectId, passId] }
    : {
        where: `${base} AND (props_observed_at IS NULL OR props_observed_at < ? OR stale = 1)`,
        args: [projectId, passId, T],
      };
}

function toPassView(r: PassRow): PassView {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    trigger: r.trigger,
    status: r.status,
    rootId: r.root_id,
    snapshotAt: r.snapshot_at,
    pages: r.pages,
    listed: r.listed,
    subtree: r.subtree,
    toRead: r.to_read,
    readOk: r.read_ok,
    readFailed: r.read_failed,
    requests: r.requests,
    added: r.added,
    removed: r.removed,
    corrected: r.corrected,
    estimate: parse<BuildEstimate | null>(r.estimate, null),
    summary: r.summary,
    error: r.error,
    jobId: r.job_id,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  };
}

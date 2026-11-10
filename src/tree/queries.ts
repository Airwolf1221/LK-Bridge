/**
 * The repository tree's query layer (v2 A2) for later sessions: A3 builds name resolution and ordering on it, B2 the
 * Discover tools. No LegendKeeper request is ever made here: everything is answered from the stored tree.
 *
 * Every answer is `{ tree, data }`: `tree` states the tree's status (`not_configured`, `not_built`, `building`,
 * `ready`, `stale`), why it is not ready, and when it was last confirmed, so a caller can decide whether to trust it.
 * Nothing is answered for a project whose tree is `not_configured`.
 *
 * Name lookups are EXACT (no fuzzy matching, PLAN-v2 4.4) and return EVERY match. By default they ignore case
 * (Unicode NFC, lower case); `caseSensitive: true` compares the stored text as it is.
 */
import { nameKey } from './classify.js';
import { TreeStore, type NodeRow } from './store.js';
import type {
  NameField,
  NameMatch,
  NodeKind,
  SidebarBlock,
  TreeAnswer,
  TreeDocument,
  TreeMeta,
  TreeNode,
} from './types.js';

export interface SubtreeEntry {
  readonly node: TreeNode;
  /** Depth below the subtree's top (0 for the top itself). */
  readonly relativeDepth: number;
}

export interface TreeCounts {
  readonly total: number;
  readonly byKind: Readonly<Record<NodeKind, number>>;
  /** Deepest node below the root (the root's children are at depth 1). */
  readonly maxDepth: number;
  readonly stale: number;
  /** Nodes whose properties have not been read yet. */
  readonly propertiesPending: number;
}

const ORDER = 'ORDER BY rank IS NULL, rank COLLATE BINARY, id';

/** Tree order by path: a node before its descendants, siblings by display name (then id). */
function byPath(a: TreeNode, b: TreeNode): number {
  const x = a.path.names;
  const y = b.path.names;
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return x.length - y.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export class TreeQueries {
  constructor(
    private readonly store: TreeStore,
    private readonly metaOf: (projectId: string) => TreeMeta,
  ) {}

  private get db() {
    return this.store.db;
  }

  private answer<T>(projectId: string, empty: T, fn: (meta: TreeMeta) => T): TreeAnswer<T> {
    const tree = this.metaOf(projectId);
    if (tree.status === 'not_configured') return { tree, data: empty };
    return { tree, data: fn(tree) };
  }

  private rows(sql: string, ...args: unknown[]): TreeNode[] {
    return (this.db.prepare(sql).all(...args) as NodeRow[]).map((r) => TreeStore.toView(r));
  }

  /**
   * v2 C2b: whether the tree held `id` until it was found gone (deleted), and when: restore_resource restores only pages
   * that were inside the AI REPOSITORY.
   */
  tombstone(projectId: string, id: string): { readonly observedAt: number; readonly reason: string } | null {
    const t = this.store.tombstone(projectId, id);
    return t ? { observedAt: t.observed_at, reason: t.reason } : null;
  }

  /** The tree's status alone. */
  status(projectId: string): TreeMeta {
    return this.metaOf(projectId);
  }

  /** One node, or null when the tree holds no such resource (outside the root, or unknown). */
  node(projectId: string, id: string): TreeAnswer<TreeNode | null> {
    return this.answer(projectId, null, () => {
      const r = this.store.node(projectId, id);
      return r ? TreeStore.toView(r) : null;
    });
  }

  /** The root node (the AI REPOSITORY page), or null before it is built. */
  root(projectId: string): TreeAnswer<TreeNode | null> {
    return this.answer(projectId, null, (m) => {
      const r = m.rootId ? this.store.node(projectId, m.rootId) : undefined;
      return r ? TreeStore.toView(r) : null;
    });
  }

  /** A node's children in LegendKeeper's sibling order (rank, then id). */
  children(projectId: string, id: string): TreeAnswer<TreeNode[]> {
    return this.answer(projectId, [], () =>
      this.rows(`SELECT * FROM tree_nodes WHERE project_id = ? AND parent_id = ? ${ORDER}`, projectId, id),
    );
  }

  /**
   * A node and its descendants, depth-first in sibling order, down to `maxDepth` levels below it (0: the node alone;
   * omitted: everything). `limit` caps the number of entries (default 5,000); `truncated` says when it was reached.
   */
  subtree(
    projectId: string,
    id: string,
    o: { maxDepth?: number; limit?: number } = {},
  ): TreeAnswer<{ entries: SubtreeEntry[]; truncated: boolean }> {
    return this.answer(projectId, { entries: [], truncated: false }, () => {
      const top = this.store.node(projectId, id);
      if (!top) return { entries: [], truncated: false };
      const limit = o.limit ?? 5000;
      const maxDepth = o.maxDepth ?? Number.POSITIVE_INFINITY;
      const all = this.db
        .prepare(
          `SELECT * FROM tree_nodes WHERE project_id = ? AND depth > ? AND depth <= ? AND path_ids LIKE ? ESCAPE '\\' ${ORDER}`,
        )
        .all(
          projectId,
          top.depth,
          Number.isFinite(maxDepth) ? top.depth + maxDepth : 1_000_000,
          `%${likeEscape(JSON.stringify(id))}%`,
        ) as NodeRow[];
      const children = new Map<string, NodeRow[]>();
      for (const r of all) {
        if (r.parent_id === null) continue;
        const l = children.get(r.parent_id) ?? [];
        l.push(r);
        children.set(r.parent_id, l);
      }
      const entries: SubtreeEntry[] = [];
      let truncated = false;
      const walk = (r: NodeRow, rel: number): void => {
        if (entries.length >= limit) {
          truncated = true;
          return;
        }
        entries.push({ node: TreeStore.toView(r), relativeDepth: rel });
        if (rel >= maxDepth) return;
        for (const c of children.get(r.id) ?? []) walk(c, rel + 1);
      };
      walk(top, 0);
      return { entries, truncated };
    });
  }

  /** The path from the root to a node (both included), with each node's id and names; empty when unknown. */
  path(
    projectId: string,
    id: string,
  ): TreeAnswer<{ id: string; rawName: string; displayName: string; kind: NodeKind }[]> {
    return this.answer(projectId, [], () => {
      const r = this.store.node(projectId, id);
      if (!r) return [];
      const ids = TreeStore.toView(r).path.ids;
      const get = this.db.prepare(
        'SELECT id, raw_name, display_name, kind FROM tree_nodes WHERE project_id = ? AND id = ?',
      );
      return ids.map((x) => {
        const n = get.get(projectId, x) as
          { id: string; raw_name: string; display_name: string; kind: NodeKind } | undefined;
        return n
          ? { id: n.id, rawName: n.raw_name, displayName: n.display_name, kind: n.kind }
          : { id: x, rawName: '', displayName: '', kind: 'unclassified' as const };
      });
    });
  }

  /** A node's documents (id, name, type), or null when the tree does not hold it. */
  documents(projectId: string, id: string): TreeAnswer<readonly TreeDocument[] | null> {
    return this.answer(projectId, null, () => {
      const r = this.store.node(projectId, id);
      return r ? TreeStore.toView(r).documents : null;
    });
  }

  /** Every node of a kind, in path order. */
  byKind(
    projectId: string,
    kind: NodeKind,
    o: { limit?: number; offset?: number } = {},
  ): TreeAnswer<TreeNode[]> {
    return this.answer(projectId, [], () => {
      const offset = o.offset ?? 0;
      return this.rows('SELECT * FROM tree_nodes WHERE project_id = ? AND kind = ?', projectId, kind)
        .sort(byPath)
        .slice(offset, offset + (o.limit ?? 10_000));
    });
  }

  /** Nodes under the root whose name has neither prefix (reported, PLAN-v2 section 1). */
  unclassified(projectId: string, o: { limit?: number; offset?: number } = {}): TreeAnswer<TreeNode[]> {
    return this.byKind(projectId, 'unclassified', o);
  }

  /** Stale nodes (a re-read failed, or their place is unknown). */
  stale(projectId: string, limit = 200): TreeAnswer<TreeNode[]> {
    return this.answer(projectId, [], () =>
      this.rows('SELECT * FROM tree_nodes WHERE project_id = ? AND stale = 1', projectId)
        .sort(byPath)
        .slice(0, limit),
    );
  }

  counts(projectId: string): TreeAnswer<TreeCounts> {
    const empty: TreeCounts = {
      total: 0,
      byKind: { root: 0, index: 0, bsrc: 0, bwrk: 0, barc: 0, unclassified: 0 },
      maxDepth: 0,
      stale: 0,
      propertiesPending: 0,
    };
    return this.answer(projectId, empty, () => {
      const byKind = { ...empty.byKind };
      for (const r of this.db
        .prepare('SELECT kind, COUNT(*) AS n FROM tree_nodes WHERE project_id = ? GROUP BY kind')
        .all(projectId) as { kind: NodeKind; n: number }[]) {
        byKind[r.kind] = r.n;
      }
      const agg = this.db
        .prepare(
          `SELECT COUNT(*) AS total, COALESCE(MAX(depth), 0) AS maxDepth, SUM(stale) AS stale,
             SUM(CASE WHEN props_observed_at IS NULL THEN 1 ELSE 0 END) AS pending
           FROM tree_nodes WHERE project_id = ?`,
        )
        .get(projectId) as { total: number; maxDepth: number; stale: number | null; pending: number | null };
      return {
        total: agg.total,
        byKind,
        maxDepth: agg.maxDepth,
        stale: agg.stale ?? 0,
        propertiesPending: agg.pending ?? 0,
      };
    });
  }

  /**
   * v2 A3: the stored sidebar summary of each node asked for (null when its properties have not been read), for rows
   * the catalogue fields do not carry (a page's Subject). Nodes the tree does not hold are left out.
   */
  sidebars(projectId: string, ids: readonly string[]): TreeAnswer<Map<string, SidebarBlock[] | null>> {
    return this.answer(projectId, new Map<string, SidebarBlock[] | null>(), () => {
      const out = new Map<string, SidebarBlock[] | null>();
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const rows = this.db
          .prepare(
            `SELECT id, sidebar FROM tree_nodes WHERE project_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`,
          )
          .all(projectId, ...chunk) as { id: string; sidebar: string | null }[];
        for (const r of rows) {
          let v: SidebarBlock[] | null = null;
          if (r.sidebar !== null) {
            try {
              v = JSON.parse(r.sidebar) as SidebarBlock[];
            } catch {
              v = null;
            }
          }
          out.set(r.id, v);
        }
      }
      return out;
    });
  }

  // ============================================================================================ exact names

  /**
   * Every node with a name exactly equal to `name` in any of `fields` (default: all four), each match with the field
   * and the stored name that matched. A node matching through several names appears once per name.
   */
  findByName(
    projectId: string,
    name: string,
    o: { fields?: readonly NameField[]; caseSensitive?: boolean } = {},
  ): TreeAnswer<NameMatch[]> {
    return this.answer(projectId, [], () => {
      const fields = o.fields ?? (['raw', 'display', 'alias', 'canonical'] as const);
      if (fields.length === 0) return [];
      const marks = fields.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT n.*, m.field AS m_field, m.name AS m_name FROM tree_names m
           JOIN tree_nodes n ON n.project_id = m.project_id AND n.id = m.node_id
           WHERE m.project_id = ? AND ${o.caseSensitive ? 'm.name = ?' : 'm.name_key = ?'} AND m.field IN (${marks})`,
        )
        .all(projectId, o.caseSensitive ? name : nameKey(name), ...fields) as (NodeRow & {
        m_field: NameField;
        m_name: string;
      })[];
      const FIELD_ORDER: Record<NameField, number> = { raw: 0, display: 1, alias: 2, canonical: 3 };
      return rows
        .map((r) => ({ node: TreeStore.toView(r), field: r.m_field, name: r.m_name }))
        .sort((a, b) => byPath(a.node, b.node) || FIELD_ORDER[a.field] - FIELD_ORDER[b.field]);
    });
  }

  /** Nodes whose raw name (with its prefix) is exactly `name`. */
  findByRawName(
    projectId: string,
    name: string,
    o: { caseSensitive?: boolean } = {},
  ): TreeAnswer<NameMatch[]> {
    return this.findByName(projectId, name, { ...o, fields: ['raw'] });
  }

  /** Nodes whose display name (prefix removed) is exactly `name`. */
  findByDisplayName(
    projectId: string,
    name: string,
    o: { caseSensitive?: boolean } = {},
  ): TreeAnswer<NameMatch[]> {
    return this.findByName(projectId, name, { ...o, fields: ['display'] });
  }

  /** Nodes with an alias exactly `name`. */
  findByAlias(projectId: string, name: string, o: { caseSensitive?: boolean } = {}): TreeAnswer<NameMatch[]> {
    return this.findByName(projectId, name, { ...o, fields: ['alias'] });
  }

  /** Nodes whose Canonical Display Name is exactly `name`. */
  findByCanonicalName(
    projectId: string,
    name: string,
    o: { caseSensitive?: boolean } = {},
  ): TreeAnswer<NameMatch[]> {
    return this.findByName(projectId, name, { ...o, fields: ['canonical'] });
  }
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

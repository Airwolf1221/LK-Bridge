/**
 * The registry's read-only window on one project's repository tree (A2's query layer). No LegendKeeper request is
 * ever made through it.
 */
import type {
  NameMatch,
  SubtreeEntry,
  TreeMeta,
  TreeNode,
  TreeQueries,
  TreeSettings,
} from '../tree/index.js';
import { key } from './names.js';
import { RegistryError, type NodeRef } from './types.js';

/** What the registry needs from the tree service. */
export interface RegistryTree {
  readonly queries: TreeQueries;
  settings(projectId: string): TreeSettings;
}

/** Tree statuses the registry answers from (`stale` is answered, and says so). */
const USABLE = new Set(['ready', 'stale']);

export class ProjectTree {
  private sidebarCache = new Map<
    string,
    readonly { kind: string; title: string | null; rows?: readonly { key: string; text: string }[] }[] | null
  >();

  constructor(
    private readonly tree: RegistryTree,
    readonly projectId: string,
  ) {}

  meta(): TreeMeta {
    return this.tree.queries.status(this.projectId);
  }

  /** The tree's status, or TREE_NOT_READY when it has not been built (not configured, not built, building). */
  requireUsable(): TreeMeta {
    const m = this.meta();
    if (!USABLE.has(m.status)) {
      throw new RegistryError(
        'TREE_NOT_READY',
        `The repository tree is ${m.status.replace('_', ' ')}: ${m.reason ?? 'it cannot answer yet.'}`,
        { treeStatus: m.status },
      );
    }
    return m;
  }

  node(id: string): TreeNode | null {
    return this.tree.queries.node(this.projectId, id).data;
  }

  root(): TreeNode | null {
    return this.tree.queries.root(this.projectId).data;
  }

  children(id: string): TreeNode[] {
    return this.tree.queries.children(this.projectId, id).data;
  }

  /** Everything under `id` (the node itself first), depth-first in sibling order. */
  subtree(id: string): SubtreeEntry[] {
    return this.tree.queries.subtree(this.projectId, id, { limit: 1_000_000 }).data.entries;
  }

  /** Exact matches (any case) on raw names, display names, aliases and Canonical Display Names. */
  findByName(name: string): NameMatch[] {
    return this.tree.queries.findByName(this.projectId, name).data;
  }

  findByRawName(raw: string): NameMatch[] {
    return this.tree.queries.findByRawName(this.projectId, raw).data;
  }

  /** Whether `id` is `ancestorId` or below it. */
  isUnder(node: TreeNode, ancestorId: string): boolean {
    return node.path.ids.includes(ancestorId);
  }

  ref(n: TreeNode): NodeRef {
    return {
      id: n.id,
      rawName: n.rawName,
      displayName: n.displayName,
      kind: n.kind,
      path: n.path.names.join(' / '),
    };
  }

  /** Loads the sidebars of these nodes in one query (for `rowValue`). */
  preload(ids: readonly string[]): void {
    const missing = ids.filter((id) => !this.sidebarCache.has(id));
    if (missing.length === 0) return;
    const got = this.tree.queries.sidebars(this.projectId, missing).data;
    for (const id of missing) this.sidebarCache.set(id, got.get(id) ?? null);
  }

  /**
   * The text of a row of the key-value property the tree reads its catalogue fields from (PROPERTIES), or null (no
   * such row, an empty value, or properties not read yet).
   */
  rowValue(id: string, rowKey: string): string | null {
    this.preload([id]);
    const sidebar = this.sidebarCache.get(id);
    if (!sidebar) return null;
    const props = key(this.tree.settings(this.projectId).propertiesName);
    const block = sidebar.find((b) => b.kind === 'keyValue' && b.title !== null && key(b.title) === props);
    const row = block?.rows?.find((r) => key(r.key) === key(rowKey));
    const v = row?.text.trim() ?? '';
    return v === '' ? null : v;
  }
}

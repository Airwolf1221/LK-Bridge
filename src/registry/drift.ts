/**
 * Taxonomy drift (v2 A3, PLAN-v2 4.3): where the taxonomy and the repository tree disagree. Made by the tree's daily
 * check (and on the owner's request), from the stored tree alone (no request). Reported, NEVER fixed automatically.
 */
import type { TreeNode } from '../tree/index.js';
import { classifyType } from './classify.js';
import type { RegistryStore } from './store.js';
import type { ProjectTree } from './tree-view.js';

export type DriftCode =
  | 'type_root_missing'
  | 'unmapped_index'
  | 'source_deleted'
  | 'source_renamed'
  | 'source_moved'
  | 'parent_mismatch';

export interface DriftFinding {
  readonly code: DriftCode;
  readonly typeId: string;
  readonly typeName: string;
  readonly entryId: string | null;
  readonly entryName: string | null;
  /** The tree node concerned (the index, or the type's root). */
  readonly nodeId: string;
  /** Its path in the tree now, or null when it is not in the tree. */
  readonly nodePath: string | null;
  readonly message: string;
}

export interface DriftReport {
  readonly id: number;
  readonly at: number;
  readonly source: 'check' | 'owner';
  readonly passId: string | null;
  readonly treeStatus: string;
  /** Why nothing was compared (the tree was not built), or null. */
  readonly note: string | null;
  readonly findings: readonly DriftFinding[];
  readonly count: number;
}

const path = (n: TreeNode) => n.path.names.join(' / ');

/** Every disagreement between each type's taxonomy and the tree. Types whose taxonomy is not seeded are checked only for their root. */
export function computeDrift(tree: ProjectTree, store: RegistryStore): DriftFinding[] {
  const out: DriftFinding[] = [];
  for (const type of store.listTypes()) {
    if (!type.rootIndexId) continue;
    const base = { typeId: type.id, typeName: type.singular };
    const root = tree.node(type.rootIndexId);
    if (!root) {
      out.push({
        ...base,
        code: 'type_root_missing',
        entryId: null,
        entryName: null,
        nodeId: type.rootIndexId,
        nodePath: null,
        message: `The type's root index ${type.rootIndexId} is not in the repository tree (deleted, or moved outside AI REPOSITORY).`,
      });
      continue;
    }
    if (type.taxonomySeededAt === null) continue;
    const entries = store.entries(type.id);
    const bySource = new Map(entries.map((e) => [e.sourceNodeId, e]));
    const byId = new Map(entries.map((e) => [e.id, e]));
    const c = classifyType(tree, type);
    for (const cat of c.categories) {
      if (bySource.has(cat.node.id)) continue;
      out.push({
        ...base,
        code: 'unmapped_index',
        entryId: null,
        entryName: null,
        nodeId: cat.node.id,
        nodePath: path(cat.node),
        message: `“${path(cat.node)}” has no taxonomy entry and is not a character index. “Add missing” would create one.`,
      });
    }
    for (const e of entries) {
      const ref = { ...base, entryId: e.id, entryName: e.plural, nodeId: e.sourceNodeId };
      const n = tree.node(e.sourceNodeId);
      if (!n) {
        out.push({
          ...ref,
          code: 'source_deleted',
          nodePath: null,
          message: `The index of “${e.plural}” (${e.sourceNodeId}) is no longer in the repository tree.`,
        });
        continue;
      }
      if (n.displayName !== e.plural) {
        out.push({
          ...ref,
          code: 'source_renamed',
          nodePath: path(n),
          message: `The index of “${e.plural}” is now named “${n.displayName}”.`,
        });
      }
      const inType = n.path.ids.includes(root.id) && n.id !== root.id;
      if (n.parentId !== e.sourceParentNodeId || !inType) {
        const was = e.sourceParentNodeId ? tree.node(e.sourceParentNodeId) : null;
        out.push({
          ...ref,
          code: 'source_moved',
          nodePath: path(n),
          message: inType
            ? `The index of “${e.plural}” moved from under ${was ? `“${was.displayName}”` : (e.sourceParentNodeId ?? 'nothing')} to under “${n.path.names.at(-2) ?? '?'}”.`
            : `The index of “${e.plural}” moved outside the type root ${root.displayName}.`,
        });
      }
      if (!inType) continue;
      // The parent the tree implies: the nearest ancestor (below the type root) that is an entry's index.
      let expected: string | null = null;
      for (let i = n.path.ids.length - 2; i >= 0; i--) {
        const id = n.path.ids[i]!;
        if (id === root.id) break;
        const p = bySource.get(id);
        if (p) {
          expected = p.id;
          break;
        }
      }
      if (expected !== e.parentId) {
        const name = (id: string | null) =>
          id === null ? 'none (directly under the type root)' : `“${byId.get(id)?.plural ?? id}”`;
        out.push({
          ...ref,
          code: 'parent_mismatch',
          nodePath: path(n),
          message: `“${e.plural}” has the parent ${name(e.parentId)} in the taxonomy, but the tree puts it under ${name(expected)}.`,
        });
      }
    }
  }
  return out;
}

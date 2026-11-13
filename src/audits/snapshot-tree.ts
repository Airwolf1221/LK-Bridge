/**
 * The repository tree as the newest snapshot shows it (v2 E2, ADR 0044): a read-only `RegistryTree` over an
 * `AuditModel`, so the registry's own functions (`classifyType`, `computeDrift`, `outOfOrder`) run on the snapshot's
 * pages, unchanged, and so agree with the dashboard's drift report in what they count. It answers from memory and makes
 * no request of any kind.
 *
 * Only what those functions use is implemented: `status`, `node`, `root`, `children`, `subtree`, `findByName`,
 * `findByRawName` and `sidebars`. Anything else throws, so a later use cannot silently get an empty answer.
 */
import { catalogueFrom, type TreeSettings } from '../tree/classify.js';
import type {
  NameField,
  NameMatch,
  SidebarBlock,
  TreeAnswer,
  TreeMeta,
  TreeNode,
  TreeQueries,
} from '../tree/index.js';
import type { RegistryTree } from '../registry/tree-view.js';
import { nameKey, type AuditPage } from './model.js';
import type { AuditModel } from './reader.js';

const byRank = (a: AuditPage, b: AuditPage): number => {
  const ra = a.rank;
  const rb = b.rank;
  if (ra !== rb) {
    if (ra === null) return 1;
    if (rb === null) return -1;
    return ra < rb ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** Pages in sibling order (rank, then id): LegendKeeper's own order. */
export function childrenByRank(model: AuditModel): Map<string, AuditPage[]> {
  const out = new Map<string, AuditPage[]>();
  for (const p of model.pages.values()) {
    if (p.parentId === null) continue;
    const l = out.get(p.parentId) ?? [];
    l.push(p);
    out.set(p.parentId, l);
  }
  for (const l of out.values()) l.sort(byRank);
  return out;
}

export function sidebarBlocks(p: AuditPage): SidebarBlock[] | null {
  if (p.properties === null) return null;
  return p.properties.map((x) => ({
    id: x.id,
    kind: x.kind,
    title: x.title,
    ...(x.rows ? { rows: x.rows.map((r) => ({ key: r.key, text: r.text })) } : {}),
  }));
}

export class SnapshotTree implements RegistryTree {
  readonly queries: TreeQueries;
  private readonly kids: Map<string, AuditPage[]>;
  private readonly nodes = new Map<string, TreeNode>();

  constructor(
    private readonly model: AuditModel,
    private readonly treeSettings: TreeSettings,
  ) {
    this.kids = childrenByRank(model);
    const meta = (): TreeMeta => ({
      projectId: model.projectId,
      status: 'ready',
      reason: null,
      rootId: model.rootId,
      confirmedAt: model.base.takenAt,
      confirmedBy: 'check',
      staleNodes: 0,
      pendingRereads: 0,
    });
    const answer = <T>(data: T): TreeAnswer<T> => ({ tree: meta(), data });
    const q = {
      status: () => meta(),
      node: (_p: string, id: string) => answer(this.node(id)),
      root: () => answer(model.rootId ? this.node(model.rootId) : null),
      children: (_p: string, id: string) =>
        answer((this.kids.get(id) ?? []).map((c) => this.node(c.id)!).filter(Boolean)),
      subtree: (_p: string, id: string, o: { maxDepth?: number; limit?: number } = {}) => {
        const entries: { node: TreeNode; relativeDepth: number }[] = [];
        const top = this.node(id);
        const walk = (n: TreeNode, rel: number) => {
          if (entries.length >= (o.limit ?? 5000)) return;
          entries.push({ node: n, relativeDepth: rel });
          if (rel >= (o.maxDepth ?? Number.POSITIVE_INFINITY)) return;
          for (const c of this.kids.get(n.id) ?? []) {
            const cn = this.node(c.id);
            if (cn) walk(cn, rel + 1);
          }
        };
        if (top) walk(top, 0);
        return answer({ entries, truncated: entries.length >= (o.limit ?? 5000) });
      },
      findByName: (_p: string, name: string, o: { fields?: readonly NameField[] } = {}) => {
        const key = nameKey(name);
        const fields = o.fields ?? (['raw', 'display', 'alias', 'canonical'] as const);
        const out: NameMatch[] = [];
        for (const p of model.pages.values()) {
          const n = this.node(p.id)!;
          if (fields.includes('raw') && nameKey(p.rawName) === key)
            out.push({ node: n, field: 'raw', name: p.rawName });
          if (fields.includes('display') && nameKey(p.displayName) === key)
            out.push({ node: n, field: 'display', name: p.displayName });
          if (fields.includes('alias'))
            for (const a of p.aliases) if (nameKey(a) === key) out.push({ node: n, field: 'alias', name: a });
          if (
            fields.includes('canonical') &&
            n.canonicalDisplayName !== null &&
            nameKey(n.canonicalDisplayName) === key
          )
            out.push({ node: n, field: 'canonical', name: n.canonicalDisplayName });
        }
        return answer(out);
      },
      findByRawName: (_p: string, name: string) => q.findByName(_p, name, { fields: ['raw'] }),
      sidebars: (_p: string, ids: readonly string[]) => {
        const m = new Map<string, SidebarBlock[] | null>();
        for (const id of ids) {
          const p = model.pages.get(id);
          if (p) m.set(id, sidebarBlocks(p));
        }
        return answer(m);
      },
    };
    this.queries = new Proxy(q, {
      get(target, prop) {
        if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
        throw new Error(`the snapshot tree does not implement ${String(prop)}`);
      },
    }) as unknown as TreeQueries;
  }

  settings(): TreeSettings {
    return this.treeSettings;
  }

  /** One page as a tree node (its path as far as the snapshot's pages reach), or null. */
  node(id: string): TreeNode | null {
    const hit = this.nodes.get(id);
    if (hit) return hit;
    const p = this.model.pages.get(id);
    if (!p) return null;
    const ids: string[] = [];
    const names: string[] = [];
    const seen = new Set<string>();
    for (
      let cur: AuditPage | undefined = p;
      cur && !seen.has(cur.id);
      cur = cur.parentId ? this.model.pages.get(cur.parentId) : undefined
    ) {
      seen.add(cur.id);
      ids.unshift(cur.id);
      names.unshift(cur.displayName);
    }
    const blocks = sidebarBlocks(p);
    const cat = catalogueFrom(blocks ?? [], this.treeSettings);
    const node: TreeNode = {
      id: p.id,
      rawName: p.rawName,
      displayName: p.displayName,
      kind: p.kind,
      parentId: p.parentId,
      rank: p.rank,
      depth: ids.length - 1,
      path: { ids, names },
      tags: p.tags,
      aliases: p.aliases,
      documents: p.documents.map((d) => ({ id: d.id, name: d.name, type: d.type })),
      isHidden: false,
      isLocked: null,
      referenceType: cat.referenceType,
      scope: cat.scope,
      indexScope: cat.indexScope,
      canonicalDisplayName: cat.canonicalDisplayName,
      propertiesFound: blocks === null ? null : cat.propertiesFound,
      templateId: null,
      lastReadAt: p.sourceTakenAt,
      lastReadBy: 'check',
      propertiesPending: blocks === null,
      stale: false,
      staleReason: null,
    };
    this.nodes.set(id, node);
    return node;
  }
}

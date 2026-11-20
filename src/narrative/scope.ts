/**
 * v3 F4c (ADR 0065; design E2): which pages are narrative pages, for every part of the bridge that treats them apart
 * (the appraisal, the completion gate, the split triggers, the retag audit, the lifecycle tools, the facts index, the
 * briefs, the audits). The rules are the APPROVED pack version's (as every report-only reading of a pack is, R2-32); a
 * project with no attached pack carrying narrative rules, or no single Narratives index, has no narrative pages.
 */
import type { Pack, PackRules, NarrativeRules } from '../packs/types.js';
import { reportRulesOf } from '../packs/governance-audit.js';
import type { SidebarBlock, TreeNode, TreeQueries } from '../tree/index.js';
import { nkey, rootsOf, type NNode, type NView, type Roots } from './layout.js';

/** What the scope needs of the packs. */
export interface PacksLike {
  forProject(projectId: string): Pack[];
  readonly store: { rulesAt(packId: string, version: number): PackRules | null };
}

/** The narrative rules of a project: the first attached pack (by id) whose approved rules carry them, or null. */
export function narrativeRulesOf(
  packs: PacksLike | undefined | null,
  projectId: string,
): NarrativeRules | null {
  if (!packs) return null;
  for (const pack of [...packs.forProject(projectId)].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const r = reportRulesOf(pack, (id, v) => packs.store.rulesAt(id, v));
    if (r.narrative) return r.narrative;
  }
  return null;
}

/** The repository tree as the narrative layout reads it. */
export function treeView(
  queries: Pick<TreeQueries, 'node' | 'children' | 'findByName' | 'sidebars'>,
  projectId: string,
  propertiesName = 'PROPERTIES',
): NView & { treeNode(id: string): TreeNode | null } {
  const sidebars = new Map<string, readonly SidebarBlock[] | null>();
  const sidebar = (id: string) => {
    if (!sidebars.has(id)) sidebars.set(id, queries.sidebars(projectId, [id]).data.get(id) ?? null);
    return sidebars.get(id) ?? null;
  };
  return {
    node: (id) => queries.node(projectId, id).data,
    treeNode: (id) => queries.node(projectId, id).data,
    children: (id) => queries.children(projectId, id).data,
    indexesNamed: (name) =>
      queries
        .findByName(projectId, name, { fields: ['display'] })
        .data.map((m) => m.node)
        .filter((n, i, all) => n.kind === 'index' && all.findIndex((x) => x.id === n.id) === i),
    fact: (id, key) => {
      const sb = sidebar(id);
      const block = sb?.find(
        (b) => b.kind === 'keyValue' && b.title !== null && nkey(b.title) === nkey(propertiesName),
      );
      const row = block?.rows?.find((r) => nkey(r.key) === nkey(key));
      const v = row?.text.trim() ?? '';
      return v === '' ? null : v;
    },
  };
}

export interface NarrativeScope {
  readonly rules: NarrativeRules;
  readonly roots: Roots;
}

/** The scope of a project from its tree (null: no narrative rules, or no single Narratives index). */
export function narrativeScope(
  packs: PacksLike | undefined | null,
  queries: Pick<TreeQueries, 'node' | 'children' | 'findByName' | 'sidebars'> | undefined | null,
  projectId: string,
): NarrativeScope | null {
  const rules = narrativeRulesOf(packs, projectId);
  if (!rules || !queries) return null;
  try {
    const roots = rootsOf(treeView(queries, projectId), rules);
    return roots.narratives ? { rules, roots } : null;
  } catch {
    return null;
  }
}

/** Whether a tree node (with its path) is under Narratives (Narratives itself is not). */
export function inNarratives(
  scope: NarrativeScope | null,
  node: Pick<TreeNode, 'id' | 'path'> | null | undefined,
): boolean {
  const root = scope?.roots.narratives;
  if (!root || !node) return false;
  return node.id !== root.id && node.path.ids.includes(root.id);
}

/** The same, by ancestry over any view (the snapshots' model has no stored paths). */
export function underNarratives(view: Pick<NView, 'node'>, narrativesId: string, id: string): boolean {
  let cur: NNode | null = view.node(id);
  if (!cur || cur.id === narrativesId) return false;
  for (let i = 0; cur && i < 200; i++) {
    if (cur.parentId === narrativesId) return true;
    cur = cur.parentId ? view.node(cur.parentId) : null;
  }
  return false;
}

export const NARRATIVE_NO_LIFECYCLE = 'NARRATIVE_NO_LIFECYCLE';
export const NARRATIVE_NO_LIFECYCLE_MESSAGE =
  'Narrative pages have no lifecycle (the F4c design, E2): a page under Narratives is never promoted, archived or moved to Working. Nothing was written or proposed. Narrative pages are organised with the narrative tools (arkona_story_create, arkona_chapter_save…); lore a story invents reaches canon only through arkona_promote_from_chapter, as a proposal.';

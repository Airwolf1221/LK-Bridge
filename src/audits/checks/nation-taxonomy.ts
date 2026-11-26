/**
 * v3 F6c (ADR 0080; design T3 to T5, C4): territories, nations and their subindexes, category `taxonomy`, from the
 * snapshots, free. Each check is switched on or off per project (the Projects page; default on).
 *
 * - `nation_subindex_nonstandard` (warning): a nation subindex the owner ACCEPTED or MAPPED on the Nation Subindexes
 *   page whose name differs from the unified name `<Nation> <Role>` (the short name first). Undecided rows are not
 *   reported: they wait on the report page. Two subindexes of one nation with one role (a collision) are never renamed.
 *   The fix renames the display name only: the prefix ([NAV]), the id and every link stay.
 * - `territory_category_missing` (warning): a Territory entry with one of the governance's REQUIRED categories (the
 *   pack's `requiredTerritoryCategories`; Religions is recognised but never required) unbound and no index of the
 *   expected name `<Territory> <Category>` (Conflicts inside the bound Historical Events). The fix makes the empty
 *   [NAV] index through create_index's role form, as a proposal, and binds the role when the job succeeds. Lost
 *   Realmships and Divine Realms are never Territory entries, so never checked.
 * - `category_home_mismatch` (info, judgement): a source whose primary category tag is not allowed in its current home
 *   by the pack's owner homes, resolved by role (src/packs/engine/homes.ts, C5). The fix is a move proposal to the
 *   nearest allowed home; never automatic. The owner's "keep it here" silences it until the page's tags or parent change.
 *
 * None of the three looks under Working, Archive, the Legacy Canon Archive, the Design References or Narratives.
 */
import { labelContext, labelsOf } from '../../appraisal/scope.js';
import { indexRoleOfName, ROLE_PREFIX } from '../../tree/classify.js';
import type { TreeNode } from '../../tree/index.js';
import {
  describeHome,
  homeMatchAmong,
  homeTreeOf,
  suggestHomes,
  type HomeTree,
} from '../../packs/engine/homes.js';
import {
  categoryParentOf,
  requiredTerritoryCategoriesOf,
  roleKey,
  territoryCategoriesOf,
  unifiedName,
} from '../../packs/nations/roles.js';
import { homeStateHash } from '../../packs/nations/store.js';
import type { NationAuditInput } from '../../packs/nations/service.js';
import { categoryFromTags, vocabularyOf } from '../../packs/retag/engine.js';
import type { HomeRule } from '../../packs/types.js';
import { isNarrativePage, type AuditContext } from '../context.js';
import { nameKey, type AuditPage } from '../model.js';
import type { FindingDraft } from '../types.js';

/** The Nation Subindexes page's row for a child (the dashboard route). */
export const subindexRowLink = (pageId: string): string =>
  `/ui/nation-subindexes?page=${encodeURIComponent(pageId)}`;

/** Whether a page is in the checks' scope: no non-current area, not Working or Archived, not in Narratives. */
export function inTerritoryScope(ctx: AuditContext, id: string): boolean {
  if (isNarrativePage(ctx, id)) return false;
  const n = ctx.snapshotTree.node(id);
  if (!n) return false;
  const kinds = n.path.ids.map((x) => ctx.model.pages.get(x)?.kind ?? '');
  const l = labelsOf(
    { ids: n.path.ids, names: n.path.names, kinds },
    labelContext(ctx.model.rootId, ctx.lifecycle),
  );
  if (l.area !== null || l.lifecycle === 'Working' || l.lifecycle === 'Archived') return false;
  const w = ctx.lifecycle.workingIndexId;
  const a = ctx.lifecycle.archiveIndexId;
  const names = new Set([
    nameKey(ctx.lifecycle.indexNames.working),
    nameKey(ctx.lifecycle.indexNames.archived),
  ]);
  return !n.path.ids.some(
    (x, i) =>
      x === w ||
      x === a ||
      (i < n.path.ids.length - 1 && kinds[i] === 'index' && names.has(nameKey(n.path.names[i] ?? ''))),
  );
}

/** The snapshots as the home rules read them. */
export function snapshotHomeTree(ctx: AuditContext, input: NationAuditInput): HomeTree | null {
  const owners = input.rules.owners;
  if (!owners) return null;
  const st = ctx.snapshotTree;
  let indexes: TreeNode[] | null = null;
  return homeTreeOf(
    {
      node: (id) => st.node(id),
      children: (id) => st.queries.children(ctx.projectId, id).data,
      indexes: () =>
        (indexes ??= [...ctx.model.pages.values()]
          .filter((p) => p.kind === 'index')
          .map((p) => st.node(p.id)!)
          .filter(Boolean)),
      byDisplayName: (name) =>
        [...ctx.model.pages.values()]
          .filter((p) => nameKey(p.displayName) === nameKey(name))
          .map((p) => st.node(p.id)!)
          .filter(Boolean),
    },
    owners,
    input.roles,
  );
}

export function nationTaxonomyCheck(ctx: AuditContext): FindingDraft[] {
  const input = ctx.nationTaxonomy;
  if (!input) return [];
  return [
    ...(input.checks.nonstandard ? subindexNames(ctx, input) : []),
    ...(input.checks.categoryMissing ? territoryCategories(ctx, input) : []),
    ...(input.checks.categoryHome ? categoryHomes(ctx, input) : []),
  ];
}

// ============================================================================================ nation_subindex_nonstandard

function subindexNames(ctx: AuditContext, input: NationAuditInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  // A collision (two children of one nation with one role): neither is renamed.
  const groups = new Map<string, number>();
  for (const d of input.decisions) {
    const k = `${d.nationId}\u0000${roleKey(d.role!)}`;
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  for (const d of input.decisions) {
    const page = ctx.model.pages.get(d.pageId);
    if (!page || page.kind !== 'index' || page.parentId !== d.nationId) continue;
    if ((groups.get(`${d.nationId}\u0000${roleKey(d.role!)}`) ?? 0) > 1) continue;
    const nation = ctx.model.pages.get(d.nationId);
    if (!nation || !inTerritoryScope(ctx, page.id)) continue;
    const proposed = unifiedName(
      { displayName: nation.displayName, shortName: input.shortNames.get(nation.id) ?? null },
      d.role!,
    );
    if (page.displayName === proposed) continue;
    // Another child of the nation already holds the name: a collision the report shows; never renamed into it.
    if (
      childrenOf(ctx, nation.id).some((x) => x.id !== page.id && nameKey(x.displayName) === nameKey(proposed))
    )
      continue;
    const prefix = ROLE_PREFIX[indexRoleOfName(page.rawName) ?? 'subject'];
    const to = `${prefix}${proposed}`;
    out.push({
      code: 'nation_subindex_nonstandard',
      pageId: page.id,
      message: `“${page.rawName}” is ${nation.displayName}’s ${d.role} subindex (${d.action === 'accept' ? 'accepted' : 'mapped'} on the Nation Subindexes page): its name becomes “${to}”. The fix renames the display name only; the prefix, the id and every link stay.`,
      evidence: {
        nation: { id: nation.id, name: nation.rawName },
        role: d.role,
        decision: d.id,
        from: page.rawName,
        to,
        row: subindexRowLink(page.id),
      },
      fix: {
        kind: 'nation_subindex_name',
        args: {
          pageId: page.id,
          name: page.rawName,
          to,
          role: d.role,
          decisionId: d.id,
          nationId: nation.id,
        },
        summary: `Rename ${page.rawName} → ${to} (${nation.displayName}’s ${d.role}).`,
      },
    });
  }
  return out;
}

// ============================================================================================ territory_category_missing

function territoryCategories(ctx: AuditContext, input: NationAuditInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  const lost = new Set((input.tax.lostRealmshipParents ?? []).map(nameKey));
  // The governance's REQUIRED categories only (Religions is recognised, never required); a nested one's parent is looked
  // up among the recognised categories.
  const required = requiredTerritoryCategoriesOf(input.tax);
  const cats = territoryCategoriesOf(input.tax);
  for (const t of input.territories) {
    const node = ctx.model.pages.get(t.nodeId);
    if (!node || node.kind !== 'index' || !inTerritoryScope(ctx, node.id)) continue;
    const parent = node.parentId ? ctx.model.pages.get(node.parentId) : undefined;
    if (parent && lost.has(nameKey(parent.displayName))) continue;
    for (const c of required) {
      if (t.bindings.has(c)) continue;
      const parentCat = categoryParentOf(input.tax, c);
      const parentCatName = parentCat
        ? (cats.find((x) => roleKey(x) === roleKey(parentCat)) ?? parentCat)
        : null;
      // Conflicts is checked inside the bound Historical Events (and not at all while that is unbound).
      const containerId = parentCatName ? t.bindings.get(parentCatName) : node.id;
      if (!containerId) continue;
      const container = ctx.model.pages.get(containerId);
      if (!container) continue;
      const name = `${node.displayName} ${c}`;
      const there = childrenOf(ctx, containerId).some(
        (x) => x.kind === 'index' && nameKey(x.displayName) === nameKey(name),
      );
      if (there) continue;
      out.push({
        code: 'territory_category_missing',
        pageId: node.id,
        key: c,
        message: `${node.displayName} has no ${c} index: no ${c} role is bound and no index “${name}” is ${parentCatName ? `in ${container.rawName}` : 'directly under it'}. The fix makes the empty “[NAV] ${name}” there from the “[NAV] AI Navigation” template (create_index’s role form) as a proposal, and binds the role once the job succeeds.`,
        evidence: {
          territory: { id: node.id, name: node.rawName, entryId: t.entryId },
          category: c,
          in: { id: container.id, name: container.rawName },
          expected: `[NAV] ${name}`,
        },
        fix: {
          kind: 'territory_category',
          args: {
            territoryId: node.id,
            territory: node.displayName,
            category: c,
            parentId: container.id,
            name,
          },
          summary: `Create [NAV] ${name} in ${container.rawName}, and bind it as ${node.displayName}’s ${c}.`,
        },
      });
    }
  }
  return out;
}

function childrenOf(ctx: AuditContext, id: string): AuditPage[] {
  const out: AuditPage[] = [];
  for (const n of ctx.snapshotTree.queries.children(ctx.projectId, id).data) {
    const p = ctx.model.pages.get(n.id);
    if (p) out.push(p);
  }
  return out;
}

// ============================================================================================ category_home_mismatch

function categoryHomes(ctx: AuditContext, input: NationAuditInput): FindingDraft[] {
  const owners = input.rules.owners;
  const ht = snapshotHomeTree(ctx, input);
  if (!owners || !ht) return [];
  const vocab = vocabularyOf(input.rules);
  const byPrimary = new Map(owners.types.map((t) => [nameKey(t.primary), t]));
  const charRoots = ctx.types
    .filter((t) => t.placementKind === 'character' && t.rootIndexId)
    .map((t) => t.rootIndexId!);
  const out: FindingDraft[] = [];
  // Many sources share a home and a type: the match and the suggestions are worked out once per pair (the 10% rule).
  const matched = new Map<string, boolean>();
  const suggested = new Map<string, ReturnType<typeof suggestHomes>>();
  const allowedOf = new Map<string, string[]>();
  // The same tags read the same category: read once per distinct tag list.
  const cats = new Map<string, ReturnType<typeof categoryFromTags>>();
  for (const p of ctx.model.pages.values()) {
    if (p.kind !== 'bsrc' || !p.parentId) continue;
    const tagKey = p.tags.join('\u0000');
    let cat = cats.get(tagKey);
    if (!cat) cats.set(tagKey, (cat = categoryFromTags(p.tags, vocab)));
    if (!('primary' in cat)) continue;
    const type = byPrimary.get(nameKey(cat.primary));
    if (!type) continue;
    const node = ctx.snapshotTree.node(p.id);
    if (!node || charRoots.some((r) => node.path.ids.includes(r))) continue;
    const rules: HomeRule[] = [...type.homes, ...Object.values(type.kinds ?? {}).flatMap((k) => k.homes)];
    const parent = ctx.snapshotTree.node(p.parentId);
    if (!parent) continue;
    if (parent.kind !== 'index' && !rules.some((r) => r.kind === 'races')) continue;
    const pair = `${parent.id}\u0000${type.name}`;
    let fits = matched.get(pair);
    if (fits === undefined) matched.set(pair, (fits = homeMatchAmong(ht, parent, rules) !== null));
    if (fits) continue;
    if (!inTerritoryScope(ctx, p.id)) continue;
    if (input.homeRulings.get(p.id) === homeStateHash(p.tags, p.parentId)) continue;
    let allowed = allowedOf.get(type.name);
    if (!allowed) allowedOf.set(type.name, (allowed = [...new Set(rules.map((r) => describeHome(ht, r)))]));
    let suggestions = suggested.get(pair);
    if (!suggestions)
      suggested.set(
        pair,
        (suggestions = suggestHomes(ht, rules, parent, 3).filter((s) => s.id !== parent.id)),
      );
    const to = suggestions[0];
    out.push({
      code: 'category_home_mismatch',
      pageId: p.id,
      message: `${p.rawName} is tagged ${cat.primary}, which does not live in ${parent.rawName} (allowed: ${allowed.join('; ')}). ${to ? `The fix proposes moving it to the nearest allowed home, ${to.name} (${to.fits}); its id, tags and links stay.` : 'No allowed home was found to propose.'} If it belongs where it is, “Keep it here” silences this until its tags or its parent change.`,
      evidence: {
        category: cat.primary,
        tags: [...p.tags],
        home: { id: parent.id, name: parent.rawName, path: parent.path.names.join(' / ') },
        allowed,
        suggestions,
      },
      ...(to
        ? {
            fix: {
              kind: 'category_home' as const,
              args: {
                pageId: p.id,
                name: p.rawName,
                parentId: p.parentId,
                tags: [...p.tags],
                to: to.id,
                toName: to.name,
                fits: to.fits,
              },
              summary: `Move ${p.rawName} to ${to.name} (${to.fits}).`,
            },
          }
        : {}),
    });
  }
  return out;
}

/**
 * v3 F4a (ADR 0063): `arkona_name_check`, a free read (the repository tree, its stored sidebars and the snapshots).
 *
 * 1. **Namesakes** (src/packs/naming/namesakes.ts): the current characters sharing the full name, the given name, the
 *    surname or an alias, each with the page holding its identity, its Naming Culture and Life State, its labels
 *    (Authoritative, Working, AU) and what matched. `exclude` leaves characters out (the character being renamed).
 * 2. **The naming culture**, when `namingCulture` is given: resolved through the pack's culture map (F3a's token maps)
 *    to its culture owner under the pack's cultures index (Arkonan Cultures), by name or alias; the owner's naming
 *    sections (headings matching "name" or "naming", and any the pack lists), from the snapshots, cut with a result
 *    handle when long; and the current characters recorded with that Naming Culture, with their names. A value the map
 *    does not hold is reported as unmapped, and no owner is looked for.
 * 3. **Name order**: names are matched in both orders; the answer points to the presentation standard's tab
 *    (East Asian Personal Name Presentation Standard) on the governance root, read from the snapshots.
 *
 * It never suggests or infers a naming culture, race or nationality from a name, a surname or its etymology, and never
 * proposes a rename (Character Architecture): it reports, and the agent asks the owner.
 */
import { lifecycleFrom } from '../../lifecycle/settings.js';
import type { McpToolContext, McpToolResult } from '../../mcp/server.js';
import { finish, repoContext, treeInfo, type RepoCtx } from '../../mcp/tools/repo.js';
import { errorResult, type ProjectDeps } from '../../mcp/tools/shape.js';
import { cleanPrefixes } from '../../registry/names.js';
import type { TreeNode } from '../../tree/index.js';
import { findCharacters } from '../engine/plan.js';
import { textKey } from '../engine/text.js';
import { cutText, packForRead, sectionMarkdown, sectionsWhere } from '../read-support.js';
import type { Pack, PackRules } from '../types.js';
import {
  currentCharacters,
  nameKeyOf,
  namesakesOf,
  namesakeView,
  subjectPart,
  treeLabeller,
  usableName,
  type CharacterRecord,
  type CharacterScan,
} from './namesakes.js';

type Obj = Record<string, unknown>;

/** What every answer says (Character Architecture: the naming-culture review is the owner's). */
export const NEVER_INFER =
  'Report only: the bridge never suggests or infers a naming culture, race or nationality from a name, a surname or its etymology, and never proposes a rename. Bring the namesakes to the owner and ask; record only what the owner decides.';

export interface NameCheckInput {
  readonly name?: string | undefined;
  readonly givenName?: string | undefined;
  readonly surname?: string | undefined;
  readonly aliases?: readonly string[] | undefined;
  readonly namingCulture?: string | undefined;
  readonly exclude?: readonly string[] | undefined;
}

/** The identity pages a list of names or ids names (each a character's), and what named none. */
export function excludedIdentities(
  ctx: RepoCtx,
  refs: readonly string[],
): { ids: Set<string>; unknown: string[] } {
  const ids = new Set<string>();
  const unknown: string[] = [];
  for (const raw of refs) {
    const q = raw.trim();
    if (q === '') continue;
    const direct = ctx.tree.node(ctx.projectId, q).data;
    if (direct) {
      const c = ctx.types.characterOfPage(direct.id);
      if (c.ok) {
        ids.add(c.value.core.id);
        continue;
      }
    }
    const found = findCharacters(ctx, cleanPrefixes(q).name || q);
    if (found.subjects.length === 0) unknown.push(q);
    for (const s of found.subjects) ids.add(s.identity.id);
  }
  return { ids, unknown };
}

/** The culture map's token for a Naming Culture value (null: not in the map). */
export function cultureToken(rules: PackRules, value: string): string | null {
  const hit = Object.entries(rules.tags.culture).find(([k]) => textKey(k) === textKey(value));
  return hit ? hit[1] : null;
}

/** The governance root's tab of a name in this project (the pack's governance sources' pages), or null. */
function governanceTab(
  ctx: RepoCtx,
  pack: Pack,
  projectName: string,
  tabName: string,
): { page: TreeNode; document: { id: string; name: string | null } } | null {
  const roots = [
    ...new Set(
      pack.governance.filter((g) => textKey(g.project) === textKey(projectName)).map((g) => g.resourceId),
    ),
  ];
  for (const id of roots) {
    const page = ctx.tree.node(ctx.projectId, id).data;
    const d = page?.documents.find((x) => textKey(x.name ?? '') === textKey(tabName));
    if (page && d) return { page, document: { id: d.id, name: d.name } };
  }
  return null;
}

/** The culture owners a Naming Culture resolves to: pages under the cultures index named (or aliased) by it. */
function cultureOwners(
  ctx: RepoCtx,
  indexName: string,
  names: readonly string[],
): { index: TreeNode | null; owners: TreeNode[] } {
  const want = new Set(names.map(nameKeyOf).filter((k) => k !== ''));
  const index =
    ctx.tree
      .byKind(ctx.projectId, 'index')
      .data.find((n) => nameKeyOf(n.displayName) === nameKeyOf(indexName)) ?? null;
  if (!index) return { index: null, owners: [] };
  const entries = ctx.tree.subtree(ctx.projectId, index.id, { limit: 5000 }).data.entries.map((e) => e.node);
  const named = (n: TreeNode) =>
    want.has(nameKeyOf(subjectPart(n.displayName))) ||
    want.has(nameKeyOf(n.displayName)) ||
    n.aliases.some((a) => want.has(nameKeyOf(a)));
  const pages = entries.filter((n) => (n.kind === 'bsrc' || n.kind === 'bwrk') && named(n));
  if (pages.length > 0) return { index, owners: pages };
  // A culture with its own index: its pages are its owners.
  const own = entries.find((n) => n.kind === 'index' && n.id !== index.id && named(n));
  if (!own) return { index, owners: [] };
  return {
    index,
    owners: ctx.tree
      .children(ctx.projectId, own.id)
      .data.filter((n) => n.kind === 'bsrc' || n.kind === 'bwrk'),
  };
}

export async function nameCheck(
  pd: ProjectDeps,
  mctx: McpToolContext,
  o: {
    readonly packId: string;
    readonly tool: string;
    readonly input: NameCheckInput;
    readonly full: boolean;
  },
): Promise<McpToolResult> {
  const p = packForRead(pd, o.packId);
  if (!p.ok) return p.result;
  const { pack, rules } = p;
  const q = o.input;
  if (
    ![q.name, q.givenName, q.surname, q.namingCulture].some((v) => v && v.trim() !== '') &&
    !(q.aliases ?? []).length
  )
    return errorResult(
      {
        code: 'INVALID_INPUT',
        message: 'Give a name, a given name, a surname, an alias or a naming culture to check.',
      },
      pd,
    );
  const rc = repoContext(pd);
  if (!rc.ok) return rc.result;
  const ctx = rc.ctx;
  const lifecycle = lifecycleFrom(pd.services?.projectSettings?.(ctx.projectId) ?? {});
  const scan = currentCharacters({ ctx, rules, lifecycle });
  const usable = usableName(rules);
  const excluded = excludedIdentities(ctx, q.exclude ?? []);
  const name = q.name ? cleanPrefixes(q.name).name.trim() : undefined;
  const query = {
    ...(name ? { name: subjectPart(name) } : {}),
    ...(q.givenName ? { givenName: q.givenName } : {}),
    ...(q.surname ? { surname: q.surname } : {}),
    ...(q.aliases ? { aliases: q.aliases } : {}),
  };
  const asksName = Object.keys(query).length > 0;
  const found = asksName ? namesakesOf(scan, query, usable, excluded.ids) : [];
  const cap = o.full ? 200 : 25;
  const notes: string[] = [];
  if (excluded.unknown.length > 0)
    notes.push(`exclude: no character is named ${excluded.unknown.map((x) => `“${x}”`).join(', ')}.`);
  if (scan.unread > 0)
    notes.push(
      `${scan.unread} current character page${scan.unread === 1 ? '' : 's'} whose facts the tree has not read yet ${scan.unread === 1 ? 'was' : 'were'} matched by name and alias only.`,
    );

  const culture = q.namingCulture?.trim()
    ? await cultureReport(pd, mctx, o.tool, ctx, rules, scan, q.namingCulture.trim(), o.full)
    : null;

  // The presentation standard: how a name is presented (its order) is the standard's; matching tries both orders.
  const standard = rules.naming?.presentationStandard ?? null;
  const tab = standard ? governanceTab(ctx, pack, pd.project.name, standard) : null;
  const presentation = standard
    ? {
        standard,
        ...(tab
          ? {
              tab: { page: { id: tab.page.id, name: tab.page.rawName }, document: tab.document },
              read: 'read_document with the page and this document for how a personal name is presented',
            }
          : { tab: null }),
        note: 'Names are matched in both orders (family name first, or given name first), so a namesake is found whichever order its name is written in. How a name is presented is the standard’s: the bridge never decides it.',
      }
    : null;

  const body: Obj = {
    query: {
      ...(name ? { name } : {}),
      ...(q.givenName ? { givenName: q.givenName } : {}),
      ...(q.surname ? { surname: q.surname } : {}),
      ...(q.aliases?.length ? { aliases: q.aliases } : {}),
      ...(q.namingCulture ? { namingCulture: q.namingCulture } : {}),
      ...(excluded.ids.size > 0 ? { excluded: [...excluded.ids] } : {}),
    },
    ...(asksName
      ? {
          namesakes: found.slice(0, cap).map(namesakeView),
          counts: {
            warning: found.filter((n) => n.severity === 'warning').length,
            info: found.filter((n) => n.severity === 'info').length,
            total: found.length,
            ...(found.length > cap ? { shown: cap, more: 'detail "full" lists up to 200' } : {}),
          },
        }
      : {}),
    ...(culture ? { namingCulture: culture } : {}),
    ...(presentation ? { presentation } : {}),
    inspected: {
      characters: scan.characters.length,
      leftOut: {
        archived: scan.leftOut.archived,
        ...(Object.keys(scan.leftOut.areas).length > 0 ? { nonCurrentAreas: scan.leftOut.areas } : {}),
      },
    },
    ...(notes.length > 0 ? { notes } : {}),
    rule: NEVER_INFER,
    freshness: { tree: treeInfo(ctx.meta, ctx.now) },
    cost: 'free: the bridge’s own tree and stored sidebars, and the snapshots (no LegendKeeper read)',
  };
  return finish(pd, mctx, o.tool, body, () => ({
    namesakes: found.length,
    first: found.slice(0, 5).map((n) => n.character.subject),
  }));
}

/** The naming culture's part of the answer (see the module comment, 2). */
async function cultureReport(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  ctx: RepoCtx,
  rules: PackRules,
  scan: CharacterScan,
  value: string,
  full: boolean,
): Promise<Obj> {
  const token = cultureToken(rules, value);
  const recorded = (c: CharacterRecord): 'value' | 'token' | null => {
    if (!c.namingCulture) return null;
    if (textKey(c.namingCulture) === textKey(value)) return 'value';
    if (token !== null && cultureToken(rules, c.namingCulture) === token) return 'token';
    return null;
  };
  const members = scan.characters
    .map((c) => ({ c, by: recorded(c) }))
    .filter((x): x is { c: CharacterRecord; by: 'value' | 'token' } => x.by !== null)
    .sort((a, b) => a.c.subject.localeCompare(b.c.subject, 'en', { sensitivity: 'base' }));
  const cap = full ? 200 : 40;
  const memberView = {
    count: members.length,
    characters: members.slice(0, cap).map(({ c, by }) => ({
      character: c.subject,
      identityPage: c.identity,
      labels: [c.lifecycle, ...(c.au ? ['AU'] : [])],
      givenName: c.names.given,
      surname: c.names.surname,
      recordedAs: c.namingCulture,
      ...(by === 'token' ? { matchedBy: 'the same culture token' } : {}),
    })),
    ...(members.length > cap ? { more: members.length - cap } : {}),
  };
  if (token === null)
    return {
      value,
      mapped: false,
      note: `“${value}” is not in the pack’s culture map (the Packs page’s token maps), so no culture owner is looked for. Ask the owner which culture is meant; never choose one from the name.`,
      members: memberView,
    };
  const naming = rules.naming;
  if (!naming)
    return {
      value,
      mapped: true,
      token,
      note: 'The approved pack version names no cultures index, so the culture owner is not looked for.',
      members: memberView,
    };
  const { index, owners } = cultureOwners(ctx, naming.culturesIndex, [token, value]);
  const labels = treeLabeller(ctx, lifecycleFrom(pd.services?.projectSettings?.(ctx.projectId) ?? {}));
  const extra = new Set(naming.sections.map((s) => textKey(s)));
  const wanted = (title: string) => /nam(e|ing)/i.test(title) || extra.has(textKey(title));
  const appraisal = pd.services?.appraisal;
  let reader: Awaited<ReturnType<NonNullable<typeof appraisal>['reader']>>['reader'] | null = null;
  let readerNote: string | null = null;
  if (appraisal && owners.length > 0)
    try {
      reader = (await appraisal.reader(ctx.projectId)).reader;
    } catch (e) {
      readerNote = e instanceof Error ? e.message : String(e);
    }
  const ownerViews: Obj[] = [];
  for (const n of owners.slice(0, 5)) {
    const page = reader ? await reader.load(n.id) : null;
    const sections = page?.body ? sectionsWhere(page.body.blocks, wanted) : [];
    ownerViews.push({
      id: n.id,
      name: n.rawName,
      path: n.path.names.join(' / '),
      lifecycle: labels(n).lifecycle,
      ...(page?.body
        ? {
            namingSections: sections.map((s) =>
              Object.assign(
                { heading: s.title },
                cutText(
                  pd,
                  mctx,
                  tool,
                  `${n.displayName} › ${s.title}`,
                  sectionMarkdown(s.blocks),
                  full ? 20_000 : 2_500,
                ),
              ),
            ),
            snapshot: {
              id: page.page.sourceSnapshotId,
              takenAt: new Date(page.page.sourceTakenAt).toISOString(),
            },
            ...(sections.length === 0 ? { note: 'no heading of this page matches “name” or “naming”' } : {}),
          }
        : {
            namingSections: [],
            note: readerNote
              ? `its text could not be read from the snapshots (${readerNote}): read it with read_document`
              : 'not in the snapshots yet: read it with read_document',
          }),
    });
  }
  return {
    value,
    mapped: true,
    token,
    ...(index ? { culturesIndex: { id: index.id, name: index.rawName } } : {}),
    owners: ownerViews,
    ...(owners.length === 0
      ? {
          note: index
            ? `No page under ${index.rawName} is named or aliased “${token}”${textKey(token) !== textKey(value) ? ` or “${value}”` : ''}: the culture has no owner page there yet.`
            : `No index named “${naming.culturesIndex}” is in the repository, so the culture owner is not looked for.`,
        }
      : {}),
    ...(owners.length > 5 ? { moreOwners: owners.length - 5 } : {}),
    members: memberView,
  };
}

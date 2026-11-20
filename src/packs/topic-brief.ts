/**
 * v3 F4a (ADR 0063): `arkona_brief { subject, live?, include?, detail? }`, the brief on any subject (a nation, polity,
 * culture, religion, place, event, magic system, item…). It generalises `arkona_character_brief` (ADR 0052 decision 9),
 * which a character subject delegates to. Project Navigation's "Smallest Sufficient Retrieval": one free call instead
 * of five page reads.
 *
 * Free: the bridge's repository tree and stored sidebars, the snapshots (the appraisal's overlay: sidebars, link
 * collections, bodies, references), the chronology's tables (from the snapshots), the proposals and the audit findings.
 * `live: true` re-reads the head owner's sidebar (one read). It returns:
 *
 * 1. **the owner**: the subject resolved to its owning page or pages (an `[INDEX]` and the pages directly in it, or a
 *    single owner), each with its lifecycle (Authoritative, Working, Archived; AU), Reference Type, Scope, Last Major
 *    Revision and tags;
 * 2. **its Dependencies, one level**, each with its lifecycle and Scope; a Dependency on a Working or Archived page (or
 *    on historical material) is flagged (Project Navigation: "Current authority must not depend on Working, historical
 *    material or an unrelated AU"); and the count of incoming Dependencies, with the first ten;
 * 3. **Source Boundaries and Unresolved Material**, as text from the snapshots, cut with a handle when long;
 * 4. **Related Sources**, with their lifecycles;
 * 5. **chronology**: the table rows that name the subject (by mention, name or alias), with their KCY and age table;
 * 6. **work in progress**: the Working pages that mention it or depend on it, and the pending proposals touching its
 *    pages;
 * 7. **the open audit findings** on its pages;
 * 8. **freshness**: how old each source is.
 *
 * Every item is labelled by lifecycle, so established canon is never mistaken for Working material; the brief lists
 * each owner and item apart and never merges or summarises across lifecycles. The Legacy Canon Archive and the Design
 * References (ADR 0054's non-current areas) are left out unless `include` names them, and what was left out is counted.
 * A name that resolves to several subjects is refused with the candidates, as `get_resource` refuses one.
 */
import { sidebarFrom } from '../facts/index.js';
import { collectionsOf, type Collection, type PageReader } from '../appraisal/reader.js';
import type { AreaKey } from '../appraisal/scope.js';
import { findTable } from '../chronology/table.js';
import { lifecycleFrom, type LifecycleConfig } from '../lifecycle/settings.js';
import type { McpToolContext, McpToolResult } from '../mcp/server.js';
import {
  ago,
  finish,
  liveRead,
  repoContext,
  resolvePage,
  treeInfo,
  type RepoCtx,
} from '../mcp/tools/repo.js';
import { errorResult, type ProjectDeps } from '../mcp/tools/shape.js';
import { cleanPrefixes } from '../registry/names.js';
import { sidebarPiece } from '../snapshots/canonical.js';
import type { SidebarBlock, TreeNode } from '../tree/index.js';
import { consistencyLine } from '../consistency/brief-line.js';
import { characterBrief } from './brief.js';
import { textKey } from './engine/text.js';
import { nameKeyOf, splitAliases, subjectPart, treeLabeller } from './naming/namesakes.js';
import { cutText, packForRead, sectionMarkdown, sectionsWhere } from './read-support.js';
import type { PackRules } from './types.js';

type Obj = Record<string, unknown>;
type Lifecycle = 'Authoritative' | 'Working' | 'Archived';

export interface TopicBriefInput {
  readonly subject: string;
  readonly live: boolean;
  /** Non-current areas brought in: `legacy` (the Legacy Canon Archive), `design` (the Design References). */
  readonly include: readonly string[];
  readonly full: boolean;
}

/** Project Navigation's rule, quoted with every flagged Dependency. */
const DEPENDENCY_RULE =
  'Project Navigation: “Current authority must not depend on Working, historical material or an unrelated AU.”';

const AREA_LABEL: Readonly<Record<AreaKey, string>> = {
  legacy: 'the Legacy Canon Archive',
  design: 'the Design References',
};

/** A sidebar row of the tree's summary. */
function rowOf(sidebar: readonly SidebarBlock[] | null, property: string, key: string): string | null {
  const kv = sidebar?.find((p) => p.kind === 'keyValue' && textKey(p.title ?? '') === textKey(property));
  const r = kv?.rows?.find((x) => textKey(x.key) === textKey(key));
  const t = r?.text.trim() ?? '';
  return t === '' ? null : t;
}

const iso = (t: number) => new Date(t).toISOString();

export async function topicBrief(
  pd: ProjectDeps,
  mctx: McpToolContext,
  o: { readonly packId: string; readonly tool: string; readonly input: TopicBriefInput },
): Promise<McpToolResult> {
  const p = packForRead(pd, o.packId);
  if (!p.ok) return p.result;
  const { rules } = p;
  const rc = repoContext(pd);
  if (!rc.ok) return rc.result;
  const ctx = rc.ctx;
  const lifecycle = lifecycleFrom(pd.services?.projectSettings?.(ctx.projectId) ?? {});
  const labels = treeLabeller(ctx, lifecycle);
  const include = new Set(o.input.include);
  // The pages left out, by area (each counted once however many owners point at it).
  const leftOut = new Map<AreaKey, Set<string>>();
  const inScope = (n: TreeNode | null | undefined): boolean => {
    if (!n) return true;
    const a = labels(n).area;
    if (a === null || include.has(a)) return true;
    leftOut.set(a, (leftOut.get(a) ?? new Set<string>()).add(n.id));
    return false;
  };

  // ---------------------------------------------------------------------------------- the subject
  const r = resolveSubject(ctx, o.input.subject, labels, include);
  if (!r.ok) return r.result;
  const node = r.node;
  const character = ctx.types.characterOfPage(node.id);
  if (character.ok)
    return characterBrief(pd, mctx, {
      packId: o.packId,
      tool: o.tool,
      character: character.value.core.id,
      live: o.input.live,
      delegatedFrom: o.tool,
    });

  // ---------------------------------------------------------------------------------- the owners
  const isPage = (n: TreeNode) => n.kind === 'bsrc' || n.kind === 'bwrk' || n.kind === 'barc';
  const kids = node.kind === 'index' ? ctx.tree.children(ctx.projectId, node.id).data : [];
  const owners = node.kind === 'index' ? kids.filter(isPage).filter((n) => inScope(n)) : [node];
  const subindexes = kids.filter((n) => n.kind === 'index');
  const subjectIds = new Set([node.id, ...owners.map((n) => n.id)]);

  // The snapshots' overlay (free): sidebars, collections, bodies, references.
  const appraisal = pd.services?.appraisal;
  let reader: PageReader | null = null;
  const couldNotCheck: string[] = [];
  if (appraisal)
    try {
      reader = (await appraisal.reader(ctx.projectId)).reader;
    } catch (e) {
      couldNotCheck.push(
        `The snapshots cannot be read (${e instanceof Error ? e.message : String(e)}): Dependencies, Related Sources, sections, chronology and incoming links are not listed.`,
      );
    }
  else couldNotCheck.push('The snapshots are not available here: only the tree’s records are listed.');

  // live: the head owner's sidebar, one read.
  const head = owners[0] ?? null;
  let live: { id: string; facts: Map<string, string>; collections: Collection[]; at: number } | null = null;
  if (o.input.live && head) {
    const read = await liveRead(pd, mctx, o.tool, 'getResource', { path: { resourceId: head.id } });
    if (!read.ok) return read.result;
    const side = sidebarPiece((read.value as { properties?: unknown } | null)?.properties ?? []);
    const facts = new Map<string, string>();
    const kv = sidebarFrom(read.value).find(
      (x) => x.kind === 'keyValue' && textKey(x.title) === textKey(rules.sidebar.property),
    );
    for (const row of kv?.rows ?? [])
      facts.set(
        textKey(row.key),
        row.content
          .map((c) => (typeof c.text === 'string' ? c.text : ''))
          .join('')
          .trim(),
      );
    live = { id: head.id, facts, collections: collectionsOf(side), at: ctx.now };
  }

  const sidebars = ctx.tree.sidebars(
    ctx.projectId,
    owners.map((n) => n.id),
  ).data;
  const fieldKeys = {
    lmr: lifecycle.fields.lastMajorRevision,
    continuityType: lifecycle.fields.continuityType,
  };
  const auType = rules.tags.au?.continuityType ?? null;
  const ownerTerms = ownerHeadings(rules);
  const cap = o.input.full ? 100 : 10;
  const textMax = o.input.full ? 20_000 : 1_500;

  const lifecycleOf = (n: TreeNode | null): Lifecycle | null => (n ? labels(n).lifecycle : null);
  const targetView = (id: string): Obj => {
    const t = ctx.tree.node(ctx.projectId, id).data;
    if (!t) {
      const snap = reader?.page(id);
      return snap
        ? {
            id,
            name: snap.rawName,
            lifecycle: null,
            note: 'not in the repository tree now (only in the snapshots)',
          }
        : {
            id,
            name: null,
            lifecycle: null,
            note: 'not in the repository (deleted, or outside the AI REPOSITORY)',
          };
    }
    const area = labels(t).area;
    return {
      id,
      name: t.rawName,
      lifecycle: lifecycleOf(t),
      ...(t.scope ? { scope: t.scope } : {}),
      ...(area ? { area: AREA_LABEL[area] } : {}),
    };
  };

  const references = appraisal && reader ? appraisal.references(ctx.projectId, [...subjectIds]) : [];
  const ownerViews: Obj[] = [];
  const snapshotTimes: number[] = [];
  for (const n of owners) {
    const sb = sidebars.get(n.id) ?? null;
    const isLive = live !== null && live.id === n.id;
    const fact = (k: string) =>
      isLive ? live!.facts.get(textKey(k)) || null : rowOf(sb, rules.sidebar.property, k);
    const continuity = fact(fieldKeys.continuityType);
    const loaded = reader ? await reader.load(n.id) : null;
    if (loaded && loaded.page.sourceSnapshotId !== 'live') snapshotTimes.push(loaded.page.sourceTakenAt);
    const collections = isLive ? live!.collections : (loaded?.collections ?? []);
    const collection = (title: string) =>
      collections.find((c) => textKey(c.title) === textKey(title))?.items.map((i) => i.resourceId) ?? null;

    // Dependencies, one level, each flagged when current authority would depend on non-current material.
    const deps = collection(rules.sidebar.dependencies);
    const depViews = (deps ?? []).map((id) => {
      const v = targetView(id);
      const t = ctx.tree.node(ctx.projectId, id).data;
      const area = t ? labels(t).area : null;
      const lc = v.lifecycle as Lifecycle | null;
      const flag =
        lc === 'Working' || lc === 'Archived'
          ? `a Dependency on a${lc === 'Archived' ? 'n Archived' : ' Working'} page. ${DEPENDENCY_RULE}`
          : area
            ? `a Dependency on historical material (${AREA_LABEL[area]}). ${DEPENDENCY_RULE}`
            : v.name === null
              ? 'a Dependency on a page that is not in the repository'
              : null;
      return { ...v, ...(flag ? { flag } : {}) };
    });
    // Related Sources, each with its lifecycle (the non-current areas left out unless asked for).
    const related = collection(rules.sidebar.related);
    const relatedViews = (related ?? [])
      .filter((id) => inScope(ctx.tree.node(ctx.projectId, id).data))
      .map((id) => targetView(id));
    // Incoming Dependencies: pages listing this owner in their Dependencies.
    const incoming = [
      ...new Set(
        references
          .filter(
            (x) =>
              x.toPage === n.id &&
              x.via === 'collection' &&
              x.fromDocument === null &&
              textKey(x.property ?? '') === textKey(rules.sidebar.dependencies),
          )
          .map((x) => x.fromPage),
      ),
    ].filter((id) => inScope(ctx.tree.node(ctx.projectId, id).data));
    // Source Boundaries and Unresolved Material, from the snapshot's body.
    const sections = loaded?.body ? sectionsWhere(loaded.body.blocks, (t) => ownerTerms.has(textKey(t))) : [];
    const sectionView = (title: string): Obj | null => {
      const s = sections.find((x) => textKey(x.title) === textKey(title));
      if (!s) return null;
      return cutText(pd, mctx, o.tool, `${n.displayName} › ${s.title}`, sectionMarkdown(s.blocks), textMax);
    };
    const boundaries = [...ownerTerms.values()];
    ownerViews.push({
      id: n.id,
      name: n.rawName,
      path: n.path.names.join(' / '),
      lifecycle: lifecycleOf(n),
      ...(auType !== null && continuity !== null && textKey(continuity) === textKey(auType)
        ? { au: true }
        : {}),
      referenceType: n.referenceType,
      scope: n.scope,
      lastMajorRevision: fact(fieldKeys.lmr),
      tags: n.tags,
      factsFrom: isLive
        ? { source: 'live', readAt: iso(live!.at), reads: 1 }
        : sb
          ? { source: 'tree', readAt: iso(n.lastReadAt), age: ago(ctx.now - n.lastReadAt) }
          : { source: 'tree', note: 'the tree has not read this page’s sidebar yet (live: true reads it)' },
      dependencies:
        deps === null
          ? loaded || isLive
            ? 'no Dependencies collection on this page'
            : 'not in the snapshots yet (live: true reads it)'
          : depViews,
      relatedSources:
        related === null
          ? loaded || isLive
            ? 'no Related Sources collection on this page'
            : 'not in the snapshots yet (live: true reads it)'
          : relatedViews,
      incomingDependencies: {
        count: incoming.length,
        first: incoming.slice(0, cap).map((id) => targetView(id)),
      },
      ...Object.fromEntries(
        boundaries.map((title) => [
          sectionKey(title),
          loaded?.body ? (sectionView(title) ?? 'no such section on this page') : 'not in the snapshots yet',
        ]),
      ),
      ...(loaded && loaded.page.sourceSnapshotId !== 'live'
        ? {
            snapshot: {
              id: loaded.page.sourceSnapshotId,
              takenAt: iso(loaded.page.sourceTakenAt),
              age: ago(ctx.now - loaded.page.sourceTakenAt),
            },
          }
        : {}),
    });
  }

  // ---------------------------------------------------------------------------------- chronology
  const names = subjectNames(ctx, node, owners, rules);
  const chronology = reader
    ? await chronologyRows(pd, ctx, reader, subjectIds, names, o.input.full ? 200 : 20, (id) =>
        lifecycleOf(ctx.tree.node(ctx.projectId, id).data),
      )
    : null;

  // ---------------------------------------------------------------------------------- work in progress
  const working = new Map<string, { node: TreeNode | null; how: Set<string> }>();
  for (const x of references) {
    if (subjectIds.has(x.fromPage)) continue;
    const from = ctx.tree.node(ctx.projectId, x.fromPage).data;
    const lc = from ? labels(from).lifecycle : (reader?.labels(x.fromPage).lifecycle ?? null);
    if (lc !== 'Working') continue;
    if (from && !inScope(from)) continue;
    const how =
      x.via === 'mention'
        ? 'mentions it'
        : textKey(x.property ?? '') === textKey(rules.sidebar.dependencies)
          ? 'depends on it'
          : textKey(x.property ?? '') === textKey(rules.sidebar.related)
            ? 'lists it in its Related Sources'
            : `lists it${x.property ? ` in ${x.property}` : ''}`;
    const e = working.get(x.fromPage) ?? { node: from, how: new Set<string>() };
    e.how.add(how);
    working.set(x.fromPage, e);
  }
  const proposals = appraisal ? appraisal.proposalsTouching(ctx.projectId, subjectIds) : [];

  // ---------------------------------------------------------------------------------- findings
  const findings: Obj[] = [];
  const audits = pd.services?.audits;
  if (audits)
    for (const id of subjectIds)
      for (const f of audits.store.list(ctx.projectId, { pageId: id, state: 'open', limit: 20 }).findings)
        findings.push({
          page: f.pageName,
          code: f.code,
          severity: f.severity,
          message: f.message.length > 300 ? `${f.message.slice(0, 299)}…` : f.message,
          seen: iso(f.lastSeenAt),
        });

  const overlay = appraisal ? appraisal.freshness(ctx.projectId) : null;
  const body: Obj = {
    subject: {
      asked: o.input.subject,
      resolvedTo: { id: node.id, name: node.rawName, kind: node.kind === 'index' ? 'index' : 'owner' },
      ...(r.via ? { via: r.via } : {}),
      path: node.path.names.join(' / '),
    },
    owners: ownerViews,
    ...(node.kind === 'index' && owners.length === 0
      ? {
          note: 'This index holds no owner page of its own (only subindexes, or pages left out as non-current).',
        }
      : {}),
    ...(subindexes.length > 0 ? { subindexes: subindexes.map((s) => ({ id: s.id, name: s.rawName })) } : {}),
    chronology: chronology ?? 'not checked (the snapshots cannot be read)',
    workInProgress: {
      workingPages: [...working.entries()].slice(0, cap).map(([id, e]) => ({
        ...targetView(id),
        how: [...e.how],
      })),
      ...(working.size > cap ? { moreWorkingPages: working.size - cap } : {}),
      proposals: proposals.slice(0, cap).map((x) => ({
        id: x.id,
        state: x.state,
        summary: x.summary,
        proposed: iso(x.createdAt),
      })),
      ...(proposals.length > cap ? { moreProposals: proposals.length - cap } : {}),
    },
    findings,
    // v3 F4b (ADR 0064, D5): the open contradictions (dates, identity facts) restated on the subject's pages.
    consistency: consistencyLine(audits, ctx.projectId, subjectIds),
    ...(leftOut.size > 0
      ? {
          leftOut: Object.fromEntries([...leftOut].map(([k, v]) => [AREA_LABEL[k], v.size])),
          leftOutHint: 'include: ["legacy", "design"] brings the non-current areas in',
        }
      : {}),
    ...(couldNotCheck.length > 0 ? { couldNotCheck } : {}),
    freshness: {
      tree: treeInfo(ctx.meta, ctx.now),
      snapshots: overlay
        ? {
            newest: overlay.newest,
            age: overlay.age,
            ...(snapshotTimes.length > 0
              ? {
                  ownersTakenFrom: {
                    oldest: iso(Math.min(...snapshotTimes)),
                    newest: iso(Math.max(...snapshotTimes)),
                  },
                }
              : {}),
          }
        : null,
      ...(live ? { live: `${head!.rawName}’s sidebar was read now (one read)` } : {}),
    },
    rule: 'Every item carries its lifecycle: established canon (Authoritative) and Working material are listed apart and never merged or summarised together. Ask the owner before treating Working material as canon.',
    cost: o.input.live
      ? 'one read (the head owner’s sidebar); the rest free'
      : 'free: the bridge’s tree, snapshots, chronology tables, proposals and audit findings',
  };
  return finish(pd, mctx, o.tool, body, () => ({
    subject: node.rawName,
    owners: ownerViews.map((v) => v.name),
  }));
}

/** The section headings a brief reads from an owner's body: Source Boundaries and Unresolved Material (pack data). */
function ownerHeadings(rules: PackRules): Map<string, string> {
  const out = new Map<string, string>();
  const add = (h: string) => out.set(textKey(h), h);
  add('Source Boundaries');
  for (const h of rules.owners?.text.warnMissing ?? []) add(h);
  add(rules.owners?.text.unresolved ?? 'Unresolved Material');
  for (const t of rules.types) add(t.text.unresolved);
  return out;
}

/** "Source Boundaries" → `sourceBoundaries`. */
const sectionKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)/g, (_m, c: string) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '');

/** The names a subject goes by: the index's name, each owner's subject, their aliases and Canonical Display Names. */
function subjectNames(ctx: RepoCtx, node: TreeNode, owners: readonly TreeNode[], rules: PackRules): string[] {
  const names = new Set<string>();
  const add = (s: string | null | undefined) => {
    const t = (s ?? '').trim();
    if (t.length >= 3) names.add(t);
  };
  add(subjectPart(node.displayName));
  for (const a of node.aliases) add(a);
  const sidebars = ctx.tree.sidebars(
    ctx.projectId,
    owners.map((n) => n.id),
  ).data;
  for (const n of owners) {
    add(subjectPart(n.displayName));
    add(n.canonicalDisplayName);
    for (const a of n.aliases) add(a);
    for (const a of splitAliases(rowOf(sidebars.get(n.id) ?? null, rules.sidebar.property, 'Aliases')))
      add(a);
  }
  return [...names];
}

/** The chronology's table rows naming the subject: by a mention of one of its pages, or its name or an alias. */
async function chronologyRows(
  pd: ProjectDeps,
  ctx: RepoCtx,
  reader: PageReader,
  subjectIds: ReadonlySet<string>,
  names: readonly string[],
  cap: number,
  lifecycleOf: (id: string) => Lifecycle | null,
): Promise<Obj> {
  const chron = pd.services?.chronology;
  if (!chron) return { rows: [], note: 'The chronology is not available here.' };
  let cfg: ReturnType<typeof chron.config>;
  try {
    cfg = chron.config(ctx.projectId);
  } catch {
    return { rows: [], note: 'The chronology’s settings cannot be read.' };
  }
  if (!cfg.resourceId || cfg.ages.length === 0)
    return { rows: [], note: 'The chronology is not set up for this project, so no table was read.' };
  const page = reader.page(cfg.resourceId);
  if (!page) return { rows: [], note: 'The chronology page is not in the snapshots yet.' };
  const keys = names.map((n) => ({ name: n, key: nameKeyOf(n) })).filter((k) => k.key !== '');
  const rows: Obj[] = [];
  let total = 0;
  for (const age of cfg.ages) {
    const doc = page.documents.find((d) => d.id === age.tableDocumentId);
    if (!doc) continue;
    const piece = (await pd.services?.snapshots?.store.getJson<{ blocks?: unknown[] }>(doc.sha256)) ?? null;
    const found = piece?.blocks
      ? findTable(piece.blocks, { event: cfg.columns.event, date: cfg.columns.date, kcy: cfg.columns.kcy })
      : null;
    if (!found) continue;
    for (const row of found.table.rows) {
      const cell = (i: number) => row.cells[i];
      const event = cell(found.columns.event);
      const text = event?.text ?? '';
      const mentioned = row.cells.some((c) => c.mentions.some((m) => subjectIds.has(m.resourceId)));
      // A possessive still names the subject ("Al-Tibr’s fleet").
      const k = ` ${nameKeyOf(text.replace(/['’]s\b/g, ''))} `;
      const named = mentioned ? null : keys.find((x) => k.includes(` ${x.key} `));
      if (!mentioned && !named) continue;
      total++;
      if (rows.length >= cap) continue;
      rows.push({
        age: age.name,
        table: doc.name,
        row: row.id,
        event: text,
        date: cell(found.columns.date)?.text ?? '',
        kcy: cell(found.columns.kcy)?.text ?? '',
        matchedBy: mentioned ? 'a mention of its page' : `its name “${named!.name}”`,
      });
    }
  }
  return {
    rows,
    count: total,
    ...(total > rows.length ? { more: total - rows.length } : {}),
    from: {
      page: page.rawName,
      lifecycle: lifecycleOf(page.id),
      snapshot: page.sourceSnapshotId,
      takenAt: iso(page.sourceTakenAt),
    },
  };
}

/**
 * The subject a name resolves to, in the default scope (the non-current areas left out unless asked for). One
 * character's pages, or an index with its own owners, are one subject; several others are refused with the candidates.
 * A name the registry does not resolve is looked for as a page's subject (the part before " - "), which finds a
 * compact owner by its subject ("Sultanate of Tarim").
 */
function resolveSubject(
  ctx: RepoCtx,
  subject: string,
  labels: ReturnType<typeof treeLabeller>,
  include: ReadonlySet<string>,
):
  | { readonly ok: true; readonly node: TreeNode; readonly via?: string }
  | { readonly ok: false; readonly result: McpToolResult } {
  const q = cleanPrefixes(subject).name.trim() || subject.trim();
  /**
   * The registry's own refusal (ambiguous with the candidates, not found with near names, or the registry's error), as
   * get_resource's. Should the registry answer differently on the second asking, the candidates in hand are refused.
   */
  const registryRefusal = (candidates: readonly TreeNode[] = []): McpToolResult => {
    const rp = resolvePage(ctx, q);
    if (!rp.ok) return rp.result;
    return errorResult(
      candidates.length > 1
        ? {
            code: 'AMBIGUOUS',
            message: `“${subject}” names ${candidates.length} subjects. Choose one and pass its id.`,
            candidates: candidates.map((n) => ({
              id: n.id,
              name: n.rawName,
              path: n.path.names.join(' / '),
            })),
          }
        : {
            code: 'NOT_FOUND',
            message: `“${subject}” could not be resolved to one subject; pass a page id.`,
          },
      ctx.pd,
    );
  };
  const current = (n: TreeNode) => {
    const a = labels(n).area;
    return a === null || include.has(a);
  };
  const node = (id: string) => ctx.tree.node(ctx.projectId, id).data;
  const notCurrent = (list: readonly TreeNode[]): McpToolResult =>
    errorResult(
      {
        code: 'SUBJECT_NOT_CURRENT',
        message: `“${subject}” is only in ${[...new Set(list.map((n) => AREA_LABEL[labels(n).area!]))].join(' and ')}, which a brief leaves out. Pass include: ${JSON.stringify([...new Set(list.map((n) => labels(n).area!))])} to brief it.`,
        candidates: list.map((n) => ({ id: n.id, name: n.rawName, path: n.path.names.join(' / ') })),
      },
      ctx.pd,
    );
  /** One subject among candidates: one character's pages, or an index and pages directly in it. */
  const one = (list: readonly TreeNode[]): TreeNode | null => {
    if (list.length === 1) return list[0]!;
    const chars = new Set(
      list.map((n) => {
        const c = ctx.types.characterOfPage(n.id);
        return c.ok ? c.value.core.id : null;
      }),
    );
    if (!chars.has(null) && chars.size === 1) return list[0]!;
    const indexes = list.filter((n) => n.kind === 'index');
    if (indexes.length === 1 && list.every((n) => n.id === indexes[0]!.id || n.parentId === indexes[0]!.id))
      return indexes[0]!;
    return null;
  };
  let r: ReturnType<RepoCtx['types']['resolve']>;
  try {
    r = ctx.types.resolve(q, {});
  } catch {
    // The registry's error (a tree not read yet, say), answered as get_resource answers it.
    return { ok: false, result: registryRefusal() };
  }
  if (r.status === 'resolved') {
    const n = node(r.node.id);
    if (!n) return { ok: false, result: registryRefusal() };
    if (!current(n)) return { ok: false, result: notCurrent([n]) };
    return { ok: true, node: n };
  }
  if (r.status === 'ambiguous') {
    const all = r.candidates.map((c) => node(c.id)).filter((n): n is TreeNode => n !== null);
    const inScope = all.filter(current);
    if (inScope.length === 0 && all.length > 0) return { ok: false, result: notCurrent(all) };
    const picked = one(inScope);
    if (picked) return { ok: true, node: picked };
    // Several subjects: refused with the candidates, exactly as get_resource refuses an ambiguous name.
    return { ok: false, result: registryRefusal(inScope) };
  }
  // Not a page's name: a page's subject (the part before " - "), or an alias.
  const want = nameKeyOf(q);
  const hits: TreeNode[] = [];
  for (const kind of ['index', 'bsrc', 'bwrk', 'barc'] as const)
    for (const n of ctx.tree.byKind(ctx.projectId, kind).data)
      if (nameKeyOf(subjectPart(n.displayName)) === want || n.aliases.some((a) => nameKeyOf(a) === want))
        hits.push(n);
  const inScope = hits.filter(current);
  if (inScope.length === 0)
    return { ok: false, result: hits.length > 0 ? notCurrent(hits) : registryRefusal() };
  const picked = one(inScope);
  if (picked) return { ok: true, node: picked, via: 'its subject' };
  return {
    ok: false,
    result: errorResult(
      {
        code: 'AMBIGUOUS',
        message: `“${subject}” names ${inScope.length} subjects. Choose one and pass its id.`,
        candidates: inScope.map((n) => ({
          id: n.id,
          name: n.displayName,
          kind: n.kind,
          path: n.path.names.join(' / '),
        })),
      },
      ctx.pd,
    ),
  };
}

export type { LifecycleConfig };

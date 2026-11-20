/**
 * The Discover tools (v2 B2, ADR 0029): find and look at pages, tags, templates, calendars and assets. Almost all of
 * them answer from the bridge's own models (the repository tree, the type registry, the asset tree) and cost nothing;
 * the live reads (`get_resource`, `list_calendars`, a content search) say so in their descriptions.
 *
 * Every tool works only inside the project's AI REPOSITORY root, and every answer from the tree states the tree's
 * status and when it was last confirmed.
 */
import type { ImageUploadRow } from '../../images/store.js';
import { factsVersionFrom } from '../../facts/version.js';
import * as z from 'zod';
import type { AssetFolder, AssetItem, AssetMeta } from '../../assets/index.js';
import {
  describeHit,
  isPlainText,
  parseQuery,
  positiveText,
  runSearch,
  searchable,
  SearchSyntaxError,
  underValues,
  SEARCH_FIELDS,
  positiveTerms,
  textTermKey,
  textTerms,
  type Expr,
} from '../../discover/search.js';
import { inScope, labelContext, labelsOf, type Labels } from '../../appraisal/scope.js';
import { lifecycleFrom } from '../../lifecycle/settings.js';
import type { NodeKind, TreeNode } from '../../tree/index.js';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import { defineTool, READ_ANNOTATIONS, renamedTool } from './define.js';
import {
  ago,
  characterIndexNote,
  clip,
  finish,
  liveRead,
  nodeRefBody,
  repoContext,
  resolvePage,
  treeInfo,
  treeNotReady,
  OUTSIDE_NOTE,
  type RepoCtx,
} from './repo.js';
import {
  errorFromThrown,
  errorResult,
  mcpOrigin,
  projectArg,
  render,
  withProject,
  type ProjectDeps,
  type ToolDeps,
} from './shape.js';
import { inRankOrder } from '../../lk/row-order.js';

const SCOPE_CLIP = 60;
const KIND = z.enum(['index', 'bsrc', 'bwrk', 'barc', 'unclassified']);
const iso = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

// ------------------------------------------------------------------------------------------------ node views

/** A page as the browse and search tools list it. */
function brief(n: TreeNode): Record<string, unknown> {
  return {
    id: n.id,
    name: n.displayName,
    kind: n.kind,
    ...(n.referenceType ? { type: n.referenceType } : {}),
    ...(n.scope ? { scope: clip(n.scope, SCOPE_CLIP) } : {}),
    ...(n.tags.length > 0 ? { tags: n.tags } : {}),
  };
}

const parentPath = (n: TreeNode): string => n.path.names.slice(0, -1).join(' / ');

// ------------------------------------------------------------------------------------------------ the page tools

export function discoverTools(deps: ToolDeps): McpToolProvider[] {
  // ---------------------------------------------------------------------------------------------- browse tree
  const browse = defineTool({
    name: 'browse_repository_tree',
    title: 'Browse the repository tree',
    access: 'read',
    description:
      'Shows part of the AI REPOSITORY as a tree: each page’s kind (index, bsrc Authoritative, bwrk Working, barc Archived, unclassified), name, Reference Type, Scope, tags and number of child pages. Start here to learn how the repository is laid out; to find a page by name use search. `path` is a name, an id or a path such as "Characters / Beastkin / Foxians" (default: the root); `depth` is how many levels (default 2, at most 6); `kinds` filters. Large listings are cut level by level: browse a deeper `path`. Example: { "path": "Characters", "depth": 1 }. Cost: none (answered from the bridge’s tree, which says how fresh it is).',
    inputSchema: z.object({
      path: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('Page name, id or "A / B / C" path. Default: the root.'),
      depth: z.number().int().min(0).max(6).optional().describe('Levels below the page to show. Default 2.'),
      kinds: z.array(KIND).max(5).optional().describe('Show only these kinds of page.'),
      limit: z.number().int().min(1).max(400).optional().describe('Most pages to list. Default 150.'),
      offset: z.number().int().min(0).optional().describe('Skip this many of the first page’s children.'),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: ({ path, depth, kinds, limit, offset, project }, mctx) =>
      withProject(deps, project, 'read', (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        const top = locate(ctx, path);
        if (!top.ok) return top.result;
        const maxLevels = depth ?? 2;
        const budget = { left: limit ?? 150 };
        const keep = (k: NodeKind) => !kinds || kinds.length === 0 || (kinds as string[]).includes(k);
        const view = (n: TreeNode): Record<string, unknown> & { children?: Record<string, unknown>[] } => ({
          ...brief(n),
        });
        const root = view(top.node);
        interface Pending {
          readonly node: TreeNode;
          readonly out: Record<string, unknown> & { children?: Record<string, unknown>[] };
          readonly skip: number;
        }
        let level: Pending[] = [{ node: top.node, out: root, skip: offset ?? 0 }];
        let truncated = false;
        let nextOffset: number | null = null;
        let shown = 0;
        for (let l = 0; l <= maxLevels; l++) {
          const next: Pending[] = [];
          for (const p of level) {
            const kids = ctx.tree.children(ctx.projectId, p.node.id).data;
            p.out.childCount = kids.length;
            if (l === maxLevels || kids.length === 0) continue;
            const wanted = kids.filter((k) => keep(k.kind));
            const children: Record<string, unknown>[] = [];
            p.out.children = children;
            let i = p.skip;
            for (; i < wanted.length; i++) {
              if (budget.left <= 0) {
                truncated = true;
                if (p.node.id === top.node.id && nextOffset === null) nextOffset = i;
                break;
              }
              budget.left--;
              shown++;
              const c = wanted[i]!;
              const o = view(c);
              children.push(o);
              next.push({ node: c, out: o, skip: 0 });
            }
            if (p.skip > 0) p.out.childrenFrom = p.skip;
            if (kinds && kinds.length > 0 && wanted.length !== kids.length)
              p.out.matchingChildren = wanted.length;
          }
          level = next;
          if (level.length === 0) break;
        }
        // Pages at the edge of the depth limit or of the page budget show only their count; the ones cut by the
        // budget have no `children` array at all.
        return finish(
          pd,
          mctx,
          'browse_repository_tree',
          {
            tree: treeInfo(ctx.meta, ctx.now),
            path: top.node.path.names.join(' / '),
            shown,
            ...(truncated
              ? {
                  truncated: true,
                  ...(nextOffset !== null ? { nextOffset } : {}),
                  hint: 'Cut at the page limit. Browse a deeper path for the rest, raise limit (at most 400), or filter with kinds.',
                }
              : {}),
            node: root,
          },
          () => ({
            path: top.node.path.names.join(' / '),
            shown,
            node: { id: root.id, name: root.name, childCount: root.childCount },
          }),
        );
      }),
  });

  // ---------------------------------------------------------------------------------------------- search
  const search = defineTool({
    name: 'search',
    title: 'Search the repository',
    access: 'read',
    description:
      'Finds pages in the AI REPOSITORY by name, alias, Canonical Display Name or Scope. Use it when you do not know a page’s exact name (the tools that take a page accept a name or an id). For a question about a subject on an Arkona project, call arkona_brief first (free: its owners, links, boundaries and work in progress in one call), then search for what it does not cover. All words must match; "quoted phrases"; OR, NOT (or -term) and ( ) combine (capitals for OR, AND, NOT). Filters: tag: type: (Reference Type) kind: (index, bsrc, bwrk, barc, unclassified) under: (a page) scope:. Ranked: exact name, prefix, word, text in a name, alias, Scope. Example: { "query": "foxian tag:elder -kind:index under:Characters" }. Cost: none. ' +
      'content: true also searches page TEXT (blocks, sidebar facts, names and aliases) through the bridge’s full-text index, with the same operators (a word matches words starting with it; a phrase exactly), each result labelled by lifecycle and branch, with its document, section and a snippet: free, and complete as of the newest snapshot it states (later app edits are not in it yet). The Legacy Canon Archive and the Design References are left out unless include names them ("legacy", "design"). Discovery evidence, never proof on its own. content: "live" asks LegendKeeper’s own search instead (1 read; ranked, INCOMPLETE, no operators). Pages outside the AI REPOSITORY are never searched.',
    inputSchema: z.object({
      query: z.string().min(1).max(500).describe('Words, "phrases", OR, NOT/-, ( ), and filters.'),
      content: z
        .union([z.boolean(), z.literal('live')])
        .optional()
        .describe(
          'true: also search page text through the bridge’s full-text index (free, as of the newest snapshot); "live": LegendKeeper’s own search (1 read, incomplete).',
        ),
      include: z
        .array(z.enum(['legacy', 'design']))
        .max(2)
        .optional()
        .describe(
          'With content: true, bring the Legacy Canon Archive and the Design References in (left out by default).',
        ),
      limit: z.number().int().min(1).max(100).optional().describe('Results per page. Default 25.'),
      offset: z.number().int().min(0).optional(),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: ({ query, content, include, limit, offset, project }, mctx) =>
      withProject(deps, project, 'read', async (pd) => {
        let expr: Expr;
        try {
          expr = parseQuery(query);
        } catch (e) {
          if (e instanceof SearchSyntaxError) {
            return errorResult(
              {
                code: 'SEARCH_SYNTAX',
                message: e.message,
                position: e.position,
                syntax: `words, "phrases", OR, NOT or -term, ( ), filters ${SEARCH_FIELDS.map((f) => `${f}:`).join(' ')}`,
              },
              pd,
            );
          }
          throw e;
        }
        const rc = repoContext(pd, { allowUnready: true });
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        const usable = ctx.meta.status === 'ready' || ctx.meta.status === 'stale';
        const pageSize = limit ?? 25;
        const from = offset ?? 0;

        if (!usable) {
          // The tree cannot answer. A plain-text content search is cheap and can still be confined to the root by the
          // ancestry LegendKeeper returns with each hit; anything with operators needs the tree.
          if (content !== undefined && content !== false && isPlainText(expr) && ctx.meta.rootId) {
            const live = await liveSearch(ctx, mctx, expr);
            if (!live.ok) return live.result;
            const hits = live.hits.slice(from, from + pageSize);
            return render(
              {
                query,
                tree: treeInfo(ctx.meta, ctx.now),
                source: 'LegendKeeper page-text search only (the tree cannot answer yet)',
                total: live.hits.length,
                count: hits.length,
                results: hits.map((h) => ({ ...h, matched: ['page text'] })),
                note: 'Incomplete by nature: LegendKeeper’s search is ranked, capped at 100 and can miss pages.',
              },
              pd,
            );
          }
          return treeNotReady(ctx);
        }

        // under: values are pages, resolved exactly like any name (an ambiguity lists the candidates).
        const under = new Map<string, string>();
        for (const v of underValues(expr)) {
          const r = resolvePage(ctx, v, { what: `under:${v}` });
          if (!r.ok) return r.result;
          under.set(v, r.node.id);
        }

        let contentIds: Map<string, number> | undefined;
        let contentNote: Record<string, unknown> | undefined;
        // v3 F3c (ADR 0054): content: true is the bridge's full-text index (each term answered on its own, so every
        // operator holds on the text too); content: "live" is LegendKeeper's own search, as before.
        const fts = content === true ? await fullText(pd, ctx, expr) : null;
        if (fts && !fts.ok) contentNote = fts.note;
        if (content === 'live') {
          if (positiveText(expr).length === 0) {
            contentNote = {
              searched: false,
              note: 'The query has no words to search for in page text (only filters or negated terms), so LegendKeeper was not asked and nothing was spent.',
            };
          } else {
            const live = await liveSearch(ctx, mctx, expr);
            if (!live.ok) return live.result;
            contentIds = new Map(live.hits.map((h, i) => [String(h.id), i]));
            contentNote = {
              searched: true,
              foundByLegendKeeper: live.hits.length,
              note: 'LegendKeeper’s page-text search is ranked and incomplete by nature: it can miss pages, and a page it did not return may still contain the words.',
            };
          }
        }

        const all = ctx.tree.subtree(ctx.projectId, ctx.meta.rootId!, { limit: 1_000_000 }).data.entries;
        const candidates = all.filter((e) => e.node.kind !== 'root').map((e) => searchable(e.node));
        const ranked = runSearch(expr, candidates, {
          under,
          ...(contentIds ? { content: new Set(contentIds.keys()) } : {}),
          ...(fts?.ok ? { text: fts.text } : {}),
        });
        // Pages found only through their text keep LegendKeeper's order (or the index's relevance) among themselves.
        const order = contentIds ?? (fts?.ok ? fts.rank : undefined);
        const sorted = [...ranked].sort(
          (a, b) =>
            a.score - b.score ||
            (order && a.textOnly && b.textOnly
              ? (order.get(a.node.id) ?? 0) - (order.get(b.node.id) ?? 0)
              : 0),
        );
        // The full-text search's scope (decision D1): the non-current areas only when asked for.
        const labels = fts?.ok ? searchLabels(pd, ctx) : null;
        const wanted = new Set<string>(include ?? []);
        let leftOut = 0;
        const final = labels
          ? sorted.filter((r) => {
              const l = labels(r.node);
              if (inScope(l, wanted)) return true;
              leftOut++;
              return false;
            })
          : sorted;
        if (fts?.ok)
          contentNote = {
            searched: true,
            index: fts.index,
            ...(leftOut > 0
              ? {
                  leftOut,
                  leftOutNote: `${leftOut} match(es) in the Legacy Canon Archive or the Design References were left out (non-current); include: ["legacy", "design"] brings them in.`,
                }
              : {}),
            note: 'The bridge’s full-text index: complete as of the newest snapshot it names (page text, sidebar facts, names and aliases); edits made in LegendKeeper since are not in it yet. Discovery evidence, never proof on its own.',
          };
        const page = final.slice(from, from + pageSize);
        return finish(
          pd,
          mctx,
          'search',
          {
            query,
            tree: treeInfo(ctx.meta, ctx.now),
            total: final.length,
            count: page.length,
            offset: from,
            nextOffset: from + page.length < final.length ? from + page.length : null,
            results: page.map((r) => ({
              ...brief(r.node),
              path: parentPath(r.node),
              matched: [...new Set(r.hits.map(describeHit))],
              ...(r.textOnly ? { foundBy: 'page text' } : {}),
              ...(labels ? (({ lifecycle, branch }) => ({ lifecycle, branch }))(labels(r.node)) : {}),
              ...(fts?.ok && r.hits.some((h) => h.field === 'page text')
                ? { text: fts.hits(r.node.id) }
                : {}),
            })),
            ...(contentNote ? { content: contentNote } : {}),
          },
          () => ({
            total: final.length,
            first: page.slice(0, 5).map((r) => ({ id: r.node.id, name: r.node.displayName })),
          }),
        );
      }),
  });

  // ---------------------------------------------------------------------------------------------- get_resource
  // v2 E3b (ADR 0045, P1): `get_resources` is merged in. `resource` is one page; `resources` is up to 25 as ONE job.
  const getOne = async (
    pd: ProjectDeps,
    mctx: McpToolContext,
    resource: string,
    live: boolean | undefined,
  ): Promise<McpToolResult> => {
    const rc = repoContext(pd);
    if (!rc.ok) return rc.result;
    const ctx = rc.ctx;
    const r = resolvePage(ctx, resource);
    if (!r.ok) return r.result;
    const item = await describe(ctx, mctx, r.node, live !== false, 'full', 'get_resource');
    if (!item.ok) return item.result;
    const note = characterIndexNote(ctx, r.node);
    return finish(
      pd,
      mctx,
      'get_resource',
      { tree: treeInfo(ctx.meta, ctx.now), resource: item.body, ...(note ? { character: note } : {}) },
      () => ({ resource: { id: r.node.id, name: r.node.displayName } }),
    );
  };

  const LARGE_BATCH = 10;
  const getMany = async (
    pd: ProjectDeps,
    mctx: McpToolContext,
    {
      resources,
      live,
      detail,
      confirm,
    }: {
      resources: readonly string[];
      live: boolean | undefined;
      detail: 'summary' | 'full' | undefined;
      confirm: boolean | undefined;
    },
  ): Promise<McpToolResult> => {
    const rc = repoContext(pd);
    if (!rc.ok) return rc.result;
    const ctx = rc.ctx;
    const level = detail === 'full' ? 'full' : 'summary';
    interface Entry {
      readonly asked: string;
      readonly node?: TreeNode;
      readonly error?: unknown;
    }
    const entries: Entry[] = [];
    const seen = new Set<string>();
    for (const asked of resources) {
      const r = resolvePage(ctx, asked);
      if (!r.ok) {
        const text = r.result.content.map((c) => ('text' in c ? c.text : '')).join('');
        let err: unknown = text;
        try {
          err = (JSON.parse(text.split('\n')[0]!) as { error?: unknown }).error;
        } catch {
          /* keep the text */
        }
        entries.push({ asked, error: err });
      } else if (!seen.has(r.node.id)) {
        seen.add(r.node.id);
        entries.push({ asked, node: r.node });
      }
    }
    const nodes = entries.filter((e) => e.node).map((e) => e.node!);
    const liveReads = live === false ? 0 : nodes.length;
    if (liveReads > LARGE_BATCH && confirm !== true) {
      const lk = pd.projects.anyClient(pd.project.id);
      const e = lk?.governor.estimate({
        reads: liveReads,
        writes: 0,
        createManyItems: 0,
        priority: 'P1',
      });
      return render(
        {
          status: 'estimate',
          tree: treeInfo(ctx.meta, ctx.now),
          pages: nodes.length,
          reads: liveReads,
          ...(e
            ? {
                wallClockSeconds: Math.round(e.wallClockMs / 1000),
                tightestTier: e.tightestTier,
                fitsToday: e.fitsToday,
              }
            : {}),
          hint: `Nothing was read. This takes ${liveReads} LegendKeeper reads. Repeat the call with confirm: true to run it, or use live: false (no reads) or fewer pages.`,
        },
        pd,
      );
    }
    // One job: a getResource step per page, read as they finish.
    const sidebars = new Map<string, unknown>();
    const failures = new Map<string, unknown>();
    let jobNote: Record<string, unknown> | undefined;
    if (liveReads > 0) {
      try {
        const sub = await pd.engine.submit({
          kind: 'batch_ops',
          project: pd.project.id,
          steps: nodes.map((n) => ({
            op: 'getResource',
            params: { path: { resourceId: n.id } },
          })),
          onError: 'continue',
          origin: mcpOrigin(mctx, 'get_resource'),
          priority: 'P1',
          title: `get_resource (${nodes.length} pages)`,
        });
        if (!('jobId' in sub))
          return errorResult({ code: 'BRIDGE_ERROR', message: 'The read was not accepted.' }, pd);
        const job = await pd.engine.wait(pd.project.id, sub.jobId, 25_000);
        const done = job.status === 'succeeded' || job.status === 'failed';
        const results = done ? pd.engine.stepResults(pd.project.id, sub.jobId) : undefined;
        if (!results) {
          return render(
            {
              status: 'running',
              jobId: sub.jobId,
              tree: treeInfo(ctx.meta, ctx.now),
              hint: 'The reads are waiting for LegendKeeper’s rate budget and have NOT failed. Follow the job with bridge_job_status; do not start another get_resource.',
            },
            pd,
          );
        }
        results.forEach((st, i) => {
          const n = nodes[i]!;
          if (st.status === 'succeeded') sidebars.set(n.id, st.value);
          else failures.set(n.id, st.error ?? { message: `The read ended ${st.status}.` });
        });
        jobNote = { jobId: sub.jobId };
      } catch (e) {
        return errorFromThrown(e, pd);
      }
    }
    const out: Record<string, unknown>[] = [];
    for (const e of entries) {
      if (!e.node) {
        out.push({ asked: e.asked, ok: false, error: e.error });
        continue;
      }
      const failure = failures.get(e.node.id);
      if (failure) {
        out.push({ asked: e.asked, ok: false, id: e.node.id, error: failure });
        continue;
      }
      const note = characterIndexNote(ctx, e.node);
      out.push({
        asked: e.asked,
        ok: true,
        ...nodeBody(ctx, e.node),
        ...(note ? { character: note } : {}),
        ...(live === false
          ? {}
          : {
              factsVersion: factsVersionOfRead(ctx, e.node.id, sidebars.get(e.node.id)),
              sidebar: sidebarOf(ctx, sidebars.get(e.node.id), level),
            }),
        ...(live === false ? {} : { liveRead: liveStamp(sidebars.get(e.node.id)) }),
      });
    }
    return finish(
      pd,
      mctx,
      'get_resource',
      { tree: treeInfo(ctx.meta, ctx.now), count: out.length, ...(jobNote ?? {}), resources: out },
      () => ({ count: out.length, resources: out.map((o) => ({ asked: o.asked, ok: o.ok, id: o.id })) }),
    );
  };

  const getResource = defineTool({
    name: 'get_resource',
    title: 'Get one or several pages and their sidebars',
    access: 'read',
    description:
      'Shows a page: from the tree its path, kind, documents, tags, aliases, Reference Type and Scope; from one live read its whole sidebar: the facts in template order, each link collection with its items, other properties (read-only) and `factsVersion`. Pass `resource` for one page, or `resources` (up to 25 names or ids) for several as ONE job: use that instead of a loop. Use it before set_facts (pass factsVersion as baseFactsVersion). For page text use read_document. A name matching several pages is refused with the candidates: pass the id; a character’s facts and Scope are on its Character Core (or Character Reference), not on its [INDEX] page. live: false gives the tree’s data alone, for free. More than 10 pages first returns an estimate: repeat with confirm: true. Example: { "resource": "Asagiri Miyabi" } or { "resources": ["Asagiri Miyabi", "Asagiri Kaede"] }. Cost: 1 read per page (live: false: none).',
    inputSchema: z.object({
      resource: z.string().min(1).max(500).optional().describe('One page: name or id.'),
      resources: z
        .array(z.string().min(1).max(500))
        .min(1)
        .max(25)
        .optional()
        .describe(
          'Several pages (at most 25) instead of `resource`; a page that cannot be resolved is reported in its own entry.',
        ),
      live: z
        .boolean()
        .optional()
        .describe('false: the tree’s data only, no LegendKeeper read. Default true.'),
      detail: z.enum(['summary', 'full']).optional().describe('With `resources`: summary (default) or full.'),
      confirm: z
        .boolean()
        .optional()
        .describe(`With \`resources\`: needed for more than ${LARGE_BATCH} live reads, after the estimate.`),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: ({ resource, resources, live, detail, confirm, project }, mctx) =>
      withProject(deps, project, 'read', async (pd) => {
        if ((resource === undefined) === (resources === undefined)) {
          return errorResult(
            {
              code: 'RESOURCE_REQUIRED',
              message:
                resource === undefined
                  ? 'Say which page: pass `resource` (one page name or id) or `resources` (up to 25).'
                  : 'Pass either `resource` (one page) or `resources` (several), not both.',
              hint: 'Nothing was read. Example: { "resource": "Asagiri Miyabi" }.',
            },
            pd,
          );
        }
        if (resources !== undefined) return getMany(pd, mctx, { resources, live, detail, confirm });
        return getOne(pd, mctx, resource!, live);
      }),
  });

  /** The old name, kept one release: a cached tool list fails with a pointer to `get_resource` (ADR 0045, P1). */
  const getResourcesRenamed = renamedTool(
    'get_resources',
    'get_resource',
    'pass `resources` (a list of up to 25 names or ids) instead of `resource`; everything else is as before.',
  );

  // ---------------------------------------------------------------------------------------------- lists
  const listTags = defineTool({
    name: 'list_tags',
    title: 'List tags in use',
    access: 'read',
    description:
      'Lists the tags in use in the AI REPOSITORY with how many pages carry each, most used first; `query` filters. To find the pages with a tag use search with tag:<name>. Cost: none.',
    inputSchema: z.object({
      query: z.string().max(100).optional().describe('Keep tags containing this text.'),
      limit: z.number().int().min(1).max(500).optional().describe('Default 200.'),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: ({ query, limit, project }, mctx) =>
      withProject(deps, project, 'read', (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        const counts = new Map<string, number>();
        for (const e of ctx.tree.subtree(ctx.projectId, ctx.meta.rootId!, { limit: 1_000_000 }).data
          .entries) {
          for (const t of e.node.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        const q = query?.trim().toLowerCase();
        const list = [...counts.entries()]
          .filter(([t]) => !q || t.toLowerCase().includes(q))
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const max = limit ?? 200;
        return finish(
          pd,
          mctx,
          'list_tags',
          {
            tree: treeInfo(ctx.meta, ctx.now),
            total: list.length,
            count: Math.min(list.length, max),
            ...(list.length > max ? { truncated: true, hint: 'Narrow it with query.' } : {}),
            tags: list.slice(0, max).map(([tag, count]) => ({ tag, count })),
          },
          () => ({ total: list.length, first: list.slice(0, 20).map(([tag, count]) => ({ tag, count })) }),
        );
      }),
  });

  const listTemplates = defineTool({
    name: 'list_templates',
    title: 'List templates',
    access: 'read',
    description:
      'Lists the project’s templates (name, id, and which registry type and role uses each, for example Character / core). Use it to choose `template` for create_resource. Templates live outside the AI REPOSITORY. Cost: none when the bridge holds the list (it says when it was read), otherwise 1 read per 100.',
    inputSchema: z.object({
      refresh: z
        .boolean()
        .optional()
        .describe('Read the list from LegendKeeper now (1 read per 100 templates).'),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: ({ refresh, project }, mctx) =>
      withProject(deps, project, 'read', async (pd) => {
        const services = pd.services;
        if (!services)
          return errorResult(
            { code: 'TOOL_UNAVAILABLE', message: 'The type registry is not available.' },
            pd,
          );
        const types = services.registry.forProject(pd.project.id);
        const snap = types.store.templates();
        let templates: { id: string; name: string }[] = snap.templates.map((t) => ({
          id: t.id,
          name: t.name,
        }));
        let source: Record<string, unknown> = { from: 'the bridge’s copy', readAt: iso(snap.readAt) };
        if (refresh === true || snap.readAt === null) {
          templates = [];
          let cursor: string | undefined;
          for (let page = 0; page < 20; page++) {
            const r = await liveRead(pd, mctx, 'list_templates', 'listTemplates', {
              query: { limit: 100, ...(cursor ? { cursor } : {}) },
            });
            if (!r.ok) return r.result;
            const v = r.value as { data?: unknown[]; hasMore?: boolean; nextCursor?: string | null };
            for (const t of v.data ?? []) {
              const o = t as { id?: unknown; name?: unknown };
              if (typeof o.id === 'string' && typeof o.name === 'string')
                templates.push({ id: o.id, name: o.name });
            }
            if (v.hasMore !== true || !v.nextCursor) break;
            cursor = v.nextCursor;
          }
          source = { from: 'LegendKeeper (read now)', readAt: iso((pd.now ?? Date.now)()) };
        }
        const uses = new Map<string, { type: string; role: string }[]>();
        const add = (id: string | null, type: string, role: string) => {
          if (!id) return;
          uses.set(id, [...(uses.get(id) ?? []), { type, role }]);
        };
        for (const t of types.store.listTypes()) {
          add(t.indexTemplateId, t.singular, 'index');
          for (const p of t.pageTemplates) add(p.templateId, t.singular, p.role);
        }
        return render(
          {
            source,
            count: templates.length,
            templates: templates.map((t) => ({
              id: t.id,
              name: t.name,
              ...(uses.has(t.id) ? { usedBy: uses.get(t.id) } : {}),
            })),
          },
          pd,
        );
      }),
  });

  const listCalendars = defineTool({
    name: 'list_calendars',
    title: 'List calendars',
    access: 'read',
    description:
      'Lists the project’s calendars: months, days in a year, eras and date formats, summarised. A timeline document names its calendar by id. To check or convert a date use calendar_date. Cost: 1 read.',
    inputSchema: z.object({ project: projectArg }),
    annotations: READ_ANNOTATIONS,
    handler: ({ project }, mctx) =>
      withProject(deps, project, 'read', async (pd) => {
        const r = await liveRead(pd, mctx, 'list_calendars', 'listCalendars', {});
        if (!r.ok) return r.result;
        const list = ((r.value as { data?: unknown[] })?.data ?? []) as Record<string, unknown>[];
        return render({ count: list.length, calendars: list.map(calendarSummary) }, pd);
      }),
  });

  // ---------------------------------------------------------------------------------------------- assets
  const browseAssets = defineTool({
    name: 'browse_asset_tree',
    title: 'Browse the asset folders',
    access: 'read',
    description:
      'Shows the asset library as folders (to `depth`, default 2) with their asset counts; includeAssets: true lists the assets in each folder. `folder` is an id, a name or a path such as "Characters / Beastkin / Qishen". To list one folder’s assets with their urls use list_assets. The library is not limited to the AI REPOSITORY. Example: { "folder": "Characters", "depth": 1 }. Cost: none.',
    inputSchema: z.object({
      folder: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('Folder id, name or "A / B" path. Default: the top.'),
      depth: z.number().int().min(0).max(6).optional().describe('Levels of subfolders to show. Default 2.'),
      includeAssets: z.boolean().optional().describe('List the assets in each folder shown.'),
      assetsPerFolder: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Most assets listed per folder. Default 20.'),
      limit: z.number().int().min(1).max(400).optional().describe('Most folders to list. Default 150.'),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: ({ folder, depth, includeAssets, assetsPerFolder, limit, project }, mctx) =>
      withProject(deps, project, 'read', (pd) => {
        const ac = assetContext(pd);
        if (!ac.ok) return ac.result;
        const { q, id, meta, now } = ac;
        const top = locateFolder(pd, q, id, folder);
        if (!top.ok) return top.result;
        const perFolder = assetsPerFolder ?? 20;
        const budget = { left: limit ?? 150 };
        let truncated = false;
        let shown = 0;
        const build = (f: AssetFolder | null, levels: number): Record<string, unknown> => {
          const fid = f?.id ?? null;
          const subs = q.children(id, fid).data;
          const here = q.assetsIn(id, fid, { limit: includeAssets ? perFolder : 1 });
          const out: Record<string, unknown> = {
            ...(f ? { id: f.id, name: f.name } : { name: '(library top)' }),
            folderCount: subs.length,
            assetCount: here.data.total,
          };
          if (includeAssets && here.data.assets.length > 0) {
            const uploads = uploadsOf(pd, here.data.assets);
            out.assets = here.data.assets.map((a) => assetBrief(a, uploads));
            if (here.data.total > here.data.assets.length) out.assetsShown = here.data.assets.length;
          }
          if (levels > 0 && subs.length > 0) {
            const kids: Record<string, unknown>[] = [];
            for (const s of subs) {
              if (budget.left <= 0) {
                truncated = true;
                break;
              }
              budget.left--;
              shown++;
              kids.push(build(s, levels - 1));
            }
            out.folders = kids;
          }
          return out;
        };
        const tree = build(top.folder, depth ?? 2);
        return finish(
          pd,
          mctx,
          'browse_asset_tree',
          {
            assetTree: assetInfo(meta, now),
            ...(top.folder ? { path: top.path } : {}),
            foldersShown: shown,
            ...(truncated
              ? { truncated: true, hint: 'Cut at the folder limit: browse a deeper folder.' }
              : {}),
            folder: tree,
          },
          () => ({
            foldersShown: shown,
            folder: { name: tree.name, folderCount: tree.folderCount, assetCount: tree.assetCount },
          }),
        );
      }),
  });

  const listAssets = defineTool({
    name: 'list_assets',
    title: 'List assets in a folder',
    access: 'read',
    description:
      'Lists the assets directly in one folder (name, id, type, size, url), paged. `folder` is an id, a name or a path; `type` keeps IMAGE, MAP or AUDIO. Use an asset’s url on a page as ![alt](url). For the folder layout use browse_asset_tree. Example: { "folder": "Qishen", "limit": 20 }. Cost: none.',
    inputSchema: z.object({
      folder: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('Folder id, name or "A / B" path. Default: the top.'),
      type: z.enum(['IMAGE', 'MAP', 'AUDIO']).optional(),
      limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
      offset: z.number().int().min(0).optional(),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: ({ folder, type, limit, offset, project }, mctx) =>
      withProject(deps, project, 'read', (pd) => {
        const ac = assetContext(pd);
        if (!ac.ok) return ac.result;
        const { q, id, meta, now } = ac;
        const top = locateFolder(pd, q, id, folder);
        if (!top.ok) return top.result;
        const from = offset ?? 0;
        const page = q.assetsIn(id, top.folder?.id ?? null, {
          ...(type ? { types: [type] } : {}),
          limit: limit ?? 50,
          offset: from,
        }).data;
        const next = from + page.assets.length;
        const uploads = uploadsOf(pd, page.assets);
        return finish(
          pd,
          mctx,
          'list_assets',
          {
            assetTree: assetInfo(meta, now),
            folder: top.folder
              ? { id: top.folder.id, name: top.folder.name, path: top.path }
              : { name: '(library top)' },
            total: page.total,
            count: page.assets.length,
            offset: from,
            nextOffset: next < page.total ? next : null,
            assets: page.assets.map((a) => ({ ...assetBrief(a, uploads), ...(a.url ? { url: a.url } : {}) })),
          },
          () => ({ total: page.total, first: page.assets.slice(0, 10).map((a) => assetBrief(a)) }),
        );
      }),
  });

  return [
    browse,
    browseAssets,
    search,
    getResource,
    getResourcesRenamed,
    listTags,
    listTemplates,
    listCalendars,
    listAssets,
  ];
}

// ------------------------------------------------------------------------------------------------ locating a page

/** A page by name, id, or path of display names; the root when nothing is given. */
function locate(
  ctx: RepoCtx,
  path: string | undefined,
): { readonly ok: true; readonly node: TreeNode } | { readonly ok: false; readonly result: McpToolResult } {
  if (path === undefined || path.trim() === '') {
    const root = ctx.tree.root(ctx.projectId).data;
    if (!root) return { ok: false, result: treeNotReady(ctx) };
    return { ok: true, node: root };
  }
  const direct = resolvePage(ctx, path);
  if (direct.ok || !path.includes('/')) return direct;
  // "A / B / C": walk the display names from the root. The whole text was tried as a name first, because some names
  // hold a slash themselves ("Undetermined / Unknown").
  const root = ctx.tree.root(ctx.projectId).data;
  if (!root) return direct;
  const parts = path
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  const same = (n: TreeNode, p: string) => {
    const k = p.toLowerCase();
    return [n.displayName, n.rawName, ...n.aliases].some((x) => x.toLowerCase() === k);
  };
  if (parts.length > 0 && same(root, parts[0]!)) parts.shift();
  let node = root;
  for (const part of parts) {
    const kids = ctx.tree.children(ctx.projectId, node.id).data.filter((k) => same(k, part));
    if (kids.length === 0) return direct;
    if (kids.length > 1) {
      return {
        ok: false,
        result: errorResult(
          {
            code: 'AMBIGUOUS',
            message: `“${part}” in the path matches ${kids.length} pages under ${node.path.names.join(' / ')}. Pass the id of the one you mean.`,
            candidates: kids.map((k) => ({
              id: k.id,
              name: k.displayName,
              kind: k.kind,
              path: k.path.names.join(' / '),
            })),
          },
          ctx.pd,
        ),
      };
    }
    node = kids[0]!;
  }
  return { ok: true, node };
}

// ------------------------------------------------------------------------------------------------ search helpers

/**
 * v3 F3c (ADR 0054): the full-text index's answer for a query: each free-text term's pages, each page's best rank, and
 * a page's hits (document, section, snippet) for the results shown. Free: the bridge's own database, brought up to date
 * from the snapshot store first.
 */
async function fullText(
  pd: ProjectDeps,
  ctx: RepoCtx,
  expr: Expr,
): Promise<
  | {
      readonly ok: true;
      readonly text: Map<string, Set<string>>;
      readonly rank: Map<string, number>;
      readonly index: unknown;
      readonly hits: (pageId: string) => Record<string, unknown>[];
    }
  | { readonly ok: false; readonly note: Record<string, unknown> }
> {
  const a = pd.services?.appraisal;
  if (!a)
    return {
      ok: false,
      note: {
        searched: false,
        note: 'The full-text index is not available in this bridge; content: "live" asks LegendKeeper (1 read, incomplete).',
      },
    };
  const e = await a.ensureIndex(ctx.projectId);
  if (!e.state)
    return {
      ok: false,
      note: {
        searched: false,
        note: 'The full-text index is built from the nightly full snapshot and there is none yet, so only names, aliases and Scope were searched. content: "live" asks LegendKeeper (1 read, incomplete).',
      },
    };
  const text = new Map<string, Set<string>>();
  const rank = new Map<string, number>();
  const positive = new Set(positiveTerms(expr).map(textTermKey));
  for (const t of textTerms(expr)) {
    const pages = a.fullText.pagesFor(ctx.projectId, t);
    text.set(textTermKey(t), new Set(pages.keys()));
    if (!positive.has(textTermKey(t))) continue;
    for (const [id, r] of pages) rank.set(id, Math.min(rank.get(id) ?? Infinity, r));
  }
  const terms = positiveTerms(expr);
  return {
    ok: true,
    text,
    rank,
    index: a.freshness(ctx.projectId, e.state),
    hits: (pageId) =>
      a.fullText.hits(ctx.projectId, pageId, terms, 3).map((h) => ({
        ...(h.documentId ? { document: h.documentId } : {}),
        ...(h.section ? { section: h.section } : {}),
        unit: h.unit,
        ...(h.field ? { field: h.field } : {}),
        snippet: h.snippet,
      })),
  };
}

/** v3 F3c: a tree node's lifecycle, branch and area labels (the full-text search's scope, decision D1). */
function searchLabels(pd: ProjectDeps, ctx: RepoCtx): (n: TreeNode) => Labels {
  const settings = pd.services?.projectSettings?.(ctx.projectId) ?? {};
  const lc = labelContext(ctx.meta.rootId, lifecycleFrom(settings));
  const kinds = new Map<string, string>();
  const kindOf = (id: string): string => {
    let k = kinds.get(id);
    if (k === undefined) {
      k = ctx.tree.node(ctx.projectId, id).data?.kind ?? '';
      kinds.set(id, k);
    }
    return k;
  };
  return (n) => labelsOf({ ids: n.path.ids, names: n.path.names, kinds: n.path.ids.map(kindOf) }, lc);
}

async function liveSearch(
  ctx: RepoCtx,
  mctx: McpToolContext,
  expr: Expr,
): Promise<
  | { readonly ok: true; readonly hits: { id: string; name: string; path: string }[] }
  | { readonly ok: false; readonly result: McpToolResult }
> {
  const q = positiveText(expr).join(' ').slice(0, 500);
  const r = await liveRead(ctx.pd, mctx, 'search', 'search', { query: { q, limit: 100 } });
  if (!r.ok) return r;
  const rootId = ctx.meta.rootId;
  const seen = new Set<string>();
  const hits: { id: string; name: string; path: string }[] = [];
  for (const item of ((r.value as { data?: unknown[] })?.data ?? []) as {
    resource?: { id?: string; name?: string; path?: { id: string; name: string }[] };
  }[]) {
    const res = item.resource;
    if (!res?.id || seen.has(res.id)) continue; // a resource appears once per matching document
    // Inside the root: its ancestry holds the root, or the tree itself holds the page.
    const inside =
      res.id === rootId ||
      (res.path ?? []).some((a) => a.id === rootId) ||
      ctx.tree.node(ctx.projectId, res.id).data !== null;
    if (!inside) continue;
    seen.add(res.id);
    const plain = (n: string) => n.replace(/^\s*\[(?:INDEX|BSRC)\]\s*/i, '');
    hits.push({
      id: res.id,
      name: plain(res.name ?? ''),
      path: (res.path ?? []).map((a) => plain(a.name)).join(' / '),
    });
  }
  return { ok: true, hits };
}

// ------------------------------------------------------------------------------------------------ get_resource

/** A page's tree data. */
function nodeBody(ctx: RepoCtx, n: TreeNode): Record<string, unknown> {
  return {
    id: n.id,
    name: n.displayName,
    rawName: n.rawName,
    kind: n.kind,
    path: n.path.names.join(' / '),
    ...(n.parentId ? { parent: { id: n.parentId, name: n.path.names.at(-2) } } : {}),
    documents: n.documents.map((d) => ({ id: d.id, name: d.name, type: d.type })),
    tags: n.tags,
    ...(n.aliases.length > 0 ? { aliases: n.aliases } : {}),
    ...(n.referenceType ? { referenceType: n.referenceType } : {}),
    ...(n.scope ? { scope: n.scope } : {}),
    ...(n.indexScope ? { indexScope: n.indexScope } : {}),
    ...(n.canonicalDisplayName ? { canonicalDisplayName: n.canonicalDisplayName } : {}),
    childCount: ctx.tree.children(ctx.projectId, n.id).data.length,
    ...(n.isHidden ? { hidden: true } : {}),
    ...(n.isLocked ? { locked: true } : {}),
    ...(n.templateId ? { templateId: n.templateId } : {}),
    treeReadAt: iso(n.lastReadAt),
    ...(n.propertiesPending ? { propertiesNotReadYet: true } : {}),
    ...(n.stale ? { stale: n.staleReason ?? true } : {}),
  };
}

type Json = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function runsText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((r: unknown) => {
      const run = r as { text?: unknown; mention?: { text?: unknown; name?: unknown }; break?: unknown };
      if (typeof run.text === 'string') return run.text;
      if (run.mention) return text(run.mention.text) || text(run.mention.name);
      return run.break === true ? ' ' : '';
    })
    .join('');
}

function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return (blocks as { content?: unknown; children?: unknown }[])
    .map((b) => [runsText(b.content), blocksText(b.children)].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n');
}

/**
 * v2 C2b: the page's `factsVersion` from a live getResource answer (remembered, so a stale `baseFactsVersion` passed to
 * set_facts later is answered with what changed).
 */
export function factsVersionOfRead(ctx: RepoCtx, resourceId: string, resource: unknown): string {
  const { version, state } = factsVersionFrom(resourceId, resource);
  ctx.pd.services?.factsVersions?.store(ctx.projectId, resourceId, version, state);
  return version;
}

/** The sidebar of a getResource answer, as facts, link collections and named read-only properties. */
export function sidebarOf(
  ctx: RepoCtx,
  resource: unknown,
  level: 'summary' | 'full',
): Record<string, unknown>[] {
  const props = (resource as { properties?: unknown[] } | null)?.properties;
  if (!Array.isArray(props)) return [];
  const full = level === 'full';
  const obj = (v: unknown): Json => (v !== null && typeof v === 'object' ? (v as Json) : {});
  const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);
  const nameOf = (rid: string, did?: string) => {
    const n = ctx.tree.node(ctx.projectId, rid).data;
    if (!n) return { name: null, outsideRepository: true };
    const doc = did ? n.documents.find((d) => d.id === did) : undefined;
    return { name: n.displayName, ...(doc ? { document: doc.name } : {}) };
  };
  return props.map((raw) => {
    const p = obj(raw);
    const base = {
      kind: text(p.kind),
      ...(p.title ? { title: text(p.title) } : {}),
      ...(p.id ? { id: text(p.id) } : {}),
      ...(typeof p.version === 'string' ? { version: p.version } : {}),
    };
    if (p.kind === 'keyValue') {
      return {
        ...base,
        kind: 'facts',
        // In LegendKeeper's display order (by rank): getResource gives rows in stored order.
        facts: inRankOrder(list(p.rows)).map((r) => {
          const value = typeof r.text === 'string' ? r.text : runsText(r.content);
          const mentions = list(r.content)
            .filter((c) => c.mention)
            .map((c) => {
              const m = obj(c.mention);
              return {
                resourceId: text(m.resourceId),
                ...(m.documentId ? { documentId: text(m.documentId) } : {}),
                text: text(m.text) || text(m.name),
              };
            });
          return {
            key: r.key,
            value: full ? value : clip(value, 160),
            ...(mentions.length > 0 ? { mentions: full ? mentions : mentions.slice(0, 5) } : {}),
          };
        }),
      };
    }
    if (p.kind === 'resourceCollection' || p.kind === 'resourceLink') {
      const items = list(p.items);
      const shown = full ? items : items.slice(0, 15);
      return {
        ...base,
        kind: 'links',
        collection: p.kind === 'resourceCollection' ? 'collection' : 'link',
        ...(p.filter
          ? { hasFilter: true, note: 'A filter adds matching pages that are not listed here.' }
          : {}),
        itemCount: items.length,
        items: shown.map((i) => ({
          ...(i.id ? { id: text(i.id) } : {}),
          resourceId: text(i.resourceId),
          ...nameOf(text(i.resourceId), i.documentId ? text(i.documentId) : undefined),
          ...(i.documentId ? { documentId: text(i.documentId) } : {}),
        })),
        ...(shown.length < items.length ? { itemsShown: shown.length } : {}),
      };
    }
    if (p.kind === 'textField') {
      const t = blocksText(p.children);
      return { ...base, kind: 'text', readOnly: true, text: full ? t : clip(t, 300) };
    }
    return {
      ...base,
      readOnly: true,
      ...(p.kind === 'unsupported'
        ? {
            unsupported: true,
            note: 'LegendKeeper’s API cannot show or change this property; the bridge leaves it as it is.',
          }
        : { note: 'Shown by name only; the bridge does not read or change this kind of property.' }),
    };
  });
}

const liveStamp = (resource: unknown): Record<string, unknown> => {
  const r = (resource ?? {}) as { updatedAt?: unknown; isLocked?: unknown };
  return {
    ...(typeof r.updatedAt === 'string' ? { updatedAt: r.updatedAt } : {}),
    ...(typeof r.isLocked === 'boolean' ? { locked: r.isLocked } : {}),
  };
};

async function describe(
  ctx: RepoCtx,
  mctx: McpToolContext,
  node: TreeNode,
  live: boolean,
  level: 'summary' | 'full',
  tool: string,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly result: McpToolResult }
> {
  const body = nodeBody(ctx, node);
  if (!live) return { ok: true, body: { ...body, liveRead: false } };
  const r = await liveRead(ctx.pd, mctx, tool, 'getResource', { path: { resourceId: node.id } });
  if (!r.ok) return r;
  return {
    ok: true,
    body: {
      ...body,
      factsVersion: factsVersionOfRead(ctx, node.id, r.value),
      sidebar: sidebarOf(ctx, r.value, level),
      liveRead: liveStamp(r.value),
    },
  };
}

// ------------------------------------------------------------------------------------------------ calendars

function calendarSummary(c: Record<string, unknown>): Record<string, unknown> {
  const months = (Array.isArray(c.months) ? c.months : []) as {
    name?: string;
    length?: number;
    interval?: number;
  }[];
  const regular = months.filter((m) => (m.interval ?? 1) === 1);
  const days = regular.reduce((s, m) => s + (m.length ?? 0), 0);
  const era = (e: Record<string, unknown>) => ({
    name: e.name,
    ...(e.abbr ? { abbr: e.abbr } : {}),
    startsAt: e.startsAt,
    resetMode: e.resetMode,
  });
  const neg =
    c.negativeEra && typeof c.negativeEra === 'object' ? [era(c.negativeEra as Record<string, unknown>)] : [];
  const pos = ((Array.isArray(c.positiveEras) ? c.positiveEras : []) as Record<string, unknown>[]).map(era);
  const fmt = (c.format ?? null) as Record<string, unknown> | null;
  return {
    id: c.id,
    name: c.name,
    months: { count: months.length, names: months.map((m) => m.name) },
    daysInRegularYear: days,
    ...(Array.isArray(c.leapDays) ? { leapDays: c.leapDays.length } : {}),
    weekdays: Array.isArray(c.weekdays) ? c.weekdays.length : undefined,
    hoursInDay: c.hoursInDay,
    minutesInHour: c.minutesInHour,
    eras: [...neg, ...pos],
    ...(fmt ? { format: { id: fmt.id, year: fmt.year, month: fmt.month, day: fmt.day } } : {}),
    ...(c.hasZeroYear !== undefined ? { hasZeroYear: c.hasZeroYear } : {}),
    ...(typeof c.version === 'string' ? { version: c.version } : {}),
  };
}

// ------------------------------------------------------------------------------------------------ asset helpers

function assetInfo(meta: AssetMeta, now: number): Record<string, unknown> {
  return {
    status: meta.status,
    ...(meta.reason ? { note: meta.reason } : {}),
    confirmedAt: iso(meta.confirmedAt),
    ...(meta.confirmedAt !== null ? { confirmed: ago(now - meta.confirmedAt) } : {}),
    ...(meta.staleRows > 0 ? { staleRows: meta.staleRows } : {}),
  };
}

function assetBrief(a: AssetItem, uploads?: ReadonlyMap<string, ImageUploadRow>): Record<string, unknown> {
  const u = uploads?.get(a.id);
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    ...(a.width && a.height ? { width: a.width, height: a.height } : {}),
    ...(a.size !== null ? { size: a.size } : {}),
    ...(a.isHidden ? { hidden: true } : {}),
    // v2 D3 (ADR 0041): what the bridge knows of an image it uploaded itself.
    ...(u
      ? {
          bridgeUpload: {
            originalFormat: u.original.format,
            width: u.width,
            height: u.height,
            frames: u.frames,
            conversion: u.conversionMode,
            storedBytesVerified: u.storedVerified === true,
            staged: u.staged,
            ...(u.staged ? { staged_id: u.id } : {}),
          },
        }
      : {}),
  };
}

/** v2 D3: the bridge's upload records of these assets (empty without the image pipeline). */
function uploadsOf(pd: ProjectDeps, assets: readonly AssetItem[]): ReadonlyMap<string, ImageUploadRow> {
  const images = pd.services?.images;
  if (!images || assets.length === 0) return new Map();
  return images.store.uploadsOfAssets(
    pd.project.id,
    assets.map((a) => a.id),
  );
}

function assetContext(pd: ProjectDeps):
  | {
      readonly ok: true;
      readonly q: NonNullable<ProjectDeps['services']>['assets']['queries'];
      readonly id: string;
      readonly meta: AssetMeta;
      readonly now: number;
    }
  | { readonly ok: false; readonly result: McpToolResult } {
  const services = pd.services;
  if (!services) {
    return {
      ok: false,
      result: errorResult({ code: 'TOOL_UNAVAILABLE', message: 'The asset tree is not available.' }, pd),
    };
  }
  const q = services.assets.queries;
  const meta = q.status(pd.project.id);
  const now = (pd.now ?? Date.now)();
  if (meta.status === 'not_built' || meta.status === 'building') {
    return {
      ok: false,
      result: errorResult(
        {
          code: 'ASSET_TREE_NOT_READY',
          message:
            meta.status === 'building'
              ? 'The asset tree is being built and cannot answer yet. Try again when the walk has finished.'
              : 'The asset tree has not been built yet. The bridge owner starts the first build on the dashboard’s Asset Tree page.',
          assetTree: assetInfo(meta, now),
        },
        pd,
      ),
    };
  }
  return { ok: true, q, id: pd.project.id, meta, now };
}

function locateFolder(
  pd: ProjectDeps,
  q: NonNullable<ProjectDeps['services']>['assets']['queries'],
  projectId: string,
  folder: string | undefined,
):
  | { readonly ok: true; readonly folder: AssetFolder | null; readonly path: string }
  | { readonly ok: false; readonly result: McpToolResult } {
  if (folder === undefined || folder.trim() === '') return { ok: true, folder: null, path: '' };
  const wanted = folder.trim();
  const byId = q.folder(projectId, wanted).data;
  if (byId) return { ok: true, folder: byId, path: byId.path.names.join(' / ') };
  const parts = wanted
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  // The whole text as a folder name first (some names hold a slash), then as a path from the top.
  let matches = q.findFoldersByName(projectId, wanted).data;
  if (matches.length === 0 && parts.length > 1) matches = q.foldersByPath(projectId, parts).data;
  if (matches.length === 1)
    return { ok: true, folder: matches[0]!, path: matches[0]!.path.names.join(' / ') };
  if (matches.length > 1) {
    return {
      ok: false,
      result: errorResult(
        {
          code: 'AMBIGUOUS',
          message: `“${wanted}” matches ${matches.length} folders. Pass the id of the one you mean, or a longer path.`,
          candidates: matches.map((m) => ({ id: m.id, name: m.name, path: m.path.names.join(' / ') })),
        },
        pd,
      ),
    };
  }
  return {
    ok: false,
    result: errorResult(
      { code: 'NOT_FOUND', message: `No asset folder is named or has the path “${wanted}”.` },
      pd,
    ),
  };
}

export { OUTSIDE_NOTE, nodeRefBody };

/**
 * Shared parts of the Discover and Read tools (v2 B2, ADR 0029): the project's repository tree and registry for one
 * call, the tree-status line every answer carries, name resolution with typed errors, confinement to the AI REPOSITORY
 * root, and the size rule for results.
 */
import type { ProjectTypes } from '../../registry/index.js';
import { RegistryError, ROLE_LABEL } from '../../registry/index.js';
import type { NodeRef } from '../../registry/index.js';
import type { TreeMeta, TreeNode, TreeQueries } from '../../tree/index.js';
import type { McpToolContext, McpToolResult } from '../server.js';
import {
  errorFromThrown,
  errorResult,
  mcpOrigin,
  render,
  type ProjectDeps,
  type ToolErrorBody,
} from './shape.js';

/** Appended to the messages that say a page was not found: the high-level tools stop at the root. */
export const OUTSIDE_NOTE =
  'The high-level tools only work inside the project’s AI REPOSITORY page; lk_api_read can still reach pages outside it.';

export interface RepoCtx {
  readonly pd: ProjectDeps;
  readonly projectId: string;
  readonly tree: TreeQueries;
  readonly types: ProjectTypes;
  readonly meta: TreeMeta;
  readonly now: number;
}

export const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

/** The tree line of an answer: its status, why if it is not ready, and when it was last confirmed. */
export function treeInfo(meta: TreeMeta, now: number): Record<string, unknown> {
  return {
    status: meta.status,
    ...(meta.reason ? { note: meta.reason } : {}),
    confirmedAt: meta.confirmedAt === null ? null : new Date(meta.confirmedAt).toISOString(),
    ...(meta.confirmedAt !== null ? { confirmed: ago(now - meta.confirmedAt) } : {}),
    ...(meta.staleNodes > 0 ? { stalePages: meta.staleNodes } : {}),
  };
}

/** The wording of a refusal because the tree cannot answer. */
export function treeNotReady(ctx: { pd: ProjectDeps; meta: TreeMeta; now: number }): McpToolResult {
  const m = ctx.meta;
  const why =
    m.status === 'not_configured'
      ? 'No AI REPOSITORY root is set for this project, so the repository tree does not exist. The bridge owner sets it on the dashboard’s Repository Tree page.'
      : m.status === 'not_built'
        ? 'The repository tree has not been built yet. The bridge owner starts the first build on the dashboard’s Repository Tree page.'
        : 'The repository tree is being built and cannot answer yet. Try again when the build has finished.';
  return errorResult(
    {
      code: m.status === 'not_configured' ? 'TREE_NOT_CONFIGURED' : 'TREE_NOT_READY',
      message: `${why} ${m.reason ? `(${m.reason}) ` : ''}Nothing was read from LegendKeeper. The low-level tools (lk_api_read) work without the tree.`,
      tree: treeInfo(m, ctx.now),
    },
    ctx.pd,
  );
}

/** The tree and registry of the call's project, or the refusal to return (no services, or the tree is not usable). */
export function repoContext(
  deps: ProjectDeps,
  o: { allowUnready?: boolean } = {},
): { readonly ok: true; readonly ctx: RepoCtx } | { readonly ok: false; readonly result: McpToolResult } {
  const services = deps.services;
  if (!services) {
    return {
      ok: false,
      result: errorResult(
        {
          code: 'TOOL_UNAVAILABLE',
          message: 'The repository tree is not available in this bridge build.',
        },
        deps,
      ),
    };
  }
  const projectId = deps.project.id;
  const meta = services.tree.queries.status(projectId);
  const now = (deps.now ?? Date.now)();
  const ctx: RepoCtx = {
    pd: deps,
    projectId,
    tree: services.tree.queries,
    types: services.registry.forProject(projectId),
    meta,
    now,
  };
  if (!o.allowUnready && meta.status !== 'ready' && meta.status !== 'stale') {
    return { ok: false, result: treeNotReady(ctx) };
  }
  return { ok: true, ctx };
}

/** A tree node as the tools list it: enough to recognise it, small enough for hundreds. */
export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function nodeRefBody(n: NodeRef): Record<string, unknown> {
  return { id: n.id, name: n.displayName, kind: n.kind, path: n.path };
}

/** A registry refusal as a typed tool error, keeping its details (candidates, near names…). */
export function registryError(e: RegistryError, ctx: Pick<RepoCtx, 'pd' | 'meta' | 'now'>): McpToolResult {
  const body: ToolErrorBody = { code: e.code, message: e.message, ...e.details };
  if (e.code === 'TREE_NOT_READY') return treeNotReady(ctx);
  return errorResult(body, ctx.pd);
}

export type Resolved =
  { readonly ok: true; readonly node: TreeNode } | { readonly ok: false; readonly result: McpToolResult };

const ID_SHAPED = /^(lk:\/\/resources\/)?[a-z][0-9a-z]{5,31}$/;

/**
 * A name or id to exactly one page inside the repository. Ambiguity lists the candidates with their paths; a miss says
 * the search was limited to the AI REPOSITORY root.
 */
export function resolvePage(
  ctx: RepoCtx,
  query: string,
  o: { scope?: { under: string }; what?: string } = {},
): Resolved {
  try {
    const r = ctx.types.resolve(query, o.scope ? { scope: o.scope } : {});
    if (r.status === 'resolved') {
      const node = ctx.tree.node(ctx.projectId, r.node.id).data;
      if (node) return { ok: true, node };
      return {
        ok: false,
        result: errorResult(
          { code: 'NOT_FOUND', message: `${r.node.id} is not in the repository tree.` },
          ctx.pd,
        ),
      };
    }
    if (r.status === 'ambiguous') {
      return {
        ok: false,
        result: errorResult(
          {
            code: 'AMBIGUOUS',
            message: `${o.what ?? '“' + query + '”'} matches ${r.candidates.length} pages. Choose one and pass its id.`,
            // v2 C2b: a write target is never chosen for the agent, even among one character's pages; each
            // candidate says its character role, so the agent can name the one it means.
            candidates: r.candidates.map((c) => {
              const role = ctx.types.characterRole?.(c.id);
              return {
                ...nodeRefBody(c),
                matchedBy: c.matchedBy,
                ...(role ? { role: ROLE_LABEL[role.role] } : {}),
              };
            }),
          },
          ctx.pd,
        ),
      };
    }
    const looksLikeId = ID_SHAPED.test(query.trim());
    return {
      ok: false,
      result: errorResult(
        {
          code: looksLikeId ? 'NOT_IN_REPOSITORY' : 'NOT_FOUND',
          message: looksLikeId
            ? `${query.trim()} is not a page inside this project’s AI REPOSITORY (it may not exist, or it may be outside the root). ${OUTSIDE_NOTE}`
            : `No page inside the AI REPOSITORY is named “${r.cleaned}”.${r.near.length ? ` Near names (a hint only, nothing was guessed): ${r.near.map((n) => `${n.displayName} (${n.id})`).join('; ')}.` : ''} ${OUTSIDE_NOTE}`,
          ...(r.near.length ? { near: r.near.map(nodeRefBody) } : {}),
        },
        ctx.pd,
      ),
    };
  } catch (e) {
    if (e instanceof RegistryError) return { ok: false, result: registryError(e, ctx) };
    throw e;
  }
}

/** One governed live read for a tool, at interactive priority. */
export async function liveRead(
  pd: ProjectDeps,
  ctx: McpToolContext,
  tool: string,
  opId: string,
  params: Record<string, unknown>,
): Promise<
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly result: McpToolResult }
> {
  try {
    const r = await pd.engine.run(opId, params, {
      project: pd.project.id,
      origin: mcpOrigin(ctx, tool),
      priority: 'P1',
      signal: ctx.signal,
    });
    if (r.status === 'succeeded') return { ok: true, value: r.result };
    return {
      ok: false,
      result: errorResult(
        {
          code: 'READ_DELAYED',
          message:
            'LegendKeeper’s rate budget is busy, so this read was queued instead of run. Follow it with bridge_job_status; do not call this tool again in a loop.',
          ...(r.status === 'queued' || r.status === 'waiting_budget' ? { jobId: r.jobId } : {}),
        },
        pd,
      ),
    };
  } catch (e) {
    return { ok: false, result: errorFromThrown(e, pd) };
  }
}

/**
 * Applies the size rule: a result that fits `MCP_RESULT_MAX_CHARS` comes back as it is; a larger one is stored and a
 * handle comes back, with `preview` (a short look) for `bridge_result_page` to continue from.
 */
export function finish(
  pd: ProjectDeps,
  ctx: McpToolContext,
  tool: string,
  body: Record<string, unknown>,
  preview: () => unknown,
): McpToolResult {
  const named = { project: pd.project.name, ...body };
  const text = JSON.stringify(named);
  if (text.length <= pd.settings.resultMaxChars) return render(body, pd);
  const stored = pd.engine.recordResult({
    project: pd.project.id,
    opId: tool,
    params: {},
    value: named,
    origin: mcpOrigin(ctx, tool),
    title: `${tool} (stored result)`,
  });
  return render(
    {
      status: 'stored',
      handle: stored.artifactId,
      chars: text.length,
      ...(body.tree !== undefined ? { tree: body.tree } : {}),
      preview: preview(),
      hint: 'Too large to return in one piece. Read it with bridge_result_page({ handle, offset }), a page at a time, or ask for less.',
    },
    pd,
  );
}

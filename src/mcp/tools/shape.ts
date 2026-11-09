/**
 * Result shaping shared by every tool (PLAN §7):
 *
 * - every result ends with the one-line budget footer (PLAN §5.4);
 * - default results are summaries (ids, names, counts, versions); `detail: "full"` opts in to whole payloads;
 * - anything over `MCP_RESULT_MAX_CHARS` (about 40,000 characters) is stored as a job artefact and returned as a
 *   handle that `bridge_result_page` pages. Claude Code truncates MCP output at 25,000 tokens, so defaults stay far
 *   below that;
 * - failures become typed `{ error: { code, message, … } }` results, never thrown exceptions.
 */
import * as z from 'zod';
import type { ToolsSettings } from '../../config/tools.js';
import {
  BudgetExhaustedError,
  JobsError,
  LkOperationError,
  PolicyDeniedError,
  UnsupportedBlockLossError,
  VersionConflictError,
  type JobEngine,
  type JobOrigin,
  type OpParams,
  type RunResult,
} from '../../jobs/index.js';
import type { ProjectsRuntime } from '../../projects/registry.js';
import type {
  ProjectSelector,
  ProjectSelectionError,
  SelectableProjects,
  SelectedProject,
} from '../../projects/selection.js';
import type { ProjectView } from '../../projects/types.js';
import type { McpToolResult } from '../server.js';
import type { GuardOptions } from './upload-http.js';

/** The projects as the tools see them (v2 A1): `ProjectRegistry` and `StaticProjects` both provide this. */
export type ToolProjects = ProjectsRuntime & SelectableProjects & { list(): ProjectView[] };

/** What every tool handler needs. */
export interface ToolDeps {
  readonly engine: JobEngine;
  /** Every project's client (for its budget footer) and the `project` argument's choices (v2 A1). */
  readonly projects: ToolProjects;
  /** Resolves the `project` argument (REQUIRE_PROJECT_FOR_WRITES applies to write tools). */
  readonly selector: ProjectSelector;
  readonly settings: ToolsSettings;
  readonly version: string;
  /** LK_READ_ONLY as configured (the effective flag, which can be overridden at runtime, comes from the engine). */
  readonly configuredReadOnly: boolean;
  /** Test seam for the upload guard (resolver, CA, allowed addresses). Never set in production. */
  readonly uploadGuard?: GuardOptions | undefined;
  readonly now?: () => number;
}

/** A tool call's deps, bound to the project the call resolved to (every result names it). */
export interface ProjectDeps extends ToolDeps {
  readonly project: SelectedProject;
}

/** The optional `project` argument every tool takes (v2 A1). */
export const projectArg = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe(
    'The LegendKeeper project (its name, or its id): see list_projects. Reads default to the default project; ' +
      'writes must name one when the bridge serves several.',
  );

/**
 * Resolves the call's `project` and runs `fn` with deps bound to it. An unknown project, a write with no project while
 * several are served (REQUIRE_PROJECT_FOR_WRITES), or a project not available now is refused here, before anything is
 * sent or recorded.
 */
export function withProject(
  deps: ToolDeps,
  project: string | undefined,
  access: 'read' | 'write',
  fn: (pd: ProjectDeps) => McpToolResult | Promise<McpToolResult>,
): McpToolResult | Promise<McpToolResult> {
  const sel = deps.selector.select(project, access);
  if (!sel.ok) return selectionError(deps, sel.error);
  return fn({ ...deps, project: sel.project });
}

/** The refusal of a `project` argument, with the default project's budget line (it is where a read would go). */
export function selectionError(deps: ToolDeps, error: ProjectSelectionError): McpToolResult {
  const hint =
    error.code === 'PROJECT_REQUIRED'
      ? 'Pass project with one of the names in registered (list_projects shows them all).'
      : 'Call list_projects to see the projects this bridge serves.';
  const text = `${JSON.stringify({ error: { ...error, hint } })}\n${defaultFooter(deps)}`;
  return { content: [{ type: 'text', text }], isError: true };
}

function defaultFooter(deps: Pick<ToolDeps, 'projects'>): string {
  const d = deps.projects.defaultProject();
  return footerFor(deps, d.id, d.name);
}

/** The budget line of one project (each has its own governor), naming it. */
export function footerFor(deps: Pick<ToolDeps, 'projects'>, projectId: string | null, name: string): string {
  const lk = projectId !== null ? deps.projects.anyClient(projectId) : undefined;
  return lk ? lk.budgetFooter(name) : `budget (${name}): not available (the project is not served now)`;
}

// ------------------------------------------------------------------------------------------------ principal

/**
 * Every engine call from a tool uses `mcpOrigin(ctx, tool)` (src/policy): the principal resolved from the
 * server-issued token, the tool's name, and never `approvedBy`. It refuses when the request has no principal, so a
 * tool can never fall back to the `system` principal.
 */
export { mcpOrigin } from '../../policy/mcp.js';

// ------------------------------------------------------------------------------------------------ rendering

/**
 * Compact JSON, then the budget footer on its own last line. Every result names the project it used (v2 A1): an
 * object body gets `project` (the name) unless it already says, and the footer is that project's, naming it.
 */
export function render(
  body: unknown,
  deps: Pick<ProjectDeps, 'projects' | 'project'>,
  isError = false,
): McpToolResult {
  const named =
    body !== null && typeof body === 'object' && !Array.isArray(body) && !('project' in body)
      ? { project: deps.project.name, ...(body as Record<string, unknown>) }
      : body;
  const text = `${JSON.stringify(named)}\n${footerFor(deps, deps.project.id, deps.project.name)}`;
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

export interface ToolErrorBody {
  readonly code: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

export function errorResult(
  error: ToolErrorBody,
  deps: Pick<ProjectDeps, 'projects' | 'project'>,
): McpToolResult {
  return render({ error }, deps, true);
}

const BUDGET_HINT =
  'Do not retry in a loop. Wait until retryAt (or check bridge_budget), or hand the work to lk_api_batch.';

function jsonOf(e: JobsError): ToolErrorBody {
  return e.toJSON() as unknown as ToolErrorBody;
}

/** Maps anything an engine call can throw to a typed tool error. */
export function errorFromThrown(e: unknown, deps: Pick<ProjectDeps, 'projects' | 'project'>): McpToolResult {
  if (e instanceof BudgetExhaustedError) {
    return errorResult(
      {
        code: 'BUDGET_EXHAUSTED',
        message: e.message,
        tier: e.tier,
        retryAt: new Date(e.retryAtMs).toISOString(),
        retryAfterSeconds: Math.max(0, Math.ceil((e.retryAtMs - Date.now()) / 1000)),
        hint: BUDGET_HINT,
      },
      deps,
    );
  }
  if (e instanceof LkOperationError) {
    const lk = e.lk;
    return errorResult(
      {
        code: 'LK_ERROR',
        lkCode: lk.code,
        status: lk.status,
        message: lk.message,
        requestId: lk.requestId,
        classification: lk.classification,
        retryable: lk.retryable,
        ...(lk.errors.length > 0 ? { issues: lk.errors } : {}),
        ...(e.jobId ? { jobId: e.jobId, stepNo: e.stepNo } : {}),
        ...(lk.classification === 'budget' ? { hint: BUDGET_HINT } : {}),
      },
      deps,
    );
  }
  if (e instanceof VersionConflictError) {
    return errorResult(
      {
        ...jsonOf(e),
        hint: 'The entity changed since you read it. Read it again, re-apply your change to the current content, and pass the new version.',
      },
      deps,
    );
  }
  if (e instanceof UnsupportedBlockLossError) {
    return errorResult(
      {
        ...jsonOf(e),
        hint: 'Include these unsupported blocks (by id) in the new content, or pass allowUnsupportedLoss: true only if losing them is intended.',
      },
      deps,
    );
  }
  if (e instanceof PolicyDeniedError) {
    return errorResult({ ...jsonOf(e), hint: 'This connection is not allowed to do that.' }, deps);
  }
  if (e instanceof JobsError) {
    return errorResult(jsonOf(e), deps);
  }
  if (e instanceof z.ZodError) {
    return errorResult({ code: 'INVALID_PARAMS', message: e.message }, deps);
  }
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && e instanceof Error) return errorResult({ code, message: e.message }, deps);
  return errorResult({ code: 'BRIDGE_ERROR', message: e instanceof Error ? e.message : String(e) }, deps);
}

// ------------------------------------------------------------------------------------------------ run results

const WAIT_HINT = 'Do not submit it again. Follow it with bridge_job_status or bridge_job_wait.';

/** Shapes an engine `RunResult` for a single-operation tool. Writes that waited or were captured are not errors. */
export function runResultBody(
  opId: string,
  r: RunResult,
  detail: 'summary' | 'full',
): Record<string, unknown> {
  switch (r.status) {
    case 'succeeded':
      return {
        status: 'succeeded',
        operationId: opId,
        ...(r.jobId ? { jobId: r.jobId } : {}),
        result: detail === 'full' ? r.result : summarise(opId, r.result),
        requestIds: r.requestIds,
      };
    case 'queued':
      return {
        status: 'queued',
        operationId: opId,
        jobId: r.jobId,
        reason: r.reason,
        eta: r.eta === null ? null : new Date(r.eta).toISOString(),
        hint:
          r.reason === 'read_only' || r.reason === 'writes_paused'
            ? `Writes are held (${r.reason}); it runs when they resume. ${WAIT_HINT}`
            : `Queued because it is large. ${WAIT_HINT}`,
      };
    case 'waiting_budget':
      return {
        status: 'waiting_budget',
        operationId: opId,
        jobId: r.jobId,
        resumeAt: r.eta === null ? null : new Date(r.eta).toISOString(),
        hint: `The rate budget is exhausted; the write resumes by itself and has NOT failed. Never retry it. ${WAIT_HINT}`,
      };
    case 'proposal_captured':
      return {
        status: 'proposal_captured',
        operationId: opId,
        proposalId: r.proposalId,
        ...(r.summary !== undefined ? { summary: r.summary } : {}),
        hint: 'The change needs the owner’s approval and was not made. Never retry it; tell the user it is waiting for approval, and follow it with bridge_proposal_status.',
      };
  }
}

// ------------------------------------------------------------------------------------------------ summaries

const SNIPPET = 120;

function clip(s: string, n = SNIPPET): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Scalar fields of an object (long strings clipped); arrays and objects become counts. */
export function project(item: unknown, depth = 0): unknown {
  if (item === null || typeof item !== 'object') return typeof item === 'string' ? clip(item) : item;
  if (Array.isArray(item))
    return depth > 0 ? `[${item.length} items]` : item.map((x) => project(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
    if (v === null || ['number', 'boolean'].includes(typeof v)) out[k] = v;
    else if (typeof v === 'string') out[k] = clip(v);
    else if (Array.isArray(v)) {
      out[k] =
        v.length <= 5 && v.every((x) => typeof x === 'string' || typeof x === 'number')
          ? v
          : `[${v.length} items]`;
    } else out[k] = '{…}';
  }
  return out;
}

function runsText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((r) => {
      const run = r as { text?: unknown; mention?: { text?: unknown } };
      if (typeof run.text === 'string') return run.text;
      if (typeof run.mention?.text === 'string') return run.mention.text;
      return '';
    })
    .join('');
}

interface BlockLike {
  id?: unknown;
  kind?: unknown;
  level?: unknown;
  content?: unknown;
  children?: unknown;
  [key: string]: unknown;
}

function countBlocks(blocks: unknown, acc = { total: 0, unsupported: [] as string[] }) {
  if (!Array.isArray(blocks)) return acc;
  for (const b of blocks as BlockLike[]) {
    acc.total++;
    if (b.kind === 'unsupported' && typeof b.id === 'string') acc.unsupported.push(b.id);
    countBlocks(b.children, acc);
  }
  return acc;
}

const OUTLINE_MAX = 60;

function summariseBlocks(v: Record<string, unknown>): Record<string, unknown> {
  const blocks = Array.isArray(v.blocks) ? (v.blocks as BlockLike[]) : [];
  const counts = countBlocks(blocks);
  return {
    id: v.id,
    version: v.version,
    ...(v.schema !== undefined ? { schema: v.schema } : {}),
    blockCount: counts.total,
    topLevelBlocks: blocks.length,
    ...(counts.unsupported.length > 0 ? { unsupportedBlockIds: counts.unsupported } : {}),
    outline: blocks.slice(0, OUTLINE_MAX).map((b) => {
      const text = clip(runsText(b.content), 80);
      return {
        id: b.id,
        kind: b.kind,
        ...(b.level !== undefined ? { level: b.level } : {}),
        ...(text ? { text } : {}),
        ...(Array.isArray(b.children) && b.children.length > 0 ? { children: b.children.length } : {}),
      };
    }),
    ...(blocks.length > OUTLINE_MAX
      ? { outlineTruncated: `${blocks.length - OUTLINE_MAX} more blocks` }
      : {}),
    note: 'Summary. Pass detail: "full" for the whole block tree.',
  };
}

function summariseBoard(v: Record<string, unknown>): Record<string, unknown> {
  const n = (k: string) => (Array.isArray(v[k]) ? (v[k] as unknown[]).length : 0);
  return {
    version: v.version,
    pages: n('pages'),
    shapes: n('shapes'),
    bindings: n('bindings'),
    assets: n('assets'),
    note: 'Summary. Pass detail: "full" for the whole board; listBoardShapes pages the shapes.',
  };
}

/**
 * A list page's summary stays inline (under about 7,000 tokens) even at 100 rich items: items are projected as
 * usual, and when that would exceed `LIST_SUMMARY_MAX_CHARS` they are reduced to the fields that identify them.
 */
export const LIST_SUMMARY_MAX_CHARS = 24_000;
const ESSENTIAL_KEYS = [
  'id',
  'name',
  'title',
  'type',
  'kind',
  'parentId',
  'resourceId',
  'documentId',
  'version',
];

function essentials(item: unknown): unknown {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return project(item, 1);
  const o = item as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ESSENTIAL_KEYS) {
    const v = o[k];
    if (typeof v === 'string') out[k] = clip(v, 80);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // Search hits nest the entity ({ resource, document }): keep their identity too.
      out[k] = essentials(v);
    }
  }
  for (const k of ['resource', 'document']) {
    const v = o[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out[k] = essentials(v);
  }
  return out;
}

function listItems(data: readonly unknown[]): { items: unknown[]; note?: string } {
  const items = data.map((x) => project(x));
  if ((JSON.stringify(items) ?? '').length <= LIST_SUMMARY_MAX_CHARS) return { items };
  return {
    items: data.map((x) => essentials(x)),
    note: 'Items reduced to id, name, type and parent to stay small. Pass detail: "full" (or a smaller limit) for every field.',
  };
}

/** Per-operation shaping of a successful result. Falls back to a generic digest. */
export function summarise(opId: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value ?? null;
  const v = value as Record<string, unknown>;
  if ((opId === 'getDocumentBlocks' || opId === 'replaceDocumentBlocks') && Array.isArray(v.blocks)) {
    return summariseBlocks(v);
  }
  if ((opId === 'getBoardContent' || opId === 'replaceBoardContent') && Array.isArray(v.shapes)) {
    return summariseBoard(v);
  }
  if (Array.isArray(v.data) && ('hasMore' in v || 'nextCursor' in v)) {
    return {
      count: v.data.length,
      hasMore: v.hasMore === true,
      nextCursor: typeof v.nextCursor === 'string' ? v.nextCursor : null,
      ...listItems(v.data),
    };
  }
  if (Array.isArray(v.data)) return { count: v.data.length, ...listItems(v.data) };
  const text = JSON.stringify(v);
  if (text.length <= 6_000) return v;
  return { ...(project(v) as object), note: 'Large result shortened. Pass detail: "full" for everything.' };
}

/** A short, depth-limited look at a value, for the preview that accompanies an artefact handle. */
export function preview(value: unknown, maxChars = 1_500): unknown {
  const text = JSON.stringify(summarise('', value));
  return text.length <= maxChars ? JSON.parse(text) : `${text.slice(0, maxChars)}…`;
}

// ------------------------------------------------------------------------------------------------ oversize

export interface StoredHandle {
  readonly status: 'stored';
  readonly handle: string;
  readonly jobId: string;
  readonly chars: number;
  readonly preview: unknown;
  readonly hint: string;
}

/**
 * Applies the size rule to a read's result: summary (or full) inline when it fits; otherwise the whole value is
 * stored as a `result` artefact (a succeeded one-step job) and a handle comes back.
 */
export function shapeRead(
  deps: ProjectDeps,
  args: {
    readonly opId: string;
    readonly params: OpParams;
    readonly value: unknown;
    readonly detail: 'summary' | 'full';
    readonly origin: JobOrigin;
  },
): { readonly inline: unknown } | StoredHandle {
  const shaped = args.detail === 'full' ? args.value : summarise(args.opId, args.value);
  const text = JSON.stringify(shaped) ?? 'null';
  if (text.length <= deps.settings.resultMaxChars) return { inline: shaped };
  const stored = deps.engine.recordResult({
    project: deps.project.id,
    opId: args.opId,
    params: args.params,
    value: args.value,
    origin: args.origin,
  });
  return {
    status: 'stored',
    handle: stored.artifactId,
    jobId: stored.jobId,
    chars: text.length,
    preview: preview(args.value),
    hint: 'Too large to return in one piece. Read it with bridge_result_page({ handle, offset }), a page at a time.',
  };
}

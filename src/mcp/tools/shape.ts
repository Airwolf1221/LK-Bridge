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
  SYSTEM_PRINCIPAL,
  UnsupportedBlockLossError,
  VersionConflictError,
  type JobEngine,
  type JobOrigin,
  type OpParams,
  type RunResult,
} from '../../jobs/index.js';
import type { LkClient } from '../../lk/index.js';
import type { CallerIdentity } from '../../auth/bearer.js';
import type { McpToolContext, McpToolResult } from '../server.js';
import type { GuardOptions } from './upload-http.js';

/** What every tool handler needs. */
export interface ToolDeps {
  readonly engine: JobEngine;
  readonly lk: LkClient;
  readonly settings: ToolsSettings;
  readonly version: string;
  readonly projectId: string;
  /** LK_READ_ONLY as configured (the effective flag, which can be overridden at runtime, comes from the engine). */
  readonly configuredReadOnly: boolean;
  /** Test seam for the upload guard (resolver, CA, allowed addresses). Never set in production. */
  readonly uploadGuard?: GuardOptions | undefined;
  readonly now?: () => number;
}

// ------------------------------------------------------------------------------------------------ principal

/**
 * The principal a tool call acts for. PLACEHOLDER until chunk 2b adds principals, profiles and policy: one principal
 * per OAuth client or PAT, all under the profile `default`. Chunk 2b replaces this function and nothing else here.
 */
export function principalFor(caller: CallerIdentity | undefined): NonNullable<JobOrigin['principal']> {
  if (!caller) return SYSTEM_PRINCIPAL;
  const principalId = caller.kind === 'pat' ? caller.clientId : `oauth:${caller.clientId}`;
  return { principalId, profile: 'default', label: caller.label ?? caller.clientId };
}

/** Origin for the engine: the calling connection's principal and the MCP tool name (PLAN §6.1). */
export function originFor(tool: string, ctx: McpToolContext): JobOrigin {
  const caller = ctx.caller;
  return {
    kind: 'mcp',
    ...(caller ? { client: caller.label ?? caller.clientId } : {}),
    tool,
    principal: principalFor(caller),
  };
}

// ------------------------------------------------------------------------------------------------ rendering

/** Compact JSON, then the budget footer on its own last line. */
export function render(body: unknown, deps: Pick<ToolDeps, 'lk'>, isError = false): McpToolResult {
  const text = `${JSON.stringify(body)}\n${deps.lk.budgetFooter()}`;
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

export interface ToolErrorBody {
  readonly code: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

export function errorResult(error: ToolErrorBody, deps: Pick<ToolDeps, 'lk'>): McpToolResult {
  return render({ error }, deps, true);
}

const BUDGET_HINT =
  'Do not retry in a loop. Wait until retryAt (or check bridge_budget), or hand the work to lk_api_batch.';

function jsonOf(e: JobsError): ToolErrorBody {
  return e.toJSON() as unknown as ToolErrorBody;
}

/** Maps anything an engine call can throw to a typed tool error. */
export function errorFromThrown(e: unknown, deps: Pick<ToolDeps, 'lk'>): McpToolResult {
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
        hint: 'The change needs the owner’s approval and was not made. Never retry it; tell the user it is waiting for approval.',
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
      items: v.data.map((x) => project(x)),
    };
  }
  if (Array.isArray(v.data)) return { count: v.data.length, items: v.data.map((x) => project(x)) };
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
  deps: ToolDeps,
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

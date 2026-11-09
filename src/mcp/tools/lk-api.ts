/**
 * The low-level layer (PLAN §7, amendment 2): list, describe, read, write, batch, paginate_all. All 89 registry
 * operations are reachable through `lk_api_read` and `lk_api_write`, which hand them to the job engine, so every
 * guard (versions, unsupported blocks, cascade confirmation, member admin, read-only, policy) applies.
 */
import * as z from 'zod';
import type { JobEngine, OpParams } from '../../jobs/index.js';
import { getOperation, operations, type OperationDef } from '../../lk/index.js';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import {
  costClass,
  detailSchema,
  paramsSchema,
  rateCostText,
  referencedDefs,
  suggestOperations,
  versionReader,
} from './schemas.js';
import {
  errorFromThrown,
  errorResult,
  mcpOrigin,
  projectArg,
  render,
  runResultBody,
  shapeRead,
  withProject,
  type ProjectDeps,
  type ToolDeps,
} from './shape.js';

const TAGS = [...new Set(operations.map((o) => o.tag))];

// ------------------------------------------------------------------------------------------------ one operation

export type OperationTool = 'lk_api_read' | 'lk_api_write';

export function toolFor(op: OperationDef): OperationTool {
  return op.kind === 'read' ? 'lk_api_read' : 'lk_api_write';
}

export interface ExecuteInput {
  readonly operationId: string;
  readonly params: OpParams;
  readonly detail: 'summary' | 'full';
  readonly allowUnsupportedLoss?: boolean | undefined;
  readonly confirm?: 'cascade' | undefined;
}

/**
 * Runs ONE operation through the engine on behalf of `tool`. The read/write mismatch is refused here, before the
 * engine is called, so it spends no budget and records nothing.
 */
export async function executeOne(
  deps: ProjectDeps,
  tool: string,
  expected: OperationTool | 'any',
  input: ExecuteInput,
  ctx: McpToolContext,
): Promise<McpToolResult> {
  const op = getOperation(input.operationId);
  if (!op) {
    return errorResult(
      {
        code: 'UNKNOWN_OPERATION',
        message: `Unknown LegendKeeper operation: ${input.operationId}`,
        didYouMean: suggestOperations(
          input.operationId,
          operations.map((o) => o.operationId),
        ),
        hint: 'Use lk_api_list_operations to see all 89 operations.',
      },
      deps,
    );
  }
  const right = toolFor(op);
  if (expected !== 'any' && right !== expected) {
    return errorResult(
      {
        code: 'WRONG_TOOL_FOR_OPERATION',
        message:
          op.kind === 'read'
            ? `${op.operationId} is a read operation. Use lk_api_read. (No budget was spent.)`
            : `${op.operationId} is a ${op.kind} operation that changes data. Use lk_api_write. (No budget was spent.)`,
        operationId: op.operationId,
        kind: op.kind,
        useTool: right,
      },
      deps,
    );
  }
  try {
    const origin = mcpOrigin(ctx, tool);
    const r = await deps.engine.run(op.operationId, input.params, {
      project: deps.project.id,
      origin,
      priority: 'P1',
      signal: ctx.signal,
      ...(input.allowUnsupportedLoss === true ? { allowUnsupportedLoss: true } : {}),
      ...(input.confirm ? { confirm: input.confirm } : {}),
    });
    if (r.status !== 'succeeded') return render(runResultBody(op.operationId, r, input.detail), deps);
    const shaped = shapeRead(deps, {
      opId: op.operationId,
      params: input.params,
      value: r.result,
      detail: input.detail,
      origin,
    });
    if ('inline' in shaped) {
      return render(
        {
          status: 'succeeded',
          operationId: op.operationId,
          ...(r.jobId ? { jobId: r.jobId } : {}),
          result: shaped.inline,
          requestIds: r.requestIds,
        },
        deps,
      );
    }
    return render({ operationId: op.operationId, ...(r.jobId ? { jobId: r.jobId } : {}), ...shaped }, deps);
  } catch (e) {
    return errorFromThrown(e, deps);
  }
}

// ------------------------------------------------------------------------------------------------ tools

const DESTRUCTIVE_LIST = operations
  .filter((o) => o.risk !== 'safe')
  .map((o) => o.operationId)
  .join(', ');

export function lkApiTools(deps: ToolDeps): McpToolProvider[] {
  const listOperations = defineTool({
    name: 'lk_api_list_operations',
    title: 'List LegendKeeper operations',
    access: 'read',
    description:
      `Lists the ${operations.length} LegendKeeper API operations the bridge can run, filterable by tag and kind, ` +
      'with a one-line summary, kind (read / write / upload), risk (safe / destructive / admin) and cost class. ' +
      'Run an operation with lk_api_read (kind read) or lk_api_write (anything else). Cost: none (no LegendKeeper call). Risk: none.',
    inputSchema: z.object({
      tag: z
        .string()
        .optional()
        .describe(`One of: ${TAGS.join(', ')} (case-insensitive).`),
      kind: z
        .enum(['read', 'write', 'upload'])
        .optional()
        .describe('read = lk_api_read; write and upload = lk_api_write.'),
      risk: z.enum(['safe', 'destructive', 'admin']).optional(),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: ({ tag, kind, risk, project }) =>
      withProject(deps, project, 'read', (pd) => {
        const list = operations.filter(
          (o) =>
            (tag === undefined || o.tag.toLowerCase() === tag.toLowerCase()) &&
            (kind === undefined || o.kind === kind) &&
            (risk === undefined || o.risk === risk),
        );
        return render(
          {
            count: list.length,
            tags: TAGS,
            operations: list.map((o) => ({
              operationId: o.operationId,
              tag: o.tag,
              kind: o.kind,
              risk: o.risk,
              cost: costClass(o),
              summary: o.summary,
              ...(o.versioned ? { versioned: true } : {}),
              ...(o.paged ? { paged: true } : {}),
            })),
            next: 'lk_api_describe_operation({ operationId }) for the input schema.',
          },
          pd,
        );
      }),
  });

  const describeOperation = defineTool({
    name: 'lk_api_describe_operation',
    title: 'Describe a LegendKeeper operation',
    access: 'read',
    description:
      'Shows one operation in full: its input JSON Schema, risk, whether it is versioned (and which read gives the version), ' +
      'and its rate costs. Call it before an unfamiliar write. Cost: none (no LegendKeeper call). Risk: none.',
    inputSchema: z.object({
      operationId: z.string().describe('For example "replaceDocumentBlocks".'),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: ({ operationId, project }, ctx) =>
      withProject(deps, project, 'read', (pd) => {
        const op = getOperation(operationId);
        if (!op) {
          return errorResult(
            {
              code: 'UNKNOWN_OPERATION',
              message: `Unknown LegendKeeper operation: ${operationId}`,
              didYouMean: suggestOperations(
                operationId,
                operations.map((o) => o.operationId),
              ),
            },
            pd,
          );
        }
        const reader = versionReader(op);
        const body = {
          operationId: op.operationId,
          summary: op.summary,
          tag: op.tag,
          http: `${op.method} ${op.pathTemplate.replace('/projects/{projectId}', '')}`,
          kind: op.kind,
          runWith: toolFor(op),
          risk: op.risk,
          concurrency: op.concurrency,
          versioned: op.versioned,
          ...(reader ? { versionFrom: `${reader} (pass its version as params.ifMatch)` } : {}),
          paged: op.paged,
          rateCost: { class: costClass(op), tiers: op.costs, text: rateCostText(op) },
          guards: guardsFor(op),
          inputSchema: { ...op.inputJsonSchema, $defs: referencedDefs(op.inputJsonSchema) },
        };
        const text = JSON.stringify(body);
        if (text.length <= deps.settings.resultMaxChars) return render(body, pd);
        // A schema as large as the block model: stored, and paged with bridge_result_page.
        const stored = deps.engine.recordResult({
          project: pd.project.id,
          opId: 'lk_api_describe_operation',
          params: { path: { operationId } },
          value: body,
          origin: mcpOrigin(ctx, 'lk_api_describe_operation'),
          title: `describe ${op.operationId}`,
        });
        return render(
          {
            operationId: op.operationId,
            status: 'stored',
            handle: stored.artifactId,
            chars: text.length,
            overview: { ...body, inputSchema: undefined },
            hint: 'The input schema is large. Page it with bridge_result_page({ handle, offset }).',
          },
          pd,
        );
      }),
  });

  const read = defineTool({
    name: 'lk_api_read',
    title: 'Run a LegendKeeper read',
    access: 'read',
    description:
      'Runs ONE read operation (kind "read") by operationId through the governor. Cost: 1 read. Risk: none. ' +
      'Refuses operations that change data (use lk_api_write) without spending budget. ' +
      'Results are summaries (ids, names, counts, versions); pass detail "full" for whole payloads such as block trees. ' +
      'Results over about 40,000 characters come back as a handle: page it with bridge_result_page. ' +
      'Read before you write, and pass the version you read as params.ifMatch on the write.',
    inputSchema: z.object({
      operationId: z.string().describe('For example "getDocumentBlocks".'),
      params: paramsSchema.optional(),
      detail: detailSchema,
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: ({ operationId, params, detail, project }, ctx) =>
      withProject(deps, project, 'read', (pd) =>
        executeOne(
          pd,
          'lk_api_read',
          'lk_api_read',
          { operationId, params: (params ?? {}) as OpParams, detail: detail ?? 'summary' },
          ctx,
        ),
      ),
  });

  const write = defineTool({
    name: 'lk_api_write',
    title: 'Run a LegendKeeper write',
    access: 'write',
    description:
      'Runs ONE operation that changes data (kind "write" or "upload", including createImageUpload and createImageAsset) ' +
      'through the job engine and governor. Cost: 1 write (createManyResources also costs 1 item per entry). ' +
      `Risk: varies per operation; destructive or admin: ${DESTRUCTIVE_LIST}. ` +
      'Refuses read operations (use lk_api_read) without spending budget. ' +
      'Read first and pass the version you read as params.ifMatch; the bridge refuses a stale version. ' +
      'It also refuses a replace or block delete that would remove "unsupported" blocks (allowUnsupportedLoss overrides), and deleteResource ' +
      'with cascade unless confirm is "cascade". If the result is waiting_budget, queued or proposal_captured, ' +
      'the write is NOT lost and must NOT be retried: follow it with bridge_job_status.',
    inputSchema: z.object({
      operationId: z.string().describe('For example "updateResource".'),
      params: paramsSchema.optional(),
      allowUnsupportedLoss: z
        .boolean()
        .optional()
        .describe(
          'Only on replaceDocumentBlocks, replaceBlock and deleteBlock: allow the write to remove unsupported blocks.',
        ),
      confirm: z
        .literal('cascade')
        .optional()
        .describe('Required on deleteResource with query.cascade = true.'),
      detail: detailSchema,
      project: projectArg,
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: ({ operationId, params, allowUnsupportedLoss, confirm, detail, project }, ctx) =>
      withProject(deps, project, 'write', (pd) =>
        executeOne(
          pd,
          'lk_api_write',
          'lk_api_write',
          {
            operationId,
            params: (params ?? {}) as OpParams,
            detail: detail ?? 'summary',
            allowUnsupportedLoss,
            confirm,
          },
          ctx,
        ),
      ),
  });

  const batch = defineTool({
    name: 'lk_api_batch',
    title: 'Run LegendKeeper operations as a batch job',
    access: 'write',
    description:
      'Submits an ordered list of operations as ONE persisted job (batch_ops) and returns { jobId, status, eta } at once. ' +
      'onError "stop" (stopOnError, default) halts at the first failure; "continue" runs the rest. Prefer this for any multi-step work. ' +
      'Cost: the sum of its steps, paced by the governor at job priority (it leaves headroom for interactive calls). ' +
      'Risk: that of its riskiest step; every guard applies to every step, and the whole batch is refused up front if any step is invalid or not allowed. ' +
      'Follow it with bridge_job_wait or bridge_job_status; never re-submit it.',
    inputSchema: z.object({
      calls: z
        .array(
          z.object({
            operationId: z.string(),
            params: paramsSchema.optional(),
            allowUnsupportedLoss: z.boolean().optional(),
            confirm: z.literal('cascade').optional(),
          }),
        )
        .min(1)
        .max(500),
      onError: z.enum(['stop', 'stopOnError', 'continue']).optional().describe('Default "stop".'),
      title: z.string().max(200).optional(),
      project: projectArg,
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: ({ calls, onError, title, project }, ctx) =>
      withProject(deps, project, 'write', async (pd) => {
        try {
          const r = await deps.engine.submit({
            kind: 'batch_ops',
            project: pd.project.id,
            steps: calls.map((c) => ({
              op: c.operationId,
              params: (c.params ?? {}) as OpParams,
              ...(c.allowUnsupportedLoss === true ? { allowUnsupportedLoss: true } : {}),
              ...(c.confirm ? { confirm: c.confirm } : {}),
            })),
            onError: onError === 'continue' ? 'continue' : 'stop',
            origin: mcpOrigin(ctx, 'lk_api_batch'),
            priority: 'P2',
            ...(title ? { title } : {}),
          });
          return render(submitBody(r, calls.length), pd);
        } catch (e) {
          return errorFromThrown(e, pd);
        }
      }),
  });

  const paginate = defineTool({
    name: 'lk_api_paginate_all',
    title: 'Read every page of a LegendKeeper list',
    access: 'read',
    description:
      'Follows every cursor of a paged list operation (listResources, listTemplates, listEvents, listAssets, listProjects) as a ' +
      'paginate_all job: each page is a separate governed read at job priority. Returns { jobId, handle, eta } at once. ' +
      'Cost: 1 read per page (up to 100 items). Risk: none. Wait with bridge_job_wait, then page the stored items with ' +
      'bridge_result_page({ handle }); partial results are readable while it runs.',
    inputSchema: z.object({
      operationId: z.string().describe('A paged read, e.g. "listResources".'),
      params: paramsSchema.optional(),
      maxItems: z.number().int().min(1).optional(),
      maxPages: z.number().int().min(1).optional(),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: ({ operationId, params, maxItems, maxPages, project }, ctx) =>
      withProject(deps, project, 'read', async (pd) => {
        const op = getOperation(operationId);
        if (!op || op.kind !== 'read' || !op.paged) {
          return errorResult(
            {
              code: op ? 'NOT_PAGED' : 'UNKNOWN_OPERATION',
              message: op
                ? `${op.operationId} is not a paged read operation, so it cannot be paginated. (No budget was spent.)`
                : `Unknown LegendKeeper operation: ${operationId}`,
              pagedOperations: operations
                .filter((o) => o.paged && o.kind === 'read')
                .map((o) => o.operationId),
            },
            pd,
          );
        }
        try {
          const r = await deps.engine.submit({
            kind: 'paginate_all',
            project: pd.project.id,
            op: operationId,
            params: (params ?? {}) as OpParams,
            ...(maxItems !== undefined ? { maxItems } : {}),
            ...(maxPages !== undefined ? { maxPages } : {}),
            origin: mcpOrigin(ctx, 'lk_api_paginate_all'),
            priority: 'P2',
          });
          if (!('jobId' in r)) return render(submitBody(r, 1), pd);
          const job = deps.engine.queries.getJob(pd.project.id, r.jobId);
          const handle = (job?.result as { artifactId?: string } | null)?.artifactId;
          return render(
            {
              ...submitBody(r, 1),
              handle,
              hint: 'Wait with bridge_job_wait, then bridge_result_page({ handle }).',
            },
            pd,
          );
        } catch (e) {
          return errorFromThrown(e, pd);
        }
      }),
  });

  return [listOperations, describeOperation, read, write, batch, paginate];
}

/** `{ jobId, status, eta }` for a submitted job, or the captured proposal. */
export function submitBody(
  r: Awaited<ReturnType<JobEngine['submit']>>,
  steps: number,
): Record<string, unknown> {
  if ('proposalId' in r) {
    return {
      status: 'proposal_captured',
      proposalId: r.proposalId,
      ...(r.summary !== undefined ? { summary: r.summary } : {}),
      hint: 'The work needs the owner’s approval and was not started. Never retry it; tell the user it is waiting for approval, and follow it with bridge_proposal_status.',
    };
  }
  return {
    jobId: r.jobId,
    status: r.status,
    eta: r.eta === null ? null : new Date(r.eta).toISOString(),
    steps,
    hint: 'Do not submit it again. Follow it with bridge_job_wait({ jobId }) or bridge_job_status({ jobId }).',
  };
}

function guardsFor(op: OperationDef): string[] {
  const g: string[] = [];
  if (op.kind !== 'read') {
    g.push('refused while the bridge is read-only (LK_READ_ONLY), or while the project itself is read-only');
  }
  if (op.versioned) g.push('versioned: If-Match is always sent; a stale version is refused');
  if (op.risk === 'admin') g.push('member/invite administration: disabled unless LK_ALLOW_MEMBER_ADMIN=true');
  if (op.operationId === 'deleteResource') g.push('cascade=true needs confirm: "cascade"');
  if (['replaceDocumentBlocks', 'replaceBlock', 'deleteBlock'].includes(op.operationId)) {
    g.push('refused if it would remove "unsupported" blocks, unless allowUnsupportedLoss: true');
  }
  if (op.risk === 'destructive') g.push('a pre-image is journalled first (bridge_journal_lookup)');
  return g;
}

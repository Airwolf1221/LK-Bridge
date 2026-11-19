/**
 * The low-level layer (PLAN §7, amendment 2): list, describe, read, write, batch, paginate_all. All 89 registry
 * operations are reachable through `lk_api_read` and `lk_api_write`, which hand them to the job engine, so every
 * guard (versions, unsupported blocks, cascade confirmation, member admin, read-only, policy) applies.
 */
import * as z from 'zod';
import type { LmrMode } from '../../jobs/lmr-hook.js';
import type { JobEngine, OpParams } from '../../jobs/index.js';
import { getOperation, operations, type OperationDef } from '../../lk/index.js';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { unknownOperationBody } from './discovery.js';
import { canonicalBody } from './shape.js';
import { subjectRenameRefusal } from '../../packs/rename/guard.js';
import { plainRenameArg } from './resources.js';
import {
  costClass,
  detailSchema,
  lastMajorRevisionArg,
  paramsSchema,
  rateCostText,
  referencedDefs,
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
  /** v3 F3c (ADR 0051): the caller's Last Major Revision override (writes only). */
  readonly lastMajorRevision?: LmrMode | undefined;
  /** ADR 0058 amendment (C): why a subject is renamed plainly (an `updateResource` on a pack project). */
  readonly plainRename?: { readonly reason: string } | undefined;
}

/**
 * ADR 0058 amendment (C): an `updateResource` that changes a subject's name on a project with an approved setting pack
 * is `arkona_rename`'s: the refusal body (`USE_ARKONA_RENAME`), or null.
 */
export function subjectRenameIn(
  pd: ProjectDeps,
  opId: string,
  params: OpParams,
): Record<string, unknown> | null {
  if (opId !== 'updateResource') return null;
  const name = (params.body as { name?: unknown } | undefined)?.name;
  const id = params.path?.resourceId;
  const services = pd.services;
  if (typeof name !== 'string' || typeof id !== 'string' || !services?.packs) return null;
  const projectId = pd.project.id;
  const node = services.tree.queries.node(projectId, id).data;
  if (!node) return null;
  const types = services.registry.forProject(projectId);
  const sidebar = services.tree.queries.sidebars(projectId, [id]).data.get(id) ?? null;
  return subjectRenameRefusal({
    packs: services.packs,
    projectId,
    node,
    newName: name,
    characterOf: (pageId) => {
      try {
        return types.characterOfPage(pageId).ok;
      } catch {
        return false;
      }
    },
    factKeys: sidebar ? sidebar.flatMap((b) => (b.rows ?? []).map((r) => r.key)) : null,
    childrenOf: (indexId) => services.tree.queries.children(projectId, indexId).data,
  });
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
    return errorResult(unknownOperationBody(input.operationId, ctx.showLowLevelTools === true), deps);
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
  if (!input.plainRename) {
    const refusal = subjectRenameIn(deps, op.operationId, input.params);
    if (refusal) return errorResult(refusal as { code: string; message: string }, deps);
  }
  try {
    const origin = mcpOrigin(ctx, tool);
    const r = await deps.engine.run(op.operationId, input.params, {
      project: deps.project.id,
      origin,
      priority: 'P1',
      signal: ctx.signal,
      // CR-2026-11-R3 (R3-49): the reason in the job's title AND its journal entry (ADR 0058 amendment C), as
      // update_resource records it.
      ...(input.plainRename
        ? {
            title: `${op.operationId} (plain rename: ${input.plainRename.reason})`.slice(0, 300),
            journalOperation: { tool, plainRename: input.plainRename.reason },
          }
        : {}),
      ...(input.allowUnsupportedLoss === true ? { allowUnsupportedLoss: true } : {}),
      ...(input.confirm ? { confirm: input.confirm } : {}),
      ...(input.lastMajorRevision ? { lastMajorRevision: input.lastMajorRevision } : {}),
    });
    if (r.status !== 'succeeded') {
      const body = runResultBody(op.operationId, r, input.detail);
      return render(
        r.status !== 'proposal_captured' && r.lastMajorRevision
          ? { ...body, lastMajorRevision: r.lastMajorRevision }
          : body,
        deps,
      );
    }
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
          ...(r.lastMajorRevision ? { lastMajorRevision: r.lastMajorRevision } : {}),
        },
        deps,
      );
    }
    return render(
      {
        operationId: op.operationId,
        ...(r.jobId ? { jobId: r.jobId } : {}),
        ...shaped,
        ...(r.lastMajorRevision ? { lastMajorRevision: r.lastMajorRevision } : {}),
      },
      deps,
    );
  } catch (e) {
    return errorFromThrown(e, deps);
  }
}

// ------------------------------------------------------------------------------------------------ tools

export function lkApiTools(deps: ToolDeps): McpToolProvider[] {
  const listOperations = defineTool({
    name: 'lk_api_list_operations',
    lowLevel: true,
    title: 'List LegendKeeper operations',
    access: 'read',
    description:
      'Lists the 89 LegendKeeper operations, filterable by tag and kind, with kind, risk and cost class. For work no high-level tool does. Run an operation with lk_api_read (kind read) or lk_api_write (anything else). Cost: none.',
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
    lowLevel: true,
    title: 'Describe a LegendKeeper operation',
    access: 'read',
    description:
      'Shows one operation in full: its input schema, risk, whether it is versioned (and which read gives the version) and its rate costs. Call it before an unfamiliar write. Cost: none.',
    inputSchema: z.object({
      operationId: z.string().describe('For example "replaceDocumentBlocks".'),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: ({ operationId, project }, ctx) =>
      withProject(deps, project, 'read', (pd) => {
        const op = getOperation(operationId);
        if (!op) {
          return errorResult(unknownOperationBody(operationId, ctx.showLowLevelTools === true), pd);
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
      'Runs ONE read operation by `operationId` (the ids are listed under Operations in get_bridge_guide). The low-level fallback, for what no high-level tool does (for example listMembers); a name that is not an operation id is refused with suggestions. A write operation is refused (use lk_api_write) without spending budget. Results are summaries (detail "full" for whole payloads); over about 40,000 characters they come as a handle for bridge_result_page. Cost: 1 read.',
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
      'Runs ONE operation that changes data, by `operationId`. The low-level fallback, for what no high-level tool does: pages, facts, creates, moves, deletes, documents, timelines and maps all have their own tools, which keep the repository’s ordering, canon and lifecycle rules (this tool applies only the engine’s guards). Read first and pass the version as params.ifMatch; a stale one is refused. A read operation is refused (use lk_api_read). A replace or block delete that would lose "unsupported" blocks is refused (allowUnsupportedLoss overrides: ask the person first), and so is deleteResource with cascade unless confirm is "cascade". At scope propose, or when it touches protected canon, it becomes a proposal. If the result is queued, waiting_budget or proposal_captured the write is NOT lost: never retry it, follow it with bridge_job_status or bridge_proposal_status. Cost: 1 write.',
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
      lastMajorRevision: lastMajorRevisionArg,
      plainRename: plainRenameArg,
      project: projectArg,
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: (
      { operationId, params, allowUnsupportedLoss, confirm, detail, lastMajorRevision, plainRename, project },
      ctx,
    ) =>
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
            lastMajorRevision,
            plainRename,
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
      'Submits an ordered list of low-level operations as ONE persisted job and returns { jobId, status, eta } at once; onError "stop" (default) or "continue". Use it, not a loop of lk_api_write calls, for multi-step low-level work. Every step is checked before anything is queued. Follow it with bridge_job_status (wait_seconds waits for it); never resubmit it. Cost: the sum of its steps, at job priority.',
    inputSchema: z.object({
      calls: z
        .array(
          z.object({
            operationId: z.string(),
            params: paramsSchema.optional(),
            allowUnsupportedLoss: z.boolean().optional(),
            confirm: z.literal('cascade').optional(),
            plainRename: plainRenameArg,
          }),
        )
        .min(1)
        .max(500),
      onError: z.enum(['stop', 'stopOnError', 'continue']).optional().describe('Default "stop".'),
      title: z.string().max(200).optional(),
      lastMajorRevision: lastMajorRevisionArg,
      project: projectArg,
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: ({ calls, onError, title, lastMajorRevision, project }, ctx) =>
      withProject(deps, project, 'write', async (pd) => {
        // An unknown operation anywhere in the batch refuses the whole batch up front (nothing is queued or spent),
        // with the same suggestions and hint a single call would get.
        const unknown = calls.findIndex((c) => !getOperation(c.operationId));
        if (unknown >= 0) {
          return errorResult(
            unknownOperationBody(calls[unknown]!.operationId, ctx.showLowLevelTools === true, {
              callIndex: unknown,
              message: `Unknown LegendKeeper operation: ${calls[unknown]!.operationId} (call ${unknown + 1} of ${calls.length}). Nothing was queued.`,
            }),
            pd,
          );
        }
        // ADR 0058 amendment (C): a subject's rename on a pack project is arkona_rename's (unless plainRename says why).
        const plain: string[] = [];
        for (const [i, c] of calls.entries()) {
          if (c.plainRename) {
            if (c.operationId === 'updateResource') plain.push(c.plainRename.reason);
            continue;
          }
          const refusal = subjectRenameIn(pd, c.operationId, (c.params ?? {}) as OpParams);
          if (refusal)
            return errorResult(
              {
                ...(refusal as { code: string; message: string }),
                callIndex: i,
                message: `${String(refusal.message)} (call ${i + 1} of ${calls.length}; nothing was queued)`,
              },
              pd,
            );
        }
        const batchTitle =
          plain.length > 0 ? `${title ?? 'batch'} (plain rename: ${plain.join('; ')})`.slice(0, 300) : title;
        try {
          const r = await deps.engine.submit({
            kind: 'batch_ops',
            project: pd.project.id,
            steps: calls.map((c) => ({
              op: c.operationId,
              params: (c.params ?? {}) as OpParams,
              ...(c.allowUnsupportedLoss === true ? { allowUnsupportedLoss: true } : {}),
              ...(c.confirm ? { confirm: c.confirm } : {}),
              // CR-2026-11-R3 (R3-49): a plain rename's reason in its write's journal entry too.
              ...(c.plainRename && c.operationId === 'updateResource'
                ? { journalOperation: { tool: 'lk_api_batch', plainRename: c.plainRename.reason } }
                : {}),
            })),
            onError: onError === 'continue' ? 'continue' : 'stop',
            origin: mcpOrigin(ctx, 'lk_api_batch'),
            priority: 'P2',
            ...(batchTitle ? { title: batchTitle } : {}),
            ...(lastMajorRevision ? { lastMajorRevision } : {}),
          });
          return render(submitBody(r, calls.length), pd);
        } catch (e) {
          return errorFromThrown(e, pd);
        }
      }),
  });

  const paginate = defineTool({
    name: 'lk_api_paginate_all',
    lowLevel: true,
    title: 'Read every page of a LegendKeeper list',
    access: 'read',
    description:
      'Follows every cursor of a paged list operation (listResources, listTemplates, listEvents, listAssets, listProjects) as a job and returns { jobId, handle } at once. Wait with bridge_job_status (wait_seconds), then read the items with bridge_result_page. Inside the repository prefer search, browse_repository_tree or list_assets. Cost: 1 read per page of 100.',
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
          const paged = operations.filter((o) => o.paged && o.kind === 'read').map((o) => o.operationId);
          return errorResult(
            op
              ? {
                  code: 'NOT_PAGED',
                  message: `${op.operationId} is not a paged read operation, so it cannot be paginated. (No budget was spent.)`,
                  pagedOperations: paged,
                }
              : unknownOperationBody(operationId, ctx.showLowLevelTools === true, { pagedOperations: paged }),
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
              hint: 'Wait with bridge_job_status({ jobId, wait_seconds: 20 }), then bridge_result_page({ handle }).',
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
      ...canonicalBody(r, 'The work needs the owner’s approval and was not started.'),
    };
  }
  return {
    jobId: r.jobId,
    status: r.status,
    eta: r.eta === null ? null : new Date(r.eta).toISOString(),
    steps,
    ...(r.lastMajorRevision ? { lastMajorRevision: r.lastMajorRevision } : {}),
    hint: 'Do not submit it again. Follow it with bridge_job_status({ jobId, wait_seconds: 20 }).',
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

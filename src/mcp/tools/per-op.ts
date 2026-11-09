/**
 * Optional per-operation tools `lk_op_<operationId>` for all 89 operations, registered only when
 * MCP_EXPOSE_PER_OP_TOOLS=true (PLAN §7). Each takes the operation's own input schema, plus `detail` (and, where it
 * applies, `allowUnsupportedLoss` / `confirm`), and runs through exactly the same path as lk_api_read / lk_api_write.
 */
import * as z from 'zod';
import { operationInputSchema, operations, type OperationDef } from '../../lk/index.js';
import type { McpToolAnnotations, McpToolProvider } from '../server.js';
import { defineTool } from './define.js';
import { executeOne } from './lk-api.js';
import { rateCostText } from './schemas.js';
import { projectArg, withProject, type ToolDeps } from './shape.js';

const IDEMPOTENT_POSTS = new Set([
  'moveResource',
  'restoreResource',
  'restoreDocument',
  'assignBlockIds',
  'deleteBoardShapes',
]);

/** Annotations derived from the operation's kind, risk and method. */
export function annotationsFor(op: OperationDef): McpToolAnnotations {
  if (op.kind === 'read') {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  }
  return {
    readOnlyHint: false,
    destructiveHint: op.risk !== 'safe',
    idempotentHint: op.method === 'PUT' || op.method === 'DELETE' || IDEMPOTENT_POSTS.has(op.operationId),
    openWorldHint: false,
  };
}

const PARAM_KEYS = ['path', 'query', 'ifMatch', 'body'] as const;

export function perOpTools(deps: ToolDeps): McpToolProvider[] {
  return operations.map((op) => {
    const base = operationInputSchema(op.operationId) as z.ZodObject;
    const isWrite = op.kind !== 'read';
    const extra: z.ZodRawShape = {
      detail: z.enum(['summary', 'full']).optional().describe('summary (default) or full payload.'),
      project: projectArg,
      ...(isWrite
        ? {
            allowUnsupportedLoss: z.boolean().optional(),
            confirm: z.literal('cascade').optional(),
          }
        : {}),
    };
    const name = `lk_op_${op.operationId}`;
    return defineTool({
      name,
      title: op.summary,
      access: isWrite ? 'write' : 'read',
      description:
        `${op.summary} (${op.tag}; ${op.method} ${op.pathTemplate.replace('/projects/{projectId}', '')}). ` +
        `${rateCostText(op)} Risk: ${op.risk}.` +
        (op.versioned ? ' Versioned: pass the version you read as ifMatch.' : '') +
        (isWrite
          ? ' If the result is waiting_budget, queued or proposal_captured, never retry the write: follow it with bridge_job_status.'
          : ''),
      inputSchema: base.extend(extra),
      annotations: annotationsFor(op),
      handler: (input: Record<string, unknown>, ctx) => {
        const params: Record<string, unknown> = {};
        for (const k of PARAM_KEYS) if (input[k] !== undefined) params[k] = input[k];
        const project = typeof input.project === 'string' ? input.project : undefined;
        return withProject(deps, project, isWrite ? 'write' : 'read', (pd) =>
          executeOne(
            pd,
            name,
            'any',
            {
              operationId: op.operationId,
              params,
              detail: input.detail === 'full' ? 'full' : 'summary',
              allowUnsupportedLoss: input.allowUnsupportedLoss === true,
              confirm: input.confirm === 'cascade' ? 'cascade' : undefined,
            },
            ctx,
          ),
        );
      },
    });
  });
}

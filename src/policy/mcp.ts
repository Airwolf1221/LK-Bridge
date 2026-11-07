/**
 * The policy layer at `/mcp`: the request's principal (from the server-issued token only), per-principal tool lists,
 * and the two agent-facing proposal tools. Both are read tools restricted to the caller's own proposals; nothing here
 * can change a scope, a token or a proposal's decision (those are owner commands, commands.ts).
 */
import * as z from 'zod';
import type { CallerIdentity } from '../auth/bearer.js';
import { PolicyDeniedError } from '../jobs/errors.js';
import type { JobOrigin } from '../jobs/types.js';
import type { McpAccessControl, McpToolContext, McpToolProvider, McpToolResult } from '../mcp/server.js';
import type { LivePolicyGate } from './gate.js';
import type { ProposalService } from './proposals.js';
import { PROPOSAL_STATES } from './types.js';

/** Resolves a caller to its principal and live scope through the gate's (≤ 1 s) cache. */
export function createMcpAccessControl(gate: LivePolicyGate): McpAccessControl {
  return {
    resolve(caller: CallerIdentity | undefined) {
      const id = caller?.principalId;
      if (!id) return undefined;
      const r = gate.resolve(id);
      if (!r?.active) return undefined;
      return { principal: r.principal, scope: r.scope };
    },
  };
}

/**
 * The engine origin for an MCP tool call. Use it in every tool that calls the job engine: it carries the request's
 * principal and never `approvedBy` or an approval (the gate refuses those from agents). Throws when the request has
 * no principal, so a tool can never fall back to the `system` principal.
 */
export function mcpOrigin(ctx: McpToolContext, tool: string): JobOrigin {
  if (!ctx.principal) {
    throw new PolicyDeniedError(
      tool,
      'the connection is not known to the bridge, so it cannot act',
      'unknown',
    );
  }
  return {
    kind: 'mcp',
    ...(ctx.caller?.clientId ? { client: ctx.caller.clientId } : {}),
    tool,
    principal: ctx.principal,
  };
}

const text = (body: unknown, isError = false): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

const NO_PRINCIPAL = { error: 'This connection is not known to the bridge.' };

export function proposalTools(proposals: ProposalService): McpToolProvider[] {
  const status: McpToolProvider<z.ZodObject<{ proposalId: z.ZodString }>> = {
    name: 'bridge_proposal_status',
    title: 'Proposal status',
    description:
      'Shows the state of one of YOUR proposals (writes held for the bridge owner to approve): pending, approved, ' +
      'executing, executed, rejected (with the owner’s reason), conflicted, expired or failed, and the job id once ' +
      'it runs. Only the owner can approve or reject, in the LK-Bridge dashboard. ' +
      'Costs no LegendKeeper rate budget. Risk: none (read-only).',
    inputSchema: z.object({ proposalId: z.string().min(1).max(64) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    access: 'read',
    handler: ({ proposalId }, ctx) => {
      if (!ctx.principal) return text(NO_PRINCIPAL, true);
      const p = proposals.get(proposalId);
      // Someone else's proposal looks exactly like one that does not exist.
      if (!p || p.principalId !== ctx.principal.principalId) {
        return text({ error: `No proposal ${proposalId} for this connection.` }, true);
      }
      return text(proposals.agentView(p));
    },
  };

  const mine: McpToolProvider<
    z.ZodObject<{
      state: z.ZodOptional<z.ZodEnum<{ [K in (typeof PROPOSAL_STATES)[number]]: K }>>;
      limit: z.ZodOptional<z.ZodNumber>;
    }>
  > = {
    name: 'bridge_proposals_mine',
    title: 'My proposals',
    description:
      'Lists YOUR proposals, newest first (optionally only one state). Other connections’ proposals are never ' +
      'shown. Costs no LegendKeeper rate budget. Risk: none (read-only).',
    inputSchema: z.object({
      state: z.enum(PROPOSAL_STATES).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    access: 'read',
    handler: ({ state, limit }, ctx) => {
      if (!ctx.principal) return text(NO_PRINCIPAL, true);
      const list = proposals.list({
        principalId: ctx.principal.principalId,
        ...(state ? { state } : {}),
        limit: limit ?? 20,
      });
      return text({ proposals: list.map((p) => proposals.agentView(p)) });
    },
  };
  return [status, mine];
}

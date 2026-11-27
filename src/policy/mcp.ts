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
import type { ProjectSelector, SelectedProject } from '../projects/selection.js';
import { renamedTool } from '../mcp/tools/define.js';
import type { LivePolicyGate } from './gate.js';
import type { ProposalService } from './proposals.js';
import { PROPOSAL_STATES } from './types.js';
import { currentWorkstream } from '../workstreams/context.js';

/** Resolves a caller to its principal and live scope through the gate's (≤ 1 s) cache. */
export function createMcpAccessControl(gate: LivePolicyGate): McpAccessControl {
  return {
    resolve(caller: CallerIdentity | undefined) {
      const id = caller?.principalId;
      if (!id) return undefined;
      const r = gate.resolve(id);
      if (!r?.active) return undefined;
      return { principal: r.principal, scope: r.scope, showLowLevelTools: r.showLowLevelTools };
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
  const ws = currentWorkstream();
  return {
    kind: 'mcp',
    ...(ctx.caller?.clientId ? { client: ctx.caller.clientId } : {}),
    tool,
    principal: ctx.principal,
    // v3 F5c (ADR 0069, H8): the call's workstream label (its argument, else the connection's default).
    ...(ws !== null ? { workstream: ws } : {}),
  };
}

const NO_PRINCIPAL = { error: 'This connection is not known to the bridge.' };

export interface ProposalToolsOptions {
  /**
   * Resolves the `project` argument (v2 A1): proposals belong to a project, and these tools show the asked project's
   * only (default: the default project). Without a selector (no projects configured) they refuse.
   */
  readonly selector?: ProjectSelector;
  /**
   * The budget line of a project, naming it (the runtime passes the project's governor footer). A refused `project`
   * gets the default project's line (where a read would go), whose id may not be known yet.
   */
  readonly footer?: (project: { readonly id: string | null; readonly name: string }) => string;
}

const projectArg = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe('The LegendKeeper project (name or id); default: the default project. See list_projects.');

/**
 * The two agent-facing proposal tools. Results follow the tool layer's shape (src/mcp/tools/shape.ts): compact JSON
 * naming the project, then the project's budget footer on its own last line when `footer` is given.
 */
export function proposalTools(proposals: ProposalService, o: ProposalToolsOptions = {}): McpToolProvider[] {
  const text = (body: unknown, project: SelectedProject | null, isError = false): McpToolResult => {
    const named =
      project && body !== null && typeof body === 'object' ? { project: project.name, ...body } : body;
    // Every result ends with a budget line, like every other tool's: a refused `project` shows the default project's.
    const fallback = !project && o.selector ? o.selector.projects.defaultProject() : null;
    const footerOf = project ?? fallback;
    const footer = footerOf && o.footer ? `\n${o.footer(footerOf)}` : '';
    return {
      content: [{ type: 'text', text: `${JSON.stringify(named)}${footer}` }],
      ...(isError ? { isError: true } : {}),
    };
  };
  /** Both tools are reads: the default project applies when none is named. */
  const pick = (asked: string | undefined): SelectedProject | McpToolResult => {
    if (!o.selector)
      return text({ error: 'No LegendKeeper project is configured on this bridge.' }, null, true);
    const sel = o.selector.select(asked, 'read');
    if (!sel.ok) {
      const hint =
        sel.error.code === 'PROJECT_REQUIRED'
          ? 'Pass project with one of the names in registered (list_projects shows them all).'
          : 'Call list_projects to see the projects this bridge serves.';
      return text({ error: { ...sel.error, hint } }, null, true);
    }
    return sel.project;
  };
  const isResult = (v: SelectedProject | McpToolResult): v is McpToolResult => 'content' in v;

  // v2 E3b (ADR 0045, P2): `bridge_proposals_mine` is merged in. With a proposalId one proposal is shown; without it,
  // the caller's own proposals are listed (newest first, optionally one state).
  const status: McpToolProvider<
    z.ZodObject<{
      proposalId: z.ZodOptional<z.ZodString>;
      state: z.ZodOptional<z.ZodEnum<{ [K in (typeof PROPOSAL_STATES)[number]]: K }>>;
      limit: z.ZodOptional<z.ZodNumber>;
      project: z.ZodOptional<z.ZodString>;
    }>
  > = {
    name: 'bridge_proposal_status',
    title: 'Proposal status',
    description:
      'Shows the state of one of YOUR proposals (writes held for the owner). Proposals come from a connection at scope propose (every write becomes one) or from the owner’s automation; at scope write your writes run directly. States: pending, approved, executing, executed, rejected (with the reason), conflicted, expired or failed, and the job id once it runs. Pass `proposalId`; without it, lists your proposals in the project, newest first (optionally only one `state`, at most `limit`). Pass the project the write was for. Use it after proposal_captured instead of repeating the write; only the owner can approve or reject, on the dashboard. A conflicted proposal means the page changed: read it again and propose afresh. Cost: none.',
    inputSchema: z.object({
      proposalId: z.string().min(1).max(64).optional().describe('One proposal. Leave out to list yours.'),
      state: z.enum(PROPOSAL_STATES).optional().describe('When listing: only proposals in this state.'),
      limit: z.number().int().min(1).max(50).optional().describe('When listing: default 20.'),
      project: projectArg,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    access: 'read',
    handler: ({ proposalId, state, limit, project: asked }, ctx) => {
      if (!ctx.principal) return text(NO_PRINCIPAL, null, true);
      const project = pick(asked);
      if (isResult(project)) return project;
      if (proposalId === undefined) {
        const list = proposals.list({
          project: project.id,
          principalId: ctx.principal.principalId,
          ...(state ? { state } : {}),
          limit: limit ?? 20,
        });
        return text({ proposals: list.map((p) => proposals.agentView(p)) }, project);
      }
      const p = proposals.get(proposalId);
      // Someone else's proposal, or one in another project, looks exactly like one that does not exist.
      if (!p || p.principalId !== ctx.principal.principalId || p.projectId !== project.id) {
        return text(
          { error: `No proposal ${proposalId} for this connection in project "${project.name}".` },
          project,
          true,
        );
      }
      return text(proposals.agentView(p), project);
    },
  };

  /** The old name, kept one release (ADR 0045, P2). */
  const mine = renamedTool(
    'bridge_proposals_mine',
    'bridge_proposal_status',
    'leave `proposalId` out to list your proposals (`state` and `limit` work as before).',
  );
  return [status, mine];
}

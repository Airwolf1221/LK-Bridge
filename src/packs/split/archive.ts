/**
 * v3 F3e (ADR 0059, decision D2): phase 2 of a split, proposed BY THE BRIDGE once phase 1 has verified: the source
 * archived through archive_page's own plan (src/mcp/tools/lifecycle.ts `archiveProposalPlan`: its note, facts, tags and
 * move; the AU and lead rules as the tool applies them), as ONE canonical proposal for the owner. The split never
 * deletes the source; deleting it later is a separate decision of the owner's.
 *
 * Approving a split that retires its source is the owner's request for this proposal, so it is made as the owner's
 * forced proposal (ADR 0042): the dashboard's origin with the system principal. The canonical guard makes it a canonical
 * proposal (it refuses the bridge any protected change of its own), so nothing is archived until the owner approves it.
 * The plan's reads go the same way: no MCP connection made them.
 *
 * v3 F12 (ADR 0081): no second approval. A split an agent at scope `write` made directly retires its source as that
 * agent (`because.as`, phase 1's origin): the gate asks its scope now (a proposal at `propose`), the guards let its
 * lifecycle change through as direct, and it is on the owner's Review page with Revert. A split the owner approved
 * retires its source at once too, as the owner's confirmed action (the approval asked for it: `retire`).
 */
import { SYSTEM_PRINCIPAL, type JobOrigin } from '../../jobs/types.js';
import type { McpToolContext } from '../../mcp/server.js';
import { archiveProposalPlan } from '../../mcp/tools/lifecycle.js';
import type { ProjectDeps, ToolDeps } from '../../mcp/tools/shape.js';
import type { Archiver } from './service.js';

/** A logger that says nothing (the bridge's own proposal has no request to log against). */
const SILENT_LOG = {
  level: 'silent',
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  silent: () => undefined,
  child: () => SILENT_LOG,
} as unknown as McpToolContext['log'];

/** The bridge's archive proposal for a split's source (the `Archiver` the split service calls). */
export function bridgeArchiver(deps: ToolDeps): Archiver {
  return async (projectId, pageId, because) => {
    const sel = deps.selector.select(projectId, 'write');
    if (!sel.ok) return { ok: false, code: sel.error.code, message: sel.error.message };
    const asAgent = because.as;
    const origin: JobOrigin = asAgent
      ? {
          kind: asAgent.kind,
          ...(asAgent.client !== undefined ? { client: asAgent.client } : {}),
          tool: 'archive_page',
          detail: because.detail,
          ...(asAgent.principal ? { principal: asAgent.principal } : {}),
          ...(asAgent.workstream !== undefined ? { workstream: asAgent.workstream } : {}),
        }
      : {
          kind: 'ui',
          client: 'dashboard',
          tool: 'archive_page',
          detail: because.detail,
          principal: SYSTEM_PRINCIPAL,
          ownerConfirmed: true,
        };
    const engine = new Proxy(deps.engine, {
      get(t, k) {
        const v = Reflect.get(t, k) as unknown;
        if (k === 'run') return (...a: Parameters<typeof t.run>) => t.run(a[0], a[1], { ...a[2], origin });
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    const pd: ProjectDeps = { ...deps, engine, project: sel.project };
    const mctx: McpToolContext = {
      caller: undefined,
      signal: new AbortController().signal,
      log: SILENT_LOG,
      principal: SYSTEM_PRINCIPAL,
      scope: 'write',
    };
    const p = await archiveProposalPlan(pd, mctx, pageId);
    if (!p.ok) return p;
    const b = p.value;
    const summary = `archive_page: ${b.pageName} → ${b.newName} (${because.summary})`;
    const r = await pd.engine.submit({
      kind: 'batch_ops',
      project: sel.project.id,
      steps: b.steps,
      onError: 'stop',
      priority: 'P1',
      origin,
      title: summary.slice(0, 300),
      holdLock: b.hold,
      ...(b.holdDocument ? { holdDocument: b.holdDocument } : {}),
      ...(b.holdAlso ? { holdAlso: b.holdAlso } : {}),
      lifecycle: b.marker,
      internal: true,
      proposal: {
        operations: [b.operation],
        summary,
        prefetched: [{ op: 'getResource', path: { resourceId: b.pageId }, body: b.raw }],
      },
    });
    if ('proposalId' in r && typeof r.proposalId === 'string')
      return { ok: true, proposalId: r.proposalId, summary };
    if ('jobId' in r && typeof r.jobId === 'string') return { ok: true, jobId: r.jobId, summary };
    return { ok: false, code: 'NOT_PROPOSED', message: 'The archive was not captured as a proposal.' };
  };
}

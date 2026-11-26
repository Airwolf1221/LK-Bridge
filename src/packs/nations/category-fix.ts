/**
 * v3 F6c (ADR 0080, C4): the audit's `territory_category` fix (`territory_category_missing`): the missing
 * `[NAV] <Territory> <Category>` made by create_index's OWN role form (src/mcp/tools/resources.ts `planCreateIndex` with
 * `roleFor: { territory, category }`), so the name, the place, the "[NAV] AI Navigation" template, T11's order and tags
 * and the role binding after the job live in one place.
 *
 * The plan's writes go through the given engine as ONE forced proposal (the dashboard's, or the Automation principal's);
 * with `direct` (the automation's Apply, only when the owner switched the code to it) the job is submitted without being
 * forced, and every guard judges it. A territory renamed since the finding (its name no longer the one the finding
 * expected), or a role bound meanwhile, is FIX_STALE: nothing is proposed.
 */
import { AuditError } from '../../audits/errors.js';
import type { FixResult, TerritoryCategoryCreator } from '../../audits/fixes.js';
import { SYSTEM_PRINCIPAL } from '../../jobs/types.js';
import type { McpToolContext } from '../../mcp/server.js';
import { repoContext } from '../../mcp/tools/repo.js';
import { planCreateIndex } from '../../mcp/tools/resources.js';
import type { ProjectDeps, ToolDeps } from '../../mcp/tools/shape.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

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

const STALE = new Set([
  'NAME_NOT_GOVERNED',
  'ROLE_BOUND',
  'UNKNOWN_ENTRY',
  'INDEX_EXISTS',
  'CATEGORY_PARENT_UNBOUND',
]);

export function bridgeTerritoryCategoryCreator(deps: ToolDeps): TerritoryCategoryCreator {
  return async (projectId, c, o) => {
    const sel = deps.selector.select(projectId, 'write');
    if (!sel.ok) throw new AuditError(sel.error.code, sel.error.message);
    const origin = o.origin;
    const real = deps.engine;
    const engine = new Proxy(real, {
      get(t, k) {
        if (k === 'submit')
          return (req: Obj) =>
            o.engine.submit({
              ...req,
              origin,
              // v3 F12 (ADR 0081): the owner's confirmed "Apply fix" (its origin) runs at once, as the automation's Apply does.
              ...(o.direct === true || origin.ownerConfirmed === true ? {} : { forceProposal: true }),
            });
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
    const rc = repoContext(pd);
    if (!rc.ok)
      throw new AuditError('FIX_UNAVAILABLE', 'The repository tree is not usable now; nothing was proposed.');
    const out = await planCreateIndex(pd, mctx, rc.ctx, {
      name: c.name,
      roleFor: { territory: c.territoryId, category: c.category },
    });
    if (out.kind === 'answer') {
      const text = out.result.content.find((x) => x.type === 'text')?.text ?? '';
      let body: Obj = {};
      try {
        body = JSON.parse(text.split('\n')[0] ?? '{}') as Obj;
      } catch {
        // not JSON: handled below
      }
      const err = isObj(body.error) ? body.error : {};
      const code = typeof err.code === 'string' ? err.code : 'FIX_REFUSED';
      const message =
        typeof err.message === 'string' ? err.message : 'The category index could not be planned now.';
      if (STALE.has(code))
        throw new AuditError(
          'FIX_STALE',
          `${message} The finding is out of date; nothing was proposed. Re-check it (or wait for the next audit).`,
          { refused: code },
        );
      throw new AuditError(code, message, err);
    }
    const summary = `Create [NAV] ${c.name}, and bind it as its ${c.category}`;
    if (typeof out.proposalId === 'string')
      return { status: 'proposal_captured', proposalId: out.proposalId, summary, fix: 'territory_category' };
    if (typeof out.jobId === 'string')
      return {
        status: 'job_submitted',
        jobId: out.jobId,
        summary,
        fix: 'territory_category',
      } satisfies FixResult;
    throw new AuditError(
      'NOT_PROPOSED',
      'The category index was not captured as a proposal; nothing was done.',
    );
  };
}

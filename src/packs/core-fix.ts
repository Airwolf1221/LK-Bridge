/**
 * v3 F7.1 (ADR 0072): the audit's `core_upgrade` fix (`character_core_missing`): a Compact Character Reference at the
 * head of a multi-owner index upgraded to its Character Core by the character tool's OWN planner
 * (`arkona_create_character` with `target` and `upgradeToCore`, src/packs/engine/plan.ts): the same rename, Reference
 * Type, template record, wording and images as every package that needs a Core, so the rule lives in one place.
 *
 * The page is read live first: a page renamed since the audit (upgraded meanwhile, say) is FIX_STALE and nothing is
 * proposed. The plan's writes go through the given engine as ONE forced proposal (the dashboard's, or the Automation
 * principal's); with `direct` (the automation's Apply, only when the owner switched the code to it) the job is submitted
 * without being forced, and every guard judges it: the canon guard keeps an Authoritative page's rename a canonical
 * proposal. Nothing here bypasses a guard.
 */
import { AuditError } from '../audits/errors.js';
import type { CoreUpgrader, FixResult } from '../audits/fixes.js';
import { SYSTEM_PRINCIPAL } from '../jobs/types.js';
import type { McpToolContext } from '../mcp/server.js';
import { liveRead } from '../mcp/tools/repo.js';
import type { ProjectDeps, ToolDeps } from '../mcp/tools/shape.js';
import { runPackage } from './run.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const TOOL = 'arkona_create_character';

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

export function bridgeCoreUpgrader(deps: ToolDeps): CoreUpgrader {
  return async (projectId, page, o) => {
    const sel = deps.selector.select(projectId, 'write');
    if (!sel.ok) throw new AuditError(sel.error.code, sel.error.message);
    const origin = o.origin;
    const real = deps.engine;
    const engine = new Proxy(real, {
      get(t, k) {
        if (k === 'submit')
          return (req: Obj) =>
            o.engine.submit({ ...req, origin, ...(o.direct === true ? {} : { forceProposal: true }) });
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
    // The page as it is now: still the Compact Character Reference the audit saw.
    const live = await liveRead(pd, mctx, TOOL, 'getResource', { path: { resourceId: page.pageId } });
    if (!live.ok || !isObj(live.value))
      throw new AuditError(
        'FIX_STALE',
        `${page.name} could not be read now (gone, or not readable). Nothing was proposed.`,
      );
    if (live.value.name !== page.name)
      throw new AuditError(
        'FIX_STALE',
        `${page.name} is named “${String(live.value.name)}” now. The finding is out of date; nothing was proposed. Re-check it (or wait for the next audit).`,
        { found: live.value.name },
      );
    const res = await runPackage(pd, mctx, {
      packId: 'arkona',
      type: 'Character',
      tool: TOOL,
      input: { name: page.name, identity: {}, pages: [], target: page.pageId, upgradeToCore: true },
      dryRun: false,
      args: { target: page.pageId, upgradeToCore: true, fromAudit: 'character_core_missing' },
    });
    const text = res.content.find((c) => c.type === 'text')?.text ?? '';
    let body: Obj = {};
    try {
      body = JSON.parse(text.split('\n')[0] ?? '{}') as Obj;
    } catch {
      // not JSON: handled below
    }
    if (res.isError === true || isObj(body.error)) {
      const err = isObj(body.error) ? body.error : {};
      throw new AuditError(
        typeof err.code === 'string' ? err.code : 'FIX_REFUSED',
        typeof err.message === 'string' ? err.message : 'The upgrade could not be planned now.',
        isObj(err) ? err : {},
      );
    }
    const summary = typeof body.summary === 'string' ? body.summary : null;
    if (typeof body.proposalId === 'string')
      return { status: 'proposal_captured', proposalId: body.proposalId, summary, fix: 'core_upgrade' };
    if (typeof body.jobId === 'string')
      return { status: 'job_submitted', jobId: body.jobId, summary, fix: 'core_upgrade' } satisfies FixResult;
    throw new AuditError('NOT_PROPOSED', 'The upgrade was not captured as a proposal; nothing was done.');
  };
}

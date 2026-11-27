/**
 * v3 F6d (ADR 0082, N4): the audit's `templated_name` fix (`name_nontemplated`): a source renamed to
 * `<Subject> - <Role>` through the rename engine (src/packs/rename/plan.ts, `arkona_rename`'s path, in its PAGE mode),
 * never through update_resource alone. Mentions show the new name by themselves, routing lines naming the old name
 * follow, the journal records the rename (its id on every write); the id, the prefix, the tags and the links stay. Every
 * other occurrence of the old name (another page's prose or sidebar, a custom mention label) is listed for review, as
 * arkona_rename lists it, and never edited.
 *
 * The page is read live first: its name, Subject or Reference Type changed since the finding is FIX_STALE and nothing is
 * planned. The plan goes through the given engine: ONE forced proposal (the dashboard's "Propose", or the automation
 * gathering its run's ONE proposal), a job at once for the owner's confirmed "Apply fix", or, with `direct` (the
 * automation's Apply, only when the owner switched the code to it), a job submitted without being forced, every guard
 * judging it: a direct job, an Authoritative page's rename included (the owner's ruling of the F6d follow-up amends ADR 0057
 * decision 5: the Apply setting is the approval); a guard's refusal still refuses.
 * Nothing here bypasses a guard.
 */
import { AuditError } from '../../audits/errors.js';
import type { FixResult, TemplatedRenamer } from '../../audits/fixes.js';
import { sidebarFrom } from '../../facts/sidebar.js';
import { SYSTEM_PRINCIPAL } from '../../jobs/types.js';
import type { McpToolContext } from '../../mcp/server.js';
import { liveRead } from '../../mcp/tools/repo.js';
import type { ProjectDeps, ToolDeps } from '../../mcp/tools/shape.js';
import { classifyName } from '../../tree/classify.js';
import { textKey } from '../engine/text.js';
import { planRename, RENAME_TOOL } from '../rename/plan.js';
import { packBasis } from '../run.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const TEMPLATED_RENAME_TOOL = 'audits.templated_name';

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

const runsText = (content: unknown): string =>
  Array.isArray(content)
    ? (content as Obj[])
        .map((r) =>
          typeof r.text === 'string'
            ? r.text
            : isObj(r.mention) && typeof r.mention.text === 'string'
              ? r.mention.text
              : isObj(r.mention) && typeof r.mention.name === 'string'
                ? r.mention.name
                : '',
        )
        .join('')
    : '';

/** What `liveFact` answers for a row the sidebar holds more than once. */
const TWICE = '\u0000twice';

/** A fact of the page's PROPERTIES as it reads live (null: no row or empty; TWICE: more than one row). */
function liveFact(properties: unknown, propertiesName: string, key: string): string | null {
  const sb = sidebarFrom({ data: Array.isArray(properties) ? properties : [] });
  const kv = sb.find((p) => p.kind === 'keyValue' && textKey(p.title) === textKey(propertiesName));
  const rows = (kv?.rows ?? []).filter((r) => textKey(r.key) === textKey(key));
  if (rows.length > 1) return TWICE;
  const t = rows[0] ? runsText(rows[0].content).trim() : '';
  return t === '' ? null : t;
}

export function bridgeTemplatedRenamer(deps: ToolDeps, packId = 'arkona'): TemplatedRenamer {
  return async (projectId, a, o): Promise<FixResult> => {
    const sel = deps.selector.select(projectId, 'write');
    if (!sel.ok) throw new AuditError(sel.error.code, sel.error.message);
    const origin = o.origin;
    const forced = o.direct !== true && o.ownerConfirmed !== true;
    // As core-fix.ts: the plan's live reads run with the fix's origin (the dashboard's, or the Automation principal's).
    const real = deps.engine;
    const engine = new Proxy(real, {
      get(t, k) {
        const v = Reflect.get(t, k) as unknown;
        if (k === 'run') return (...x: Parameters<typeof t.run>) => t.run(x[0], x[1], { ...x[2], origin });
        return typeof v === 'function' ? (v as (...y: unknown[]) => unknown).bind(t) : v;
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
    // N4: the page as it is now: its name, Subject and Reference Type still those the finding saw.
    const live = await liveRead(pd, mctx, RENAME_TOOL, 'getResource', { path: { resourceId: a.pageId } });
    if (!live.ok || !isObj(live.value))
      throw new AuditError(
        'FIX_STALE',
        `${a.name} could not be read now (gone, or not readable). Nothing was proposed.`,
      );
    const res = live.value;
    const stale = (what: string, extra: Obj = {}) =>
      new AuditError(
        'FIX_STALE',
        `${what} The finding is out of date; nothing was proposed. Re-check it (or wait for the next audit).`,
        extra,
      );
    if (res.name !== a.name)
      throw stale(`${a.name} is named “${String(res.name)}” now.`, { found: res.name });
    const settings = pd.services?.projectSettings?.(projectId) as { treePropertiesName?: string } | undefined;
    const propertiesName = settings?.treePropertiesName ?? 'PROPERTIES';
    const subject = liveFact(res.properties, propertiesName, a.subjectRow);
    if (subject !== a.subject)
      throw stale(
        `${a.name}’s Subject is ${subject === null ? 'empty' : subject === TWICE ? 'in the sidebar twice' : `“${subject}”`} now, not “${a.subject}”.`,
        {
          subject,
        },
      );
    const referenceType = liveFact(res.properties, propertiesName, a.referenceTypeRow);
    if (referenceType !== a.referenceType)
      throw stale(
        `${a.name}’s Reference Type is ${referenceType === null ? 'empty' : referenceType === TWICE ? 'in the sidebar twice' : `“${referenceType}”`} now, not “${a.referenceType}”.`,
        { referenceType },
      );
    const b = await packBasis(pd, mctx, packId, RENAME_TOOL);
    if (!b.ok)
      throw new AuditError(
        'FIX_UNAVAILABLE',
        'The rename engine’s pack is not available here. Nothing was proposed.',
      );
    const basis = b.value;
    if (basis.governance.state !== 'current')
      throw new AuditError(
        'PACK_NOT_CURRENT',
        `${basis.governance.message} A rename follows the pack's approved rules, so nothing can be planned now.`,
      );
    const appraisal = pd.services?.appraisal;
    if (!appraisal)
      throw new AuditError(
        'FIX_UNAVAILABLE',
        'A rename finds the old name through the full-text index, which is not available here. Nothing was proposed.',
      );
    const to = classifyName(a.to).displayName;
    const r = await planRename(
      { pd, mctx, basis, appraisal },
      { subject: a.pageId, newName: to, page: true, keepOldAsAlias: false, lastMajorRevision: 'skip' },
    );
    if (!r.ok) {
      const text = r.result.content.find((c) => c.type === 'text')?.text ?? '';
      let err: Obj = {};
      try {
        const body = JSON.parse(text.split('\n')[0] ?? '{}') as Obj;
        err = isObj(body.error) ? body.error : body;
      } catch {
        // not JSON
      }
      throw new AuditError(
        typeof err.code === 'string' ? err.code : 'FIX_REFUSED',
        typeof err.message === 'string' ? err.message : 'The rename could not be planned now.',
      );
    }
    const plan = r.plan;
    if (plan.refusals.length > 0) {
      const first = plan.refusals[0]!;
      throw new AuditError(first.code, first.message, { refusals: plan.refusals });
    }
    const authoritative = classifyName(a.name).kind === 'bsrc';
    const reviewOnly = plan.review.count > 0 ? plan.review : null;
    const operation = {
      tool: TEMPLATED_RENAME_TOOL,
      engine: RENAME_TOOL,
      fromAudit: 'name_nontemplated',
      pack: basis.pack.id,
      rename: plan.renameId,
      page: { id: a.pageId, name: a.name },
      oldName: plan.oldName,
      newName: plan.newName,
      subject: a.subject,
      referenceType: a.referenceType,
      changes: { name: { before: a.name, after: a.to } },
      ...(reviewOnly ? { reviewOnly } : {}),
      ...(plan.notPlanned.length ? { notPlanned: plan.notPlanned.slice(0, 50) } : {}),
    };
    const title = `Rename ${a.name} → ${a.to} (the template <Subject> - <Role>)`;
    const items = plan.items.map((i) => ({
      ...i,
      label: `${a.name} → ${a.to}`,
      group: 'Templated names',
      ...(reviewOnly ? { why: undefined } : {}),
    }));
    const submitted = await o.engine.submit({
      kind: 'batch_ops',
      project: projectId,
      steps: plan.steps,
      onError: 'stop',
      priority: 'P1',
      origin,
      title: title.slice(0, 300),
      internal: true,
      ...(forced ? { forceProposal: true } : {}),
      // ADR 0057 decision 5: renaming an Authoritative page is canon (the canon guard judges it in any case); a Working or
      // Archived page's rename is an ordinary edit.
      ...(authoritative
        ? {
            lifecycle: {
              tool: RENAME_TOOL,
              canonical: true,
              reason: `renames ${a.name}, an Authoritative page, to its templated name ${a.to}`,
              pages: [],
            },
          }
        : {}),
      resumable: { kind: 'rename', recheck: [1] },
      lastMajorRevision: 'skip',
      proposal: {
        summary: title,
        items,
        operation,
        operations: [
          {
            ...operation,
            pageParts: [
              `name: ${a.name} → ${a.to}`,
              ...(reviewOnly ? [`${reviewOnly.count} for review only`] : []),
            ],
            summaryLabel: title,
          },
        ],
        prefetched: plan.prefetched,
      },
    });
    const renames = pd.services?.renames;
    const record = (proposalId: string | null, jobId: string | null) =>
      renames?.record({
        id: plan.renameId,
        projectId,
        packId: basis.pack.id,
        subjectId: a.pageId,
        subjectKind: 'page',
        oldName: plan.oldName,
        newName: plan.newName,
        proposalId,
        jobId,
        token: null,
        review: { parts: [], customLabels: plan.review.occurrences },
      });
    if (typeof submitted.proposalId === 'string') {
      // A captured plan (the automation gathering its run's proposal) is recorded by nobody: it is not a proposal yet.
      if (!submitted.proposalId.startsWith('automation:')) record(submitted.proposalId, null);
      return {
        status: 'proposal_captured',
        proposalId: submitted.proposalId,
        summary: typeof submitted.summary === 'string' ? submitted.summary : title,
        fix: 'templated_name',
      };
    }
    if (!forced && typeof submitted.jobId === 'string') {
      record(null, submitted.jobId);
      return { status: 'job_submitted', jobId: submitted.jobId, summary: title, fix: 'templated_name' };
    }
    throw new AuditError('NOT_PROPOSED', 'The rename was neither proposed nor submitted; nothing was done.');
  };
}

/**
 * v3 F6d: the rename engine's record of a templated rename the automation submitted itself (its Apply job, or the run's
 * proposal it is an item of), as `arkona_rename` records its own: the old and new names, and the review list.
 */
export function recordTemplatedRename(
  renames: Pick<NonNullable<NonNullable<ProjectDeps['services']>['renames']>, 'record'> | undefined,
  projectId: string,
  req: Obj,
  ids: { readonly jobId?: string; readonly proposalId?: string },
): void {
  const proposal = isObj(req.proposal) ? req.proposal : null;
  const op = proposal && isObj(proposal.operation) ? proposal.operation : null;
  if (!renames || !op || op.tool !== TEMPLATED_RENAME_TOOL || typeof op.rename !== 'string') return;
  const page = isObj(op.page) ? op.page : {};
  const review =
    isObj(op.reviewOnly) && Array.isArray(op.reviewOnly.occurrences) ? op.reviewOnly.occurrences : [];
  renames.record({
    id: op.rename,
    projectId,
    packId: typeof op.pack === 'string' ? op.pack : 'arkona',
    subjectId: typeof page.id === 'string' ? page.id : '',
    subjectKind: 'page',
    oldName: String(op.oldName),
    newName: String(op.newName),
    proposalId: ids.proposalId ?? null,
    jobId: ids.jobId ?? null,
    token: null,
    review: { parts: [], customLabels: review as never },
  });
}

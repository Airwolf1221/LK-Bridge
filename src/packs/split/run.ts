/**
 * v3 F3e (ADR 0059): `arkona_split_owner`'s run. The pack and project checked (as every pack tool), the plan made
 * (src/packs/split/plan.ts), then a preview (a dry run, or the refusals with everything the plan found) or ONE proposal:
 * always a CANONICAL proposal, whatever the caller's scope (D7: a split creates and changes several owners, often canon,
 * as a rename does). The bulk rail does not apply: it is already a proposal the owner reads item by item.
 *
 * `report` (a split's id, its proposal or its job) answers what became of a split: its phase 1, its verification,
 * and its phase 2 (the archive proposal the bridge made, or why there is none). Free.
 */
import { AppraisalError } from '../../appraisal/types.js';
import type { McpToolContext, McpToolResult } from '../../mcp/server.js';
import { withRequest, type CreateOutcome } from '../../mcp/tools/create-support.js';
import { finish } from '../../mcp/tools/repo.js';
import { errorResult, render, type ProjectDeps } from '../../mcp/tools/shape.js';
import { runWriteJob } from '../../mcp/tools/write-job.js';
import { packBasis } from '../run.js';
import { planSplit, SPLIT_TOOL, type Issue, type SplitInput, type SplitPlan } from './plan.js';
import { SPLIT_CHECKS } from './checks.js';
import { jobVerified } from './service.js';

type Obj = Record<string, unknown>;

export interface RunSplitOptions {
  readonly packId: string;
  readonly input: SplitInput;
  readonly dryRun: boolean;
  readonly operationId?: string | undefined;
  readonly args: Obj;
}

/** The plan as the agent and the owner read it: the map, every destination, the audits, the dependencies, the cost. */
export function splitPreview(plan: SplitPlan): Obj {
  return {
    split: plan.splitId,
    source: plan.source,
    retire: plan.retire,
    phase2: plan.retire
      ? 'once phase 1 verifies, the bridge proposes archiving the source (archive_page): a separate canonical proposal; the split never deletes it'
      : 'none: the source survives, with an interface summary for each section that left it',
    sections: plan.sections,
    destinations: plan.destinations.map((d) => ({
      key: d.key,
      kind: d.kind,
      item: d.item,
      page: d.page,
      new: d.isNew,
      sections: d.sections,
      blocks: d.blocks.length,
      words: d.words,
      ...(d.images ? { images: d.images } : {}),
      ...(d.universal ? { universal: d.universal } : {}),
    })),
    interfaceSummaries: plan.summaries,
    indexEntries: plan.indexEntries,
    completeness: plan.completeness,
    ...(plan.nextSteps.length ? { nextSteps: plan.nextSteps } : {}),
    dependencies: {
      remapped: plan.dependencies.mapped.map((m) => ({ page: m.page, to: m.to, keepSource: m.keepSource })),
      unmapped: plan.dependencies.unmapped,
      ...(plan.dependencies.chronology.length ? { chronologyRows: plan.dependencies.chronology } : {}),
    },
    items: {
      total: plan.items.length,
      list: plan.items.map((i) => ({
        id: i.id,
        group: i.group,
        label: i.label,
        ...(i.dependsOn.length ? { dependsOn: i.dependsOn } : {}),
        ...(i.diff?.context ? { ifLeftOut: i.diff.context } : {}),
      })),
    },
    blockIds: plan.ids,
    ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
    ...(plan.notes.length ? { notes: plan.notes } : {}),
    lastMajorRevision: {
      mode: plan.lmr.mode,
      newPages: plan.lmr.newPages.length
        ? `${plan.lmr.newPages.join(', ')}: dated the day the job runs`
        : 'none',
      measuredWhenItRuns: plan.lmr.measured,
      ...(plan.lmr.switchedOff ? { switchedOff: 'lmrPackTools is off for this project' } : {}),
    },
    cost: {
      planReads: plan.cost.planReads,
      job: {
        reads: plan.cost.jobReads,
        writes: plan.cost.jobWrites,
        note: 'phase 1, with every item approved',
      },
      ...(plan.retire
        ? { phase2: 'archive_page’s own cost (about 6 reads to propose, then about 15 reads and 8 writes)' }
        : {}),
    },
  };
}

function refusal(pd: ProjectDeps, refusals: readonly Issue[], extra: Obj = {}): McpToolResult {
  const first = refusals[0]!;
  const { code, message, ...details } = first;
  return errorResult(
    {
      ...details,
      code,
      message:
        refusals.length === 1
          ? message
          : `${message} (and ${refusals.length - 1} more refusal${refusals.length === 2 ? '' : 's'}: see refusals)`,
      refusals,
      ...extra,
    },
    pd,
  );
}

export async function runSplit(
  pd: ProjectDeps,
  mctx: McpToolContext,
  o: RunSplitOptions,
): Promise<McpToolResult> {
  const b = await packBasis(pd, mctx, o.packId, SPLIT_TOOL);
  if (!b.ok) return b.result;
  const basis = b.value;
  if (basis.governance.state !== 'current')
    return errorResult(
      {
        code: 'PACK_NOT_CURRENT',
        message: `${basis.governance.message} A split makes owners by the pack's approved rules, so nothing can be proposed now.`,
        governance: { state: basis.governance.state, sources: basis.governance.sources },
      },
      pd,
    );
  const appraisal = pd.services?.appraisal;
  if (!appraisal)
    return errorResult(
      {
        code: 'TOOL_UNAVAILABLE',
        message:
          'A split reads the incoming Dependencies through the appraisal (change impact), which is not available here.',
      },
      pd,
    );
  let r: Awaited<ReturnType<typeof planSplit>>;
  try {
    r = await planSplit({ pd, mctx, basis, appraisal }, o.input);
  } catch (e) {
    if (e instanceof AppraisalError)
      return errorResult(
        {
          code: e.code,
          message: `${e.message} A split reads the incoming Dependencies from the snapshots (change impact), so it cannot be planned yet.`,
        },
        pd,
      );
    throw e;
  }
  if (!r.ok) {
    if (r.result) return r.result;
    return refusal(pd, r.refusals ?? [], r.partial ? { preview: r.partial } : {});
  }
  const plan = r.plan;
  const preview = splitPreview(plan);
  if (o.dryRun)
    return finish(
      pd,
      mctx,
      SPLIT_TOOL,
      {
        status: 'dry_run',
        ...preview,
        message:
          'Dry run: nothing was written and nothing was proposed. Bring the map, the warnings and the Anti-Fragmentation note to the owner; call again without dryRun only when the owner wants the split: ONE canonical proposal, approved whole or destination by destination.',
      },
      () => ({ items: plan.items.length, summary: plan.summary }),
    );
  return withRequest(
    pd,
    mctx,
    SPLIT_TOOL,
    { ...o.args, dryRun: false },
    { key: `split:${plan.source.id}`, label: `the split of ${plan.source.name}` },
    async (): Promise<CreateOutcome> => {
      const head: Obj = { pack: basis.pack.id, ...preview };
      const out = await runWriteJob(pd, mctx, SPLIT_TOOL, {
        steps: plan.steps,
        labels: plan.labels,
        title: plan.summary,
        // No job-level locks: the job makes pages (as a package does); each write takes its own page's lock and
        // re-checks inside it (the source edits are exact or the job stops; an append is rebased on a conflict).
        lifecycle: plan.marker,
        forceProposal: true,
        // ADR 0058 (Resume): a split that stops part-way resumes from where it stopped, its first check again first.
        // CR-2026-11-R3 (R3-22): and its destinations check (what left a destination while the job was stopped is never
        // then taken out of the source).
        resumable: { kind: 'split', recheck: [1], recheckCheckers: [SPLIT_CHECKS.destinations] },
        lastMajorRevision: plan.lmr.mode,
        proposal: {
          operations: plan.operations,
          summary: plan.summary,
          items: plan.items,
          operation: {
            tool: SPLIT_TOOL,
            pack: basis.pack.id,
            split: plan.splitId,
            source: plan.source,
            retire: plan.retire,
            destinations: preview.destinations,
            sections: plan.sections,
            interfaceSummaries: plan.summaries,
            indexEntries: plan.indexEntries,
            completeness: plan.completeness,
            ...(plan.nextSteps.length ? { nextSteps: plan.nextSteps } : {}),
            dependencies: preview.dependencies,
            ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
            cost: preview.cost,
          },
          prefetched: plan.prefetched,
        },
        head,
        preview: () => ({ items: plan.items.length, summary: plan.summary }),
      });
      const splits = pd.services?.splits;
      if (splits && (out.proposalId || out.jobId))
        splits.record({
          id: plan.splitId,
          projectId: pd.project.id,
          packId: basis.pack.id,
          sourceId: plan.source.id,
          sourceName: plan.source.name,
          retire: plan.retire,
          proposalId: out.proposalId ?? null,
          jobId: out.jobId ?? null,
          plan: {
            destinations: plan.destinations.map((d) => ({
              key: d.key,
              kind: d.kind,
              item: d.item,
              page: d.page,
              isNew: d.isNew,
              sections: d.sections,
            })),
            items: plan.items.map((i) => i.id),
            newPages: plan.destinations.filter((d) => d.isNew && d.page).map((d) => d.page!),
            unmapped: plan.dependencies.unmapped,
            upgrade: plan.upgrade,
            nextSteps: plan.nextSteps,
          },
        });
      return { kind: 'job', head, labels: plan.labels, ...out };
    },
  );
}

/** `report`: what became of a split (free). */
export function splitReport(pd: ProjectDeps, mctx: McpToolContext, ref: string): McpToolResult {
  const splits = pd.services?.splits;
  if (!splits)
    return errorResult({ code: 'TOOL_UNAVAILABLE', message: 'Splits are not available here.' }, pd);
  const rec = splits.find(pd.project.id, ref.trim());
  if (!rec)
    return errorResult(
      {
        code: 'SPLIT_NOT_FOUND',
        message: `No split ${ref} on ${pd.project.name} (give its id, proposal or job).`,
      },
      pd,
    );
  void mctx;
  // CR-2026-11-R3 (R3-67): whether phase 1 verified is the job's own verification, never the split's.
  const job = rec.jobId ? pd.engine.queries.getJob(pd.project.id, rec.jobId) : null;
  const verified = job && ['succeeded', 'failed', 'cancelled'].includes(job.status) ? jobVerified(job) : null;
  return render(
    {
      split: rec.id,
      state: rec.state,
      verified,
      source: { id: rec.sourceId, name: rec.sourceName },
      retire: rec.retire,
      proposalId: rec.proposalId,
      jobId: rec.jobId,
      destinations: rec.plan.destinations,
      phase2: rec.phase2 ?? (rec.retire ? 'proposed once phase 1 has verified' : 'none: the source survives'),
      ...(rec.plan.nextSteps?.length ? { nextSteps: rec.plan.nextSteps } : {}),
      ...(rec.revert ? { revert: rec.revert } : {}),
    },
    pd,
  );
}

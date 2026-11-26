/**
 * v3 F3d (renames), ADR 0058: `arkona_rename`'s run. The pack and project checked (as every pack tool), the plan made
 * (src/packs/rename/plan.ts), then a preview (a dry run, or the refusals with everything the plan found) or ONE
 * proposal: always a CANONICAL proposal, whatever the caller's scope (ADR 0057 decision 5: renaming a canon page is
 * canon; a rename touches canon wherever the subject is named). It is not subject to the bulk rail (ADR 0055): one
 * subject, one proposal the owner reads item by item, and approves whole or in part.
 *
 * `report` (a rename's id, its proposal or its job) answers what a rename left: free, from the full-text index.
 */
import { AppraisalError } from '../../appraisal/types.js';
import type { McpToolContext, McpToolResult } from '../../mcp/server.js';
import { withRequest, type CreateOutcome } from '../../mcp/tools/create-support.js';
import { finish } from '../../mcp/tools/repo.js';
import { errorResult, render, type ProjectDeps } from '../../mcp/tools/shape.js';
import { runWriteJob } from '../../mcp/tools/write-job.js';
import type { LifecycleMarker } from '../../jobs/types.js';
import { packBasis } from '../run.js';
import {
  GROUPS,
  planRename,
  RENAME_TOOL,
  refusalResult,
  setRenameErrorRenderer,
  type RenameInput,
  type RenamePlan,
} from './plan.js';

type Obj = Record<string, unknown>;

setRenameErrorRenderer((pd, body) => errorResult(body as { code: string; message: string }, pd));

export interface RunRenameOptions {
  readonly packId: string;
  readonly input: RenameInput;
  readonly dryRun: boolean;
  readonly operationId?: string | undefined;
  readonly args: Obj;
}

/** The preview: the items by group (ticked or not, and why), what is left as historical or not planned, the cost. */
export function renamePreview(plan: RenamePlan): Obj {
  const groups: Obj[] = [];
  for (const g of Object.values(GROUPS)) {
    const its = plan.items.filter((i) => i.group === g);
    if (its.length === 0) continue;
    groups.push({
      group: g,
      items: its.map((i) => ({
        id: i.id,
        label: i.label,
        ticked: i.selected,
        ...(i.why ? { why: i.why } : {}),
        ...(i.tags?.length ? { tags: i.tags } : {}),
        ...(i.dependsOn.length ? { dependsOn: i.dependsOn } : {}),
        ...(i.diff ? { diff: i.diff } : {}),
      })),
    });
  }
  return {
    subject: { id: plan.subject.id, name: plan.subject.name, kind: plan.subject.kind },
    oldName: plan.oldName,
    newName: plan.newName,
    ...(plan.followUp ? { followUp: true } : {}),
    items: { total: plan.items.length, ticked: plan.items.filter((i) => i.selected).length },
    groups,
    ...(plan.token ? { token: plan.token } : {}),
    ...(plan.historical.length ? { leftAsHistorical: plan.historical } : {}),
    ...(plan.notPlanned.length ? { notPlanned: plan.notPlanned } : {}),
    ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
    // v3 F4a (ADR 0063): the new name's namesakes (a warning above for an exact full name; never a refusal).
    ...(plan.namesakes?.length ? { namesakes: plan.namesakes } : {}),
    ...(plan.replacements.length ? { replacements: plan.replacements } : {}),
    ...(plan.notes.length ? { notes: plan.notes } : {}),
    // ADR 0058 amendment (B, D): never items, nothing to approve: for the agent to bring to the owner.
    ...(plan.review.count > 0 ? { reviewOnly: plan.review } : {}),
    lastMajorRevision: {
      mode: plan.lmr.mode,
      measuredWhenItRuns: plan.lmr.pages,
      nameOnlyPages: plan.lmr.minor,
      ...(plan.lmr.switchedOff ? { switchedOff: 'lmrPackTools is off for this project' } : {}),
    },
    cost: {
      planReads: plan.cost.planReads,
      job: { reads: plan.cost.jobReads, writes: plan.cost.jobWrites, note: 'with every item approved' },
    },
  };
}

/** Its pages, one operation each, for the proposal's page-level summary. */
function operationsOf(plan: RenamePlan): Obj[] {
  const byPage = new Map<string, { page: { id: string; name: string }; parts: string[] }>();
  const loose: string[] = [];
  for (const i of plan.items) {
    if (!i.page) {
      loose.push(i.label);
      continue;
    }
    const e = byPage.get(i.page.id) ?? { page: i.page, parts: [] as string[] };
    e.parts.push(i.label);
    byPage.set(i.page.id, e);
  }
  const ops: Obj[] = [...byPage.values()].map((e) => ({
    tool: RENAME_TOOL,
    rename: plan.renameId,
    page: e.page,
    pageParts: e.parts.slice(0, 40),
    summaryLabel: `${e.page.name}: ${e.parts.length} change${e.parts.length === 1 ? '' : 's'} (${plan.oldName} → ${plan.newName})`,
  }));
  if (loose.length > 0)
    ops.push({
      tool: RENAME_TOOL,
      rename: plan.renameId,
      pageParts: loose.slice(0, 40),
      summaryLabel: `art, taxonomy and the pack: ${loose.length} change${loose.length === 1 ? '' : 's'}`,
    });
  return ops;
}

export async function runRename(
  pd: ProjectDeps,
  mctx: McpToolContext,
  o: RunRenameOptions,
): Promise<McpToolResult> {
  const b = await packBasis(pd, mctx, o.packId, RENAME_TOOL);
  if (!b.ok) return b.result;
  const basis = b.value;
  if (basis.governance.state !== 'current')
    return errorResult(
      {
        code: 'PACK_NOT_CURRENT',
        message: `${basis.governance.message} A rename computes identity tags and facts by the pack's approved rules, so nothing can be proposed now.`,
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
          'A rename finds every mention of the name through the full-text index, which is not available here.',
      },
      pd,
    );
  let r: Awaited<ReturnType<typeof planRename>>;
  try {
    r = await planRename({ pd, mctx, basis, appraisal }, o.input);
  } catch (e) {
    if (e instanceof AppraisalError)
      return errorResult(
        {
          code: e.code,
          message: `${e.message} A rename finds the name's mentions through the full-text index, so it cannot be planned yet.`,
        },
        pd,
      );
    throw e;
  }
  if (!r.ok) return r.result;
  const plan = r.plan;
  const preview = renamePreview(plan);
  if (plan.refusals.length > 0) return refusalResult(pd, plan.refusals, { preview });
  if (o.dryRun) {
    return finish(
      pd,
      mctx,
      RENAME_TOOL,
      {
        status: 'dry_run',
        ...preview,
        message: `Dry run: nothing was written and nothing was proposed. Call again without dryRun to propose it: ONE canonical proposal for the owner, who approves it whole or item by item.${plan.review.count > 0 ? ` Bring the ${plan.review.count} review-only occurrence${plan.review.count === 1 ? '' : 's'} (reviewOnly: name parts on their own, custom labels) to the owner: the bridge never edits them, and the owner can ask for a follow-up rename (from) of specific ones.` : ''}`,
      },
      () => ({ items: plan.items.length, summary: plan.summary }),
    );
  }
  const marker: LifecycleMarker = {
    tool: RENAME_TOOL,
    canonical: true,
    reason: `renaming ${plan.oldName} to ${plan.newName} changes how canon names it (ADR 0057 decision 5): every rename is a canonical proposal`,
    pages: [],
  };
  return withRequest(
    pd,
    mctx,
    RENAME_TOOL,
    { ...o.args, dryRun: false },
    { key: `rename:${plan.subject.id}`, label: `the rename of ${plan.subject.name}` },
    async (): Promise<CreateOutcome> => {
      const head: Obj = {
        pack: basis.pack.id,
        rename: plan.renameId,
        ...preview,
      };
      const out = await runWriteJob(pd, mctx, RENAME_TOOL, {
        steps: plan.steps,
        labels: plan.labels,
        title: plan.summary,
        // ADR 0058 amendment (A): no job-level locks. Each write takes its own page's (document's, asset's) lock only for
        // itself and re-checks inside it (a conflict is rebased, or its item skipped), so ordinary writes to those pages
        // never wait for the whole rename.
        lifecycle: marker,
        // v3 F12 (ADR 0081): a canon rename the agent at scope `write` makes directly (on the Review page, with Revert); a
        // canonical proposal at scope `propose` (the marker).
        // ADR 0058 (E3): a rename that stops part-way resumes from where it stopped: its check (the subject, every page,
        // block and asset as planned, or already renamed by this rename) first.
        resumable: { kind: 'rename', recheck: [1] },
        lastMajorRevision: plan.lmr.mode,
        proposal: {
          operations: operationsOf(plan),
          summary: plan.summary,
          items: plan.items,
          operation: {
            tool: RENAME_TOOL,
            pack: basis.pack.id,
            rename: plan.renameId,
            subject: { id: plan.subject.id, name: plan.subject.name, kind: plan.subject.kind },
            oldName: plan.oldName,
            newName: plan.newName,
            ...(plan.token ? { token: plan.token } : {}),
            ...(plan.historical.length ? { leftAsHistorical: plan.historical.slice(0, 100) } : {}),
            ...(plan.notPlanned.length ? { notPlanned: plan.notPlanned.slice(0, 100) } : {}),
            ...(plan.review.count > 0 ? { reviewOnly: plan.review } : {}),
            // v3 F4a (ADR 0063): what the owner should know before approving: the new name is already in use.
            ...(plan.warnings.some((w) => w.code === 'NAMESAKE')
              ? { warnings: plan.warnings.filter((w) => w.code === 'NAMESAKE').map((w) => w.message) }
              : {}),
            ...(plan.namesakes?.length ? { namesakes: plan.namesakes } : {}),
            cost: preview.cost,
          },
          prefetched: plan.prefetched,
        },
        head,
        preview: () => ({ items: plan.items.length, summary: plan.summary }),
      });
      const renames = pd.services?.renames;
      if (renames && (out.proposalId || out.jobId))
        renames.record({
          id: plan.renameId,
          projectId: pd.project.id,
          packId: basis.pack.id,
          subjectId: plan.subject.id,
          subjectKind: plan.subject.kind,
          oldName: plan.oldName,
          newName: plan.newName,
          proposalId: out.proposalId ?? null,
          jobId: out.jobId ?? null,
          token: plan.token,
          review: {
            parts: plan.review.parts,
            customLabels: plan.review.occurrences.filter((o) => o.kind === 'custom label'),
          },
        });
      return { kind: 'job', head, labels: plan.labels, ...out };
    },
  );
}

/** `report`: what a rename left (and its state), free. */
export async function renameReport(
  pd: ProjectDeps,
  mctx: McpToolContext,
  ref: string,
): Promise<McpToolResult> {
  const renames = pd.services?.renames;
  if (!renames)
    return errorResult({ code: 'TOOL_UNAVAILABLE', message: 'Renames are not available here.' }, pd);
  const rec = renames.find(pd.project.id, ref.trim());
  if (!rec)
    return errorResult(
      {
        code: 'RENAME_NOT_FOUND',
        message: `No rename ${ref} on ${pd.project.name} (give its id, proposal or job).`,
      },
      pd,
    );
  let leftovers = rec.leftovers;
  if (rec.state === 'done' || rec.state === 'stopped') {
    try {
      leftovers = await renames.leftovers(pd.project.id, rec.id, { refresh: true });
    } catch {
      // The index is not readable now: the report kept at the job's end stands.
    }
  }
  const body: Obj = {
    rename: rec.id,
    state: rec.state,
    subject: { id: rec.subjectId, kind: rec.subjectKind },
    oldName: rec.oldName,
    newName: rec.newName,
    proposalId: rec.proposalId,
    jobId: rec.jobId,
    ...(rec.token ? { token: rec.token } : {}),
    leftovers:
      leftovers ??
      (rec.state === 'proposed' || rec.state === 'running'
        ? 'listed once the job has ended'
        : 'not listed (the full-text index is not available)'),
  };
  void mctx;
  return render(body, pd);
}

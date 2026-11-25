/**
 * Revert a finished direct-write job (v3 F3.4, ADR 0055 decision B), owner-initiated, from the Review page or the Jobs
 * page. It generalises the block-by-block undo (ADR 0046 decision 1, src/pages/undo.ts) to every kind of change an agent
 * makes at scope `write` that the bridge can put back from its own record (src/review/targets.ts and revert-plan.ts).
 *
 * - **Never reverted:** a deletion (restore_resource, which already exists, is named instead); anything that was a
 *   proposal (the owner approved it before it happened, canon and lifecycle changes included); a job still running; a
 *   revert (a revert is never itself reverted).
 * - **Only when nothing has changed since:** each target is read live and compared with the state the job left, by
 *   content; a target that differs is not reverted and the answer lists it with what changed. An outside edit is never
 *   overwritten. The rest of the job is reverted only when the owner confirms a partial revert (`confirmPartial`); the
 *   default is all or nothing.
 * - **One job:** run by the system principal at P1, holding every page, document and asset it writes for its whole run;
 *   each target's part checks it again inside those locks before its first write, chains its If-Match, is journalled
 *   like any write (`job.revert`) and verified. Last Major Revision is put back only where the job set it (its decision
 *   kept the value before); the revert sets no date of its own (`lastMajorRevision: "skip"`).
 * - **Audited** (`job.revert`: the job, the targets and the outcome; once when submitted or refused, once when it ends)
 *   and needs the owner's re-authentication (the admin route). Its result points to the journal and the snapshots.
 */
import type { BackgroundRunner } from '../background.js';
import type { Db } from '../db/open.js';
import type { JobEngine } from '../jobs/engine.js';
import { JobsError } from '../jobs/errors.js';
import {
  EXPECT_STEP,
  VERIFY_STEP,
  type DocumentChecker,
  type RegisteredChecker,
} from '../jobs/internal-steps.js';
import { rowsContentHash, rowsState, stableJson, type RowState } from '../jobs/sidebar-state.js';
import {
  SYSTEM_PRINCIPAL,
  TERMINAL_JOB_STATUSES,
  type JobView,
  type OpParams,
  type StepSpec,
} from '../jobs/types.js';
import { compareStoredBlocks } from '../jobs/verify-blocks.js';
import { withoutVersions } from '../pages/blockwise.js';
import type { PolicyStore } from '../policy/store.js';
import type { ImageService } from '../images/service.js';
import { planChronology, type ChronologyAccess } from './revert-chronology.js';
import {
  isStagingName,
  notRevertible,
  planBlocks,
  planFactsTarget,
  planImage,
  planLmr,
  planMove,
  planResource,
  planText,
  placeDiffs,
  resourceDiffs,
  REVERT_BLOCKS_CHECKER,
  REVERT_CHECKER,
  REVERT_TOOL,
  renumberStep,
  type PlanIo,
  type TargetCheck,
  type TargetPlan,
} from './revert-plan.js';
import type { ReviewService } from './service.js';
import type { BlockTarget, ResourceTarget, Target } from './targets.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export { REVERT_TOOL } from './revert-plan.js';

export class RevertError extends Error {
  override readonly name = 'RevertError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RevertPreview {
  readonly jobId: string;
  readonly projectId: string;
  readonly eligible:
    { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string };
  readonly targets: readonly TargetCheck[];
  /** Targets that would be written back now. */
  readonly ready: number;
  /** Targets that would not (changed since, gone, not revertible): a revert of the rest needs `confirmPartial`. */
  readonly notReverted: number;
  /**
   * v3 F3e (ADR 0059): a split's phase 1: the pages it made, which go to ONE deletion proposal once the revert has run
   * (or at once, when nothing else needs putting back).
   */
  readonly split?: {
    readonly pagesMade: number;
    /** CR-2026-11-R3 (R3-09): a split's phase 1 is reverted whole or not at all (never a partial revert). */
    readonly wholeOnly: true;
  };
}

export type RevertResult =
  | {
      readonly status: 'submitted';
      readonly revertJobId: string;
      readonly partial: boolean;
      readonly targets: readonly TargetCheck[];
      readonly message: string;
    }
  | {
      /**
       * v3 F3e (ADR 0059): a split's phase 1 that stopped before anything left its source: nothing to put back, so no
       * revert job; the pages it made go to ONE deletion proposal for the owner.
       */
      readonly status: 'proposed';
      readonly deletionProposalId: string | null;
      readonly targets: readonly TargetCheck[];
      readonly message: string;
    }
  | {
      readonly status: 'refused';
      readonly code: string;
      readonly message: string;
      readonly targets: readonly TargetCheck[];
    };

export interface RevertDeps {
  /** v3 F6a.1: the runtime's background work: follow-ups this service starts are tracked there. */
  readonly background?: Pick<BackgroundRunner, 'track'>;
  readonly db: Db;
  readonly engine: Pick<
    JobEngine,
    | 'submit'
    | 'events'
    | 'queries'
    | 'internalRead'
    | 'stepResults'
    | 'registerAsyncChecker'
    | 'registerChecker'
    | 'stepRecords'
  >;
  readonly review: ReviewService;
  readonly policy: Pick<PolicyStore, 'audit'>;
  readonly now: () => number;
  readonly chronology?: ChronologyAccess;
  /**
   * v3 F3.4 (ADR 0055 decision B5): the staged images, to put a reverted placement's file back into the bridge's server
   * staging and its record back on the Staging page.
   */
  readonly images?: Pick<ImageService, 'store' | 'copyPlacedToStaging' | 'restage' | 'dropCopy'>;
  /**
   * v3 F3e (ADR 0059): a split's phase 1 is revertible although the owner approved it (the design: "phase 1 can be
   * reverted, putting the moved content back and removing what it created"): the pages it made are not reverted by the
   * job but go to ONE deletion proposal once it has succeeded (`afterRevert`).
   */
  readonly splits?: {
    isPhase1(projectId: string, jobId: string): boolean;
    /** Whether a split's phase 1 has been reverted (with or without a revert job). */
    isReverted?(projectId: string, jobId: string): boolean;
    /** CR-2026-11-R3 (R3-09): whether phase 2 archived the source (its archive note changed the source's text). */
    isRetired?(projectId: string, jobId: string): boolean;
    /** How many pages a split's phase 1 made (its deletion proposal's pages, at most). */
    pagesMade?(projectId: string, jobId: string): number;
    /**
     * CR-2026-11-R3 (R3-66): the source a split's phase 1 upgraded from its Compact Character Reference to its Character
     * Core (renaming an Authoritative page is canon, ADR 0057 decision 5, which the bridge never does on its own): its name
     * and Reference Type are put back by the deletion proposal of the pages the split made, not by the revert job.
     */
    coreUpgrade?(
      projectId: string,
      jobId: string,
    ): { readonly resourceId: string; readonly from: string; readonly to: string } | null;
    afterRevert(
      projectId: string,
      jobId: string,
      revertJobId: string | null,
    ): Promise<{ readonly deletionProposalId: string | null; readonly problem?: string } | null>;
  };
  /**
   * v3 F3f (ADR 0060): other owner-approved jobs Revert applies to (a retag apply batch: its tags restored exactly, each
   * page only while it is as the job left it).
   */
  readonly approvedRevertible?: (projectId: string, jobId: string) => boolean;
  /**
   * v3 F5b (ADR 0068): a job Revert refuses although it is on the Review page, with its code and message (a governance
   * amendment recording that an automation was switched off: switching the code on again is the way back).
   */
  readonly refuse?: (
    projectId: string,
    jobId: string,
  ) => { readonly code: string; readonly message: string } | null;
  readonly log?: { warn(o: unknown, m: string): void };
}

/**
 * What the revert's record keeps about each image placement it reverts (v3 F3.4, decision B5): the copy of its file
 * already in the bridge's server staging; once the job has succeeded, its staged record goes back on the Staging page
 * and the placed asset's deletion is proposed to the owner (the proposal's id is added here).
 */
interface ImageNote {
  readonly assetId: string;
  readonly stagedId: string;
  readonly name: string | null;
  /** The copy of its file in the bridge's server staging (made before the job). */
  readonly copy: { readonly sha256: string; readonly bytes: number };
  /** The proposal to delete the placed asset (once the job has succeeded). */
  readonly deletionProposalId?: string | null;
  /** Why the follow-up did not happen, if it did not. */
  readonly problem?: string;
}

const isNotFound = (e: unknown): boolean => {
  const lk = (e as { lk?: { status?: number }; status?: number } | null)?.lk;
  return lk?.status === 404 || (e as { code?: unknown })?.code === 'NOT_FOUND';
};

export class RevertService {
  private offs: (() => void)[] = [];
  /** CR-2026-11-R2 (R2-21): the jobs a revert is being prepared for (until its record says `submitted`). */
  private readonly reserved = new Set<string>();
  /** CR-2026-11-R2 (R2-23): the ready set the owner was last shown, by job (bounded). */
  private readonly shown = new Map<string, readonly string[]>();

  constructor(private readonly d: RevertDeps) {}

  /** Registers the in-lock checks and follows revert jobs to their end. Returns a detach. */
  start(): () => void {
    this.offs.push(this.d.engine.registerAsyncChecker(REVERT_CHECKER, revertChecker));
    this.offs.push(this.d.engine.registerChecker(REVERT_BLOCKS_CHECKER, blocksChecker));
    this.offs.push(
      this.d.engine.events.on('job', (e: { type: string; job: JobView }) => {
        if (e.job.origin.tool !== REVERT_TOOL || !TERMINAL_JOB_STATUSES.has(e.job.status)) return;
        try {
          this.finished(e.job);
        } catch (err) {
          this.d.log?.warn({ err, jobId: e.job.id }, 'a revert could not be settled');
        }
      }),
    );
    return () => this.stop();
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  // ---------------------------------------------------------------------------------------------- eligibility

  private eligibility(
    projectId: string,
    jobId: string,
  ): { ok: true; job: JobView } | { ok: false; code: string; message: string } {
    const job = this.d.engine.queries.getJob(projectId, jobId);
    if (!job)
      return { ok: false, code: 'JOB_NOT_FOUND', message: `There is no job ${jobId} in this project.` };
    if (job.origin.tool === REVERT_TOOL)
      return {
        ok: false,
        code: 'IS_A_REVERT',
        message: `Job ${jobId} is a revert, and a revert is never itself reverted. The journal (bridge_journal_lookup with jobId ${jobId}) and the snapshots hold every target as it was before it.`,
      };
    const refused = this.d.refuse?.(projectId, jobId) ?? null;
    if (refused) return { ok: false, code: refused.code, message: refused.message };
    const split = this.d.splits?.isPhase1(projectId, jobId) === true;
    const approvedRevertible = this.d.approvedRevertible?.(projectId, jobId) === true;
    if (!this.d.review.store.get(projectId, jobId) && !split && !approvedRevertible) {
      if (job.approvedBy !== null)
        return {
          ok: false,
          code: 'WAS_A_PROPOSAL',
          message: `Job ${jobId} ran from a proposal the owner approved (seen before it happened; canon and lifecycle changes are always such proposals), so Revert does not apply. The journal and the snapshots hold what it changed.`,
        };
      return {
        ok: false,
        code: 'NOT_A_DIRECT_WRITE',
        message: `Job ${jobId} is not an agent’s direct write at scope write (the bridge’s own work, or a read): Revert does not apply.`,
      };
    }
    if (!TERMINAL_JOB_STATUSES.has(job.status))
      return {
        ok: false,
        code: 'JOB_RUNNING',
        message: `Job ${jobId} is still ${job.status}: a revert waits until it has finished (or been cancelled).`,
      };
    const prev = this.d.db
      .prepare(
        `SELECT state, revert_job_id FROM job_reverts WHERE project_id = ? AND job_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(projectId, jobId) as { state: string; revert_job_id: string } | undefined;
    if (prev?.state === 'submitted')
      return {
        ok: false,
        code: 'REVERT_RUNNING',
        message: `A revert of job ${jobId} is running (job ${prev.revert_job_id}).`,
      };
    if (prev?.state === 'succeeded')
      return {
        ok: false,
        code: 'ALREADY_REVERTED',
        message: `Job ${jobId} has been reverted (job ${prev.revert_job_id}).`,
      };
    if (split && this.d.splits?.isReverted?.(projectId, jobId) === true)
      return {
        ok: false,
        code: 'ALREADY_REVERTED',
        message: `Split job ${jobId} has been reverted: the pages it made were proposed for deletion.`,
      };
    return { ok: true, job };
  }

  // ---------------------------------------------------------------------------------------------- planning

  private io(projectId: string, jobId: string): PlanIo {
    const cache = new Map<string, Promise<{ exists: boolean; body: unknown }>>();
    return {
      jobId,
      read: (op: string, params: OpParams) => {
        const key = `${op} ${stableJson(params)}`;
        let p = cache.get(key);
        if (!p) {
          p = this.d.engine
            .internalRead(projectId, op, params, { priority: 'P1', notFoundIsAnswer: true })
            .then((body) => ({ exists: true, body }))
            .catch((e: unknown) => {
              if (isNotFound(e)) return { exists: false, body: null };
              throw new RevertError(
                'READ_FAILED',
                `A target could not be read (${op}): ${e instanceof Error ? e.message : String(e)}. Nothing was reverted; try again.`,
              );
            });
          cache.set(key, p);
        }
        return p;
      },
    };
  }

  private async plan(
    projectId: string,
    jobId: string,
  ): Promise<{
    eligible: RevertPreview['eligible'];
    plans: TargetPlan[];
    targets: Target[];
  }> {
    const el = this.eligibility(projectId, jobId);
    if (!el.ok)
      return { eligible: { ok: false, code: el.code, message: el.message }, plans: [], targets: [] };
    // R3-57 (ADR 0061 part B decision 5): a retag batch's page is put back only while its name and parent are as the job
    // left them too.
    const targets =
      this.d.review.targets(projectId, jobId, {
        placeAsLeft: this.d.approvedRevertible?.(projectId, jobId) === true,
      }) ?? [];
    const io = this.io(projectId, jobId);
    const plans: TargetPlan[] = [];
    const blocksByDoc = new Map<string, BlockTarget[]>();
    const split = this.d.splits?.isPhase1(projectId, jobId) === true;
    const upgrade = split ? (this.d.splits?.coreUpgrade?.(projectId, jobId) ?? null) : null;
    for (const t of targets) {
      if (t.kind === 'block') {
        blocksByDoc.set(t.documentId, [...(blocksByDoc.get(t.documentId) ?? []), t]);
        continue;
      }
      // v3 F3e (ADR 0059): what a split made is not reverted here: once the revert has run, those pages go to ONE
      // deletion proposal (each only while it is exactly as the split made it).
      if (split && t.kind === 'none' && t.creation === true) {
        plans.push({
          check: {
            key: t.key,
            kind: t.kind,
            page: t.page,
            what: t.what,
            state: 'nothing_to_do',
            detail: `${t.what}: made by the split; proposed for deletion once the revert has run (only while it is as the split made it)`,
          },
        });
        continue;
      }
      const t2 = upgrade?.resourceId === resourceOf(t) ? withoutUpgrade(t, upgrade) : t;
      if (t2 === null) {
        plans.push({
          check: {
            key: t.key,
            kind: t.kind,
            page: t.page,
            what: t.what,
            state: 'nothing_to_do',
            detail: `${t.what}: ${upgrade!.from} became ${upgrade!.to} with the split; it is put back (with its Reference Type) by the deletion proposal of the pages the split made, which the owner approves as canon`,
          },
        });
        continue;
      }
      plans.push(await this.planOne(t2, io, projectId));
    }
    for (const ts of blocksByDoc.values()) plans.push(...(await planBlocks(ts, io)));
    return { eligible: { ok: true }, plans, targets };
  }

  private async planOne(t: Target, io: PlanIo, projectId: string): Promise<TargetPlan> {
    switch (t.kind) {
      case 'text':
        return planText(t, io);
      case 'facts':
        return planFactsTarget(t, io);
      case 'lmr':
        return planLmr(t, io);
      case 'resource':
        return planResource(t, io);
      case 'move':
        return planMove(t, io);
      case 'image':
        return planImage(t, io);
      case 'chronology':
        return planChronology(t, io, projectId, this.d.chronology);
      case 'block':
        return planBlocks([t], io).then((x) => x[0]!);
      case 'none':
        return notRevertible(t, t.reason, {
          ...(t.deletion ? { deletion: true } : {}),
          instead: t.instead ?? null,
          journal: t.journal,
        });
    }
  }

  /** What a revert would do now: each target, read live (reads only; nothing is written). */
  async preview(projectId: string, jobId: string): Promise<RevertPreview> {
    const { eligible, plans } = await this.plan(projectId, jobId);
    const targets = plans.map((p) => p.check);
    // CR-2026-11-R2 (R2-23): what the owner is shown is what a partial revert may revert (and nothing else).
    if (eligible.ok)
      this.remember(
        projectId,
        jobId,
        targets
          .filter((c) => c.state === 'ready')
          .map((c) => c.key)
          .sort(),
      );
    const split = this.d.splits?.isPhase1(projectId, jobId) === true;
    return {
      jobId,
      projectId,
      eligible,
      targets,
      ready: targets.filter((c) => c.state === 'ready').length,
      notReverted: targets.filter((c) => c.state !== 'ready' && c.state !== 'nothing_to_do').length,
      ...(split
        ? {
            split: { pagesMade: this.d.splits?.pagesMade?.(projectId, jobId) ?? 0, wholeOnly: true as const },
          }
        : {}),
    };
  }

  // ---------------------------------------------------------------------------------------------- reverting

  /**
   * The owner's revert (the admin route re-authenticates first). See the module comment.
   *
   * CR-2026-11-R2 (R2-21): one revert of a job at a time. The job is reserved here, before anything is awaited, and stays
   * reserved until its `job_reverts` row says `submitted` (or the revert is refused): a second request meanwhile (a
   * double click, two tabs) is refused with `REVERT_RUNNING`.
   */
  async revert(
    actor: 'owner',
    projectId: string,
    jobId: string,
    o: { readonly confirmPartial?: boolean; readonly confirmed?: readonly string[] } = {},
  ): Promise<RevertResult> {
    if (actor !== 'owner') throw new RevertError('NOT_OWNER', 'Only the owner reverts a job.');
    const key = reservationKey(projectId, jobId);
    if (this.reserved.has(key)) {
      const message = `A revert of job ${jobId} is being prepared: wait for it, then look again.`;
      this.d.policy.audit('owner', 'job.revert', jobId, undefined, {
        outcome: 'refused',
        code: 'REVERT_RUNNING',
        targets: [],
      });
      return { status: 'refused', code: 'REVERT_RUNNING', message, targets: [] };
    }
    this.reserved.add(key);
    try {
      return await this.revertReserved(projectId, jobId, o);
    } finally {
      this.reserved.delete(key);
    }
  }

  private async revertReserved(
    projectId: string,
    jobId: string,
    o: { readonly confirmPartial?: boolean; readonly confirmed?: readonly string[] },
  ): Promise<RevertResult> {
    const { eligible, plans, targets: jobTargets } = await this.plan(projectId, jobId);
    let targets: TargetCheck[] = plans.map((p) => p.check);
    const summary = () => targets.map((c) => ({ key: c.key, what: c.what, state: c.state }));
    const refuse = (code: string, message: string): RevertResult => {
      this.d.policy.audit('owner', 'job.revert', jobId, undefined, {
        outcome: 'refused',
        code,
        targets: summary(),
      });
      return { status: 'refused', code, message, targets };
    };
    if (!eligible.ok) return refuse(eligible.code, eligible.message);
    let readyPlans = plans.filter((p) => p.check.state === 'ready');
    const others = targets.filter((c) => c.state !== 'ready' && c.state !== 'nothing_to_do');
    const readyKeys = readyPlans.map((p) => p.check.key).sort();
    if (readyPlans.length === 0) {
      // v3 F3e (ADR 0059): a split's phase 1 that stopped before anything left the source made pages and nothing else
      // to put back: those pages go to ONE deletion proposal (each only while it is as the split made it).
      const splits = this.d.splits;
      const splitMade =
        splits?.isPhase1(projectId, jobId) === true &&
        jobTargets.some((t) => t.kind === 'none' && t.creation === true);
      if (splits && splitMade && others.length === 0) {
        const out = await splits.afterRevert(projectId, jobId, null);
        this.d.policy.audit('owner', 'job.revert', jobId, undefined, {
          outcome: 'proposed',
          deletionProposal: out?.deletionProposalId ?? null,
          targets: summary(),
        });
        return {
          status: 'proposed',
          deletionProposalId: out?.deletionProposalId ?? null,
          targets,
          message: out?.deletionProposalId
            ? `Nothing of job ${jobId} had left the source, so there is nothing to put back: the pages it made are proposed for deletion (proposal ${out.deletionProposalId}), for the owner to approve.`
            : `Nothing of job ${jobId} had left the source, and none of the pages it made could be proposed for deletion${out?.problem ? ` (${out.problem})` : ' (each changed since, or is gone)'}.`,
        };
      }
      if (others.length > 0 && others.every((c) => c.deletion === true))
        return refuse(
          'DELETION',
          `Job ${jobId} deleted what it changed, and a deletion is never reverted: use restore_resource (a page) or the journal’s pre-images (bridge_journal_lookup with jobId ${jobId}).`,
        );
      if (others.length === 0)
        return refuse('NOTHING_TO_REVERT', `Everything job ${jobId} changed is already as it was before it.`);
      return refuse(
        'NOTHING_TO_REVERT',
        `Nothing of job ${jobId} can be reverted: ${others.map((c) => `${c.what} (${c.detail})`).join('; ')}.`,
      );
    }
    if (others.length > 0) {
      // CR-2026-11-R3 (R3-09): a split's phase 1 moved material. The source's edit and each destination's write are
      // two halves of one move, so it is reverted whole or not at all: a partial revert took the moved blocks off their
      // destination while the source (changed since, by a later edit or phase 2's archive note) stayed without them,
      // and the moved sections were on no live page.
      if (this.d.splits?.isPhase1(projectId, jobId) === true) {
        const retired = this.d.splits.isRetired?.(projectId, jobId) === true;
        return refuse(
          'SPLIT_REVERT_NOT_WHOLE',
          `Job ${jobId} is a split’s phase 1: its source’s edit and each destination’s write are two halves of one move, so it is reverted whole or not at all. ${others.length} of the ${targets.length} things it changed cannot be put back (listed with why), so nothing was reverted: a partial revert could leave moved material on no page.` +
            (retired
              ? ' Phase 2 archived the source, and its archive note changed the source: unarchive it first (unarchive_page removes an unedited note), then look again.'
              : ' Put those back as the split left them and look again, or take what you need from the journal (bridge_journal_lookup with jobId ' +
                jobId +
                ') or a snapshot.'),
        );
      }
      if (o.confirmPartial !== true) {
        this.remember(projectId, jobId, readyKeys);
        return refuse(
          'PARTIAL_REVERT_NEEDS_CONFIRMATION',
          `${others.length} of the ${targets.length} things job ${jobId} changed cannot be reverted (listed with why). The default is all or nothing: confirm a partial revert to revert the other ${readyPlans.length}.`,
        );
      }
      // CR-2026-11-R2 (R2-23): a partial revert reverts exactly the targets the owner confirmed (the ready set of the
      // preview, sent with the request; else the one last shown), or nothing.
      const seen = o.confirmed
        ? [...new Set(o.confirmed)].sort()
        : this.shown.get(reservationKey(projectId, jobId));
      if (!seen)
        return refuse(
          'PARTIAL_REVERT_NEEDS_CONFIRMATION',
          `Look at what a revert of job ${jobId} would do first: a partial revert reverts exactly the targets you confirmed.`,
        );
      if (seen.join('\n') !== readyKeys.join('\n')) {
        this.remember(projectId, jobId, readyKeys);
        return refuse(
          'REVERT_CHANGED',
          `What can be reverted of job ${jobId} has changed since you confirmed it (now: ${readyPlans.map((p) => p.check.what).join(', ')}): nothing was reverted. Look again and confirm.`,
        );
      }
    }

    // CR-2026-11-R2 (R2-18): a Last Major Revision date goes back only together with the edit that justified it. When that
    // edit is not reverted (a confirmed partial revert), the date stays: the page's major revision still stands.
    const keptLmr = new Set<string>();
    for (const p of readyPlans) {
      const t = jobTargets.find((x) => x.key === p.check.key);
      if (t?.kind !== 'lmr') continue;
      const why = jobTargets.filter((x) => x.key !== t.key && x.steps.some((n) => t.justifiedBy.includes(n)));
      const stays = why.filter((x) => {
        const s = plans.find((q) => q.check.key === x.key)?.check.state;
        return s !== 'ready' && s !== 'nothing_to_do';
      });
      if (stays.length > 0) keptLmr.add(p.check.key);
    }
    if (keptLmr.size > 0) {
      const keep = (c: TargetCheck): TargetCheck =>
        keptLmr.has(c.key)
          ? {
              ...c,
              state: 'nothing_to_do',
              detail: `${c.what} stays: the edit that set it is not reverted, so the page’s major revision still stands`,
            }
          : c;
      targets = targets.map(keep);
      const writing = readyPlans.filter((p) => !keptLmr.has(p.check.key));
      // Nothing else to write: the job only checks, inside its lock, that the date is still as the job left it.
      readyPlans =
        writing.length > 0
          ? writing
          : readyPlans.map((p) => ({ ...p, check: keep(p.check), steps: (p.steps ?? []).slice(0, 1) }));
    }

    // v3 F3.4 (decision B5): each image placement's file is copied back into the bridge's server staging FIRST, so a
    // file that cannot be saved refuses the revert before anything is written.
    const images: ImageNote[] = [];
    for (const p of readyPlans) {
      if (!p.image) continue;
      try {
        if (!this.d.images) throw new Error('the staged images are not available here');
        const copy = await this.d.images.copyPlacedToStaging(projectId, p.image.stagedId, p.image.url);
        images.push({ assetId: p.image.assetId, stagedId: p.image.stagedId, name: p.image.name, copy });
      } catch (e) {
        await this.dropCopies(images);
        return refuse(
          'IMAGE_NOT_SAVED',
          `${p.check.what}: ${e instanceof Error ? e.message : String(e)} Nothing was reverted: the image stays where it is.`,
        );
      }
    }

    // ONE job, every lock held for the whole run. CR-2026-11-R2 (R2-20): every target's check runs first, in one go, before
    // the first write (and again if the job takes its locks back before anything is sent): a target changed since is
    // caught before ANY target is written, so a revert stays all or nothing.
    const steps = freshRowVersions(checksFirst(readyPlans.map((p) => p.steps ?? [])));
    const resources = [...new Set(readyPlans.flatMap((p) => p.resources ?? []))];
    const documents = [...new Set(readyPlans.flatMap((p) => p.documents ?? []))];
    const assets = [...new Set(readyPlans.flatMap((p) => p.assets ?? []))];
    let jobIdOfRevert: string;
    try {
      const r = await this.d.engine.submit({
        kind: 'batch_ops',
        project: projectId,
        steps,
        onError: 'stop',
        priority: 'P1',
        origin: {
          kind: 'ui',
          client: 'dashboard',
          tool: REVERT_TOOL,
          detail: `revert:${jobId}`,
          principal: SYSTEM_PRINCIPAL,
        },
        title: `Revert of job ${jobId}`,
        internal: true,
        lastMajorRevision: 'skip',
        ...(resources.length > 0
          ? {
              holdLock: { resourceId: resources[0]! },
              ...(resources.length > 1 || documents.length > 0
                ? { holdMore: { resources: resources.slice(1), documents } }
                : {}),
            }
          : documents.length > 0
            ? { holdDocuments: documents }
            : {}),
        ...(assets.length > 0 ? { holdAssets: assets } : {}),
      });
      if (!('jobId' in r)) {
        await this.dropCopies(images);
        return refuse('NOT_SUBMITTED', 'The revert was not accepted as a job; nothing was written.');
      }
      jobIdOfRevert = r.jobId;
    } catch (e) {
      await this.dropCopies(images);
      const code = e instanceof JobsError ? (e.code ?? 'REFUSED') : 'REFUSED';
      return refuse(
        code,
        `The revert was refused before anything was written: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const partial = others.length > 0;
    const written = readyPlans.filter((p) => p.check.state === 'ready').length;
    this.d.db
      .prepare(
        `INSERT INTO job_reverts (project_id, job_id, revert_job_id, state, partial, targets, created_at, created_by)
         VALUES (?, ?, ?, 'submitted', ?, ?, ?, 'owner')`,
      )
      .run(
        projectId,
        jobId,
        jobIdOfRevert,
        partial ? 1 : 0,
        JSON.stringify({ targets, images }),
        this.d.now(),
      );
    this.shown.delete(reservationKey(projectId, jobId));
    this.d.policy.audit('owner', 'job.revert', jobId, undefined, {
      outcome: 'submitted',
      revertJobId: jobIdOfRevert,
      partial,
      targets: summary(),
    });
    return {
      status: 'submitted',
      revertJobId: jobIdOfRevert,
      partial,
      targets,
      message:
        `Revert job ${jobIdOfRevert} submitted: ${written} target${written === 1 ? '' : 's'} written back` +
        (partial ? `; ${others.length} not (listed with why)` : '') +
        (keptLmr.size > 0 ? `; Last Major Revision left as it is (the edit that set it stays)` : '') +
        `. Every target is checked again inside the job before anything is written.` +
        (images.length > 0
          ? ` Once it succeeds, ${images.length === 1 ? 'the placed image goes' : `the ${images.length} placed images go`} back to the Staging page (${images.length === 1 ? 'its file is' : 'their files are'} already copied to the bridge’s server), and deleting ${images.length === 1 ? 'it' : 'them'} from the library is proposed to you on the Proposals page.`
          : '') +
        ` The journal (bridge_journal_lookup with jobId ${jobId}) and the snapshots hold everything as it was, if you need to go further.`,
    };
  }

  /** CR-2026-11-R2 (R2-23): the ready set the owner was last shown for a job (a preview, or a refusal listing it). */
  private remember(projectId: string, jobId: string, readyKeys: readonly string[]): void {
    const key = reservationKey(projectId, jobId);
    this.shown.delete(key);
    this.shown.set(key, [...readyKeys]);
    while (this.shown.size > 500) this.shown.delete(this.shown.keys().next().value!);
  }

  /** A revert job ended: its record, the audit, the review item, and its images back on the Staging page. */
  private finished(job: JobView): void {
    const row = this.d.db
      .prepare('SELECT id, project_id, job_id, state, targets FROM job_reverts WHERE revert_job_id = ?')
      .get(job.id) as
      { id: number; project_id: string; job_id: string; state: string; targets: string } | undefined;
    if (!row || row.state !== 'submitted') return;
    // CR-2026-11-R2 (R2-25): a revert whose own verify found a target not as planned did not fully revert: it is settled
    // failed (and the item stays unreviewed), whatever the job's status.
    const mismatch =
      job.status === 'succeeded'
        ? (this.d.engine.stepRecords(row.project_id, job.id) ?? []).some(
            (s) =>
              s.opId === VERIFY_STEP &&
              isObj(s.result) &&
              isObj(s.result.verification) &&
              s.result.verification.status === 'mismatch',
          )
        : false;
    const state =
      job.status === 'succeeded' && !mismatch
        ? 'succeeded'
        : job.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
    this.d.db
      .prepare('UPDATE job_reverts SET state = ?, finished_at = ? WHERE id = ?')
      .run(state, this.d.now(), row.id);
    this.d.policy.audit('system', 'job.revert', row.job_id, undefined, {
      outcome: state,
      revertJobId: job.id,
      ...(job.lastError ? { error: job.lastError.message } : {}),
      ...(mismatch
        ? {
            error:
              'the revert’s own verify found a target not as planned (written, but not as it was before)',
          }
        : {}),
    });
    let note: { targets?: unknown; images?: ImageNote[] };
    try {
      note = JSON.parse(row.targets) as { targets?: unknown; images?: ImageNote[] };
    } catch {
      note = {};
    }
    const notes = note.images ?? [];
    if (state !== 'succeeded') {
      // The revert did not go ahead: the copies of the images' files are not wanted.
      this.follow('dropping the copies of a revert’s images', this.dropCopies(notes));
      return;
    }
    this.d.review.markReverted(row.project_id, row.job_id);
    if (notes.length > 0)
      this.follow(
        'putting a revert’s images back on the Staging page',
        this.afterImages(row.id, row.project_id, row.job_id, note, notes),
      );
    // v3 F3e (ADR 0059): a split's phase 1 reverted: the pages it made go to ONE deletion proposal.
    if (this.d.splits?.isPhase1(row.project_id, row.job_id))
      this.follow(
        'proposing the deletion of a reverted split’s pages',
        this.d.splits
          .afterRevert(row.project_id, row.job_id, job.id)
          .catch((err: unknown) =>
            this.d.log?.warn(
              { err, jobId: row.job_id },
              'the pages a reverted split made could not be proposed for deletion',
            ),
          ),
      );
  }

  /** v3 F6a.1: a follow-up, tracked by the runtime's background work (a stop waits for it before the database closes). */
  private follow(label: string, p: Promise<unknown>): void {
    void (this.d.background ? this.d.background.track(label, p) : p);
  }

  /**
   * v3 F3.4 (ADR 0055 decision B5): once a revert job has succeeded, each image placement it reverted goes back on the
   * Staging page (its staged record, from the copy of its file on the bridge's server), and deleting the placed asset is
   * proposed to the owner: ONE proposal per image, by the bridge, never run without the owner's approval. Nothing is
   * written to LegendKeeper here, and nothing to its staging folder. Recorded with the revert and audited.
   */
  private async afterImages(
    revertId: number,
    projectId: string,
    jobId: string,
    note: { targets?: unknown; images?: ImageNote[] },
    notes: readonly ImageNote[],
  ): Promise<void> {
    const done: ImageNote[] = [];
    for (const im of notes) {
      try {
        if (!this.d.images?.restage(projectId, im.stagedId, im.copy.sha256))
          throw new Error(`there is no staged image ${im.stagedId} any more`);
        const label = im.name ?? im.assetId;
        const summary = `Revert of job ${jobId}: delete the placed image “${label}” from the library (its file is back on the Staging page)`;
        const r = await this.d.engine.submit({
          kind: 'batch_ops',
          project: projectId,
          steps: [
            {
              op: 'deleteAsset',
              params: { path: { assetId: im.assetId } },
              journalOperation: { tool: REVERT_TOOL, revertOf: jobId, write: `the placed image “${label}”` },
            },
          ],
          onError: 'stop',
          priority: 'P1',
          origin: { kind: 'ui', client: 'dashboard', tool: REVERT_TOOL, detail: `revert:${jobId}` },
          title: summary.slice(0, 300),
          forceProposal: true,
          proposal: { summary },
        });
        const proposalId = 'proposalId' in r && typeof r.proposalId === 'string' ? r.proposalId : null;
        if (!proposalId) throw new Error('the deletion was not captured as a proposal');
        done.push({ ...im, deletionProposalId: proposalId });
      } catch (e) {
        const problem = e instanceof Error ? e.message : String(e);
        this.d.log?.warn(
          { err: e, jobId, assetId: im.assetId },
          'a reverted image placement could not be followed up',
        );
        // Not back on the Staging page: the copy of its file is not wanted (kept while a staged record uses it).
        await this.dropCopies([im]);
        done.push({ ...im, deletionProposalId: null, problem });
      }
    }
    try {
      this.d.db
        .prepare('UPDATE job_reverts SET targets = ? WHERE id = ?')
        .run(JSON.stringify({ ...note, images: done }), revertId);
    } catch {
      // the record keeps the copies as they were; the audit row below says what happened
    }
    this.d.policy.audit('system', 'job.revert', jobId, undefined, {
      outcome: 'images',
      images: done.map((im) => ({
        assetId: im.assetId,
        stagedId: im.stagedId,
        deletionProposalId: im.deletionProposalId ?? null,
        ...(im.problem ? { problem: im.problem } : {}),
      })),
    });
  }

  /** Removes the copies of images' files made for a revert that did not go ahead. */
  private async dropCopies(notes: readonly ImageNote[]): Promise<void> {
    for (const im of notes) {
      try {
        await this.d.images?.dropCopy(im.copy.sha256);
      } catch (e) {
        this.d.log?.warn({ err: e, stagedId: im.stagedId }, 'a copy of an image’s file could not be removed');
      }
    }
  }
}

const reservationKey = (projectId: string, jobId: string) => `${projectId}\u0000${jobId}`;

/**
 * CR-2026-11-R2 (R2-20): the targets' parts joined into one job with every part's leading check (`bridge.expect`) first, in
 * one go, then each part's writes and verify in order; the step numbers each step names are mapped to the new order.
 */
export function checksFirst(parts: readonly (readonly StepSpec[])[]): StepSpec[] {
  const order: { part: number; local: number }[] = [];
  const lead = parts.map((ss) => {
    let n = 0;
    while (n < ss.length && ss[n]!.op === EXPECT_STEP) n++;
    return n;
  });
  parts.forEach((ss, i) => ss.forEach((_, j) => j < lead[i]! && order.push({ part: i, local: j + 1 })));
  parts.forEach((ss, i) => ss.forEach((_, j) => j >= lead[i]! && order.push({ part: i, local: j + 1 })));
  const at = new Map(order.map((o, k) => [`${o.part}:${o.local}`, k + 1]));
  return order.map((o) => renumberStep(parts[o.part]![o.local - 1]!, (n) => at.get(`${o.part}:${n}`) ?? n));
}

/** The sidebar writes a revert job can make (each moves the page's sidebar version on). */
const SIDEBAR_WRITES = new Set([
  'updateProperty',
  'createProperty',
  'deleteProperty',
  'updatePropertyRow',
  'createPropertyRow',
  'deletePropertyRow',
]);
const ROW_WRITES = new Set(['updatePropertyRow', 'createPropertyRow', 'deletePropertyRow']);

/**
 * v3 F3e (ADR 0059): a row write whose If-Match is its target's check (read before the first write) while an EARLIER
 * write of the same revert job changed the same page's sidebar (another target's link collection: a split's phase 1
 * changes a page's Related Sources and its Last Major Revision, two targets) would send a version that is no longer the
 * page's. Such a write is judged inside its lock instead: the rows must still be exactly as the check read them, and the
 * version sent is the one read there. Every other write keeps its chain unchanged.
 */
export function freshRowVersions(steps: readonly StepSpec[]): StepSpec[] {
  const wrote = new Set<string>();
  return steps.map((s) => {
    const rid = s.params?.path?.resourceId;
    const from = s.ifMatchFrom;
    let out = s;
    if (typeof rid === 'string' && from?.key !== undefined && ROW_WRITES.has(s.op) && wrote.has(rid)) {
      const check = steps[from.step - 1];
      const checks =
        check?.op === EXPECT_STEP
          ? ((check.params?.body as { checks?: Record<string, unknown>[] } | undefined)?.checks ?? [])
          : [];
      const c = checks.find((x) => x.label === from.key && x.kind === 'propertyRows' && x.resourceId === rid);
      if (c && Array.isArray(c.rows)) {
        const { ifMatchFrom: _stale, ...rest } = s;
        void _stale;
        out = {
          ...rest,
          expectCurrent: { state: 'rows', hash: rowsContentHash(rowsState(c.rows)), label: from.key },
        };
      }
    }
    if (typeof rid === 'string' && SIDEBAR_WRITES.has(s.op)) wrote.add(rid);
    return out;
  });
}

// ------------------------------------------------------------------------------------------------ in-lock checks

/** A page's fields, or an asset's place, exactly as the job left them (inside the revert job's locks). */
const revertChecker: RegisteredChecker = async (ctx) => {
  const input = (ctx.input ?? {}) as {
    kind?: string;
    resourceId?: string;
    assetId?: string;
    fields?: Record<string, unknown>;
  };
  if (input.kind === 'resource' && input.resourceId) {
    const r = await ctx.read('getResource', { path: { resourceId: input.resourceId } });
    if (!r.exists) return { differences: [{ path: ctx.label, expected: 'present', actual: '(gone)' }] };
    const live = isObj(r.body) ? r.body : {};
    const place = (ctx.input as { place?: ResourceTarget['place'] }).place;
    return { differences: [...resourceDiffs(input.fields ?? {}, live), ...placeDiffs(place, live)] };
  }
  if (input.kind === 'asset' && input.assetId) {
    const r = await ctx.read('getAsset', { path: { assetId: input.assetId } });
    if (!r.exists) return { differences: [{ path: ctx.label, expected: 'present', actual: '(gone)' }] };
    const live = isObj(r.body) ? r.body : {};
    const f = (input.fields ?? {}) as { folderId?: string | null; name?: string | null; isHidden?: boolean };
    const now = {
      folderId: typeof live.folderId === 'string' && live.folderId !== '' ? live.folderId : null,
      name: typeof live.name === 'string' ? live.name : null,
      isHidden: live.isHidden === true,
    };
    const differences = [];
    if (f.folderId !== undefined && now.folderId !== f.folderId)
      differences.push({ path: 'folder', expected: f.folderId, actual: now.folderId });
    if (f.isHidden !== undefined && now.isHidden !== f.isHidden)
      differences.push({ path: 'hidden', expected: f.isHidden, actual: now.isHidden });
    if (typeof f.name === 'string' && now.name !== f.name)
      differences.push({ path: 'name', expected: f.name, actual: now.name });
    // CR-2026-11-R2 (R2-22): the folder it goes back to, read now: never a staging folder, nor one whose name is unknown.
    const into = (ctx.input as { into?: { folderId?: string; notNamed?: string[] } }).into;
    if (into?.folderId) {
      const g = await ctx.read('getAsset', { path: { assetId: into.folderId } });
      const fb = isObj(g.body) ? g.body : {};
      if (!g.exists || typeof fb.deletedAt === 'string')
        differences.push({ path: 'the folder it goes back to', expected: 'present', actual: '(gone)' });
      else if (typeof fb.name !== 'string' || isStagingName(fb.name, into.notNamed ?? []))
        differences.push({
          path: 'the folder it goes back to',
          expected: 'not the staging folder',
          actual: typeof fb.name === 'string' ? fb.name : '(no name)',
        });
    }
    return { differences };
  }
  return { differences: [{ path: ctx.label, expected: 'a revert target', actual: 'nothing to check' }] };
};

/** Single blocks of a document exactly as the job left them (gives the document's version, for If-Match). */
const blocksChecker: DocumentChecker = (ctx) => {
  const input = (ctx.input ?? {}) as { blocks?: { id: string; expect: Obj | null }[] };
  const find = (list: readonly unknown[], id: string): Obj | null => {
    for (const b of list) {
      if (!isObj(b)) continue;
      if (b.id === id) return b;
      if (Array.isArray(b.children)) {
        const f = find(b.children as unknown[], id);
        if (f) return f;
      }
    }
    return null;
  };
  const differences = [];
  for (const b of input.blocks ?? []) {
    const found = find(ctx.document.blocks, b.id);
    if (b.expect === null) {
      if (found) differences.push({ path: b.id, expected: 'absent', actual: 'present' });
      continue;
    }
    if (!found) {
      differences.push({ path: b.id, expected: 'present', actual: '(gone)' });
      continue;
    }
    if (!compareStoredBlocks([b.expect], withoutVersions([found])).ok)
      differences.push({ path: b.id, expected: 'the block as the job left it', actual: 'changed since' });
  }
  return { differences };
};

const resourceOf = (t: Target): string | null =>
  'resourceId' in t && typeof t.resourceId === 'string' ? t.resourceId : null;

/**
 * CR-2026-11-R3 (R3-66): a target of the source a split upgraded to its Character Core, without the upgrade (its new name,
 * its Reference Type row), which the deletion proposal puts back; null when nothing else of it is left to revert.
 */
function withoutUpgrade(t: Target, u: { readonly from: string; readonly to: string }): Target | null {
  if (t.kind === 'resource') {
    const before = { ...t.before } as Record<string, unknown>;
    const left = { ...t.left } as Record<string, unknown>;
    if (before.name !== u.from || left.name !== u.to) return t;
    delete before.name;
    delete left.name;
    return Object.keys(left).length === 0 ? null : { ...t, before, left };
  }
  if (t.kind === 'facts' && t.rowsBefore && t.rowsLeft) {
    const rt = (rows: readonly RowState[]) =>
      rows.find((r) => r.key.trim().toLowerCase() === 'reference type');
    const left = rt(t.rowsLeft);
    if (!left) return t;
    const rowsBefore = t.rowsBefore.map((r) => (r.id === left.id ? left : r));
    const same = stableJson(rowsBefore) === stableJson(t.rowsLeft);
    if (same && t.collections.length === 0 && !t.lmr) return null;
    return { ...t, rowsBefore: same ? t.rowsLeft : rowsBefore };
  }
  return t;
}

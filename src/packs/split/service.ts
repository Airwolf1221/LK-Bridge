/**
 * v3 F3e (ADR 0059): what follows a split once it is proposed (the design's section 2, decisions D2 and D6).
 *
 * - **The record** (`pack_splits`): the source, whether it is to be retired, the destinations as planned, the phase 1
 *   proposal and job, and what followed.
 * - **Phase 2 (D2)**: when phase 1's job has succeeded (its last step is the verification: a difference stops it, so a
 *   job that succeeded has verified), and the source is to be retired, the bridge proposes archiving it through
 *   archive_page's own plan: a SEPARATE canonical proposal for the owner. Only when every item of the split was approved
 *   and none was skipped when it ran: a destination left out keeps its sections in the source (D6), so the source still
 *   owns material and is not retired (the record says why). The split never deletes the source.
 * - **A stopped phase 1** (a verification failure, a conflict): no phase 2; Resume and Revert stay available.
 * - **Revert of phase 1**: the revert job puts the moved content back (the Revert service's own targets: the source's
 *   text, the existing owners' appends, the remapped Dependencies, the index lines, Last Major Revision); once it has
 *   succeeded, the pages phase 1 made go to ONE deletion proposal for the owner (the deletes rail's way: a delete is a
 *   proposal; an Authoritative page's is canonical), each only while it is exactly as the job made it; one changed
 *   since is kept and listed.
 */
import type { Db } from '../../db/open.js';
import type { JobEngine } from '../../jobs/engine.js';
import { SYSTEM_PRINCIPAL, type JobView, type StepSpec } from '../../jobs/types.js';
import { stateHash } from '../../jobs/sidebar-state.js';
import { expandFacts } from '../../facts/expand.js';
import { FactsPlanError, planFacts } from '../../facts/plan.js';
import { sidebarFrom } from '../../facts/sidebar.js';
import { rowTextRuns } from '../../facts/values.js';
import { shiftStep } from '../engine/job.js';
import type { ProposalHooks } from '../../policy/proposals.js';
import type { ProposalView } from '../../policy/types.js';
import { contentPrint, textPrint } from './blocks.js';
import { mainDocumentOf, SPLIT_CHECKS, type MadeCheckInput, type VerifyCheckInput } from './checks.js';
import { EXPECT_STEP } from '../../jobs/internal-steps.js';
import { SPLIT_TOOL, type SplitUpgrade } from './plan.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export type SplitState =
  | 'proposed'
  | 'running'
  | 'verified'
  /** CR-2026-11-R3 (R3-67): phase 1 ran to its end, but the job's verification found differences: nothing is retired. */
  | 'unverified'
  | 'stopped'
  | 'retiring'
  | 'retired'
  | 'reverted'
  | 'closed';

export interface SplitRecordPlan {
  readonly destinations: readonly {
    readonly key: string;
    readonly kind: string;
    readonly item: string;
    readonly page: { readonly id: string; readonly name: string } | null;
    readonly isNew: boolean;
    readonly sections: readonly string[];
  }[];
  readonly items: readonly string[];
  readonly newPages: readonly { readonly id: string; readonly name: string }[];
  readonly unmapped: readonly { readonly id: string; readonly name: string }[];
  /** CR-2026-11-R3 (R3-66): the source upgraded to its Character Core by the split (put back with the pages it made). */
  readonly upgrade?: SplitUpgrade | null;
}

export interface SplitPhase2 {
  readonly proposalId?: string;
  readonly jobId?: string;
  readonly summary?: string;
  /** Why there is no phase 2 (the source survives, a destination left out, a skipped item, a stopped job). */
  readonly reason?: string;
  readonly at: number;
}

export interface SplitRevert {
  /** The revert job (null: nothing but the pages it made was left to put back, so no job ran). */
  readonly revertJobId: string | null;
  /** The proposal deleting the pages phase 1 made (null when none could be proposed). */
  readonly deletionProposalId: string | null;
  readonly deleted: readonly { readonly id: string; readonly name: string }[];
  /** Pages kept because they changed since phase 1 made them (or could not be read). */
  readonly kept: readonly { readonly id: string; readonly name: string; readonly why: string }[];
  /**
   * CR-2026-11-R3 (R3-66): a source phase 1 upgraded to its Character Core: whether the deletion proposal puts it back to
   * its Compact Character Reference (after the deletions), or why not.
   */
  readonly core?: { readonly back: boolean; readonly why?: string };
  readonly problem?: string;
}

export interface SplitRecord {
  readonly id: string;
  readonly projectId: string;
  readonly packId: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly retire: boolean;
  readonly proposalId: string | null;
  readonly jobId: string | null;
  readonly state: SplitState;
  readonly plan: SplitRecordPlan;
  readonly phase2: SplitPhase2 | null;
  readonly revert: SplitRevert | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface Row {
  id: string;
  project_id: string;
  pack_id: string;
  source_id: string;
  source_name: string;
  retire: number;
  proposal_id: string | null;
  job_id: string | null;
  state: SplitState;
  plan: string;
  phase2: string | null;
  revert: string | null;
  created_at: number;
  updated_at: number;
}

const parse = <T>(s: string | null): T | null => {
  if (s === null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

const toRecord = (r: Row): SplitRecord => ({
  id: r.id,
  projectId: r.project_id,
  packId: r.pack_id,
  sourceId: r.source_id,
  sourceName: r.source_name,
  retire: r.retire === 1,
  proposalId: r.proposal_id,
  jobId: r.job_id,
  state: r.state,
  plan: parse<SplitRecordPlan>(r.plan) ?? { destinations: [], items: [], newPages: [], unmapped: [] },
  phase2: parse<SplitPhase2>(r.phase2),
  revert: parse<SplitRevert>(r.revert),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Proposes archiving a page as the bridge (src/packs/split/archive.ts `bridgeArchiver`). */
export type Archiver = (
  projectId: string,
  pageId: string,
  because: { readonly detail: string; readonly summary: string },
) => Promise<
  { ok: true; proposalId: string; summary: string } | { ok: false; code: string; message: string }
>;

export interface SplitServiceDeps {
  readonly db: Db;
  readonly engine: Pick<JobEngine, 'events' | 'submit' | 'internalRead' | 'queries' | 'stepRecords'> &
    Partial<Pick<JobEngine, 'skippedItems'>>;
  readonly proposals: {
    addHooks(h: ProposalHooks): () => void;
    get(id: string): ProposalView | undefined;
    /** The items the owner approved and left out (null: not itemized, or approved whole). */
    itemsOf?(
      id: string,
    ): { readonly approved: readonly string[] | null; readonly omitted: readonly string[] | null } | null;
  };
  /** The page's parent, as the repository tree has it (children are deleted before their parents). */
  readonly parentOf?: (projectId: string, pageId: string) => string | null;
  readonly audit: (
    actor: string,
    action: string,
    target: string | null,
    before?: unknown,
    after?: unknown,
  ) => void;
  readonly now: () => number;
  readonly log?: { warn(o: unknown, m: string): void };
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** CR-2026-11-R3 (R3-67): the job's own verification (every read-back of its writes and its verify step) found no difference. */
export function jobVerified(job: Pick<JobView, 'status' | 'result'>): boolean {
  return job.status === 'succeeded' && isObj(job.result) && job.result.verified === true;
}

export class SplitService {
  private offs: (() => void)[] = [];
  private archiver: Archiver | null = null;
  /** Phase 2 being proposed, by split (one at a time, never twice). */
  private readonly proposing = new Set<string>();

  constructor(private readonly d: SplitServiceDeps) {}

  /** Set once the tools exist (archive_page's planner needs the tool layer's deps). */
  setArchiver(a: Archiver): void {
    this.archiver = a;
  }

  start(): () => void {
    this.offs.push(
      this.d.proposals.addHooks({
        afterSubmit: (ctx) => this.afterSubmit(ctx.proposal, ctx.jobId),
        afterRepropose: (ctx) => this.afterRepropose(ctx.original, ctx.proposalId),
        // CR-2026-11-R3 (R3-15): a split's left-out destinations are planned again on the source as it is now, never
        // re-proposed from the old plan (its source edits and verification name blocks the first job already moved).
        refuseRepropose: (original) =>
          this.byProposal(original.id)
            ? 'A split’s left-out destinations are not proposed again from the old plan: the source has changed since ' +
              '(the approved part moved its blocks). Ask the agent to split what is left (arkona_split_owner on the ' +
              'source as it is now).'
            : null,
      }),
      this.d.engine.events.on('job', (e: { type: string; job: JobView }) => {
        try {
          this.onJob(e.job);
        } catch (err) {
          this.d.log?.warn({ err, jobId: e.job.id }, 'a split could not follow its job');
        }
      }),
    );
    return () => this.stop();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }

  // ============================================================================================ the record

  record(r: {
    readonly id: string;
    readonly projectId: string;
    readonly packId: string;
    readonly sourceId: string;
    readonly sourceName: string;
    readonly retire: boolean;
    readonly proposalId: string | null;
    readonly jobId: string | null;
    readonly plan: SplitRecordPlan;
  }): SplitRecord {
    const now = this.d.now();
    this.d.db
      .prepare(
        `INSERT INTO pack_splits (id, project_id, pack_id, source_id, source_name, retire, proposal_id, job_id, state, plan,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.projectId,
        r.packId,
        r.sourceId,
        r.sourceName,
        r.retire ? 1 : 0,
        r.proposalId,
        r.jobId,
        r.jobId ? 'running' : 'proposed',
        JSON.stringify(r.plan),
        now,
        now,
      );
    return this.get(r.id)!;
  }

  get(id: string): SplitRecord | null {
    const r = this.d.db.prepare('SELECT * FROM pack_splits WHERE id = ?').get(id) as Row | undefined;
    return r ? toRecord(r) : null;
  }

  byProposal(proposalId: string): SplitRecord | null {
    const r = this.d.db
      .prepare('SELECT * FROM pack_splits WHERE proposal_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(proposalId) as Row | undefined;
    return r ? toRecord(r) : null;
  }

  byJob(projectId: string, jobId: string): SplitRecord | null {
    const r = this.d.db
      .prepare(
        'SELECT * FROM pack_splits WHERE project_id = ? AND job_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(projectId, jobId) as Row | undefined;
    return r ? toRecord(r) : null;
  }

  /** A split by its id, its proposal or its job. */
  find(projectId: string, ref: string): SplitRecord | null {
    const r = this.get(ref) ?? this.byProposal(ref) ?? this.byJob(projectId, ref);
    return r && r.projectId === projectId ? r : null;
  }

  /** The splits of a source, newest first. */
  forSource(projectId: string, sourceId: string, limit = 20): SplitRecord[] {
    return (
      this.d.db
        .prepare(
          'SELECT * FROM pack_splits WHERE project_id = ? AND source_id = ? ORDER BY created_at DESC LIMIT ?',
        )
        .all(projectId, sourceId, limit) as Row[]
    ).map(toRecord);
  }

  private update(
    id: string,
    f: { state?: SplitState; jobId?: string; phase2?: SplitPhase2; revert?: SplitRevert },
  ): void {
    const sets: string[] = ['updated_at = ?'];
    const args: unknown[] = [this.d.now()];
    if (f.state !== undefined) {
      sets.push('state = ?');
      args.push(f.state);
    }
    if (f.jobId !== undefined) {
      sets.push('job_id = ?');
      args.push(f.jobId);
    }
    if (f.phase2 !== undefined) {
      sets.push('phase2 = ?');
      args.push(JSON.stringify(f.phase2));
    }
    if (f.revert !== undefined) {
      sets.push('revert = ?');
      args.push(JSON.stringify(f.revert));
    }
    this.d.db.prepare(`UPDATE pack_splits SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  // ============================================================================================ the proposals

  private afterSubmit(proposal: ProposalView, jobId: string): void {
    const rec = this.byProposal(proposal.id);
    if (rec) {
      this.update(rec.id, { state: 'running', jobId });
      return;
    }
    // Phase 2's archive proposal approved: its job, followed to its end.
    const p2 = this.d.db
      .prepare(`SELECT * FROM pack_splits WHERE json_extract(phase2, '$.proposalId') = ? LIMIT 1`)
      .get(proposal.id) as Row | undefined;
    if (p2) {
      const r = toRecord(p2);
      this.update(r.id, { phase2: { ...(r.phase2 ?? { at: this.d.now() }), jobId } });
    }
  }

  /** "Propose these again": the new proposal is a split of its own (the same source), never retiring by itself. */
  private afterRepropose(original: ProposalView, proposalId: string): void {
    const rec = this.byProposal(original.id);
    if (!rec) return;
    this.record({
      id: `${rec.id.split('~')[0]}~${proposalId.slice(-8)}`,
      projectId: rec.projectId,
      packId: rec.packId,
      sourceId: rec.sourceId,
      sourceName: rec.sourceName,
      retire: rec.retire,
      proposalId,
      jobId: null,
      plan: rec.plan,
    });
  }

  // ============================================================================================ the jobs

  private onJob(job: JobView): void {
    if (!TERMINAL.has(job.status)) {
      const rec = this.byJob(job.projectId, job.id);
      if (rec && rec.state === 'stopped') this.update(rec.id, { state: 'running' });
      return;
    }
    const rec = this.byJob(job.projectId, job.id);
    if (rec) {
      if (rec.state === 'reverted') return;
      if (job.status !== 'succeeded') {
        this.update(rec.id, {
          state: 'stopped',
          phase2: {
            reason: `phase 1 ${job.status === 'cancelled' ? 'was cancelled' : 'stopped before it verified'}${job.lastError ? ` (${job.lastError.message.slice(0, 300)})` : ''}: nothing is retired. Resume it once it is put right, or Revert it.`,
            at: this.d.now(),
          },
        });
        return;
      }
      // CR-2026-11-R3 (R3-67): verified only when the job's own verification says so, never on the split's own judgement
      // (the two once disagreed: the job "not verified", the split "verified"). A job that ran to its end whose read-back
      // found differences is not verified, and nothing is retired.
      if (!jobVerified(job)) {
        this.update(rec.id, {
          state: 'unverified',
          phase2: {
            reason: `phase 1 ran to its end, but its verification found differences (job ${job.id}'s result): nothing is retired. Look at the differences on the job, then put them right or Revert it.`,
            at: this.d.now(),
          },
        });
        this.d.audit('system', 'split.unverified', rec.id, null, { job: job.id });
        return;
      }
      void this.afterVerified(rec, job).catch((err: unknown) =>
        this.d.log?.warn({ err, split: rec.id }, 'phase 2 of a split could not be proposed'),
      );
      return;
    }
    // Phase 2's job ended: the source retired (archived), or not.
    const p2 = this.d.db
      .prepare(
        `SELECT * FROM pack_splits WHERE project_id = ? AND json_extract(phase2, '$.jobId') = ? LIMIT 1`,
      )
      .get(job.projectId, job.id) as Row | undefined;
    if (p2 && job.status === 'succeeded') this.update(p2.id, { state: 'retired' });
  }

  /** Phase 1 has succeeded, so verified (its last step is the verification). Phase 2 when everything was done. */
  private async afterVerified(rec: SplitRecord, job: JobView): Promise<void> {
    if (!rec.retire) {
      this.update(rec.id, {
        state: 'verified',
        phase2: { reason: 'the source survives (retire was not asked): no phase 2', at: this.d.now() },
      });
      return;
    }
    if (rec.phase2?.proposalId || this.proposing.has(rec.id)) return;
    const items = rec.proposalId ? (this.d.proposals.itemsOf?.(rec.proposalId) ?? null) : null;
    const omitted = items?.omitted ?? [];
    const skipped = this.d.engine.skippedItems?.(rec.projectId, job.id) ?? [];
    if (omitted.length > 0 || skipped.length > 0) {
      const why =
        omitted.length > 0
          ? `the owner left out ${omitted.length} item${omitted.length === 1 ? '' : 's'} (${omitted.slice(0, 5).join(', ')}), whose sections stay in the source`
          : `${skipped.length} item${skipped.length === 1 ? ' was' : 's were'} skipped when the job ran (${skipped
              .slice(0, 5)
              .map((x) => x.item)
              .join(', ')})`;
      this.update(rec.id, {
        state: 'verified',
        phase2: {
          reason: `${why}: the source still owns material, so it is not retired. Split what is left as a new split (arkona_split_owner on the source as it is now), then retire it with archive_page when nothing is left.`,
          at: this.d.now(),
        },
      });
      this.d.audit('system', 'split.phase2_withheld', rec.id, null, {
        job: job.id,
        omitted,
        skipped: skipped.map((x) => x.item),
      });
      return;
    }
    if (!this.archiver) {
      this.update(rec.id, {
        state: 'verified',
        phase2: {
          reason: 'archive_page is not available here: retire the source with archive_page',
          at: this.d.now(),
        },
      });
      return;
    }
    this.proposing.add(rec.id);
    try {
      let r: Awaited<ReturnType<Archiver>>;
      try {
        r = await this.archiver(rec.projectId, rec.sourceId, {
          detail: `split:${rec.id} phase 2`,
          summary: `phase 2 of split ${rec.id}: phase 1 verified (job ${job.id})`,
        });
      } catch (e) {
        r = { ok: false, code: 'NOT_PROPOSED', message: e instanceof Error ? e.message : String(e) };
      }
      if (r.ok) {
        this.update(rec.id, {
          state: 'retiring',
          phase2: { proposalId: r.proposalId, summary: r.summary, at: this.d.now() },
        });
        this.d.audit('system', 'split.phase2_proposed', rec.id, null, {
          job: job.id,
          proposal: r.proposalId,
        });
      } else {
        this.update(rec.id, {
          state: 'verified',
          phase2: {
            reason: `the archive could not be proposed (${r.code}: ${r.message}); retire the source with archive_page`,
            at: this.d.now(),
          },
        });
      }
    } finally {
      this.proposing.delete(rec.id);
    }
  }

  // ============================================================================================ revert

  /** Whether a job is a split's phase 1 (Revert applies to it although the owner approved it). */
  isPhase1(projectId: string, jobId: string): boolean {
    return this.byJob(projectId, jobId) !== null;
  }

  /** How many pages a split's phase 1 made (they go to a deletion proposal when it is reverted). */
  pagesMade(projectId: string, jobId: string): number {
    return (this.d.engine.stepRecords(projectId, jobId) ?? []).filter(
      (s) =>
        (s.opId === 'createResourceFromTemplate' || s.opId === 'createResource') &&
        s.status === 'succeeded' &&
        isObj(s.params.body) &&
        typeof s.params.body.id === 'string',
    ).length;
  }

  /** Whether a split's phase 1 has been reverted (it is never resumed then). */
  isReverted(projectId: string, jobId: string): boolean {
    return this.byJob(projectId, jobId)?.state === 'reverted';
  }

  /** CR-2026-11-R3 (R3-09): whether phase 2 archived the source (its archive note changed the source's text). */
  isRetired(projectId: string, jobId: string): boolean {
    return this.byJob(projectId, jobId)?.state === 'retired';
  }

  /** CR-2026-11-R3 (R3-66): the source phase 1 upgraded to its Character Core (only once its rename has run). */
  coreUpgrade(projectId: string, jobId: string): SplitUpgrade | null {
    const u = this.byJob(projectId, jobId)?.plan.upgrade ?? null;
    if (!u) return null;
    const ran = (this.d.engine.stepRecords(projectId, jobId) ?? []).some(
      (s) =>
        s.opId === 'updateResource' &&
        s.status === 'succeeded' &&
        s.params.path?.resourceId === u.resourceId &&
        isObj(s.params.body) &&
        s.params.body.name === u.to,
    );
    return ran ? u : null;
  }

  /**
   * CR-2026-11-R3 (R3-66): the steps putting an upgraded source back to its Compact Character Reference (its name, its
   * Reference Type, the Compact template recorded), numbered after `base` steps; or why not (it changed since).
   */
  private async compactAgain(
    projectId: string,
    u: SplitUpgrade,
    base: number,
    jobId: string,
  ): Promise<{ steps: StepSpec[] } | { why: string }> {
    let res: unknown;
    try {
      res = await this.d.engine.internalRead(
        projectId,
        'getResource',
        { path: { resourceId: u.resourceId } },
        { priority: 'P1', notFoundIsAnswer: true },
      );
    } catch (e) {
      return { why: `it could not be read (${e instanceof Error ? e.message : String(e)})` };
    }
    if (!isObj(res)) return { why: 'it is gone' };
    if (res.name !== u.to) return { why: `it is named “${str(res.name) ?? '?'}” now, not “${u.to}”` };
    const tags = Array.isArray(res.tags) ? res.tags.filter((t): t is string => typeof t === 'string') : [];
    const sidebar = sidebarFrom({ data: Array.isArray(res.properties) ? res.properties : [] });
    const journal = (write: string) => ({ tool: SPLIT_TOOL, revertOf: jobId, write });
    const steps: StepSpec[] = [
      {
        op: 'updateResource',
        params: { path: { resourceId: u.resourceId }, body: { name: u.from } },
        expectCurrent: { state: 'resource', hash: stateHash({ name: u.to, tags }), label: u.to },
        journalOperation: { ...journal(`rename back to ${u.from}`), page: { id: u.resourceId, name: u.to } },
      },
    ];
    if (u.templates.compact)
      steps.push({
        op: 'bridge.record',
        params: {
          body: {
            action: 'complete',
            store: 'pack',
            record: { kind: 'set_template', resourceId: u.resourceId, templateId: u.templates.compact },
          },
        },
      });
    if (u.referenceType.before !== null) {
      let fp;
      try {
        fp = planFacts({
          resourceId: u.resourceId,
          sidebar,
          propertyTitle: u.property,
          facts: [{ key: 'Reference Type', value: rowTextRuns(u.referenceType.before) }],
          links: [],
          templateKeys: null,
        });
      } catch (e) {
        if (e instanceof FactsPlanError)
          return { why: `its Reference Type cannot be put back (${e.message})` };
        throw e;
      }
      if (!fp.empty) {
        const fx = expandFacts(fp, { id: u.resourceId, name: u.from }, sidebar, {
          facts: [`Reference Type: ${u.referenceType.after} → ${u.referenceType.before}`],
          links: null,
        });
        const at = base + steps.length;
        for (const s of fx.steps) {
          const shifted = shiftStep(s, at);
          steps.push(
            s.journalOperation
              ? { ...shifted, journalOperation: { ...s.journalOperation, ...journal('Reference Type back') } }
              : shifted,
          );
        }
      }
    }
    return { steps };
  }

  /**
   * CR-2026-11-R3 (R3-10): which pages the split made still hold material that is not back in the source (read now):
   * each moved block of the job's own verification, in the source under its id with its content. Gives, for a page, a
   * short reason when something is not back (null when all of it is, or the page took nothing from the source).
   */
  private async notBackInSource(
    projectId: string,
    records: readonly { opId: string; params: { body?: unknown } }[],
  ): Promise<(pageId: string) => string | null> {
    const step = records.find((s) => {
      const checks = isObj(s.params.body) ? s.params.body.checks : null;
      return (
        s.opId === EXPECT_STEP &&
        Array.isArray(checks) &&
        isObj(checks[0]) &&
        checks[0].checker === SPLIT_CHECKS.verify
      );
    });
    const input = step
      ? ((step.params.body as { checks: { input: VerifyCheckInput }[] }).checks[0]!.input ?? null)
      : null;
    if (!input) return () => null;
    const moved = new Map<string, string[]>();
    for (const m of input.moves)
      if (m.kind === 'move' && m.dest)
        moved.set(m.dest.resourceId, [...(moved.get(m.dest.resourceId) ?? []), ...m.blocks]);
    if (moved.size === 0) return () => null;
    let blocks: Obj[] | null = null;
    try {
      const now = await this.d.engine.internalRead(
        projectId,
        'getDocumentBlocks',
        { path: { resourceId: input.source.resourceId, documentId: input.source.documentId } },
        { priority: 'P1', notFoundIsAnswer: true },
      );
      blocks = isObj(now) && Array.isArray(now.blocks) ? (now.blocks as unknown[]).filter(isObj) : [];
    } catch {
      blocks = null;
    }
    const byId = new Map((blocks ?? []).map((b) => [str(b.id) ?? '', b]));
    const original = new Map(input.original.map((o) => [o.id, o]));
    return (pageId) => {
      const ids = moved.get(pageId);
      if (!ids || ids.length === 0) return null;
      if (blocks === null) return 'the source could not be read to confirm it';
      const gone = ids.filter((id) => {
        const o = original.get(id);
        const b = byId.get(id);
        if (!o || !b) return true;
        return o.content !== undefined ? contentPrint(b) !== o.content : textPrint(b) !== o.text;
      });
      if (gone.length === 0) return null;
      const first = original.get(gone[0]!);
      const what = first?.excerpt ? `“${first.excerpt}”` : `block ${gone[0]}`;
      return `${gone.length} block${gone.length === 1 ? '' : 's'}, ${what}${gone.length > 1 ? ' among them' : ''}`;
    };
  }

  /**
   * After a revert of phase 1 has succeeded: the pages it made go to ONE deletion proposal, children before their
   * parents, each only while it is exactly as phase 1 made it (its text as written, its name).
   */
  async afterRevert(
    projectId: string,
    jobId: string,
    revertJobId: string | null,
  ): Promise<SplitRevert | null> {
    const rec = this.byJob(projectId, jobId);
    if (!rec) return null;
    const records = this.d.engine.stepRecords(projectId, jobId) ?? [];
    const deleted: { id: string; name: string }[] = [];
    // CR-2026-11-R3 (R3-21): how each page to delete was made (checked again when the deletion runs).
    const made_: Map<string, MadeCheckInput> = new Map();
    const kept: { id: string; name: string; why: string }[] = [];
    // CR-2026-11-R3 (R3-10): a page the split made is proposed for deletion only once the material it took is back in
    // the source (read now, block by block, by content): never its only copy.
    const notBack = await this.notBackInSource(projectId, records);
    // Every page the job made (a new index too), never one it did not make (left out, or the job stopped first).
    const made = records
      .filter(
        (s) =>
          (s.opId === 'createResourceFromTemplate' || s.opId === 'createResource') &&
          s.status === 'succeeded' &&
          isObj(s.params.body) &&
          typeof s.params.body.id === 'string',
      )
      .map((s) => {
        const body = s.params.body as Obj;
        const id = body.id as string;
        return {
          id,
          name: rec.plan.newPages.find((p) => p.id === id)?.name ?? str(body.name) ?? id,
        };
      });
    for (const p of made) {
      const missing = notBack(p.id);
      if (missing) {
        kept.push({ ...p, why: `the material it took is not back in ${rec.sourceName} (${missing})` });
        continue;
      }
      const text = [...records]
        .reverse()
        .find(
          (s) =>
            s.opId === 'replaceDocumentBlocks' &&
            s.status === 'succeeded' &&
            s.params.path?.resourceId === p.id,
        );
      try {
        const res = await this.d.engine.internalRead(
          projectId,
          'getResource',
          { path: { resourceId: p.id } },
          { priority: 'P1', notFoundIsAnswer: true },
        );
        if (!isObj(res)) {
          kept.push({ ...p, why: 'it is gone already' });
          continue;
        }
        const doc = mainDocumentOf(res);
        const sent =
          isObj(text?.params.body) && Array.isArray(text.params.body.blocks) ? text.params.body.blocks : null;
        if (doc && sent) {
          const now = await this.d.engine.internalRead(
            projectId,
            'getDocumentBlocks',
            { path: { resourceId: p.id, documentId: doc } },
            { priority: 'P1', notFoundIsAnswer: true },
          );
          const live = isObj(now) && Array.isArray(now.blocks) ? (now.blocks as unknown[]).filter(isObj) : [];
          const want = (sent as unknown[]).filter(isObj);
          // CR-2026-11-R3 (R3-21): the whole of each block (its formatting, rows and structure), not its words alone.
          const same =
            live.length === want.length &&
            live.every(
              (b, i) => str(b.id) === str(want[i]!.id) && contentPrint(b) === contentPrint(want[i]!),
            );
          if (!same) {
            kept.push({ ...p, why: 'its text changed since the split made it' });
            continue;
          }
          made_.set(p.id, {
            resourceId: p.id,
            name: str(res.name) ?? p.name,
            documentId: doc,
            blocks: want.map((b) => ({ id: str(b.id), content: contentPrint(b) })),
          });
        } else
          made_.set(p.id, {
            resourceId: p.id,
            name: str(res.name) ?? p.name,
            documentId: null,
            blocks: null,
          });
        deleted.push(p);
      } catch (e) {
        kept.push({ ...p, why: `it could not be read (${e instanceof Error ? e.message : String(e)})` });
      }
    }
    // Children first (a page made under another made page, as specialist pages under a new character index).
    const ids = new Set(deleted.map((p) => p.id));
    const depth = (id: string): number => {
      let n = 0;
      let cur = this.d.parentOf?.(projectId, id) ?? null;
      while (cur && ids.has(cur) && n < 50) {
        n++;
        cur = this.d.parentOf?.(projectId, cur) ?? null;
      }
      return n;
    };
    const order = [...deleted].sort((a, b) => depth(b.id) - depth(a.id));
    let deletionProposalId: string | null = null;
    let problem: string | undefined;
    // CR-2026-11-R3 (R3-66): a source phase 1 upgraded to its Character Core goes back to its Compact Character Reference
    // in the same proposal, after the deletions (renaming an Authoritative page is canon, which the owner approves), and
    // only when every page the split made goes with it: a page kept leaves the character several owners, and its Core.
    const up = this.coreUpgrade(projectId, jobId);
    let compact: StepSpec[] = [];
    let core: SplitRevert['core'];
    if (up) {
      if (kept.length > 0 || order.length === 0)
        core = {
          back: false,
          why: `${kept.length} page${kept.length === 1 ? '' : 's'} the split made ${kept.length === 1 ? 'is' : 'are'} kept, so ${up.to} stays the Character Core of several owners`,
        };
      else {
        const r = await this.compactAgain(projectId, up, order.length * 2, jobId);
        if ('steps' in r) {
          compact = r.steps;
          core = { back: true };
        } else core = { back: false, why: `${up.to} stays the Character Core: ${r.why}` };
      }
    }
    if (order.length > 0) {
      const summary = `Revert of split ${rec.id} (phase 1, job ${jobId}): delete the ${order.length} page${order.length === 1 ? '' : 's'} it made${core?.back === true ? `, then ${up!.to} back to ${up!.from} (Reference Type ${up!.referenceType.before ?? '?'})` : ''}; ${revertJobId ? `the moved material is back in ${rec.sourceName}` : `nothing had left ${rec.sourceName} yet`}. The pages: ${order.map((p) => p.name).join(', ')}.`;
      try {
        // CR-2026-11-R3 (R3-21): each page checked again just before its deletion, when the owner's approval runs.
        const steps: StepSpec[] = order.flatMap((p): StepSpec[] => [
          {
            op: EXPECT_STEP,
            params: {
              body: {
                checks: [
                  {
                    label: `${p.name}: as the split made it`,
                    kind: 'registered',
                    checker: SPLIT_CHECKS.made,
                    input: made_.get(p.id)!,
                  },
                ],
              },
            },
          },
          {
            op: 'deleteResource',
            params: { path: { resourceId: p.id } },
            journalOperation: {
              tool: SPLIT_TOOL,
              split: rec.id,
              revertOf: jobId,
              write: `the page ${p.name} the split made`,
            },
          },
        ]);
        steps.push(...compact);
        const r = await this.d.engine.submit({
          kind: 'batch_ops',
          project: projectId,
          steps,
          onError: 'stop',
          priority: 'P1',
          origin: {
            kind: 'ui',
            client: 'dashboard',
            tool: SPLIT_TOOL,
            detail: `revert:${jobId}`,
            principal: SYSTEM_PRINCIPAL,
          },
          title: summary.slice(0, 300),
          forceProposal: true,
          internal: true,
          // Part of the revert: no date of its own (the revert put Last Major Revision back where the split set it).
          lastMajorRevision: 'skip',
          proposal: { summary },
        });
        deletionProposalId = 'proposalId' in r && typeof r.proposalId === 'string' ? r.proposalId : null;
        if (!deletionProposalId) problem = 'the deletion was not captured as a proposal';
      } catch (e) {
        problem = e instanceof Error ? e.message : String(e);
      }
    }
    const revert: SplitRevert = {
      revertJobId,
      deletionProposalId,
      deleted: order,
      kept,
      ...(core ? { core } : {}),
      ...(problem ? { problem } : {}),
    };
    this.update(rec.id, { state: 'reverted', revert });
    this.d.audit('system', 'split.reverted', rec.id, null, {
      job: jobId,
      revertJob: revertJobId,
      deletionProposal: deletionProposalId,
      deleted: order.map((p) => p.id),
      kept: kept.map((p) => ({ id: p.id, why: p.why })),
    });
    return revert;
  }
}

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
import type { ProposalHooks } from '../../policy/proposals.js';
import type { ProposalView } from '../../policy/types.js';
import { blockText } from './blocks.js';
import { mainDocumentOf } from './checks.js';
import { SPLIT_TOOL } from './plan.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export type SplitState =
  'proposed' | 'running' | 'verified' | 'stopped' | 'retiring' | 'retired' | 'reverted' | 'closed';

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
  readonly revertJobId: string;
  /** The proposal deleting the pages phase 1 made (null when none could be proposed). */
  readonly deletionProposalId: string | null;
  readonly deleted: readonly { readonly id: string; readonly name: string }[];
  /** Pages kept because they changed since phase 1 made them (or could not be read). */
  readonly kept: readonly { readonly id: string; readonly name: string; readonly why: string }[];
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

/** Proposes archiving a page as the bridge (src/mcp/tools/lifecycle.ts `proposeArchiveByBridge`). */
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
          reason: `${why}: the source still owns material, so it is not retired. Propose those items again, then retire it with archive_page when nothing is left.`,
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
      const r = await this.archiver(rec.projectId, rec.sourceId, {
        detail: `split:${rec.id} phase 2`,
        summary: `phase 2 of split ${rec.id}: phase 1 verified (job ${job.id})`,
      });
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

  /**
   * After a revert of phase 1 has succeeded: the pages it made go to ONE deletion proposal, children before their
   * parents, each only while it is exactly as phase 1 made it (its text as written, its name).
   */
  async afterRevert(projectId: string, jobId: string, revertJobId: string): Promise<SplitRevert | null> {
    const rec = this.byJob(projectId, jobId);
    if (!rec) return null;
    const records = this.d.engine.stepRecords(projectId, jobId) ?? [];
    const deleted: { id: string; name: string }[] = [];
    const kept: { id: string; name: string; why: string }[] = [];
    for (const p of rec.plan.newPages) {
      const made = records.find(
        (s) =>
          (s.opId === 'createResourceFromTemplate' || s.opId === 'createResource') &&
          s.status === 'succeeded' &&
          isObj(s.params.body) &&
          s.params.body.id === p.id,
      );
      if (!made) continue; // never made (left out, or the job stopped first)
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
          const same =
            live.length === want.length &&
            live.every((b, i) => str(b.id) === str(want[i]!.id) && blockText(b) === blockText(want[i]!));
          if (!same) {
            kept.push({ ...p, why: 'its text changed since the split made it' });
            continue;
          }
        }
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
    if (order.length > 0) {
      const summary = `Revert of split ${rec.id} (phase 1, job ${jobId}): delete the ${order.length} page${order.length === 1 ? '' : 's'} it made (${order.map((p) => p.name).join(', ')}); the moved material is back in ${rec.sourceName}`;
      try {
        const steps: StepSpec[] = order.map((p) => ({
          op: 'deleteResource',
          params: { path: { resourceId: p.id } },
          journalOperation: {
            tool: SPLIT_TOOL,
            split: rec.id,
            revertOf: jobId,
            write: `the page ${p.name} the split made`,
          },
        }));
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

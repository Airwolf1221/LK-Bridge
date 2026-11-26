/**
 * Restore proposals (v2 E1a, ADR 0042): a restore plan becomes ONE proposal, whatever the caller's scope (`forceProposal`;
 * PLAN-v2 4.11: "made as proposals"), and the owner approves it on the Proposals page. Each is recorded
 * (`snapshot_restores`), so the dashboard can list them and so an undelete's second proposal (the page's content back to
 * the snapshot, planned against the page as it came back) follows once the undelete has run.
 */
import type { BackgroundRunner } from '../background.js';
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/open.js';
import { SYSTEM_PRINCIPAL, type JobEngine, type JobOrigin, type Principal } from '../jobs/index.js';
import {
  planRestore,
  RestoreError,
  type RestoreDeps,
  type RestoreEstimate,
  type RestoreInput,
  type RestorePlan,
} from './restore.js';
import type { SnapshotService } from './service.js';
import {
  countSteps,
  sequentialEstimate,
  type EstimateLike,
  type PlanEstimateInput,
} from './plan-estimate.js';

export interface RestoreRecord {
  readonly id: string;
  readonly projectId: string;
  readonly pageId: string;
  readonly pageName: string;
  readonly snapshotId: string;
  readonly scope: string;
  readonly mode: string | null;
  readonly documentId: string | null;
  readonly proposalId: string | null;
  /** v3 F12 (ADR 0081): the job a restore runs as when it was not proposed. */
  readonly jobId: string | null;
  readonly state: 'proposed' | 'running' | 'executed' | 'failed' | 'closed';
  readonly followUp: string | null;
  readonly followUpProposalId: string | null;
  readonly followUpJobId: string | null;
  readonly requestedBy: string;
  readonly summary: string;
  /** What the run could not restore exactly: a field LegendKeeper refused and the write went without (v2 E1a, ADR 0042). */
  readonly couldntRestoreExactly: readonly { readonly what: string; readonly why: string }[];
  readonly plan: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ProposeResult =
  | { readonly status: 'nothing_to_do'; readonly plan: RestorePlan }
  /**
   * v3 F12 (ADR 0081): run at once as one job: the owner confirmed it on the dashboard (`origin.ownerConfirmed`), or an
   * agent at scope `write` asked for it (on the owner's Review page). The record follows the job.
   */
  | {
      readonly status: 'submitted';
      readonly jobId: string;
      readonly summary: string;
      readonly restoreId: string;
      readonly plan: RestorePlan;
    }
  | {
      readonly status: 'proposal_captured';
      readonly proposalId: string;
      readonly summary: string | null;
      readonly canonical?: { readonly reason: string };
      readonly restoreId: string;
      readonly plan: RestorePlan;
    };

type Raw = Record<string, unknown>;

/** The operation a restore proposal keeps for the dashboard (its Markdown before and after, and what it cannot do). */
export function restoreOperation(plan: RestorePlan): Record<string, unknown> {
  const join = (k: 'before' | 'after') => plan.pieces.map((p) => `<!-- ${p.label} -->\n${p[k]}`).join('\n\n');
  return {
    tool: 'restore_snapshot',
    page: plan.page,
    scope: plan.scope,
    ...(plan.mode ? { mode: plan.mode } : {}),
    snapshot: {
      id: plan.snapshot.id,
      takenAt: new Date(plan.snapshot.takenAt).toISOString(),
      kind: plan.snapshot.kind,
    },
    pageParts: plan.parts,
    before: join('before'),
    after: join('after'),
    pieces: plan.pieces.map((p) => ({ label: p.label, diff: p.diff })),
    lost: plan.lost,
    kept: plan.kept,
    notRestored: plan.notRestored,
    warnings: plan.warnings,
    ...(plan.idMap ? { idMap: plan.idMap } : {}),
    ...(plan.followUp
      ? { followUp: 'After it runs, a second proposal brings the page’s content back to the snapshot.' }
      : {}),
  };
}

export class Restores {
  private detach: (() => void)[] = [];

  constructor(
    private readonly o: {
      readonly db: Db;
      readonly svc: SnapshotService;
      readonly engine: JobEngine;
      readonly deps: (projectId: string) => RestoreDeps;
      /** v2 E5.5: the project's governor estimate (undefined when it has no governor now). */
      readonly estimate?: (projectId: string, input: PlanEstimateInput) => EstimateLike | undefined;
      readonly now: () => number;
      /** v3 F6a.1: the runtime's background work: the second proposal is tracked there (awaited on stop). */
      readonly background?: Pick<BackgroundRunner, 'track'>;
      readonly log?: { warn(obj: Record<string, unknown>, msg: string): void };
    },
  ) {}

  async plan(input: RestoreInput): Promise<RestorePlan> {
    // CR-2026-11-R2 (R2-48): one restore of a deleted page at a time. While a recreate or an undelete of the page is still
    // a proposal or still running, another is refused: planned meanwhile, it is a second page (a recreate with new ids
    // beside the first, or beside the undeleted original), or a finish planned from a page the first job is still
    // writing (what that job writes after the plan would be written twice). Once it has ended, the same request
    // finishes a recreate that stopped part-way.
    if (input.scope === 'deleted') {
      const busy = this.deletedRestoreInProgress(input.projectId, input.pageId);
      if (busy)
        throw new RestoreError(
          'RESTORE_IN_PROGRESS',
          `A restore of this deleted page is still a proposal or still running (restore ${busy.id}, ${busy.mode ?? 'deleted'}${busy.proposalId ? `, proposal ${busy.proposalId}` : ''}). Wait until it has ended (or the owner has rejected it): a recreate that stopped part-way is then finished by the same request. Nothing was planned.`,
          { restoreId: busy.id, ...(busy.proposalId ? { proposalId: busy.proposalId } : {}) },
        );
    }
    const plan = await planRestore(
      {
        ...this.o.deps(input.projectId),
        recreatedTarget: (projectId, pageId, snapshotId) =>
          this.recreatedTarget(projectId, pageId, snapshotId),
      },
      input,
    );
    return plan.empty ? plan : { ...plan, estimate: this.estimate(input.projectId, plan) };
  }

  /**
   * v2 E5.5 (backlog 16): the restore's time once approved: its steps at P1, one after another, at the measured per-write
   * duration and the tiers' effective limits, learned operation groups included. The plan's own reads are already done.
   */
  private estimate(projectId: string, plan: RestorePlan): RestoreEstimate | null {
    if (!this.o.estimate) return null;
    const c = countSteps(plan.steps);
    let est: EstimateLike | undefined;
    try {
      est = this.o.estimate(projectId, { reads: c.reads, writes: c.writes, priority: 'P1', ops: c.ops });
    } catch {
      est = undefined; // an estimate never stops a restore being planned
    }
    if (!est) return null;
    return { reads: c.reads, writes: c.writes, ...sequentialEstimate(est, c) };
  }

  /** R2-48: the latest restore of the deleted page (a recreate or an undelete) still a proposal or running, or null. */
  private deletedRestoreInProgress(
    projectId: string,
    pageId: string,
  ): { id: string; mode: string | null; proposalId: string | null } | null {
    const r = this.o.db
      .prepare(
        `SELECT id, mode, proposal_id FROM snapshot_restores WHERE project_id = ? AND page_id = ? AND scope = 'deleted'
           AND state IN ('proposed', 'running') ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId, pageId) as { id: string; mode: string | null; proposal_id: string | null } | undefined;
    return r ? { id: r.id, mode: r.mode, proposalId: r.proposal_id } : null;
  }

  /**
   * v3 F2 (ADR 0049 decision 6): the page an earlier recreate of this page from this snapshot made, by its record: its
   * own id (`ids: original`) or the new one minted when that proposal was captured (its id map). Null when none was
   * proposed (or every one was closed).
   */
  recreatedTarget(projectId: string, pageId: string, snapshotId: string): string | null {
    const r = this.o.db
      .prepare(
        `SELECT plan FROM snapshot_restores WHERE project_id = ? AND page_id = ? AND snapshot_id = ? AND scope = 'deleted'
           AND mode = 'recreate' AND state <> 'closed' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId, pageId, snapshotId) as { plan: string } | undefined;
    if (!r) return null;
    try {
      const plan = JSON.parse(r.plan) as { idMap?: Record<string, string> | null };
      return plan.idMap?.[pageId] ?? pageId;
    } catch {
      return pageId;
    }
  }

  /**
   * v3 F2 (ADR 0049 decision 6): "Finish" on a recreate that stopped part-way: the same request proposed again, which
   * now plans only what the page it made still lacks.
   */
  async finish(projectId: string, restoreId: string, origin: JobOrigin, by: string): Promise<ProposeResult> {
    const r = this.o.db
      .prepare(
        'SELECT page_id, snapshot_id, scope, mode FROM snapshot_restores WHERE project_id = ? AND id = ?',
      )
      .get(projectId, restoreId) as
      { page_id: string; snapshot_id: string; scope: string; mode: string | null } | undefined;
    if (!r) throw new RestoreError('NOT_FOUND', `No restore ${restoreId} in this project.`);
    if (r.scope !== 'deleted' || r.mode !== 'recreate')
      throw new RestoreError(
        'NOT_A_RECREATE',
        'Only a recreate can be finished; propose the restore again instead.',
      );
    return this.propose(
      { projectId, pageId: r.page_id, snapshotId: r.snapshot_id, scope: 'deleted', mode: 'recreate' },
      origin,
      by,
    );
  }

  /**
   * Plans and submits a restore. `origin` is the caller's (an agent's MCP origin, or the dashboard's); its principal is
   * kept for the content stage. v3 F12 (ADR 0081): it runs as ONE job for the owner's confirmed dashboard action
   * (`ownerConfirmed`) and for an agent at scope `write`; it is ONE proposal for an agent at scope `propose` (the gate)
   * and for any other request of the bridge's own (forced, as before).
   */
  async propose(
    input: RestoreInput,
    origin: JobOrigin,
    requestedBy: string,
    planned?: RestorePlan,
  ): Promise<ProposeResult> {
    const plan = planned ?? (await this.plan(input));
    if (plan.empty) return { status: 'nothing_to_do', plan };
    // v3 F3d (ADR 0058): minted first, so a recreate's job knows its restore (Resume finishes it by its record).
    const id = `rst_${randomBytes(8).toString('hex')}`;
    const recreate = input.scope === 'deleted' && plan.mode === 'recreate';
    const ownWork =
      (origin.principal === undefined || origin.principal.principalId === SYSTEM_PRINCIPAL.principalId) &&
      origin.ownerConfirmed !== true;
    const r = await this.o.engine.submit({
      kind: 'batch_ops',
      project: input.projectId,
      steps: plan.steps,
      onError: 'stop',
      priority: 'P1',
      origin,
      title: plan.summary.slice(0, 300),
      ...(plan.holdLock ? { holdLock: plan.holdLock } : {}),
      ...(plan.holdDocuments ? { holdDocuments: plan.holdDocuments } : {}),
      ...(plan.lifecycle ? { lifecycle: plan.lifecycle } : {}),
      ...(input.lastMajorRevision ? { lastMajorRevision: input.lastMajorRevision } : {}),
      // v3 F3d (ADR 0058): a recreate that stops part-way is resumed by finishing it (F2's Finish, ADR 0049 decision 6).
      ...(recreate ? { resumable: { kind: 'recreate' as const, ref: id } } : {}),
      internal: true,
      ...(ownWork ? { forceProposal: true } : {}),
      proposal: {
        operation: restoreOperation(plan),
        operations: [
          {
            tool: 'restore_snapshot',
            page: plan.page,
            pageParts: plan.parts.length ? plan.parts : [plan.scope],
            summaryLabel: plan.summary,
          },
        ],
        summary: plan.summary,
      },
    });
    const proposalId = 'proposalId' in r && typeof r.proposalId === 'string' ? r.proposalId : null;
    const jobId = !proposalId && 'jobId' in r && typeof r.jobId === 'string' ? r.jobId : null;
    if (!proposalId && !jobId)
      throw new RestoreError('NOT_PROPOSED', 'The restore was neither run nor proposed; nothing was done.');
    const now = this.o.now();
    this.o.db
      .prepare(
        `INSERT INTO snapshot_restores (id, project_id, page_id, page_name, snapshot_id, scope, mode, document_id, proposal_id,
           job_id, state, follow_up, requested_by, summary, plan, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.pageId,
        plan.page.name,
        input.snapshotId,
        input.scope,
        plan.mode ?? null,
        input.documentId ?? null,
        proposalId,
        jobId,
        jobId ? 'running' : 'proposed',
        plan.followUp ?? null,
        requestedBy,
        plan.summary,
        JSON.stringify({
          principal: origin.principal ?? null,
          originKind: origin.kind,
          client: origin.client ?? null,
          ...(origin.ownerConfirmed === true ? { ownerConfirmed: true } : {}),
          idMap: plan.idMap ?? null,
          lost: plan.lost.length,
          notRestored: plan.notRestored.length,
        }),
        now,
        now,
      );
    if (jobId) return { status: 'submitted', jobId, summary: plan.summary, restoreId: id, plan };
    const canonical = (r as { canonical?: { reason: string } }).canonical;
    return {
      status: 'proposal_captured',
      proposalId: proposalId!,
      summary: (r as { summary?: string }).summary ?? null,
      ...(canonical ? { canonical: { reason: canonical.reason } } : {}),
      restoreId: id,
      plan,
    };
  }

  /**
   * Follows the restores: an executed undelete gets its content stage; a final state closes the record. A proposed
   * restore is followed by its proposal, one that runs at once (v3 F12) by its job.
   */
  attach(): () => void {
    const executed = (rec: RestoreRecord, jobId: string | null) => {
      this.setState(rec.id, 'executed');
      this.noteDropped(rec, jobId);
      if (rec.scope === 'image') this.noteImage(rec, jobId);
      if (rec.followUp === 'content') {
        const p = this.followUp(rec).catch((err: unknown) =>
          this.o.log?.warn({ err, restore: rec.id }, 'the restore’s content stage failed'),
        );
        void (this.o.background ? this.o.background.track('the restore’s content stage', p) : p);
      }
    };
    const off = this.o.engine.events.on('proposal', (e) => {
      if (e.type !== 'updated') return;
      const rec = this.byProposal(e.proposalId);
      if (!rec || rec.state !== 'proposed') return;
      if (e.state === 'executed') executed(rec, e.jobId);
      else if (['failed', 'conflicted', 'rejected', 'expired'].includes(e.state)) {
        this.setState(rec.id, e.state === 'failed' ? 'failed' : 'closed');
      }
    });
    this.detach.push(off);
    const offJobs = this.o.engine.events.on('job', (e) => {
      if (e.type !== 'updated') return;
      const st = e.job.status;
      if (st !== 'succeeded' && st !== 'failed' && st !== 'cancelled') return;
      const rec = this.byJob(e.job.projectId, e.job.id);
      if (!rec || rec.state !== 'running') return;
      if (st === 'succeeded') executed(rec, e.job.id);
      else this.setState(rec.id, st === 'failed' ? 'failed' : 'closed');
    });
    this.detach.push(offJobs);
    return () => {
      for (const d of this.detach.splice(0)) d();
    };
  }

  /** The content of an undeleted page back to the snapshot: a second proposal, planned against the page as it came back. */
  async followUp(rec: RestoreRecord): Promise<string | null> {
    const stored = rec.plan as {
      principal?: Principal | null;
      originKind?: string;
      client?: string | null;
      ownerConfirmed?: boolean;
    };
    // v3 F12 (ADR 0081): the content stage follows the first the same way: the owner's confirmed restore runs it at once.
    const confirmed = stored.ownerConfirmed === true ? { ownerConfirmed: true as const } : {};
    const origin: JobOrigin = stored.principal
      ? {
          kind: (stored.originKind as JobOrigin['kind']) ?? 'mcp',
          ...(stored.client ? { client: stored.client } : {}),
          tool: 'restore_snapshot',
          principal: stored.principal,
          ...confirmed,
        }
      : { kind: 'ui', client: 'owner', tool: 'restore_snapshot', ...confirmed };
    try {
      const r = await this.propose(
        { projectId: rec.projectId, pageId: rec.pageId, snapshotId: rec.snapshotId, scope: 'content' },
        origin,
        rec.requestedBy,
      );
      const pid = r.status === 'proposal_captured' ? r.proposalId : null;
      const jid = r.status === 'submitted' ? r.jobId : null;
      this.o.db
        .prepare(
          'UPDATE snapshot_restores SET follow_up_proposal_id = ?, follow_up_job_id = ?, follow_up = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          pid,
          jid,
          pid || jid ? 'content' : 'content: already as at the snapshot',
          this.o.now(),
          rec.id,
        );
      return pid ?? jid;
    } catch (e) {
      this.o.db
        .prepare('UPDATE snapshot_restores SET follow_up = ?, updated_at = ? WHERE id = ?')
        .run(
          `content: not proposed (${e instanceof Error ? e.message : String(e)})`.slice(0, 1000),
          this.o.now(),
          rec.id,
        );
      throw e;
    }
  }

  /**
   * ADR 0042 decision 9: a write LegendKeeper refused a field of (an icon name it does not know) went without it; the
   * restore still finished, and the record lists each such field as "could not be restored exactly".
   */
  private noteDropped(rec: RestoreRecord, jobId: string | null): void {
    if (!jobId) return;
    try {
      const dropped: { what: string; why: string }[] = [];
      for (const s of this.o.engine.stepResults(rec.projectId, jobId) ?? []) {
        const v = s.value as { droppedFields?: Record<string, unknown>; droppedWhere?: unknown } | null;
        if (!v || typeof v !== 'object' || !v.droppedFields) continue;
        for (const [field, value] of Object.entries(v.droppedFields))
          dropped.push({
            what: `${field} ${JSON.stringify(value)} (${typeof v.droppedWhere === 'string' ? v.droppedWhere : `step ${s.stepNo}`})`,
            why: 'LegendKeeper refused it, so it was left out and LegendKeeper’s default applies; set it by hand',
          });
      }
      if (dropped.length === 0) return;
      this.o.db
        .prepare('UPDATE snapshot_restores SET plan = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify({ ...rec.plan, couldntRestoreExactly: dropped }), this.o.now(), rec.id);
    } catch (err) {
      this.o.log?.warn({ err, restore: rec.id }, 'could not note what a restore left out');
    }
  }

  /**
   * v3 F3c (ADR 0051 decision 3): an image restore's job has run. Its record gains the new asset (id and URL, which
   * exist only now) and, when a page that showed the old URL changed after the proposal and its relink was refused, an
   * `image_relink_failed` follow-up naming the pages left to relink by hand (never retried; the asset stays).
   */
  private noteImage(rec: RestoreRecord, jobId: string | null): void {
    if (!jobId) return;
    try {
      const plan = rec.plan as { assetStep?: unknown };
      const steps = this.o.engine.stepResults(rec.projectId, jobId) ?? [];
      const made = steps.find((x) => x.stepNo === plan.assetStep && x.status === 'succeeded')?.value as
        { id?: unknown; url?: unknown } | undefined;
      const job = this.o.engine.queries.getJob(rec.projectId, jobId);
      const followUps = (
        ((job?.result ?? {}) as { followUps?: { kind?: unknown; pageId?: unknown; reason?: unknown }[] })
          .followUps ?? []
      ).filter((f) => f.kind === 'image_relink_failed');
      const pages = [...new Set(followUps.map((f) => (typeof f.pageId === 'string' ? f.pageId : '?')))];
      this.o.db
        .prepare('UPDATE snapshot_restores SET plan = ?, follow_up = ?, updated_at = ? WHERE id = ?')
        .run(
          JSON.stringify({
            ...rec.plan,
            ...(typeof made?.id === 'string' ? { newAsset: { id: made.id, url: made.url ?? null } } : {}),
            ...(followUps.length > 0
              ? { notRelinked: followUps.map((f) => ({ pageId: f.pageId, reason: f.reason })) }
              : {}),
          }),
          followUps.length > 0
            ? `image_relink_failed: the image was restored, but ${pages.length} page(s) changed since the proposal and still show the old URL (${pages.join(', ')}); relink them by hand to the new asset`.slice(
                0,
                1000,
              )
            : rec.followUp,
          this.o.now(),
          rec.id,
        );
    } catch (err) {
      this.o.log?.warn({ err, restore: rec.id }, 'could not note what an image restore did');
    }
  }

  private setState(id: string, state: RestoreRecord['state']): void {
    this.o.db
      .prepare('UPDATE snapshot_restores SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, this.o.now(), id);
  }

  /** v3 F3d (ADR 0058): one restore record of a project, by its id, or null. */
  record(projectId: string, id: string): RestoreRecord | null {
    const r = this.o.db
      .prepare('SELECT * FROM snapshot_restores WHERE project_id = ? AND id = ?')
      .get(projectId, id) as Raw | undefined;
    return r ? recordOf(r) : null;
  }

  /** v3 F12: the restore a job runs (its first stage), or null. */
  byJob(projectId: string, jobId: string): RestoreRecord | null {
    const r = this.o.db
      .prepare('SELECT * FROM snapshot_restores WHERE project_id = ? AND job_id = ?')
      .get(projectId, jobId) as Raw | undefined;
    return r ? recordOf(r) : null;
  }

  byProposal(proposalId: string): RestoreRecord | null {
    const r = this.o.db.prepare('SELECT * FROM snapshot_restores WHERE proposal_id = ?').get(proposalId) as
      Raw | undefined;
    return r ? recordOf(r) : null;
  }

  list(projectId: string, o: { readonly pageId?: string; readonly limit?: number } = {}): RestoreRecord[] {
    const rows = (
      o.pageId
        ? this.o.db
            .prepare(
              'SELECT * FROM snapshot_restores WHERE project_id = ? AND page_id = ? ORDER BY created_at DESC LIMIT ?',
            )
            .all(projectId, o.pageId, o.limit ?? 50)
        : this.o.db
            .prepare('SELECT * FROM snapshot_restores WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
            .all(projectId, o.limit ?? 50)
    ) as Raw[];
    return rows.map(recordOf);
  }
}

function recordOf(r: Raw): RestoreRecord {
  const json = (v: unknown) => {
    try {
      return typeof v === 'string' ? (JSON.parse(v) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    pageId: String(r.page_id),
    pageName: String(r.page_name),
    snapshotId: String(r.snapshot_id),
    scope: String(r.scope),
    mode: typeof r.mode === 'string' ? r.mode : null,
    documentId: typeof r.document_id === 'string' ? r.document_id : null,
    proposalId: typeof r.proposal_id === 'string' ? r.proposal_id : null,
    jobId: typeof r.job_id === 'string' ? r.job_id : null,
    state: r.state as RestoreRecord['state'],
    followUp: typeof r.follow_up === 'string' ? r.follow_up : null,
    followUpProposalId: typeof r.follow_up_proposal_id === 'string' ? r.follow_up_proposal_id : null,
    followUpJobId: typeof r.follow_up_job_id === 'string' ? r.follow_up_job_id : null,
    requestedBy: String(r.requested_by),
    summary: String(r.summary),
    couldntRestoreExactly: Array.isArray(json(r.plan).couldntRestoreExactly)
      ? (json(r.plan).couldntRestoreExactly as { what: string; why: string }[])
      : [],
    plan: json(r.plan),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

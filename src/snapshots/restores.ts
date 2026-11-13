/**
 * Restore proposals (v2 E1a, ADR 0042): a restore plan becomes ONE proposal, whatever the caller's scope (`forceProposal`;
 * PLAN-v2 4.11: "made as proposals"), and the owner approves it on the Proposals page. Each is recorded
 * (`snapshot_restores`), so the dashboard can list them and so an undelete's second proposal (the page's content back to
 * the snapshot, planned against the page as it came back) follows once the undelete has run.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/open.js';
import type { JobEngine, JobOrigin, Principal } from '../jobs/index.js';
import {
  planRestore,
  RestoreError,
  type RestoreDeps,
  type RestoreInput,
  type RestorePlan,
} from './restore.js';
import type { SnapshotService } from './service.js';

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
  readonly state: 'proposed' | 'executed' | 'failed' | 'closed';
  readonly followUp: string | null;
  readonly followUpProposalId: string | null;
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
      readonly now: () => number;
      readonly log?: { warn(obj: Record<string, unknown>, msg: string): void };
    },
  ) {}

  plan(input: RestoreInput): Promise<RestorePlan> {
    return planRestore(this.o.deps(input.projectId), input);
  }

  /**
   * Plans and submits a restore as one proposal. `origin` is the caller's (an agent's MCP origin, or the dashboard's);
   * its principal is kept for the follow-up proposal.
   */
  async propose(
    input: RestoreInput,
    origin: JobOrigin,
    requestedBy: string,
    planned?: RestorePlan,
  ): Promise<ProposeResult> {
    const plan = planned ?? (await this.plan(input));
    if (plan.empty) return { status: 'nothing_to_do', plan };
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
      internal: true,
      forceProposal: true,
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
    if (!('proposalId' in r) || typeof r.proposalId !== 'string')
      throw new RestoreError('NOT_PROPOSED', 'The restore was not captured as a proposal; nothing was done.');
    const id = `rst_${randomBytes(8).toString('hex')}`;
    const now = this.o.now();
    this.o.db
      .prepare(
        `INSERT INTO snapshot_restores (id, project_id, page_id, page_name, snapshot_id, scope, mode, document_id, proposal_id, state,
           follow_up, requested_by, summary, plan, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)`,
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
        r.proposalId,
        plan.followUp ?? null,
        requestedBy,
        plan.summary,
        JSON.stringify({
          principal: origin.principal ?? null,
          originKind: origin.kind,
          client: origin.client ?? null,
          idMap: plan.idMap ?? null,
          lost: plan.lost.length,
          notRestored: plan.notRestored.length,
        }),
        now,
        now,
      );
    const canonical = (r as { canonical?: { reason: string } }).canonical;
    return {
      status: 'proposal_captured',
      proposalId: r.proposalId,
      summary: (r as { summary?: string }).summary ?? null,
      ...(canonical ? { canonical: { reason: canonical.reason } } : {}),
      restoreId: id,
      plan,
    };
  }

  /** Follows the restore proposals: an executed undelete gets its content proposal; a final state closes the record. */
  attach(): () => void {
    const off = this.o.engine.events.on('proposal', (e) => {
      if (e.type !== 'updated') return;
      const rec = this.byProposal(e.proposalId);
      if (!rec || rec.state !== 'proposed') return;
      if (e.state === 'executed') {
        this.setState(rec.id, 'executed');
        this.noteDropped(rec, e.jobId);
        if (rec.followUp === 'content')
          void this.followUp(rec).catch((err: unknown) =>
            this.o.log?.warn({ err, restore: rec.id }, 'the restore’s second proposal failed'),
          );
      } else if (['failed', 'conflicted', 'rejected', 'expired'].includes(e.state)) {
        this.setState(rec.id, e.state === 'failed' ? 'failed' : 'closed');
      }
    });
    this.detach.push(off);
    return () => {
      for (const d of this.detach.splice(0)) d();
    };
  }

  /** The content of an undeleted page back to the snapshot: a second proposal, planned against the page as it came back. */
  async followUp(rec: RestoreRecord): Promise<string | null> {
    const stored = rec.plan as { principal?: Principal | null; originKind?: string; client?: string | null };
    const origin: JobOrigin = stored.principal
      ? {
          kind: (stored.originKind as JobOrigin['kind']) ?? 'mcp',
          ...(stored.client ? { client: stored.client } : {}),
          tool: 'restore_snapshot',
          principal: stored.principal,
        }
      : { kind: 'ui', client: 'owner', tool: 'restore_snapshot' };
    try {
      const r = await this.propose(
        { projectId: rec.projectId, pageId: rec.pageId, snapshotId: rec.snapshotId, scope: 'content' },
        origin,
        rec.requestedBy,
      );
      const pid = r.status === 'proposal_captured' ? r.proposalId : null;
      this.o.db
        .prepare(
          'UPDATE snapshot_restores SET follow_up_proposal_id = ?, follow_up = ?, updated_at = ? WHERE id = ?',
        )
        .run(pid, pid ? 'content' : 'content: already as at the snapshot', this.o.now(), rec.id);
      return pid;
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

  private setState(id: string, state: RestoreRecord['state']): void {
    this.o.db
      .prepare('UPDATE snapshot_restores SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, this.o.now(), id);
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
    state: r.state as RestoreRecord['state'],
    followUp: typeof r.follow_up === 'string' ? r.follow_up : null,
    followUpProposalId: typeof r.follow_up_proposal_id === 'string' ? r.follow_up_proposal_id : null,
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

/**
 * v3 F5c (ADR 0069, H6): `arkona_identity_reconcile`'s records (`identity_reconciles`): one per submitted call (a job or
 * a proposal), with every item as planned (refused ones included) and, once its job has ended, every item's outcome and
 * consistency follow-ups. The tool's `report` and the workstream report read them back, free.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/open.js';

type Obj = Record<string, unknown>;

export type ItemStatus =
  /** Facts and tags written and read back as planned (or the page already held them). */
  | 'done'
  /** Facts written and read back; the tags were held, skipped or not written, and why. */
  | 'partly_done'
  /** Nothing written: the page changed since it was read (or was gone); the others carried on. */
  | 'skipped'
  /** A write failed, or its outcome is unknown; the rest of the item was not run. */
  | 'failed'
  /** The job stopped before reaching the item (Resume continues it). */
  | 'not_run'
  /** Refused when planned (an unmapped value, a rename, a protected fact, an ambiguous name). */
  | 'refused'
  /** Left out by the owner when approving the proposal. */
  | 'excluded';

/** One item as planned. */
export interface PlannedItem {
  readonly item: string;
  /** What the caller named. */
  readonly asked: string;
  readonly character: string;
  readonly page: { readonly id: string; readonly name: string; readonly role: string } | null;
  readonly status: 'planned' | 'refused' | 'no_change';
  readonly refusal?: { readonly code: string; readonly message: string } & Obj;
  readonly facts?: readonly { key: string; before: string | null; after: string; change: string }[];
  readonly factsVersion?: string;
  readonly tags?: {
    readonly status: 'write' | 'held' | 'already_correct' | 'not_applicable' | 'off';
    readonly current: readonly string[];
    readonly proposed: readonly string[];
    readonly reason?: string;
    readonly disposition?: string | null;
    /** The old identity value's own token, replaced by the new value's (never inferred). */
    readonly replaced?: readonly { readonly tag: string; readonly why: string }[];
  };
  readonly nameCheck?: Obj;
}

export interface ItemOutcome {
  readonly item: string;
  readonly character: string;
  readonly page: { readonly id: string; readonly name: string } | null;
  readonly status: ItemStatus;
  readonly reason?: string;
  readonly facts?: {
    readonly written: boolean;
    readonly verified: boolean | null;
    readonly detail?: unknown;
  };
  readonly tags?: { readonly status: string; readonly reason?: string; readonly verified?: boolean | null };
  readonly followUps?: readonly Obj[];
}

export interface IdentityRecord {
  readonly id: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly workstream: string | null;
  readonly jobId: string | null;
  readonly proposalId: string | null;
  readonly state: 'proposed' | 'running' | 'finished' | 'rejected';
  readonly plan: { readonly items: readonly PlannedItem[]; readonly reconcileTags: boolean } & Obj;
  readonly outcome: ({ readonly items: readonly ItemOutcome[]; readonly summary: string } & Obj) | null;
  readonly createdAt: number;
  readonly finishedAt: number | null;
}

interface Row {
  id: string;
  project_id: string;
  principal_id: string;
  workstream: string | null;
  job_id: string | null;
  proposal_id: string | null;
  state: IdentityRecord['state'];
  plan: string;
  outcome: string | null;
  created_at: number;
  finished_at: number | null;
}

const toRecord = (r: Row): IdentityRecord => ({
  id: r.id,
  projectId: r.project_id,
  principalId: r.principal_id,
  workstream: r.workstream,
  jobId: r.job_id,
  proposalId: r.proposal_id,
  state: r.state,
  plan: JSON.parse(r.plan) as IdentityRecord['plan'],
  outcome: r.outcome ? (JSON.parse(r.outcome) as IdentityRecord['outcome']) : null,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

export class IdentityRecords {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  save(r: {
    readonly projectId: string;
    readonly principalId: string;
    readonly workstream: string | null;
    readonly jobId: string | null;
    readonly proposalId: string | null;
    readonly plan: IdentityRecord['plan'];
  }): IdentityRecord {
    const id = `idr_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    this.db
      .prepare(
        `INSERT INTO identity_reconciles (id, project_id, principal_id, workstream, job_id, proposal_id, state, plan,
           created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        r.projectId,
        r.principalId,
        r.workstream,
        r.jobId,
        r.proposalId,
        r.proposalId && !r.jobId ? 'proposed' : 'running',
        JSON.stringify(r.plan),
        this.now(),
      );
    return this.get(id)!;
  }

  get(id: string): IdentityRecord | null {
    const r = this.db.prepare('SELECT * FROM identity_reconciles WHERE id = ?').get(id) as Row | undefined;
    return r ? toRecord(r) : null;
  }

  byJob(projectId: string, jobId: string): IdentityRecord | null {
    const r = this.db
      .prepare(
        'SELECT * FROM identity_reconciles WHERE project_id = ? AND job_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(projectId, jobId) as Row | undefined;
    return r ? toRecord(r) : null;
  }

  byProposal(proposalId: string): IdentityRecord | null {
    const r = this.db.prepare('SELECT * FROM identity_reconciles WHERE proposal_id = ?').get(proposalId) as
      Row | undefined;
    return r ? toRecord(r) : null;
  }

  setJob(id: string, jobId: string): void {
    this.db
      .prepare(
        "UPDATE identity_reconciles SET job_id = ?, state = 'running', outcome = NULL, finished_at = NULL WHERE id = ?",
      )
      .run(jobId, id);
  }

  setState(id: string, state: IdentityRecord['state']): void {
    this.db.prepare('UPDATE identity_reconciles SET state = ? WHERE id = ?').run(state, id);
  }

  finish(id: string, outcome: NonNullable<IdentityRecord['outcome']>): void {
    this.db
      .prepare("UPDATE identity_reconciles SET outcome = ?, state = 'finished', finished_at = ? WHERE id = ?")
      .run(JSON.stringify(outcome), this.now(), id);
  }
}

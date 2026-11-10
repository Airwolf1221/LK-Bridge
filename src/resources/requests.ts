/**
 * Request coordination for the create tools (v2 C2b, ADR 0034; PLAN-v2 4.13 and section 9). Two stores, one database:
 *
 * - **`operation_id`**: an optional id on every create, kept per project and principal with a hash of the normalised
 *   request. `begin` reserves it atomically before anything is planned or sent: the same id with the same request is a
 *   `repeat` (the earlier result: its job, its outcome, or its proposal; nothing is written twice), the same id with a
 *   different request is `reused` (refused), and an id whose first call is still planning is `in_progress`. A call that
 *   ends without a job or proposal (a refusal, a dry run) releases its reservation, so the id can be used again. Rows
 *   are kept at least as long as the journal (`retentionMs`).
 * - **Claims**: a request for a named thing (a character, by its name key) while another request for the same thing is
 *   still planning, queued, running or a pending proposal is a duplicate, across principals, so two agents cannot both
 *   create one character. Once the first has finished, the claim no longer counts, and placement's return-existing finds
 *   the page it made.
 *
 * Node runs one call's synchronous code at a time and every check-and-reserve here is one SQLite transaction, so two
 * overlapping calls cannot both pass.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/open.js';
import { stableJson } from '../jobs/sidebar-state.js';

/** Job states in which the work is still to happen (or happening). */
const ACTIVE_JOB_STATES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'waiting_budget',
  'waiting_lock',
  'paused',
]);
/** Proposal states in which the work may still happen. */
const ACTIVE_PROPOSAL_STATES: ReadonlySet<string> = new Set(['pending', 'approved', 'executing']);

/** A request still planning (no job or proposal yet) counts for this long; after it, it was abandoned (a crash). */
export const PLANNING_TTL_MS = 5 * 60_000;

export interface OperationRow {
  readonly projectId: string;
  readonly principalId: string;
  readonly operationId: string;
  readonly tool: string;
  readonly requestHash: string;
  readonly state: 'reserved' | 'job' | 'proposal' | 'answered';
  readonly jobId: string | null;
  readonly proposalId: string | null;
  readonly result: Record<string, unknown> | null;
  readonly createdAt: number;
}

export type BeginResult =
  | { readonly kind: 'new' }
  | { readonly kind: 'repeat'; readonly row: OperationRow }
  | { readonly kind: 'reused'; readonly row: OperationRow }
  | { readonly kind: 'in_progress'; readonly row: OperationRow };

export interface ClaimRow {
  readonly claimKey: string;
  readonly principalId: string;
  readonly tool: string;
  readonly label: string;
  readonly jobId: string | null;
  readonly proposalId: string | null;
  readonly createdAt: number;
}

export type ClaimResult =
  { readonly ok: true; readonly token: number } | { readonly ok: false; readonly holder: ClaimRow };

/** Trimmed strings, no `undefined`, keys in order: two requests that mean the same give the same hash. */
export function normaliseRequest(v: unknown): unknown {
  if (typeof v === 'string') return v.trim().replace(/\s+/g, ' ');
  if (Array.isArray(v)) return v.map(normaliseRequest);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === undefined) continue;
      out[k] = normaliseRequest(x);
    }
    return out;
  }
  return v;
}

/** The hash of a tool's request (its arguments without `operation_id`, `project`, `dryRun` and `detail`). */
export function requestHash(tool: string, args: Record<string, unknown>): string {
  const { operation_id: _o, project: _p, dryRun: _d, detail: _x, ...rest } = args;
  return createHash('sha256')
    .update(stableJson({ tool, request: normaliseRequest(rest) }))
    .digest('hex');
}

interface OpDbRow {
  project_id: string;
  principal_id: string;
  operation_id: string;
  tool: string;
  request_hash: string;
  state: OperationRow['state'];
  job_id: string | null;
  proposal_id: string | null;
  result: string | null;
  created_at: number;
}

const opRow = (r: OpDbRow): OperationRow => ({
  projectId: r.project_id,
  principalId: r.principal_id,
  operationId: r.operation_id,
  tool: r.tool,
  requestHash: r.request_hash,
  state: r.state,
  jobId: r.job_id,
  proposalId: r.proposal_id,
  result: r.result ? (JSON.parse(r.result) as Record<string, unknown>) : null,
  createdAt: r.created_at,
});

export class RequestRegistry {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    /** How long operation ids are kept: at least the journal's retention. */
    private readonly retentionMs: number,
  ) {}

  // ============================================================================================ operation_id

  /** Reserves `operationId` for this request, or says what the earlier call with it was. */
  begin(
    projectId: string,
    principalId: string,
    operationId: string,
    tool: string,
    hash: string,
  ): BeginResult {
    const at = this.now();
    return this.db.transaction((): BeginResult => {
      this.db.prepare('DELETE FROM operation_ids WHERE created_at < ?').run(at - this.retentionMs);
      const got = this.db
        .prepare('SELECT * FROM operation_ids WHERE project_id = ? AND principal_id = ? AND operation_id = ?')
        .get(projectId, principalId, operationId) as OpDbRow | undefined;
      if (got) {
        const row = opRow(got);
        if (row.requestHash !== hash || row.tool !== tool) return { kind: 'reused', row };
        if (row.state === 'reserved') {
          if (at - row.createdAt < PLANNING_TTL_MS) return { kind: 'in_progress', row };
          // Abandoned (the bridge stopped while it planned): nothing was submitted, so it starts again.
          this.db
            .prepare(
              'UPDATE operation_ids SET created_at = ?, updated_at = ? WHERE project_id = ? AND principal_id = ? AND operation_id = ?',
            )
            .run(at, at, projectId, principalId, operationId);
          return { kind: 'new' };
        }
        return { kind: 'repeat', row };
      }
      this.db
        .prepare(
          `INSERT INTO operation_ids (project_id, principal_id, operation_id, tool, request_hash, state, created_at,
             updated_at) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)`,
        )
        .run(projectId, principalId, operationId, tool, hash, at, at);
      return { kind: 'new' };
    })();
  }

  /** Records what the reserved operation became: its job, its proposal, or an answer with neither. */
  settle(
    projectId: string,
    principalId: string,
    operationId: string,
    o: { jobId?: string; proposalId?: string; result: Record<string, unknown> },
  ): void {
    const state = o.jobId ? 'job' : o.proposalId ? 'proposal' : 'answered';
    this.db
      .prepare(
        `UPDATE operation_ids SET state = ?, job_id = ?, proposal_id = ?, result = ?, updated_at = ?
          WHERE project_id = ? AND principal_id = ? AND operation_id = ?`,
      )
      .run(
        state,
        o.jobId ?? null,
        o.proposalId ?? null,
        JSON.stringify(o.result),
        this.now(),
        projectId,
        principalId,
        operationId,
      );
  }

  /** Frees a reservation that produced nothing (a refusal, a dry run): the id can be used again. */
  releaseOperation(projectId: string, principalId: string, operationId: string): void {
    this.db
      .prepare(
        `DELETE FROM operation_ids WHERE project_id = ? AND principal_id = ? AND operation_id = ? AND state = 'reserved'`,
      )
      .run(projectId, principalId, operationId);
  }

  /** A proposal's state now (and its job once approved), for an `operation_id` repeat. */
  proposalState(projectId: string, proposalId: string): { state: string; jobId: string | null } | null {
    const r = this.db
      .prepare('SELECT state, job_id FROM proposals WHERE id = ? AND project_id = ?')
      .get(proposalId, projectId) as { state: string; job_id: string | null } | undefined;
    return r ? { state: r.state, jobId: r.job_id } : null;
  }

  // ============================================================================================ claims

  /** Whether a claim's request may still create its thing (planning, queued, running, or a pending proposal). */
  isActive(c: Pick<ClaimRow, 'jobId' | 'proposalId' | 'createdAt'>, projectId: string): boolean {
    if (c.jobId) {
      const j = this.db
        .prepare('SELECT status FROM jobs WHERE id = ? AND project_id = ?')
        .get(c.jobId, projectId) as { status: string } | undefined;
      return j !== undefined && ACTIVE_JOB_STATES.has(j.status);
    }
    if (c.proposalId) {
      const p = this.db
        .prepare('SELECT state, job_id FROM proposals WHERE id = ? AND project_id = ?')
        .get(c.proposalId, projectId) as { state: string; job_id: string | null } | undefined;
      if (!p) return false;
      if (p.state === 'executing' && p.job_id)
        return this.isActive({ ...c, proposalId: null, jobId: p.job_id }, projectId);
      return ACTIVE_PROPOSAL_STATES.has(p.state);
    }
    return this.now() - c.createdAt < PLANNING_TTL_MS;
  }

  /** Claims `claimKey` for this request, or names the request that holds it now. */
  claim(projectId: string, claimKey: string, principalId: string, tool: string, label: string): ClaimResult {
    return this.db.transaction((): ClaimResult => {
      const got = this.db
        .prepare('SELECT * FROM request_claims WHERE project_id = ? AND claim_key = ?')
        .get(projectId, claimKey) as
        | {
            claim_key: string;
            principal_id: string;
            tool: string;
            label: string;
            job_id: string | null;
            proposal_id: string | null;
            created_at: number;
          }
        | undefined;
      if (got) {
        const holder: ClaimRow = {
          claimKey: got.claim_key,
          principalId: got.principal_id,
          tool: got.tool,
          label: got.label,
          jobId: got.job_id,
          proposalId: got.proposal_id,
          createdAt: got.created_at,
        };
        if (this.isActive(holder, projectId)) return { ok: false, holder };
      }
      let at = this.now();
      if (got && got.created_at >= at) at = got.created_at + 1; // the token tells this claim from the one it replaced
      this.db
        .prepare(
          `INSERT INTO request_claims (project_id, claim_key, principal_id, tool, label, job_id, proposal_id, created_at,
             updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
           ON CONFLICT (project_id, claim_key) DO UPDATE SET principal_id = excluded.principal_id, tool = excluded.tool,
             label = excluded.label, job_id = NULL, proposal_id = NULL, created_at = excluded.created_at,
             updated_at = excluded.updated_at`,
        )
        .run(projectId, claimKey, principalId, tool, label, at, at);
      return { ok: true, token: at };
    })();
  }

  /** Records the job or proposal that carries a claim's request. */
  bind(projectId: string, claimKey: string, token: number, o: { jobId?: string; proposalId?: string }): void {
    this.db
      .prepare(
        `UPDATE request_claims SET job_id = ?, proposal_id = ?, updated_at = ?
          WHERE project_id = ? AND claim_key = ? AND created_at = ?`,
      )
      .run(o.jobId ?? null, o.proposalId ?? null, this.now(), projectId, claimKey, token);
  }

  /** Drops a claim that produced nothing (a refusal, a dry run, a returned existing page). */
  releaseClaim(projectId: string, claimKey: string, token: number): void {
    this.db
      .prepare('DELETE FROM request_claims WHERE project_id = ? AND claim_key = ? AND created_at = ?')
      .run(projectId, claimKey, token);
  }
}

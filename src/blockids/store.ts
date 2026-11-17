/** SQLite state of the block-id sweep (migration 3300, ADR 0056). */
import type { Db } from '../db/open.js';

export type DocStatus = 'done' | 'already' | 'moved' | 'unverified' | 'failed' | 'gone' | 'error';
export type SandboxVerdict = 'PASS' | 'NOTED' | 'FAIL';

export interface SandboxCheckRecord {
  readonly id: number;
  readonly bridgeVersion: string;
  readonly project: string;
  readonly verdict: SandboxVerdict;
  readonly detail: string | null;
  readonly at: number;
}

/** Where a verification failure stopped the sweep (the Maintenance card shows it in red). */
export interface StopRecord {
  readonly projectId: string;
  readonly project: string;
  readonly resourceId: string;
  readonly documentId: string;
  readonly page: string | null;
  readonly jobId: string | null;
  readonly journalId: number | null;
  readonly reason: string;
  readonly differences: readonly {
    readonly path: string;
    readonly expected: unknown;
    readonly actual: unknown;
  }[];
}

export interface SweepState {
  readonly maxPerRun: number;
  readonly override: { readonly at: number; readonly by: string } | null;
  readonly stop: (StopRecord & { readonly at: number; readonly acknowledgedAt: number | null }) | null;
}

export interface DocRecord {
  readonly projectId: string;
  readonly documentId: string;
  readonly resourceId: string;
  readonly status: DocStatus;
  readonly jobId: string | null;
  readonly journalId: number | null;
  readonly assigned: number | null;
  readonly detail: string | null;
  readonly attempts: number;
  readonly updatedAt: number;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const toDoc = (r: Row): DocRecord => ({
  projectId: String(r.project_id),
  documentId: String(r.document_id),
  resourceId: String(r.resource_id),
  status: r.status as DocStatus,
  jobId: (r.job_id as string | null) ?? null,
  journalId: num(r.journal_id),
  assigned: num(r.assigned),
  detail: (r.detail as string | null) ?? null,
  attempts: Number(r.attempts ?? 0),
  updatedAt: Number(r.updated_at),
});

export class BlockIdStore {
  constructor(
    readonly db: Db,
    private readonly now: () => number,
  ) {}

  // ------------------------------------------------------------------------------------------ the sandbox check

  /** Records one verdict of the sandbox check (test/sandbox/assign-block-ids.test.ts). */
  recordSandboxCheck(r: {
    bridgeVersion: string;
    project: string;
    verdict: SandboxVerdict;
    detail?: string;
  }): void {
    this.db
      .prepare(
        'INSERT INTO block_id_sandbox_checks (bridge_version, project, verdict, detail, at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(r.bridgeVersion, r.project, r.verdict, r.detail?.slice(0, 4000) ?? null, this.now());
  }

  /** The newest PASS for this bridge version, or null. */
  passFor(bridgeVersion: string): SandboxCheckRecord | null {
    const r = this.db
      .prepare(
        `SELECT * FROM block_id_sandbox_checks WHERE bridge_version = ? AND verdict = 'PASS' ORDER BY id DESC LIMIT 1`,
      )
      .get(bridgeVersion) as Row | undefined;
    return r ? toCheck(r) : null;
  }

  /** The newest verdicts of any version (the card shows them). */
  latestChecks(limit = 5): SandboxCheckRecord[] {
    return (
      this.db.prepare('SELECT * FROM block_id_sandbox_checks ORDER BY id DESC LIMIT ?').all(limit) as Row[]
    ).map(toCheck);
  }

  // ------------------------------------------------------------------------------------------ settings and the stop

  state(): SweepState {
    const r = this.db.prepare('SELECT * FROM block_id_sweep_state WHERE id = 1').get() as Row | undefined;
    if (!r) return { maxPerRun: 20, override: null, stop: null };
    let stop: SweepState['stop'] = null;
    if (typeof r.stop_detail === 'string' && r.stopped_at !== null) {
      try {
        stop = {
          ...(JSON.parse(r.stop_detail) as StopRecord),
          at: Number(r.stopped_at),
          acknowledgedAt: num(r.stop_acknowledged_at),
        };
      } catch {
        stop = null;
      }
    }
    return {
      maxPerRun: Number(r.max_per_run),
      override:
        r.override_at !== null && r.override_at !== undefined
          ? { at: Number(r.override_at), by: typeof r.override_by === 'string' ? r.override_by : 'owner' }
          : null,
      stop,
    };
  }

  setMaxPerRun(n: number): void {
    this.db
      .prepare('UPDATE block_id_sweep_state SET max_per_run = ?, updated_at = ? WHERE id = 1')
      .run(n, this.now());
  }

  setOverride(on: boolean, by: string): void {
    this.db
      .prepare(
        'UPDATE block_id_sweep_state SET override_at = ?, override_by = ?, updated_at = ? WHERE id = 1',
      )
      .run(on ? this.now() : null, on ? by : null, this.now());
  }

  recordStop(s: StopRecord): void {
    this.db
      .prepare(
        `UPDATE block_id_sweep_state SET stop_detail = ?, stopped_at = ?, stop_acknowledged_at = NULL, updated_at = ?
         WHERE id = 1`,
      )
      .run(JSON.stringify(s), this.now(), this.now());
  }

  /** The owner enabled the job again after a stop: the stop stays on record, no longer in red. */
  acknowledgeStop(): void {
    this.db
      .prepare(
        `UPDATE block_id_sweep_state SET stop_acknowledged_at = ?, updated_at = ?
         WHERE id = 1 AND stopped_at IS NOT NULL AND stop_acknowledged_at IS NULL`,
      )
      .run(this.now(), this.now());
  }

  // ------------------------------------------------------------------------------------------ documents

  doc(projectId: string, documentId: string): DocRecord | null {
    const r = this.db
      .prepare('SELECT * FROM block_id_sweep_docs WHERE project_id = ? AND document_id = ?')
      .get(projectId, documentId) as Row | undefined;
    return r ? toDoc(r) : null;
  }

  docs(projectId: string, status?: DocStatus): DocRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM block_id_sweep_docs WHERE project_id = ?${status ? ' AND status = ?' : ''}
           ORDER BY updated_at DESC, document_id`,
        )
        .all(projectId, ...(status ? [status] : [])) as Row[]
    ).map(toDoc);
  }

  setDoc(r: {
    projectId: string;
    documentId: string;
    resourceId: string;
    status: DocStatus;
    jobId?: string | null;
    journalId?: number | null;
    assigned?: number | null;
    detail?: string | null;
    attempt?: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO block_id_sweep_docs
           (project_id, document_id, resource_id, status, job_id, journal_id, assigned, detail, attempts, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, document_id) DO UPDATE SET
           resource_id = excluded.resource_id, status = excluded.status,
           job_id = COALESCE(excluded.job_id, block_id_sweep_docs.job_id),
           journal_id = COALESCE(excluded.journal_id, block_id_sweep_docs.journal_id),
           assigned = COALESCE(excluded.assigned, block_id_sweep_docs.assigned),
           detail = excluded.detail,
           attempts = block_id_sweep_docs.attempts + excluded.attempts,
           updated_at = excluded.updated_at`,
      )
      .run(
        r.projectId,
        r.documentId,
        r.resourceId,
        r.status,
        r.jobId ?? null,
        r.journalId ?? null,
        r.assigned ?? null,
        r.detail?.slice(0, 2000) ?? null,
        r.attempt ? 1 : 0,
        this.now(),
      );
  }

  /** The journal entry of a job's step (the pre-image of the `assignBlockIds` the sweep sent), or null. */
  journalId(jobId: string, stepNo: number): number | null {
    const r = this.db
      .prepare('SELECT id FROM write_journal WHERE job_id = ? AND step_no = ? ORDER BY id DESC LIMIT 1')
      .get(jobId, stepNo) as { id: number } | undefined;
    return r ? Number(r.id) : null;
  }

  /** A journal entry's pre-image, parsed (null when it is gone or unreadable). */
  journalPreImage(id: number): unknown {
    const r = this.db.prepare('SELECT pre_image FROM write_journal WHERE id = ?').get(id) as
      { pre_image: string | null } | undefined;
    if (!r?.pre_image) return null;
    try {
      return JSON.parse(r.pre_image);
    } catch {
      return null;
    }
  }
}

function toCheck(r: Row): SandboxCheckRecord {
  return {
    id: Number(r.id),
    bridgeVersion: String(r.bridge_version),
    project: String(r.project),
    verdict: r.verdict as SandboxVerdict,
    detail: (r.detail as string | null) ?? null,
    at: Number(r.at),
  };
}

/**
 * The review queue of direct writes (v3 F3.4, ADR 0055 decision A): one `direct_writes` row per job an agent ran
 * directly at scope `write` (no proposal, no approval), made when the job is created. The queue lists a row once its
 * job has finished and written something (a journal entry applied, or possibly applied), until the owner marks it
 * reviewed or reverts it. Approved proposals (the owner saw them before they happened) and the bridge's own work never
 * get a row.
 */
import type { Db } from '../db/open.js';

export type ReviewedVia = 'review' | 'bulk' | 'revert';

export interface DirectWriteRow {
  readonly jobId: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly profile: string;
  readonly tool: string | null;
  readonly createdAt: number;
  readonly reviewedAt: number | null;
  readonly reviewedBy: string | null;
  readonly reviewedVia: ReviewedVia | null;
}

/** Which items a list shows. */
export interface ReviewFilter {
  readonly state?: 'unreviewed' | 'reviewed' | 'all';
  readonly profile?: string;
  readonly principalId?: string;
  readonly tool?: string;
  /** Only items created before this time (ms), for paging back. */
  readonly before?: number;
  readonly limit?: number;
}

interface Row {
  job_id: string;
  project_id: string;
  principal_id: string;
  profile: string;
  tool: string | null;
  created_at: number;
  reviewed_at: number | null;
  reviewed_by: string | null;
  reviewed_via: ReviewedVia | null;
}

const toRow = (r: Row): DirectWriteRow => ({
  jobId: r.job_id,
  projectId: r.project_id,
  principalId: r.principal_id,
  profile: r.profile,
  tool: r.tool,
  createdAt: r.created_at,
  reviewedAt: r.reviewed_at,
  reviewedBy: r.reviewed_by,
  reviewedVia: r.reviewed_via,
});

/** A finished job that wrote something (applied, or possibly applied). */
const LISTED = `j.status IN ('succeeded', 'failed', 'cancelled')
  AND EXISTS (SELECT 1 FROM write_journal w WHERE w.job_id = d.job_id AND w.outcome IN ('applied', 'unknown'))`;

export class ReviewStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  /** Records a direct-write job (idempotent). */
  record(r: {
    readonly jobId: string;
    readonly projectId: string;
    readonly principalId: string;
    readonly profile: string;
    readonly tool: string | null;
    readonly createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO direct_writes (job_id, project_id, principal_id, profile, tool, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(r.jobId, r.projectId, r.principalId, r.profile, r.tool?.slice(0, 200) ?? null, r.createdAt);
  }

  get(projectId: string, jobId: string): DirectWriteRow | null {
    const r = this.db
      .prepare('SELECT * FROM direct_writes WHERE job_id = ? AND project_id = ?')
      .get(jobId, projectId) as Row | undefined;
    return r ? toRow(r) : null;
  }

  /** Whether the job is listed now (finished, and wrote something). */
  listed(projectId: string, jobId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM direct_writes d JOIN jobs j ON j.id = d.job_id
           WHERE d.job_id = ? AND d.project_id = ? AND ${LISTED}`,
        )
        .get(jobId, projectId) !== undefined
    );
  }

  private where(projectId: string, f: ReviewFilter): { sql: string; vals: unknown[] } {
    const where = ['d.project_id = ?', LISTED];
    const vals: unknown[] = [projectId];
    const state = f.state ?? 'unreviewed';
    if (state === 'unreviewed') where.push('d.reviewed_at IS NULL');
    if (state === 'reviewed') where.push('d.reviewed_at IS NOT NULL');
    if (f.profile !== undefined) {
      where.push('d.profile = ?');
      vals.push(f.profile);
    }
    if (f.principalId !== undefined) {
      where.push('d.principal_id = ?');
      vals.push(f.principalId);
    }
    if (f.tool !== undefined) {
      where.push('d.tool = ?');
      vals.push(f.tool);
    }
    if (f.before !== undefined) {
      where.push('d.created_at < ?');
      vals.push(f.before);
    }
    return { sql: where.join(' AND '), vals };
  }

  /** Newest first. */
  list(projectId: string, f: ReviewFilter = {}): DirectWriteRow[] {
    const w = this.where(projectId, f);
    return (
      this.db
        .prepare(
          `SELECT d.* FROM direct_writes d JOIN jobs j ON j.id = d.job_id WHERE ${w.sql}
           ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`,
        )
        .all(...w.vals, Math.min(Math.max(f.limit ?? 50, 1), 1000)) as Row[]
    ).map(toRow);
  }

  count(projectId: string, f: ReviewFilter = {}): number {
    const w = this.where(projectId, f);
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM direct_writes d JOIN jobs j ON j.id = d.job_id WHERE ${w.sql}`)
        .get(...w.vals) as { n: number }
    ).n;
  }

  /** Unreviewed items per project (the badge of every project), each at most `cap`. */
  unreviewedByProject(cap = 500): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT d.project_id AS project, COUNT(*) AS n FROM direct_writes d JOIN jobs j ON j.id = d.job_id
         WHERE d.reviewed_at IS NULL AND ${LISTED} GROUP BY d.project_id`,
      )
      .all() as { project: string; n: number }[];
    return new Map(rows.map((r) => [r.project, Math.min(r.n, cap)]));
  }

  /** Marks items reviewed (those already reviewed are left as they are). Returns the ids marked now. */
  markReviewed(projectId: string, jobIds: readonly string[], by: string, via: ReviewedVia): string[] {
    const at = this.now();
    const set = this.db.prepare(
      `UPDATE direct_writes SET reviewed_at = ?, reviewed_by = ?, reviewed_via = ?
       WHERE job_id = ? AND project_id = ? AND reviewed_at IS NULL`,
    );
    const done: string[] = [];
    this.db.transaction(() => {
      for (const id of jobIds) if (set.run(at, by, via, id, projectId).changes > 0) done.push(id);
    })();
    return done;
  }

  /** The unreviewed ids a filter covers (for "Mark all reviewed"), newest first, at most `cap`. */
  unreviewedIds(projectId: string, f: ReviewFilter, cap: number): string[] {
    return this.list(projectId, { ...f, state: 'unreviewed', limit: cap }).map((r) => r.jobId);
  }

  /** The distinct agents (profiles) and tools of a project's items, for the filters. */
  facets(projectId: string): { profiles: string[]; tools: string[] } {
    const col = (c: 'profile' | 'tool') =>
      (
        this.db
          .prepare(
            `SELECT DISTINCT ${c} AS v FROM direct_writes WHERE project_id = ? AND ${c} IS NOT NULL ORDER BY ${c}`,
          )
          .all(projectId) as { v: string }[]
      ).map((r) => r.v);
    return { profiles: col('profile'), tools: col('tool') };
  }
}

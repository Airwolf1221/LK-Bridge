/**
 * v3 F6d (ADR 0082): the Templated Names report as the newest audit run judged it, and the owner's "Keep this name"
 * rulings (migration 5000).
 */
import { createHash } from 'node:crypto';
import type { Db } from '../../db/open.js';
import { prepared } from '../../db/statements.js';
import { STATUSES, type TemplatedRow, type TemplatedStatus } from './template.js';

export interface NameRuling {
  readonly projectId: string;
  readonly pageId: string;
  readonly pageName: string;
  readonly subject: string | null;
  readonly referenceType: string | null;
  readonly hash: string;
  readonly reason: string;
  readonly by: string;
  readonly at: number;
}

export interface ReportMeta {
  readonly runId: string;
  readonly builtAt: number;
  readonly snapshotId: string;
  readonly takenAt: number;
  readonly excluded: Readonly<Record<string, number>>;
}

export interface RowFilter {
  readonly status?: readonly TemplatedStatus[];
  readonly category?: string;
  readonly page?: string;
  readonly offset?: number;
  readonly limit?: number;
}

interface RowRecord {
  project_id: string;
  page_id: string;
  ord: number;
  raw_name: string;
  display_name: string;
  parent_id: string | null;
  category: string | null;
  subject: string | null;
  reference_type: string | null;
  role: string | null;
  proposed: string | null;
  status: TemplatedStatus;
  reason: string;
  hash: string;
  other_id: string | null;
  other_name: string | null;
}

const toRow = (r: RowRecord): TemplatedRow => ({
  pageId: r.page_id,
  rawName: r.raw_name,
  displayName: r.display_name,
  parentId: r.parent_id,
  category: r.category,
  subject: r.subject,
  referenceType: r.reference_type,
  role: r.role,
  proposed: r.proposed,
  status: r.status,
  reason: r.reason,
  hash: r.hash,
  ...(r.other_id ? { other: { id: r.other_id, name: r.other_name ?? r.other_id } } : {}),
});

/** Rows written per statement batch (each batch is one transaction of the whole replace). */
const CHUNK = 500;

export class TemplatedNameStore {
  private changes = 0;

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  /** Changes whenever a report or a ruling changes (a cache key). */
  version(): number {
    return this.changes;
  }

  // ============================================================================================ the report

  /**
   * Replaces the project's report with a run's rows (one transaction). A report equal to the stored one (its digest) is
   * not written again: only the run it came from is recorded.
   */
  replace(projectId: string, meta: Omit<ReportMeta, 'builtAt'>, rows: readonly TemplatedRow[]): void {
    const h = createHash('sha256');
    for (const r of rows)
      h.update(
        `${r.pageId}\u0000${r.rawName}\u0000${r.status}\u0000${r.proposed ?? ''}\u0000${r.hash}\u0000${r.reason}\u0000${r.category ?? ''}\u0000${r.other?.id ?? ''}\n`,
      );
    const digest = h.digest('hex');
    const had = prepared(this.db, 'SELECT digest FROM templated_name_reports WHERE project_id = ?').get(
      projectId,
    ) as { digest: string } | undefined;
    if (had?.digest === digest) {
      prepared(
        this.db,
        `UPDATE templated_name_reports SET run_id = ?, built_at = ?, snapshot_id = ?, taken_at = ?, excluded = ?
         WHERE project_id = ?`,
      ).run(meta.runId, this.now(), meta.snapshotId, meta.takenAt, JSON.stringify(meta.excluded), projectId);
      return;
    }
    const del = prepared(this.db, 'DELETE FROM templated_name_rows WHERE project_id = ?');
    const ins = prepared(
      this.db,
      `INSERT INTO templated_name_rows (project_id, page_id, ord, raw_name, display_name, parent_id, category, subject,
         reference_type, role, proposed, status, reason, hash, other_id, other_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const meta1 = prepared(
      this.db,
      `INSERT INTO templated_name_reports (project_id, run_id, built_at, snapshot_id, taken_at, excluded, digest)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET run_id = excluded.run_id, built_at = excluded.built_at,
         snapshot_id = excluded.snapshot_id, taken_at = excluded.taken_at, excluded = excluded.excluded,
         digest = excluded.digest`,
    );
    this.db.transaction(() => {
      del.run(projectId);
      for (let i = 0; i < rows.length; i += CHUNK)
        for (const [k, r] of rows.slice(i, i + CHUNK).entries())
          ins.run(
            projectId,
            r.pageId,
            i + k,
            r.rawName,
            r.displayName,
            r.parentId,
            r.category,
            r.subject,
            r.referenceType,
            r.role,
            r.proposed,
            r.status,
            r.reason.slice(0, 1000),
            r.hash,
            r.other?.id ?? null,
            r.other?.name ?? null,
          );
      meta1.run(
        projectId,
        meta.runId,
        this.now(),
        meta.snapshotId,
        meta.takenAt,
        JSON.stringify(meta.excluded),
        digest,
      );
    })();
    this.changes++;
  }

  meta(projectId: string): ReportMeta | null {
    const r = prepared(this.db, 'SELECT * FROM templated_name_reports WHERE project_id = ?').get(
      projectId,
    ) as
      | { run_id: string; built_at: number; snapshot_id: string; taken_at: number; excluded: string }
      | undefined;
    if (!r) return null;
    let excluded: Record<string, number>;
    try {
      excluded = JSON.parse(r.excluded) as Record<string, number>;
    } catch {
      excluded = {};
    }
    return { runId: r.run_id, builtAt: r.built_at, snapshotId: r.snapshot_id, takenAt: r.taken_at, excluded };
  }

  /** One row by page (null: not in the report). */
  row(projectId: string, pageId: string): TemplatedRow | null {
    const r = prepared(this.db, 'SELECT * FROM templated_name_rows WHERE project_id = ? AND page_id = ?').get(
      projectId,
      pageId,
    ) as RowRecord | undefined;
    return r ? toRow(r) : null;
  }

  /**
   * A page of rows, the owner's rulings laid over them (a row whose hash matches its page's ruling reads `kept`), and the
   * counts per status for the whole report under the category filter. Paged in SQL: O(rows), never pages × rows.
   */
  rows(
    projectId: string,
    f: RowFilter,
  ): { rows: TemplatedRow[]; total: number; counts: Record<TemplatedStatus, number>; categories: string[] } {
    // The effective status in SQL: a matching ruling makes the row `kept`.
    const eff = `CASE WHEN k.hash IS NOT NULL AND k.hash = r.hash THEN 'kept' ELSE r.status END`;
    const from = `FROM templated_name_rows r LEFT JOIN templated_name_rulings k
      ON k.project_id = r.project_id AND k.page_id = r.page_id`;
    const where: string[] = ['r.project_id = ?'];
    const args: unknown[] = [projectId];
    if (f.category !== undefined && f.category !== '') {
      where.push(f.category === '(none)' ? 'r.category IS NULL' : 'r.category = ?');
      if (f.category !== '(none)') args.push(f.category);
    }
    if (f.page) {
      where.push("(r.page_id = ? OR r.raw_name LIKE ? ESCAPE '\\')");
      args.push(f.page, `%${f.page.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const countRows = this.db
      .prepare(`SELECT ${eff} AS s, COUNT(*) AS n ${from} WHERE ${where.join(' AND ')} GROUP BY s`)
      .all(...args) as { s: TemplatedStatus; n: number }[];
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<TemplatedStatus, number>;
    for (const c of countRows) if (c.s in counts) counts[c.s] = c.n;
    const statuses = (f.status ?? []).filter((s) => (STATUSES as readonly string[]).includes(s));
    const w2 = [...where];
    const a2 = [...args];
    if (statuses.length > 0) {
      w2.push(`${eff} IN (${statuses.map(() => '?').join(', ')})`);
      a2.push(...statuses);
    }
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${w2.join(' AND ')}`).get(...a2) as { n: number }
    ).n;
    const limit = Math.max(1, Math.min(f.limit ?? 100, 500));
    const offset = Math.max(0, f.offset ?? 0);
    const list = this.db
      .prepare(`SELECT r.*, ${eff} AS eff ${from} WHERE ${w2.join(' AND ')} ORDER BY r.ord LIMIT ? OFFSET ?`)
      .all(...a2, limit, offset) as (RowRecord & { eff: TemplatedStatus })[];
    const categories = (
      prepared(
        this.db,
        'SELECT DISTINCT category FROM templated_name_rows WHERE project_id = ? AND category IS NOT NULL ORDER BY category',
      ).all(projectId) as { category: string }[]
    ).map((x) => x.category);
    return {
      rows: list.map((r) =>
        r.eff === 'kept' && r.status !== 'kept'
          ? {
              ...toRow(r),
              status: 'kept' as const,
              proposed: null,
              reason:
                'the owner’s ruling “Keep this name” (it lapses when the Subject, the Reference Type or the name changes)',
            }
          : toRow(r),
      ),
      total,
      counts,
      categories,
    };
  }

  // ============================================================================================ rulings

  rulings(projectId: string): NameRuling[] {
    return (
      prepared(this.db, 'SELECT * FROM templated_name_rulings WHERE project_id = ?').all(projectId) as {
        project_id: string;
        page_id: string;
        page_name: string;
        subject: string | null;
        reference_type: string | null;
        hash: string;
        reason: string;
        by: string;
        at: number;
      }[]
    ).map((r) => ({
      projectId: r.project_id,
      pageId: r.page_id,
      pageName: r.page_name,
      subject: r.subject,
      referenceType: r.reference_type,
      hash: r.hash,
      reason: r.reason,
      by: r.by,
      at: r.at,
    }));
  }

  ruling(projectId: string, pageId: string): NameRuling | null {
    return this.rulings(projectId).find((r) => r.pageId === pageId) ?? null;
  }

  keep(
    projectId: string,
    by: string,
    r: {
      pageId: string;
      pageName: string;
      subject: string | null;
      referenceType: string | null;
      hash: string;
      reason: string;
    },
  ): NameRuling {
    prepared(
      this.db,
      `INSERT INTO templated_name_rulings (project_id, page_id, page_name, subject, reference_type, hash, reason, by, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, page_id) DO UPDATE SET page_name = excluded.page_name, subject = excluded.subject,
         reference_type = excluded.reference_type, hash = excluded.hash, reason = excluded.reason, by = excluded.by,
         at = excluded.at`,
    ).run(
      projectId,
      r.pageId,
      r.pageName.slice(0, 500),
      r.subject,
      r.referenceType,
      r.hash,
      r.reason.slice(0, 1000),
      by,
      this.now(),
    );
    this.changes++;
    return this.ruling(projectId, r.pageId)!;
  }

  remove(projectId: string, pageId: string): boolean {
    const n = prepared(
      this.db,
      'DELETE FROM templated_name_rulings WHERE project_id = ? AND page_id = ?',
    ).run(projectId, pageId).changes;
    if (n > 0) this.changes++;
    return n > 0;
  }
}

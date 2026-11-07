/**
 * The write journal (PLAN §6.4): a pre-image captured before each destructive write, so a person can see (and by
 * hand restore) what was there. View-only in v1: no automated rollback.
 *
 * What is captured: the blocks JSON before `replaceDocumentBlocks` / `replaceBlock` / block deletes, the board before
 * `replaceBoardContent` / `deleteBoardShapes`, the resource before `updateResource` / `moveResource`, the document
 * before `updateDocument`, the property before `updateProperty`, rows and infobox properties before their deletes,
 * the calendar before `updateCalendar` / `deleteCalendar`, and only the ids for other deletes and member removals.
 */
import type { Db } from '../db/open.js';

export interface JournalEntryInput {
  readonly jobId?: string | undefined;
  readonly stepNo?: number | undefined;
  readonly opId: string;
  readonly risk: string;
  readonly targetKind: string;
  readonly targetId?: string | null | undefined;
  readonly resourceId?: string | null | undefined;
  readonly documentId?: string | null | undefined;
  readonly version?: string | null | undefined;
  readonly params?: unknown;
  readonly preImage?: unknown;
}

export type JournalOutcome = 'pending' | 'applied' | 'not_applied' | 'unknown';

export interface JournalEntry {
  readonly id: number;
  readonly at: number;
  readonly jobId: string | null;
  readonly stepNo: number | null;
  readonly opId: string;
  readonly risk: string;
  readonly targetKind: string;
  readonly targetId: string | null;
  readonly resourceId: string | null;
  readonly documentId: string | null;
  readonly version: string | null;
  readonly params: unknown;
  /** Present unless the lookup asked for `includePreImage: false`. Null for id-only entries. */
  readonly preImage?: unknown;
  readonly bytes: number;
  readonly outcome: JournalOutcome;
}

export interface JournalFilter {
  readonly jobId?: string;
  readonly resourceId?: string;
  readonly documentId?: string;
  readonly targetId?: string;
  readonly opId?: string;
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
  /** Default true. False returns only the metadata (cheap listing). */
  readonly includePreImage?: boolean;
}

export interface JournalRetention {
  readonly retentionDays: number;
  readonly maxBytes: number;
}

/** Caps the stored params of a write: the ids and flags matter, a 1 MB body does not. */
const PARAMS_CAP_BYTES = 16 * 1024;

interface Row {
  id: number;
  at: number;
  job_id: string | null;
  step_no: number | null;
  op_id: string;
  risk: string;
  target_kind: string;
  target_id: string | null;
  resource_id: string | null;
  document_id: string | null;
  version: string | null;
  params: string | null;
  pre_image?: string | null;
  bytes: number;
  outcome: JournalOutcome;
}

function parse(text: string | null | undefined): unknown {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function capParams(params: unknown): string | null {
  if (params === undefined) return null;
  const text = JSON.stringify(params);
  if (Buffer.byteLength(text) <= PARAMS_CAP_BYTES) return text;
  const p = params as { path?: unknown; query?: unknown; ifMatch?: unknown };
  return JSON.stringify({ path: p.path, query: p.query, ifMatch: p.ifMatch, bodyOmitted: true });
}

export class WriteJournal {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  /** Records an entry before the write is sent. Returns its id (for `setOutcome`). */
  record(e: JournalEntryInput): number {
    const pre = e.preImage === undefined ? null : JSON.stringify(e.preImage);
    const params = capParams(e.params);
    const bytes = Buffer.byteLength(pre ?? '') + Buffer.byteLength(params ?? '');
    const info = this.db
      .prepare(
        `INSERT INTO write_journal (at, job_id, step_no, op_id, risk, target_kind, target_id, resource_id,
           document_id, version, params, pre_image, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now(),
        e.jobId ?? null,
        e.stepNo ?? null,
        e.opId,
        e.risk,
        e.targetKind,
        e.targetId ?? null,
        e.resourceId ?? null,
        e.documentId ?? null,
        e.version ?? null,
        params,
        pre,
        bytes,
      );
    return Number(info.lastInsertRowid);
  }

  setOutcome(id: number, outcome: JournalOutcome): void {
    this.db.prepare('UPDATE write_journal SET outcome = ? WHERE id = ?').run(outcome, id);
  }

  /** Sets the outcome of the latest entry for a step (used after a restart, when the entry id is not in memory). */
  setOutcomeForStep(jobId: string, stepNo: number, outcome: JournalOutcome): void {
    this.db
      .prepare(
        `UPDATE write_journal SET outcome = ? WHERE id = (
           SELECT id FROM write_journal WHERE job_id = ? AND step_no = ? ORDER BY id DESC LIMIT 1)`,
      )
      .run(outcome, jobId, stepNo);
  }

  /** Whether a step already has a journal entry (a resumed step does not record a second pre-image). */
  hasEntry(jobId: string, stepNo: number): boolean {
    return (
      this.db.prepare('SELECT 1 FROM write_journal WHERE job_id = ? AND step_no = ? LIMIT 1').get(jobId, stepNo) !==
      undefined
    );
  }

  lookup(filter: JournalFilter = {}): JournalEntry[] {
    return journalLookup(this.db, filter);
  }

  prune(retention: JournalRetention): { removedByAge: number; removedBySize: number; bytes: number } {
    return pruneJournal(this.db, retention, this.now());
  }
}

/** `bridge_journal_lookup` and the UI's journal view. Newest first. */
export function journalLookup(db: Db, filter: JournalFilter = {}): JournalEntry[] {
  const where: string[] = [];
  const vals: unknown[] = [];
  const eq = (col: string, v: unknown) => {
    where.push(`${col} = ?`);
    vals.push(v);
  };
  if (filter.jobId !== undefined) eq('job_id', filter.jobId);
  if (filter.resourceId !== undefined) eq('resource_id', filter.resourceId);
  if (filter.documentId !== undefined) eq('document_id', filter.documentId);
  if (filter.targetId !== undefined) eq('target_id', filter.targetId);
  if (filter.opId !== undefined) eq('op_id', filter.opId);
  if (filter.since !== undefined) {
    where.push('at >= ?');
    vals.push(filter.since);
  }
  if (filter.until !== undefined) {
    where.push('at <= ?');
    vals.push(filter.until);
  }
  const withPre = filter.includePreImage !== false;
  const cols = `id, at, job_id, step_no, op_id, risk, target_kind, target_id, resource_id, document_id, version,
    params, bytes, outcome${withPre ? ', pre_image' : ''}`;
  const rows = db
    .prepare(
      `SELECT ${cols} FROM write_journal ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT ?`,
    )
    .all(...vals, Math.min(filter.limit ?? 50, 1000)) as Row[];
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    jobId: r.job_id,
    stepNo: r.step_no,
    opId: r.op_id,
    risk: r.risk,
    targetKind: r.target_kind,
    targetId: r.target_id,
    resourceId: r.resource_id,
    documentId: r.document_id,
    version: r.version,
    params: parse(r.params),
    ...(withPre ? { preImage: parse(r.pre_image) } : {}),
    bytes: r.bytes,
    outcome: r.outcome,
  }));
}

/**
 * Retention (PLAN §6.4, default 30 days or 2 GB): drops entries older than `retentionDays`, then the oldest entries
 * until the journal fits in `maxBytes`. The scheduled `journal-prune` maintenance job (chunk 6) calls this.
 */
export function pruneJournal(
  db: Db,
  retention: JournalRetention,
  nowMs: number = Date.now(),
): { removedByAge: number; removedBySize: number; bytes: number } {
  return db.transaction(() => {
    const cutoff = nowMs - retention.retentionDays * 86_400_000;
    const removedByAge = db.prepare('DELETE FROM write_journal WHERE at < ?').run(cutoff).changes;
    let total = (db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM write_journal').get() as { b: number }).b;
    let removedBySize = 0;
    if (total > retention.maxBytes) {
      const rows = db.prepare('SELECT id, bytes FROM write_journal ORDER BY id').iterate() as IterableIterator<{
        id: number;
        bytes: number;
      }>;
      let lastId = 0;
      for (const r of rows) {
        if (total <= retention.maxBytes) break;
        total -= r.bytes;
        lastId = r.id;
        removedBySize++;
      }
      if (lastId > 0) db.prepare('DELETE FROM write_journal WHERE id <= ?').run(lastId);
    }
    return { removedByAge, removedBySize, bytes: total };
  })();
}

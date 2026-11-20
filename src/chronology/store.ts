/**
 * The chronology's own tables (v2 D1, ADR 0038; migration 1800): cached calendar definitions, the record of each
 * chronology change (for resuming one that stopped part-way), the links between the bridge's own rows and events, and
 * the chronology check's runs. Synchronous, like every other store.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/open.js';
import { nameWithTail, splitNameTail } from './names.js';

type Obj = Record<string, unknown>;

/** A row's three cells as the chronology compares them (spaces collapsed; nothing else changed). */
export interface RowCells {
  readonly description: string;
  readonly date: string;
  readonly kcy: string;
}

const cellText = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();

/** v2 E6 (ADR 0048): the fingerprint of a row's cells: a table-only mark holds while it is unchanged. */
export function rowCellsHash(t: RowCells): string {
  return createHash('sha256')
    .update(JSON.stringify([cellText(t.description), cellText(t.date), cellText(t.kcy)]))
    .digest('hex')
    .slice(0, 32);
}

/** v2 E6 (ADR 0048): a row the owner never wants on the timeline. */
export interface TableOnlyMark {
  readonly tableDocumentId: string;
  readonly rowId: string;
  readonly age: string;
  readonly textsHash: string;
  readonly texts: RowCells;
  readonly reason: string | null;
  readonly markedBy: string;
  readonly markedAt: number;
}

/**
 * The marks that hold for a table as it is now: by row id, those whose row is still there with the cells it had when
 * marked. A mark whose row changed or is gone is `lapsed` (the row is back in the check).
 */
export function currentTableOnly(
  rows: readonly {
    readonly id: string | null;
    readonly description: string;
    readonly dateText: string;
    readonly kcyText: string;
  }[],
  marks: readonly TableOnlyMark[],
): { readonly current: ReadonlySet<string>; readonly lapsed: readonly TableOnlyMark[] } {
  const byId = new Map(rows.filter((r) => r.id !== null).map((r) => [r.id!, r]));
  const current = new Set<string>();
  const lapsed: TableOnlyMark[] = [];
  for (const m of marks) {
    const r = byId.get(m.rowId);
    if (r && rowCellsHash({ description: r.description, date: r.dateText, kcy: r.kcyText }) === m.textsHash)
      current.add(m.rowId);
    else lapsed.push(m);
  }
  return { current, lapsed };
}
const json = (v: unknown) => JSON.stringify(v ?? null);
const parse = <T>(s: string | null | undefined, fallback: T): T => {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

// ============================================================================================ the record

export type ChronologyTool =
  | 'create_timeline_event'
  | 'update_timeline_event'
  | 'delete_timeline_event'
  | 'sync_timeline_event'
  /** v2 E5 hotfix: the "Propose a fix" of a count mismatch (src/chronology/count.ts); no MCP tool. */
  | 'chronology_count_fix'
  /** v3 F3.4 (ADR 0055): the owner's revert of a direct chronology change (src/review/revert-chronology.ts). */
  | 'job_revert'
  /** v3 F3d (renames), ADR 0058: the chronology rows (and their events) of an approved rename (src/packs/rename). */
  | 'arkona_rename';

/** One write a change makes, as the record keeps it (what resuming checks against the documents as they are). */
export type TargetWrite =
  | {
      /**
       * Not a write: the table row, as the plan read it, must still be exactly so inside the lock (the compare-and-swap
       * of a repair that writes only the timeline and takes the row as its authority).
       */
      readonly kind: 'row.assert';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly rowId: string;
      readonly texts: { readonly description: string; readonly date: string; readonly kcy: string };
    }
  | {
      /**
       * v2 E5 hotfix. Not a write: the age table must still have exactly this many rows inside the lock (the
       * compare-and-swap of the count fix, which sets the Main count to the table's row count).
       */
      readonly kind: 'row.count';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly rows: number;
    }
  | {
      /**
       * v2 E6 (ADR 0048). Not a write: the age table must still have no row that could be this event's own (the same
       * date, the same start, or its name), other than the rows in `ignore` as they were (paired elsewhere or
       * table-only when the delete was planned). The compare-and-swap of deleting an event without a row.
       */
      readonly kind: 'row.orphan';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly event: {
        readonly start: number;
        readonly end: number | null;
        readonly detail: 1 | 2 | 3;
        readonly name: string;
      };
      readonly ignore: readonly {
        readonly rowId: string;
        readonly texts: { readonly description: string; readonly date: string; readonly kcy: string };
      }[];
      /**
       * ADR 0057 decision 2: the rows whose date cannot be read that the plan found accounted for (paired, or marked
       * table-only); any other such row inside the lock stops the delete. Absent on proposals made before it.
       */
      readonly unreadableKnown?: readonly string[];
    }
  | {
      readonly kind: 'row.insert';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly rowId: string;
      /** The texts the row holds (description, Date, KCY), and the whole block as built. */
      readonly texts: { readonly description: string; readonly date: string; readonly kcy: string };
      readonly block: Obj;
    }
  | {
      readonly kind: 'row.delete';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly rowId: string;
      readonly texts: { readonly description: string; readonly date: string; readonly kcy: string };
    }
  | {
      readonly kind: 'row.replace';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly rowId: string;
      readonly before: { readonly description: string; readonly date: string; readonly kcy: string };
      readonly texts: { readonly description: string; readonly date: string; readonly kcy: string };
      readonly block: Obj;
    }
  | {
      /**
       * v3 F2.1. Not a write: the event, as the plan read it, must still be exactly so inside the lock (the
       * compare-and-swap of a link the caller chose: `sync_timeline_event` with `event_id` on an event that agrees).
       */
      readonly kind: 'event.assert';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly eventId: string;
    }
  | {
      readonly kind: 'event.create';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly eventId: string;
      readonly body: Obj;
    }
  | {
      readonly kind: 'event.delete';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly eventId: string;
    }
  | {
      readonly kind: 'event.update';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly eventId: string;
      readonly fields: Obj;
    }
  | {
      readonly kind: 'count';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly rowId: string;
      readonly delta: number;
    };

export interface ChronologyTarget {
  readonly writes: readonly TargetWrite[];
  /** The link the change leaves (row and event of one chronology event), or removes. */
  readonly link?: {
    readonly age: string;
    readonly tableDocumentId: string;
    readonly rowId: string;
    readonly timelineDocumentId: string;
    readonly eventId: string;
    /** v3 F2 (ADR 0049): the tail the bridge wrote in the event's name ('' for none; absent when unknown). */
    readonly nameTail?: string;
  } | null;
  readonly unlink?: { readonly tableDocumentId: string; readonly rowId: string } | null;
}

export interface ChronologyRecord {
  readonly id: number;
  readonly projectId: string;
  readonly tool: ChronologyTool;
  readonly requestKey: string;
  readonly ages: readonly string[];
  readonly summary: string;
  readonly target: ChronologyTarget;
  /** The Main counts as the first job's check found them, by Main row: before the change and after it. */
  readonly observed: { readonly counts?: Readonly<Record<string, { before: number; after: number }>> };
  readonly state: 'incomplete' | 'complete' | 'resolved';
  readonly jobId: string | null;
  readonly jobs: readonly string[];
  readonly principalId: string;
  readonly approver: string | null;
  readonly proposalId: string | null;
  readonly detail: Obj;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

interface RecordRow {
  id: number;
  project_id: string;
  tool: string;
  request_key: string;
  ages: string;
  summary: string;
  target: string;
  observed: string | null;
  state: string;
  job_id: string | null;
  jobs: string;
  principal_id: string;
  approver: string | null;
  proposal_id: string | null;
  detail: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

const recordOf = (r: RecordRow): ChronologyRecord => ({
  id: r.id,
  projectId: r.project_id,
  tool: r.tool as ChronologyTool,
  requestKey: r.request_key,
  ages: parse<string[]>(r.ages, []),
  summary: r.summary,
  target: parse<ChronologyTarget>(r.target, { writes: [] }),
  observed: parse<ChronologyRecord['observed']>(r.observed, {}),
  state: r.state as ChronologyRecord['state'],
  jobId: r.job_id,
  jobs: parse<string[]>(r.jobs, []),
  principalId: r.principal_id,
  approver: r.approver,
  proposalId: r.proposal_id,
  detail: parse<Obj>(r.detail, {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
});

// ============================================================================================ the check

export interface CheckFinding {
  readonly kind:
    | 'row_without_event'
    | 'event_without_row'
    /** v3 F2.1: an unpaired event that unpaired rows could own: paired by the owner, never deleted. */
    | 'event_in_tie'
    | 'date_mismatch'
    | 'name_drift'
    | 'row_out_of_order'
    | 'wrong_kcy'
    | 'count_mismatch'
    | 'wrong_uri'
    | 'unreadable_date'
    | 'date_text_differs'
    | 'not_found';
  readonly age: string;
  readonly message: string;
  readonly detail?: Obj;
}

export interface CheckRun {
  readonly id: number;
  readonly projectId: string;
  readonly trigger: string;
  readonly state: 'running' | 'succeeded' | 'failed';
  readonly requests: number;
  readonly summary: string | null;
  readonly findings: readonly CheckFinding[];
  readonly ages: readonly Obj[];
  readonly error: string | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
}

interface CheckRow {
  id: number;
  project_id: string;
  trigger: string;
  state: string;
  requests: number;
  summary: string | null;
  findings: string;
  ages: string;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

const checkOf = (r: CheckRow): CheckRun => ({
  id: r.id,
  projectId: r.project_id,
  trigger: r.trigger,
  state: r.state as CheckRun['state'],
  requests: r.requests,
  summary: r.summary,
  findings: parse<CheckFinding[]>(r.findings, []),
  ages: parse<Obj[]>(r.ages, []),
  error: r.error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

interface TableOnlyRow {
  table_document_id: string;
  row_id: string;
  age: string;
  texts_hash: string;
  texts: string;
  reason: string | null;
  marked_by: string;
  marked_at: number;
}

const tableOnlyOf = (r: TableOnlyRow): TableOnlyMark => ({
  tableDocumentId: r.table_document_id,
  rowId: r.row_id,
  age: r.age,
  textsHash: r.texts_hash,
  texts: parse<RowCells>(r.texts, { description: '', date: '', kcy: '' }),
  reason: r.reason,
  markedBy: r.marked_by,
  markedAt: r.marked_at,
});

export interface ChronologyLink {
  readonly tableDocumentId: string;
  readonly rowId: string;
  readonly timelineDocumentId: string;
  readonly eventId: string;
  readonly age: string;
  /**
   * v3 F2 (ADR 0049 decision 1): the tail the bridge wrote after the last ` – ` of the event's name (ADR 0048 decision
   * 3), or '' when it wrote none. Undefined when unknown (a link made before migration 2800, recognised on read).
   */
  readonly nameTail?: string;
}

export class ChronologyStore {
  constructor(
    readonly db: Db,
    private readonly now: () => number,
  ) {}

  // ------------------------------------------------------------------------------------------ calendars

  cachedCalendar(
    projectId: string,
    calendarId: string,
  ): { definition: unknown; version: string | null; fetchedAt: number } | null {
    const r = this.db
      .prepare(
        'SELECT definition, version, fetched_at FROM chronology_calendars WHERE project_id = ? AND calendar_id = ?',
      )
      .get(projectId, calendarId) as
      { definition: string; version: string | null; fetched_at: number } | undefined;
    return r ? { definition: parse(r.definition, null), version: r.version, fetchedAt: r.fetched_at } : null;
  }

  cacheCalendar(
    projectId: string,
    def: { id: string; name: string; version?: string | undefined },
    raw: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO chronology_calendars (project_id, calendar_id, name, version, definition, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, calendar_id) DO UPDATE SET name = excluded.name, version = excluded.version,
           definition = excluded.definition, fetched_at = excluded.fetched_at`,
      )
      .run(projectId, def.id, def.name, def.version ?? null, json(raw), this.now());
  }

  // ------------------------------------------------------------------------------------------ records

  begin(
    projectId: string,
    r: {
      readonly tool: ChronologyTool;
      readonly requestKey: string;
      readonly ages: readonly string[];
      readonly summary: string;
      readonly target: ChronologyTarget;
      readonly observed: ChronologyRecord['observed'];
      readonly principalId: string;
      readonly approver: string | null;
      readonly jobId: string;
      readonly proposalId: string | null;
      readonly resumeOf?: number;
      readonly detail?: Obj;
    },
  ): ChronologyRecord {
    const now = this.now();
    if (r.resumeOf !== undefined) {
      const prev = this.get(projectId, r.resumeOf);
      if (prev && prev.state === 'incomplete') {
        const jobs = prev.jobs.includes(r.jobId) ? prev.jobs : [...prev.jobs, r.jobId];
        // The first job's counts stay: they are what resuming is checked against.
        const observed = {
          ...r.observed,
          ...prev.observed,
          counts: { ...r.observed.counts, ...prev.observed.counts },
        };
        this.db
          .prepare(
            'UPDATE chronology_records SET job_id = ?, jobs = ?, observed = ?, updated_at = ? WHERE id = ?',
          )
          .run(r.jobId, json(jobs), json(observed), now, prev.id);
        return this.get(projectId, prev.id)!;
      }
    }
    // A restarted job runs its begin step again: the same record.
    const same = this.byJob(projectId, r.jobId);
    if (same) return same;
    const res = this.db
      .prepare(
        `INSERT INTO chronology_records (project_id, tool, request_key, ages, summary, target, observed, state, job_id,
           jobs, principal_id, approver, proposal_id, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'incomplete', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        r.tool,
        r.requestKey,
        json(r.ages),
        r.summary,
        json(r.target),
        json(r.observed),
        r.jobId,
        json([r.jobId]),
        r.principalId,
        r.approver,
        r.proposalId,
        json(r.detail ?? {}),
        now,
        now,
      );
    return this.get(projectId, Number(res.lastInsertRowid))!;
  }

  complete(projectId: string, id: number, extra: Obj = {}): ChronologyRecord | null {
    const rec = this.get(projectId, id);
    if (!rec) return null;
    const now = this.now();
    this.db
      .prepare(
        "UPDATE chronology_records SET state = 'complete', detail = ?, updated_at = ?, completed_at = ? WHERE id = ?",
      )
      .run(json({ ...rec.detail, ...extra }), now, now, id);
    return this.get(projectId, id);
  }

  /** The owner's "mark resolved" (after fixing a stopped change by hand). */
  resolve(projectId: string, id: number, by: string): ChronologyRecord | null {
    const rec = this.get(projectId, id);
    if (!rec || rec.state !== 'incomplete') return rec;
    const now = this.now();
    this.db
      .prepare("UPDATE chronology_records SET state = 'resolved', detail = ?, updated_at = ? WHERE id = ?")
      .run(json({ ...rec.detail, resolvedBy: by, resolvedAt: now }), now, id);
    return this.get(projectId, id);
  }

  get(projectId: string, id: number): ChronologyRecord | null {
    const r = this.db
      .prepare('SELECT * FROM chronology_records WHERE project_id = ? AND id = ?')
      .get(projectId, id) as RecordRow | undefined;
    return r ? recordOf(r) : null;
  }

  byJob(projectId: string, jobId: string): ChronologyRecord | null {
    const r = this.db
      .prepare(
        'SELECT * FROM chronology_records WHERE project_id = ? AND job_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(projectId, jobId) as RecordRow | undefined;
    return r ? recordOf(r) : null;
  }

  /** Every incomplete record of a project (a stopped change waits on the ages it touches). */
  incomplete(projectId: string): ChronologyRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM chronology_records WHERE project_id = ? AND state = 'incomplete' ORDER BY id")
        .all(projectId) as RecordRow[]
    ).map(recordOf);
  }

  recent(projectId: string, o: { limit: number; offset?: number }): ChronologyRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM chronology_records WHERE project_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
        .all(projectId, o.limit, o.offset ?? 0) as RecordRow[]
    ).map(recordOf);
  }

  count(projectId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM chronology_records WHERE project_id = ?').get(projectId) as {
        n: number;
      }
    ).n;
  }

  // ------------------------------------------------------------------------------------------ links

  link(projectId: string, l: ChronologyLink): void {
    // An unknown tail (a record made before migration 2800) is stored as NULL, recognised on the next read.
    this.db
      .prepare(
        `INSERT INTO chronology_links (project_id, table_document_id, row_id, timeline_document_id, event_id, age, updated_at, name_tail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, table_document_id, row_id) DO UPDATE SET timeline_document_id = excluded.timeline_document_id,
           event_id = excluded.event_id, age = excluded.age, updated_at = excluded.updated_at, name_tail = excluded.name_tail`,
      )
      .run(
        projectId,
        l.tableDocumentId,
        l.rowId,
        l.timelineDocumentId,
        l.eventId,
        l.age,
        this.now(),
        l.nameTail ?? null,
      );
  }

  unlink(projectId: string, tableDocumentId: string, rowId: string): void {
    this.db
      .prepare('DELETE FROM chronology_links WHERE project_id = ? AND table_document_id = ? AND row_id = ?')
      .run(projectId, tableDocumentId, rowId);
  }

  links(projectId: string, tableDocumentId?: string): ChronologyLink[] {
    const rows = (
      tableDocumentId
        ? this.db
            .prepare('SELECT * FROM chronology_links WHERE project_id = ? AND table_document_id = ?')
            .all(projectId, tableDocumentId)
        : this.db.prepare('SELECT * FROM chronology_links WHERE project_id = ?').all(projectId)
    ) as {
      table_document_id: string;
      row_id: string;
      timeline_document_id: string;
      event_id: string;
      age: string;
      name_tail: string | null;
    }[];
    return rows.map((r) => {
      const l: ChronologyLink = {
        tableDocumentId: r.table_document_id,
        rowId: r.row_id,
        timelineDocumentId: r.timeline_document_id,
        eventId: r.event_id,
        age: r.age,
      };
      const tail = r.name_tail ?? this.recogniseTail(projectId, l);
      return { ...l, nameTail: tail };
    });
  }

  /**
   * v3 F2 (ADR 0049 decision 1): the tail of a link made before migration 2800, recognised once from the chronology
   * record that made its event: the bridge wrote a tail only when the event's name, as it created it, equalled
   * `<opening words> – <Date cell>` with the row's Date cell at the time. Anything else (no record, a plain name, a name
   * whose ` – ` came from anyone else) is '' and is never rewritten. Stored, so it is worked out once.
   */
  private recogniseTail(projectId: string, l: ChronologyLink): string {
    const recs = this.db
      .prepare(
        `SELECT target FROM chronology_records WHERE project_id = ? AND instr(target, ?) > 0 ORDER BY id DESC`,
      )
      .all(projectId, l.eventId) as { target: string }[];
    let tail = '';
    for (const r of recs) {
      const t = parse<ChronologyTarget>(r.target, { writes: [] });
      const ev = t.writes.find((w) => w.kind === 'event.create' && w.eventId === l.eventId);
      if (!ev || ev.kind !== 'event.create') continue;
      const name = typeof ev.body.name === 'string' ? ev.body.name : '';
      const row = t.writes.find(
        (w) =>
          (w.kind === 'row.assert' || w.kind === 'row.insert') &&
          w.rowId === l.rowId &&
          w.documentId === l.tableDocumentId, // X5: a row id is its table document's
      );
      const cell = row && (row.kind === 'row.assert' || row.kind === 'row.insert') ? row.texts.date : null;
      const split = splitNameTail(name);
      if (cell !== null && split && name === nameWithTail(split.opening, cell)) tail = split.tail;
      break;
    }
    this.db
      .prepare(
        'UPDATE chronology_links SET name_tail = ? WHERE project_id = ? AND table_document_id = ? AND row_id = ? AND name_tail IS NULL',
      )
      .run(tail, projectId, l.tableDocumentId, l.rowId);
    return tail;
  }

  // ------------------------------------------------------------------------------------------ table-only marks

  /** v2 E6 (ADR 0048): marks a row table-only, with its cells as they are now (replacing an earlier mark). */
  markTableOnly(
    projectId: string,
    m: {
      readonly tableDocumentId: string;
      readonly rowId: string;
      readonly age: string;
      readonly texts: RowCells;
      readonly reason: string | null;
      readonly by: string;
    },
  ): TableOnlyMark {
    this.db
      .prepare(
        `INSERT INTO chronology_table_only (project_id, table_document_id, row_id, age, texts_hash, texts, reason, marked_by, marked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, table_document_id, row_id) DO UPDATE SET age = excluded.age,
           texts_hash = excluded.texts_hash, texts = excluded.texts, reason = excluded.reason,
           marked_by = excluded.marked_by, marked_at = excluded.marked_at`,
      )
      .run(
        projectId,
        m.tableDocumentId,
        m.rowId,
        m.age,
        rowCellsHash(m.texts),
        json(m.texts),
        m.reason,
        m.by,
        this.now(),
      );
    return this.tableOnlyMark(projectId, m.tableDocumentId, m.rowId)!;
  }

  /** Clears a row's table-only mark; returns the mark it removed, or null. */
  unmarkTableOnly(projectId: string, tableDocumentId: string, rowId: string): TableOnlyMark | null {
    const before = this.tableOnlyMark(projectId, tableDocumentId, rowId);
    this.db
      .prepare(
        'DELETE FROM chronology_table_only WHERE project_id = ? AND table_document_id = ? AND row_id = ?',
      )
      .run(projectId, tableDocumentId, rowId);
    return before;
  }

  tableOnlyMark(projectId: string, tableDocumentId: string, rowId: string): TableOnlyMark | null {
    const r = this.db
      .prepare(
        'SELECT * FROM chronology_table_only WHERE project_id = ? AND table_document_id = ? AND row_id = ?',
      )
      .get(projectId, tableDocumentId, rowId) as TableOnlyRow | undefined;
    return r ? tableOnlyOf(r) : null;
  }

  /** Every table-only mark of a project (or of one table), oldest first. */
  tableOnly(projectId: string, tableDocumentId?: string): TableOnlyMark[] {
    const rows = (
      tableDocumentId
        ? this.db
            .prepare(
              'SELECT * FROM chronology_table_only WHERE project_id = ? AND table_document_id = ? ORDER BY marked_at, row_id',
            )
            .all(projectId, tableDocumentId)
        : this.db
            .prepare('SELECT * FROM chronology_table_only WHERE project_id = ? ORDER BY marked_at, row_id')
            .all(projectId)
    ) as TableOnlyRow[];
    return rows.map(tableOnlyOf);
  }

  // ------------------------------------------------------------------------------------------ checks

  startCheck(projectId: string, trigger: string): CheckRun {
    const res = this.db
      .prepare(
        "INSERT INTO chronology_checks (project_id, trigger, state, started_at) VALUES (?, ?, 'running', ?)",
      )
      .run(projectId, trigger, this.now());
    return this.check(projectId, Number(res.lastInsertRowid))!;
  }

  finishCheck(
    projectId: string,
    id: number,
    o: {
      state: 'succeeded' | 'failed';
      requests: number;
      summary: string;
      findings: readonly CheckFinding[];
      ages: readonly Obj[];
      error?: string;
    },
  ): CheckRun | null {
    this.db
      .prepare(
        `UPDATE chronology_checks SET state = ?, requests = ?, summary = ?, findings = ?, ages = ?, error = ?, finished_at = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(
        o.state,
        o.requests,
        o.summary,
        json(o.findings),
        json(o.ages),
        o.error ?? null,
        this.now(),
        projectId,
        id,
      );
    return this.check(projectId, id);
  }

  check(projectId: string, id: number): CheckRun | null {
    const r = this.db
      .prepare('SELECT * FROM chronology_checks WHERE project_id = ? AND id = ?')
      .get(projectId, id) as CheckRow | undefined;
    return r ? checkOf(r) : null;
  }

  lastCheck(projectId: string): CheckRun | null {
    const r = this.db
      .prepare('SELECT * FROM chronology_checks WHERE project_id = ? ORDER BY id DESC LIMIT 1')
      .get(projectId) as CheckRow | undefined;
    return r ? checkOf(r) : null;
  }

  runningCheck(projectId: string): CheckRun | null {
    const r = this.db
      .prepare(
        "SELECT * FROM chronology_checks WHERE project_id = ? AND state = 'running' ORDER BY id DESC LIMIT 1",
      )
      .get(projectId) as CheckRow | undefined;
    return r ? checkOf(r) : null;
  }

  /** A check left running by a restart is closed as failed. */
  closeStaleChecks(projectId: string): void {
    this.db
      .prepare(
        "UPDATE chronology_checks SET state = 'failed', error = 'interrupted (the bridge stopped)', finished_at = ? WHERE project_id = ? AND state = 'running'",
      )
      .run(this.now(), projectId);
  }
}

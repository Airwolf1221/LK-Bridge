/**
 * A chronology change as ONE job (v2 D1, PLAN-v2 4.9, ADR 0038): from the change's target (the writes it makes) and
 * what the documents hold now, the steps that are left, in order:
 *
 * 1. `bridge.expect`, inside the locks of every document the change touches (sorted, held for the whole job): each
 *    table and the Main table judged by the chronology's checkers (the row's place and the new count worked out there),
 *    the lane present, each event present or absent as planned;
 * 2. `bridge.record` begin (the change's record, for resuming);
 * 3. the writes: the table first (it is the authority), then the timeline, then the Main counts. Each table row is
 *    written block by block (`insertBlock`, `moveBlock`, `replaceBlock`, `deleteBlock`), never by rewriting the
 *    document, so anything else on the page (an inline icon, a keep region) is untouched. Each versioned write chains
 *    its If-Match from the check (or the job's own previous write to that document);
 * 4. `bridge.verify`: rows, events and counts read back;
 * 5. `bridge.record` complete (and the link between the row and the event).
 *
 * A write already made (resuming a change that stopped part-way) is left out: nothing is ever applied twice.
 */
import {
  EXPECT_STEP,
  RECORD_STEP,
  VERIFY_STEP,
  type ExpectCheck,
  type VerifyTarget,
} from '../jobs/internal-steps.js';
import type { StepSpec } from '../jobs/index.js';
import type { MainCheckInput, TableCheckInput, TableOp, TableVerifyInput } from './checkers.js';
import type { ChronologyConfig } from './settings.js';
import type { ChronologyTarget, ChronologyTool, TargetWrite } from './store.js';
import type { RowTexts, SortKey } from './table.js';

type Obj = Record<string, unknown>;

/** What the plan needs to know about each write beyond the target (from the documents as read now). */
export interface WriteContext {
  /** The table block id of each table document touched. */
  readonly tableIds: Readonly<Record<string, string>>;
  readonly mainTableId: string;
  /** Per inserted or replaced row: its date's sort key and date, and its description's text. */
  readonly rows: Readonly<
    Record<
      string,
      {
        sortKey: SortKey;
        date: { start: number; end: number | null; detail: 1 | 2 | 3 };
        description: string;
      }
    >
  >;
  /** The count cell's paragraph of each Main row touched, and its text as planned. */
  readonly counts: Readonly<Record<string, { paragraphId: string; text: string; age: string }>>;
  /** The lane of each timeline touched: id and name. */
  readonly lanes: Readonly<Record<string, { id: string; name: string }>>;
  /** Event fields as they are now (update, delete), for the in-lock check. */
  readonly events: Readonly<Record<string, Obj>>;
  /** Resuming: the Main count each count write must still find (its write was not made). */
  readonly expectBefore?: Readonly<Record<string, number>>;
  /** Rows whose date changes (their place may too): moved before they are replaced. */
  readonly moves?: ReadonlySet<string>;
}

export interface BuiltJob {
  readonly steps: StepSpec[];
  readonly labels: string[];
  readonly holdDocuments: string[];
}

const EVENT_FIELDS = ['name', 'start', 'end', 'detail', 'laneId', 'uri'] as const;

/** The steps of a change (see the module comment). `writes` are the target's writes still to make. */
export function buildJob(o: {
  readonly tool: ChronologyTool;
  readonly config: ChronologyConfig;
  readonly target: ChronologyTarget;
  readonly writes: readonly TargetWrite[];
  readonly ctx: WriteContext;
  readonly record: {
    readonly requestKey: string;
    readonly ages: readonly string[];
    readonly summary: string;
    readonly resumeOf?: number;
  };
}): BuiltJob {
  const c = o.config;
  const resourceId = c.resourceId!;
  const mainDoc = c.mainDocumentId!;
  const checks: ExpectCheck[] = [];
  const verify: VerifyTarget[] = [];
  const steps: StepSpec[] = [];
  const labels: string[] = [];
  const docs = new Set<string>();
  const tableOps = new Map<string, TableOp[]>();
  const tableVerify = new Map<string, TableVerifyInput['rows'][number][]>();
  const mainOps: MainCheckInput['ops'][number][] = [];
  const lanesChecked = new Set<string>();
  const eventsChecked = new Set<string>();
  const ageCols = { event: c.columns.event, date: c.columns.date, kcy: c.columns.kcy };
  const mainCols = {
    age: c.columns.age,
    count: c.columns.count,
    table: c.columns.table,
    timeline: c.columns.timeline,
  };
  const tableAge = new Map<string, string>();
  const pushTableOp = (doc: string, op: TableOp) => tableOps.set(doc, [...(tableOps.get(doc) ?? []), op]);
  const pushVerify = (doc: string, v: TableVerifyInput['rows'][number]) =>
    tableVerify.set(doc, [...(tableVerify.get(doc) ?? []), v]);

  // Step numbers: 1 is the check, 2 the record; the writes follow.
  const EXPECT = 1;
  const writeSteps: { step: StepSpec; label: string; doc: string }[] = [];
  const lastWriteTo = new Map<string, number>(); // document → the index in writeSteps of its last write
  const chain = (doc: string, label: string) => {
    const prev = lastWriteTo.get(doc);
    return prev === undefined ? { step: EXPECT, key: label } : { step: 3 + prev };
  };
  const addWrite = (doc: string, step: StepSpec, label: string) => {
    lastWriteTo.set(doc, writeSteps.length);
    writeSteps.push({ step, label, doc });
  };
  const journal = (w: TargetWrite) => ({ tool: o.tool, chronology: { write: w.kind, age: w.age } });

  // The table writes first, then the events, then the counts (the table is the authority).
  const order = (w: TargetWrite) => (w.kind.startsWith('row.') ? 0 : w.kind.startsWith('event.') ? 1 : 2);
  const writes = [...o.writes].sort((a, b) => order(a) - order(b));
  for (const w of writes) {
    docs.add(w.documentId);
    if (w.kind.startsWith('row.')) tableAge.set(w.documentId, w.age);
    switch (w.kind) {
      case 'row.insert': {
        const r = o.ctx.rows[w.rowId]!;
        const key = `row:${w.rowId}`;
        pushTableOp(w.documentId, {
          op: 'insert',
          key,
          rowId: w.rowId,
          block: w.block,
          sortKey: r.sortKey,
          date: r.date,
          description: r.description,
        });
        pushVerify(w.documentId, { rowId: w.rowId, present: true, texts: w.texts });
        addWrite(
          w.documentId,
          {
            op: 'insertBlock',
            judgedInLock: true,
            params: { path: { resourceId, documentId: w.documentId }, body: { block: w.block } },
            bindBody: { step: EXPECT, key },
            ifMatchFrom: chain(w.documentId, `table:${w.documentId}`),
            journalOperation: journal(w),
          },
          `add the row “${w.texts.date}” to the ${w.age} table`,
        );
        break;
      }
      case 'row.delete': {
        pushTableOp(w.documentId, { op: 'delete', rowId: w.rowId, texts: w.texts });
        pushVerify(w.documentId, { rowId: w.rowId, present: false });
        addWrite(
          w.documentId,
          {
            op: 'deleteBlock',
            judgedInLock: true,
            params: { path: { resourceId, documentId: w.documentId, blockId: w.rowId } },
            ifMatchFrom: chain(w.documentId, `table:${w.documentId}`),
            journalOperation: journal(w),
          },
          `delete the row “${w.texts.date}” from the ${w.age} table`,
        );
        break;
      }
      case 'row.replace': {
        const r = o.ctx.rows[w.rowId]!;
        const moveKey = o.ctx.moves?.has(w.rowId) ? `move:${w.rowId}` : undefined;
        pushTableOp(w.documentId, {
          op: 'replace',
          rowId: w.rowId,
          before: w.before,
          sortKey: r.sortKey,
          date: r.date,
          description: r.description,
          ...(moveKey ? { moveKey } : {}),
        });
        pushVerify(w.documentId, { rowId: w.rowId, present: true, texts: w.texts });
        if (moveKey) {
          addWrite(
            w.documentId,
            {
              op: 'moveBlock',
              judgedInLock: true,
              params: { path: { resourceId, documentId: w.documentId, blockId: w.rowId }, body: {} },
              bindBody: { step: EXPECT, key: moveKey },
              ifMatchFrom: chain(w.documentId, `table:${w.documentId}`),
              journalOperation: journal(w),
            },
            `move the row to its new place in the ${w.age} table`,
          );
        }
        addWrite(
          w.documentId,
          {
            op: 'replaceBlock',
            judgedInLock: true,
            params: { path: { resourceId, documentId: w.documentId, blockId: w.rowId }, body: w.block },
            ifMatchFrom: chain(w.documentId, `table:${w.documentId}`),
            journalOperation: journal(w),
          },
          `change the row to “${w.texts.date}” in the ${w.age} table`,
        );
        break;
      }
      case 'event.create': {
        if (!eventsChecked.has(w.eventId)) {
          eventsChecked.add(w.eventId);
          checks.push({
            label: `event:${w.eventId}`,
            kind: 'event',
            resourceId,
            documentId: w.documentId,
            eventId: w.eventId,
            present: false,
          });
        }
        const fields = Object.fromEntries(
          EVENT_FIELDS.filter((k) => w.body[k] !== undefined).map((k) => [k, w.body[k]]),
        );
        verify.push({
          kind: 'event',
          label: `${w.age} timeline event`,
          resourceId,
          documentId: w.documentId,
          eventId: w.eventId,
          present: true,
          fields,
        });
        addWrite(
          w.documentId,
          {
            op: 'createEvent',
            params: { path: { resourceId, documentId: w.documentId }, body: w.body },
            journalOperation: journal(w),
          },
          `add the event “${String(w.body.name)}” to the ${w.age} timeline`,
        );
        break;
      }
      case 'event.delete': {
        const now = o.ctx.events[w.eventId] ?? {};
        checks.push({
          label: `event:${w.eventId}`,
          kind: 'event',
          resourceId,
          documentId: w.documentId,
          eventId: w.eventId,
          present: true,
          fields: Object.fromEntries(
            EVENT_FIELDS.filter((k) => now[k] !== undefined).map((k) => [k, now[k]]),
          ),
        });
        verify.push({
          kind: 'event',
          label: `${w.age} timeline event deleted`,
          resourceId,
          documentId: w.documentId,
          eventId: w.eventId,
          present: false,
        });
        addWrite(
          w.documentId,
          {
            op: 'deleteEvent',
            params: { path: { resourceId, documentId: w.documentId, eventId: w.eventId } },
            journalOperation: journal(w),
          },
          `delete the event from the ${w.age} timeline`,
        );
        break;
      }
      case 'event.update': {
        const now = o.ctx.events[w.eventId] ?? {};
        checks.push({
          label: `event:${w.eventId}`,
          kind: 'event',
          resourceId,
          documentId: w.documentId,
          eventId: w.eventId,
          present: true,
          fields: Object.fromEntries(
            EVENT_FIELDS.filter((k) => now[k] !== undefined).map((k) => [k, now[k]]),
          ),
        });
        verify.push({
          kind: 'event',
          label: `${w.age} timeline event`,
          resourceId,
          documentId: w.documentId,
          eventId: w.eventId,
          present: true,
          fields: w.fields,
        });
        addWrite(
          w.documentId,
          {
            op: 'updateEvent',
            params: { path: { resourceId, documentId: w.documentId, eventId: w.eventId }, body: w.fields },
            journalOperation: journal(w),
          },
          `change the event in the ${w.age} timeline`,
        );
        break;
      }
      case 'count': {
        const cell = o.ctx.counts[w.rowId]!;
        const key = `count:${w.rowId}`;
        const expectBefore = o.ctx.expectBefore?.[w.rowId];
        mainOps.push({
          rowId: w.rowId,
          age: cell.age,
          paragraphId: cell.paragraphId,
          delta: w.delta,
          key,
          ...(expectBefore !== undefined ? { expectBefore } : {}),
        });
        addWrite(
          mainDoc,
          {
            op: 'updateBlock',
            judgedInLock: true,
            params: {
              path: { resourceId, documentId: mainDoc, blockId: cell.paragraphId },
              body: { content: [{ text: cell.text }] },
            },
            bindBody: { step: EXPECT, key },
            ifMatchFrom: chain(mainDoc, 'main'),
            journalOperation: journal(w),
            journalPreImage: {
              countCell: { paragraphId: cell.paragraphId, text: cell.text, asPlanned: true },
            },
          },
          `${w.delta > 0 ? 'add one to' : 'take one from'} the ${w.age} count on the Main table`,
        );
        break;
      }
    }
  }
  // The checks: each table, the Main table, each lane of a timeline an event is created in.
  for (const [doc, ops] of tableOps) {
    checks.unshift({
      label: `table:${doc}`,
      kind: 'document',
      resourceId,
      documentId: doc,
      checker: 'chronology.table',
      input: {
        age: tableAge.get(doc) ?? doc,
        tableId: o.ctx.tableIds[doc]!,
        columns: ageCols,
        ops,
      } satisfies TableCheckInput,
    });
  }
  if (mainOps.length > 0) {
    docs.add(mainDoc);
    checks.push({
      label: 'main',
      kind: 'document',
      resourceId,
      documentId: mainDoc,
      checker: 'chronology.main',
      input: {
        tableId: o.ctx.mainTableId,
        columns: mainCols,
        ops: mainOps,
        verifyKey: 'verify.main',
      } satisfies MainCheckInput,
    });
  }
  for (const w of writes) {
    if (w.kind !== 'event.create' || lanesChecked.has(w.documentId)) continue;
    lanesChecked.add(w.documentId);
    const lane = o.ctx.lanes[w.documentId]!;
    checks.push({
      label: `lane:${w.documentId}`,
      kind: 'lane',
      resourceId,
      documentId: w.documentId,
      laneId: lane.id,
      name: lane.name,
    });
  }
  for (const [doc, rows] of tableVerify) {
    verify.unshift({
      kind: 'checked',
      label: `table ${doc}`,
      resourceId,
      documentId: doc,
      checker: 'chronology.verify.table',
      input: { tableId: o.ctx.tableIds[doc]!, columns: ageCols, rows } satisfies TableVerifyInput,
    });
  }
  if (mainOps.length > 0) {
    verify.push({
      kind: 'checked',
      label: 'Main counts',
      resourceId,
      documentId: mainDoc,
      checker: 'chronology.verify.main',
      input: null,
      inputFrom: { step: EXPECT, key: 'verify.main' },
    });
  }

  steps.push({ op: EXPECT_STEP, params: { body: { checks } } });
  labels.push('check');
  steps.push({
    op: RECORD_STEP,
    params: {
      body: {
        store: 'chronology',
        action: 'begin',
        record: {
          tool: o.tool,
          requestKey: o.record.requestKey,
          ages: o.record.ages,
          summary: o.record.summary,
          target: o.target,
          ...(o.record.resumeOf !== undefined ? { resumeOf: o.record.resumeOf } : {}),
        },
      },
    },
  });
  labels.push('record');
  for (const w of writeSteps) {
    steps.push(w.step);
    labels.push(w.label);
  }
  if (verify.length > 0) {
    steps.push({ op: VERIFY_STEP, params: { body: { targets: verify } } });
    labels.push('verify');
  }
  steps.push({ op: RECORD_STEP, params: { body: { store: 'chronology', action: 'complete', record: {} } } });
  labels.push('record complete');
  return { steps, labels, holdDocuments: [...docs].sort() };
}

/** A row's cells replaced (description, Date, KCY), every other cell and every id kept. */
export function replaceCells(
  rowBlock: Obj,
  columns: { readonly event: number; readonly date: number; readonly kcy: number },
  values: { readonly descriptionRuns?: readonly Obj[]; readonly date?: string; readonly kcy?: string },
  mint: () => string,
): Obj {
  const cells = (Array.isArray(rowBlock.children) ? (rowBlock.children as Obj[]) : []).map((cell, i) => {
    const content =
      i === columns.event && values.descriptionRuns
        ? values.descriptionRuns.map((r) => ({ ...r }))
        : i === columns.date && values.date !== undefined
          ? [{ text: values.date }]
          : i === columns.kcy && values.kcy !== undefined
            ? [{ text: values.kcy }]
            : null;
    if (content === null) return structuredClone(cell);
    const kids = Array.isArray(cell.children) ? (cell.children as Obj[]) : [];
    const para = kids.length === 1 && kids[0]!.kind === 'paragraph' ? kids[0]! : null;
    return {
      ...structuredClone(cell),
      children: [{ id: typeof para?.id === 'string' ? para.id : mint(), kind: 'paragraph', content }],
    };
  });
  return { ...structuredClone(rowBlock), children: cells };
}

export type { RowTexts };

/**
 * Chronology sync (v2 D1, PLAN-v2 4.9, ADR 0038): the per-project settings (found by naming convention, confirmed by the
 * owner), the calendar the chronology's timelines use (cached, so `calendar_date` costs nothing), the record of each
 * chronology change (a change that stopped part-way is resumed, never replayed), the links between the bridge's own rows
 * and events, the checks inside the lock that the timeline tools' jobs run, and the chronology check.
 *
 * The table is the authority; the timeline is a derived view. The check reports, it never repairs (PLAN-v2 4.12).
 */
import type { Db } from '../db/open.js';
import {
  BudgetExhaustedError,
  LkOperationError,
  type JobEngine,
  type JobView,
  type OpParams,
  type PriorityClass,
  type StepView,
} from '../jobs/index.js';
import { createCalendar, CalendarError, type Calendar, type Era } from '../calendar/index.js';
import type { TreeNode, TreeService } from '../tree/index.js';
import { nameKey } from '../tree/index.js';
import { chronologyCheckers } from './checkers.js';
import { runCheck, type CheckReader } from './check.js';
import { buildJob, type WriteContext } from './plan.js';
import { planSync, SYNC_TOOL } from './sync.js';
import { COUNT_FIX_TOOL, planCountFix } from './count.js';
import { ORPHAN_TOOL, planOrphanDelete } from './orphan.js';
import {
  chronologyConfigFrom,
  chronologySchema,
  DEFAULT_CHRONOLOGY,
  storedFrom,
  type AgeConfig,
  type ChronologyConfig,
  type StoredChronology,
} from './settings.js';
import {
  ChronologyStore,
  type ChronologyTarget,
  type ChronologyTool,
  type TableOnlyMark,
  type TargetWrite,
} from './store.js';
import { detectStyle, readAgeTable, readMainTable, type AgeTable, type DetectedStyle } from './table.js';

export * from './settings.js';
export * from './store.js';
export * from './table.js';
export * from './checkers.js';
export { runCheck, type CheckReader, type CheckReport } from './check.js';
export * from './sync.js';
export { COUNT_FIX_TOOL, planCountFix, type CountFixPlan, type CountFixResult } from './count.js';
export * from './orphan.js';
export {
  matchRowsAndEvents,
  nearestRows,
  openingWords,
  shapeChange,
  type MismatchBy,
  type PairHow,
  type Pairing,
} from './check.js';

type Obj = Record<string, unknown>;

export class ChronologyError extends Error {
  override readonly name = 'ChronologyError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Obj = {},
  ) {
    super(message);
  }
}

export interface ChronologyDeps {
  readonly db: Db;
  readonly engine: JobEngine;
  readonly tree: Pick<TreeService, 'queries'>;
  readonly settings: (projectId: string) => Readonly<Record<string, unknown>> | undefined;
  readonly setSetting: (projectId: string, key: string, value: unknown) => void;
  readonly audit: (
    actor: string,
    action: string,
    target: string | null,
    before?: unknown,
    after?: unknown,
  ) => void;
  readonly now: () => number;
  /** Whether agents' work (P1 or P2) is queued for the project: the check gives way. */
  readonly busy?: (projectId: string) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: { warn(obj: Obj, msg: string): void };
}

/** A document of the chronology resource as the tree knows it. */
export interface DocRef {
  readonly id: string;
  readonly name: string;
  readonly type: string | null;
}

/** What a lookup by name finds in the tree (free: no LegendKeeper request). */
export interface FindView {
  readonly resource:
    | { readonly status: 'found'; readonly id: string; readonly name: string; readonly path: string }
    | { readonly status: 'missing'; readonly name: string }
    | {
        readonly status: 'ambiguous';
        readonly name: string;
        readonly candidates: readonly { id: string; name: string; path: string }[];
      };
  readonly main: DocRef | null;
  readonly ages: readonly {
    readonly name: string;
    readonly table: DocRef | null;
    readonly timeline: DocRef | null;
  }[];
  readonly problems: readonly string[];
}

/** What reading the chronology finds (the dashboard's "Read the chronology"): everything the owner confirms. */
export interface LookupView extends FindView {
  readonly requests: number;
  readonly calendar: {
    readonly id: string;
    readonly name: string;
    readonly eras: readonly { id: string; name: string; abbr: string }[];
  } | null;
  readonly mainTable: {
    readonly tableId: string | null;
    readonly rows: readonly {
      id: string | null;
      age: string;
      count: string;
      table: string | null;
      timeline: string | null;
    }[];
  } | null;
  readonly found: readonly (AgeConfig & {
    readonly era: string;
    readonly rows: number;
    readonly count: string;
    readonly problems: readonly string[];
  })[];
  readonly style: DetectedStyle | null;
  /** The settings to confirm, or null when something is missing (see `problems`). */
  readonly proposed: StoredChronology | null;
}

/** The chronology as confirmed, checked against the tree now, or the refusal the tools give. */
export type Readiness =
  | { readonly ok: true; readonly config: ChronologyConfig; readonly resource: TreeNode }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface Chronology {
  readonly store: ChronologyStore;
  config(projectId: string): ChronologyConfig;
  find(projectId: string): FindView;
  /** Reads the calendar, the Main table, every age table and every age timeline's lanes (about 3 per age). */
  lookup(projectId: string, priority?: PriorityClass): Promise<LookupView>;
  /** The owner's confirmation (or `null`: back to the defaults, unconfirmed). Audited `project.set_chronology`. */
  update(actor: string, projectId: string, settings: StoredChronology | null): ChronologyConfig;
  readiness(projectId: string): Readiness;
  /** The calendar the bridge last read for a project (no request), or null. */
  calendar(projectId: string, calendarId?: string): Calendar | null;
  /** Stores a calendar definition just read (from `listCalendars`) and gives its engine. */
  remember(projectId: string, definition: Obj): Calendar;
  /** The era of an age of the configured calendar. */
  eraOf(calendar: Calendar, age: AgeConfig): Era | null;
  /** The owner's "mark resolved" of a stopped change. Audited. */
  resolve(actor: string, projectId: string, recordId: number): void;
  /** The chronology check of one project (the maintenance job and the dashboard's button). Never repairs. */
  check(
    projectId: string,
    trigger: string,
    priority?: PriorityClass,
  ): Promise<{ summary: string; changed: boolean; skipped?: boolean }>;
  /**
   * v2 D1.1 (ADR 0039): the dashboard's "Propose a fix" for one finding (a row without an event, or a row and its event
   * disagreeing about the date): plans `sync_timeline_event` for that row and captures it as ONE proposal for the owner
   * to approve as normal, whatever the caller. Nothing is written until the owner approves. Audited
   * `chronology.propose_fix`. Throws `ChronologyError` with the refusal (an ambiguous pairing, a change that stopped
   * part-way, a row that is gone).
   *
   * v2 E5 hotfix: `kind: 'count'` is the fix of a `count_mismatch`: the age's Event count cell in the Main table set to
   * the age table's row count, both re-read live (src/chronology/count.ts), as ONE proposal in the same way. A count that
   * already matches answers `nothing_to_do`; a Main table with no row for the age has no fix (`MAIN_ROW_NOT_FOUND`).
   */
  proposeFix(
    actor: string,
    projectId: string,
    fix: ChronologyFix,
  ): Promise<
    | { readonly status: 'proposal_captured'; readonly proposalId: string; readonly summary: string | null }
    | { readonly status: 'nothing_to_do'; readonly message: string }
  >;
  /**
   * v2 E6 (ADR 0048): marks a row of an age table table-only (the owner never wants it on the timeline). The table is
   * read once (the row's cells as they are now are kept with the mark); the mark hides the row from the check while
   * they are unchanged. Audited `chronology.table_only`.
   */
  markTableOnly(
    actor: string,
    projectId: string,
    o: { readonly age: string; readonly rowId: string; readonly reason?: string | null },
  ): Promise<TableOnlyMark>;
  /** Clears a row's table-only mark (no request). Audited `chronology.table_only`. */
  unmarkTableOnly(
    actor: string,
    projectId: string,
    o: { readonly age: string; readonly rowId: string },
  ): void;
  attach(): () => void;
  stop(): void;
}

/**
 * What "Propose a fix" fixes: a table row's timeline event (the default), an age's Main count (v2 E5 hotfix), or (v2
 * E6) an event without a row, deleted.
 */
export type ChronologyFix =
  | {
      readonly kind?: 'sync';
      readonly age: string;
      readonly rowId: string;
      /** v2 E6 (ADR 0048): a repair that changes the event's shape (`range → single day`) needs this. */
      readonly confirmShapeChange?: boolean;
    }
  | { readonly kind: 'count'; readonly age: string }
  | { readonly kind: 'orphan'; readonly age: string; readonly eventId: string };

const nodeView = (n: TreeNode) => ({ id: n.id, name: n.rawName, path: n.path.names.join(' / ') });

export function createChronology(d: ChronologyDeps): Chronology {
  const store = new ChronologyStore(d.db, d.now);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stopper = new AbortController();
  const calendars = new Map<string, { version: string | null; fetchedAt: number; cal: Calendar }>();

  const config = (projectId: string): ChronologyConfig => {
    const s = d.settings(projectId) ?? {};
    const c = chronologyConfigFrom(s.chronology);
    const legacy = typeof s.chronologyResourceId === 'string' ? s.chronologyResourceId : null;
    return c.resourceId === null && legacy ? { ...c, resourceId: legacy } : c;
  };

  const node = (projectId: string, id: string): TreeNode | null => {
    try {
      return d.tree.queries.node(projectId, id).data;
    } catch {
      return null;
    }
  };

  const docsOf = (n: TreeNode): DocRef[] =>
    n.documents
      .filter((x) => typeof x.id === 'string')
      .map((x) => ({ id: x.id, name: x.name ?? '', type: x.type }));

  // ------------------------------------------------------------------------------------------ the lookup by name

  const find = (projectId: string): FindView => {
    const c = config(projectId);
    const problems: string[] = [];
    let resourceNode: TreeNode | null = null;
    let resource: FindView['resource'];
    if (c.resourceId) {
      resourceNode = node(projectId, c.resourceId);
      resource = resourceNode
        ? { status: 'found', ...nodeView(resourceNode) }
        : { status: 'missing', name: `${c.names.resource} (${c.resourceId})` };
    } else {
      let hits: TreeNode[];
      try {
        hits = d.tree.queries
          .findByDisplayName(projectId, c.names.resource)
          .data.map((m) => m.node)
          .filter((n) => n.kind !== 'root');
      } catch {
        hits = [];
      }
      // Several pages of that name (an index and the chronology page itself): the one holding the chronology's
      // documents (its Main page and at least one age table).
      if (hits.length > 1) {
        const holds = hits.filter((n) => {
          const ds = docsOf(n);
          return (
            ds.some((x) => nameKey(x.name) === nameKey(c.names.mainDocument) && x.type === 'page') &&
            ds.some((x) => x.name.toLowerCase().endsWith(c.names.tableSuffix.toLowerCase()))
          );
        });
        if (holds.length === 1) hits = holds;
      }
      if (hits.length === 1) {
        resourceNode = hits[0]!;
        resource = { status: 'found', ...nodeView(resourceNode) };
      } else if (hits.length === 0) resource = { status: 'missing', name: c.names.resource };
      else resource = { status: 'ambiguous', name: c.names.resource, candidates: hits.map(nodeView) };
    }
    if (!resourceNode) {
      problems.push(
        resource.status === 'ambiguous'
          ? `More than one page is named “${c.names.resource}”; set the chronology resource on the Projects page.`
          : `No page named “${c.names.resource}” is in the repository tree (or the configured one is gone).`,
      );
      return { resource, main: null, ages: [], problems };
    }
    const docs = docsOf(resourceNode);
    const mains = docs.filter((x) => nameKey(x.name) === nameKey(c.names.mainDocument) && x.type === 'page');
    if (mains.length !== 1)
      problems.push(`The chronology has ${mains.length} page documents named “${c.names.mainDocument}”.`);
    const ages = new Map<string, { name: string; table: DocRef | null; timeline: DocRef | null }>();
    const suffix = (name: string, s: string) =>
      name.toLowerCase().endsWith(s.toLowerCase()) ? name.slice(0, name.length - s.length).trim() : null;
    for (const x of docs) {
      const t = suffix(x.name, c.names.tableSuffix);
      const l = suffix(x.name, c.names.timelineSuffix);
      const age = t ?? l;
      if (!age) continue;
      const k = nameKey(age);
      const e = ages.get(k) ?? { name: age, table: null, timeline: null };
      if (t !== null) {
        if (x.type !== 'page') problems.push(`“${x.name}” is a ${x.type ?? 'blank'} document, not a page.`);
        else if (e.table) problems.push(`Two documents are named “${x.name}”.`);
        else e.table = x;
      } else {
        if (x.type !== 'time')
          problems.push(`“${x.name}” is a ${x.type ?? 'blank'} document, not a timeline.`);
        else if (e.timeline) problems.push(`Two documents are named “${x.name}”.`);
        else e.timeline = x;
      }
      ages.set(k, e);
    }
    for (const a of ages.values()) {
      if (!a.table)
        problems.push(`The age “${a.name}” has no “${a.name}${c.names.tableSuffix}” page document.`);
      if (!a.timeline)
        problems.push(`The age “${a.name}” has no “${a.name}${c.names.timelineSuffix}” timeline.`);
    }
    return { resource, main: mains.length === 1 ? mains[0]! : null, ages: [...ages.values()], problems };
  };

  // ------------------------------------------------------------------------------------------ reads

  const reader =
    (projectId: string, priority: PriorityClass, counter: { n: number }) =>
    async (op: string, params: OpParams): Promise<unknown> => {
      for (;;) {
        if (stopper.signal.aborted) throw new Error('the bridge is stopping');
        try {
          counter.n++;
          return await d.engine.internalRead(projectId, op, params, {
            priority,
            notFoundIsAnswer: true,
            signal: stopper.signal,
          });
        } catch (e) {
          if (e instanceof LkOperationError && (e.lk.status === 404 || e.lkCode === 'NOT_FOUND'))
            return undefined;
          if (e instanceof BudgetExhaustedError && priority === 'P3') {
            await sleep(Math.max(1000, e.retryAtMs - d.now()));
            continue;
          }
          throw e;
        }
      }
    };

  const remember = (projectId: string, def: Obj): Calendar => {
    const cal = createCalendar(def);
    store.cacheCalendar(
      projectId,
      { id: cal.engine.id, name: cal.engine.name, version: def.version as string | undefined },
      def,
    );
    calendars.set(`${projectId}:${cal.engine.id}`, {
      version: typeof def.version === 'string' ? def.version : null,
      fetchedAt: d.now(),
      cal,
    });
    return cal;
  };

  const calendar = (projectId: string, calendarId?: string): Calendar | null => {
    const id = calendarId ?? config(projectId).calendarId;
    if (!id) return null;
    const key = `${projectId}:${id}`;
    const cached = store.cachedCalendar(projectId, id);
    if (!cached) return null;
    const mem = calendars.get(key);
    if (mem && mem.version === cached.version && mem.fetchedAt >= cached.fetchedAt) return mem.cal;
    try {
      const cal = createCalendar(cached.definition);
      calendars.set(key, { version: cached.version, fetchedAt: cached.fetchedAt, cal });
      return cal;
    } catch {
      return null;
    }
  };

  const eraOf = (cal: Calendar, age: AgeConfig): Era | null =>
    cal.engine.eras.find((e) => e.id === age.eraId) ??
    cal.engine.eras.find((e) => nameKey(e.name) === nameKey(age.name)) ??
    null;

  const lookup = async (projectId: string, priority: PriorityClass = 'P2'): Promise<LookupView> => {
    const f = find(projectId);
    const c = config(projectId);
    const counter = { n: 0 };
    const read = reader(projectId, priority, counter);
    const problems = [...f.problems];
    const base = {
      ...f,
      requests: 0,
      calendar: null,
      mainTable: null,
      found: [],
      style: null,
      proposed: null,
    };
    if (f.resource.status !== 'found' || !f.main) return { ...base, problems };
    const resourceId = f.resource.id;
    // The calendar: the one the age timelines use (each must use the same).
    const calIds = new Set<string>();
    const lanes = new Map<string, Obj[]>();
    for (const a of f.ages) {
      if (!a.timeline) continue;
      const doc = (await read('getDocument', { path: { resourceId, documentId: a.timeline.id } })) as
        Obj | undefined;
      if (typeof doc?.calendarId === 'string') calIds.add(doc.calendarId);
      else problems.push(`“${a.timeline.name}” has no calendar.`);
      const l = (await read('listLanes', { path: { resourceId, documentId: a.timeline.id } })) as
        { data?: Obj[] } | undefined;
      lanes.set(a.timeline.id, Array.isArray(l?.data) ? l.data : []);
    }
    if (calIds.size > 1)
      problems.push(`The age timelines use ${calIds.size} different calendars (${[...calIds].join(', ')}).`);
    let cal: Calendar | null = null;
    const calId = [...calIds][0] ?? c.calendarId;
    if (calId) {
      const list = (await read('listCalendars', {})) as { data?: Obj[] } | undefined;
      const def = (list?.data ?? []).find((x) => x.id === calId);
      if (!def) problems.push(`The calendar ${calId} was not found.`);
      else {
        try {
          cal = remember(projectId, def);
        } catch (e) {
          problems.push(e instanceof CalendarError ? e.message : String(e));
        }
      }
    }
    // The Main table.
    const mainDoc = (await read('getDocumentBlocks', { path: { resourceId, documentId: f.main.id } })) as
      { blocks?: unknown[] } | undefined;
    const main = readMainTable(mainDoc?.blocks ?? [], c.columns);
    if (!main)
      problems.push(
        `The Main document has no table with the columns ${[c.columns.age, c.columns.count, c.columns.table, c.columns.timeline].join(' | ')}.`,
      );
    // Each age: its era, its Main row, its lane, its table.
    const tables: AgeTable[] = [];
    const found: LookupView['found'][number][] = [];
    for (const a of f.ages) {
      const ap: string[] = [];
      if (!a.table || !a.timeline) continue;
      const era = cal ? cal.engine.eras.find((e) => nameKey(e.name) === nameKey(a.name)) : null;
      if (cal && !era) ap.push(`No era of the calendar “${cal.engine.name}” is named “${a.name}”.`);
      const row = main?.rows.find((r) => nameKey(r.age) === nameKey(a.name));
      if (main && !row) ap.push(`The Main table has no row for “${a.name}”.`);
      if (row && row.table && (row.table.documentId !== a.table.id || row.table.resourceId !== resourceId))
        ap.push(
          `The Main row's table link points to ${row.table.documentId ?? row.table.resourceId}, not “${a.table.name}”.`,
        );
      if (
        row &&
        row.timeline &&
        (row.timeline.documentId !== a.timeline.id || row.timeline.resourceId !== resourceId)
      )
        ap.push(
          `The Main row's timeline link points to ${row.timeline.documentId ?? row.timeline.resourceId}, not “${a.timeline.name}”.`,
        );
      if (row && row.count === null) ap.push(`The Main row's count “${row.countText}” is not a number.`);
      if (row && !row.id) ap.push('The Main row has no block id.');
      const ls = lanes.get(a.timeline.id) ?? [];
      const lane = ls.length === 1 ? ls[0]! : null;
      if (ls.length !== 1)
        ap.push(`“${a.timeline.name}” has ${ls.length} lanes; an age timeline has exactly one.`);
      let rows = 0;
      if (cal) {
        const blocks = (await read('getDocumentBlocks', { path: { resourceId, documentId: a.table.id } })) as
          { blocks?: unknown[] } | undefined;
        const t = readAgeTable(blocks?.blocks ?? [], cal.parser, c.style.date, c.columns);
        if (!t)
          ap.push(
            `“${a.table.name}” has no table with the columns ${c.columns.event} | ${c.columns.date} | ${c.columns.kcy}.`,
          );
        else {
          tables.push(t);
          rows = t.rows.length;
        }
      }
      found.push({
        name: a.name,
        eraId: era?.id ?? '',
        era: era ? `${era.name} (${era.abbr})` : '(none)',
        tableDocumentId: a.table.id,
        timelineDocumentId: a.timeline.id,
        laneId: typeof lane?.id === 'string' ? lane.id : '',
        laneName: typeof lane?.name === 'string' ? lane.name : '',
        mainRowId: row?.id ?? '',
        rows,
        count: row?.countText ?? '',
        problems: ap,
      });
      problems.push(...ap.map((p) => `${a.name}: ${p}`));
    }
    const style = tables.length > 0 ? detectStyle(tables) : null;
    const complete = problems.length === 0 && cal !== null && main !== null && found.length > 0;
    return {
      ...f,
      problems,
      requests: counter.n,
      calendar: cal
        ? {
            id: cal.engine.id,
            name: cal.engine.name,
            eras: cal.engine.eras.map((e) => ({ id: e.id, name: e.name, abbr: e.abbr })),
          }
        : null,
      mainTable: main
        ? {
            tableId: main.table.id,
            rows: main.rows.map((r) => ({
              id: r.id,
              age: r.age,
              count: r.countText,
              table: r.table?.documentId ?? null,
              timeline: r.timeline?.documentId ?? null,
            })),
          }
        : null,
      found,
      style,
      proposed:
        complete && cal
          ? storedFrom({
              ...DEFAULT_CHRONOLOGY,
              ...c,
              resourceId,
              calendarId: cal.engine.id,
              mainDocumentId: f.main.id,
              ages: found.map(({ era: _e, rows: _r, count: _c, problems: _p, ...a }) => a),
              style: style ? style.proposed : c.style,
              confirmed: false,
              confirmedAt: null,
            })
          : null,
    };
  };

  // ------------------------------------------------------------------------------------------ confirmation

  const readiness = (projectId: string): Readiness => {
    const c = config(projectId);
    const how = 'The owner reads and confirms the chronology on the dashboard (Chronology page).';
    if (c.problem) return { ok: false, code: 'CHRONOLOGY_NOT_CONFIGURED', message: `${c.problem} ${how}` };
    if (!c.confirmed || !c.resourceId || !c.mainDocumentId || !c.calendarId || c.ages.length === 0)
      return {
        ok: false,
        code: 'CHRONOLOGY_NOT_CONFIGURED',
        message: `The chronology is not confirmed yet; the chronology tools refuse until it is. ${how}`,
      };
    const res = node(projectId, c.resourceId);
    if (!res)
      return {
        ok: false,
        code: 'CHRONOLOGY_CHANGED',
        message: `The confirmed chronology resource (${c.resourceId}) is no longer in the repository tree. ${how}`,
      };
    const docs = new Map(docsOf(res).map((x) => [x.id, x]));
    const want: [string, string, string][] = [[c.mainDocumentId, c.names.mainDocument, 'page']];
    for (const a of c.ages) {
      want.push([a.tableDocumentId, `${a.name}${c.names.tableSuffix}`, 'page']);
      want.push([a.timelineDocumentId, `${a.name}${c.names.timelineSuffix}`, 'time']);
    }
    for (const [id, name, type] of want) {
      const x = docs.get(id);
      if (!x)
        return {
          ok: false,
          code: 'CHRONOLOGY_CHANGED',
          message: `The confirmed document “${name}” (${id}) is no longer on the chronology. ${how}`,
        };
      if (nameKey(x.name) !== nameKey(name) || x.type !== type)
        return {
          ok: false,
          code: 'CHRONOLOGY_CHANGED',
          message: `The confirmed document ${id} is now “${x.name}” (${x.type ?? 'blank'}), not “${name}”. ${how}`,
        };
    }
    return { ok: true, config: c, resource: res };
  };

  const update = (actor: string, projectId: string, settings: StoredChronology | null): ChronologyConfig => {
    const before = d.settings(projectId)?.chronology ?? null;
    if (settings === null) {
      d.setSetting(projectId, 'chronology', null);
      d.audit(actor, 'project.set_chronology', projectId, before, null);
      return config(projectId);
    }
    const parsed = chronologySchema.safeParse(settings);
    if (!parsed.success)
      throw new ChronologyError(
        'INVALID_SETTINGS',
        `The chronology settings are not valid: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}.`,
      );
    const s = parsed.data;
    const next: StoredChronology = { ...s, confirmed: true, confirmedAt: d.now() };
    const stored = before;
    d.setSetting(projectId, 'chronology', next);
    const ready = readiness(projectId);
    if (!ready.ok) {
      d.setSetting(projectId, 'chronology', stored);
      throw new ChronologyError(ready.code, ready.message);
    }
    const ages = new Set<string>();
    for (const a of s.ages ?? []) {
      if (ages.has(nameKey(a.name))) {
        d.setSetting(projectId, 'chronology', stored);
        throw new ChronologyError('INVALID_SETTINGS', `The age “${a.name}” is listed twice.`);
      }
      ages.add(nameKey(a.name));
    }
    d.audit(actor, 'project.set_chronology', projectId, before, next);
    return config(projectId);
  };

  const resolve = (actor: string, projectId: string, recordId: number) => {
    const rec = store.get(projectId, recordId);
    if (!rec) throw new ChronologyError('NOT_FOUND', `No chronology change ${recordId}.`);
    if (rec.state !== 'incomplete')
      throw new ChronologyError('NOT_INCOMPLETE', `Change ${recordId} is ${rec.state}.`);
    store.resolve(projectId, recordId, actor);
    d.audit(
      actor,
      'chronology.resolve',
      projectId,
      { recordId, state: rec.state },
      { recordId, state: 'resolved' },
    );
  };

  // ------------------------------------------------------------------------------------------ the record

  const recordHandler = (job: JobView, _step: StepView, params: OpParams): unknown => {
    const body = (params.body ?? {}) as { action?: unknown; record?: unknown };
    if (body.action === 'begin') {
      const r = (body.record ?? {}) as {
        tool?: ChronologyTool;
        requestKey?: string;
        ages?: string[];
        summary?: string;
        target?: ChronologyTarget;
        resumeOf?: number;
        detail?: Obj;
      };
      if (!r.tool || !r.requestKey || !r.target)
        throw new ChronologyError(
          'INVALID_RECORD',
          'The chronology record of this job is not valid; nothing was written.',
        );
      // The counts the job's own check found inside the lock (before and after), for resuming.
      const steps = d.engine.stepResults(job.projectId, job.id) ?? [];
      let counts: Record<string, { before: number; after: number }> = {};
      for (const s of steps) {
        const observed = (
          s.value as {
            observed?: Record<string, { counts?: Record<string, { before: number; after: number }> }>;
          } | null
        )?.observed;
        for (const o of Object.values(observed ?? {})) if (o?.counts) counts = { ...counts, ...o.counts };
      }
      const origin = job.origin as { approval?: { proposalId?: unknown } };
      const rec = store.begin(job.projectId, {
        tool: r.tool,
        requestKey: r.requestKey,
        ages: r.ages ?? [],
        summary: r.summary ?? r.tool,
        target: r.target,
        observed: { counts },
        principalId: job.principalId,
        approver: job.approvedBy ?? null,
        jobId: job.id,
        proposalId: typeof origin.approval?.proposalId === 'string' ? origin.approval.proposalId : null,
        ...(typeof r.resumeOf === 'number' ? { resumeOf: r.resumeOf } : {}),
        ...(r.detail ? { detail: r.detail } : {}),
      });
      return { recordId: rec.id, state: rec.state };
    }
    if (body.action === 'complete') {
      const rec = store.byJob(job.projectId, job.id);
      if (!rec) throw new ChronologyError('NO_RECORD', 'This job wrote no chronology record to complete.');
      const steps = d.engine.stepResults(job.projectId, job.id) ?? [];
      const verification = steps
        .map((s) => (s.value as { verification?: { status?: unknown } } | null)?.verification)
        .find((v) => v !== undefined);
      if (rec.target.unlink)
        store.unlink(job.projectId, rec.target.unlink.tableDocumentId, rec.target.unlink.rowId);
      if (rec.target.link) store.link(job.projectId, rec.target.link);
      const done = store.complete(job.projectId, rec.id, {
        ...(verification
          ? { verified: verification.status === 'verified', verification: verification.status }
          : {}),
      });
      return { recordId: rec.id, state: done?.state ?? 'complete' };
    }
    throw new ChronologyError('INVALID_RECORD', 'A bridge.record step is begin or complete.');
  };

  // ------------------------------------------------------------------------------------------ the check

  const check: Chronology['check'] = async (projectId, trigger, priority = 'P3') => {
    const ready = readiness(projectId);
    if (!ready.ok) return { skipped: true, changed: false, summary: `Skipped: ${ready.message}` };
    if (store.runningCheck(projectId)) store.closeStaleChecks(projectId);
    const run = store.startCheck(projectId, trigger);
    const counter = { n: 0 };
    const read = reader(projectId, priority, counter);
    const paced: CheckReader = async (op, params) => {
      // Agents' work first: wait while P1 or P2 work is queued for the project.
      if (priority === 'P3') for (let i = 0; i < 240 && d.busy?.(projectId); i++) await sleep(250);
      return read(op, params);
    };
    try {
      const list = (await paced('listCalendars', {})) as { data?: Obj[] } | undefined;
      const def = (list?.data ?? []).find((x) => x.id === ready.config.calendarId);
      if (!def)
        throw new ChronologyError(
          'CALENDAR_NOT_FOUND',
          `The calendar ${ready.config.calendarId} was not found.`,
        );
      const cal = remember(projectId, def);
      const report = await runCheck({
        projectId,
        config: ready.config,
        calendar: cal,
        read: paced,
        links: store.links(projectId),
        tableOnly: store.tableOnly(projectId),
      });
      const done = store.finishCheck(projectId, run.id, {
        state: 'succeeded',
        requests: counter.n,
        summary: report.summary,
        findings: report.findings,
        ages: report.ages,
      });
      return { summary: done?.summary ?? report.summary, changed: report.findings.length > 0 };
    } catch (e) {
      store.finishCheck(projectId, run.id, {
        state: 'failed',
        requests: counter.n,
        summary: 'The check stopped.',
        findings: [],
        ages: [],
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  };

  // ------------------------------------------------------------------------------------------ propose a fix

  const proposeFix: Chronology['proposeFix'] = async (actor, projectId, fix) => {
    const ready = readiness(projectId);
    if (!ready.ok) throw new ChronologyError(ready.code, ready.message);
    const c = ready.config;
    const age = c.ages.find((a) => nameKey(a.name) === nameKey(fix.age));
    if (!age) throw new ChronologyError('AGE_NOT_FOUND', `No age of the chronology is named “${fix.age}”.`);
    const stopped = store
      .incomplete(projectId)
      .find((r) => r.ages.some((a) => nameKey(a) === nameKey(age.name)));
    if (stopped)
      throw new ChronologyError(
        'CHRONOLOGY_INCOMPLETE',
        `A chronology change of ${stopped.ages.join(' and ')} stopped part-way (change ${stopped.id}: ${stopped.summary}). Finish it (repeat the same request) or mark it resolved first. Nothing was proposed.`,
        { recordId: stopped.id },
      );
    const read = reader(projectId, 'P1', { n: 0 });
    const list = (await read('listCalendars', {})) as { data?: Obj[] } | undefined;
    const def = (list?.data ?? []).find((x) => x.id === c.calendarId);
    if (!def)
      throw new ChronologyError('CALENDAR_NOT_FOUND', `The calendar ${String(c.calendarId)} was not found.`);
    const cal = remember(projectId, def);
    const page = { id: c.resourceId!, name: ready.resource.rawName };
    if (fix.kind === 'count') {
      const plan = await planCountFix({ config: c, calendar: cal, read, age });
      if (!plan.ok) throw new ChronologyError(plan.code, plan.message, plan.details);
      if (plan.action === 'nothing')
        return {
          status: 'nothing_to_do',
          message: `The ${age.name} count on the Main table already matches its table (${plan.main.text.trim()}; table rows ${plan.rows}): nothing to fix, and nothing was proposed.`,
        };
      return capture(actor, projectId, {
        tool: COUNT_FIX_TOOL,
        config: c,
        age,
        page,
        plan,
        audit: { kind: 'count', from: plan.main.value, to: plan.rows, events: plan.events },
      });
    }
    if (fix.kind === 'orphan') {
      // v2 E6 (ADR 0048): an event without a row, deleted (only the event; no row, no count change).
      const plan = await planOrphanDelete({
        config: c,
        calendar: cal,
        read,
        links: store.links(projectId),
        tableOnly: store.tableOnly(projectId),
        ref: { eventId: fix.eventId, age: age.name },
      });
      if (!plan.ok) throw new ChronologyError(plan.code, plan.message, plan.details);
      return capture(actor, projectId, {
        tool: ORPHAN_TOOL,
        config: c,
        age,
        page,
        plan,
        audit: { kind: 'orphan', eventId: fix.eventId, nearest: plan.nearest.map((n) => n.rowId) },
      });
    }
    const plan = await planSync({
      config: c,
      calendar: cal,
      read,
      links: store.links(projectId),
      tableOnly: store.tableOnly(projectId),
      ref: { rowId: fix.rowId, age: age.name },
    });
    if (!plan.ok) throw new ChronologyError(plan.code, plan.message, plan.details);
    if (plan.action === 'nothing')
      return {
        status: 'nothing_to_do',
        message: 'The row and its timeline event already agree; nothing was proposed.',
      };
    // v2 E6 (ADR 0048): a repair that turns a range into a single date (or the reverse) is never one click.
    if (plan.shapeChange && fix.confirmShapeChange !== true)
      throw new ChronologyError(
        'SHAPE_CHANGE_UNCONFIRMED',
        `This fix would change the ${age.name} event “${plan.event?.name.slice(0, 80) ?? ''}”: ${plan.shapeChange} (the row says “${plan.row.dateText}”). Check that the row and the event are the same chronology event, then confirm the change. Nothing was proposed.`,
        { shapeChange: plan.shapeChange, rowId: fix.rowId, eventId: plan.event?.id ?? null },
      );
    return capture(actor, projectId, {
      tool: SYNC_TOOL,
      config: c,
      age,
      page,
      plan,
      audit: {
        rowId: fix.rowId,
        action: plan.action,
        ...(plan.shapeChange ? { shapeChange: plan.shapeChange, confirmed: true } : {}),
      },
    });
  };

  // ------------------------------------------------------------------------------------------ table-only marks

  const ageNamed = (projectId: string, name: string): AgeConfig => {
    const ready = readiness(projectId);
    if (!ready.ok) throw new ChronologyError(ready.code, ready.message);
    const age = ready.config.ages.find((a) => nameKey(a.name) === nameKey(name));
    if (!age) throw new ChronologyError('AGE_NOT_FOUND', `No age of the chronology is named “${name}”.`);
    return age;
  };

  const markTableOnly: Chronology['markTableOnly'] = async (actor, projectId, o) => {
    const age = ageNamed(projectId, o.age);
    const c = config(projectId);
    const read = reader(projectId, 'P1', { n: 0 });
    const list = (await read('listCalendars', {})) as { data?: Obj[] } | undefined;
    const def = (list?.data ?? []).find((x) => x.id === c.calendarId);
    if (!def)
      throw new ChronologyError('CALENDAR_NOT_FOUND', `The calendar ${String(c.calendarId)} was not found.`);
    const cal = remember(projectId, def);
    const b = (await read('getDocumentBlocks', {
      path: { resourceId: c.resourceId!, documentId: age.tableDocumentId },
    })) as { blocks?: unknown[] } | undefined;
    const t = readAgeTable(b?.blocks ?? [], cal.parser, c.style.date, c.columns);
    const row = t?.rows.find((r) => r.id === o.rowId);
    if (!row) throw new ChronologyError('ROW_NOT_FOUND', `The ${age.name} table has no row ${o.rowId}.`);
    const before = store.tableOnlyMark(projectId, age.tableDocumentId, o.rowId);
    const reason = o.reason?.trim() ? o.reason.trim().slice(0, 500) : null;
    const mark = store.markTableOnly(projectId, {
      tableDocumentId: age.tableDocumentId,
      rowId: o.rowId,
      age: age.name,
      texts: { description: row.description, date: row.dateText, kcy: row.kcyText },
      reason,
      by: actor,
    });
    d.audit(
      actor,
      'chronology.table_only',
      projectId,
      before ? { age: age.name, rowId: o.rowId, tableOnly: true, date: before.texts.date } : null,
      { age: age.name, rowId: o.rowId, tableOnly: true, date: row.dateText, reason },
    );
    return mark;
  };

  const unmarkTableOnly: Chronology['unmarkTableOnly'] = (actor, projectId, o) => {
    const age = ageNamed(projectId, o.age);
    const before = store.unmarkTableOnly(projectId, age.tableDocumentId, o.rowId);
    if (!before)
      throw new ChronologyError('NOT_FOUND', `The ${age.name} row ${o.rowId} is not marked table-only.`);
    d.audit(
      actor,
      'chronology.table_only',
      projectId,
      { age: age.name, rowId: o.rowId, tableOnly: true, date: before.texts.date, reason: before.reason },
      { age: age.name, rowId: o.rowId, tableOnly: false },
    );
  };

  /**
   * One planned chronology change captured as ONE proposal, whatever the caller (`forceProposal`; the policy gate and
   * the write guard still run, a deny still denies), proposed by the dashboard. Nothing is written until the owner
   * approves it; approving runs the ordinary chronology job (src/chronology/plan.ts). Audited `chronology.propose_fix`.
   */
  const capture = async (
    actor: string,
    projectId: string,
    o: {
      readonly tool: ChronologyTool;
      readonly config: ChronologyConfig;
      readonly age: AgeConfig;
      readonly page: { readonly id: string; readonly name: string };
      readonly plan: {
        readonly target: ChronologyTarget;
        readonly writes: readonly TargetWrite[];
        readonly ctx: WriteContext;
        readonly requestKey: string;
        readonly summary: string;
        readonly head: Obj;
        readonly markdown: { readonly before: string; readonly after: string };
      };
      readonly audit: Obj;
    },
  ): Promise<{ status: 'proposal_captured'; proposalId: string; summary: string | null }> => {
    const { plan, page, tool } = o;
    const built = buildJob({
      tool,
      config: o.config,
      target: plan.target,
      writes: plan.writes,
      ctx: plan.ctx,
      record: { requestKey: plan.requestKey, ages: [o.age.name], summary: plan.summary },
      // The count fix sets a count: a Main document changed since the proposal conflicts at approval, as usual.
      ...(tool === COUNT_FIX_TOOL ? { captureMainVersion: true } : {}),
    });
    const parts = built.labels.filter((l) => !['check', 'record', 'verify', 'record complete'].includes(l));
    const r = await d.engine.submit({
      kind: 'batch_ops',
      project: projectId,
      steps: built.steps,
      onError: 'stop',
      priority: 'P1',
      origin: { kind: 'ui', client: 'owner', tool: 'chronology_propose_fix' },
      title: plan.summary.slice(0, 300),
      holdDocuments: built.holdDocuments,
      internal: true,
      forceProposal: true,
      proposal: {
        operation: {
          tool,
          page,
          before: plan.markdown.before,
          after: plan.markdown.after,
          chronology: plan.head,
        },
        operations: [{ tool, page, pageParts: parts, summaryLabel: plan.summary, chronology: plan.head }],
        summary: plan.summary,
      },
    });
    if (!('proposalId' in r))
      throw new ChronologyError('NOT_PROPOSED', 'The fix was not captured as a proposal; nothing was done.');
    d.audit(actor, 'chronology.propose_fix', projectId, null, {
      age: o.age.name,
      ...o.audit,
      proposalId: r.proposalId,
    });
    return { status: 'proposal_captured', proposalId: r.proposalId, summary: r.summary ?? null };
  };

  return {
    store,
    config,
    find,
    lookup,
    update,
    readiness,
    calendar,
    remember,
    eraOf,
    resolve,
    check,
    proposeFix,
    markTableOnly,
    unmarkTableOnly,
    attach() {
      const offRecord = d.engine.registerRecordHandler(recordHandler, 'chronology');
      const checkers = chronologyCheckers((projectId) => calendar(projectId));
      const offs = Object.entries(checkers).map(([name, fn]) => d.engine.registerChecker(name, fn));
      return () => {
        offRecord();
        for (const off of offs) off();
      };
    },
    stop: () => stopper.abort(),
  };
}

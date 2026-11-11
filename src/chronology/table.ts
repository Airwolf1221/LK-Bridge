/**
 * The chronology's tables as blocks (v2 D1, PLAN-v2 4.9, ADR 0038): an age table (`Historical Event | Date | KCY`, one
 * row per event in calendar order) and the Main table (`Age | Event count | Complete dated table | Interactive
 * timeline`, one row per age). Reading them, the calendar order of rows, building a new row, and learning how the tables
 * write their dates and KCY values (never invented: what the real rows show is what the bridge writes).
 *
 * Only top-level tables are read; a table's first row is its header. Text of a cell is the text of its runs, a mention
 * counting as its label (or the page's name), a line break as a space.
 */
import {
  DEFAULT_DATE_STYLE,
  DEFAULT_KCY_STYLE,
  parseKcyCell,
  type DateParser,
  type DateTextStyle,
  type KcyStyle,
  type ParsedDate,
} from '../calendar/index.js';
import { CalendarError } from '../calendar/errors.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export interface Mention {
  readonly resourceId: string;
  readonly documentId: string | null;
}

export interface Cell {
  readonly id: string | null;
  /** The cell's single paragraph (null when the cell holds something else, or several blocks). */
  readonly paragraphId: string | null;
  readonly runs: readonly Obj[];
  readonly text: string;
  readonly mentions: readonly Mention[];
  /** More than one block, or a block that is not a paragraph. */
  readonly complex: boolean;
  readonly block: Obj;
}

export interface Row {
  readonly id: string | null;
  readonly cells: readonly Cell[];
  readonly block: Obj;
}

export interface Table {
  readonly id: string | null;
  /** The table's position among the document's top-level blocks. */
  readonly index: number;
  readonly header: Row;
  readonly rows: readonly Row[];
  readonly block: Obj;
}

/** The text of runs: text, a mention's label (or the page's name), a line break as a space. */
export function runsText(runs: unknown): string {
  let out = '';
  for (const r of arr(runs)) {
    if (typeof r.text === 'string') out += r.text;
    else if (isObj(r.mention)) out += str(r.mention.text) ?? str(r.mention.name) ?? '';
    else if (r.break === true) out += ' ';
  }
  return out;
}

function mentionsOf(runs: unknown): Mention[] {
  return arr(runs)
    .filter((r) => isObj(r.mention) && typeof r.mention.resourceId === 'string')
    .map((r) => {
      const m = r.mention as Obj;
      return { resourceId: m.resourceId as string, documentId: str(m.documentId) };
    });
}

function cellOf(b: Obj): Cell {
  const kids = arr(b.children);
  const para = kids.length === 1 && kids[0]!.kind === 'paragraph' ? kids[0]! : null;
  const runs = para ? arr(para.content) : kids.flatMap((k) => arr(k.content));
  return {
    id: str(b.id),
    paragraphId: para ? str(para.id) : null,
    runs,
    text: (para ? runsText(para.content) : kids.map((k) => runsText(k.content)).join(' '))
      .replace(/\s+/g, ' ')
      .trim(),
    mentions: mentionsOf(runs),
    complex: para === null && kids.length > 0,
    block: b,
  };
}

function rowOf(b: Obj): Row {
  return {
    id: str(b.id),
    cells: arr(b.children)
      .filter((c) => c.kind === 'tableCell')
      .map(cellOf),
    block: b,
  };
}

/** Every top-level table of a document. */
export function tablesOf(blocks: readonly unknown[]): Table[] {
  const out: Table[] = [];
  blocks.forEach((b, index) => {
    if (!isObj(b) || b.kind !== 'table') return;
    const rows = arr(b.children)
      .filter((r) => r.kind === 'tableRow')
      .map(rowOf);
    if (rows.length === 0) return;
    out.push({ id: str(b.id), index, header: rows[0]!, rows: rows.slice(1), block: b });
  });
  return out;
}

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** The first top-level table whose header row has these columns (by name, without case), with their positions. */
export function findTable<K extends string>(
  blocks: readonly unknown[],
  columns: Readonly<Record<K, string>>,
): { table: Table; columns: Record<K, number> } | null {
  for (const t of tablesOf(blocks)) {
    const names = t.header.cells.map((c) => norm(c.text));
    const pos = {} as Record<K, number>;
    let ok = true;
    for (const [k, name] of Object.entries(columns) as [K, string][]) {
      const i = names.indexOf(norm(name));
      if (i < 0) {
        ok = false;
        break;
      }
      pos[k] = i;
    }
    if (ok) return { table: t, columns: pos };
  }
  return null;
}

// ============================================================================================ an age table

export const AGE_COLUMNS = { event: 'Historical Event', date: 'Date', kcy: 'KCY' } as const;
export const MAIN_COLUMNS = {
  age: 'Age',
  count: 'Event count',
  table: 'Complete dated table',
  timeline: 'Interactive timeline',
} as const;

export interface AgeRow {
  readonly id: string | null;
  /** Position among the table's data rows (0 is the first row after the header). */
  readonly index: number;
  readonly description: string;
  readonly descriptionRuns: readonly Obj[];
  readonly dateText: string;
  readonly kcyText: string;
  /** The Date cell read by the calendar engine, or why it could not be. */
  readonly date: ParsedDate | null;
  readonly dateError: { readonly code: string; readonly message: string } | null;
  readonly row: Row;
}

export interface AgeTable {
  readonly table: Table;
  readonly columns: { readonly event: number; readonly date: number; readonly kcy: number };
  readonly rows: readonly AgeRow[];
}

/** Reads an age table from a document's blocks, or null when it has none with the three columns. */
export function readAgeTable(
  blocks: readonly unknown[],
  parser: DateParser,
  style: DateTextStyle = DEFAULT_DATE_STYLE,
  columns: { event: string; date: string; kcy: string } = AGE_COLUMNS,
): AgeTable | null {
  const found = findTable(blocks, { event: columns.event, date: columns.date, kcy: columns.kcy });
  if (!found) return null;
  const c = found.columns;
  const rows = found.table.rows.map((row, index): AgeRow => {
    const cell = (i: number) => row.cells[i];
    const dateText = cell(c.date)?.text ?? '';
    let date: ParsedDate | null = null;
    let dateError: AgeRow['dateError'] = null;
    try {
      date = parser.parse(dateText, style);
    } catch (e) {
      if (e instanceof CalendarError) dateError = { code: e.code, message: e.message };
      else throw e;
    }
    return {
      id: row.id,
      index,
      description: cell(c.event)?.text ?? '',
      descriptionRuns: cell(c.event)?.runs ?? [],
      dateText,
      kcyText: cell(c.kcy)?.text ?? '',
      date,
      dateError,
      row,
    };
  });
  return { table: found.table, columns: c, rows };
}

// ============================================================================================ calendar order

/**
 * Where a date sorts in an age table: by year (KCY); within a year the dated rows (day or month) by their start, then
 * the year-only rows (and year ranges); a range by its start. Equal keys keep their order (a new row goes after them).
 */
export interface SortKey {
  readonly kcy: number;
  readonly yearOnly: 0 | 1;
  readonly start: number;
}

export function sortKey(d: Pick<ParsedDate, 'kcy' | 'detail' | 'start'>): SortKey {
  return { kcy: d.kcy.start, yearOnly: d.detail === 1 ? 1 : 0, start: d.start };
}

export function compareKeys(a: SortKey, b: SortKey): number {
  return a.kcy - b.kcy || a.yearOnly - b.yearOnly || a.start - b.start;
}

/**
 * The row a new row goes after: the last row (in table order) whose date sorts at or before the new one's, so ties go
 * after the existing rows of the same date. Rows whose date cannot be read are passed over (and reported). Null: the
 * new row goes first (straight after the header row).
 */
export function anchorFor(
  rows: readonly AgeRow[],
  key: SortKey,
  skip: ReadonlySet<string> = new Set(),
): AgeRow | null {
  let anchor: AgeRow | null = null;
  for (const r of rows) {
    if (!r.date || (r.id !== null && skip.has(r.id))) continue;
    if (compareKeys(sortKey(r.date), key) <= 0) anchor = r;
  }
  return anchor;
}

/** Rows whose date sorts before the previous readable row's: out of calendar order. */
export function outOfOrder(rows: readonly AgeRow[]): { row: AgeRow; after: AgeRow }[] {
  const out: { row: AgeRow; after: AgeRow }[] = [];
  let prev: AgeRow | null = null;
  for (const r of rows) {
    if (!r.date) continue;
    if (prev?.date && compareKeys(sortKey(r.date), sortKey(prev.date)) < 0) out.push({ row: r, after: prev });
    else prev = r;
  }
  return out;
}

/** Text compared without case or extra spaces. */
export const sameText = (a: string, b: string) => norm(a) === norm(b);

/** Two dates that store the same (start, end, detail). */
export function sameDate(
  a: Pick<ParsedDate, 'start' | 'end' | 'detail'>,
  b: Pick<ParsedDate, 'start' | 'end' | 'detail'>,
): boolean {
  return a.start === b.start && (a.end ?? null) === (b.end ?? null) && a.detail === b.detail;
}

// ============================================================================================ a new row

/** A new data row: one cell per header column, each with one paragraph; the three columns filled, others empty. */
export function buildRow(o: {
  readonly ids: {
    readonly row: string;
    readonly cells: readonly string[];
    readonly paragraphs: readonly string[];
  };
  readonly width: number;
  readonly columns: { readonly event: number; readonly date: number; readonly kcy: number };
  readonly descriptionRuns: readonly Obj[];
  readonly dateText: string;
  readonly kcyText: string;
}): Obj {
  const children: Obj[] = [];
  for (let i = 0; i < o.width; i++) {
    const content =
      i === o.columns.event
        ? o.descriptionRuns.map((r) => ({ ...r }))
        : i === o.columns.date
          ? [{ text: o.dateText }]
          : i === o.columns.kcy
            ? [{ text: o.kcyText }]
            : [];
    children.push({
      id: o.ids.cells[i]!,
      kind: 'tableCell',
      children: [{ id: o.ids.paragraphs[i]!, kind: 'paragraph', content }],
    });
  }
  return { id: o.ids.row, kind: 'tableRow', children };
}

/** The texts of a row's three cells, as the verify step compares them. */
export interface RowTexts {
  readonly description: string;
  readonly date: string;
  readonly kcy: string;
}

export function rowTexts(r: AgeRow): RowTexts {
  return { description: r.description, date: r.dateText, kcy: r.kcyText };
}

// ============================================================================================ the Main table

export interface MainRow {
  readonly id: string | null;
  readonly index: number;
  readonly age: string;
  readonly countText: string;
  readonly count: number | null;
  readonly countCell: Cell | null;
  readonly table: Mention | null;
  readonly timeline: Mention | null;
  readonly row: Row;
}

export interface MainTable {
  readonly table: Table;
  readonly columns: {
    readonly age: number;
    readonly count: number;
    readonly table: number;
    readonly timeline: number;
  };
  readonly rows: readonly MainRow[];
}

/** A count as the Main table writes it (`335`, `1,204`), or null. */
export function parseCount(text: string): number | null {
  const t = text.trim();
  if (/^\d+$/.test(t) || /^\d{1,3}(,\d{3})+$/.test(t)) return Number(t.replace(/,/g, ''));
  return null;
}

export function readMainTable(
  blocks: readonly unknown[],
  columns: { age: string; count: string; table: string; timeline: string } = MAIN_COLUMNS,
): MainTable | null {
  const found = findTable(blocks, {
    age: columns.age,
    count: columns.count,
    table: columns.table,
    timeline: columns.timeline,
  });
  if (!found) return null;
  const c = found.columns;
  const rows = found.table.rows.map((row, index): MainRow => {
    const countCell = row.cells[c.count] ?? null;
    return {
      id: row.id,
      index,
      age: row.cells[c.age]?.text ?? '',
      countText: countCell?.text ?? '',
      count: countCell ? parseCount(countCell.text) : null,
      countCell,
      table: row.cells[c.table]?.mentions[0] ?? null,
      timeline: row.cells[c.timeline]?.mentions[0] ?? null,
      row,
    };
  });
  return { table: found.table, columns: c, rows };
}

/** A count written as the Main table writes its counts (thousands commas when any count there has them). */
export function formatCount(n: number, main: MainTable): string {
  const commas = main.rows.some((r) => /,/.test(r.countText));
  return commas ? n.toLocaleString('en-GB') : String(n);
}

/** The count cell's new content: the first run's marks kept, the text replaced. */
export function countContent(cell: Cell, text: string): Obj[] {
  const first = cell.runs.find((r) => typeof r.text === 'string');
  const { text: _t, ...marks } = first ?? {};
  return [{ ...marks, text }];
}

// ============================================================================================ how the tables write

export interface Evidence<T> {
  /** What the rows show, or null when nothing showed it (the default is used then, and the owner confirms it). */
  readonly value: T | null;
  /** Each value seen, with how many rows showed it. */
  readonly seen: Readonly<Record<string, number>>;
  readonly examples: readonly string[];
}

export interface DetectedStyle {
  readonly date: { readonly rangeSeparator: Evidence<string>; readonly yearGrouping: Evidence<string> };
  readonly kcy: {
    readonly grouping: Evidence<string>;
    readonly minus: Evidence<string>;
    readonly rangeSeparator: Evidence<string>;
    readonly sameYearRange: Evidence<'single' | 'range'>;
  };
  /** The style to propose: what the rows show most, the defaults where they show nothing. */
  readonly proposed: { readonly date: DateTextStyle; readonly kcy: KcyStyle };
  /** Aspects the rows show more than one way (the owner chooses). */
  readonly conflicts: readonly string[];
}

class Tally<T extends string> {
  readonly seen: Record<string, number> = {};
  readonly examples: string[] = [];
  add(v: T, example: string) {
    this.seen[v] = (this.seen[v] ?? 0) + 1;
    if (this.examples.length < 3) this.examples.push(example);
  }
  evidence(): Evidence<T> {
    const entries = Object.entries(this.seen).sort((a, b) => b[1] - a[1]);
    return { value: (entries[0]?.[0] as T | undefined) ?? null, seen: this.seen, examples: this.examples };
  }
}

/** Learns how the tables write dates and KCY values from their rows (ADR 0038). */
export function detectStyle(tables: readonly AgeTable[]): DetectedStyle {
  const dateSep = new Tally<string>();
  const yearGroup = new Tally<string>();
  const kGroup = new Tally<string>();
  const kMinus = new Tally<string>();
  const kSep = new Tally<string>();
  const kSame = new Tally<'single' | 'range'>();
  for (const t of tables) {
    for (const r of t.rows) {
      const d = r.date;
      if (d && d.end !== null) {
        const m = /\s*[-–—−]\s*/.exec(r.dateText.replace(/^unknown\s*,?\s*/i, ''));
        if (m) dateSep.add(m[0], r.dateText);
      }
      const big = /\d{1,3}(?:,\d{3})+|\d{4,}/.exec(r.dateText);
      if (big) yearGroup.add(big[0].includes(',') ? ',' : '', r.dateText);
      const k = parseKcyCell(r.kcyText);
      if (!k) continue;
      if (k.grouping !== null) kGroup.add(k.grouping, r.kcyText);
      if (k.minus !== null) kMinus.add(k.minus, r.kcyText);
      if (k.rangeSeparator !== null) kSep.add(k.rangeSeparator, r.kcyText);
      if (d && d.end !== null && d.kcy.end === d.kcy.start)
        kSame.add(k.end === null ? 'single' : 'range', `${r.dateText} | ${r.kcyText}`);
    }
  }
  const ev = {
    date: { rangeSeparator: dateSep.evidence(), yearGrouping: yearGroup.evidence() },
    kcy: {
      grouping: kGroup.evidence(),
      minus: kMinus.evidence(),
      rangeSeparator: kSep.evidence(),
      sameYearRange: kSame.evidence(),
    },
  };
  const conflicts: string[] = [];
  const pick = <T extends string>(name: string, e: Evidence<T>, fallback: T): T => {
    if (Object.keys(e.seen).length > 1) conflicts.push(name);
    return e.value ?? fallback;
  };
  return {
    ...ev,
    proposed: {
      date: {
        rangeSeparator: pick(
          'date range separator',
          ev.date.rangeSeparator,
          DEFAULT_DATE_STYLE.rangeSeparator,
        ),
        yearGrouping: pick('year thousands separator', ev.date.yearGrouping, DEFAULT_DATE_STYLE.yearGrouping),
      },
      kcy: {
        grouping: pick('KCY thousands separator', ev.kcy.grouping, DEFAULT_KCY_STYLE.grouping),
        minus: pick('KCY minus sign', ev.kcy.minus, DEFAULT_KCY_STYLE.minus),
        rangeSeparator: pick('KCY range separator', ev.kcy.rangeSeparator, DEFAULT_KCY_STYLE.rangeSeparator),
        sameYearRange: pick(
          'KCY of a range inside one year',
          ev.kcy.sameYearRange,
          DEFAULT_KCY_STYLE.sameYearRange,
        ),
      },
    },
    conflicts,
  };
}

/** The shape of a cell's text, for the sandbox summary: digits become 9, letters a, so `Azah 18th, 4A 1` is `Aaaa 99aa, 9A 9`. */
export function cellShape(text: string): string {
  return text
    .replace(/\d+(?:,\d{3})*/g, (m) => (m.includes(',') ? '9,999' : '9'))
    .replace(/\p{Lu}\p{Ll}+/gu, 'Word')
    .replace(/\p{Ll}+/gu, 'w');
}

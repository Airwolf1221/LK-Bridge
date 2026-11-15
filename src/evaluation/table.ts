/**
 * The results table (v2 E3, ADR 0045), in the format of the owner's own table (docs/reviews/E3-evaluation.md, "Results
 * template"): one Markdown row per scenario, ready to paste into a message.
 *
 * Columns: `#`, `Scenario`, `Assistant`, `Tools called`, `Result`, `Notes`.
 *
 * Display choices, made because the owner's own table does so:
 * - Tools are listed in the order they were called. Consecutive repeats collapse to `name ×N` (a repeat after another
 *   tool is listed again): `guide ×3, search, get_resource (live: false)`.
 * - `get_bridge_guide` is written `guide`, as the owner writes it. This is only a way of showing it: the real name is
 *   what is stored, graded and compared. `get_markdown_guide` keeps its name, as the owner's table keeps it.
 * - A `get_resource` call that sent `live` shows it: `get_resource (live: false)`. Only that boolean is shown; no other
 *   argument is (the log keeps no values).
 * - Result is Right, Partly or Wrong as the owner confirmed it, or `not graded`: the auto-grade is never put there.
 * - Notes: the owner's note, then the error codes seen (`Error codes: AMBIGUOUS, SECTION_NOT_FOUND ×2`), then a count of
 *   writes without a base version.
 *
 * Pure: no database, no clock.
 */
import { ASSISTANT_LABEL, type Assistant } from './scenarios.js';
import { errorCodesOf, type AutoGrade, type RecordedCall } from './grade.js';

export type OwnerGrade = 'right' | 'partly' | 'wrong';
export const GRADE_LABEL: Readonly<Record<OwnerGrade, string>> = {
  right: 'Right',
  partly: 'Partly',
  wrong: 'Wrong',
};

/** How a tool is named in the table (display only). */
export const DISPLAY_NAME: Readonly<Record<string, string>> = { get_bridge_guide: 'guide' };

export const displayTool = (name: string): string => DISPLAY_NAME[name] ?? name;

const MULTIPLY = '×';

function label(c: RecordedCall): string {
  return `${displayTool(c.tool)}${c.live === undefined ? '' : ` (live: ${String(c.live)})`}`;
}

/** `guide ×3, search, get_resource (live: false)`; `none` when no tool was called. */
export function formatToolSequence(calls: readonly RecordedCall[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < calls.length) {
    const name = label(calls[i]!);
    let n = 1;
    while (i + n < calls.length && label(calls[i + n]!) === name) n++;
    parts.push(n > 1 ? `${name} ${MULTIPLY}${n}` : name);
    i += n;
  }
  return parts.length > 0 ? parts.join(', ') : 'none';
}

/** `AMBIGUOUS, SECTION_NOT_FOUND ×2` (most frequent first). */
export function formatErrorCodes(calls: readonly RecordedCall[]): string {
  return errorCodesOf(calls)
    .map((e) => (e.count > 1 ? `${e.code} ${MULTIPLY}${e.count}` : e.code))
    .join(', ');
}

export interface TableRow {
  readonly scenarioId: number;
  readonly shortTitle: string;
  readonly assistant: Assistant;
  readonly calls: readonly RecordedCall[];
  readonly ownerGrade: OwnerGrade | null;
  readonly note: string;
  readonly autoGrade?: Pick<AutoGrade, 'writesWithoutBaseVersion'> | null;
}

/** A cell must stay on one line and must not contain a pipe. */
const cell = (s: string): string =>
  s
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();

export function notesOf(row: Pick<TableRow, 'calls' | 'note' | 'autoGrade'>): string {
  const parts: string[] = [];
  if (row.note.trim() !== '') parts.push(row.note.trim());
  const codes = formatErrorCodes(row.calls);
  if (codes !== '') parts.push(`Error codes: ${codes}`);
  const noBase = row.autoGrade?.writesWithoutBaseVersion ?? row.calls.filter((c) => c.noBase === true).length;
  if (noBase > 0) parts.push(`write without a base version ${MULTIPLY}${noBase}`);
  return parts.join(' · ');
}

export function buildResultsTable(rows: readonly TableRow[]): string {
  const head = [
    '| # | Scenario | Assistant | Tools called | Result | Notes |',
    '| --: | --- | --- | --- | --- | --- |',
  ];
  const body = [...rows]
    .sort((a, b) => a.scenarioId - b.scenarioId)
    .map((r) =>
      [
        String(r.scenarioId),
        cell(r.shortTitle),
        ASSISTANT_LABEL[r.assistant],
        cell(formatToolSequence(r.calls)),
        r.ownerGrade ? GRADE_LABEL[r.ownerGrade] : 'not graded',
        cell(notesOf(r)),
      ].join(' | '),
    )
    .map((l) => `| ${l} |`);
  return [...head, ...body].join('\n') + '\n';
}

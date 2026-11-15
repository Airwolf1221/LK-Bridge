/**
 * Comparing two evaluation runs (v2 E3, ADR 0045): for each scenario the change in the owner's grade, the tools called
 * (added, removed, how many calls), and the error codes that appeared or went away; and a short summary, for example
 * `SECTION_NOT_FOUND: 6 → 0`.
 *
 * Only what a run keeps is compared (its own compact copy of each scenario's calls), so it works after the log has pruned
 * the rows. Pure: no database, no clock.
 */
import { errorCodesOf, type RecordedCall } from './grade.js';
import { GRADE_LABEL, type OwnerGrade } from './table.js';

export interface CompareScenario {
  readonly scenarioId: number;
  readonly shortTitle: string;
  /** Recorded (finished with Done). */
  readonly done: boolean;
  readonly calls: readonly RecordedCall[];
  readonly ownerGrade: OwnerGrade | null;
}

export interface CompareRun {
  readonly id: string;
  readonly createdAt: number;
  readonly assistant: string;
  readonly scenarios: readonly CompareScenario[];
}

export type GradeMovement = 'better' | 'worse' | 'same' | 'new' | 'unknown';

export interface ToolDelta {
  readonly tool: string;
  /** Calls in the earlier run and the later one. */
  readonly from: number;
  readonly to: number;
}

export interface ScenarioComparison {
  readonly scenarioId: number;
  readonly shortTitle: string;
  /** Recorded in the earlier run, in the later one. */
  readonly inA: boolean;
  readonly inB: boolean;
  readonly gradeA: OwnerGrade | null;
  readonly gradeB: OwnerGrade | null;
  readonly movement: GradeMovement;
  /** `Partly → Right`, `Right (unchanged)`, `not graded → Wrong`. */
  readonly gradeText: string;
  readonly callsA: number;
  readonly callsB: number;
  readonly toolsAdded: ToolDelta[];
  readonly toolsRemoved: ToolDelta[];
  readonly codesAppeared: string[];
  readonly codesGone: string[];
}

export interface ErrorCodeChange {
  readonly code: string;
  readonly from: number;
  readonly to: number;
}

export interface Comparison {
  readonly a: { id: string; createdAt: number; assistant: string };
  readonly b: { id: string; createdAt: number; assistant: string };
  readonly scenarios: ScenarioComparison[];
  /** Scenarios recorded in both runs (the error-code totals count these only, so the two sides are alike). */
  readonly commonScenarios: number;
  readonly errorCodeChanges: ErrorCodeChange[];
  readonly gradeCounts: { a: GradeCounts; b: GradeCounts };
  /** One line each: the error-code changes, the grades, the calls. */
  readonly summary: string[];
}

export interface GradeCounts {
  readonly right: number;
  readonly partly: number;
  readonly wrong: number;
  readonly notGraded: number;
}

const RANK: Record<OwnerGrade, number> = { wrong: 1, partly: 2, right: 3 };
const gradeName = (g: OwnerGrade | null): string => (g ? GRADE_LABEL[g] : 'not graded');

function countTools(calls: readonly RecordedCall[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of calls) m.set(c.tool, (m.get(c.tool) ?? 0) + 1);
  return m;
}

function movement(a: OwnerGrade | null, b: OwnerGrade | null, inA: boolean): GradeMovement {
  if (!inA) return 'new';
  if (a === null || b === null) return a === b ? 'same' : 'unknown';
  return RANK[b] > RANK[a] ? 'better' : RANK[b] < RANK[a] ? 'worse' : 'same';
}

function countGrades(list: readonly CompareScenario[]): GradeCounts {
  const n = { right: 0, partly: 0, wrong: 0, notGraded: 0 };
  for (const s of list) {
    if (!s.done) continue;
    if (s.ownerGrade) n[s.ownerGrade]++;
    else n.notGraded++;
  }
  return n;
}

export function compareRuns(a: CompareRun, b: CompareRun): Comparison {
  const byA = new Map(a.scenarios.filter((s) => s.done).map((s) => [s.scenarioId, s]));
  const byB = new Map(b.scenarios.filter((s) => s.done).map((s) => [s.scenarioId, s]));
  const ids = [...new Set([...byA.keys(), ...byB.keys()])].sort((x, y) => x - y);
  const scenarios = ids.map((id): ScenarioComparison => {
    const sa = byA.get(id);
    const sb = byB.get(id);
    const ca = sa?.calls ?? [];
    const cb = sb?.calls ?? [];
    const ta = countTools(ca);
    const tb = countTools(cb);
    const added: ToolDelta[] = [];
    const removed: ToolDelta[] = [];
    for (const tool of [...new Set([...ta.keys(), ...tb.keys()])].sort()) {
      const from = ta.get(tool) ?? 0;
      const to = tb.get(tool) ?? 0;
      if (to > from) added.push({ tool, from, to });
      else if (to < from) removed.push({ tool, from, to });
    }
    const codesA = new Set(errorCodesOf(ca).map((e) => e.code));
    const codesB = new Set(errorCodesOf(cb).map((e) => e.code));
    const gradeA = sa?.ownerGrade ?? null;
    const gradeB = sb?.ownerGrade ?? null;
    const m = movement(gradeA, gradeB, sa !== undefined);
    return {
      scenarioId: id,
      shortTitle: (sb ?? sa)?.shortTitle ?? `Scenario ${id}`,
      inA: sa !== undefined,
      inB: sb !== undefined,
      gradeA,
      gradeB,
      movement: sb === undefined ? 'unknown' : m,
      gradeText:
        sa === undefined
          ? `new: ${gradeName(gradeB)}`
          : sb === undefined
            ? `${gradeName(gradeA)} → not run`
            : gradeA === gradeB
              ? `${gradeName(gradeB)} (unchanged)`
              : `${gradeName(gradeA)} → ${gradeName(gradeB)}`,
      callsA: ca.length,
      callsB: cb.length,
      toolsAdded: added,
      toolsRemoved: removed,
      codesAppeared: [...codesB].filter((c) => !codesA.has(c)).sort(),
      codesGone: [...codesA].filter((c) => !codesB.has(c)).sort(),
    };
  });

  const common = ids.filter((id) => byA.has(id) && byB.has(id));
  const total = (m: Map<number, CompareScenario>, which: number[]): Map<string, number> => {
    const t = new Map<string, number>();
    for (const id of which)
      for (const e of errorCodesOf(m.get(id)!.calls)) t.set(e.code, (t.get(e.code) ?? 0) + e.count);
    return t;
  };
  const ea = total(byA, common);
  const eb = total(byB, common);
  const errorCodeChanges: ErrorCodeChange[] = [...new Set([...ea.keys(), ...eb.keys()])]
    .map((code) => ({ code, from: ea.get(code) ?? 0, to: eb.get(code) ?? 0 }))
    .filter((c) => c.from !== c.to)
    .sort((x, y) => Math.abs(y.to - y.from) - Math.abs(x.to - x.from) || x.code.localeCompare(y.code));

  const gradeCounts = { a: countGrades(a.scenarios), b: countGrades(b.scenarios) };
  const summary: string[] = errorCodeChanges.map((c) => `${c.code}: ${c.from} → ${c.to}`);
  if (errorCodeChanges.length === 0 && common.length > 0) summary.push('No change in the error codes seen.');
  const g = (n: GradeCounts) =>
    `${n.right} right, ${n.partly} partly, ${n.wrong} wrong, ${n.notGraded} not graded`;
  summary.push(`Grades: ${g(gradeCounts.a)} → ${g(gradeCounts.b)}`);
  const sum = (m: Map<number, CompareScenario>, which: number[]) =>
    which.reduce((n, id) => n + m.get(id)!.calls.length, 0);
  summary.push(
    `Calls in the ${common.length} scenarios both runs recorded: ${sum(byA, common)} → ${sum(byB, common)}`,
  );
  return {
    a: { id: a.id, createdAt: a.createdAt, assistant: a.assistant },
    b: { id: b.id, createdAt: b.createdAt, assistant: b.assistant },
    scenarios,
    commonScenarios: common.length,
    errorCodeChanges,
    gradeCounts,
    summary,
  };
}

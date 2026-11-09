/**
 * Report building for the v2 phase 0 spike (docs/PLAN-v2.md, section 6, session 0): small helpers for the evidence under
 * each check, and the Markdown layout of the whole report. Nothing here touches LegendKeeper.
 *
 * House rule for the report: summaries and small samples, never whole payloads. Every fenced sample is capped (40 lines
 * by default), and every line in it is cut short, so a stray long paragraph cannot flood the page.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Verdict = 'PASS' | 'FAIL' | 'INFO';

export interface CheckReport {
  readonly id: number;
  readonly title: string;
  readonly verdict: Verdict;
  /** One line for the summary table. */
  readonly summary: string;
  /** Markdown lines (already formatted) shown under the check's heading. */
  readonly evidence: readonly string[];
  /** How many requests the check made (LegendKeeper API calls through the governor, plus asset downloads). */
  readonly requests: number;
  readonly ms: number;
}

export const DEFAULT_SAMPLE_LINES = 40;
const MAX_LINE = 220;

/** One line of plain text: whitespace collapsed, control characters dropped, cut at `max` characters with an ellipsis. */
export function txt(value: unknown, max = 60): string {
  const s = (typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

/** Inline code for a bullet, safe against backticks in the value. */
export function code(value: unknown, max = 80): string {
  return `\`${txt(value, max).replace(/`/g, "'")}\``;
}

/** The evidence under one check. */
export class Evidence {
  readonly lines: string[] = [];
  constructor(private readonly sampleLines: number = DEFAULT_SAMPLE_LINES) {}

  /** A blank line. */
  gap(): this {
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== '') this.lines.push('');
    return this;
  }
  /** A bullet. */
  bullet(text: string): this {
    this.lines.push(`- ${text}`);
    return this;
  }
  /** A plain paragraph line. */
  text(text: string): this {
    this.lines.push(text);
    return this;
  }
  /** A plain line introducing a sample, with the blank line a fence needs after a paragraph. */
  caption(text: string): this {
    this.lines.push(text, '');
    return this;
  }
  /** A bold label line introducing a sample. */
  label(text: string): this {
    this.gap();
    this.lines.push(`**${text}**`);
    this.lines.push('');
    return this;
  }
  /**
   * A fenced sample of at most `sampleLines` lines (the fence itself is not counted). Longer input is cut and ends with
   * a line saying how much was left out.
   */
  sample(rows: readonly string[], cap: number = this.sampleLines): this {
    const clean = rows.map((r) => {
      const one = r.replace(/```/g, "'''").replace(/\r/g, '');
      return one.length > MAX_LINE ? `${one.slice(0, MAX_LINE - 1)}…` : one;
    });
    const shown =
      clean.length > cap ? [...clean.slice(0, cap - 1), `… (${clean.length - cap + 1} more lines)`] : clean;
    this.gap();
    this.lines.push('```text', ...shown, '```', '');
    return this;
  }
  /** A fenced sample of `key: value` lines, one per top-level field (nested values on one line each). */
  fields(obj: Record<string, unknown>, cap: number = this.sampleLines): this {
    return this.sample(
      Object.entries(obj).map(
        ([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(txt(v, 120)) : txtJson(v)}`,
      ),
      cap,
    );
  }
}

function txtJson(v: unknown): string {
  const s = JSON.stringify(v) ?? 'undefined';
  return s.length > 160 ? `${s.slice(0, 159)}…` : s;
}

/** Counts of strings, as `a×3, b×1`, most frequent first. */
export function tally(values: Iterable<string>, limit = 12): string {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  const rows = [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = rows.slice(0, limit).map(([k, n]) => `${k}×${n}`);
  if (rows.length > limit) shown.push(`… ${rows.length - limit} more`);
  return shown.length > 0 ? shown.join(', ') : '(none)';
}

/** Consecutive repeats folded: `[a, a, b]` becomes `a×2, b`. */
export function runLength(values: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < values.length;) {
    let j = i;
    while (j < values.length && values[j] === values[i]) j++;
    out.push(j - i > 1 ? `${values[i]}×${j - i}` : values[i]!);
    i = j;
  }
  return out.length > 0 ? out.join(', ') : '(none)';
}

/** `YYYYMMDD-HHMMSS` in UTC: safe in a file name and sorts by time. */
export function fileStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

/**
 * Writes the report (and, when there is one, the calendar oracle) to `<outDir>/spike-v2-<stamp>.md` and
 * `<outDir>/spike-v2-<stamp>-oracle.json`, creating the directory. Returns the paths written. The files hold the test
 * world's content but no secret; they are readable by the owner's group only.
 */
export function writeReportFiles(outDir: string, started: Date, report: string, oracle: unknown): string[] {
  mkdirSync(outDir, { recursive: true, mode: 0o750 });
  const base = join(outDir, `spike-v2-${fileStamp(started)}`);
  const written = [`${base}.md`];
  writeFileSync(written[0]!, `${report}\n`, { mode: 0o640 });
  if (oracle) {
    written.push(`${base}-oracle.json`);
    writeFileSync(written[1]!, `${JSON.stringify(oracle, null, 2)}\n`, { mode: 0o640 });
  }
  return written;
}

export interface ReportMeta {
  readonly generatedAt: string;
  readonly projectId: string;
  readonly durationMs: number;
  readonly ids: Readonly<Record<string, string>>;
  readonly stats: {
    readonly requests: number;
    readonly reads: number;
    readonly writes: number;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly networkErrors: number;
    readonly status429: number;
    readonly downloads: number;
  };
  readonly cleanup: { readonly attempted: boolean; readonly ok: boolean; readonly detail: string };
  readonly budgetFooter: string;
}

const duration = (ms: number) => `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

/** The whole report as Markdown. */
export function formatReport(meta: ReportMeta, checks: readonly CheckReport[]): string {
  const out: string[] = [];
  out.push('# LK-Bridge v2, phase 0 spike report', '');
  out.push(
    `Generated ${meta.generatedAt} against project ${code(meta.projectId)} (the test world). Took ${duration(meta.durationMs)}.`,
    '',
  );
  const counts = (v: Verdict) => checks.filter((c) => c.verdict === v).length;
  out.push(`**${counts('PASS')} PASS, ${counts('FAIL')} FAIL, ${counts('INFO')} INFO.** `);
  out.push(
    'A FAIL is a finding (an assumption in docs/PLAN-v2.md that does not hold), not a fault in the script. ' +
      'INFO is data to read. Only check 1 writes anything.',
    '',
  );
  out.push('| # | Check | Result | In one line |', '|---|---|---|---|');
  for (const c of checks)
    out.push(`| ${c.id} | ${c.title} | ${c.verdict} | ${c.summary.replace(/\|/g, '/')} |`);
  out.push('');
  out.push(
    'Ids used (override with flags): ' +
      Object.entries(meta.ids)
        .map(([k, v]) => `${k} ${code(v)}`)
        .join(', '),
    '',
  );
  for (const c of checks) {
    out.push(`## ${c.id}. ${c.title}`, '', `**${c.verdict}**: ${c.summary}`, '');
    out.push(...c.evidence);
    if (c.evidence.length > 0 && c.evidence[c.evidence.length - 1] !== '') out.push('');
  }
  const s = meta.stats;
  out.push('## Run statistics', '');
  out.push(
    `- LegendKeeper requests on the wire: ${s.requests} (${s.reads} reads, ${s.writes} writes), network errors ${s.networkErrors}.`,
    `- Responses by status: ${
      Object.entries(s.byStatus)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ') || '(none)'
    }. **429 responses: ${s.status429}** (target 0).`,
    `- Asset downloads through the outbound guard (not LegendKeeper API calls): ${s.downloads}.`,
    `- Throwaway root (check 1): ${meta.cleanup.attempted ? (meta.cleanup.ok ? 'deleted (cascade)' : `**NOT DELETED**: ${meta.cleanup.detail}`) : 'not created'}.`,
    `- ${meta.budgetFooter}`,
    '',
  );
  out.push(
    'Per check: ' +
      checks.map((c) => `${c.id}: ${c.requests} req, ${(c.ms / 1000).toFixed(1)} s`).join(' · '),
    '',
  );
  return out.join('\n');
}

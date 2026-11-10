/**
 * The Markdown diff of a page write (v2 C1, ADR 0031): the page's Markdown before and after, compared line by line, with
 * every keep region shown as one labelled placeholder line (`[keep region: infobox infobx01]`), so the owner and the
 * agent see what text changes and which protected blocks stay or go, without the regions' readable text in the way.
 *
 * Used by write_page's dry run and `detail: "full"`, and by the dashboard's proposal page.
 */

export interface DiffLine {
  readonly kind: 'same' | 'add' | 'del';
  readonly text: string;
}

export interface DiffHunk {
  /** 1-based first line and line count, before and after (unified-diff style). */
  readonly beforeStart: number;
  readonly beforeLines: number;
  readonly afterStart: number;
  readonly afterLines: number;
  readonly lines: readonly DiffLine[];
}

export interface MarkdownDiff {
  readonly added: number;
  readonly removed: number;
  readonly hunks: readonly DiffHunk[];
  /** The middle of the two texts was too large to align line by line: it is shown as removed, then added. */
  readonly coarse?: boolean;
}

const KEEP_OPEN = /^((?:[ \t]*>[ \t]?)*[ \t]*)<!-- lk:keep id="([^"]*)" kind="([^"]*)"[^>]*-->[ \t]*$/;
const KEEP_CLOSE = /^((?:[ \t]*>[ \t]?)*[ \t]*)<!-- \/lk:keep -->[ \t]*$/;

/** The page's lines, each keep region (markers and readable text) replaced by one placeholder line. */
export function withPlaceholders(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = KEEP_OPEN.exec(lines[i]!);
    if (!open) {
      out.push(lines[i]!);
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !KEEP_CLOSE.test(lines[j]!)) j++;
    if (j >= lines.length) {
      // No closing marker (cannot happen for the bridge's own Markdown): leave the lines as they are.
      out.push(lines[i]!);
      continue;
    }
    out.push(`${open[1]}[keep region: ${open[3]} ${open[2]}]`);
    i = j;
  }
  return out;
}

/** Above this many cells the middle is not aligned (it is shown as removed, then added). */
const LCS_MAX_CELLS = 4_000_000;

/** A line diff: common prefix and suffix, then an exact LCS of the middle. */
export function lineDiff(
  before: readonly string[],
  after: readonly string[],
): { lines: DiffLine[]; coarse: boolean } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  const lines: DiffLine[] = [];
  for (let i = 0; i < start; i++) lines.push({ kind: 'same', text: before[i]! });
  const mb = before.slice(start, endB);
  const ma = after.slice(start, endA);
  const n = mb.length;
  const m = ma.length;
  let coarse = false;
  if (n * m > LCS_MAX_CELLS) {
    coarse = true;
    for (const t of mb) lines.push({ kind: 'del', text: t });
    for (const t of ma) lines.push({ kind: 'add', text: t });
  } else if (n > 0 || m > 0) {
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i * w + j] =
          mb[i] === ma[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (mb[i] === ma[j]) {
        lines.push({ kind: 'same', text: mb[i]! });
        i++;
        j++;
      } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) lines.push({ kind: 'del', text: mb[i++]! });
      else lines.push({ kind: 'add', text: ma[j++]! });
    }
    while (i < n) lines.push({ kind: 'del', text: mb[i++]! });
    while (j < m) lines.push({ kind: 'add', text: ma[j++]! });
  }
  for (let i = endB; i < before.length; i++) lines.push({ kind: 'same', text: before[i]! });
  return { lines, coarse };
}

/** Groups a line diff into hunks with `context` unchanged lines around each change. */
export function toHunks(lines: readonly DiffLine[], context = 3): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const changed = lines.map((l) => l.kind !== 'same');
  let b = 1;
  let a = 1;
  const pos: { b: number; a: number }[] = lines.map((l) => {
    const p = { b, a };
    if (l.kind !== 'add') b++;
    if (l.kind !== 'del') a++;
    return p;
  });
  let i = 0;
  while (i < lines.length) {
    if (!changed[i]) {
      i++;
      continue;
    }
    const from = Math.max(0, i - context);
    // A hunk runs on while the next change is within 2 × context lines (their contexts would touch).
    let to = i;
    for (let k = i; k < lines.length; k++) {
      if (changed[k]) to = k;
      else if (k - to > 2 * context) break;
    }
    const end = Math.min(lines.length, to + context + 1);
    const slice = lines.slice(from, end);
    hunks.push({
      beforeStart: pos[from]!.b,
      beforeLines: slice.filter((l) => l.kind !== 'add').length,
      afterStart: pos[from]!.a,
      afterLines: slice.filter((l) => l.kind !== 'del').length,
      lines: slice,
    });
    i = end;
  }
  return hunks;
}

/** The Markdown diff of a page: before and after, keep regions as placeholders, in hunks. */
export function markdownDiff(before: string, after: string, context = 3): MarkdownDiff {
  const { lines, coarse } = lineDiff(withPlaceholders(before), withPlaceholders(after));
  return {
    added: lines.filter((l) => l.kind === 'add').length,
    removed: lines.filter((l) => l.kind === 'del').length,
    hunks: toHunks(lines, context),
    ...(coarse ? { coarse: true } : {}),
  };
}

/** The diff as unified-diff text (`@@ -a,b +c,d @@`, then ` `, `+` and `-` lines). */
export function unifiedText(diff: MarkdownDiff): string {
  const out: string[] = [];
  for (const h of diff.hunks) {
    out.push(`@@ -${h.beforeStart},${h.beforeLines} +${h.afterStart},${h.afterLines} @@`);
    for (const l of h.lines) out.push(`${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`);
  }
  return out.join('\n');
}

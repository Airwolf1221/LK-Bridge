/**
 * Readable diffs for proposals. A block tree becomes indented text lines (one per block) and two trees are compared
 * line by line, so an owner sees what text is added and removed. Anything else is shown as before and after fields.
 */

export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An array of objects that each have a string `kind`, or one such object: LegendKeeper block content. */
export function looksLikeBlocks(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0 && v.every((b) => isDict(b) && typeof b.kind === 'string');
  return isDict(v) && typeof v.kind === 'string' && ('content' in v || 'children' in v || 'text' in v);
}

const SKIP = new Set(['id', 'kind', 'content', 'children', 'version', 'text']);

function inlineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) =>
      isDict(c)
        ? typeof c.text === 'string'
          ? c.text
          : inlineText(c.content)
        : typeof c === 'string'
          ? c
          : '',
    )
    .join('');
}

function walk(b: Dict, depth: number, out: string[]): void {
  const indent = '  '.repeat(depth);
  const kind = String(b.kind);
  if (kind === 'unsupported') {
    out.push(`${indent}[unsupported block: kept as it is]`);
    return;
  }
  const text = typeof b.text === 'string' ? b.text : inlineText(b.content);
  const props = Object.entries(b)
    .filter(
      ([k, v]) => !SKIP.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'),
    )
    .map(([k, v]) => `${k}=${String(v)}`);
  out.push(`${indent}[${kind}${props.length ? ` ${props.join(' ')}` : ''}]${text ? ` ${text}` : ''}`);
  if (Array.isArray(b.children)) for (const c of b.children) if (isDict(c)) walk(c, depth + 1, out);
}

/** One line per block, indented by depth. */
export function blocksToLines(v: unknown): string[] {
  const out: string[] = [];
  const list = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
  for (const b of list) if (isDict(b)) walk(b, 0, out);
  return out;
}

/** A longest-common-subsequence line diff. Very large inputs fall back to "all removed, all added". */
export function lineDiff(before: readonly string[], after: readonly string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  if (n * m > 4_000_000) {
    return [
      ...before.map((text): DiffLine => ({ kind: 'del', text })),
      ...after.map((text): DiffLine => ({ kind: 'add', text })),
    ];
  }
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] =
        before[i] === after[j]
          ? t[(i + 1) * w + j + 1]! + 1
          : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ kind: 'same', text: before[i]! });
      i++;
      j++;
    } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) {
      out.push({ kind: 'del', text: before[i++]! });
    } else {
      out.push({ kind: 'add', text: after[j++]! });
    }
  }
  while (i < n) out.push({ kind: 'del', text: before[i++]! });
  while (j < m) out.push({ kind: 'add', text: after[j++]! });
  return out;
}

export const diffBlocks = (before: unknown, after: unknown): DiffLine[] =>
  lineDiff(blocksToLines(before), blocksToLines(after));

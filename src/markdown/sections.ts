/**
 * Sections (docs/PLAN-v2.md 4.7 rule 6): a section runs from a top-level heading to the next top-level heading of the
 * same or a higher level. It is addressed by its heading path, `Biography > Early Life`: the segments must appear in
 * that order on the way down to the heading, and the last one is the heading itself. Matching is exact on the heading's
 * text, else case-insensitive. A path that matches several headings is refused with the options listed; add `[n]` to
 * the last segment (`Notes [2]`) to pick the n-th of them.
 */
import type { Heading, RootContent } from 'mdast';
import { MarkdownError } from './errors.js';
import { isObj, mentionLabel } from './model.js';
import { KEEP_CLOSE_RE, KEEP_OPEN_RE, parseMdast, plainText } from './parse.js';
import type { LkBlock, OutlineEntry, Section } from './types.js';

export interface HeadingRef {
  readonly level: number;
  readonly text: string;
  readonly path: readonly string[];
  /** Index of the heading among the top-level items (blocks or Markdown items). */
  readonly index: number;
  readonly line: number;
  readonly blockId?: string;
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A heading's text as its Markdown reads: text, mention labels, a space for a line break, "(icon)" for an inline icon. */
function headingText(runs: unknown): string {
  if (!Array.isArray(runs)) return '';
  return runs
    .map((r: unknown) => {
      if (!isObj(r)) return '';
      if (typeof r.text === 'string') return r.text;
      if (isObj(r.mention)) return mentionLabel(r.mention);
      if (r.break === true) return ' ';
      return '(icon)';
    })
    .join('');
}

/** Assigns heading paths from levels. */
function withPaths(raw: readonly Omit<HeadingRef, 'path'>[]): HeadingRef[] {
  const stack: { level: number; text: string }[] = [];
  return raw.map((h) => {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push({ level: h.level, text: h.text });
    return { ...h, path: stack.map((s) => s.text) };
  });
}

/** Top-level headings of a block tree. */
export function blockHeadings(blocks: readonly LkBlock[]): HeadingRef[] {
  const raw: Omit<HeadingRef, 'path'>[] = [];
  blocks.forEach((b, i) => {
    if (!isObj(b) || b.kind !== 'heading' || !Number.isInteger(b.level)) return;
    raw.push({
      level: b.level as number,
      text: clean(headingText(b.content)),
      index: i,
      line: 0,
      ...(typeof b.id === 'string' ? { blockId: b.id } : {}),
    });
  });
  return withPaths(raw);
}

interface MdItem {
  readonly node: RootContent;
  /** First and last line of the item (a keep region spans its markers). */
  readonly startLine: number;
  readonly endLine: number;
  readonly heading: Heading | null;
}

/** Top-level items of Markdown, with keep regions as one item (a heading kept as a region still counts as a heading). */
function mdItems(md: string): MdItem[] {
  const nodes = parseMdast(md).children;
  const out: MdItem[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const start = n.position?.start.line ?? 0;
    if (n.type === 'html') {
      const open = KEEP_OPEN_RE.exec(n.value.trim());
      if (open) {
        let j = i + 1;
        while (
          j < nodes.length &&
          !(nodes[j]!.type === 'html' && KEEP_CLOSE_RE.test((nodes[j] as { value: string }).value.trim()))
        )
          j++;
        const inner = nodes[i + 1];
        const heading = open[2] === 'heading' && inner?.type === 'heading' ? inner : null;
        out.push({
          node: n,
          startLine: start,
          endLine: nodes[Math.min(j, nodes.length - 1)]!.position?.end.line ?? start,
          heading,
        });
        i = j;
        continue;
      }
    }
    out.push({
      node: n,
      startLine: start,
      endLine: n.position?.end.line ?? start,
      heading: n.type === 'heading' ? n : null,
    });
  }
  return out;
}

function mdHeadings(items: readonly MdItem[]): HeadingRef[] {
  const raw: Omit<HeadingRef, 'path'>[] = [];
  items.forEach((it, i) => {
    if (!it.heading) return;
    raw.push({
      level: it.heading.depth,
      text: clean(it.heading.children.map(plainText).join('')),
      index: i,
      line: it.startLine,
    });
  });
  return withPaths(raw);
}

/** The headings of a page's Markdown, with their paths. */
export function outline(md: string): OutlineEntry[] {
  return mdHeadings(mdItems(md)).map((h) => ({
    level: h.level,
    text: h.text,
    path: h.path.join(' > '),
    line: h.line,
  }));
}

/** Finds the one heading a path names (typed errors otherwise). */
export function findSection(headings: readonly HeadingRef[], path: string): HeadingRef {
  const segments = path
    .split('>')
    .map(clean)
    .filter((s) => s !== '');
  if (segments.length === 0)
    throw new MarkdownError(
      'INVALID_EDIT',
      'The section path is empty. Name a heading, e.g. "Biography > Early Life".',
    );
  let pick: number | null = null;
  const last = /^(.*?)\s*\[(\d+)\]$/.exec(segments[segments.length - 1]!);
  const tryMatch = (segs: string[], fold: boolean): HeadingRef[] => {
    const eq = (a: string, b: string) => (fold ? a.toLowerCase() === b.toLowerCase() : a === b);
    return headings.filter((h) => {
      if (!eq(h.text, segs[segs.length - 1]!)) return false;
      let k = segs.length - 2;
      for (let p = h.path.length - 2; p >= 0 && k >= 0; p--) if (eq(h.path[p]!, segs[k]!)) k--;
      return k < 0;
    });
  };
  let found = tryMatch(segments, false);
  if (found.length === 0) found = tryMatch(segments, true);
  if (found.length === 0 && last) {
    const segs = [...segments.slice(0, -1), last[1]!];
    pick = Number(last[2]);
    found = tryMatch(segs, false);
    if (found.length === 0) found = tryMatch(segs, true);
  }
  const options = (list: readonly HeadingRef[]) =>
    list.map((h, i) => ({
      path: h.path.join(' > '),
      choose: list.length > 1 ? `${h.path.join(' > ')} [${i + 1}]` : h.path.join(' > '),
      level: h.level,
      ...(h.line ? { line: h.line } : {}),
      ...(h.blockId ? { blockId: h.blockId } : {}),
    }));
  if (found.length === 0)
    throw new MarkdownError(
      'SECTION_NOT_FOUND',
      `No heading matches "${path}". The page's headings are: ${headings.map((h) => `"${h.path.join(' > ')}"`).join(', ') || '(none)'}.`,
      { path, available: options(headings) },
    );
  if (pick !== null) {
    const h = found[pick - 1];
    if (!h)
      throw new MarkdownError(
        'SECTION_NOT_FOUND',
        `"${path}" asks for match ${pick}, but only ${found.length} heading(s) match.`,
        {
          path,
          options: options(found),
        },
      );
    return h;
  }
  if (found.length > 1)
    throw new MarkdownError(
      'SECTION_AMBIGUOUS',
      `${found.length} headings match "${path}": ${options(found)
        .map((o) => `"${o.choose}"${o.line ? ` (line ${o.line})` : ''}`)
        .join(', ')}. Use a longer path, or add [n] to pick one.`,
      { path, options: options(found) },
    );
  return found[0]!;
}

/** The extent of a section among top-level items: [heading index, end index). */
export function sectionRange(
  headings: readonly HeadingRef[],
  h: HeadingRef,
  itemCount: number,
): [number, number] {
  const next = headings.find((x) => x.index > h.index && x.level <= h.level);
  return [h.index, next ? next.index : itemCount];
}

/** One section of a page's Markdown, by heading path. */
export function getSection(md: string, path: string): Section {
  const items = mdItems(md);
  const headings = mdHeadings(items);
  const h = findSection(headings, path);
  const [a, b] = sectionRange(headings, h, items.length);
  const lines = md.split(/\r?\n/);
  const startLine = items[a]!.startLine;
  const endLine = b > a + 1 ? items[b - 1]!.endLine : items[a]!.endLine;
  const text = lines.slice(startLine - 1, endLine).join('\n');
  const headItem = items[a]!;
  const body = lines.slice(headItem.endLine, endLine).join('\n').replace(/^\n+/, '');
  return {
    heading: { level: h.level, text: h.text, path: h.path.join(' > '), line: h.line },
    markdown: `${text}\n`,
    body: body === '' ? '' : `${body}\n`,
    startLine,
    endLine,
  };
}

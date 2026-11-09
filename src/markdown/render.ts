/**
 * `toMarkdown`: a page's blocks → Markdown (docs/PLAN-v2.md 4.7; the agent guide is docs/markdown.md).
 *
 * Every block Markdown can express is written in the owner's schema; everything else becomes a keep region,
 * `<!-- lk:keep id="…" kind="…" -->` + a readable rendering + `<!-- /lk:keep -->`, restored exactly on write.
 *
 * Exactness is checked, not assumed: a line with marks is parsed back and, if CommonMark's emphasis rules would read it
 * differently, rendered again with HTML tags; and (unless `selfCheck: false`) the whole page is parsed back and compared
 * with the blocks' projections. A top-level block that still does not come back identical is turned into a keep region,
 * with a warning, so the Markdown never misrepresents the page.
 */
import { MarkdownError } from './errors.js';
import { destination, escapeLineStart, escapeText, needsCheck, protectEdges, renderRuns } from './inline.js';
import {
  analyse,
  canon,
  fingerprint,
  fullProjection,
  Interner,
  jsonEqual,
  projectedChildren,
  SAFE_ID_RE,
  toLkRuns,
  type ANode,
  type NRun,
} from './model.js';
import { parseDrafts, parseInlineCell, parseInlineLine, type Draft } from './parse.js';
import { readableLines } from './readable.js';
import type {
  DocumentInput,
  KeepRegion,
  LkBlock,
  MarkdownWarning,
  ToMarkdownContext,
  ToMarkdownResult,
} from './types.js';

export function documentBlocks(doc: DocumentInput): readonly LkBlock[] {
  if (Array.isArray(doc)) return doc as readonly LkBlock[];
  const blocks = (doc as { blocks?: unknown }).blocks;
  return Array.isArray(blocks) ? (blocks as LkBlock[]) : [];
}

export function keepMarker(id: string, kind: string): string {
  return `<!-- lk:keep id="${id}" kind="${SAFE_ID_RE.test(kind) ? kind : 'block'}" -->`;
}
export const KEEP_CLOSE = '<!-- /lk:keep -->';

interface RenderState {
  /** Nodes forced into keep regions by the self-check. */
  readonly forced: Map<ANode, string>;
}

const isKeep = (n: ANode, s: RenderState): boolean => n.keep !== null || s.forced.has(n);

// ------------------------------------------------------------------------------------------------ inline lines

/** One line of inline Markdown for runs, checked against the parser when it carries marks. */
export function inlineLine(
  runs: readonly NRun[],
  opts: { table?: boolean; lineStart?: boolean; heading?: boolean } = {},
): string | null {
  const finish = (s: string) => {
    let out = protectEdges(s);
    // A heading's trailing "#"s would be read as its closing sequence.
    if (opts.heading && endsWithRaw(out, '#')) out = `${out.slice(0, -1)}\\#`;
    if (opts.lineStart) out = escapeLineStart(out);
    return out;
  };
  const plain = finish(renderRuns(runs, { table: opts.table === true }));
  if (!needsCheck(runs)) return plain;
  const want = toLkRuns(runs);
  const table = opts.table === true;
  if (inlineMatches(plain, want, table)) return plain;
  const html = finish(renderRuns(runs, { table, html: true }));
  if (inlineMatches(html, want, table)) return html;
  return null;
}

/** Whether `s` ends with `c` not already escaped by a backslash (an even number of backslashes before it). */
function endsWithRaw(s: string, c: string): boolean {
  if (!s.endsWith(c)) return false;
  let n = 0;
  for (let i = s.length - 2; i >= 0 && s[i] === '\\'; i--) n++;
  return n % 2 === 0;
}

function inlineMatches(line: string, want: unknown, table: boolean): boolean {
  if (line === '') return Array.isArray(want) && want.length === 0;
  // A cell is checked inside a table; any other line on its own, where it must not start a block that its real place
  // (a task, a list item) would not start.
  const got = table ? parseInlineCell(line) : parseInlineLine(escapeLineStart(line));
  return got !== null && jsonEqual(got, want);
}

// ------------------------------------------------------------------------------------------------ blocks

function prefixQuote(lines: readonly string[]): string[] {
  return lines.map((l) => (l === '' ? '>' : `> ${l}`));
}

function indent(lines: readonly string[], width: number): string[] {
  const pad = ' '.repeat(width);
  return lines.map((l) => (l === '' ? '' : `${pad}${l}`));
}

/** A line that CommonMark reads as an HTML block, so the next line cannot follow it without a blank line. */
const htmlLine = (l: string | undefined): boolean =>
  l !== undefined && (/^<[^>]*>$/.test(l) || l === '<p></p>');

class Renderer {
  constructor(private readonly s: RenderState) {}

  /** Blocks separated by blank lines, alternating list markers so neighbouring lists stay separate. */
  blocks(nodes: readonly ANode[]): string[] {
    const out: string[] = [];
    let prevBullet: string | null = null;
    let prevOrdered: string | null = null;
    for (const n of nodes) {
      if (out.length > 0) out.push('');
      const kind = isKeep(n, this.s) ? 'keep' : n.block.kind;
      const bullet: string | null =
        kind === 'bulletList' || kind === 'taskList' ? (prevBullet === '-' ? '*' : '-') : null;
      const ordered: string | null = kind === 'orderedList' ? (prevOrdered === '.' ? ')' : '.') : null;
      out.push(...this.node(n, bullet ?? '-', ordered ?? '.'));
      prevBullet = bullet;
      prevOrdered = ordered;
    }
    return out;
  }

  node(n: ANode, bullet = '-', delim = '.'): string[] {
    if (isKeep(n, this.s)) return keepLines(n);
    const b = n.block;
    switch (b.kind) {
      case 'paragraph':
        return [this.paragraphLine(n)];
      case 'heading': {
        const s = this.line(n, { lineStart: true, heading: true });
        return [`${'#'.repeat(b.level as number)}${s !== '' ? ` ${s}` : ''}`];
      }
      case 'quote':
        return prefixQuote(this.blocks(projectedChildren(n)));
      case 'callout':
        return prefixQuote([`[!${String(b.tone)}]`, '', ...this.blocks(projectedChildren(n))]);
      case 'secret':
        return prefixQuote(['[!secret]', '', ...this.blocks(projectedChildren(n))]);
      case 'expand': {
        const title = protectEdges(escapeText(b.title as string));
        return prefixQuote([
          `[!expand]${title !== '' ? ` ${title}` : ''}`,
          '',
          ...this.blocks(projectedChildren(n)),
        ]);
      }
      case 'code':
        return codeLines(b.text as string, typeof b.language === 'string' ? b.language : '');
      case 'rule':
        return ['---'];
      case 'bulletList':
        return n.children.flatMap((item) => this.item(item, `${bullet} `));
      case 'orderedList': {
        const start = typeof b.start === 'number' ? b.start : 1;
        return n.children.flatMap((item, i) => this.item(item, `${start + i}${delim} `));
      }
      case 'taskList':
        return n.children.map((t) => {
          const s = this.line(t, { lineStart: false });
          return `${bullet} [${t.block.checked === true ? 'x' : ' '}] ${s !== '' ? s : '<!-- empty -->'}`;
        });
      case 'table':
        return this.table(n);
      case 'image': {
        const alt = typeof b.alt === 'string' ? escapeText(b.alt) : '';
        return [`![${alt}](${destination(b.url as string)})`];
      }
      default:
        // Unreachable: analyse() marks every other kind as a keep region.
        return keepLines(n);
    }
  }

  private line(n: ANode, opts: { table?: boolean; lineStart?: boolean; heading?: boolean }): string {
    const s = inlineLine(n.runs ?? [], opts);
    if (s === null) throw new UnrenderableError(n);
    return s;
  }

  private paragraphLine(n: ANode): string {
    if ((n.runs ?? []).length === 0) return '<p></p>';
    return this.line(n, { lineStart: true });
  }

  private item(item: ANode, marker: string): string[] {
    const kids = projectedChildren(item);
    const width = marker.length;
    const out: string[] = [];
    let prev: ANode | null = null;
    let prevLines: string[] = [];
    let prevBullet: string | null = null;
    let prevOrdered: string | null = null;
    kids.forEach((k, idx) => {
      const kind = isKeep(k, this.s) ? 'keep' : k.block.kind;
      const bullet: string | null =
        kind === 'bulletList' || kind === 'taskList' ? (prevBullet === '-' ? '*' : '-') : null;
      const ordered: string | null = kind === 'orderedList' ? (prevOrdered === '.' ? ')' : '.') : null;
      let lines: string[];
      if (idx === 0 && kind === 'paragraph' && (k.runs ?? []).length === 0)
        lines = kids.length === 1 ? [''] : ['<p></p>'];
      else lines = this.node(k, bullet ?? '-', ordered ?? '.');
      if (idx === 0) {
        out.push(lines[0] === '' ? marker.trimEnd() : `${marker}${lines[0]}`);
        out.push(...indent(lines.slice(1), width));
      } else {
        if (!this.tight(prev!, prevLines, k, lines)) out.push('');
        out.push(...indent(lines, width));
      }
      prev = k;
      prevLines = lines;
      prevBullet = bullet;
      prevOrdered = ordered;
    });
    return out;
  }

  /** Whether `next` may follow `prev` inside a list item without a blank line (a tight list). */
  private tight(
    prev: ANode,
    prevLines: readonly string[],
    next: ANode,
    nextLines: readonly string[],
  ): boolean {
    if (isKeep(prev, this.s) || isKeep(next, this.s)) return false;
    // A bare "-" right under a line of text would underline it as a heading (setext), and an empty item cannot
    // interrupt a paragraph (it would become part of the text).
    if (/^(?:[-=*+]+|\d{1,9}[.)])$/.test(nextLines[0] ?? '')) return false;
    const prevOk =
      (prev.block.kind === 'paragraph' && !htmlLine(prevLines[prevLines.length - 1])) ||
      prev.block.kind === 'bulletList' ||
      prev.block.kind === 'taskList' ||
      prev.block.kind === 'orderedList';
    if (!prevOk) return false;
    if (next.block.kind === 'bulletList' || next.block.kind === 'taskList') return true;
    if (next.block.kind === 'orderedList') return next.block.start === undefined || next.block.start === 1;
    return false;
  }

  private table(n: ANode): string[] {
    const rows = n.children.map((r) =>
      r.children.map((c) => {
        const p = projectedChildren(c)[0]!;
        return this.line(p, { table: true });
      }),
    );
    const fmt = (cells: string[]) => `| ${cells.join(' | ')} |`;
    const head = rows[0]!;
    return [fmt(head), fmt(head.map(() => '---')), ...rows.slice(1).map(fmt)];
  }
}

class UnrenderableError extends Error {
  constructor(readonly node: ANode) {
    super('unrenderable');
  }
}

export function codeLines(text: string, language: string): string[] {
  const runs = new Set((text.match(/`{3,}/g) ?? []).map((r) => r.length));
  let n = 3;
  while ([...runs].some((r) => r >= n)) n++;
  const fence = '`'.repeat(n);
  return [`${fence}${language}`, ...(text === '' ? [] : text.split('\n')), fence];
}

export function keepLines(n: ANode): string[] {
  return [keepMarker(n.keepId!, n.block.kind), '', ...readableLines(n.block), '', KEEP_CLOSE];
}

// ------------------------------------------------------------------------------------------------ the check

/** Fingerprint of a parsed draft (the same space as model.fingerprint). */
export function draftFingerprint(d: Draft, interner: Interner): number {
  if (d.t === 'keep') return interner.id(`K:${d.id}`);
  if (d.t === 'raw') return interner.fresh();
  if (d.fp !== undefined && d.fpBy === interner) return d.fp;
  const kids = d.children ? d.children.map((c) => draftFingerprint(c, interner)) : [];
  d.fp = interner.id(`${canon(d.own)}:${kids.join(',')}`);
  d.fpBy = interner;
  return d.fp;
}

/** The fingerprint a node has when the self-check forced it into a keep region. */
function nodeFp(n: ANode, s: RenderState, interner: Interner): number {
  if (s.forced.has(n)) return interner.id(`K:${n.keepId ?? String(n.block.id)}`);
  return fingerprint(n, interner);
}

function sameTopLevel(nodes: readonly ANode[], drafts: readonly Draft[], s: RenderState): boolean {
  if (nodes.length !== drafts.length) return false;
  const interner = new Interner();
  // Forced nodes keep their memoised fingerprints out of the comparison.
  return nodes.every((n, i) => nodeFp(n, s, interner) === draftFingerprint(drafts[i]!, interner));
}

class Forcer {
  private n = 0;
  constructor(
    readonly s: RenderState,
    readonly warnings: MarkdownWarning[],
  ) {}
  /** Turns a top-level node into a keep region (with a synthetic id when its own cannot be written in a marker). */
  force(n: ANode, why: string): void {
    if (this.s.forced.has(n)) return;
    this.s.forced.set(n, why);
    const id = n.block.id;
    (n as { keepId: string | null }).keepId =
      typeof id === 'string' && SAFE_ID_RE.test(id) ? id : `anon-x${++this.n}`;
    this.warnings.push({
      code: 'RENDERED_AS_KEEP_REGION',
      message: `A ${n.block.kind} block is shown as a keep region because ${why}.`,
      ...(typeof id === 'string' ? { at: id } : {}),
    });
  }
}

function renderAll(nodes: readonly ANode[], f: Forcer): string {
  const r = new Renderer(f.s);
  for (;;) {
    try {
      const lines = r.blocks(nodes);
      return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
    } catch (e) {
      if (!(e instanceof UnrenderableError)) throw e;
      f.force(topLevelOf(nodes, e.node), 'its formatting has no exact Markdown form');
    }
  }
}

function topLevelOf(nodes: readonly ANode[], target: ANode): ANode {
  const contains = (n: ANode): boolean => n === target || projectedChildren(n).some(contains);
  return nodes.find(contains) ?? target;
}

function parsesBack(md: string, nodes: readonly ANode[], s: RenderState): boolean {
  try {
    return sameTopLevel(nodes, parseDrafts(md).drafts, s);
  } catch {
    return false;
  }
}

export interface RenderedPage {
  readonly markdown: string;
  readonly nodes: readonly ANode[];
  readonly forced: ReadonlyMap<ANode, string>;
  readonly warnings: MarkdownWarning[];
}

/** Renders a page, with the self-check. Shared by toMarkdown and fromMarkdown (which must see the same regions). */
export function renderPage(blocks: readonly LkBlock[], selfCheck: boolean): RenderedPage {
  const nodes = analyse(blocks);
  const s: RenderState = { forced: new Map() };
  const warnings: MarkdownWarning[] = [];
  const f = new Forcer(s, warnings);
  let md = renderAll(nodes, f);
  if (!selfCheck || parsesBack(md, nodes, s)) return { markdown: md, nodes, forced: s.forced, warnings };
  // Find the top-level blocks that do not come back, and keep them.
  for (const n of nodes) {
    if (isKeep(n, s)) continue;
    if (!parsesBack(renderAll([n], f), [n], s))
      f.force(n, 'its Markdown would not convert back to exactly the same block');
  }
  md = renderAll(nodes, f);
  if (parsesBack(md, nodes, s)) return { markdown: md, nodes, forced: s.forced, warnings };
  throw new MarkdownError(
    'RENDER_SELF_CHECK_FAILED',
    'The page could not be written as Markdown that converts back exactly. This is a converter bug: run the round-trip script on this page and report it.',
  );
}

/** Every keep region, top-most only, in document order. */
export function regionsOf(nodes: readonly ANode[], forced: ReadonlyMap<ANode, string>): KeepRegion[] {
  const out: KeepRegion[] = [];
  const walk = (list: readonly ANode[]) => {
    for (const n of list) {
      const why = n.keep ?? forced.get(n);
      if (why !== undefined && why !== null)
        out.push({ id: n.keepId ?? String(n.block.id), kind: n.block.kind, reason: why });
      else walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * A page's block tree → Markdown. `regions` lists every keep region (id, kind and why Markdown cannot show it).
 */
export function toMarkdown(document: DocumentInput, ctx: ToMarkdownContext = {}): ToMarkdownResult {
  const page = renderPage(documentBlocks(document), ctx.selfCheck !== false);
  return { markdown: page.markdown, regions: regionsOf(page.nodes, page.forced), warnings: page.warnings };
}

/** For tests: what a page's Markdown shows (keep regions as `{ kind: '@keep', id }`). */
export function projectDocument(document: DocumentInput): LkBlock[] {
  return analyse(documentBlocks(document)).map(fullProjection);
}

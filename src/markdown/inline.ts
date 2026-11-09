/**
 * Runs → one line of inline Markdown (paragraphs, headings, table cells, tasks, list items).
 *
 * Marks become `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `<u>`, `<sub>`, `<sup>`, `<span style="color:…">`,
 * `<span style="background-color:…">` and `[text](url)`. CommonMark's emphasis rules (flanking delimiters) cannot
 * express every run boundary, for example bold text that ends in a space; the renderer is therefore run twice when
 * needed: first with Markdown delimiters, then (`html: true`) with `<strong>`, `<em>` and `<s>`, which have no such
 * rules. The caller checks which one parses back exactly (see render.ts).
 *
 * Every character Markdown would read as syntax is escaped with a backslash: `\ ` * [ ] < ~` always, `_` unless it
 * sits between two letters or digits, `|` in table cells, `&` when it would start an entity, `!` before a link, and
 * the characters that would start a block at the beginning of a line.
 */
import { BOOL_MARKS, type Marks, type NRun } from './model.js';

export interface InlineOptions {
  /** In a GFM table cell: escape `|`. */
  readonly table?: boolean;
  /** Use HTML tags for bold, italic and strikethrough (the fallback when delimiters would not parse back). */
  readonly html?: boolean;
}

type MarkKey = 'link' | 'color' | 'highlight' | 'underline' | 'sup' | 'sub' | 'bold' | 'italic' | 'strike';
/** Outer to inner, when several marks open at once and last equally long. */
const ORDER: readonly MarkKey[] = [
  'link',
  'color',
  'highlight',
  'underline',
  'sup',
  'sub',
  'bold',
  'italic',
  'strike',
];

interface OpenMark {
  readonly key: MarkKey;
  readonly value: string;
}

const ENTITY_RE = /^&(?:#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]{0,31};)/;
/** A character that is neither whitespace nor punctuation/symbol, in CommonMark's (and micromark's) sense. */
const isWordChar = (c: string | undefined): boolean => c !== undefined && !/[\s\p{P}\p{S}]/u.test(c);

/** Escapes text for inline Markdown (not the line-start rules; see `escapeLineStart`). */
export function escapeText(text: string, table = false): string {
  const cps = Array.from(text);
  let out = '';
  let offset = 0;
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!;
    switch (c) {
      case '\\':
      case '`':
      case '*':
      case '[':
      case ']':
      case '<':
      case '~':
        out += `\\${c}`;
        break;
      case '|':
        out += table ? '\\|' : '|';
        break;
      case '&':
        out += ENTITY_RE.test(text.slice(offset)) ? '\\&' : '&';
        break;
      case '_': {
        let j = i;
        while (cps[j + 1] === '_') j++;
        const literal = isWordChar(cps[i - 1]) && isWordChar(cps[j + 1]);
        out += (literal ? '_' : '\\_').repeat(j - i + 1);
        offset += j - i;
        i = j;
        break;
      }
      default:
        out += c;
    }
    offset += c.length;
  }
  return out;
}

/** Escapes what would start a block at the beginning of a line (heading, quote, list, numbered list). */
export function escapeLineStart(s: string): string {
  if (/^[#>+-]/.test(s)) return `\\${s}`;
  const m = /^(\d{1,9})([.)])/.exec(s);
  if (m) return `${m[1]}\\${s.slice(m[1]!.length)}`;
  return s;
}

/** Leading and trailing spaces or tabs are dropped by CommonMark; write the outermost ones as character references. */
export function protectEdges(s: string): string {
  const ref = (c: string) => (c === '\t' ? '&#9;' : '&#32;');
  if (s.length === 0) return s;
  let out = s;
  if (out.endsWith(' ') || out.endsWith('\t')) out = `${out.slice(0, -1)}${ref(out[out.length - 1]!)}`;
  if (out.startsWith(' ') || out.startsWith('\t')) out = `${ref(out[0]!)}${out.slice(1)}`;
  return out;
}

/** A code span whose fence differs from every backtick run inside it. */
export function codeSpan(text: string, table = false): string {
  const t = table ? text.replace(/\|/g, '\\|') : text;
  const runs = new Set((t.match(/`+/g) ?? []).map((r) => r.length));
  let n = 1;
  while (runs.has(n)) n++;
  const fence = '`'.repeat(n);
  const pad =
    t.startsWith('`') || t.endsWith('`') || (t.startsWith(' ') && t.endsWith(' ') && /[^ ]/.test(t));
  return pad ? `${fence} ${t} ${fence}` : `${fence}${t}${fence}`;
}

/** A link destination: bare when it is simple, else in angle brackets. Backslashes, `&` before an entity, and `|` in tables are escaped. */
export function destination(url: string, table = false): string {
  let d = url.replace(/\\/g, '\\\\').replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&');
  if (table) d = d.replace(/\|/g, '\\|');
  if (d === '' || /[\s<>()]/.test(d) || [...d].some((c) => c.charCodeAt(0) < 0x20 || c === '\x7f')) {
    return `<${d.replace(/[<>]/g, (c) => `\\${c}`)}>`;
  }
  return d;
}

export function mentionUrl(resourceId: string, documentId?: string): string {
  return documentId !== undefined
    ? `lk://resources/${resourceId}/docs/${documentId}`
    : `lk://resources/${resourceId}`;
}

function marksOf(m: Marks): OpenMark[] {
  const out: OpenMark[] = [];
  for (const key of ORDER) {
    if (key === 'link') {
      if (m.link !== undefined) out.push({ key, value: m.link });
    } else if (key === 'color' || key === 'highlight') {
      const v = m[key];
      if (v !== undefined) out.push({ key, value: v });
    } else if (m[key]) out.push({ key, value: '1' });
  }
  return out;
}

const has = (list: readonly OpenMark[], o: OpenMark) =>
  list.some((x) => x.key === o.key && x.value === o.value);

function opener(o: OpenMark, html: boolean): string {
  switch (o.key) {
    case 'link':
      return '[';
    case 'color':
      return `<span style="color:${o.value}">`;
    case 'highlight':
      return `<span style="background-color:${o.value}">`;
    case 'underline':
      return '<u>';
    case 'sup':
      return '<sup>';
    case 'sub':
      return '<sub>';
    case 'bold':
      return html ? '<strong>' : '**';
    case 'italic':
      return html ? '<em>' : '*';
    case 'strike':
      return html ? '<s>' : '~~';
  }
}

function closer(o: OpenMark, html: boolean, table: boolean): string {
  switch (o.key) {
    case 'link':
      return `](${destination(o.value, table)})`;
    case 'color':
    case 'highlight':
      return '</span>';
    case 'underline':
      return '</u>';
    case 'sup':
      return '</sup>';
    case 'sub':
      return '</sub>';
    case 'bold':
      return html ? '</strong>' : '**';
    case 'italic':
      return html ? '</em>' : '*';
    case 'strike':
      return html ? '</s>' : '~~';
  }
}

/** True when any run has a mark, a link or a mention: the output then needs checking against the parser. */
export function needsCheck(runs: readonly NRun[]): boolean {
  return runs.some(
    (r) =>
      r.t === 'mention' ||
      (r.t === 'text' &&
        (BOOL_MARKS.some((k) => r.marks[k]) ||
          r.marks.link !== undefined ||
          r.marks.color !== undefined ||
          r.marks.highlight !== undefined)),
  );
}

/** Renders runs as one line of inline Markdown (edges and line start not yet protected). */
export function renderRuns(runs: readonly NRun[], opts: InlineOptions = {}): string {
  const html = opts.html === true;
  const table = opts.table === true;
  const stack: OpenMark[] = [];
  let out = '';
  const nextText = (i: number): Extract<NRun, { t: 'text' }> | undefined => {
    for (let j = i; j < runs.length; j++) {
      const r = runs[j]!;
      if (r.t === 'text') return r;
      if (r.t === 'mention') return undefined;
    }
    return undefined;
  };
  const closeTo = (target: readonly OpenMark[]) => {
    let k = 0;
    while (k < stack.length && has(target, stack[k]!)) k++;
    while (stack.length > k) out += closer(stack.pop()!, html, table);
  };
  const openBracket = () => {
    // `!` right before `[` would make an image.
    if (out.endsWith('!')) out = `${out.slice(0, -1)}\\!`;
  };
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]!;
    if (r.t !== 'text') {
      const next = nextText(i + 1);
      const keep = next ? marksOf(next.marks).filter((o) => has(stack, o)) : [];
      closeTo(r.t === 'mention' ? keep.filter((o) => o.key !== 'link') : keep);
      if (r.t === 'break') out += '<br>';
      else {
        openBracket();
        out += `[${escapeText(r.label, table)}](${destination(mentionUrl(r.resourceId, r.documentId), table)})`;
      }
      continue;
    }
    const target = marksOf(r.marks);
    closeTo(target);
    const toOpen = target.filter((o) => !has(stack, o));
    if (toOpen.length > 0) {
      const extent = (o: OpenMark) => {
        let n = 0;
        for (let j = i + 1; j < runs.length; j++) {
          const x = runs[j]!;
          if (x.t === 'break') continue;
          if (x.t === 'mention' || !has(marksOf(x.marks), o)) break;
          n++;
        }
        return n;
      };
      const ranked = toOpen
        .map((o) => ({ o, e: extent(o), k: ORDER.indexOf(o.key) }))
        .sort((a, b) => b.e - a.e || a.k - b.k);
      for (const { o } of ranked) {
        if (o.key === 'link') openBracket();
        out += opener(o, html);
        stack.push(o);
      }
    }
    out += r.marks.code ? codeSpan(r.text, table) : escapeText(r.text, table);
  }
  closeTo([]);
  return out;
}

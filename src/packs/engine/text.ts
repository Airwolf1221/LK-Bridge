/**
 * A pack's text rules (v3 F3a, ADR 0050), from Arkona's Source Formatting: page names, headings and body text never hold
 * an em dash (U+2014) or an en dash (U+2013) used as a separator (each becomes an ASCII hyphen-minus, listed); a page name
 * never holds a forbidden word (`CANON`) or a date; a body starts with its Purpose heading, never with the page's own
 * title or a metadata header; empty or placeholder sections are refused; sections a role should have are warned about;
 * an identity page that carries a large specialist block is warned about (the heuristic in ADR 0050).
 */
import type { LkBlock } from '../../markdown/index.js';
import type { PackRules, TypeRules } from '../types.js';

type Obj = Record<string, unknown>;

/** One dash replaced: where, and the text around it before and after. */
export interface Replacement {
  readonly page: string;
  readonly field: string;
  readonly before: string;
  readonly after: string;
}

const EM = '—';
const EN = '–';

/** Whether a text holds a dash the rules replace. */
export function hasForbiddenDash(s: string): boolean {
  return s.includes(EM) || /\s–|–\s/.test(s);
}

/**
 * Replaces, in one line of plain text, every em dash and every en dash used as a separator (with a space on at least one
 * side) by an ASCII hyphen-minus with a space either side; a dash at the start of the line becomes a hyphen with no
 * space before it. En dashes inside a range (`1990–1995`) are kept.
 */
export function replaceDashesInLine(line: string): string {
  let s = line.replace(/[ \t]*—[ \t]*/g, ' - ');
  s = s.replace(/[ \t]+–[ \t]*|[ \t]*–[ \t]+/g, ' - ');
  // A dash that was at the very start (or end) keeps no space on that side.
  s = s.replace(/^ - /, '- ').replace(/ - $/, ' -');
  return s;
}

const snippet = (text: string, at: number, width = 40) => {
  const start = Math.max(0, at - width);
  const end = Math.min(text.length, at + width);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
};

/** Replaces the dashes in a single-line value (a name, a label, a fact), recording each change. */
export function replaceDashes(value: string, page: string, field: string, out: Replacement[]): string {
  if (!hasForbiddenDash(value)) return value;
  const after = replaceDashesInLine(value);
  out.push({ page, field, before: value, after });
  return after;
}

/**
 * Replaces the dashes in a Markdown body, line by line (never inside a fenced code block), recording each line changed
 * as a heading or body replacement. A body line that would start with "- " after the change (a dialogue dash) is
 * escaped, so it never becomes a list item.
 */
export function replaceDashesInMarkdown(md: string, page: string, out: Replacement[]): string {
  const lines = md.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence !== null || !hasForbiddenDash(line)) continue;
    const heading = /^\s{0,3}#{1,6}\s/.test(line);
    const lead = /^(\s*)—/.exec(line);
    let next = replaceDashesInLine(line);
    if (lead && !heading) next = `${lead[1]}\\-${next.slice(lead[1]!.length + 1)}`;
    out.push({
      page,
      field: heading ? 'heading' : 'body',
      before: snippet(line, Math.max(line.indexOf(EM), line.indexOf(EN))),
      after: snippet(next, Math.max(0, next.indexOf(' - '))),
    });
    lines[i] = next;
  }
  return lines.join('\n');
}

/** Why a page name is refused: a forbidden word (`CANON`) or a date. Null when it is acceptable. */
export function nameProblem(name: string, rules: PackRules): { code: string; message: string } | null {
  for (const w of rules.names.forbiddenWords) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}([^\\p{L}\\p{N}]|$)`, 'iu');
    if (re.test(name))
      return {
        code: 'NAME_HAS_FORBIDDEN_WORD',
        message: `The page name “${name}” holds “${w}”; Arkona's Source Formatting never puts ${w} in a page name (the status is a fact and a tag, not a name).`,
      };
  }
  for (const p of rules.names.datePatterns) {
    const m = new RegExp(p, 'iu').exec(name);
    if (m)
      return {
        code: 'NAME_HAS_DATE',
        message: `The page name “${name}” holds a date (“${m[0]}”); Arkona's Source Formatting never puts dates in page names (dates live in the sidebar: Last Major Revision, Temporal Scope).`,
      };
  }
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const textKey = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-GB');

/** The plain text of a block's runs. */
export function blockText(b: LkBlock | Obj): string {
  const content = (b as Obj).content;
  if (!Array.isArray(content)) return '';
  return (content as Obj[])
    .map((r) => {
      if (typeof r.text === 'string') return r.text;
      const m = r.mention as Obj | undefined;
      if (m && typeof m.text === 'string') return m.text;
      return '';
    })
    .join('');
}

/** A section of a body: its heading block (null before the first heading), its level, and the blocks under it. */
export interface Section {
  readonly heading: LkBlock | null;
  readonly title: string;
  readonly level: number;
  readonly blocks: LkBlock[];
}

/** Splits top-level blocks into sections at every heading (any level). */
export function sectionsOf(blocks: readonly LkBlock[]): Section[] {
  const out: { heading: LkBlock | null; title: string; level: number; blocks: LkBlock[] }[] = [];
  let cur: { heading: LkBlock | null; title: string; level: number; blocks: LkBlock[] } = {
    heading: null,
    title: '',
    level: 0,
    blocks: [],
  };
  for (const b of blocks) {
    if ((b as Obj).kind === 'heading') {
      if (cur.heading !== null || cur.blocks.length > 0) out.push(cur);
      const level = typeof (b as Obj).level === 'number' ? ((b as Obj).level as number) : 1;
      cur = { heading: b, title: blockText(b).trim(), level, blocks: [] };
    } else cur.blocks.push(b);
  }
  if (cur.heading !== null || cur.blocks.length > 0) out.push(cur);
  return out;
}

/** The characters of text under a section (its blocks and theirs, all levels). */
function textSize(blocks: readonly unknown[]): number {
  let n = 0;
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    n += blockText(b as Obj).length;
    const kids = (b as Obj).children;
    if (Array.isArray(kids)) n += textSize(kids);
  }
  return n;
}

const PLACEHOLDER_TEXT = /^(?:\s*(?:tbd|tbc|todo|to do|placeholder|lorem ipsum.*|\.\.\.|…|\[.*\]|<.*>|\{.*\}|-+|\?+)\s*)$/i;
const METADATA_KEYS = [
  'status',
  'reference type',
  'continuity',
  'continuity type',
  'scope',
  'subject',
  'tags',
  'last major revision',
  'supersedes',
  'canonical display name',
  'race / species',
  'temporal scope',
  'life state',
  'naming culture',
];

export interface TextIssue {
  readonly code: string;
  readonly message: string;
  readonly page: string;
  readonly at?: string;
}

/**
 * The body rules for one page's converted blocks: Purpose first (else the page's own title, a metadata header, or another
 * first block, each refused with its own code); no empty or placeholder section (the index's collection section may be
 * empty: the template's collection block goes there); the role's sections warned about when missing; the overload
 * heuristic for identity roles.
 */
export function checkBody(input: {
  readonly page: string;
  readonly role: string;
  readonly blocks: readonly LkBlock[];
  readonly titles: readonly string[];
  readonly type: TypeRules;
  readonly warnMissing: readonly string[];
  readonly allowEmpty?: readonly string[];
}): { refusals: TextIssue[]; warnings: TextIssue[] } {
  const refusals: TextIssue[] = [];
  const warnings: TextIssue[] = [];
  const { page, type } = input;
  const blocks = input.blocks.filter((b) => !((b as Obj).kind === 'paragraph' && blockText(b).trim() === ''));
  const first = blocks[0];
  const firstHeading = type.text.firstHeading;
  if (!first) {
    refusals.push({ code: 'BODY_EMPTY', page, message: `${page}: the page has no text; give its ${firstHeading} first.` });
    return { refusals, warnings };
  }
  const firstText = blockText(first).trim();
  const isTitle = input.titles.some((t) => textKey(t) === textKey(firstText));
  if ((first as Obj).kind !== 'heading' || textKey(firstText) !== textKey(firstHeading)) {
    if (isTitle) {
      refusals.push({
        code: 'BODY_REPEATS_TITLE',
        page,
        message: `${page}: the body starts with the page's own title (“${firstText}”). Arkona's Source Formatting puts no title in the body (LegendKeeper shows the name): start with ## ${firstHeading}.`,
      });
    } else if (looksLikeMetadata(blocks)) {
      refusals.push({
        code: 'BODY_HAS_METADATA_HEADER',
        page,
        message: `${page}: the body starts with a metadata header (“${firstText.slice(0, 80)}”). Facts belong in the sidebar, which the bridge fills: start with ## ${firstHeading}.`,
      });
    } else {
      refusals.push({
        code: 'PURPOSE_NOT_FIRST',
        page,
        message: `${page}: the first heading must be “${firstHeading}” (Arkona's Source Formatting: Purpose first, then the subject's sections); it is “${firstText.slice(0, 80)}”.`,
      });
    }
  }
  const sections = sectionsOf(blocks);
  const allowEmpty = new Set((input.allowEmpty ?? []).map(textKey));
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    if (!s.heading) continue;
    // A heading followed only by deeper headings is a parent section, not an empty one.
    const next = sections[i + 1];
    const hasChildren = next !== undefined && next.heading !== null && next.level > s.level;
    const body = s.blocks.filter((b) => !((b as Obj).kind === 'paragraph' && blockText(b).trim() === ''));
    if (body.length === 0 && !hasChildren && !allowEmpty.has(textKey(s.title))) {
      refusals.push({
        code: 'EMPTY_SECTION',
        page,
        at: s.title,
        message: `${page}: the section “${s.title}” is empty. Arkona's Character Architecture makes no empty or placeholder sections: give it content or leave it out.`,
      });
      continue;
    }
    if (
      body.length > 0 &&
      body.every((b) => (b as Obj).kind === 'paragraph' && PLACEHOLDER_TEXT.test(blockText(b)))
    ) {
      refusals.push({
        code: 'PLACEHOLDER_SECTION',
        page,
        at: s.title,
        message: `${page}: the section “${s.title}” holds only a placeholder. Give it content or leave it out.`,
      });
    }
  }
  const headings = new Set(sections.filter((s) => s.heading).map((s) => textKey(s.title)));
  for (const h of input.warnMissing) {
    if (!headings.has(textKey(h)))
      warnings.push({
        code: 'SECTION_MISSING',
        page,
        at: h,
        message: `${page}: no “${h}” section (Arkona's Source Formatting puts it on this kind of page where it applies).`,
      });
  }
  if (type.text.overload.roles.includes(input.role)) {
    for (const s of sections) {
      if (!s.heading) continue;
      const t = textKey(s.title);
      const domain = Object.entries(type.text.overload.domains).find(([, words]) =>
        words.some((w) => t.includes(textKey(w))),
      );
      const size = textSize(s.blocks);
      if (domain && size >= type.text.overload.minChars) {
        warnings.push({
          code: 'CORE_OVERLOADED',
          page,
          at: s.title,
          message: `${page}: the section “${s.title}” is a large ${domain[0].toLowerCase()} block (${size} characters). Arkona's Character Architecture keeps the Core to identity and routing: consider a specialist page for it (role "specialist", title "${domain[0]}").`,
        });
      }
    }
  }
  return { refusals, warnings };
}

function looksLikeMetadata(blocks: readonly LkBlock[]): boolean {
  const first = blocks[0] as Obj | undefined;
  if (!first) return false;
  const lines = (b: Obj) =>
    blockText(b)
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  const isMeta = (l: string) => {
    const m = /^\**([^:*]{2,40})\**\s*:/.exec(l);
    return m !== null && METADATA_KEYS.includes(textKey(m[1]!));
  };
  if (first.kind === 'table') return true;
  if (first.kind === 'paragraph') return lines(first).some(isMeta);
  if (first.kind === 'bulletList' && Array.isArray(first.children)) {
    return (first.children as Obj[]).some((item) =>
      Array.isArray(item.children) ? (item.children as Obj[]).some((p) => lines(p).some(isMeta)) : false,
    );
  }
  return false;
}

/** Placeholders a gated value may not be (compared without case, brackets and surrounding space). */
export function isPlaceholder(value: string, placeholders: readonly string[]): boolean {
  const v = textKey(value).replace(/^[[({<]+|[\])}>]+$/g, '').trim();
  if (v === '') return true;
  if (/^\{.*\}$|^\[.*\]$|^<.*>$/.test(textKey(value))) return true;
  return placeholders.some((p) => textKey(p) === v);
}

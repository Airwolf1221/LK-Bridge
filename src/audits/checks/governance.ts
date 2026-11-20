/**
 * v3 F4a (ADR 0063): the governance drift check, the audits' `governance` category.
 *
 * It reads the governance documents, the tabs of the page the pack's governance sources sit on (Arkona's AI
 * REPOSITORY root; its pinned sections included), from the snapshots as every check reads its pages, so it is free and
 * runs with the nightly audit. It reports and never repairs (Repository Automation's Default Boundary): no finding offers
 * "Propose a fix"; governance edits are the owner's. Each finding carries the replacement the pack's equivalence map
 * suggests, to copy into a `write_page` edit by hand.
 *
 * - `governance_unknown_tool` (warning): a name in tool form that the bridge's tool registry does not have. Tool form is
 *   a snake_case identifier in code formatting (an inline code run, a code block) or right after "call", "invoke" or
 *   "use". The old bridge's call shapes (the pack's `legacyNames`: `write_lk`, `read_lk`, `job_action`) are flagged
 *   wherever they appear; an argument of an old call (`job_action`) is folded into the call it belongs to. A retired
 *   tool's name is flagged with the tool that took over. The bridge's own argument names, finding codes and statuses are
 *   not tools, and are not flagged.
 * - `governance_external_name` (info): a kebab-case skill name of three words or more (`format-baisheng-owners`) in tool
 *   form, or any name of the equivalence map anywhere. A name the owner allowed on the Audits page is never reported.
 * - `governance_missing_reference` (info): a capitalised name of two words or more, in a section whose heading holds one
 *   of the pack's `referenceSections` (Startup, Related Guidance, Source Boundaries, Dependencies), that resolves to
 *   nothing, however generously it is read (the owner's review): no page in any area (the Design References included)
 *   by its name, its subject, or its name with the lifecycle prefix, a leading "Arkona – " and a trailing generic word
 *   ("Reference", "Standard", "Workflow", "Index") removed; no tab, alias or tag; nor a template or a heading of the
 *   governance documents themselves. Elsewhere a capitalised phrase is too often not a name. A near miss ("LK
 *   Bootstrap" beside the root's tab "AI Bootstrap") names its closest match as the suggested replacement.
 */
import { cleanPrefixes } from '../../registry/names.js';
import type { GovernanceAuditRules, GovernanceEquivalent } from '../../packs/types.js';
import { headingKey } from '../../packs/sections.js';
import type { AuditContext, Check } from '../context.js';
import type { FindingDraft } from '../types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ============================================================================================ inputs

/** The names the bridge knows: its tools, its retired names, and the words of its tools that are not tools. */
export interface KnownNames {
  /** Every tool the bridge offers (the listed ones and those a setting or a pack lists). */
  readonly tools: ReadonlySet<string>;
  /** A retired tool's name → the tool that took over. */
  readonly retired: ReadonlyMap<string, string>;
  /** Names the bridge knows that are not tools: its tools' argument names, finding codes, job and proposal statuses. */
  readonly vocabulary: ReadonlySet<string>;
}

/** One governance document (a tab of the governance root), as the snapshots hold it. */
export interface GovernanceDocument {
  readonly pageId: string;
  readonly documentId: string;
  readonly name: string | null;
  /** Its blocks, or null when the snapshot store could not give them (nothing is reported for it). */
  readonly blocks: readonly unknown[] | null;
}

/** What the check is given (built by the audit service from the pack, the snapshots and the bridge's tools). */
export interface GovernanceAuditInput {
  readonly rules: GovernanceAuditRules;
  /** The pack the rules come from, for the messages (`Arkona`). */
  readonly packName: string;
  readonly documents: readonly GovernanceDocument[];
  readonly known: KnownNames;
  /** External names the owner allowed (compared without case). */
  readonly allowed: ReadonlySet<string>;
}

// ============================================================================================ the blocks' text

/** A block of a governance document as the check reads it. */
export interface GovernanceBlock {
  readonly blockId: string | null;
  readonly heading: boolean;
  /** The headings above it (and its own, for a heading), joined with " › ". */
  readonly section: string;
  /** Inside a section whose heading holds one of the pack's `referenceSections`. */
  readonly inReferenceSection: boolean;
  /** The block's text: its runs joined (a mention by its label, a line break as a space). */
  readonly text: string;
  /** Code formatting: each inline code span (adjacent code runs joined) and a code block's text. */
  readonly code: readonly string[];
  /** The plain text outside code and mentions, in pieces (a mention or a code span ends a piece). */
  readonly prose: readonly string[];
}

/** Whether a heading holds one of the words (each matched as whole words, as pinned headings are compared). */
export function headingHolds(title: string, words: readonly string[]): boolean {
  const h = ` ${headingKey(title)} `;
  return words.some((w) => {
    const k = headingKey(w);
    return k !== '' && h.includes(` ${k} `);
  });
}

/** The blocks of one document, top level and nested (lists, tables), each with its section. */
export function governanceBlocks(
  blocks: readonly unknown[],
  referenceSections: readonly string[],
): GovernanceBlock[] {
  const out: GovernanceBlock[] = [];
  const stack: { level: number; title: string; ref: boolean }[] = [];
  const runsOf = (runs: readonly unknown[]) => {
    let text = '';
    const code: string[] = [];
    const prose: string[] = [];
    let c = '';
    let p = '';
    const flushCode = () => {
      if (c.trim() !== '') code.push(c);
      c = '';
    };
    const flushProse = () => {
      if (p.trim() !== '') prose.push(p);
      p = '';
    };
    for (const r of runs) {
      if (!isObj(r)) continue;
      if (typeof r.text === 'string') {
        text += r.text;
        if (r.code === true) {
          flushProse();
          c += r.text;
        } else {
          flushCode();
          p += r.text;
        }
      } else if (isObj(r.mention)) {
        flushCode();
        flushProse();
        text += str(r.mention.text) || str(r.mention.name);
      } else if (r.break === true) {
        text += ' ';
        flushCode();
        p += ' ';
      }
    }
    flushCode();
    flushProse();
    return { text, code, prose };
  };
  const walk = (list: readonly unknown[]): void => {
    for (const raw of list) {
      if (!isObj(raw)) continue;
      const kind = str(raw.kind);
      const blockId = typeof raw.id === 'string' ? raw.id : null;
      if (kind === 'heading') {
        const level = typeof raw.level === 'number' ? raw.level : 1;
        const r = runsOf(Array.isArray(raw.content) ? raw.content : []);
        while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
        stack.push({ level, title: r.text.trim(), ref: headingHolds(r.text, referenceSections) });
        out.push({
          blockId,
          heading: true,
          section: stack.map((s) => s.title).join(' › '),
          inReferenceSection: false,
          ...r,
        });
        continue;
      }
      const section = stack.map((s) => s.title).join(' › ');
      const inReferenceSection = stack.some((s) => s.ref);
      if (kind === 'code' || (typeof raw.text === 'string' && !Array.isArray(raw.content))) {
        const t = str(raw.text);
        out.push({ blockId, heading: false, section, inReferenceSection, text: t, code: [t], prose: [] });
      } else if (Array.isArray(raw.content)) {
        out.push({ blockId, heading: false, section, inReferenceSection, ...runsOf(raw.content) });
      }
      if (Array.isArray(raw.children)) walk(raw.children);
    }
  };
  walk(blocks);
  return out;
}

// ============================================================================================ tool form

/** A snake_case identifier (two words or more). */
const SNAKE = /(?<![A-Za-z0-9_])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![A-Za-z0-9_])/g;
const SNAKE_WHOLE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
/** A kebab-case skill name: three words or more, each starting with a letter (`format-baisheng-owners`). */
const KEBAB = /(?<![A-Za-z0-9_-])[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*){2,}(?![A-Za-z0-9_-])/g;
const KEBAB_WHOLE = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*){2,}$/;
/** The words that put the next name in tool form ("call `write_lk`", "use the format-baisheng-owners skill"). */
const VERB =
  /(?<![A-Za-z])(?:call|calls|calling|called|invoke|invokes|invoking|invoked|use|uses|using)\s+(?:the\s+)?(\S+)/gi;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wholeWord = (name: string) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(name)}(?![A-Za-z0-9_-])`, 'i');

/** A short excerpt of the text around `at` (for the message). */
function snippetAt(text: string, at: number, len: number): string {
  const t = text.replace(/\s+/g, ' ');
  const from = Math.max(0, at - 60);
  const to = Math.min(t.length, at + len + 80);
  return `${from > 0 ? '…' : ''}${t.slice(from, to).trim()}${to < t.length ? '…' : ''}`;
}

/** The values a block gives the arguments `keys` (`job_action: "guide"` → `{ job_action: 'guide' }`). */
export function argsIn(text: string, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const m = new RegExp(
      `(?<![A-Za-z0-9_])${escapeRe(k)}["'”’]?\\s*[:=]\\s*["'“‘]?([A-Za-z0-9_.-]+)`,
      'i',
    ).exec(text);
    if (m) out[k] = m[1]!.toLowerCase();
  }
  return out;
}

/** The equivalent the map gives a name with these arguments: the most specific entry whose arguments all match. */
export function equivalentFor(
  rules: GovernanceAuditRules,
  name: string,
  args: Readonly<Record<string, string>>,
): GovernanceEquivalent | null {
  const entries = rules.equivalents
    .filter((e) => e.name.toLowerCase() === name.toLowerCase())
    .sort((a, b) => Object.keys(b.when ?? {}).length - Object.keys(a.when ?? {}).length);
  for (const e of entries) {
    const when = e.when ?? {};
    if (Object.entries(when).every(([k, v]) => args[k] !== undefined && args[k] === v.toLowerCase()))
      return e;
  }
  return null;
}

/** The argument names the map's entries for a name require (`write_lk` → `job_action`). */
const argKeysOf = (rules: GovernanceAuditRules, name: string): string[] => [
  ...new Set(
    rules.equivalents
      .filter((e) => e.name.toLowerCase() === name.toLowerCase())
      .flatMap((e) => Object.keys(e.when ?? {})),
  ),
];

/** One name found in a document, in tool form or as a name the pack lists. */
export interface NameHit {
  readonly name: string;
  readonly kind: 'tool' | 'external';
  /** How it was found: code formatting, after a verb, or a name the pack lists found anywhere. */
  readonly form: 'code' | 'call' | 'listed';
  readonly args: Readonly<Record<string, string>>;
  readonly section: string;
  readonly snippet: string;
}

/** The names in tool form (and the pack's listed names) of one document's blocks. */
export function nameHits(blocks: readonly GovernanceBlock[], rules: GovernanceAuditRules): NameHit[] {
  const out: NameHit[] = [];
  const legacy = new Set(rules.legacyNames.map((n) => n.toLowerCase()));
  // An argument of an old call (a `when` key that is itself a legacy name): folded into the call when both are there.
  const argumentNames = new Set(
    rules.equivalents.flatMap((e) => Object.keys(e.when ?? {})).filter((k) => legacy.has(k.toLowerCase())),
  );
  const listedSkills = rules.equivalents.filter((e) => e.name.includes('-')).map((e) => e.name);
  for (const b of blocks) {
    const seen = new Set<string>();
    const found: { name: string; form: NameHit['form']; at: number }[] = [];
    const add = (name: string, form: NameHit['form'], at: number) => {
      const k = name.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      found.push({ name, form, at });
    };
    for (const span of b.code) {
      for (const m of span.matchAll(SNAKE)) add(m[0], 'code', Math.max(0, b.text.indexOf(m[0])));
      for (const m of span.matchAll(KEBAB)) add(m[0], 'code', Math.max(0, b.text.indexOf(m[0])));
    }
    for (const m of b.text.matchAll(VERB)) {
      const token = m[1]!.replace(/^[`'"“‘«*(]+/, '').replace(/[`'"”’»*).,;:!?]+$/, '');
      if (SNAKE_WHOLE.test(token) || KEBAB_WHOLE.test(token)) add(token, 'call', m.index ?? 0);
    }
    for (const n of [...legacy, ...listedSkills]) {
      const m = wholeWord(n).exec(b.text);
      if (m) add(m[0], 'listed', m.index);
    }
    const hasCall = found.some((f) => legacy.has(f.name.toLowerCase()) && !argumentNames.has(f.name));
    for (const f of found) {
      if (hasCall && argumentNames.has(f.name)) continue; // part of the call it belongs to
      const kind = f.name.includes('-') ? 'external' : 'tool';
      const args = kind === 'tool' ? argsIn(b.text, argKeysOf(rules, f.name)) : {};
      out.push({
        name: f.name,
        kind,
        form: f.form,
        args,
        section: b.section,
        snippet: snippetAt(b.text, f.at, f.name.length),
      });
    }
  }
  return out;
}

// ============================================================================================ capitalised names

/** Words that may join the words of a name ("Approved Hierarchy and Standardised Navigation"). */
const CONNECTORS = new Set(['and', '&', 'of', 'the', 'for', 'to', 'in', 'on', 'with', 'by', 'a', 'an']);
/** Words that start a sentence or a list item before a name ("Read Fiction Writing"), never a name's first word. */
const STARTERS = new Set([
  'a',
  'after',
  'agents',
  'all',
  'also',
  'always',
  'an',
  'and',
  'any',
  'apply',
  'ask',
  'before',
  'begin',
  'but',
  'by',
  'call',
  'check',
  'cite',
  'confirm',
  'consult',
  'do',
  'each',
  'every',
  'finally',
  'first',
  'follow',
  'for',
  'from',
  'if',
  'include',
  'its',
  'keep',
  'load',
  'never',
  'next',
  'no',
  'note',
  'only',
  'open',
  'or',
  'per',
  'prefer',
  'read',
  'record',
  'review',
  'see',
  'start',
  'that',
  'the',
  'their',
  'then',
  'these',
  'this',
  'those',
  'treat',
  'under',
  'use',
  'verify',
  'via',
  'when',
  'where',
  'which',
  'while',
  'with',
  'within',
  'without',
]);

const isCapital = (w: string): boolean => /^\p{Lu}/u.test(w);

/** A name's comparable form: case, accents, punctuation, "&" for "and", a possessive "'s" ignored. */
export function nameNorm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/['’]s\b/giu, '')
    .toLocaleLowerCase('en-GB')
    .replace(/&/g, ' and ')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Runs of capitalised words (a connector may join two), each ending at clause punctuation or a lower-case word. */
export function capitalisedRuns(text: string): string[][] {
  const runs: string[][] = [];
  let cur: string[] = [];
  const flush = () => {
    while (cur.length > 0 && CONNECTORS.has(cur[cur.length - 1]!.toLowerCase())) cur.pop();
    if (cur.length > 0) runs.push(cur);
    cur = [];
  };
  for (const raw of text.split(/\s+/)) {
    if (raw === '') continue;
    if (/^[([{“"‘«]/.test(raw)) flush();
    const bare = raw.replace(/^[([{“"‘'«*_]+/, '').replace(/[)\]}”"’'».,;:!?*_]+$/, '');
    // A possessive ends a name: "Repository Automation’s Startup" is two names, not one.
    const possessive = /['’]s$/.test(bare);
    const word = bare.replace(/['’]s$/, '');
    const ends = /[)\]}”"».,;:!?]$/.test(raw) || /[’']$/.test(raw) || possessive;
    if (word === '' || /^\d/.test(word)) flush();
    else if (isCapital(word)) cur.push(word);
    else if (cur.length > 0 && CONNECTORS.has(word.toLowerCase())) cur.push(word);
    else flush();
    if (ends) flush();
  }
  flush();
  return runs;
}

/** The trailing generic words a name is also tried without when the pack says nothing (the owner's review). */
export const GENERIC_WORDS: readonly string[] = ['Reference', 'Standard', 'Workflow', 'Index'];

/**
 * The names the AI REPOSITORY knows: each whole (any length), each without a trailing generic word, and every run of two
 * words or more inside one.
 */
export interface Resolvable {
  readonly whole: ReadonlySet<string>;
  readonly parts: ReadonlySet<string>;
  /** The trailing generic words (compared form) a name in the text is also tried without. */
  readonly generic: ReadonlySet<string>;
}

/** A name without its trailing generic word (compared form), or null when it has none or is only that word. */
function withoutGeneric(k: string, generic: ReadonlySet<string>): string | null {
  const w = k.split(' ');
  return w.length > 1 && generic.has(w[w.length - 1]!) ? w.slice(0, -1).join(' ') : null;
}

export function resolvableNames(
  names: Iterable<string>,
  genericWords: Iterable<string> = GENERIC_WORDS,
): Resolvable {
  const generic = new Set([...genericWords].map(nameNorm).filter((g) => g !== ''));
  const whole = new Set<string>();
  const parts = new Set<string>();
  for (const n of names) {
    const k = nameNorm(n);
    if (k === '') continue;
    whole.add(k);
    const short = withoutGeneric(k, generic);
    if (short) whole.add(short);
    const words = k.split(' ').slice(0, 16);
    for (let i = 0; i < words.length; i++)
      for (let j = i + 2; j <= words.length; j++) parts.add(words.slice(i, j).join(' '));
  }
  return { whole, parts, generic };
}

/** Whether a name (compared form) resolves: as it is, or without its trailing generic word. */
export function knows(known: Resolvable, k: string): boolean {
  if (k === '') return false;
  if (known.whole.has(k) || known.parts.has(k)) return true;
  const short = withoutGeneric(k, known.generic);
  return short !== null && (known.whole.has(short) || known.parts.has(short));
}

/** The words that separate the names of a list ("Project Navigation and Fiction Writing"). */
const LIST_WORDS = new Set(['and', '&', 'or']);

/**
 * The capitalised names of a run that resolve to nothing. Every known name of two words or more is taken out of the run
 * first (the longest from the left: "Approved Hierarchy and Standardised Navigation" whole); what is left is split at
 * the words of a list, a starter ("Read", "The") is dropped from each piece, and a piece of two capitalised words or
 * more is a name that resolves to nothing. A single word never stands for a name here, so a page called "Fiction" never
 * hides a missing "Fiction Writing".
 */
export function unresolvedIn(run: readonly string[], known: Resolvable): string[] {
  const out: string[] = [];
  const piece = (words: readonly string[]) => {
    let s = [...words];
    while (s.length > 0 && (CONNECTORS.has(s[0]!.toLowerCase()) || STARTERS.has(s[0]!.toLowerCase())))
      s = s.slice(1);
    while (s.length > 0 && CONNECTORS.has(s[s.length - 1]!.toLowerCase())) s = s.slice(0, -1);
    if (s.filter(isCapital).length < 2) return;
    if (knows(known, nameNorm(s.join(' ')))) return;
    out.push(s.join(' '));
  };
  const settle = (words: readonly string[]) => {
    let cur: string[] = [];
    for (const w of words) {
      if (LIST_WORDS.has(w.toLowerCase())) {
        piece(cur);
        cur = [];
      } else cur.push(w);
    }
    piece(cur);
  };
  let left: string[] = [];
  let i = 0;
  while (i < run.length) {
    let to = -1;
    if (isCapital(run[i]!))
      for (let j = run.length; j >= i + 2; j--) {
        if (!isCapital(run[j - 1]!)) continue;
        if (knows(known, nameNorm(run.slice(i, j).join(' ')))) {
          to = j;
          break;
        }
      }
    if (to > 0) {
      settle(left);
      left = [];
      i = to;
    } else {
      left.push(run[i]!);
      i++;
    }
  }
  settle(left);
  return out;
}

// ============================================================================================ near names

/** Levenshtein distance, giving up (max + 1) once it must exceed `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** A bridge tool a name is a slip of (two edits at most; one for a short name), or null. */
export function nearTool(name: string, tools: ReadonlySet<string>): string | null {
  const max = name.length >= 10 ? 2 : 1;
  let best: { tool: string; d: number } | null = null;
  for (const t of tools) {
    if (t.startsWith('lk_op_')) continue;
    const d = editDistance(name, t, max);
    if (d <= max && (!best || d < best.d || (d === best.d && t < best.tool))) best = { tool: t, d };
  }
  return best?.tool ?? null;
}

/** What a known name is: a tab, a page's name (or subject), an alias, a tag, a template or a governance heading. */
export type KnownKind = 'tab' | 'page' | 'alias' | 'tag' | 'template' | 'heading';

/** A name the AI REPOSITORY knows, as written, and what holds it (a near miss's suggestion). */
export interface KnownName {
  readonly name: string;
  readonly kind: KnownKind;
  /** The page it belongs to: the tab's page, the page itself, the page an alias or tag is on. */
  readonly page?: { readonly id: string; readonly name: string };
}

/** Among equally near names, a tab first (governance points at tabs most), then a page, an alias, a tag… */
const KIND_RANK: Readonly<Record<KnownKind, number>> = {
  tab: 0,
  page: 1,
  alias: 2,
  tag: 3,
  template: 4,
  heading: 5,
};

/**
 * The known name closest to one that resolves to nothing (a near miss), or null: a slip of two edits at most (one for a
 * name under eight letters), the same words in another order, or a longer name holding every word of it. Literal: never
 * a guess at what was meant beyond that. `candidates` holds names of two words or more by their compared form.
 */
export function closestName(name: string, candidates: ReadonlyMap<string, KnownName>): KnownName | null {
  const k = nameNorm(name);
  const words = k.split(' ');
  const max = k.length >= 8 ? 2 : 1;
  let best: { c: KnownName; score: number } | null = null;
  for (const [key, c] of candidates) {
    if (key === k) continue;
    const d = editDistance(k, key, max);
    let score: number | null = d <= max ? d : null;
    if (score === null) {
      const kw = key.split(' ');
      if (kw.length >= words.length && words.every((w) => kw.includes(w)))
        score = max + 1 + (kw.length - words.length);
    }
    if (score === null) continue;
    const better =
      !best ||
      score < best.score ||
      (score === best.score &&
        (KIND_RANK[c.kind] < KIND_RANK[best.c.kind] ||
          (KIND_RANK[c.kind] === KIND_RANK[best.c.kind] && c.name.localeCompare(best.c.name, 'en') < 0)));
    if (better) best = { c, score };
  }
  return best?.c ?? null;
}

/** A near miss's closest name, as the message says it ("the tab “AI Bootstrap” of AI REPOSITORY"). */
function knownWords(c: KnownName): string {
  const on = c.page ? ` of ${c.page.name}` : '';
  switch (c.kind) {
    case 'tab':
      return `the tab “${c.name}”${on}`;
    case 'page':
      return c.page && nameNorm(c.page.name) !== nameNorm(c.name)
        ? `“${c.name}”, the page ${c.page.name}`
        : `the page “${c.name}”`;
    case 'alias':
      return `“${c.name}”, an alias${on}`;
    case 'tag':
      return `the tag “${c.name}”${c.page ? ` (on ${c.page.name})` : ''}`;
    case 'template':
      return `the template “${c.name}”`;
    case 'heading':
      return `the governance heading “${c.name}”`;
  }
}

/** A leading project prefix ("Arkona - ") as a pattern: any dash, any spacing, no case. */
function leadingPattern(prefix: string): RegExp | null {
  const words = prefix.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return new RegExp(
    `^${words.map((w) => (/^[-–—]$/.test(w) ? '[-–—]' : escapeRe(w))).join('\\s*')}\\s*`,
    'iu',
  );
}

// ============================================================================================ the check

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** A section path's own heading (the innermost), for a message; the evidence keeps the whole path. */
const own = (section: string) => section.split(' › ').at(-1) ?? section;
const quoteList = (l: readonly string[]) => [...new Set(l.map(own))].map((s) => `“${s}”`).join(', ');

/** The bridge's equivalent as the message words it. */
function equivalentWords(e: GovernanceEquivalent | null, retiredTo: string | null): string {
  if (retiredTo) return ` It was renamed to ${retiredTo}: use that instead.`;
  if (!e) return ' The pack’s equivalence map has no equivalent for it.';
  const note = e.note ? ` (${e.partial ? 'partial: ' : ''}${e.note})` : e.partial ? ' (partial)' : '';
  return ` The bridge’s ${e.partial ? 'nearest equivalent' : 'equivalent'}: ${e.use}${note}.`;
}

export const governanceCheck: Check = (ctx: AuditContext): FindingDraft[] => {
  const g = ctx.governance;
  if (!g) return [];
  const out: FindingDraft[] = [];
  const known = g.known;
  const allowed = new Set([...g.allowed].map((a) => a.toLowerCase()));
  const legacy = new Set(g.rules.legacyNames.map((n) => n.toLowerCase()));

  // Everything a reference may name, generously (the owner's review): every page in every area (the Design References
  // and the Legacy Canon Archive included) by its name, its subject, its name with the lifecycle prefix, a leading
  // project prefix ("Arkona – ") and a trailing generic word removed, its aliases, tags and Canonical Display Name;
  // every tab; the templates; and the governance documents' own headings.
  const generic = g.rules.resolution?.generic ?? GENERIC_WORDS;
  const genericTail = new RegExp(`\\s+(?:${generic.map(escapeRe).join('|')})$`, 'iu');
  const leading = (g.rules.resolution?.leading ?? [])
    .map(leadingPattern)
    .filter((x): x is RegExp => x !== null);
  const entries: KnownName[] = [];
  const add = (name: string | null | undefined, kind: KnownKind, page?: KnownName['page']) => {
    const n = (name ?? '').trim();
    if (n !== '') entries.push({ name: n, kind, ...(page ? { page } : {}) });
  };
  for (const p of ctx.model.pages.values()) {
    const ref = { id: p.id, name: p.rawName };
    const clean = cleanPrefixes(p.rawName).name;
    const [subject, ...rest] = clean.split(/\s+[-–—]\s+/);
    add(p.displayName, 'page', ref);
    add(clean, 'page', ref);
    add(subject, 'page', ref);
    // "<Subject> - <descriptor>" is often called by its subject and the descriptor's last word ("the Salahad
    // Reference" for "Salahad - Continent Reference").
    const last = rest.join(' ').trim().split(/\s+/).at(-1);
    if (last) add(`${subject} ${last}`, 'page', ref);
    // A leading project prefix removed, then a trailing generic word: "Arkona – Fiction Writing Reference" is
    // "Fiction Writing Reference" and "Fiction Writing".
    for (const re of leading) {
      const short = clean.replace(re, '');
      if (short === clean || short === '') continue;
      add(short, 'page', ref);
      add(short.replace(genericTail, ''), 'page', ref);
    }
    add(subject?.replace(genericTail, ''), 'page', ref);
    add(p.facts.get('canonical display name')?.text, 'page', ref);
    for (const a of p.aliases) add(a, 'alias', ref);
    for (const t of p.tags) add(t, 'tag', ref);
    for (const d of p.documents) add(d.name, 'tab', ref);
  }
  for (const t of ctx.templateNames) add(cleanPrefixes(t).name.replace(/\s+template$/i, ''), 'template');
  const docBlocks = g.documents.map((d) => ({
    doc: d,
    blocks: d.blocks ? governanceBlocks(d.blocks, g.rules.referenceSections) : null,
  }));
  for (const d of docBlocks) for (const b of d.blocks ?? []) if (b.heading) add(b.text, 'heading');
  const resolvable = resolvableNames(
    entries.map((e) => e.name),
    generic,
  );
  // The near-miss candidates: every known name of two words or more, as written, and without its generic word.
  const candidates = new Map<string, KnownName>();
  for (const e of entries)
    for (const name of [e.name, e.name.replace(genericTail, '')]) {
      const k = nameNorm(name);
      if (!k.includes(' ')) continue;
      const had = candidates.get(k);
      if (!had || KIND_RANK[e.kind] < KIND_RANK[had.kind]) candidates.set(k, { ...e, name });
    }

  for (const { doc, blocks } of docBlocks) {
    if (!blocks) continue;
    const tab = { id: doc.documentId, name: doc.name };
    const tabName = doc.name ?? 'A governance document';

    // ---------------------------------------------------------------------------------- tools and skills
    const groups = new Map<
      string,
      {
        hit: NameHit;
        code: 'governance_unknown_tool' | 'governance_external_name';
        equivalent: GovernanceEquivalent | null;
        retiredTo: string | null;
        sections: Set<string>;
        forms: Set<string>;
        count: number;
      }
    >();
    for (const h of nameHits(blocks, g.rules)) {
      const lower = h.name.toLowerCase();
      let code: 'governance_unknown_tool' | 'governance_external_name';
      let retiredTo: string | null = null;
      if (h.kind === 'external') {
        if (allowed.has(lower)) continue;
        code = 'governance_external_name';
      } else {
        const isLegacy = legacy.has(lower);
        if (!isLegacy && known.tools.has(h.name)) continue;
        retiredTo = known.retired.get(h.name) ?? null;
        if (!isLegacy && !retiredTo && known.vocabulary.has(h.name)) continue;
        code = 'governance_unknown_tool';
      }
      const equivalent = retiredTo ? null : equivalentFor(g.rules, h.name, h.args);
      const key = `${code}|${lower}|${equivalent ? equivalent.use : ''}`;
      const grp = groups.get(key) ?? {
        hit: h,
        code,
        equivalent,
        retiredTo,
        sections: new Set<string>(),
        forms: new Set<string>(),
        count: 0,
      };
      grp.sections.add(h.section || '(before the first heading)');
      grp.forms.add(h.form);
      grp.count++;
      groups.set(key, grp);
    }
    for (const grp of groups.values()) {
      const { hit, code, equivalent, retiredTo } = grp;
      const sections = [...grp.sections].sort();
      const where = `${quoteList(sections.slice(0, 3))}${sections.length > 3 ? ` and ${sections.length - 3} more` : ''}`;
      const argWords = Object.entries(equivalent?.when ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      const suggested = retiredTo ?? equivalent?.use ?? null;
      const evidence = {
        tab,
        name: hit.name,
        ...(argWords ? { arguments: equivalent?.when } : {}),
        sections,
        ...(equivalent
          ? {
              equivalent: {
                use: equivalent.use,
                ...(equivalent.note ? { note: equivalent.note } : {}),
                ...(equivalent.partial ? { partial: true } : {}),
              },
            }
          : {}),
        ...(retiredTo ? { retired: { renamedTo: retiredTo } } : {}),
        ...(suggested ? { suggestedReplacement: suggested } : {}),
      };
      const count = grp.count > 1 ? ` (${plural(grp.count, 'place')})` : '';
      // With no equivalent: a bridge tool the name is a slip of, as the suggestion (in the message only, so a new tool
      // never re-opens an acknowledged finding).
      const near = !suggested && code === 'governance_unknown_tool' ? nearTool(hit.name, known.tools) : null;
      const suggestion = suggested
        ? ''
        : code === 'governance_unknown_tool'
          ? near
            ? ` Suggested replacement: ${near}, the bridge tool nearest in spelling (check it does the job).`
            : ' No bridge tool is near it in spelling: replace it with the tool that does the job (get_bridge_guide lists them), or remove it.'
          : ' Otherwise remove it, or name the bridge tool that does the job.';
      const message =
        code === 'governance_unknown_tool'
          ? `${tabName} names \`${hit.name}\`${argWords ? ` (${argWords})` : ''} in ${where}${count}: ${
              legacy.has(hit.name.toLowerCase())
                ? 'one of the old bridge’s call shapes, which this bridge does not have'
                : retiredTo
                  ? 'a retired tool name'
                  : 'not a tool of the bridge'
            }.${equivalentWords(equivalent, retiredTo)}${suggestion} For example: ${hit.snippet} Governance is yours to edit: change the page by hand (write_page) if it should change; the audit changes nothing.`
          : `${tabName} names the skill \`${hit.name}\` in ${where}${count}.${equivalentWords(equivalent, null)} If it is a real skill you use elsewhere, allow the name on the Audits page and it is not reported again.${suggestion} For example: ${hit.snippet}`;
      out.push({
        code,
        pageId: doc.pageId,
        documentId: doc.documentId,
        key: `${hit.name.toLowerCase()}${equivalent ? `→${equivalent.use}` : ''}`,
        message,
        evidence,
      });
    }

    // ---------------------------------------------------------------------------------- missing references
    const missing = new Map<string, { name: string; section: string; snippet: string; count: number }>();
    for (const b of blocks) {
      if (b.heading || !b.inReferenceSection) continue;
      for (const piece of b.prose)
        for (const run of capitalisedRuns(piece))
          for (const name of unresolvedIn(run, resolvable)) {
            const key = `${nameNorm(b.section)}|${nameNorm(name)}`;
            const m = missing.get(key);
            if (m) m.count++;
            else
              missing.set(key, {
                name,
                section: b.section,
                snippet: snippetAt(b.text, Math.max(0, b.text.indexOf(name)), name.length),
                count: 1,
              });
          }
    }
    for (const [key, m] of missing) {
      // A near miss names its closest match, in the evidence too (so an acknowledgement covers that match); a name with
      // nothing near says what to do instead.
      const closest = closestName(m.name, candidates);
      const times = m.count > 1 ? ` (${plural(m.count, 'time')})` : '';
      const message = closest
        ? `${tabName}’s section “${own(m.section)}” names “${m.name}”${times}, which resolves to no page, tab, alias or tag in the AI REPOSITORY: a near miss for ${knownWords(closest)}. ${m.snippet} Suggested replacement: “${closest.name}”. Correct it by hand if that is meant, or acknowledge this finding if it is right as it is.`
        : `${tabName}’s section “${own(m.section)}” names “${m.name}”${times}, which resolves to no page, tab, alias or tag in the AI REPOSITORY, and nothing is near it: ${m.snippet} Correct it by hand, remove it if what it points to is gone, or acknowledge this finding if it is right as it is.`;
      out.push({
        code: 'governance_missing_reference',
        pageId: doc.pageId,
        documentId: doc.documentId,
        key,
        message,
        evidence: {
          tab,
          section: m.section,
          name: m.name,
          ...(closest
            ? {
                nearMiss: {
                  closest: closest.name,
                  kind: closest.kind,
                  ...(closest.page ? { page: closest.page } : {}),
                },
                suggestedReplacement: closest.name,
              }
            : {}),
        },
      });
    }
  }
  return out;
};

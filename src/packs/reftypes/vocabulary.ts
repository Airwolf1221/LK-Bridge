/**
 * v3 F6a (ADR 0076; design T1): the Reference Type vocabulary as data, and as the governance section the owner publishes
 * (Source Formatting's "Reference Type Vocabulary", under "Sidebar Metadata").
 *
 * The section is written by the bridge in one fixed form and read back in that form only (F5a's rule: the bridge reads
 * nothing it cannot read exactly):
 *
 * - its heading, "Reference Type Vocabulary", one level below "Sidebar Metadata";
 * - the rule, one paragraph ("A Reference Type names the page’s role …");
 * - a paragraph introducing the lists (no colon);
 * - one paragraph per primary category: `Polity: Polity Reference (Polity); Polity Constitution Reference
 *   (Constitution).`, each type with its role word in brackets, and any variants the vocabulary itself accepts after
 *   `, also:` inside the brackets (`Language & Naming Reference (Language & Naming, also: Culture & Naming Reference)`);
 * - a paragraph introducing the specialist types, then one paragraph per approved specialist type: `Specialist type:
 *   Arkonan Calendar Reference (Chronology), any page in this category.` or `Specialist type: X (Polity), for these
 *   pages: <mention>, <mention>.` (the pages as mentions, read back by their ids).
 *
 * A paragraph shaped `Label: …` whose items do not all read is unreadable, and so is the whole section (fail closed).
 */
import { headingKey, sectionBlocksOf } from '../sections.js';
import type { ReferenceTypeRules } from '../types.js';

type Obj = Record<string, unknown>;

/** The vocabulary itself (the rules without where it lives and how values are normalised). */
export interface VocabularyLists {
  readonly rule: string;
  readonly categories: ReferenceTypeRules['categories'];
  readonly specialist: ReferenceTypeRules['specialist'];
}

export const INTRO_TYPES =
  'Each paragraph below lists one primary category’s canonical Reference Types, each with its role word in brackets.';
export const INTRO_SPECIALIST =
  'Approved specialist types (the Specialist exemption) keep their type and their names, only on the pages named.';
const SPECIALIST_LABEL = 'Specialist type';

/** The plain text of a block's runs (mention labels included). */
export function blockText(b: Obj): string {
  const content = b.content;
  if (!Array.isArray(content)) return '';
  return (content as Obj[])
    .map((r) =>
      typeof r.text === 'string'
        ? r.text
        : r.mention && typeof (r.mention as Obj).text === 'string'
          ? ((r.mention as Obj).text as string)
          : r.mention && typeof (r.mention as Obj).name === 'string'
            ? ((r.mention as Obj).name as string)
            : '',
    )
    .join('');
}

/** A comparable form of a type's name (case, spacing, `&`/`and` and punctuation ignored). */
export const typeKey = (s: string): string => headingKey(s);

// ============================================================================================ rendering

const para = (content: Obj[]): Obj => ({ kind: 'paragraph', content });
const t = (text: string, bold = false): Obj => (bold ? { text, bold: true } : { text });

/** One category's line, as text. */
export function categoryLine(c: VocabularyLists['categories'][number]): string {
  const items = c.types.map((x) => {
    const also = (x.aliases ?? []).length > 0 ? `, also: ${(x.aliases ?? []).join(', ')}` : '';
    return `${x.name} (${x.role}${also})`;
  });
  return `${c.category}: ${items.join('; ')}.`;
}

/** One specialist type's line, as text (the pages by name). */
export function specialistLine(s: VocabularyLists['specialist'][number]): string {
  return s.pages === null
    ? `${SPECIALIST_LABEL}: ${s.type} (${s.category}), any page in this category.`
    : `${SPECIALIST_LABEL}: ${s.type} (${s.category}), for these pages: ${s.pages.map((p) => p.name).join(', ')}.`;
}

/** The section's text, line by line, exactly as it will read (the publish preview). */
export function sectionLines(v: VocabularyLists, heading: string): string[] {
  const cats = v.categories.filter((c) => c.types.length > 0);
  return [
    heading,
    v.rule,
    INTRO_TYPES,
    ...cats.map(categoryLine),
    ...(v.specialist.length > 0 ? [INTRO_SPECIALIST, ...v.specialist.map(specialistLine)] : []),
  ];
}

/** The section as LegendKeeper blocks (new blocks: no ids), its heading at `level`. */
export function renderSection(v: VocabularyLists, heading: string, level: number): Obj[] {
  const out: Obj[] = [
    { kind: 'heading', level, content: [t(heading)] },
    para([t(v.rule)]),
    para([t(INTRO_TYPES)]),
  ];
  for (const c of v.categories) {
    if (c.types.length === 0) continue;
    out.push(para([t(`${c.category}:`, true), t(` ${categoryLine(c).slice(c.category.length + 2)}`)]));
  }
  if (v.specialist.length > 0) {
    out.push(para([t(INTRO_SPECIALIST)]));
    for (const s of v.specialist) {
      if (s.pages === null) {
        out.push(para([t(specialistLine(s))]));
        continue;
      }
      const runs: Obj[] = [t(`${SPECIALIST_LABEL}: ${s.type} (${s.category}), for these pages: `)];
      s.pages.forEach((p, i) => {
        if (i > 0) runs.push(t(', '));
        runs.push({ mention: { resourceId: p.id, text: p.name } });
      });
      runs.push(t('.'));
      out.push(para(runs));
    }
  }
  return out;
}

// ============================================================================================ parsing

export type SectionParse =
  | { readonly ok: true; readonly vocabulary: VocabularyLists }
  | { readonly ok: false; readonly reason: string };

const ITEM = /^(.+?)\s*\(([^()]+)\)$/;

function parseItems(category: string, list: string): VocabularyLists['categories'][number] | string {
  const body = list.trim().replace(/\.\s*$/, '');
  if (body === '') return `the line for ${category} lists no type`;
  const types: { name: string; role: string; aliases?: string[] }[] = [];
  for (const raw of body.split(';')) {
    const item = raw.trim();
    const m = ITEM.exec(item);
    if (!m) return `“${item}” (${category}) is not written as “Type (role word)”`;
    const inner = m[2]!;
    const at = inner.search(/,\s*also:/i);
    const role = (at >= 0 ? inner.slice(0, at) : inner).trim();
    const aliases =
      at >= 0
        ? inner
            .slice(at)
            .replace(/^,\s*also:\s*/i, '')
            .split(',')
            .map((x) => x.trim())
            .filter((x) => x !== '')
        : [];
    if (role === '') return `“${item}” (${category}) has no role word`;
    types.push({ name: m[1]!.trim(), role, ...(aliases.length > 0 ? { aliases } : {}) });
  }
  return { category: category.trim(), types };
}

/** The mention runs of a block, in order. */
function mentionsOf(b: Obj): { id: string; name: string }[] {
  const content = Array.isArray(b.content) ? (b.content as Obj[]) : [];
  return content
    .filter((r) => r.mention && typeof (r.mention as Obj).resourceId === 'string')
    .map((r) => {
      const m = r.mention as Obj;
      const name = typeof m.text === 'string' ? m.text : typeof m.name === 'string' ? m.name : '';
      return { id: m.resourceId as string, name };
    });
}

function parseSpecialist(b: Obj, text: string): VocabularyLists['specialist'][number] | string {
  const m =
    /^\s*Specialist type:\s*(.+?)\s*\(([^()]+)\),\s*(any page in this category|for these pages:\s*(.*?))\s*\.?\s*$/i.exec(
      text,
    );
  if (!m) return `“${text}” is not written as “Specialist type: Type (Category), any page in this category.”`;
  const type = m[1]!.trim();
  const category = m[2]!.trim();
  if (/^any page/i.test(m[3]!)) return { type, category, pages: null };
  const mentions = mentionsOf(b);
  if (mentions.length === 0)
    return `the specialist type “${type}” names its pages without links: link each page (a mention)`;
  return { type, category, pages: mentions.map((x) => ({ id: x.id, name: x.name || x.id })) };
}

/**
 * The vocabulary the section states (`section`: its blocks, heading first, as `sectionBlocksOf` gives them). Fails, never
 * guesses: a missing rule, a list line that does not read, no category at all.
 */
export function parseSection(section: readonly Obj[] | null): SectionParse {
  if (!section) return { ok: false, reason: 'the section is not in the document exactly once' };
  const categories: VocabularyLists['categories'][number][] = [];
  const specialist: VocabularyLists['specialist'][number][] = [];
  let rule: string | null = null;
  for (const b of section.slice(1)) {
    if (b.kind === 'heading') continue;
    const text = blockText(b).trim();
    if (text === '') continue;
    if (/^\s*Specialist type\s*:/i.test(text)) {
      const s = parseSpecialist(b, text);
      if (typeof s === 'string') return { ok: false, reason: s };
      specialist.push(s);
      continue;
    }
    const m = /^([^:]{1,100}):\s*(.*)$/s.exec(text);
    if (m) {
      const c = parseItems(m[1]!, m[2]!);
      if (typeof c === 'string') return { ok: false, reason: c };
      const had = categories.find((x) => typeKey(x.category) === typeKey(c.category));
      if (had) return { ok: false, reason: `the category ${c.category} is listed twice` };
      categories.push(c);
      continue;
    }
    if (text === INTRO_TYPES || text === INTRO_SPECIALIST) continue;
    if (rule === null) rule = text;
  }
  if (rule === null) return { ok: false, reason: 'the section states no rule (its first paragraph)' };
  if (categories.length === 0) return { ok: false, reason: 'the section lists no category' };
  const seen = new Map<string, string>();
  for (const c of categories)
    for (const x of c.types) {
      const k = typeKey(x.name);
      const had = seen.get(k);
      if (had !== undefined && had !== typeKey(c.category))
        return { ok: false, reason: `${x.name} is listed in two categories` };
      seen.set(k, typeKey(c.category));
    }
  return { ok: true, vocabulary: { rule, categories, specialist } };
}

/** Whether two vocabularies say the same (the order of categories, types and specialists ignored). */
export function sameVocabulary(a: VocabularyLists, b: VocabularyLists): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: VocabularyLists): string {
  const cats = v.categories
    .filter((c) => c.types.length > 0)
    .map((c) => ({
      c: c.category,
      t: c.types.map((x) => `${x.name}|${x.role}|${[...(x.aliases ?? [])].sort().join(',')}`).sort(),
    }))
    .sort((x, y) => (x.c < y.c ? -1 : x.c > y.c ? 1 : 0));
  const spec = v.specialist
    .map(
      (s) =>
        `${s.type}|${s.category}|${
          s.pages === null
            ? '*'
            : s.pages
                .map((p) => p.id)
                .sort()
                .join(',')
        }`,
    )
    .sort();
  return JSON.stringify({ r: v.rule, cats, spec });
}

// ============================================================================================ writing into a document

export type SpliceResult =
  | {
      readonly ok: true;
      /** The whole document as it will be (every block outside the section untouched, ids kept). */
      readonly blocks: Obj[];
      /** True when the section was there already (its contents replaced in place). */
      readonly replaced: boolean;
      readonly level: number;
    }
  | { readonly ok: false; readonly code: string; readonly reason: string };

const levelOf = (b: Obj): number => (typeof b.level === 'number' ? b.level : 1);

/**
 * The document with the vocabulary section written: replaced in place when the heading is there (exactly once), else
 * inserted at the end of the `under` section, one heading level below it (at most 3). Refused when `under` is missing or
 * ambiguous, or the section is there more than once.
 */
export function spliceSection(
  blocks: readonly unknown[],
  under: string,
  heading: string,
  v: VocabularyLists,
): SpliceResult {
  const list = blocks.filter((b): b is Obj => typeof b === 'object' && b !== null);
  const headingAt = (name: string) =>
    list
      .map((b, i) => ({ b, i }))
      .filter((x) => x.b.kind === 'heading' && headingKey(blockText(x.b)) === headingKey(name))
      .map((x) => x.i);
  const endOf = (at: number) => {
    const level = levelOf(list[at]!);
    let end = at + 1;
    while (end < list.length && !(list[end]!.kind === 'heading' && levelOf(list[end]!) <= level)) end++;
    return end;
  };
  const here = headingAt(heading);
  if (here.length > 1)
    return {
      ok: false,
      code: 'SECTION_AMBIGUOUS',
      reason: `the page has ${here.length} headings “${heading}”: leave one, then publish again`,
    };
  if (here.length === 1) {
    const at = here[0]!;
    const level = levelOf(list[at]!);
    const end = endOf(at);
    const next = [...list.slice(0, at), ...renderSection(v, heading, level), ...list.slice(end)];
    return { ok: true, blocks: next, replaced: true, level };
  }
  const parent = headingAt(under);
  if (parent.length !== 1)
    return {
      ok: false,
      code: 'SECTION_PARENT_MISSING',
      reason:
        parent.length === 0
          ? `the page has no heading “${under}” to write the section under`
          : `the page has ${parent.length} headings “${under}”: which one the section goes under cannot be told`,
    };
  const at = parent[0]!;
  const level = Math.min(levelOf(list[at]!) + 1, 3);
  const end = endOf(at);
  const next = [...list.slice(0, end), ...renderSection(v, heading, level), ...list.slice(end)];
  return { ok: true, blocks: next, replaced: false, level };
}

/** The section's blocks in a document (null: not there exactly once). */
export const vocabularySection = (blocks: unknown, heading: string): Obj[] | null =>
  sectionBlocksOf(blocks, heading);

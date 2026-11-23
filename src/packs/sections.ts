/**
 * v3 F3b (ADR 0052): the pinned sections of a governance document. A pack's rules depend on named sections of its
 * governance pages (Source Formatting's "Approved Hierarchy", the Tagging Standard's "Exact Tag Grammar"); the owner's
 * approval records each one's digest, and a drift report says which pinned section changed. A section is its heading
 * and every top-level block after it up to the next heading of its level or higher.
 *
 * A pinned heading matches a document heading only as a whole (never a prefix, never a nearest guess): case, spacing,
 * punctuation, a leading number such as "3." or "B)" and "&" for "and" are ignored, so a renumbered or recapitalised
 * heading is still found, but "Approved Hierarchy" does not find "Approved Hierarchy and Standardised Navigation". A
 * pinned section that cannot be found is reported by name, with the document's outline (`outlineOf`), so the owner can
 * re-map the pin on the Packs page (ADR 0052, amendment of 16 November 2026).
 */
import { createHash } from 'node:crypto';
import { stableJson } from '../jobs/sidebar-state.js';

type Obj = Record<string, unknown>;

/** The plain text of a block's runs. */
function runsText(b: Obj): string {
  const content = b.content;
  if (!Array.isArray(content)) return '';
  return (content as Obj[])
    .map((r) =>
      typeof r.text === 'string'
        ? r.text
        : r.mention && typeof (r.mention as Obj).text === 'string'
          ? ((r.mention as Obj).text as string)
          : '',
    )
    .join('');
}

/** A heading's comparable form (see the module comment). */
export function headingKey(s: string): string {
  return s
    .normalize('NFKC')
    .toLocaleLowerCase('en-GB')
    .replace(/&/g, ' and ')
    .replace(/^\s*(?:\d+(?:\.\d+)*|[a-z]|[ivxlc]+)\s*[.)]\s+/u, '')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface FoundSection {
  /** The heading as pinned. */
  readonly heading: string;
  /** The heading as the document has it, or null when it is not there. */
  readonly found: string | null;
  /** SHA-256 of the section's blocks (stable JSON), or null when it is not there (or is ambiguous). */
  readonly digest: string | null;
  /**
   * CR-2026-11-R2 (R2-33): how many headings of the document match the pin (0, 1, or more). Two or more are AMBIGUOUS: no
   * digest, reported as a pinned change, and the owner's approval is refused until one heading is left.
   */
  readonly matches: number;
}

/** A heading block's level (1 when it has none). */
const levelOf = (b: Obj): number => (typeof b.level === 'number' ? b.level : 1);

/**
 * Each pinned heading's section in a document's top-level blocks. CR-2026-11-R2 (R2-33): a pin must be unambiguous, so a
 * heading that appears twice or more has no section (`digest` null, `matches` > 1), never its first match.
 */
export function pinnedSections(blocks: unknown, headings: readonly string[]): FoundSection[] {
  const list = (Array.isArray(blocks) ? blocks : []).filter(
    (b): b is Obj => typeof b === 'object' && b !== null,
  );
  return headings.map((heading) => {
    const want = headingKey(heading);
    const hits = list.filter((b) => b.kind === 'heading' && headingKey(runsText(b)) === want).length;
    const at = list.findIndex((b) => b.kind === 'heading' && headingKey(runsText(b)) === want);
    if (at < 0) return { heading, found: null, digest: null, matches: 0 };
    if (hits > 1) return { heading, found: runsText(list[at]!).trim(), digest: null, matches: hits };
    const level = levelOf(list[at]!);
    let end = at + 1;
    while (end < list.length) {
      const b = list[end]!;
      if (b.kind === 'heading' && levelOf(b) <= level) break;
      end++;
    }
    const digest = createHash('sha256')
      .update(stableJson(list.slice(at, end)))
      .digest('hex');
    return { heading, found: runsText(list[at]!).trim(), digest, matches: 1 };
  });
}

/** The document's headings (for a refusal that names what it holds), at most `max`. */
export function headingsOf(blocks: unknown, max = 40): string[] {
  const out: string[] = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (typeof b !== 'object' || b === null || (b as Obj).kind !== 'heading') continue;
    const t = runsText(b as Obj).trim();
    if (t) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** One heading of a document's outline: its text and its level (1 when the block has none). */
export interface OutlineHeading {
  readonly heading: string;
  readonly level: number;
}

/**
 * The document's headings in order, with their levels (ADR 0052 amendment: the Packs page's picker for re-mapping a pin),
 * at most `max`. Empty headings are left out.
 */
export function outlineOf(blocks: unknown, max = 200): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (typeof b !== 'object' || b === null || (b as Obj).kind !== 'heading') continue;
    const t = runsText(b as Obj).trim();
    if (t) out.push({ heading: t, level: levelOf(b as Obj) });
    if (out.length >= max) break;
  }
  return out;
}

// ============================================================================================ v3 F5a: supplementary tags

/**
 * v3 F5a (ADR 0067, H1): the top-level blocks of one pinned section (its heading included), or null when the heading is
 * not in the document exactly once (missing or ambiguous: nothing is read from it).
 */
export function sectionBlocksOf(blocks: unknown, heading: string): Obj[] | null {
  const list = (Array.isArray(blocks) ? blocks : []).filter(
    (b): b is Obj => typeof b === 'object' && b !== null,
  );
  const want = headingKey(heading);
  const at = list.findIndex((b) => b.kind === 'heading' && headingKey(runsText(b)) === want);
  if (at < 0) return null;
  if (list.filter((b) => b.kind === 'heading' && headingKey(runsText(b)) === want).length > 1) return null;
  const level = levelOf(list[at]!);
  let end = at + 1;
  while (end < list.length) {
    const b = list[end]!;
    if (b.kind === 'heading' && levelOf(b) <= level) break;
    end++;
  }
  return list.slice(at, end);
}

/**
 * The sentence that states the list: "… approved these existing tags as permitted supplementary tags on any eligible
 * owner (author ruling, 23 November 2026): Cosmology, Chronology and Setting Framework." The list runs from the colon
 * after "permitted supplementary tags" to the full stop that ends the sentence.
 */
const LIST_SENTENCE = /permitted supplementary tags\b[^:.]*:\s*([^.:]+?)\s*\.(?=\s|$)/i;

/** "A", "A and B", "A, B and C" (a serial comma before "and" is read too): the tags, in order. */
export function splitTagList(text: string): string[] {
  const t = text.trim();
  if (t === '') return [];
  const parts = t.split(/\s*,\s*/);
  const last = parts.pop()!;
  const tail = /^(?:and\s+)?(.*?)(?:\s+and\s+(.+))?$/i.exec(last);
  const out = [...parts];
  if (tail) {
    const [, a, b] = tail;
    if (a) out.push(a);
    if (b) out.push(b);
  } else out.push(last);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

/** The written form of a list: "A", "A and B", "A, B and C" (the section's own style). */
export function joinTagList(tags: readonly string[]): string {
  if (tags.length <= 1) return tags[0] ?? '';
  return `${tags.slice(0, -1).join(', ')} and ${tags.at(-1)}`;
}

export type SupplementaryParse =
  | {
      readonly ok: true;
      readonly tags: string[];
      /** The index (among the section's blocks) of the paragraph holding the list, and the list's text. */
      readonly blockIndex: number;
      readonly listText: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * v3 F5a (ADR 0067, H1): the tags the "Approved Supplementary Tags" section approves, parsed from its sentence. Fails
 * (never guesses) when no paragraph states the list in that form, or more than one does.
 */
export function parseSupplementaryTags(section: readonly Obj[] | null): SupplementaryParse {
  if (!section) return { ok: false, reason: 'the section is not in the document exactly once' };
  const hits: { index: number; list: string }[] = [];
  section.forEach((b, index) => {
    if (b.kind === 'heading') return;
    const m = LIST_SENTENCE.exec(runsText(b));
    if (m?.[1] !== undefined) hits.push({ index, list: m[1] });
  });
  if (hits.length === 0)
    return {
      ok: false,
      reason:
        'no sentence of the section states the list as “… permitted supplementary tags …: A, B and C.”; the bridge reads nothing it cannot read exactly',
    };
  if (hits.length > 1)
    return { ok: false, reason: 'more than one sentence of the section states a list; which one governs cannot be told' };
  const tags = splitTagList(hits[0]!.list);
  const bad = tags.find((t) => t.length > 100 || /[\n\r]/.test(t));
  if (tags.length === 0 || bad !== undefined)
    return { ok: false, reason: `the list “${hits[0]!.list}” does not read as tags` };
  return { ok: true, tags, blockIndex: hits[0]!.index, listText: hits[0]!.list };
}

export type SupplementaryEdit =
  | {
      readonly ok: true;
      /** The paragraph's id (the block written) and the block as it will be. */
      readonly blockId: string;
      readonly before: Obj;
      readonly after: Obj;
      readonly beforeText: string;
      readonly afterText: string;
      readonly tags: string[];
    }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/**
 * v3 F5a (ADR 0067, H2): the section's paragraph with `tag` added at the end of its list, keeping the sentence's
 * structure ("A, B and C" becomes "A, B, C and D"); every other run, mark and attribute of the block is kept. Refused
 * when the list cannot be read, the tag is already listed, the tag would make the list ambiguous ("and", a comma, a
 * full stop or a colon in it), or the list does not sit inside one plain text run (formatting inside it: edit it in
 * the app).
 */
export function addSupplementaryTag(section: readonly Obj[] | null, tag: string): SupplementaryEdit {
  const t = tag.trim();
  if (t === '' || t.length > 100 || /[,.:;\n\r]/.test(t) || /\band\b/i.test(t))
    return {
      ok: false,
      code: 'TAG_NOT_LISTABLE',
      reason: `“${tag}” cannot be written into the list unambiguously (a comma, a full stop, a colon or “and” in a tag would change how the list reads)`,
    };
  const parsed = parseSupplementaryTags(section);
  if (!parsed.ok) return { ok: false, code: 'SECTION_NOT_READABLE', reason: parsed.reason };
  if (parsed.tags.some((x) => headingKey(x) === headingKey(t)))
    return { ok: false, code: 'ALREADY_LISTED', reason: `“${t}” is already an Approved Supplementary Tag` };
  const block = section![parsed.blockIndex]!;
  if (typeof block.id !== 'string')
    return { ok: false, code: 'SECTION_NOT_EDITABLE', reason: 'the paragraph has no block id' };
  const runs = Array.isArray(block.content) ? (block.content as Obj[]) : [];
  const nextList = joinTagList([...parsed.tags, t]);
  const at = runs.findIndex((r) => typeof r.text === 'string' && LIST_SENTENCE.test(r.text));
  const run = at >= 0 ? runs[at]! : null;
  const text = run && typeof run.text === 'string' ? run.text : null;
  const m = text ? LIST_SENTENCE.exec(text) : null;
  if (!run || !text || !m || m[1] !== parsed.listText)
    return {
      ok: false,
      code: 'SECTION_NOT_EDITABLE',
      reason:
        'the list does not sit inside one plain text run (part of it is formatted or a mention): add the tag in the LegendKeeper app',
    };
  const start = m.index + m[0].lastIndexOf(m[1]);
  const newText = text.slice(0, start) + nextList + text.slice(start + m[1].length);
  const after: Obj = { ...block, content: runs.map((r, i) => (i === at ? { ...r, text: newText } : r)) };
  return {
    ok: true,
    blockId: block.id,
    before: block,
    after,
    beforeText: runsText(block),
    afterText: runsText(after),
    tags: [...parsed.tags, t],
  };
}

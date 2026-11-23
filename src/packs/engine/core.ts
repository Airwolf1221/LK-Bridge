/**
 * v3 F7.1 (ADR 0072): the Character Core rule, in one place.
 *
 * Character Architecture: "a character with an index and several owners has a Character Core". This module answers the
 * two questions every planner that changes a character's set has to ask:
 *
 * 1. **Is a Core needed?** (`coreNeed`, `ownersInIndex`): used by the package planner (planPackage's extend mode:
 *    arkona_add_character_art, arkona_create_owner's character pages, arkona_create_character with target, a
 *    relationship) and by the split planner (`core.needed`, CR-2026-11-R3 R3-66), so the two cannot drift apart.
 *    An **owner page** is a page of the character's set: in the tree, a `[BSRC]` or `[BWRK]` page directly under the
 *    character's index (never an index, never an Archived page); in a package, a page whose role rule holds facts (any
 *    role but the index: the registry's `facts: 'none'`) placed under the character's index (a relationship hosted
 *    under the other participant, or a Working draft placed flat under [INDEX] Working, is not this index's owner).
 * 2. **What does the upgrade change in the page's text?** (`planCoreText`): the compact-identity phrasings replaced
 *    deterministically, on the upgraded page and on the character's Art page; every image the Art page also holds
 *    removed from the Core, and every image it lacks moved there (never dropped); any other sentence still saying
 *    "compact" listed for the owner, never edited.
 *
 * Everything here is pure: the planners read the pages live and the job applies the change inside its lock
 * (`applyCoreText`, the `pack.core_text` filler), touching only the blocks the plan named.
 */
import type { LkBlock } from '../../markdown/index.js';
import { blockText, sectionsOf, textKey } from './text.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// ============================================================================================ is a Core needed?

/** The tree kinds an owner page has (a page, current or Working; never an index or an Archived page). */
export const OWNER_PAGE_KINDS: ReadonlySet<string> = new Set(['bsrc', 'bwrk']);

/** A package role that makes an owner page: every role whose rule holds facts (the index's rule holds none). */
export const isOwnerRole = (rule: { readonly facts: string }): boolean => rule.facts !== 'none';

/**
 * The owner pages directly under a character's index besides its identity page (and besides `leaving`: a split's source
 * to be retired). Counted from the repository tree.
 */
export function ownersInIndex(
  children: readonly { readonly id: string; readonly kind: string }[],
  identityId: string,
  leaving: ReadonlySet<string> = new Set(),
): number {
  return children.filter((c) => OWNER_PAGE_KINDS.has(c.kind) && c.id !== identityId && !leaving.has(c.id))
    .length;
}

export interface CoreNeed {
  /** Whether the character, after the change, has an index and two or more owner pages under a Compact Reference. */
  readonly needed: boolean;
  /** Its owner pages after the change: the identity page, the others it keeps, and the new ones. */
  readonly owners: number;
}

/**
 * The rule: the identity page is a Compact Character Reference (`role === from`), the character has an index after the
 * change (one now, or one the change makes), and it has two or more owner pages then (its identity page, the others it
 * keeps under the index, and the new ones placed there).
 */
export function coreNeed(a: {
  readonly role: string;
  /** The role a Core is upgraded from (the hook's `upgrade.from`: `compact`), or null when the type has no upgrade. */
  readonly from: string | null;
  readonly hasIndex: boolean;
  /** Owner pages under the index besides the identity page (`ownersInIndex`). */
  readonly existing: number;
  /** New owner pages the change places under the index. */
  readonly added: number;
}): CoreNeed {
  const owners = 1 + a.existing + a.added;
  const indexAfter = a.hasIndex || a.added > 0;
  return { needed: a.from !== null && a.role === a.from && indexAfter && owners >= 2, owners };
}

// ============================================================================================ the wording

/** One phrase replaced in one block (for the preview, the proposal and the job's record). */
export interface Replacement {
  readonly blockId: string;
  readonly before: string;
  readonly after: string;
}

/** A sentence still saying "compact" after the replacements: listed for the owner, never edited. */
export interface CompactLeft {
  readonly page: string;
  readonly blockId: string;
  readonly sentence: string;
}

/** Which page's rules: the upgraded page's own, or the Art page's (which also says "her character reference"). */
export type WordingRole = 'core' | 'art';

/** The replacement keeps an all-capitals phrase in capitals; otherwise the Core's proper name, "Character Core". */
const keepCase = (found: string, to: string): string =>
  /[a-z]/i.test(found) && found === found.toUpperCase() ? to.toUpperCase() : to;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The phrase rules, in order (the longest first). Deterministic: a phrase is replaced, the rest of the run is kept.
 *
 * - "Compact Main CANON reference" (any case; Main optional; CANON or AU) → "Main CANON Character Core";
 * - "Compact Character Reference", "compact character reference", "compact reference" → "Character Core";
 * - the page's old name "<Name> - Character Reference" → "<Name> - Character Core";
 * - on the Art page only, "character reference" where the sentence means the identity page: after a possessive or
 *   determiner that points at the character ("her", "his", "their", "its", "the", "<Name>'s"), and not followed by a
 *   word that makes it something else ("character reference images", "… sheet", "… art", "… pages", "… folder").
 */
function rulesFor(role: WordingRole, subject: string): { re: RegExp; to: (m: RegExpExecArray) => string }[] {
  const rules: { re: RegExp; to: (m: RegExpExecArray) => string }[] = [
    {
      re: /\bcompact\s+(main\s+)?(canon|au)\s+reference\b/gi,
      to: (m) => keepCase(m[0], `${m[1] ? `${m[1].trim()} ` : ''}${m[2]!} Character Core`),
    },
    { re: /\bcompact\s+character\s+reference\b/gi, to: (m) => keepCase(m[0], 'Character Core') },
    { re: /\bcompact\s+reference\b/gi, to: (m) => keepCase(m[0], 'Character Core') },
  ];
  if (subject.trim() !== '')
    rules.push({
      re: new RegExp(`\\b${escape(subject.trim())}\\s+-\\s+Character\\s+Reference\\b`, 'gi'),
      to: () => `${subject.trim()} - Character Core`,
    });
  if (role === 'art') {
    const name = subject.trim() !== '' ? `|${escape(subject.trim())}['’]s` : '';
    rules.push({
      re: new RegExp(
        `\\b(her|his|their|its|the${name})\\s+character\\s+reference\\b(?!\\s+(?:images?|sheets?|art|pages?|folders?)\\b)`,
        'gi',
      ),
      to: (m) => `${m[1]!} ${keepCase(m[0].slice(m[1]!.length).trim(), 'Character Core')}`,
    });
  }
  return rules;
}

/** One run's text with the rules applied (and whether anything changed). */
export function rewordText(text: string, role: WordingRole, subject: string): string {
  let out = text;
  for (const r of rulesFor(role, subject)) {
    r.re.lastIndex = 0;
    // replace's arguments: the match, its groups (undefined when unmatched), then the offset (a number) and the string
    out = out.replace(r.re, (...args: unknown[]) => {
      const at = args.findIndex((a) => typeof a === 'number');
      return r.to(args.slice(0, at) as unknown as RegExpExecArray);
    });
  }
  return out;
}

/** The blocks whose runs change, by top-level block id: each changed run as a replacement. Never `unsupported`. */
function rewordBlock(b: Obj, role: WordingRole, subject: string, top: string, out: Replacement[]): Obj {
  if (b.kind === 'unsupported') return b;
  let changed = false;
  const next: Obj = { ...b };
  if (Array.isArray(b.content)) {
    const content = (b.content as unknown[]).map((r) => {
      if (!isObj(r) || typeof r.text !== 'string' || isObj(r.mention)) return r;
      const after = rewordText(r.text, role, subject);
      if (after === r.text) return r;
      changed = true;
      out.push({ blockId: top, before: r.text, after });
      return { ...r, text: after };
    });
    if (changed) next.content = content;
  }
  if (Array.isArray(b.children)) {
    let kidChanged = false;
    const kids = (b.children as unknown[]).map((c) => {
      if (!isObj(c)) return c;
      const n = rewordBlock(c, role, subject, top, out);
      if (n !== c) kidChanged = true;
      return n;
    });
    if (kidChanged) {
      next.children = kids;
      changed = true;
    }
  }
  return changed ? next : b;
}

/**
 * The rules applied to `blocks` (only the top-level blocks in `only` when given): the new blocks and every replacement.
 * The same function plans (on the page read live) and applies inside the job's lock (on the page as it is then).
 */
export function reword(
  blocks: readonly LkBlock[],
  role: WordingRole,
  subject: string,
  only?: ReadonlySet<string>,
): { blocks: LkBlock[]; replacements: Replacement[] } {
  const replacements: Replacement[] = [];
  const out = blocks.map((b) => {
    const o = b as unknown as Obj;
    const id = typeof o.id === 'string' ? o.id : '';
    if (only && !only.has(id)) return b;
    return rewordBlock(o, role, subject, id, replacements) as unknown as LkBlock;
  });
  return { blocks: out, replacements };
}

/** Every top-level block's own text, nested text included. */
function deepText(b: Obj): string {
  const own = blockText(b);
  const kids = Array.isArray(b.children) ? (b.children as unknown[]).filter(isObj).map(deepText) : [];
  return [own, ...kids].filter((x) => x !== '').join(' ');
}

/** The sentences of `blocks` that still say "compact" (the owner's to judge; never edited). */
export function compactSentences(blocks: readonly LkBlock[], page: string): CompactLeft[] {
  const out: CompactLeft[] = [];
  for (const b of blocks) {
    const o = b as unknown as Obj;
    if (o.kind === 'unsupported') continue;
    const text = deepText(o);
    if (!/\bcompact\b/i.test(text)) continue;
    for (const s of text.split(/(?<=[.!?])\s+/))
      if (/\bcompact\b/i.test(s))
        out.push({ page, blockId: typeof o.id === 'string' ? o.id : '', sentence: s.trim().slice(0, 500) });
  }
  return out;
}

// ============================================================================================ the images

/** The URL's path: the same file on `assets` and `assets2` matches (as the asset reference index does). */
export function urlKey(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Every image URL anywhere in `blocks` (nested ones too), by its path. */
export function imageKeys(blocks: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  const walk = (xs: readonly unknown[]) => {
    for (const x of xs) {
      if (!isObj(x)) continue;
      if (x.kind === 'image' && typeof x.url === 'string' && x.url !== '') out.add(urlKey(x.url));
      if (Array.isArray(x.children)) walk(x.children);
    }
  };
  walk(blocks);
  return out;
}

/** An image the upgrade takes off the Core: already on the Art page, or moved there first. */
export interface CoreImage {
  readonly blockId: string;
  readonly url: string;
  /** The section of the Core it was in (its heading's text; "" before the first heading). */
  readonly section: string;
  readonly onArt: boolean;
}

export interface CoreImagePlan {
  readonly remove: readonly CoreImage[];
  /** For the images the Art page lacks: per image its label (level 3), a copy of the image and its interpretation. */
  readonly append: readonly LkBlock[];
  /** The Core's sections that held a removed image, and the text left in them (for the overlap warning). */
  readonly sections: readonly { readonly title: string; readonly paragraphs: number }[];
}

/**
 * The Core's top-level image blocks against the Art page's images: each image the Art page holds is removed from the
 * Core; each it lacks is copied to the Art page (its label, the image, and the paragraphs that follow it up to the next
 * image or heading as its interpretation) and then removed from the Core. Only the image block leaves the Core: its
 * prose stays, for the owner to trim. `mint` gives the copies new block ids.
 */
export function planCoreImages(
  core: readonly LkBlock[],
  artKeys: ReadonlySet<string>,
  subject: string,
  mint: () => string,
): CoreImagePlan {
  const remove: CoreImage[] = [];
  const append: LkBlock[] = [];
  const touched = new Map<string, number>();
  let section = '';
  const seen = new Set<string>();
  for (let i = 0; i < core.length; i++) {
    const b = core[i] as unknown as Obj;
    if (b.kind === 'heading') {
      section = blockText(b);
      continue;
    }
    if (b.kind !== 'image' || typeof b.url !== 'string' || b.url === '' || typeof b.id !== 'string') continue;
    const key = urlKey(b.url);
    const onArt = artKeys.has(key) || seen.has(key);
    if (!onArt) {
      seen.add(key);
      const label =
        (typeof b.alt === 'string' && b.alt.trim()) ||
        (typeof b.title === 'string' && b.title.trim() && b.title.trim() !== 'Image' ? b.title.trim() : '') ||
        `${subject} - From the Character Core`;
      append.push({
        id: mint(),
        kind: 'heading',
        level: 3,
        content: [{ text: label }],
      });
      const { id: _id, ...rest } = b;
      void _id;
      append.push({ ...rest, id: mint() } as unknown as LkBlock);
      for (let j = i + 1; j < core.length; j++) {
        const n = core[j] as unknown as Obj;
        if (n.kind === 'heading' || n.kind === 'image') break;
        if (n.kind !== 'paragraph') continue;
        append.push({ ...(JSON.parse(JSON.stringify(n)) as Obj), id: mint() } as unknown as LkBlock);
      }
    }
    remove.push({ blockId: b.id, url: b.url, section, onArt: artKeys.has(key) });
    touched.set(section, 0);
  }
  for (const s of sectionsOf(core)) {
    const key = s.heading ? s.title : '';
    if (!touched.has(key)) continue;
    touched.set(
      key,
      s.blocks.filter((x) => (x as unknown as Obj).kind === 'paragraph' && blockText(x).trim() !== '').length,
    );
  }
  return {
    remove,
    append,
    sections: [...touched.entries()].map(([title, paragraphs]) => ({ title, paragraphs })),
  };
}

// ============================================================================================ inside the job's lock

/** The `pack.core_text` filler's input: what the plan named, re-applied to the page as it is when the job runs. */
export interface CoreTextInput {
  readonly role: WordingRole;
  readonly subject: string;
  /** The top-level blocks whose wording the plan changes. */
  readonly reword: readonly string[];
  /** The image blocks removed (each only while it still shows the same file). */
  readonly remove: readonly { readonly blockId: string; readonly url: string }[];
  /** With planned blocks (the moved images): the Art page's images section and its boundary sections. */
  readonly section?: string;
  readonly boundaries?: readonly string[];
}

/**
 * The change applied to the document as it is now: the wording rules on the named blocks, the named image blocks
 * removed while they still show the planned file. (Appending the moved images is the Art filler's, run by the caller.)
 * Nothing else is touched, so every `unsupported` block stays where it is.
 */
export function applyCoreText(
  current: readonly LkBlock[],
  input: CoreTextInput,
): { blocks: LkBlock[]; replaced: number; removed: number } {
  const r = reword(current, input.role, input.subject, new Set(input.reword));
  const drop = new Map(input.remove.map((x) => [x.blockId, urlKey(x.url)]));
  let removed = 0;
  const blocks = r.blocks.filter((b) => {
    const o = b as unknown as Obj;
    const want = typeof o.id === 'string' ? drop.get(o.id) : undefined;
    if (want === undefined || o.kind !== 'image' || typeof o.url !== 'string' || urlKey(o.url) !== want)
      return true;
    removed++;
    return false;
  });
  return { blocks, replaced: r.replacements.length, removed };
}

/** For the overlap warning: the text a Core keeps in a section whose images left it. */
export function visualTextWarning(
  page: string,
  sections: CoreImagePlan['sections'],
): { code: string; message: string; page: string; section: string }[] {
  return sections
    .filter((s) => s.paragraphs > 0)
    .map((s) => ({
      code: 'UPGRADE_OVERLAP',
      message: `${page}: its section “${s.title || '(before the first heading)'}” held images that are now only on the Art page; its ${s.paragraphs} paragraph${s.paragraphs === 1 ? '' : 's'} of visual text stay${s.paragraphs === 1 ? 's' : ''} in the Core. Trim it from the Core afterwards (write_page), as a follow-up: the Art page owns the visual references.`,
      page,
      section: s.title,
    }));
}

/** The upgrade's text change, in words (the preview, the proposal and the step's label). */
export function coreTextWords(c: {
  readonly replacements: readonly Replacement[];
  readonly append: readonly unknown[];
  readonly remove: readonly unknown[];
  readonly section: string;
}): string {
  const parts: string[] = [];
  if (c.replacements.length)
    parts.push(
      `${c.replacements.length} phrase${c.replacements.length === 1 ? '' : 's'} calling the identity page compact now say${c.replacements.length === 1 ? 's' : ''} Character Core`,
    );
  const images = c.append.filter((b) => isObj(b) && b.kind === 'image').length;
  if (images)
    parts.push(
      `${c.section}: +${images} image(s) moved from the Character Core, each with its interpretation`,
    );
  if (c.remove.length)
    parts.push(`${c.remove.length} image block(s) removed (each on the Art page; no prose removed)`);
  return parts.join('; ') || 'no change';
}

/** textKey, re-exported for callers matching section names. */
export { textKey };

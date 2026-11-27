/**
 * v3 F6d (ADR 0082; design T13 as amended by the owner on 26 November 2026): templated source names, pure.
 *
 * The owner: "I'm not married to the current naming conventions of my repository. I would much rather templated names if
 * it will improve usability, with an existing exception for specialist sources that need unique naming and typing."
 *
 * An ordinary source is named `<Subject> - <Role>`: its Subject sidebar value as written, and the role word of its
 * canonical Reference Type in the PUBLISHED vocabulary (F6a: each type written "Type (role word)" in Source Formatting's
 * Reference Type Vocabulary). The lifecycle prefix ([BSRC], [BWRK], [BARC]) stays as it is.
 *
 * `judgeTemplatedNames` gives every page in scope one status (N2):
 *
 * | Status              | When |
 * | ------------------- | ---- |
 * | `templated`         | the name already is the template (case, accents, the prefix and an ASCII hyphen versus any dash aside) |
 * | `rename`            | the template is known, differs from the name, and is free |
 * | `held_no_subject`   | Subject empty, missing, twice in the sidebar, or holding an em dash (never named by guess) |
 * | `held_type`         | the vocabulary is not published, or the Reference Type is missing or not canonical (yet) |
 * | `held_collision`    | the full name (with the prefix) is a sibling's already, or another rename would take it too |
 * | `exempt_specialist` | the Reference Type is an approved specialist type for the page (the Specialist exemption) |
 * | `kept`              | the owner's "Keep this name", while the page's Subject, Reference Type and name are unchanged |
 *
 * Which pages are in scope (N1) is the caller's (src/audits/checks/templated-names.ts): it needs the snapshot tree.
 */
import { createHash } from 'node:crypto';
import { typeKey, type VocabularyLists } from '../reftypes/vocabulary.js';

export const STATUSES = [
  'rename',
  'held_collision',
  'held_no_subject',
  'held_type',
  'templated',
  'exempt_specialist',
  'kept',
] as const;
export type TemplatedStatus = (typeof STATUSES)[number];

/** The separator between the Subject and the role word. */
export const SEPARATOR = ' - ';
export const EM_DASH = '—';

/** Every dash a name may hold for the ASCII hyphen (hyphens, en and em dashes, minus signs, the small and wide forms). */
const DASHES = /[‐-―−⸺⸻﹘﹣－]/g;

/** A name's comparable form: accents removed (NFD), every dash an ASCII hyphen, white space collapsed, lower case. */
export function looseKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(DASHES, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The template for a Subject and a role word. */
export const templateFor = (subject: string, role: string): string =>
  `${subject.replace(/\s+/g, ' ').trim()}${SEPARATOR}${role.trim()}`;

/** The state a "Keep this name" ruling is tied to: the Subject, the Reference Type and the full name (SHA-256). */
export function rulingHash(o: {
  readonly subject: string | null;
  readonly referenceType: string | null;
  readonly rawName: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([o.subject ?? '', o.referenceType ?? '', o.rawName]))
    .digest('hex');
}

/** A page in scope, as the judge reads it. */
export interface NamePage {
  readonly id: string;
  /** The full name, prefix included. */
  readonly rawName: string;
  /** The name without its prefix. */
  readonly displayName: string;
  readonly parentId: string | null;
  /** The primary category tag (null: none or not readable). */
  readonly category: string | null;
  /** The Subject row's text (null: no row or empty). */
  readonly subject: string | null;
  /** The Subject row is in the sidebar more than once. */
  readonly subjectAmbiguous?: boolean;
  readonly referenceType: string | null;
  readonly referenceTypeAmbiguous?: boolean;
}

/** The vocabulary the judge reads: its state and its lists (the published section's, once published). */
export interface TemplateVocabulary {
  readonly status: 'draft' | 'published';
  readonly lists: VocabularyLists;
}

export interface JudgeInput {
  readonly pages: readonly NamePage[];
  readonly vocabulary: TemplateVocabulary | null;
  /** The children of a parent (every kind), for the sibling guard. */
  readonly siblings: (parentId: string) => readonly { readonly id: string; readonly rawName: string }[];
  /** The owner's "Keep this name" rulings: page id → the state hash they were made on. */
  readonly rulings?: ReadonlyMap<string, string>;
  /** The pack's name rules (a forbidden word, a date): the template must pass them. Null: it does. */
  readonly nameProblem?: (name: string) => string | null;
}

export interface TemplatedRow {
  readonly pageId: string;
  readonly rawName: string;
  readonly displayName: string;
  readonly parentId: string | null;
  readonly category: string | null;
  readonly subject: string | null;
  readonly referenceType: string | null;
  /** The role word (null: not known). */
  readonly role: string | null;
  /** The proposed full name, prefix included (null: no template). */
  readonly proposed: string | null;
  readonly status: TemplatedStatus;
  readonly reason: string;
  /** The state a ruling would be tied to (and is checked against). */
  readonly hash: string;
  /** A collision: the other page. */
  readonly other?: { readonly id: string; readonly name: string };
}

/** The canonical types by their exact name: the category and role word. */
function canonicalTypes(v: VocabularyLists): Map<string, { category: string; role: string }> {
  const out = new Map<string, { category: string; role: string }>();
  for (const c of v.categories)
    for (const t of c.types) out.set(t.name, { category: c.category, role: t.role });
  return out;
}

/** Whether a page's Reference Type is an approved specialist type for it (its category, and the page when named). */
export function specialistFor(
  v: VocabularyLists,
  referenceType: string,
  category: string | null,
  pageId: string,
): 'category' | 'page' | null {
  for (const s of v.specialist) {
    if (s.type !== referenceType) continue;
    if (category !== null && typeKey(s.category) !== typeKey(category)) continue;
    if (s.pages === null) {
      if (category !== null) return 'category';
      continue;
    }
    if (s.pages.some((p) => p.id === pageId)) return 'page';
  }
  return null;
}

/** The order of a run and of the report: primary category, then name. */
export function runOrder(a: TemplatedRow, b: TemplatedRow): number {
  const ca = (a.category ?? '￿').toLowerCase();
  const cb = (b.category ?? '￿').toLowerCase();
  if (ca !== cb) return ca < cb ? -1 : 1;
  const na = looseKey(a.displayName);
  const nb = looseKey(b.displayName);
  if (na !== nb) return na < nb ? -1 : 1;
  return a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0;
}

/** Every page's status (see the module comment), in the run order. */
export function judgeTemplatedNames(input: JudgeInput): TemplatedRow[] {
  const v = input.vocabulary;
  const canon = v ? canonicalTypes(v.lists) : new Map<string, { category: string; role: string }>();
  const rows: TemplatedRow[] = [];
  for (const p of input.pages) {
    const hash = rulingHash(p);
    const base = {
      pageId: p.id,
      rawName: p.rawName,
      displayName: p.displayName,
      parentId: p.parentId,
      category: p.category,
      subject: p.subject,
      referenceType: p.referenceType,
      hash,
    };
    const ruled = input.rulings?.get(p.id);
    if (ruled !== undefined && ruled === hash) {
      rows.push({
        ...base,
        role: null,
        proposed: null,
        status: 'kept',
        reason:
          'the owner’s ruling “Keep this name” (it lapses when the Subject, the Reference Type or the name changes)',
      });
      continue;
    }
    const held = (status: TemplatedStatus, reason: string, role: string | null = null) =>
      rows.push({ ...base, role, proposed: null, status, reason });
    if (!v) {
      held('held_type', 'the pack has no Reference Type vocabulary');
      continue;
    }
    if (v.status !== 'published') {
      held('held_type', 'the vocabulary is not published');
      continue;
    }
    const value = p.referenceType?.trim() ?? '';
    if (value !== '' && !p.referenceTypeAmbiguous) {
      const sp = specialistFor(v.lists, value, p.category, p.id);
      if (sp) {
        held(
          'exempt_specialist',
          sp === 'category'
            ? `“${value}” is an approved specialist type for any ${p.category} page: the page keeps its name`
            : `“${value}” is an approved specialist type for this page: it keeps its name`,
        );
        continue;
      }
    }
    const subject = p.subject?.trim() ?? '';
    if (p.subjectAmbiguous) {
      held(
        'held_no_subject',
        'Subject is in the sidebar more than once; leave one, then the page is judged again',
      );
      continue;
    }
    if (subject === '') {
      held(
        'held_no_subject',
        'Subject is empty or missing: the name is never guessed; fill in the Subject first',
      );
      continue;
    }
    if (subject.includes(EM_DASH)) {
      held('held_no_subject', 'Subject uses an em dash; fix the Subject first');
      continue;
    }
    if (p.referenceTypeAmbiguous) {
      held('held_type', 'Reference Type is in the sidebar more than once; leave one first');
      continue;
    }
    if (value === '') {
      held('held_type', 'the page has no Reference Type');
      continue;
    }
    const t = canon.get(value);
    if (!t) {
      held(
        'held_type',
        `the Reference Type “${value}” is not canonical yet: it waits for reference_type_noncanonical (decide it on the Reference Types page)`,
      );
      continue;
    }
    if (p.category !== null && typeKey(t.category) !== typeKey(p.category)) {
      held(
        'held_type',
        `“${value}” is a ${t.category} type, but the page’s primary category tag is ${p.category}: reference_type_category_mismatch waits for the owner’s ruling`,
        t.role,
      );
      continue;
    }
    const template = templateFor(subject, t.role);
    const problem = input.nameProblem?.(template) ?? null;
    if (problem) {
      held(
        'held_no_subject',
        `the templated name “${template}” breaks the name rules (${problem}); fix the Subject first`,
        t.role,
      );
      continue;
    }
    const prefix = p.rawName.slice(0, p.rawName.length - p.displayName.length);
    const proposed = `${prefix}${template}`;
    if (looseKey(p.displayName) === looseKey(template)) {
      rows.push({
        ...base,
        role: t.role,
        proposed,
        status: 'templated',
        reason: 'already named by the template',
      });
      continue;
    }
    rows.push({ ...base, role: t.role, proposed, status: 'rename', reason: `rename to “${proposed}”` });
  }
  // Collisions: a sibling's name already, or two renames to one name under one parent (the full name, prefix included).
  const renames = rows.filter((r) => r.status === 'rename');
  const byTarget = new Map<string, TemplatedRow[]>();
  for (const r of renames) {
    const k = `${r.parentId ?? ''}\u0000${looseKey(r.proposed!)}`;
    byTarget.set(k, [...(byTarget.get(k) ?? []), r]);
  }
  const replace = new Map<string, TemplatedRow>();
  // Each parent's children keyed once (not once per rename): O(pages), never renames × siblings.
  const keyed = new Map<string, Map<string, { id: string; rawName: string }[]>>();
  const siblingsKeyed = (parentId: string) => {
    let m = keyed.get(parentId);
    if (!m) {
      m = new Map();
      for (const c of input.siblings(parentId)) {
        const k = looseKey(c.rawName);
        const list = m.get(k);
        if (list) list.push(c);
        else m.set(k, [c]);
      }
      keyed.set(parentId, m);
    }
    return m;
  };
  for (const r of renames) {
    const target = looseKey(r.proposed!);
    const twin = r.parentId
      ? siblingsKeyed(r.parentId)
          .get(target)
          ?.find((s) => s.id !== r.pageId)
      : undefined;
    if (twin) {
      replace.set(r.pageId, {
        ...r,
        status: 'held_collision',
        reason: `“${r.proposed}” is already the name of a page beside it (${twin.rawName}): rename or merge one first`,
        other: { id: twin.id, name: twin.rawName },
      });
      continue;
    }
    const group = byTarget.get(`${r.parentId ?? ''}\u0000${target}`) ?? [];
    if (group.length > 1) {
      const other = group.find((x) => x.pageId !== r.pageId)!;
      replace.set(r.pageId, {
        ...r,
        status: 'held_collision',
        reason: `${other.rawName} would be renamed to the same name (“${r.proposed}”) beside it: held for this run; fix one Subject first`,
        other: { id: other.pageId, name: other.rawName },
      });
    }
  }
  const out = rows.map((r) => replace.get(r.pageId) ?? r);
  return out.sort(runOrder);
}

/** Counts per status (every status present, zero included). */
export function countsOf(
  rows: readonly { readonly status: TemplatedStatus }[],
): Record<TemplatedStatus, number> {
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<TemplatedStatus, number>;
  for (const r of rows) out[r.status]++;
  return out;
}

/**
 * v3 F6d (ADR 0082): the templated name a creation tool suggests for a new source (`create_resource`,
 * `arkona_create_owner`), or null: no template known (no approved templated names, the vocabulary not published, no
 * Subject, a type not canonical or of another category, a specialist type, a character's page), or the name given is
 * the template already. Never a refusal: the audit's `name_nontemplated` catches it later.
 */
export function templatedNameFor(
  rules: {
    readonly templatedNames?: unknown;
    readonly referenceTypes?:
      | {
          readonly status: 'draft' | 'published';
          readonly rule: string;
          readonly categories: VocabularyLists['categories'];
          readonly specialist: VocabularyLists['specialist'];
        }
      | undefined;
  } | null,
  o: {
    readonly displayName: string;
    readonly subject: string | null;
    readonly referenceType: string | null;
    readonly category: string | null;
  },
): string | null {
  const rt = rules?.referenceTypes;
  if (!rules?.templatedNames || !rt || rt.status !== 'published') return null;
  if (o.category !== null && typeKey(o.category) === typeKey('Character')) return null;
  const [row] = judgeTemplatedNames({
    pages: [
      {
        id: '\u0000new',
        rawName: o.displayName,
        displayName: o.displayName,
        parentId: null,
        category: o.category,
        subject: o.subject,
        referenceType: o.referenceType,
      },
    ],
    vocabulary: {
      status: rt.status,
      lists: { rule: rt.rule, categories: rt.categories, specialist: rt.specialist },
    },
    siblings: () => [],
  });
  return row?.status === 'rename' ? templateFor(o.subject!.trim(), row.role!) : null;
}

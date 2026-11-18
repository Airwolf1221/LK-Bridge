/**
 * v3 F3d amendment (ADR 0058, B and D): what a rename brings to the owner's attention and NEVER edits.
 *
 * - **Name parts** (B). Renaming Azhar al-Nasir to Mikhar al-Narif leaves plain "Azhar" (and "al-Nasir") everywhere.
 *   Characters share names, so the bridge never acts on them: the plan and the post-run report list every occurrence of
 *   the old given name, the old family name and each old alias on its own (a whole word, through the full-text index,
 *   A1), on a current page, that is not already part of the full old name. Each comes with its page, its section and its
 *   sentence, and says when the page belongs to ANOTHER character whose name holds the same part ("this page is in
 *   Azhar al-Rashid's set"), so a shared name is easy to tell. They are never items and never selectable: there is
 *   nothing to approve. The agent brings them to the owner, who can ask for a follow-up rename of specific occurrences
 *   (`arkona_rename` with `from`).
 * - **Custom mention labels** (D). LegendKeeper's API cannot change a mention's custom label (and Arkona's repository
 *   does not use them), so a custom label holding the old name is never written: it is listed here, "custom label:
 *   change it in the app if wanted". A rename never fails on one.
 *
 * The list is capped at {@link REVIEW_CAP} occurrences, with a count of the rest. Free: the full-text index only.
 */
import type { TextHit } from '../../appraisal/fts.js';
import type { Labels } from '../../appraisal/scope.js';
import { textKey } from '../engine/text.js';
import { namePattern, sentenceAround } from './text.js';

export const REVIEW_CAP = 200;

/** A part of the old name searched on its own. */
export interface ReviewPart {
  readonly part: string;
  readonly kind: 'given name' | 'family name' | 'alias';
}

/** One occurrence for the owner to review (never an item). */
export interface ReviewOccurrence {
  readonly kind: 'name part' | 'custom label';
  /** The part found (or, for a custom label, the old name it holds). */
  readonly part: string;
  readonly page: { readonly id: string; readonly name: string };
  readonly section: string | null;
  /** The sentence it is in (a custom label: the paragraph). */
  readonly sentence: string;
  /** A custom label: the label as it reads. */
  readonly label?: string;
  /** The page belongs to another character whose name holds the same part. */
  readonly sharedWith?: string;
  readonly note?: string;
}

export interface ReviewList {
  readonly note: string;
  readonly parts: readonly ReviewPart[];
  /** Every occurrence found, listed or not. */
  readonly count: number;
  readonly occurrences: readonly ReviewOccurrence[];
  /** Occurrences not listed (over the cap). */
  readonly more: number;
}

export interface ReviewEnv {
  readonly projectId: string;
  readonly search: (projectId: string, value: string) => readonly TextHit[];
  readonly labels: (pageId: string) => Labels | null;
  readonly pageName: (pageId: string) => string | null;
  /** The character a page belongs to (its subject's name), or null. */
  readonly characterOf: (pageId: string) => string | null;
}

/** The parts of a character's old name worth reviewing: those the new name no longer holds (never the whole name). */
export function reviewParts(o: {
  readonly oldName: string;
  readonly newName: string;
  readonly given?: string | null;
  readonly family?: string | null;
  readonly aliases?: readonly string[];
}): ReviewPart[] {
  const out: ReviewPart[] = [];
  const add = (part: string | null | undefined, kind: ReviewPart['kind']) => {
    const p = (part ?? '').replace(/\s+/g, ' ').trim();
    if (p.length < 3) return;
    if (textKey(p) === textKey(o.oldName) || textKey(p) === textKey(o.newName)) return;
    // A part the new name still holds is still right on its own.
    if (namePattern(p).test(o.newName)) return;
    if (out.some((x) => textKey(x.part) === textKey(p))) return;
    out.push({ part: p, kind });
  };
  add(o.given, 'given name');
  add(o.family, 'family name');
  for (const a of o.aliases ?? []) add(a, 'alias');
  return out;
}

/** The review list: the custom labels first, then every name part's occurrences, capped. */
export function reviewList(
  env: ReviewEnv,
  o: {
    readonly subjectName: string;
    readonly oldName: string;
    readonly parts: readonly ReviewPart[];
    readonly customLabels?: readonly ReviewOccurrence[];
  },
): ReviewList {
  const all: ReviewOccurrence[] = [...(o.customLabels ?? [])];
  const seen = new Set<string>();
  for (const { part } of o.parts) {
    for (const h of env.search(env.projectId, part)) {
      if (h.unit === 'alias') continue;
      // Current pages only (not the Archived, the Legacy Canon Archive or the Design References: D2).
      const l = env.labels(h.pageId);
      if (l && (l.area !== null || l.lifecycle === 'Archived')) continue;
      // The occurrences on their own: the part as a whole word, not inside the full old name.
      const full = [...h.text.matchAll(namePattern(o.oldName))].map((m) => [m.index, m.index + m[0].length]);
      for (const m of h.text.matchAll(namePattern(part))) {
        const start = m.index;
        const end = start + m[0].length;
        if (full.some(([a, b]) => start >= a! && end <= b!)) continue;
        const key = `${h.pageId}:${h.documentId ?? ''}:${h.blockId ?? ''}:${h.field ?? ''}:${h.unit}:${start}:${part}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const owner = env.characterOf(h.pageId);
        const shared =
          owner !== null && textKey(owner) !== textKey(o.subjectName) && textKey(owner) !== textKey(o.oldName)
            ? namePattern(part).test(owner)
            : false;
        all.push({
          kind: 'name part',
          part,
          page: { id: h.pageId, name: env.pageName(h.pageId) ?? h.pageId },
          section:
            h.unit === 'fact'
              ? `sidebar: ${h.field ?? ''}`.trim()
              : h.unit === 'name'
                ? 'the page name'
                : h.section,
          sentence: sentenceAround(h.text, start, end),
          ...(shared ? { sharedWith: `this page is in ${owner}'s set` } : {}),
        });
      }
    }
  }
  const occurrences = all.slice(0, REVIEW_CAP);
  const more = all.length - occurrences.length;
  const names = o.parts.map((p) => `“${p.part}”`).join(', ');
  return {
    note: [
      'Review only: never edited by the bridge, and nothing here is approved or selectable.',
      o.parts.length > 0
        ? `These are ${names} on their own (not inside “${o.oldName}”): characters share names, so bring them to the owner, who can ask for a follow-up rename of specific occurrences (arkona_rename with from).`
        : '',
      (o.customLabels?.length ?? 0) > 0
        ? 'A custom mention label cannot be changed through LegendKeeper’s API: change it in the app if wanted.'
        : '',
      more > 0 ? `Only the first ${REVIEW_CAP} are listed; ${more} more are not.` : '',
    ]
      .filter(Boolean)
      .join(' '),
    parts: o.parts,
    count: all.length,
    occurrences,
    more,
  };
}

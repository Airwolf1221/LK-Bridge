/**
 * CR-2026-11-R4 (the narrative property; ADR 0065 amendment 2): a page's lifecycle SIGNALS, read as the lifecycle guard
 * reads them, so that the guard, the story layout, the narrative audit and the tools agree on which pages carry a
 * lifecycle. Pure.
 *
 * A signal is a `[BSRC]`, `[BWRK]` or `[BARC]` prefix (read loosely: any case, look-alike letters, a missing space), a
 * status tag (CANON, Working, Archived, and AU) in any spelling the facts fold reads as one, or a lifecycle Status
 * (Authoritative, Working, Archived). Two readings:
 *
 * - `crossing`: a page entering or leaving Narratives, judged as the repository outside Narratives reads it: every
 *   signal above counts.
 * - `inside`: a page sitting in Narratives (the story layout, the narrative audit, the writing tools). There `AU` is the
 *   narrative tag of an AU's continuity (design E2.2: the tools set it) and a Status of Working is the generic Working
 *   sidebar's own value, which the tools never write (E3), so neither counts; everything else does.
 */
import { factKey, factValueKey } from '../facts/rules.js';
import { classifyName } from '../tree/classify.js';

/** The lifecycle words of a project (its lifecycle settings' tags and Status values). */
export interface LifecycleWords {
  readonly tags: { readonly canon: string; readonly working: string; readonly archived: string };
  readonly status: { readonly authoritative: string; readonly working: string; readonly archived: string };
}

/** A name's lifecycle prefix, read loosely (as the lifecycle guard reads it), or null. */
export function lifecyclePrefix(name: string): 'bsrc' | 'bwrk' | 'barc' | null {
  const m = /^\[\s*(bsrc|bwrk|barc|index)\s*\]/.exec(factKey(name));
  const kind = m ? m[1]! : classifyName(name).kind;
  return kind === 'bsrc' || kind === 'bwrk' || kind === 'barc' ? kind : null;
}

export type SignalReading = 'crossing' | 'inside';

/**
 * The lifecycle signals a page carries, in words (empty: none). `au`: the AU tags of the project (the AU ruling's and
 * the narrative rules' own), counted only when reading a crossing.
 */
export function lifecycleSignals(
  words: LifecycleWords,
  page: { readonly name: string; readonly tags: readonly string[]; readonly status: readonly string[] },
  reading: SignalReading,
  au: readonly string[] = [],
): string[] {
  const out: string[] = [];
  const prefix = lifecyclePrefix(page.name);
  if (prefix) out.push(`the [${prefix.toUpperCase()}] prefix`);
  // A Working tag counts inside Narratives too: the tools never keep a template's status tag (E2.2).
  const keys = new Set(
    [words.tags.canon, words.tags.working, words.tags.archived, ...(reading === 'crossing' ? au : [])].map(
      (t) => factKey(t),
    ),
  );
  for (const t of page.tags) if (keys.has(factKey(t))) out.push(`the status tag ${t}`);
  const values = [
    words.status.authoritative,
    words.status.archived,
    ...(reading === 'crossing' ? [words.status.working] : []),
  ].map((v) => factValueKey(v));
  for (const s of page.status) if (values.includes(factValueKey(s))) out.push(`Status ${s}`);
  return out;
}

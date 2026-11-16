/**
 * The closed tag grammar (v3 F3a, ADR 0050; Arkona's Controlled Native Tagging Standard v1.8): a page's tags are
 * COMPUTED from its role's grammar, the page's status and the typed facts, through the pack's token maps; an agent never
 * types one. A slot with no approved token is HELD (left out and reported), never invented; `Unknown`, `Unestablished`
 * and `None` are never tags; duplicates are dropped; a Working page's status tag (`Working`) comes first and it carries no
 * `CANON`. When the pack's governance is not current, nothing is computed (fail closed).
 */
import type { PackRules, RoleRule } from '../types.js';
import { textKey } from './text.js';

export interface HeldSlot {
  readonly page: string;
  readonly slot: string;
  readonly value: string | null;
  readonly reason: string;
}

export interface TagResult {
  readonly tags: string[];
  readonly held: HeldSlot[];
}

/** The token a fact value maps to, by the map's keys compared without case and extra spaces; null when none. */
export function tokenFor(map: Readonly<Record<string, string>>, value: string): string | null {
  const k = textKey(value);
  for (const [key, token] of Object.entries(map)) if (textKey(key) === k) return token;
  return null;
}

/**
 * The status tag of a page (v3 F3b, ADR 0052; the owner's ruling of 16 November 2026, design 1.5): `Working` for a
 * Working page (an AU one too: the lifecycle tag replaces the status tag); for an Authoritative page `AU` when its
 * Continuity Type is the pack's AU value, else `CANON`. A pack without the ruling (`tags.au` absent) gives `CANON`.
 */
export function statusTag(
  rules: PackRules,
  status: 'working' | 'authoritative',
  continuityType?: string | null,
): string {
  if (status === 'working') return rules.tags.working;
  const au = rules.tags.au;
  if (au && continuityType && textKey(continuityType) === textKey(au.continuityType)) return au.tag;
  return rules.tags.authoritative;
}

/**
 * Computes a page's tags from its role's grammar. `status` is the page's lifecycle (`working`: `Working` first and no
 * `CANON`; `authoritative`: `CANON`, or `AU` for an AU page, v3 F3b). `race` and `culture` are the identity facts as
 * given; `specialist` is the page's one specialist tag (already checked against the closed list); `primary` an owner
 * page's primary tag. A Working page whose role has its own `workingTags` gets those, and every tag the role's full
 * grammar would add beyond them is held and reported (never silently dropped).
 */
export function computeTags(input: {
  readonly rules: PackRules;
  readonly role: RoleRule;
  readonly page: string;
  readonly status: 'working' | 'authoritative';
  readonly race?: string | null;
  readonly culture?: string | null;
  readonly specialist?: string | null;
  /** The value that means a deliberate gap (`Unestablished`): its slot is held, never tagged. */
  readonly unestablished?: string;
  /** v3 F3b: the page's Continuity Type (an Authoritative AU page's status tag is the pack's AU tag). */
  readonly continuityType?: string | null;
  /** v3 F3b: an owner page's primary tag (the `$primary` slot). */
  readonly primary?: string | null;
}): TagResult {
  if (input.status === 'working' && input.role.workingTags) {
    const full = computeSlots(input, input.role.tags);
    const kept = computeSlots(input, input.role.workingTags);
    const held = [...kept.held];
    for (const t of full.tags)
      if (!kept.tags.some((x) => textKey(x) === textKey(t)))
        held.push({
          page: input.page,
          slot: 'working',
          value: t,
          reason: `a Working page carries ${input.rules.tags.working} and its primary tag only (Tagging Standard v1.8); add “${t}” when the page is promoted`,
        });
    return { tags: kept.tags, held };
  }
  return computeSlots(input, input.role.tags);
}

function computeSlots(input: Parameters<typeof computeTags>[0], slots: readonly string[]): TagResult {
  const { rules, page } = input;
  const never = new Set(rules.tags.never.map(textKey));
  const held: HeldSlot[] = [];
  const out: string[] = [];
  const push = (t: string) => {
    if (never.has(textKey(t))) return;
    if (!out.some((x) => textKey(x) === textKey(t))) out.push(t);
  };
  for (const slot of slots) {
    if (slot === '$status') {
      push(statusTag(rules, input.status, input.continuityType));
      continue;
    }
    if (slot === '$primary') {
      if (input.primary) push(input.primary);
      continue;
    }
    if (slot === '$race' || slot === '$culture') {
      const value = (slot === '$race' ? input.race : input.culture) ?? null;
      const what = slot === '$race' ? 'race' : 'culture';
      if (value === null || value.trim() === '') {
        held.push({ page, slot: what, value: null, reason: `no ${what} value` });
        continue;
      }
      if (
        never.has(textKey(value)) ||
        (input.unestablished && textKey(value) === textKey(input.unestablished))
      ) {
        held.push({ page, slot: what, value, reason: `“${value}” is never a tag` });
        continue;
      }
      const map = slot === '$race' ? rules.tags.race : rules.tags.culture;
      const token =
        tokenFor(map, value) ??
        (slot === '$race'
          ? (rules.tags.exceptional.find((x) => textKey(x) === textKey(value)) ?? null)
          : null);
      if (token === null) {
        held.push({
          page,
          slot: what,
          value,
          reason: `“${value}” has no approved ${what} token (the owner adds one on the Packs page)`,
        });
        continue;
      }
      push(token);
      continue;
    }
    if (slot === '$specialist') {
      if (input.specialist) push(input.specialist);
      continue;
    }
    push(slot);
  }
  return { tags: out, held };
}

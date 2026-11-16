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
 * Computes a page's tags from its role's grammar. `status` is the page's lifecycle (`working`: `Working` first and no
 * `CANON`; `authoritative`: `CANON`). `race` and `culture` are the identity facts as given; `specialist` is the page's
 * one specialist tag (already checked against the closed list).
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
}): TagResult {
  const { rules, role, page } = input;
  const never = new Set(rules.tags.never.map(textKey));
  const held: HeldSlot[] = [];
  const out: string[] = [];
  const push = (t: string) => {
    if (never.has(textKey(t))) return;
    if (!out.some((x) => textKey(x) === textKey(t))) out.push(t);
  };
  for (const slot of role.tags) {
    if (slot === '$status') {
      push(input.status === 'working' ? rules.tags.working : rules.tags.authoritative);
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

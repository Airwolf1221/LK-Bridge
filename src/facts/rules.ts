/**
 * The protected canonical facts rules of a project (v2 C2a, ADR 0032; PLAN-v2 10.3 as refined by the owner).
 *
 * A rule names a fact (a key-value row key, matched without case and with spaces trimmed) and what about it is
 * protected:
 * - `value`: the listed values are protected in BOTH directions: setting the fact TO one of them, or changing it FROM
 *   one of them to anything else (removing the row included), needs the owner's canonical approval. Values match
 *   without case.
 * - `change`: CHANGING an existing non-empty value needs canonical approval (another value, or removing it); setting
 *   the fact where it is empty (or absent, as on a new page) is allowed.
 *
 * The rules are configuration (project settings `canonicalRules`), edited on the dashboard and audited. A project with
 * none stored uses the defaults below. The default status for pages agents create (`agentDefaultStatus`, "Working")
 * is kept here for C2b's creation tools; templates carry no fact defaults (the owner confirmed), so nothing is inherited.
 */
import * as z from 'zod';

export type CanonicalRule =
  | {
      readonly id: string;
      readonly key: string;
      readonly kind: 'value';
      readonly values: readonly string[];
      readonly note?: string;
    }
  | { readonly id: string; readonly key: string; readonly kind: 'change'; readonly note?: string };

export const DEFAULT_CANONICAL_RULES: readonly CanonicalRule[] = Object.freeze([
  {
    id: 'status-authoritative',
    key: 'Status',
    kind: 'value',
    values: ['Authoritative'],
    note: 'Setting a page’s Status to Authoritative, or changing it from Authoritative, needs canonical approval.',
  },
  {
    id: 'continuity-type',
    key: 'Continuity Type',
    kind: 'change',
    note: 'Changing an existing Continuity Type (for example CANON ↔ AU) needs canonical approval; setting it where empty is allowed.',
  },
  {
    id: 'continuity',
    key: 'Continuity',
    kind: 'change',
    note: 'Changing an existing Continuity (for example one AU to another) needs canonical approval; setting it where empty is allowed.',
  },
]);

/** The Status agents' new pages get (C2b), unless the project says otherwise. */
export const DEFAULT_AGENT_STATUS = 'Working';

const text = (max: number) => z.string().trim().min(1).max(max);

export const canonicalRuleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: text(64).regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters, digits, - or _'),
      key: text(256),
      kind: z.literal('value'),
      values: z.array(text(256)).min(1).max(20),
      note: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      id: text(64).regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters, digits, - or _'),
      key: text(256),
      kind: z.literal('change'),
      note: z.string().max(500).optional(),
    })
    .strict(),
]);

export const canonicalRulesSchema = z
  .array(canonicalRuleSchema)
  .max(50)
  .refine((l) => new Set(l.map((r) => r.id)).size === l.length, 'each rule id once');

/** A fact key as rules compare it: trimmed, inner spaces collapsed, without case. */
export function factKey(key: string): string {
  return key.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-GB');
}

/** A value as `value` rules compare it: trimmed, inner spaces collapsed, without case. */
export function factValueKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-GB');
}

export interface CanonConfig {
  readonly rules: readonly CanonicalRule[];
  /** True when the project stores no rules of its own (the defaults apply). */
  readonly defaults: boolean;
  readonly agentDefaultStatus: string;
  /** Why the stored rules could not be used (they are then the defaults, so nothing is left unprotected). */
  readonly problem: string | null;
}

/** The rules and default status from a project's settings. Invalid stored rules fall back to the defaults (safe side). */
export function canonConfigFrom(settings: Readonly<Record<string, unknown>> | undefined): CanonConfig {
  const raw = settings?.canonicalRules;
  const status =
    typeof settings?.agentDefaultStatus === 'string' && settings.agentDefaultStatus.trim() !== ''
      ? settings.agentDefaultStatus.trim()
      : DEFAULT_AGENT_STATUS;
  if (raw === undefined || raw === null)
    return { rules: DEFAULT_CANONICAL_RULES, defaults: true, agentDefaultStatus: status, problem: null };
  const r = canonicalRulesSchema.safeParse(raw);
  if (!r.success) {
    return {
      rules: DEFAULT_CANONICAL_RULES,
      defaults: true,
      agentDefaultStatus: status,
      problem: `the stored canonical rules are not valid (${r.error.issues[0]?.message ?? 'invalid'}); the defaults apply`,
    };
  }
  return { rules: r.data as CanonicalRule[], defaults: false, agentDefaultStatus: status, problem: null };
}

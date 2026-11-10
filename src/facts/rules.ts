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
 * - `delete` (v2 C2b, decided by the owner on 10 November 2026): DELETING a page whose fact holds one of the listed values
 *   (without case) needs canonical approval; with a cascade, any page of the subtree that holds one. Restoring needs
 *   none: it brings back what was approved.
 *
 * The rules are configuration (project settings `canonicalRules`), edited on the dashboard and audited. A project with
 * none stored uses the defaults below. The default status for pages agents create (`agentDefaultStatus`, "Working")
 * is kept here for C2b's creation tools; templates carry no fact defaults (the owner confirmed), so nothing is inherited.
 */
import * as z from 'zod';

export type CanonicalRule = (
  | {
      readonly id: string;
      readonly key: string;
      readonly kind: 'value';
      readonly values: readonly string[];
      readonly note?: string;
    }
  | { readonly id: string; readonly key: string; readonly kind: 'change'; readonly note?: string }
  | {
      readonly id: string;
      readonly key: string;
      readonly kind: 'delete';
      readonly values: readonly string[];
      readonly note?: string;
    }
  /**
   * v2 C2c (ADR 0035, recommended; not yet decided by the owner): DELETING a page of these kinds (by its name's prefix:
   * `barc` for `[BARC]`) needs canonical approval; with a cascade, any page of the subtree. The archive is provenance.
   */
  | {
      readonly id: string;
      readonly kind: 'deleteKind';
      readonly kinds: readonly ('bsrc' | 'bwrk' | 'barc')[];
      readonly note?: string;
    }
  /**
   * v2 C2c (ADR 0035, recommended; not yet decided by the owner): DELETING a document of these types (map, time, board)
   * from a page whose fact holds one of the values (Status Authoritative) needs canonical approval. C2b flagged it: it
   * removes canonical content.
   */
  | {
      readonly id: string;
      readonly key: string;
      readonly kind: 'deleteDocument';
      readonly values: readonly string[];
      readonly documentTypes: readonly string[];
      readonly note?: string;
    }
) & {
  /** v2 C2c: false switches the rule off (kept in the list, shown on the dashboard, applied nowhere). Default true. */
  readonly enabled?: boolean;
};

/** v2 C2b (decided by the owner on 10 November 2026): deleting an Authoritative page needs canonical approval. */
export const DEFAULT_DELETE_RULE: CanonicalRule = Object.freeze({
  id: 'delete-authoritative',
  key: 'Status',
  kind: 'delete',
  values: ['Authoritative'],
  note: 'Deleting a page whose Status is Authoritative (or, with a cascade, any page of the subtree) needs canonical approval; restoring needs none.',
});

/** v2 C2c (ADR 0035, the recommendation; switchable on the dashboard): deleting a [BARC] page needs canonical approval. */
export const DEFAULT_DELETE_ARCHIVED_RULE: CanonicalRule = Object.freeze({
  id: 'delete-archived',
  kind: 'deleteKind' as const,
  kinds: ['barc' as const],
  note: 'Deleting a [BARC] (Archived) page, or a subtree holding one, needs canonical approval: the archive is provenance. Recommended; switch it off here if not wanted.',
});

/**
 * v2 C2c (ADR 0035, the recommendation; switchable on the dashboard): deleting a map, timeline or board of an
 * Authoritative page needs canonical approval.
 */
export const DEFAULT_DELETE_DOCUMENT_RULE: CanonicalRule = Object.freeze({
  id: 'delete-document-authoritative',
  key: 'Status',
  kind: 'deleteDocument',
  values: ['Authoritative'],
  documentTypes: ['map', 'time', 'board'],
  note: 'Deleting a map, timeline or board of a page whose Status is Authoritative needs canonical approval: it removes canonical content. Recommended; switch it off here if not wanted.',
});

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
  DEFAULT_DELETE_RULE,
  DEFAULT_DELETE_ARCHIVED_RULE,
  DEFAULT_DELETE_DOCUMENT_RULE,
]);

/** The Status agents' new pages get (C2b), unless the project says otherwise. */
export const DEFAULT_AGENT_STATUS = 'Working';

const text = (max: number) => z.string().trim().min(1).max(max);
const ruleId = text(64).regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters, digits, - or _');
const enabled = z.boolean().optional();

export const canonicalRuleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: ruleId,
      key: text(256),
      kind: z.literal('value'),
      values: z.array(text(256)).min(1).max(20),
      note: z.string().max(500).optional(),
      enabled,
    })
    .strict(),
  z
    .object({
      id: ruleId,
      key: text(256),
      kind: z.literal('change'),
      note: z.string().max(500).optional(),
      enabled,
    })
    .strict(),
  z
    .object({
      id: ruleId,
      key: text(256),
      kind: z.literal('delete'),
      values: z.array(text(256)).min(1).max(20),
      note: z.string().max(500).optional(),
      enabled,
    })
    .strict(),
  // v2 C2c (ADR 0035)
  z
    .object({
      id: ruleId,
      kind: z.literal('deleteKind'),
      kinds: z
        .array(z.enum(['bsrc', 'bwrk', 'barc']))
        .min(1)
        .max(3),
      note: z.string().max(500).optional(),
      enabled,
    })
    .strict(),
  z
    .object({
      id: ruleId,
      key: text(256),
      kind: z.literal('deleteDocument'),
      values: z.array(text(256)).min(1).max(20),
      documentTypes: z
        .array(z.enum(['page', 'map', 'time', 'board', 'blank']))
        .min(1)
        .max(5),
      note: z.string().max(500).optional(),
      enabled,
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
  /** Every rule, switched on or off (as the dashboard lists them). */
  readonly rules: readonly CanonicalRule[];
  /** v2 C2c: the rules that apply (`enabled` is not false): what every guard and tool judges by. */
  readonly active: readonly CanonicalRule[];
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
  const active = (rules: readonly CanonicalRule[]) => rules.filter((x) => x.enabled !== false);
  if (raw === undefined || raw === null)
    return {
      rules: DEFAULT_CANONICAL_RULES,
      active: active(DEFAULT_CANONICAL_RULES),
      defaults: true,
      agentDefaultStatus: status,
      problem: null,
    };
  const r = canonicalRulesSchema.safeParse(raw);
  if (!r.success) {
    return {
      rules: DEFAULT_CANONICAL_RULES,
      active: active(DEFAULT_CANONICAL_RULES),
      defaults: true,
      agentDefaultStatus: status,
      problem: `the stored canonical rules are not valid (${r.error.issues[0]?.message ?? 'invalid'}); the defaults apply`,
    };
  }
  const rules = r.data as CanonicalRule[];
  return { rules, active: active(rules), defaults: false, agentDefaultStatus: status, problem: null };
}

/** v2 C2c: the fact a rule names (`deleteKind` names none). */
export function ruleKey(rule: CanonicalRule): string | null {
  return 'key' in rule ? rule.key : null;
}

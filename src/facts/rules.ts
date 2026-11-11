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
  /**
   * C2d (ADR 0036 decision 7, the owner's): the lifecycle status tags (the lifecycle settings' CANON, Working and
   * Archived; compared without case and look-alikes folded) are added to or removed from a page only by the four
   * lifecycle tools and by the creation tools according to their `status`. `update_resource`, `updateResource` on any
   * route and a create body that adds one are refused (the lifecycle guard), naming the tool to use. Every other tag
   * stays free.
   */
  | { readonly id: string; readonly kind: 'statusTags'; readonly note?: string }
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

/** C2d (ADR 0036 decision 7, the owner's, 11 November 2026): the status tags are the lifecycle tools'. */
export const DEFAULT_STATUS_TAGS_RULE: CanonicalRule = Object.freeze({
  id: 'status-tags',
  kind: 'statusTags' as const,
  note: 'The status tags (CANON, Working, Archived, as the lifecycle settings name them) are added or removed only by the lifecycle tools and by creates according to their status; any other route is refused. Every other tag stays free.',
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
  DEFAULT_STATUS_TAGS_RULE,
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
  // C2d (ADR 0036 decision 7)
  z
    .object({
      id: ruleId,
      kind: z.literal('statusTags'),
      note: z.string().max(500).optional(),
      enabled,
    })
    .strict(),
]);

export const canonicalRulesSchema = z
  .array(canonicalRuleSchema)
  .max(50)
  .refine((l) => new Set(l.map((r) => r.id)).size === l.length, 'each rule id once');

/**
 * CR-2026-11 (CR-12): Cyrillic and Greek letters that look like Latin ones (after lower-casing), as Unicode's
 * confusables list (UTS #39) maps them, plus Cyrillic у, which reads as "u" as well as "y" (both are mapped to "u"
 * here: the fold only ever makes two keys or values that look alike compare equal).
 */
const LOOKALIKES: Readonly<Record<string, string>> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  һ: 'h',
  і: 'i',
  ї: 'i',
  ј: 'j',
  к: 'k',
  ӏ: 'l',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  ѕ: 's',
  т: 't',
  у: 'u',
  ү: 'y',
  х: 'x',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  ѵ: 'v',
  ɡ: 'g',
  α: 'a',
  β: 'b',
  ε: 'e',
  η: 'n',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ϲ: 'c',
  ϳ: 'j',
};
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'gu');

/**
 * Text as the rules compare it (CR-2026-11, CR-12): compatibility forms folded (NFKC: fullwidth letters, ligatures),
 * invisible characters removed (zero-width spaces and joiners, soft hyphens, byte-order marks: Unicode's
 * default-ignorable code points), trimmed, inner spaces collapsed, without case, and Cyrillic or Greek look-alikes read
 * as the Latin letters they look like. So a key or value LegendKeeper shows as "Status: Authoritative" is judged as
 * that, however it was spelt.
 */
function fold(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-GB')
    .replace(LOOKALIKE_RE, (c) => LOOKALIKES[c] ?? c);
}

/** A fact key as rules compare it (see `fold`). */
export function factKey(key: string): string {
  return fold(key);
}

/** A value as `value` rules compare it (see `fold`). */
export function factValueKey(value: string): string {
  return fold(value);
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

/** C2d: whether a project's status tags are guarded (the `statusTags` rule is listed and switched on). */
export function statusTagsGuarded(active: readonly CanonicalRule[]): boolean {
  return active.some((r) => r.kind === 'statusTags');
}

/** v2 C2c: the fact a rule names (`deleteKind` and `statusTags` name none). */
export function ruleKey(rule: CanonicalRule): string | null {
  return 'key' in rule ? rule.key : null;
}

/**
 * The audit rules and settings of one project (v2 E2, ADR 0044), as the owner edits them on the dashboard.
 *
 * A **rule** selects pages and names the template their sidebar and tabs follow. The old bridge selected by
 * `referenceType` (the one unambiguous Reference Type row), `namePrefix` and `ancestorName` (a unique ancestor by name,
 * following the parent chain); all the given selectors must match. v2 adds the registry: `registryType` (a type's
 * singular or plural name) with an optional `role` (`core`, `compact`, `index`…), and `kind`. A rule's template is a
 * registry role (`{ registry: { type, role } }`, resolved through the type registry), a template id, or a template name.
 *
 * Until the owner saves a list, the rules are the seeded defaults taken from the registry (Character Core, Compact
 * Character Reference, the Index template), worked out at each run so they follow the registry.
 */
import * as z from 'zod';
import type { RegistryType } from '../registry/index.js';

const text = (max: number) => z.string().trim().min(1).max(max);

export const SELECTOR_KEYS = [
  'referenceType',
  'registryType',
  'role',
  'namePrefix',
  'ancestorName',
  'kind',
] as const;

export const selectorsSchema = z
  .object({
    referenceType: text(200).optional(),
    registryType: text(100).optional(),
    role: text(60).optional(),
    namePrefix: z.string().min(1).max(100).optional(),
    ancestorName: text(200).optional(),
    kind: z.enum(['index', 'bsrc', 'bwrk', 'barc']).optional(),
  })
  .strict()
  .refine((s) => SELECTOR_KEYS.some((k) => s[k] !== undefined), 'a rule needs at least one selector')
  .refine((s) => s.role === undefined || s.registryType !== undefined, 'a role needs a registry type');

export const templateRefSchema = z
  .object({
    registry: z
      .object({ type: text(100), role: text(60) })
      .strict()
      .optional(),
    templateId: text(64).optional(),
    templateName: text(200).optional(),
  })
  .strict()
  .refine(
    (t) => [t.registry, t.templateId, t.templateName].filter((x) => x !== undefined).length === 1,
    'name the template one way: a registry role, an id, or a name',
  );

export const ruleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'a rule id is lower case letters, digits, - or _'),
    name: text(200),
    enabled: z.boolean().default(true),
    selectors: selectorsSchema,
    template: templateRefSchema,
  })
  .strict();

export type AuditRule = z.infer<typeof ruleSchema>;
export type RuleSelectors = z.infer<typeof selectorsSchema>;
export type RuleTemplate = z.infer<typeof templateRefSchema>;

export const tagSourceSchema = z.object({ pageId: text(64), documentId: text(64) }).strict();
export type TagSource = z.infer<typeof tagSourceSchema>;

const settingsShape = {
  /** `no_matching_rule` for pages no rule matches (the old bridge reported them). */
  reportUnmatched: z.boolean(),
  /** A full snapshot older than this is flagged (`stale_snapshot`); the nightly snapshot is 24 hours apart. */
  maxSnapshotAgeHours: z
    .number()
    .min(1)
    .max(24 * 30),
  /** Indexes whose children are in a manual order, left out of the ordering check (their page ids). */
  manualOrderIndexes: z.array(text(64)).max(200),
  /** Reference Types that are fine though the registry does not list them (General Source, Relationship…). */
  knownReferenceTypes: z.array(text(200)).max(200),
  /**
   * Off (default): only a Reference Type that resembles a registry value is flagged (`Character Reference` for
   * `Compact Character Reference`; see `resemblesRegistryValue` and docs/audits.md: the same words in other letters, the
   * page's name pattern, or a subset of a value's distinctive words). On: every value neither the registry nor the list
   * above knows is flagged.
   */
  strictReferenceTypes: z.boolean(),
  /**
   * v3 F4a (ADR 0063): external skill names the owner allowed (real skills used elsewhere): the governance check never
   * reports them again (`governance_external_name`). Compared without case.
   */
  governanceAllowedNames: z.array(z.string().trim().min(1).max(100)).max(500),
};

/** The settings as stored: every field present (a missing one takes its default). */
export const auditSettingsSchema = z
  .object({
    reportUnmatched: settingsShape.reportUnmatched.default(true),
    maxSnapshotAgeHours: settingsShape.maxSnapshotAgeHours.default(36),
    manualOrderIndexes: settingsShape.manualOrderIndexes.default([]),
    knownReferenceTypes: settingsShape.knownReferenceTypes.default([]),
    strictReferenceTypes: settingsShape.strictReferenceTypes.default(false),
    governanceAllowedNames: settingsShape.governanceAllowedNames.default([]),
  })
  .strict();
/** The settings as the dashboard sends them: any field may be left out (and is then kept, never reset). */
export const auditSettingsInputSchema = z.object(settingsShape).partial().strict();
export type AuditSettings = z.infer<typeof auditSettingsSchema>;

export const DEFAULT_AUDIT_SETTINGS: AuditSettings = Object.freeze({
  reportUnmatched: true,
  maxSnapshotAgeHours: 36,
  manualOrderIndexes: [],
  knownReferenceTypes: [],
  strictReferenceTypes: false,
  governanceAllowedNames: [],
});

/** What the dashboard saves: the rules (or null: back to the seeded defaults), the tag source and the settings. */
export const auditConfigInputSchema = z
  .object({
    rules: z
      .union([
        z
          .array(ruleSchema)
          .max(100)
          .refine((l) => new Set(l.map((r) => r.id)).size === l.length, 'each rule id once'),
        z.null(),
      ])
      .optional(),
    tagSource: z.union([tagSourceSchema, z.null()]).optional(),
    settings: auditSettingsInputSchema.optional(),
  })
  .strict();
export type AuditConfigInput = z.infer<typeof auditConfigInputSchema>;

export interface AuditConfig {
  /** The owner's rules, or null while the seeded defaults apply. */
  readonly rules: readonly AuditRule[] | null;
  readonly tagSource: TagSource | null;
  readonly settings: AuditSettings;
  readonly updatedAt: number | null;
  readonly updatedBy: string | null;
}

export const EMPTY_AUDIT_CONFIG: AuditConfig = Object.freeze({
  rules: null,
  tagSource: null,
  settings: DEFAULT_AUDIT_SETTINGS,
  updatedAt: null,
  updatedBy: null,
});

const typeLabel = (t: RegistryType) => t.singular;

/**
 * The seeded defaults, from the registry: for each character type its Core rule and its Compact Character Reference
 * rule; and the Index template rule from the first type that names an index template. Nothing is invented: a type with
 * no template for a role gets no rule for it.
 */
export function defaultRules(types: readonly RegistryType[]): AuditRule[] {
  const out: AuditRule[] = [];
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'type';
  for (const t of types) {
    if (t.placementKind !== 'character' || !t.placement) continue;
    for (const [role, label] of [
      ['core', 'Character Core'],
      ['compact', 'Compact Character Reference'],
    ] as const) {
      const tpl = t.pageTemplates.find((p) => p.role === role);
      if (!tpl?.templateId) continue;
      out.push({
        id: `${slug(typeLabel(t))}-${role}`,
        name: `${typeLabel(t)}: ${label}`,
        enabled: true,
        selectors: { registryType: t.singular, role },
        template: { registry: { type: t.singular, role } },
      });
    }
  }
  const withIndex = types.find((t) => t.indexTemplateId);
  if (withIndex) {
    out.push({
      id: 'index',
      name: 'Index pages',
      enabled: true,
      selectors: { kind: 'index' },
      template: { registry: { type: withIndex.singular, role: 'index' } },
    });
  }
  return out;
}

/** The rules a run uses: the owner's list, or the seeded defaults. */
export function effectiveRules(cfg: AuditConfig, types: readonly RegistryType[]): AuditRule[] {
  return cfg.rules ? [...cfg.rules] : defaultRules(types);
}

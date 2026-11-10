/**
 * Shared types of the type registry, taxonomy, name resolution, ordering and character placement (v2 A3,
 * docs/registry.md, ADR 0026).
 */
import * as z from 'zod';
import type { NodeKind, TreeMeta } from '../tree/index.js';

// ============================================================================================== errors

export type RegistryErrorCode =
  | 'NOT_OWNER'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'NAME_TAKEN'
  | 'NAME_CLASH'
  | 'TYPE_EXISTS'
  | 'ALREADY_SEEDED'
  | 'NOT_SEEDED'
  | 'HAS_CHILDREN'
  | 'TREE_NOT_READY'
  | 'UNKNOWN_TYPE'
  | 'SCOPE_NOT_FOUND'
  | 'OUT_OF_SCOPE'
  | 'AMBIGUOUS'
  | 'NOT_IN_TREE'
  | 'TYPE_ROOT_MISSING'
  | 'NO_CHARACTER_TYPE'
  | 'CHARACTER_TYPE_AMBIGUOUS'
  | 'UNKNOWN_INDEX_MISSING'
  | 'UNKNOWN_INDEX_AMBIGUOUS'
  | 'RACE_NOT_FOUND'
  | 'RACE_AMBIGUOUS'
  | 'RACE_NEEDS_REVIEW'
  | 'RACE_SOURCE_MISSING'
  | 'CHARACTER_INDEX_AMBIGUOUS'
  | 'EXISTING_PAGE_AMBIGUOUS'
  | 'TEMPLATE_NOT_CONFIGURED'
  | 'TEMPLATES_UNREADABLE';

/** Every refusal of the registry, resolver and planners: a code, a plain-language message, and details. */
export class RegistryError extends Error {
  override readonly name = 'RegistryError';
  constructor(
    readonly code: RegistryErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

// ============================================================================================== review

export interface ReviewReason {
  /** For example `singular_guess`, `deep`, `empty`, `unread`, `duplicate_name`, `not_found`. */
  readonly code: string;
  readonly message: string;
}

export type ReviewStatus = 'ok' | 'needs_review';

// ============================================================================================== types

export type PlacementKind = 'character' | 'generic';

/** The settings of the `character` placement rule (PLAN-v2 section 9). Data, so nothing is fixed in code. */
export interface CharacterPlacementConfig {
  /** The index unknown races go to, directly under the type root. */
  readonly unknownIndexName: string;
  /** Race values that mean "unknown" (compared without case; blank and null always do). */
  readonly unknownRaceValues: readonly string[];
  /** What Race / Species is set to for an unknown race. */
  readonly unknownSpeciesValue: string;
  /** The Reference Type of each kind of character page. */
  readonly referenceTypes: { readonly core: string; readonly compact: string };
  /** The PROPERTIES row naming a page's subject (else its display name before " - "). */
  readonly subjectRow: string;
  /** The PROPERTIES row the species value is written to. */
  readonly speciesRow: string;
  /** New page names, `{name}` being the character's name, without the `[BSRC] ` prefix. */
  readonly pageNames: { readonly core: string; readonly compact: string };
}

export const DEFAULT_CHARACTER_PLACEMENT: CharacterPlacementConfig = Object.freeze({
  unknownIndexName: 'Undetermined / Unknown',
  unknownRaceValues: ['Unknown', 'Undetermined', 'Unestablished', 'Undetermined / Unknown'],
  unknownSpeciesValue: 'Unestablished',
  referenceTypes: { core: 'Character Core', compact: 'Compact Character Reference' },
  subjectRow: 'Subject',
  speciesRow: 'Race / Species',
  pageNames: { core: '{name}', compact: '{name}' },
});

export interface PageTemplate {
  /** A short role name, for example `core` or `compact`. */
  readonly role: string;
  readonly templateId: string | null;
}

/** The versioned recipe a type will grow into (PLAN-v2 10.2). Empty in v2. */
export interface Recipe {
  readonly version: 1;
  readonly [key: string]: unknown;
}

export interface RegistryType {
  readonly id: string;
  readonly projectId: string;
  readonly singular: string;
  readonly plural: string;
  readonly rootIndexId: string | null;
  readonly indexTemplateId: string | null;
  readonly pageTemplates: readonly PageTemplate[];
  readonly assetRootFolder: string | null;
  readonly placementKind: PlacementKind;
  /** Only for `character`; the defaults filled in. */
  readonly placement: CharacterPlacementConfig | null;
  readonly recipe: Recipe;
  readonly packId: string | null;
  readonly status: ReviewStatus;
  readonly review: readonly ReviewReason[];
  readonly notes: string;
  readonly taxonomySeededAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TaxonomyEntry {
  readonly id: string;
  readonly projectId: string;
  readonly typeId: string;
  readonly plural: string;
  readonly singular: string;
  readonly singularSource: 'list' | 'rule' | 'owner';
  readonly parentId: string | null;
  readonly aliases: readonly string[];
  readonly sourceNodeId: string;
  readonly sourceParentNodeId: string | null;
  readonly assetFolder: string;
  readonly status: ReviewStatus;
  readonly review: readonly ReviewReason[];
  readonly notes: string;
  readonly origin: 'seed' | 'add_missing';
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TemplateInfo {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
}

export interface TemplatesSnapshot {
  readonly templates: readonly TemplateInfo[];
  readonly readAt: number | null;
  readonly error: string | null;
}

// ============================================================================================== tree-facing views

/** A node as the resolver, planners and reports show it: enough to tell candidates apart. */
export interface NodeRef {
  readonly id: string;
  readonly rawName: string;
  readonly displayName: string;
  readonly kind: NodeKind;
  /** Display names from the root down to the node, joined with " / ". */
  readonly path: string;
}

export type ResolveKind = 'index' | 'bsrc' | 'unclassified';
export type MatchField = 'id' | 'raw' | 'display' | 'alias' | 'canonical';

export type ResolveScope = { readonly under: string } | { readonly type: string };

export interface ResolveOptions {
  readonly scope?: ResolveScope | undefined;
  readonly kinds?: readonly ResolveKind[] | undefined;
}

export type ResolveResult =
  | {
      readonly status: 'resolved';
      readonly node: NodeRef;
      readonly matchedBy: MatchField;
      readonly query: string;
      readonly cleaned: string;
      readonly tree: TreeMeta;
    }
  | {
      readonly status: 'ambiguous';
      readonly candidates: readonly (NodeRef & { readonly matchedBy: MatchField })[];
      readonly query: string;
      readonly cleaned: string;
      readonly tree: TreeMeta;
    }
  | {
      readonly status: 'not_found';
      /** Up to 10 near names, purely as a hint: never used to decide anything. */
      readonly near: readonly NodeRef[];
      readonly query: string;
      readonly cleaned: string;
      readonly tree: TreeMeta;
    };

/** Where a new or moved page goes among its siblings: one neighbour, or nothing for an empty parent. */
export interface Slot {
  readonly after?: string;
  readonly before?: string;
}

// ============================================================================================== input schemas

const text = (max: number) => z.string().trim().min(1).max(max);
const nodeId = z.string().trim().min(1).max(64);
const role = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{0,39}$/, 'a role is lowercase letters, digits, - or _, starting with a letter');

export const characterPlacementSchema = z
  .object({
    unknownIndexName: text(200),
    unknownRaceValues: z.array(text(200)).max(20),
    unknownSpeciesValue: text(200),
    referenceTypes: z.object({ core: text(200), compact: text(200) }).strict(),
    subjectRow: text(200),
    speciesRow: text(200),
    pageNames: z
      .object({
        core: text(200).refine((s) => s.includes('{name}'), 'must contain {name}'),
        compact: text(200).refine((s) => s.includes('{name}'), 'must contain {name}'),
      })
      .strict(),
  })
  .partial()
  .strict();

export const typeInputSchema = z
  .object({
    singular: text(100),
    plural: text(100),
    rootIndexId: nodeId.nullable().optional(),
    indexTemplateId: nodeId.nullable().optional(),
    pageTemplates: z
      .array(z.object({ role, templateId: nodeId.nullable() }).strict())
      .max(20)
      .refine((l) => new Set(l.map((t) => t.role)).size === l.length, 'each role once')
      .optional(),
    assetRootFolder: text(200).nullable().optional(),
    placementKind: z.enum(['character', 'generic']).optional(),
    placement: characterPlacementSchema.optional(),
    notes: z.string().max(4000).optional(),
    /** Marks the type as reviewed: status `ok`, review reasons cleared. */
    reviewed: z.literal(true).optional(),
  })
  .strict();
export type TypeInput = z.infer<typeof typeInputSchema>;
export const typeUpdateSchema = typeInputSchema.partial().strict();
export type TypeUpdate = z.infer<typeof typeUpdateSchema>;

export const entryUpdateSchema = z
  .object({
    singular: text(100).optional(),
    aliases: z
      .array(text(200))
      .max(50)
      .refine((l) => new Set(l.map((a) => a.toLowerCase())).size === l.length, 'each alias once')
      .optional(),
    assetFolder: text(200).optional(),
    parentId: z.string().trim().min(1).max(64).nullable().optional(),
    notes: z.string().max(4000).optional(),
    reviewed: z.literal(true).optional(),
  })
  .strict();
export type EntryUpdate = z.infer<typeof entryUpdateSchema>;

/** Overrides for the Character seed; every field defaults to the old bridge's conventions (seed-data.ts). */
export const characterSeedSchema = z
  .object({
    singular: text(100),
    plural: text(100),
    rootIndexName: text(200),
    indexTemplateName: text(200),
    pageTemplates: z.array(z.object({ role, templateName: text(200) }).strict()).max(20),
    assetRootFolder: text(200),
    refreshTemplates: z.boolean(),
  })
  .partial()
  .strict();
export type CharacterSeedInput = z.infer<typeof characterSeedSchema>;

export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input ?? {});
  if (r.success) return r.data;
  throw new RegistryError(
    'INVALID_INPUT',
    r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
  );
}

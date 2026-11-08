/** Repository Mappings data model (chunk 6, docs/mappings.md). Data and CRUD only: there is no inference engine. */
import * as z from 'zod';

export const EXPECTED_KINDS = [
  'text',
  'number',
  'resource_link',
  'list',
  'date',
  'boolean',
  'image',
  'other',
] as const;
export type ExpectedKind = (typeof EXPECTED_KINDS)[number];

/** Suggested semantic types for the forms. The names are free text: any type the repository needs is allowed. */
export const SUGGESTED_TYPES = ['Character', 'Nation', 'Species', 'Institution', 'Place', 'Class'] as const;

const noControl = /^[^\u0000-\u001f\u007f]*$/;
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Required')
    .max(max, `At most ${max} characters`)
    .regex(noControl, 'No control characters');
const longText = z.string().max(5000, 'At most 5000 characters').default('');

export const selectorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('subtree'),
    /** The root of the subtree: a resource id. */
    resourceId: line(256),
    /** True: the resource and everything below it. False: the resource alone. */
    descendants: z.boolean().default(true),
  }),
  z.object({ kind: z.literal('template'), templateId: line(256) }),
  z.object({ kind: z.literal('tag'), tag: line(100) }),
]);
export type Selector = z.infer<typeof selectorSchema>;

export const locationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sidebar_property'), title: line(256) }),
  z.object({ kind: z.literal('infobox_row'), infoboxTitle: line(256), rowKey: line(256) }),
  z
    .object({ kind: z.literal('block'), heading: line(500).optional(), blockId: line(256).optional() })
    .refine((v) => (v.heading === undefined) !== (v.blockId === undefined), {
      message: 'Give either a heading text or a block id, not both and not neither',
    }),
]);
export type Location = z.infer<typeof locationSchema>;

export const setInputSchema = z.object({
  name: line(120),
  description: longText,
  notes: longText,
});
export type SetInput = z.infer<typeof setInputSchema>;

export const ruleInputSchema = z.object({
  selector: selectorSchema,
  semanticType: line(80),
  priority: z.number().int().min(-1000).max(1000).default(0),
  notes: longText,
});
export type RuleInput = z.infer<typeof ruleInputSchema>;

export const fieldInputSchema = z.object({
  semanticType: line(80),
  fieldName: line(120),
  location: locationSchema,
  expectedKind: z.enum(EXPECTED_KINDS),
  notes: longText,
});
export type FieldInput = z.infer<typeof fieldInputSchema>;

export interface MappingSet {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly notes: string;
  readonly active: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TypeRule extends RuleInput {
  readonly id: string;
  readonly setId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface FieldMap extends FieldInput {
  readonly id: string;
  readonly setId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SetSummary extends MappingSet {
  readonly ruleCount: number;
  readonly fieldCount: number;
}

export interface SetDetail {
  readonly set: MappingSet;
  readonly rules: TypeRule[];
  readonly fields: FieldMap[];
  /** A readable account of the whole set (see `summarise`). */
  readonly summary: SetSummaryText;
}

export interface SetSummaryText {
  readonly headline: string;
  readonly types: {
    readonly semanticType: string;
    readonly rules: string[];
    readonly fields: string[];
  }[];
  /** Things worth a second look: overlapping rules with equal priority, types with rules but no fields. */
  readonly warnings: string[];
}

export type MappingErrorCode =
  'NOT_FOUND' | 'INVALID_INPUT' | 'NAME_TAKEN' | 'DUPLICATE_FIELD' | 'INVALID_IMPORT' | 'NOT_OWNER';

export class MappingError extends Error {
  constructor(
    readonly code: MappingErrorCode,
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'MappingError';
  }
}

/** Turns a zod failure into a MappingError that names the fields. */
export function parseOrThrow<T>(
  schema: z.ZodType<T>,
  data: unknown,
  code: MappingErrorCode = 'INVALID_INPUT',
): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`);
  throw new MappingError(code, issues.join('; '), issues);
}

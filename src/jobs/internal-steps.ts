/**
 * The bridge's own steps for multi-step writes (v2 C2a, ADR 0032). They are not LegendKeeper operations: only bridge
 * code puts them in a job (`BatchSubmit.internal: true`; `lk_api_batch` never does), and both only READ.
 *
 * - `bridge.expect`, the compare-and-swap inside the lock (PLAN-v2 10.6): before the first write, re-reads every
 *   property the plan will change and compares it with the state the plan was built on. Any difference is a conflict
 *   and nothing is written. It returns the version each read gave, so the first versioned write can chain from it
 *   (`ifMatchFrom`).
 * - `bridge.verify`, the generic verify step (PLAN-v2 10.2): after the writes, re-reads each target (a page's
 *   blocks, a sidebar, a resource's fields) and compares it with the planned state. A difference is recorded on the
 *   step, the job, the errors table and (for an approved proposal) the proposal: "written but not as planned". It
 *   never fails the job and never retries anything.
 *
 * Both are put to the policy gate as reads, and each is covered by an approval token like any other step.
 */
import * as z from 'zod';
import type { PolicyOpMeta } from './policy.js';
import type { CollectionState, RowState, SidebarPropertyState, StateDifference } from './sidebar-state.js';
import type { StepOptions } from './types.js';

export const EXPECT_STEP = 'bridge.expect';
export const VERIFY_STEP = 'bridge.verify';
export const INTERNAL_STEPS: ReadonlySet<string> = new Set([EXPECT_STEP, VERIFY_STEP]);

export function isInternalStep(op: string): boolean {
  return INTERNAL_STEPS.has(op);
}

const id = z.string().min(1).max(256);
const label = z.string().min(1).max(300);
const runs = z.array(z.record(z.string(), z.unknown())).max(10_000);
// `rank` is optional: an expectation stored before ranks were kept has none and is still compared by id.
const rowState = z
  .object({ id: id.nullable(), rank: id.nullable().optional(), key: z.string().max(2048), content: runs })
  .strict();
const itemState = z.object({ id: id.nullable(), resourceId: id, documentId: id.nullable() }).strict();
const collectionState = z.object({ items: z.array(itemState).max(256), filter: z.unknown() }).strict();

const propertyCheck = z
  .object({
    label,
    kind: z.enum(['propertyRows', 'collection']),
    resourceId: id,
    propertyId: id,
    rows: z.array(rowState).max(256).optional(),
    collection: collectionState.optional(),
    /** The version the plan saw, compared only when the read in the lock gives one of the same kind. */
    version: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine((c) => (c.kind === 'propertyRows' ? c.rows !== undefined : c.collection !== undefined), {
    message: 'a propertyRows check needs rows; a collection check needs collection',
  });

/** One property of a template, as a copy of it must show it (v2 C2b): its ids are the template's. */
const templateProperty = z
  .object({
    id,
    kind: z.string().min(1).max(64),
    title: z.string().max(256),
    rows: z
      .array(z.object({ id, key: z.string().max(2048), content: runs }).strict())
      .max(256)
      .optional(),
    items: z.array(id).max(256).optional(),
  })
  .strict();

/**
 * v2 C2b: a page the same job just created from a template. Its sidebar is read in the lock and matched to the template's
 * (properties by kind and title in order, rows by key and value in rank order, items in order); anything else is a
 * conflict. The step's result maps each template id to the copy's (`ids`), for `bindIds`.
 */
const copyCheck = z
  .object({
    label,
    kind: z.literal('copy'),
    resourceId: id,
    templateId: id,
    properties: z.array(templateProperty).max(50),
  })
  .strict();

const sidebarProperty = z
  .object({
    id: z.string().max(256),
    kind: z.string().max(64),
    title: z.string().max(256),
    rows: z.array(rowState).max(256).optional(),
    collection: collectionState.optional(),
  })
  .strict();

/**
 * v2 C2b: the WHOLE sidebar must still be the state the plan was built on (`baseFactsVersion`). `directOnly`: a direct
 * write only; a proposal's own capture state protects it afterwards, so capture leaves the check out.
 */
const sidebarCheck = z
  .object({
    label,
    kind: z.literal('sidebar'),
    resourceId: id,
    factsVersion: z.string().min(1).max(64),
    properties: z.array(sidebarProperty).max(50),
    directOnly: z.boolean().optional(),
  })
  .strict();

export const expectCheckSchema = z.union([propertyCheck, copyCheck, sidebarCheck]);

export const expectParamsSchema = z
  .object({ body: z.object({ checks: z.array(expectCheckSchema).min(1).max(50) }).strict() })
  .strict();

const expectedProperty = z
  .object({
    id,
    title: z.string().max(256),
    rows: z.array(rowState).max(256).optional(),
    collection: collectionState.optional(),
  })
  .strict();

export const verifyTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('sidebar'),
      label,
      resourceId: id,
      properties: z.array(expectedProperty).max(50),
    })
    .strict(),
  z
    .object({
      kind: z.literal('blocks'),
      label,
      resourceId: id,
      documentId: id,
      blocks: z.array(z.unknown()),
    })
    .strict(),
  z
    .object({
      kind: z.literal('resource'),
      label,
      resourceId: id,
      fields: z.record(z.string(), z.unknown()),
      /** v2 C2b: where the page must stand among its siblings (listed by rank): its neighbours, null for none. */
      placement: z
        .object({
          parentId: id,
          after: id.nullable().optional(),
          before: id.nullable().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  // v2 C2b: a page's facts by key and value in rank order, and its collections' pages in order, without ids (a page the
  // job created has ids the plan could not know).
  z
    .object({
      kind: z.literal('facts'),
      label,
      resourceId: id,
      property: z
        .object({
          title: z.string().max(256),
          rows: z.array(z.object({ key: z.string().max(2048), content: runs }).strict()).max(256),
        })
        .strict()
        .optional(),
      collections: z
        .array(
          z
            .object({
              title: z.string().max(256),
              items: z.array(z.object({ resourceId: id, documentId: id.nullable() }).strict()).max(256),
            })
            .strict(),
        )
        .max(50)
        .optional(),
    })
    .strict(),
  // v2 C2b: a resource that must be gone (deleted).
  z.object({ kind: z.literal('gone'), label, resourceId: id }).strict(),
  // v2 C2b: one document of a page, by id or by name and type (a document the job created), or gone.
  z
    .object({
      kind: z.literal('document'),
      label,
      resourceId: id,
      documentId: id.optional(),
      match: z
        .object({ name: z.string().min(1).max(500), type: z.string().min(1).max(32) })
        .strict()
        .optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
      gone: z.boolean().optional(),
    })
    .strict(),
]);

export const verifyParamsSchema = z
  .object({ body: z.object({ targets: z.array(verifyTargetSchema).min(1).max(400) }).strict() })
  .strict();

export type ExpectCheck =
  | {
      readonly label: string;
      readonly kind: 'propertyRows' | 'collection';
      readonly resourceId: string;
      readonly propertyId: string;
      readonly rows?: readonly RowState[];
      readonly collection?: CollectionState;
      readonly version?: string;
    }
  | CopyCheck
  | SidebarCheck;

/** One property of a template as its copy must show it (ids are the template's). */
export interface TemplateProperty {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly rows?: readonly {
    readonly id: string;
    readonly key: string;
    readonly content: readonly Record<string, unknown>[];
  }[];
  readonly items?: readonly string[];
}

export interface CopyCheck {
  readonly label: string;
  readonly kind: 'copy';
  readonly resourceId: string;
  readonly templateId: string;
  readonly properties: readonly TemplateProperty[];
}

export interface SidebarCheck {
  readonly label: string;
  readonly kind: 'sidebar';
  readonly resourceId: string;
  readonly factsVersion: string;
  readonly properties: readonly SidebarPropertyState[];
  readonly directOnly?: boolean;
}

export interface ExpectedProperty {
  readonly id: string;
  readonly title: string;
  readonly rows?: readonly RowState[];
  readonly collection?: CollectionState;
}

export type VerifyTarget =
  | {
      readonly kind: 'sidebar';
      readonly label: string;
      readonly resourceId: string;
      readonly properties: readonly ExpectedProperty[];
    }
  | {
      readonly kind: 'blocks';
      readonly label: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly blocks: readonly unknown[];
    }
  | {
      readonly kind: 'resource';
      readonly label: string;
      readonly resourceId: string;
      readonly fields: Readonly<Record<string, unknown>>;
      readonly placement?: {
        readonly parentId: string;
        readonly after?: string | null;
        readonly before?: string | null;
      };
    }
  | {
      readonly kind: 'facts';
      readonly label: string;
      readonly resourceId: string;
      readonly property?: {
        readonly title: string;
        readonly rows: readonly {
          readonly key: string;
          readonly content: readonly Record<string, unknown>[];
        }[];
      };
      readonly collections?: readonly {
        readonly title: string;
        readonly items: readonly { readonly resourceId: string; readonly documentId: string | null }[];
      }[];
    }
  | { readonly kind: 'gone'; readonly label: string; readonly resourceId: string }
  | {
      readonly kind: 'document';
      readonly label: string;
      readonly resourceId: string;
      readonly documentId?: string;
      readonly match?: { readonly name: string; readonly type: string };
      readonly fields?: Readonly<Record<string, unknown>>;
      readonly gone?: boolean;
    };

/** The params of an internal step: `{ body: { checks } }` or `{ body: { targets } }`. */
export function expectStep(checks: readonly ExpectCheck[], options: StepOptions = {}) {
  return { op: EXPECT_STEP, params: { body: { checks } }, ...options };
}

export function verifyStep(targets: readonly VerifyTarget[], options: StepOptions = {}) {
  return { op: VERIFY_STEP, params: { body: { targets } }, ...options };
}

/** Validates an internal step's params. Returns the issues, or an empty list. */
export function internalStepIssues(op: string, params: unknown): { path: string; message: string }[] {
  const schema = op === EXPECT_STEP ? expectParamsSchema : op === VERIFY_STEP ? verifyParamsSchema : null;
  if (!schema) return [{ path: 'op', message: `${op} is not one of the bridge's own steps` }];
  const r = schema.safeParse(params);
  return r.success
    ? []
    : r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

/** What the policy gate is told about an internal step: a read, safe, with no lock. */
export function internalPolicyMeta(op: string, options: StepOptions): PolicyOpMeta {
  return {
    operationId: op,
    kind: 'read',
    method: 'GET',
    tag: 'Bridge',
    risk: 'safe',
    concurrency: 'none',
    versioned: false,
    paged: false,
    options,
  };
}

/** Reads an internal step makes, for estimates: one per check or target (a placement check adds one listing). */
export function internalReads(op: string, params: unknown): number {
  const body = (params as { body?: { checks?: unknown[]; targets?: unknown[] } } | undefined)?.body;
  if (op === EXPECT_STEP) return body?.checks?.length ?? 1;
  const targets = (body?.targets ?? []) as { placement?: unknown }[];
  return Math.max(1, targets.length + targets.filter((t) => t && t.placement !== undefined).length);
}

/** v2 C2b: a sidebar check that guards a direct write only (`directOnly`); proposals leave it out at capture. */
export function withoutDirectOnlyChecks(params: unknown): unknown {
  const body = (params as { body?: { checks?: unknown[] } } | undefined)?.body;
  if (!body || !Array.isArray(body.checks)) return params;
  const checks = body.checks.filter((c) => !(c && (c as { directOnly?: unknown }).directOnly === true));
  return { ...(params as object), body: { ...body, checks } };
}

/** The result of a verify step, recorded on the step and gathered on the job. */
export interface TargetVerification {
  readonly label: string;
  readonly kind: VerifyTarget['kind'];
  readonly status: 'verified' | 'mismatch' | 'not_checked';
  readonly differences?: readonly StateDifference[];
  readonly differenceCount?: number;
  readonly reason?: string;
  /** v2 C2b: a sidebar or facts target's page, as read back: its `factsVersion` after the writes. */
  readonly factsVersion?: string;
}

/** What the generic verify step may ignore, by target kind (listed in every verification). */
export const SIDEBAR_IGNORED_FIELDS: readonly string[] = [
  'rank and text of a row (the order of the rows, and the runs, are compared)',
  'name in a mention (read-only: the page’s current name)',
  'runs normalised as LegendKeeper does on write (empty text runs dropped, neighbouring runs with the same marks merged)',
  'the id LegendKeeper gives a row or item the bridge created',
  'properties the plan did not name',
];

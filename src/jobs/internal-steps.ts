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
import type { CollectionState, RowState, StateDifference } from './sidebar-state.js';
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

export const expectCheckSchema = z
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
    .object({ kind: z.literal('resource'), label, resourceId: id, fields: z.record(z.string(), z.unknown()) })
    .strict(),
]);

export const verifyParamsSchema = z
  .object({ body: z.object({ targets: z.array(verifyTargetSchema).min(1).max(100) }).strict() })
  .strict();

export type ExpectCheck = {
  readonly label: string;
  readonly kind: 'propertyRows' | 'collection';
  readonly resourceId: string;
  readonly propertyId: string;
  readonly rows?: readonly RowState[];
  readonly collection?: CollectionState;
  readonly version?: string;
};

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

/** Reads an internal step makes, for estimates: one per check or target. */
export function internalReads(op: string, params: unknown): number {
  const body = (params as { body?: { checks?: unknown[]; targets?: unknown[] } } | undefined)?.body;
  return op === EXPECT_STEP ? (body?.checks?.length ?? 1) : (body?.targets?.length ?? 1);
}

/** The result of a verify step, recorded on the step and gathered on the job. */
export interface TargetVerification {
  readonly label: string;
  readonly kind: VerifyTarget['kind'];
  readonly status: 'verified' | 'mismatch' | 'not_checked';
  readonly differences?: readonly StateDifference[];
  readonly differenceCount?: number;
  readonly reason?: string;
}

/** What the generic verify step may ignore, by target kind (listed in every verification). */
export const SIDEBAR_IGNORED_FIELDS: readonly string[] = [
  'rank and text of a row (the order of the rows, and the runs, are compared)',
  'name in a mention (read-only: the page’s current name)',
  'runs normalised as LegendKeeper does on write (empty text runs dropped, neighbouring runs with the same marks merged)',
  'the id LegendKeeper gives a row or item the bridge created',
  'properties the plan did not name',
];

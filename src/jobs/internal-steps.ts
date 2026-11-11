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
/**
 * v2 C2c (ADR 0035): the lifecycle record, written by the change's own job: `begin` (incomplete) when it starts and
 * `complete` at its end. It reads nothing from LegendKeeper and writes only the bridge's own database, through a handler
 * the lifecycle module registers (`engine.registerRecordHandler`).
 */
export const RECORD_STEP = 'bridge.record';
export const INTERNAL_STEPS: ReadonlySet<string> = new Set([EXPECT_STEP, VERIFY_STEP, RECORD_STEP]);

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

/**
 * v2 C2c: a page's own fields must still be what the plan saw (name, parent, tags: each compared when given), read with
 * `getResource`.
 */
const resourceCheck = z
  .object({
    label,
    kind: z.literal('resource'),
    resourceId: id,
    name: z.string().max(500).optional(),
    parentId: id.nullable().optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
  })
  .strict();

/** v2 C2c: the pages directly under a page must be exactly these (none, for archive_page). */
const childrenCheck = z
  .object({ label, kind: z.literal('children'), resourceId: id, ids: z.array(id).max(1000) })
  .strict();

/**
 * C2d (ADR 0037; ADR 0036 decision 5): the WHOLE set under a page must still be exactly the pages the plan captured:
 * every page under `resourceId` (not the page itself), each under the same parent, with the same name and tags (each
 * compared when given). A page added, gone or moved, renamed or retagged is a conflict and nothing is written.
 */
const subtreeCheck = z
  .object({
    label,
    kind: z.literal('subtree'),
    resourceId: id,
    pages: z
      .array(
        z
          .object({
            id,
            parentId: id.nullable(),
            name: z.string().max(500).optional(),
            tags: z.array(z.string().max(100)).max(50).optional(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

/**
 * v2 C2c: one block of a document: `first` (it is still the document's first block), `content` (it is still exactly
 * this block, compared as C1's verify compares blocks), or `absent` (no such block); `empty`: the document has no
 * blocks at all (a note then goes in as its only block).
 */
const blockCheck = z
  .object({
    label,
    kind: z.literal('block'),
    resourceId: id,
    documentId: id,
    blockId: id.nullable(),
    first: z.boolean().optional(),
    content: z.record(z.string(), z.unknown()).optional(),
    absent: z.boolean().optional(),
    empty: z.boolean().optional(),
  })
  .strict();

/**
 * v2 D1 (ADR 0038): a whole document, read inside the lock and judged by a checker the bridge registered by name
 * (`engine.registerChecker`): the chronology's table and Main checks. The checker gets the document as it is now and
 * the plan's `input`, and answers the differences (a conflict: nothing is written) and the bodies of the writes that
 * follow, worked out from the document as it is now (`bindBody`). The step's `versions[label]` is the document's version.
 */
const documentCheck = z
  .object({
    label,
    kind: z.literal('document'),
    resourceId: id,
    documentId: id,
    checker: z.string().min(1).max(100),
    input: z.unknown(),
  })
  .strict();

/** v2 D1: one timeline event, present with these fields (each compared when given) or absent. */
const eventCheck = z
  .object({
    label,
    kind: z.literal('event'),
    resourceId: id,
    documentId: id,
    eventId: id,
    present: z.boolean(),
    fields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** v2 D1: one lane of a timeline, present (with this name, when given). */
const laneCheck = z
  .object({
    label,
    kind: z.literal('lane'),
    resourceId: id,
    documentId: id,
    laneId: id,
    name: z.string().max(500).optional(),
  })
  .strict();

export const expectCheckSchema = z.union([
  propertyCheck,
  copyCheck,
  sidebarCheck,
  resourceCheck,
  childrenCheck,
  subtreeCheck,
  blockCheck,
  documentCheck,
  eventCheck,
  laneCheck,
]);

// C2d: a whole set checks up to a hundred pages' rows and notes in one step (it was 50).
export const expectParamsSchema = z
  .object({ body: z.object({ checks: z.array(expectCheckSchema).min(1).max(400) }).strict() })
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
  // v2 C2c: one block of a document: present with exactly this content (and first, when asked), or absent.
  z
    .object({
      kind: z.literal('block'),
      label,
      resourceId: id,
      documentId: id,
      blockId: id,
      present: z.boolean(),
      content: z.record(z.string(), z.unknown()).optional(),
      first: z.boolean().optional(),
    })
    .strict(),
  // v2 D1: a document read back and judged by a registered checker (the chronology's row and count).
  z
    .object({
      kind: z.literal('checked'),
      label,
      resourceId: id,
      documentId: id,
      checker: z.string().min(1).max(100),
      input: z.unknown(),
      /** The input is what an earlier `bridge.expect` step worked out inside the lock (`bodies[key]`). */
      inputFrom: z
        .object({ step: z.number().int().min(1), key: z.string().min(1).max(200) })
        .strict()
        .optional(),
    })
    .strict(),
  // v2 D1: one lane of a timeline, present with this name.
  z
    .object({
      kind: z.literal('lane'),
      label,
      resourceId: id,
      documentId: id,
      laneId: id,
      name: z.string().max(500).optional(),
    })
    .strict(),
  // v2 D1: one timeline event, present with these fields, or gone.
  z
    .object({
      kind: z.literal('event'),
      label,
      resourceId: id,
      documentId: id,
      eventId: id,
      present: z.boolean(),
      fields: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
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

/** v2 C2c: `bridge.record`'s params: the action and what the handler needs (checked by the handler itself). */
export const recordParamsSchema = z
  .object({
    body: z
      .object({
        // C2d: `begin_set` / `complete_set`, a whole set's record and its pages' records together.
        action: z.enum(['begin', 'complete', 'begin_set', 'complete_set']),
        record: z.record(z.string(), z.unknown()),
        /** v2 D1: which record (`lifecycle`, the default, or `chronology`). */
        store: z.enum(['lifecycle', 'chronology']).optional(),
      })
      .strict(),
  })
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
  | SidebarCheck
  | ResourceCheck
  | ChildrenCheck
  | SubtreeCheck
  | BlockCheck
  | DocumentCheck
  | EventCheck
  | LaneCheck;

/** v2 D1: a whole document judged by a registered checker. */
export interface DocumentCheck {
  readonly label: string;
  readonly kind: 'document';
  readonly resourceId: string;
  readonly documentId: string;
  readonly checker: string;
  readonly input: unknown;
}

/** v2 D1: one timeline event. */
export interface EventCheck {
  readonly label: string;
  readonly kind: 'event';
  readonly resourceId: string;
  readonly documentId: string;
  readonly eventId: string;
  readonly present: boolean;
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** v2 D1: one lane of a timeline. */
export interface LaneCheck {
  readonly label: string;
  readonly kind: 'lane';
  readonly resourceId: string;
  readonly documentId: string;
  readonly laneId: string;
  readonly name?: string;
}

/** v2 D1: what a document checker gets: the document as read inside the lock, and the plan's input. */
export interface DocumentCheckContext {
  readonly projectId: string;
  readonly jobId: string;
  readonly stepNo: number;
  readonly label: string;
  readonly input: unknown;
  readonly document: { readonly version: string | null; readonly blocks: readonly unknown[] };
}

/** A document checker's answer: differences (a conflict), and write bodies by key for `bindBody`. */
export interface DocumentCheckResult {
  readonly differences: readonly StateDifference[];
  readonly bodies?: Readonly<Record<string, unknown>>;
  /** What the checker saw, kept in the step's result (`observed[label]`). */
  readonly observed?: unknown;
}

export type DocumentChecker = (ctx: DocumentCheckContext) => DocumentCheckResult;

/** C2d: the whole set under a page, as captured. */
export interface SubtreeCheck {
  readonly label: string;
  readonly kind: 'subtree';
  readonly resourceId: string;
  readonly pages: readonly {
    readonly id: string;
    readonly parentId: string | null;
    readonly name?: string;
    readonly tags?: readonly string[];
  }[];
}

/** v2 C2c: a page's own fields as the plan saw them. */
export interface ResourceCheck {
  readonly label: string;
  readonly kind: 'resource';
  readonly resourceId: string;
  readonly name?: string;
  readonly parentId?: string | null;
  readonly tags?: readonly string[];
}

/** v2 C2c: the pages directly under a page. */
export interface ChildrenCheck {
  readonly label: string;
  readonly kind: 'children';
  readonly resourceId: string;
  readonly ids: readonly string[];
}

/** v2 C2c: one block of a document. */
export interface BlockCheck {
  readonly label: string;
  readonly kind: 'block';
  readonly resourceId: string;
  readonly documentId: string;
  readonly blockId: string | null;
  readonly first?: boolean;
  readonly content?: Readonly<Record<string, unknown>>;
  readonly absent?: boolean;
  readonly empty?: boolean;
}

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
      readonly kind: 'block';
      readonly label: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly blockId: string;
      readonly present: boolean;
      readonly content?: Readonly<Record<string, unknown>>;
      readonly first?: boolean;
    }
  | {
      readonly kind: 'lane';
      readonly label: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly laneId: string;
      readonly name?: string;
    }
  | {
      readonly kind: 'checked';
      readonly label: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly checker: string;
      readonly input: unknown;
      readonly inputFrom?: { readonly step: number; readonly key: string };
    }
  | {
      readonly kind: 'event';
      readonly label: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly eventId: string;
      readonly present: boolean;
      readonly fields?: Readonly<Record<string, unknown>>;
    }
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
  const schema =
    op === EXPECT_STEP
      ? expectParamsSchema
      : op === VERIFY_STEP
        ? verifyParamsSchema
        : op === RECORD_STEP
          ? recordParamsSchema
          : null;
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
  if (op === RECORD_STEP) return 0;
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

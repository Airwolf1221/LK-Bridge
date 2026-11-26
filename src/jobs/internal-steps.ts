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
import type { SkippedItem, StepOptions } from './types.js';

export const EXPECT_STEP = 'bridge.expect';
export const VERIFY_STEP = 'bridge.verify';
/**
 * v2 C2c (ADR 0035): the lifecycle record, written by the change's own job: `begin` (incomplete) when it starts and
 * `complete` at its end. It reads nothing from LegendKeeper and writes only the bridge's own database, through a handler
 * the lifecycle module registers (`engine.registerRecordHandler`).
 */
export const RECORD_STEP = 'bridge.record';
/**
 * v3 F2 (ADR 0049 decision 2): the decision before a page's `Last Major Revision` row is set after a substantial edit.
 * It works out today's date on the bridge's clock (Europe/London) when it RUNS (for a proposal: the day it is approved
 * and applied), finds the row (from the plan, chaining on an earlier row write's version, or by one read of the rows
 * inside the job), and either says what the next step sends (`lmr`: path, body, version) or that it is skipped (no
 * such row, or it already says today). Only reads; a failure is a follow-up (`lmr_failed`), never the job's.
 */
export const LMR_STEP = 'bridge.lmr';
export const INTERNAL_STEPS: ReadonlySet<string> = new Set([EXPECT_STEP, VERIFY_STEP, RECORD_STEP, LMR_STEP]);

/** v3 F2: a date on the bridge's clock (Europe/London), as `YYYY-MM-DD` (the form Arkona's pages use). */
export function londonDate(ms: number): string {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** v3 F2: the params of `bridge.lmr` (`{ body }`). */
export interface LmrParams {
  readonly resourceId: string;
  /** The key-value property that holds the row; absent when the plan did not know (then it is found by one read). */
  readonly propertyId?: string;
  /** The row's key (`Last Major Revision`, or the project's own name for it). */
  readonly key: string;
  /** The row's id and value as the plan saw them, when it did (then a chained version needs no read). */
  readonly rowId?: string;
  readonly value?: string;
  /** An earlier row write of the same property in this job, whose new version (or ETag) is this write's If-Match. */
  readonly chainFrom?: number;
  /** The steps whose writes made the edit substantial: if none of them wrote anything, nothing is set. */
  readonly after: readonly number[];
  /** The page's name, for the follow-up. */
  readonly page?: string;
  /** v3 F3c (ADR 0051): which mode applied and why, in words (kept in the step's result and the answer). */
  readonly why?: string;
  /**
   * v3 F3c: the edit's page text could not be measured when it was planned (the request did not hold the old text): the
   * decision measures it when it runs, from the journal's pre-images of the `after` steps and what they sent, with the
   * evidence the plan did hold (`known`: facts, links, chronology rows). Not a major revision: skipped.
   */
  readonly measure?: { readonly known?: readonly unknown[] };
}

export function isInternalStep(op: string): boolean {
  return INTERNAL_STEPS.has(op);
}

/**
 * v3 F2 (ADR 0049 decision 10): the steps a bridge-built batch (`internal: true`) may carry that are not LegendKeeper
 * operations: the internal steps, and the signed-URL PUT and stored-file check of an image upload (`upload_image.put`,
 * `upload_image.verify`, run by their custom handlers), so a staged image's placement, which uploads it from the
 * bridge's server, is one ordinary batch job or proposal. `lk_api_batch` never sets `internal`.
 */
export const BATCH_UPLOAD_STEPS: ReadonlySet<string> = new Set(['upload_image.put', 'upload_image.verify']);
export function isBridgeStep(op: string): boolean {
  return INTERNAL_STEPS.has(op) || BATCH_UPLOAD_STEPS.has(op);
}

const uploadPutParamsSchema = z
  .object({
    body: z
      .object({
        contentType: z.string().min(1).max(100),
        contentLength: z.number().int().min(1),
        contentHash: z.string().regex(/^[0-9a-f]{64}$/),
        /** The WebP the bridge keeps on its server (images/staged/), read when the step runs. */
        stagedSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
  })
  .strict();
const uploadVerifyParamsSchema = z
  .object({
    body: z
      .object({
        assetStep: z.number().int().min(1),
        contentLength: z.number().int().min(1).optional(),
        contentHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
      })
      .strict(),
  })
  .strict();

const id = z.string().min(1).max(256);
const label = z.string().min(1).max(300);
/**
 * v3 F3d amendment (ADR 0058, A): a check whose difference skips these items (recorded as "changed meanwhile", the job
 * carrying on with its other items) instead of stopping the job. Bridge code only.
 */
const skipItems = z.array(z.string().min(1).max(300)).min(1).max(200).optional();
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
    skipItems,
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
    skipItems,
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

/**
 * v2 D2 (ADR 0040): a map document, read inside the lock (its settings with `mapImage`, and every feature) and judged by
 * a map checker the bridge registered by name (`engine.registerMapChecker`): the map-feature tools' compare-and-swap for
 * writes LegendKeeper does not version. The checker answers the differences (a conflict: nothing is written) and the
 * bodies of the writes that follow (the converted coordinates and the rank between the real neighbours: `bindBody`).
 */
const mapCheck = z
  .object({
    label,
    kind: z.literal('map'),
    resourceId: id,
    documentId: id,
    checker: z.string().min(1).max(100),
    input: z.unknown(),
  })
  .strict();

/**
 * v3 F3a (ADR 0050): a check judged by an ASYNCHRONOUS checker the bridge registered by name
 * (`engine.registerAsyncChecker`): a setting pack's in-lock checks (the character is still absent when its job runs; the
 * pack's governance sources are still the approved versions). The checker reads through the job itself (governed,
 * counted with the step) and answers differences (a conflict: nothing is written), a typed refusal (the job stops with
 * that code before any write), and bodies for `bindBody`.
 */
const registeredCheck = z
  .object({
    label,
    kind: z.literal('registered'),
    checker: z.string().min(1).max(100),
    /** The page the check is about, when there is one (its versions are kept under it). */
    resourceId: id.optional(),
    input: z.unknown(),
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
  mapCheck,
  registeredCheck,
]);

/**
 * How many checks one `bridge.expect` step, and how many targets one `bridge.verify` step, may hold. C2d raised it to
 * 400 for a whole set (a hundred pages' rows and notes). CR-2026-11-R3 (R3-01): a rename's first check and its read-back
 * hold one entry per block, page and asset they cover, so a heavily referenced character (700 pages) was refused at
 * submission, after its plan had spent its reads, with an internal INVALID_PARAMS. 5,000 covers the whole of Arkona
 * (about 3,500 pages); a setting-pack plan beyond it (a rename, a split, a package) is refused plainly before it is
 * submitted or proposed (`STEP_TOO_LARGE`, src/mcp/tools/write-job.ts), never with INVALID_PARAMS. A retag batch holds
 * at most 100 pages, far below it.
 */
export const MAX_STEP_CHECKS = 5_000;

// C2d: a whole set checks up to a hundred pages' rows and notes in one step (it was 50).
export const expectParamsSchema = z
  .object({ body: z.object({ checks: z.array(expectCheckSchema).min(1).max(MAX_STEP_CHECKS) }).strict() })
  .strict();

const expectedProperty = z
  .object({
    id,
    title: z.string().max(256),
    rows: z.array(rowState).max(256).optional(),
    collection: collectionState.optional(),
    datedRowId: id.optional(),
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
  // v2 D2: a map's features read back and judged by a registered map checker (each present as written, or gone).
  z
    .object({
      kind: z.literal('mapChecked'),
      label,
      resourceId: id,
      documentId: id,
      checker: z.string().min(1).max(100),
      input: z.unknown(),
      /** Also read the document's own settings (`getDocument`: its type and `mapImage`), for the checker. */
      withDocument: z.boolean().optional(),
      /** The input is what an earlier `bridge.expect` step worked out inside the lock (`bodies[key]`). */
      inputFrom: z
        .object({ step: z.number().int().min(1), key: z.string().min(1).max(200) })
        .strict()
        .optional(),
    })
    .strict(),
  // v2 D3 (ADR 0041): an asset, read back: its fields (folderId, isHidden, name), the folder possibly one an earlier
  // step of the job created (`folderFrom`: that step's result id).
  z
    .object({
      kind: z.literal('asset'),
      label,
      assetId: id.optional(),
      // v3 F2 (ADR 0049 decision 10): an asset an earlier step of the job created (a staged image's upload).
      assetFrom: z
        .object({ step: z.number().int().min(1) })
        .strict()
        .optional(),
      fields: z.record(z.string(), z.unknown()),
      folderFrom: z
        .object({ step: z.number().int().min(1) })
        .strict()
        .optional(),
      // v3 F7d (ADR 0077, A4): not read back when one of these was withdrawn in the job (a move left out with why).
      withdrawnWith: z.array(z.string().min(1).max(200)).max(20).optional(),
    })
    .strict()
    .refine((t) => (t.assetId === undefined) !== (t.assetFrom === undefined), {
      message: 'an asset target names assetId or assetFrom',
    }),
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
  // v3 F3a (ADR 0050): anything read back and judged by an asynchronous checker the bridge registered by name (a setting
  // pack's page checks), given the results of earlier steps it names (`inputFrom`: a Last Major Revision decision, an
  // image's new asset). Each target is reported on its own, so one page can have several (one per gated field).
  z
    .object({
      kind: z.literal('registered'),
      label,
      checker: z.string().min(1).max(100),
      resourceId: id.optional(),
      input: z.unknown(),
      inputFrom: z
        .array(z.object({ step: z.number().int().min(1), as: z.string().min(1).max(100) }).strict())
        .max(50)
        .optional(),
    })
    .strict(),
]);

export const verifyParamsSchema = z
  .object({ body: z.object({ targets: z.array(verifyTargetSchema).min(1).max(MAX_STEP_CHECKS) }).strict() })
  .strict();

/** v2 C2c: `bridge.record`'s params: the action and what the handler needs (checked by the handler itself). */
export const recordParamsSchema = z
  .object({
    body: z
      .object({
        // C2d: `begin_set` / `complete_set`, a whole set's record and its pages' records together.
        action: z.enum(['begin', 'complete', 'begin_set', 'complete_set']),
        record: z.record(z.string(), z.unknown()),
        /**
         * v2 D1: which record (`lifecycle`, the default, or `chronology`); v3 F3a: `pack` (a setting pack's); v3 F6c
         * (ADR 0080): `registry_roles` (a role binding, once the job that made its index succeeded).
         */
        store: z.enum(['lifecycle', 'chronology', 'pack', 'registry_roles']).optional(),
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
  | LaneCheck
  | MapCheck
  | RegisteredExpectCheck;

/** v2 D2: a map document and its features, judged by a registered map checker. */
export interface MapCheck {
  readonly label: string;
  readonly kind: 'map';
  readonly resourceId: string;
  readonly documentId: string;
  readonly checker: string;
  readonly input: unknown;
}

/** v2 D2: what a map checker gets: the map's document settings and features as read inside the lock, and the plan's input. */
export interface MapCheckContext {
  readonly projectId: string;
  readonly jobId: string;
  readonly stepNo: number;
  readonly label: string;
  readonly input: unknown;
  /** `getDocument`'s answer (type, `mapImage`), or null when it was not read (a verify step reads the features only). */
  readonly document: Readonly<Record<string, unknown>> | null;
  readonly features: readonly Record<string, unknown>[];
}

export type MapChecker = (ctx: MapCheckContext) => DocumentCheckResult;

/** v2 D1: a whole document judged by a registered checker. */
export interface DocumentCheck {
  readonly label: string;
  readonly kind: 'document';
  readonly resourceId: string;
  readonly documentId: string;
  readonly checker: string;
  readonly input: unknown;
  /** v3 F3d amendment (ADR 0058, A): a difference skips these items instead of stopping the job. */
  readonly skipItems?: readonly string[];
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
  /** v3 F3d amendment (ADR 0058, A): a difference skips these items instead of stopping the job. */
  readonly skipItems?: readonly string[];
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
  /**
   * v3 F3d amendment (ADR 0058, A), `bridge.expect` only: items whose target changed meanwhile, skipped (the job carries
   * on with its other items); kept in the step's result (`skippedItems`).
   */
  readonly skipped?: readonly SkippedItem[];
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
  /**
   * CR-2026-11-R3 (R3-67): the Last Major Revision row a later step of the same job dates (`bridge.lmr`): its value is not
   * judged by this read-back (that step set it, and Revert lays it over these rows), every other row is.
   */
  readonly datedRowId?: string;
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
      readonly kind: 'asset';
      readonly label: string;
      readonly assetId?: string;
      /** v3 F2: the asset an earlier step of the job created. */
      readonly assetFrom?: { readonly step: number };
      readonly fields: Readonly<Record<string, unknown>>;
      readonly folderFrom?: { readonly step: number };
      /** v3 F7d (ADR 0077, A4): skipped when one of these keys was withdrawn earlier in the job. */
      readonly withdrawnWith?: readonly string[];
    }
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
      readonly kind: 'mapChecked';
      readonly label: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly checker: string;
      readonly input: unknown;
      readonly withDocument?: boolean;
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
    }
  | RegisteredVerifyTarget;

/** v3 F3a (ADR 0050): a target read back and judged by a registered asynchronous checker. */
export interface RegisteredVerifyTarget {
  readonly kind: 'registered';
  readonly label: string;
  readonly checker: string;
  readonly resourceId?: string;
  readonly input: unknown;
  /** Earlier steps whose results the checker gets, each under its own name (`from[as]`). */
  readonly inputFrom?: readonly { readonly step: number; readonly as: string }[];
}

/** v3 F3a (ADR 0050): a `bridge.expect` check judged by a registered asynchronous checker. */
export interface RegisteredExpectCheck {
  readonly label: string;
  readonly kind: 'registered';
  readonly checker: string;
  readonly resourceId?: string;
  readonly input: unknown;
}

/**
 * v3 F3a (ADR 0050): what a registered asynchronous checker gets. `read` is a governed read in the job's name (counted
 * with its step, told to the snapshot service like the bridge's other check reads); a 404 is `{ exists: false }`. In a
 * verify step the same read is made once per step (later targets get the answer the first one did).
 */
export interface RegisteredCheckContext {
  readonly projectId: string;
  readonly jobId: string;
  readonly stepNo: number;
  readonly label: string;
  readonly phase: 'expect' | 'verify';
  readonly input: unknown;
  /** Verify only: the stored results of the earlier steps the target names, by their `as` names (null: not succeeded). */
  readonly from: Readonly<Record<string, unknown>>;
  read(op: string, params: OpParamsShape): Promise<{ readonly exists: boolean; readonly body: unknown }>;
}

/** The params of a read (`{ path?, query? }`), as the registry takes them. */
export interface OpParamsShape {
  readonly path?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, unknown>>;
}

/** What a registered checker answers. */
export interface RegisteredCheckResult {
  /** A difference is a conflict in `bridge.expect` (nothing written) and a mismatch in `bridge.verify`. */
  readonly differences: readonly StateDifference[];
  /**
   * `bridge.expect` only: a typed refusal. The job stops at the check, before any write, with this code (for example
   * `CHARACTER_EXISTS`) and message, and the details beside them; never retried.
   */
  readonly refusal?: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
  /** `bridge.expect` only: write bodies by key, for `bindBody`. */
  readonly bodies?: Readonly<Record<string, unknown>>;
  /** What the checker saw, kept in the step's result. */
  readonly observed?: unknown;
  /**
   * v3 F3d amendment (ADR 0058, A), `bridge.expect` only: items whose target changed meanwhile, skipped (the job carries
   * on with its other items); kept in the step's result (`skippedItems`).
   */
  readonly skipped?: readonly SkippedItem[];
  /** v3 F3d amendment, `bridge.expect` only: the version the check read, kept as `versions[label]` for a chain. */
  readonly version?: string | null;
}

export type RegisteredChecker = (ctx: RegisteredCheckContext) => Promise<RegisteredCheckResult>;

/**
 * v3 F3a (ADR 0050): a filler, by name (`engine.registerFiller`), for `StepOptions.fill`: given the document as it is
 * when the write runs (read inside its lock) and the blocks the plan wants, it answers the blocks to send: a page the
 * same job made from a template already holds the template's content, and what Markdown cannot express there (a
 * collection block, `unsupported` content) is kept. A filler that throws stops the write (a conflict; nothing is sent).
 */
export interface FillContext {
  readonly projectId: string;
  readonly jobId: string;
  readonly stepNo: number;
  readonly input: unknown;
  /** The blocks the step was planned with (after every binding). */
  readonly planned: readonly unknown[];
  readonly current: { readonly version: string; readonly blocks: readonly unknown[] };
}

export interface FillResult {
  readonly blocks: readonly unknown[];
  /** What the filler did, kept in the step's result (`filled`). */
  readonly note?: Readonly<Record<string, unknown>>;
}

export type Filler = (ctx: FillContext) => FillResult;

const lmrParamsSchema = z
  .object({
    body: z
      .object({
        resourceId: id,
        propertyId: id.optional(),
        key: z.string().min(1).max(256),
        rowId: id.optional(),
        value: z.string().max(2048).optional(),
        chainFrom: z.number().int().min(1).optional(),
        after: z.array(z.number().int().min(1)).min(1).max(1000),
        page: z.string().max(500).optional(),
        why: z.string().max(500).optional(),
        measure: z
          .object({ known: z.array(z.record(z.string(), z.unknown())).max(1000).optional() })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

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
          : op === LMR_STEP
            ? lmrParamsSchema
            : op === 'upload_image.put'
              ? uploadPutParamsSchema
              : op === 'upload_image.verify'
                ? uploadVerifyParamsSchema
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
  if (op === LMR_STEP) {
    const b = (params as { body?: Partial<LmrParams> } | undefined)?.body;
    return b?.chainFrom !== undefined && b.rowId !== undefined ? 0 : b?.propertyId === undefined ? 2 : 1;
  }
  const body = (params as { body?: { checks?: unknown[]; targets?: unknown[] } } | undefined)?.body;
  // A map check reads the map's settings and its features (two reads); every other check one.
  if (op === EXPECT_STEP)
    return body?.checks
      ? (body.checks as { kind?: unknown }[]).reduce((n, c) => n + (c && c.kind === 'map' ? 2 : 1), 0)
      : 1;
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
  'a mention’s name (filled in by LegendKeeper), and its text where the bridge sent none (the label LegendKeeper fills in); a label the bridge wrote is compared, and so is the target (resourceId, documentId)',
  'runs normalised as LegendKeeper does on write (empty text runs dropped, neighbouring runs with the same marks merged)',
  'the id LegendKeeper gives a row or item the bridge created',
  'properties the plan did not name',
];

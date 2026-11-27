/** Shared types of the job engine (PLAN §6). */
import type { PriorityClass as GovernorPriorityClass } from '../config/lk.js';
import type { OperationKind } from '../lk/registry-types.js';
import type { LmrMode } from './lmr-hook.js';
import type { ProposalExtras } from './policy.js';

/**
 * A job's class (PLAN §5.2): P0 to P3. v3 F9 (ADR 0074): the governor's P4 (bulk) is a request class only, for the
 * bridge's own whole-repository reads (`internalRead`); no job row is ever P4.
 */
export type PriorityClass = Exclude<GovernorPriorityClass, 'P4'>;
/** Every class the governor schedules, P4 (bulk) included. */
export type { GovernorPriorityClass };

export const JOB_STATUSES = [
  'queued',
  'running',
  'waiting_budget',
  'waiting_lock',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled']);

export const STEP_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'uncertain', 'cancelled'] as const;
/**
 * `uncertain`: the step may or may not have reached LK and the bridge could not establish which without risking a
 * duplicate. The job ends `failed` with `uncertain: true`; a person decides (retry the step, or check LK).
 */
export type StepStatus = (typeof STEP_STATUSES)[number];

export type JobKind = 'single_op' | 'batch_ops' | 'paginate_all' | 'upload_image';
export type OnError = 'stop' | 'continue';

/**
 * The identity work is done for. `principalId` is stable (an owner, an OAuth client, a PAT…), `profile` names the
 * policy profile it acts under, `label` is for display. The policy store that assigns them comes in a later chunk.
 */
export interface Principal {
  readonly principalId: string;
  readonly profile: string;
  readonly label: string;
}

/** The default for internal and UI-initiated work. */
export const SYSTEM_PRINCIPAL: Principal = Object.freeze({
  principalId: 'system',
  profile: 'system',
  label: 'System',
});

/**
 * v3 F5b (ADR 0068, H5): the automation framework's own principal. Its jobs are direct writes of the codes the owner
 * switched to "Apply automatically": journalled under it, listed on the Review page and Revertible. The policy gate lets
 * it write only from the automation engine (origin `maintenance`, tool `automation.*`), never over MCP, and judges the
 * safety rails at their defaults for it, as for an agent at scope `write`.
 */
export const AUTOMATION_PRINCIPAL: Principal = Object.freeze({
  principalId: 'automation',
  profile: 'automation',
  label: 'Automation',
});

/** Who asked for the work. `kind` and the principal are filterable; the rest is shown in the UI. */
export interface JobOrigin {
  readonly kind: 'mcp' | 'ui' | 'system' | 'maintenance' | 'test';
  /** MCP client name or OAuth client id, PAT name, etc. */
  readonly client?: string;
  /** MCP tool or UI action. */
  readonly tool?: string;
  readonly detail?: string;
  /** Defaults to `SYSTEM_PRINCIPAL`. */
  readonly principal?: Principal;
  /** Who approved this work, when it ran from an approved proposal (recorded on the job and journal entries). */
  readonly approvedBy?: string;
  /**
   * Opaque proof of the owner's approval (src/policy). The engine never reads it; it only hands it to the policy
   * gate in `ctx.origin`. Only the policy layer can mint a valid one, and it serialises to `{ proposalId }` only.
   */
  readonly approval?: unknown;
  /**
   * v2 C2a (ADR 0032): who accepted this work as canon ("Approve and accept as canon"). Set only by the proposal service
   * together with a live canonical approval token; the policy gate refuses it otherwise. The write guard lets a job that
   * carries it make the protected changes it was approved for.
   */
  readonly canonicalApprovedBy?: string;
  /**
   * v3 F5c (ADR 0069, H8): the workstream label the work belongs to (an agent's `workstream` argument, or its
   * connection's default). Recorded on the job, its proposal and its journal entries; an approved proposal's job keeps
   * the proposal's.
   */
  readonly workstream?: string;
  /**
   * v3 F12 (ADR 0081): the owner confirmed this dashboard action in its dialog, so it runs at once as one job (no
   * proposal to approve next), canon and lifecycle changes included. Bridge code only, on a dashboard origin (`ui`)
   * acting as the system principal; the policy gate refuses it anywhere else.
   */
  readonly ownerConfirmed?: true;
}

/** Caller-facing input of a registry operation: `{ path?, query?, ifMatch?, body? }` (see src/lk/registry). */
export interface OpParams {
  readonly path?: Record<string, string>;
  readonly query?: Record<string, unknown>;
  readonly ifMatch?: string;
  readonly body?: unknown;
}

/** Per-step options that are not LK parameters. */
export interface StepOptions {
  /** PLAN §4 rule 2: let a replace drop `unsupported` blocks. Default false. */
  readonly allowUnsupportedLoss?: boolean;
  /** PLAN §4 rule 3: `deleteResource` with `cascade=true` needs `confirm: "cascade"`. */
  readonly confirm?: 'cascade';
  /**
   * v2 C1 (ADR 0031), set by bridge code only: after a successful `replaceDocumentBlocks`, read the document again
   * inside the lock and compare the stored blocks with the blocks sent (src/jobs/verify-blocks.ts). A difference is
   * recorded on the step, the job and the errors table; the write is never retried.
   */
  readonly verifyAfterWrite?: boolean;
  /** v2 C1, set by bridge code only: the high-level operation, recorded in the write's journal entry. */
  readonly journalOperation?: Readonly<Record<string, unknown>>;
  /**
   * v2 C1, set by bridge code only: when the in-lock read shows the document changed since `ifMatch`, ask this planner
   * (src/jobs/planners.ts) to re-plan instead of refusing. Never stored for approved proposals.
   */
  readonly replan?: { readonly planner: string; readonly input: unknown };
  /**
   * v2 C2a (ADR 0032), set by bridge code only: take this step's `If-Match` from an earlier step of the same job just
   * before it runs: that step's result `version` (a versioned write), or `versions[key]` (the `bridge.expect` step).
   * The chain of a multi-write job: each write's new version is the next write's If-Match.
   */
  readonly ifMatchFrom?: { readonly step: number; readonly key?: string };
  /**
   * v2 C2a, set by bridge code only: the bridge's own compare-and-swap for a write LegendKeeper does not version
   * (`updateProperty`): the in-lock read must show this state (`rows` or `collection`, normalised and hashed as in
   * src/jobs/sidebar-state.ts), or nothing is sent (a conflict).
   */
  readonly expectCurrent?: {
    /** RV4 sketch: `resource`, a page's name and tags as planned (updateResource, which LegendKeeper does not version). */
    readonly state: 'rows' | 'collection' | 'resource';
    readonly hash: string;
    readonly label?: string;
  };
  /**
   * v2 C2a, set by bridge code only: the repository tree re-reads what this step changed once, when the job finishes,
   * instead of after the step (a multi-write job on one page costs one re-read, not one per write).
   */
  readonly deferTreeReread?: boolean;
  /**
   * v2 C2a, set by bridge code only: kept as the journal entry's pre-image when the operation keeps none of its own
   * (row writes): the property as the plan saw it, which the job's `bridge.expect` step confirmed inside the lock.
   */
  readonly journalPreImage?: unknown;
  /**
   * v2 D2 (ADR 0040), set by bridge code only: added to the pre-image the read inside the lock gave (an object), under
   * `with`: a folder's cascade delete keeps every feature it removes in the folder's own journal entry (as a lane's
   * delete keeps its events), the same lesson as D1's.
   */
  readonly journalPreImageWith?: unknown;
  /**
   * v2 C2b (ADR 0034), set by bridge code only: this step writes to a page the same job created from a template, and
   * its params name the TEMPLATE's sidebar ids (properties, rows, items). Just before it runs they are replaced by the
   * copy's ids, from the `ids` map of the `bridge.expect` step it names (a `copy` check, made inside the job). Only
   * `path.propertyId`, `path.rowId`, `body.after`, `body.before` and `body.items[].id` are bound.
   */
  readonly bindIds?: { readonly step: number };
  /**
   * v2 D1 (ADR 0038), set by bridge code only: just before it runs, this step's `body` is replaced by the one the named
   * `bridge.expect` step worked out inside the lock (its result's `bodies[key]`): a chronology row's place and a count's
   * new value are decided from the documents as they are when the job runs, not as they were planned. The new params
   * are checked against the registry's schema and stored before anything is sent; a step being recovered keeps what it
   * was sent with.
   */
  readonly bindBody?: { readonly step: number; readonly key: string };
  /**
   * v2 D1 (ADR 0038), set by bridge code only: this write is judged by its job's own `bridge.expect` check inside the
   * lock, so a proposal captures no version of its target (another approved change to the same document does not make
   * it conflict; the check refuses what would).
   */
  readonly judgedInLock?: boolean;
  /**
   * v2 E1a (ADR 0042 decision 9), set by bridge code only: body fields LegendKeeper may refuse although the rest of the
   * write is sound (an icon name it does not know: 400 VALIDATION_ERROR naming the field). When it does, the step is sent
   * once more without them (LegendKeeper's default applies), and the step's result says what was dropped
   * (`droppedFields`). Any other refusal fails the step as before.
   */
  readonly dropIfRefused?: readonly string[];
  /**
   * v2 D3 (ADR 0041), set by bridge code only: just before it runs, this step takes the `id` of what an earlier step of
   * the same job created (a folder `createAssetFolder` made, an asset `createImageAsset` made) into `body.folderId` or
   * `path.assetId`. Done once, before anything is sent, and stored; a step being recovered keeps what it was sent with.
   */
  readonly bindFrom?: {
    readonly step: number;
    /**
     * v2 E1a (ADR 0042): `path.documentId`, for a page the same job recreates (restore_snapshot): its documents get new
     * ids, so their content writes take the id the create returned.
     */
    readonly to: 'body.folderId' | 'path.assetId' | 'path.documentId';
    /**
     * v2 E1a: where in the earlier step's result the id is: `id` (the default: a created folder, asset or document), or
     * `documents.<n>.id` (the n-th document of a page `createResource` made, 0 to 4: it creates up to five).
     * v3 F3a (ADR 0050): `documents.main.id`, the main page document of a page the job made (from a template, whose
     * documents LegendKeeper copies in an order it does not state): the one named `Main` of type page or blank, else the
     * only page or blank document; any other answer stops the step before anything is sent.
     */
    readonly from?: 'id' | `documents.${number}.id` | 'documents.main.id';
  };
  /**
   * v3 F3a (ADR 0050), set by bridge code only: just before it runs, every string in this step's `body` equal to a
   * `placeholder` is replaced by the `url` of the asset the named earlier step created (`createImageAsset`): a page's
   * image blocks, written in the same job that uploads the images, name each new asset by its real address. Done once,
   * checked against the schema and stored before anything is sent; a step being recovered keeps what it was sent with.
   */
  readonly bindAssetUrls?: readonly {
    readonly step: number;
    readonly placeholder: string;
    /** v3 F3c (ADR 0051 decision 3): `id` puts the asset's id in place of the placeholder (a map image); default `url`. */
    readonly field?: 'url' | 'id';
    /**
     * v3 F7c (ADR 0075, Z4): the blocks (by id) that show this image (its heading, image block and interpretation):
     * when the named step was withdrawn (its archive entry was refused or discarded, so the image was never uploaded),
     * these blocks are left out instead of failing the step, and the other images go ahead.
     */
    readonly drop?: readonly string[];
  }[];
  /**
   * v3 F7c (ADR 0075, Z4), set by bridge code only, on the steps that upload one staged image (createImageUpload, the
   * signed PUT, createImageAsset, the stored-file check): the image is an archive entry that was not staged yet when the
   * job was planned. Just before the step runs, the staged image of that id is looked up (the registered resolver) and
   * its WebP's length and SHA-256 (and server file) are bound into the body; when its entry was refused, failed for good
   * or discarded meanwhile, the step is not sent: it is recorded as succeeded with `{ skipped, withdrawn }`, so only
   * that image is left out. Bound once, before anything is sent.
   */
  readonly bindStaged?: { readonly stagedId: string };
  /**
   * v3 F7d (ADR 0077, A4), set by bridge code only: the step is withdrawn (recorded as succeeded with
   * `{ skipped, withdrawn: { keys, reason } }`, nothing sent) when an earlier step of the job withdrew one of these keys
   * (an image of an art set whose upload failed: its later steps, its blocks on the page and its read-back are left out).
   */
  readonly withdrawWith?: readonly string[];
  /**
   * v3 F7d (A4), set by bridge code only: when this step fails for certain (nothing may have been written: never an
   * uncertain outcome), it is withdrawn under these keys instead of failing the job, with the error as the reason, so
   * the art set's other images and groups go ahead.
   */
  readonly withdrawAs?: readonly string[];
  /**
   * v3 F3a (ADR 0050), set by bridge code only, on a `replaceDocumentBlocks` of a page the same job made from a template
   * (whose copy already holds the template's content): inside the lock, after the read that gives the If-Match, the
   * registered filler named here works out the blocks to send from the document as it is then and the planned blocks
   * (keeping what Markdown cannot express, such as an index's collection block). The result is stored before it is sent,
   * with the version read as its If-Match, so a recovery compares with it; the unsupported-block guard still judges it.
   */
  readonly fill?: { readonly filler: string; readonly input?: unknown };
  /**
   * v3 F2 (ADR 0049 decision 2), set by bridge code only: this write's path and body come from the decision the named
   * `bridge.lmr` step made when it ran (its result's `lmr`), and when that step decided to skip it (or did not succeed),
   * this step is not sent: it is recorded as succeeded with `{ skipped }`. Bound once, before anything is sent.
   */
  readonly decisionFrom?: { readonly step: number };
  /**
   * v3 F2, set by bridge code only: this step can never fail the job. A failure is recorded on the step, in the errors
   * table and in the job's result as a follow-up of this kind (for the dashboard), and the job carries on and ends as
   * if the step had not been needed. The work before it stays written: nothing is rolled back.
   */
  readonly followUp?: 'lmr_failed' | 'image_relink_failed' | 'placement_failed';
  /**
   * v3 F2 (ADR 0049 decision 9), set by bridge code only, on a `createAssetFolder` the bridge planned: when the job runs,
   * under the project's asset-folder lock, the parent's children are read fresh and a folder with exactly this name is
   * used (its id bound by the steps after it) instead of creating another. A raw createAssetFolder keeps its meaning.
   */
  readonly findOrCreate?: boolean;
  /**
   * v3 F3.4 (ADR 0055 decision E), set by the engine only: read the target once inside the lock before this write and
   * keep it as the write's journal pre-image, although the caller gave its own If-Match (which otherwise makes no read).
   * Set on a direct `updateBlock` whose page's Last Major Revision decision measures the edit when it runs (the rule
   * needs the block's "before"); never otherwise, so a write pays the read only when the rule needs it.
   */
  readonly readBefore?: boolean;
  /**
   * v3 F2 (ADR 0049 decision 9), set by bridge code only, on a `deleteAsset` of a folder: the folder's contents are read
   * when the job runs (under the asset-folder lock) and, when anything is in it, the delete is not sent (the step is
   * recorded as succeeded with `{ skipped }`): a duplicate folder is deleted only when the merge has emptied it.
   */
  readonly onlyIfEmpty?: boolean;
  /**
   * v3 F3d (renames), ADR 0058, set by bridge code only: the items of a proposal this step belongs to (src/jobs/items.ts).
   * Kept when ANY of them is approved; a step with none is shared. Only the owner's selection on the Proposals page
   * reads it; the engine runs a step the same with or without it.
   */
  readonly items?: readonly string[];
  /**
   * v3 F3d (ADR 0058), set by bridge code only: arrays inside a shared bridge step's params whose elements belong to
   * items (a check, a read-back target, a chronology record's writes). Only the elements of approved items stay.
   */
  readonly itemParts?: readonly ItemPartShape[];
  /**
   * v3 F3d amendment (ADR 0058, A), set by bridge code only: when this write finds its target changed inside its lock
   * (another version or state, or a 412), the rebaser named here is asked with the target as it is now (src/jobs/rebase.ts):
   * retry the same change on the fresh content, already done, or skip the step's items ("changed meanwhile"). `core`: a
   * conflict that cannot be rebased stops the job (resumable) instead of skipping. `with`: further items skipped with
   * this step's (the items that depend on them).
   */
  readonly rebase?: {
    readonly rebaser: string;
    readonly input: unknown;
    readonly core?: boolean;
    readonly with?: readonly string[];
    /** Asked every time the write runs (after its read inside the lock), not only on a conflict. */
    readonly always?: boolean;
  };
}

/**
 * v3 F3d amendment (ADR 0058, A): an item a job skipped when it ran, because what it edits had changed meanwhile (or
 * could not be told apart, or kept conflicting), with a before and after excerpt. Kept in the step's result
 * (`skippedItems`); the job carries on with its other items, and the owner can propose the skipped ones again.
 */
export interface SkippedItem {
  readonly item: string;
  /** Why, in words ("changed meanwhile", "appears more than once now", "conflicted three times in a row"). */
  readonly reason: string;
  /** What the item expected to edit (the planned sentence, value or name). */
  readonly before?: string | null;
  /** What is there now. */
  readonly after?: string | null;
  /** Where, for the owner (page › section). */
  readonly where?: string;
}

/** v3 F3d: one array of a shared step whose elements belong to items (src/jobs/items.ts, `ItemPart`). */
export interface ItemPartShape {
  readonly path: string;
  readonly items: readonly (readonly string[])[];
}

/**
 * v3 F3d (ADR 0058, design section 3), bridge code only: a job that can be resumed after it stops part-way (a setting
 * pack's package, a rename, a recreate), and the steps it checks again first (its preconditions, re-run inside the
 * job before it continues from where it stopped).
 */
export interface ResumableShape {
  readonly kind: 'package' | 'rename' | 'recreate' | 'split' | 'retag' | 'identity';
  /** The steps (1-based) run again on resume before the step it stopped at (the job's own checks). */
  readonly recheck?: readonly number[];
  /**
   * CR-2026-11-R3 (R3-22): the registered checkers whose checks run again on resume too (every succeeded `bridge.expect`
   * step before the step it stopped at that holds one), named rather than numbered so a selection that leaves steps
   * out does not move them. A split's destinations check: what left a destination while the job was stopped is never
   * then taken out of the source.
   */
  readonly recheckCheckers?: readonly string[];
  /** What the kind needs to find its record (a recreate's restore id). */
  readonly ref?: string;
  /**
   * v3 F5c (ADR 0069, H6): failures are isolated per item. A step that names items and fails (or whose outcome is
   * unknown) does not stop the job: the later steps of its items are not run (recorded `cancelled`, "its item failed"),
   * and every other item carries on. A failed step that names no item (a shared check) still stops the job. The job ends
   * `failed` when any item failed, so Resume runs again exactly the steps that did not succeed.
   */
  readonly isolateItems?: boolean;
}

/**
 * v3 F3d (ADR 0058, decision D3), bridge code only: the job waits before its first step until this holds (queued, with
 * `waitReason.held` naming it). A culture or race rename waits for the owner to approve the pack version holding its new
 * token map.
 */
export type WaitForShape =
  | {
      readonly kind: 'pack_version';
      readonly packId: string;
      /** The version the job waits for the owner to approve (or a later one). */
      readonly version: number;
      /** Shown to the owner while the job waits. */
      readonly reason: string;
    }
  | {
      /**
       * v3 F7c (ADR 0075, Z4): the job places archive entries that were not staged yet: it waits (`waiting_staging`)
       * until every one is staged, or refused or discarded (that image is then left out, never the others).
       */
      readonly kind: 'archive_staging';
      readonly projectId: string;
      readonly stagedIds: readonly string[];
      readonly reason: string;
    };

/** v3 F7c: what the staged-image resolver says of a staged id (`StepOptions.bindStaged`). */
export type StagedBinding =
  | {
      readonly kind: 'staged';
      readonly contentLength: number;
      readonly contentHash: string;
      readonly stagedSha256: string;
    }
  | { readonly kind: 'withdrawn'; readonly reason: string }
  | { readonly kind: 'pending'; readonly reason: string };

export interface StepSpec extends StepOptions {
  readonly op: string;
  readonly params?: OpParams;
}

export interface RunOptions extends StepOptions {
  /** v2 A1: the LegendKeeper id of the project the operation is for. Required: there is no default in the engine. */
  readonly project: string;
  readonly priority?: PriorityClass;
  readonly origin: JobOrigin;
  readonly title?: string;
  /** Aborts waiting (inline reads, and an inline write while it waits for a lock or slot). */
  readonly signal?: AbortSignal;
  /** v2 C1: added to the proposal when the policy gate turns this write into one (src/jobs/policy.ts). */
  readonly proposal?: ProposalExtras;
  /** v3 F3c (ADR 0051 decision 1): the caller's Last Major Revision override (absent: `auto`, the rule decides). */
  readonly lastMajorRevision?: LmrMode;
}

export interface BatchSubmit {
  readonly kind: 'batch_ops';
  /** v2 A1: the project every step runs against. */
  readonly project: string;
  readonly steps: readonly StepSpec[];
  readonly onError?: OnError;
  readonly priority?: PriorityClass;
  readonly origin: JobOrigin;
  readonly title?: string;
  /**
   * v2 C2a (ADR 0032), bridge code only: the job holds this resource's lock from its first step to its end (released
   * while it waits for budget, is held or paused), so no other bridge write to the resource can come between its steps.
   * Every write step must take that same lock (or none).
   */
  readonly holdLock?: { readonly resourceId: string };
  /** v2 C2a, bridge code only: the steps may include the bridge's own `bridge.expect` and `bridge.verify`. */
  readonly internal?: boolean;
  /** v2 C2a: added to the proposal when the policy gate turns the batch into one (as `RunOptions.proposal`). */
  readonly proposal?: ProposalExtras;
  /**
   * v2 C2c (ADR 0035), bridge code only: a second job-level lock, on one document of the `holdLock` page (its main page
   * document), taken after the page's lock and kept as long. A lifecycle change writes the page (rename, move, tags,
   * facts) and that document (the archive note) in one job. Requires `holdLock`.
   */
  readonly holdDocument?: { readonly documentId: string };
  /**
   * v2 C2c, bridge code only: one more resource the job holds the lock of from start to end (promote_page of a Working
   * character writes the page and its character index). Requires `holdLock`; all are taken in sorted key order.
   */
  readonly holdAlso?: { readonly resourceId: string };
  /**
   * v2 D1 (ADR 0038), bridge code only: documents the job holds the locks of from start to end (a chronology event writes
   * its age's table, its age's timeline and the Main table; a move between ages two of each). Taken with any other
   * job-level lock in one sorted order, so two jobs can never wait on each other. Needs no `holdLock`.
   */
  readonly holdDocuments?: readonly string[];
  /**
   * v3 F3.4 (ADR 0055), bridge code only: assets the job holds the locks of from start to end (a revert that moves
   * placed images back beside its page writes). Taken with every other job-level lock in one sorted order.
   */
  readonly holdAssets?: readonly string[];
  /**
   * v2 C2c (ADR 0035), bridge code only: the job IS a lifecycle change (or a create with a lifecycle status) and makes
   * exactly these changes, which the lifecycle guard then allows. Nothing an agent sends reaches it (the tools build it;
   * `lk_api_batch` never sets it).
   */
  readonly lifecycle?: LifecycleMarker;
  /**
   * C2d (ADR 0037), bridge code only: further job-level locks, any number (a whole-set lifecycle change holds every page
   * of the set, and each page's main document). Requires `holdLock`; with it, `holdDocument` and `holdAlso` they are all
   * taken in sorted key order at the job's start, so two such jobs can never wait on each other.
   */
  readonly holdMore?: { readonly resources?: readonly string[]; readonly documents?: readonly string[] };
  /**
   * C2d (ADR 0036 decision 5), bridge code only: the pages a request touches without naming them (a cascade's, a copy's
   * children, a lifecycle set), as listed when it was planned. Kept with a proposal (which lists the implicit ones
   * itself at capture) and checked again at approval and inside the lock (src/policy/page-scope.ts).
   */
  readonly pageScope?: { readonly subtrees: readonly PageScopeEntryShape[] };
  /**
   * v2 D1.1 (ADR 0039), bridge code only: the batch becomes ONE proposal for the owner whatever the principal's scope.
   * v3 F12 (ADR 0081): only the automation engine's codes at Propose (and a change the bridge only records, at scope
   * `propose`) set it; an agent at scope `write` and the owner's own dashboard actions run directly. The policy gate and
   * the write guard still run, and a deny still denies. Nothing an agent sends reaches it (`lk_api_batch` never sets it).
   */
  readonly forceProposal?: boolean;
  /**
   * v3 F2 (ADR 0049 decision 10), bridge code only: the batch places an image staged on the bridge's server (it uploads
   * it into its final folder). At scope `propose` the policy gate makes it a proposal, where any other upload is refused.
   */
  readonly stagedPlacement?: boolean;
  /** v3 F3c (ADR 0051 decision 1): the caller's Last Major Revision override (absent: `auto`, the rule decides). */
  readonly lastMajorRevision?: LmrMode;
  /** v3 F3d (ADR 0058), bridge code only: the job can be resumed after it stops part-way (see `ResumableShape`). */
  readonly resumable?: ResumableShape;
  /** v3 F3d (ADR 0058), bridge code only: the job waits before its first step until this holds. */
  readonly waitFor?: WaitForShape;
}

/** C2d: one entry of `BatchSubmit.pageScope` (src/policy/page-scope.ts has the logic). */
export interface PageScopeEntryShape {
  readonly step?: number;
  readonly rootId: string;
  readonly label: string;
  readonly pages: readonly {
    readonly id: string;
    readonly parentId: string | null;
    readonly name?: string | null;
  }[];
}

/**
 * v2 C2c (ADR 0035): what a lifecycle job declares it changes. The lifecycle guard allows exactly these changes of these
 * pages (and no others), so even bridge code cannot make an undeclared one. `tool` names the tool for refusals.
 */
export interface LifecycleMarker {
  readonly tool: string;
  /**
   * `true`: the four lifecycle tools, which always need the owner's canonical approval at every scope (and a create of
   * an Authoritative page).
   */
  readonly canonical: boolean;
  /** Why it needs canonical approval, in words (default: it changes a page's lifecycle state). */
  readonly reason?: string;
  readonly pages: readonly {
    readonly id: string;
    /** The lifecycle state the page moves to (`working`, `archived`, `authoritative`), or null for none (the index). */
    readonly to: 'authoritative' | 'working' | 'archived' | null;
  }[];
}

export interface PaginateSubmit {
  readonly kind: 'paginate_all';
  readonly project: string;
  readonly op: string;
  readonly params?: OpParams;
  /** Lower caps than the engine's (never higher). */
  readonly maxItems?: number;
  readonly maxPages?: number;
  readonly priority?: PriorityClass;
  readonly origin: JobOrigin;
  readonly title?: string;
}

/**
 * An image upload (PLAN §4 rule 5): `createImageUpload`, the signed-URL PUT (a custom step, not an LK call), then
 * `createImageAsset`. The bytes are checked by the caller (type, size, magic bytes) and stored with the PUT step so a
 * restart can send them again.
 */
export interface UploadImageSubmit {
  readonly kind: 'upload_image';
  readonly project: string;
  readonly contentType: string;
  /** Exactly the number of bytes in `dataBase64`. */
  readonly contentLength: number;
  /** Lowercase hex SHA-256 of the bytes; sent to LK so storage rejects a mismatch. */
  readonly contentHash?: string;
  readonly dataBase64: string;
  readonly name: string;
  readonly description?: string;
  /** The folder the asset goes in (root if omitted); with `createFolders`, the folder the first new folder goes in. */
  readonly folderId?: string;
  readonly priority?: PriorityClass;
  readonly origin: JobOrigin;
  readonly title?: string;
  /**
   * v2 D3 (ADR 0041): folders created first, in order, each inside the one before (the first inside `folderId`, or the
   * root); the asset then goes in the last one.
   */
  readonly createFolders?: readonly string[];
  /**
   * v2 D3: after createImageAsset, download the stored file (anonymously, from the asset host) and compare its SHA-256
   * with `contentHash` (the `upload_image.verify` step). A mismatch or a failed download is recorded, never retried, and
   * does not fail the job.
   */
  readonly verifyStored?: boolean;
  /** v2 D3: then hide the new asset (`updateAsset` with `isHidden: true`): a staged image. */
  readonly hide?: boolean;
  /**
   * v2 D3, bridge code only: the upload goes to the project's staging folder, hidden, and is placed later by a separate
   * job or proposal. The policy gate lets a `propose`-scope connection do this (the proposal then holds no bytes).
   * Requires `hide` and `verifyStored`.
   */
  readonly staging?: boolean;
}

export type SubmitRequest = BatchSubmit | PaginateSubmit | UploadImageSubmit;

export interface SubmitResult {
  readonly jobId: string;
  readonly status: JobStatus;
  /** Projected completion (ms since epoch) from governor.estimate, or null when unknown (writes paused, etc.). */
  readonly eta: number | null;
  /** v3 F3c (ADR 0051): what the Last Major Revision rule decided for this request, in words (when it applied). */
  readonly lastMajorRevision?: string;
}

export type RunResult =
  | {
      readonly status: 'succeeded';
      /** Null for inline reads (they are not recorded as jobs). */
      readonly jobId: string | null;
      readonly result: unknown;
      readonly requestIds: readonly string[];
      /** v3 F3c (ADR 0051): what the Last Major Revision rule decided for this write, in words (when it applied). */
      readonly lastMajorRevision?: string;
    }
  | {
      readonly status: 'queued' | 'waiting_budget';
      readonly jobId: string;
      readonly eta: number | null;
      readonly reason: 'estimate' | 'budget' | 'writes_paused' | 'read_only' | 'project_unavailable';
      readonly lastMajorRevision?: string;
    }
  | ProposalCaptured;

/** The policy gate asked for approval: nothing was queued; the proposal sink holds the work. */
export interface ProposalCaptured {
  readonly status: 'proposal_captured';
  readonly proposalId: string;
  /** One line describing what was proposed, when the sink gives one. */
  readonly summary?: string;
  /**
   * v2 C2a: the write makes a protected canonical change, so it became a proposal whatever the caller's scope, and only
   * the owner's "Approve and accept as canon" can run it. `reason` says which change.
   */
  readonly canonical?: { readonly reason: string; readonly changes: readonly unknown[] };
  /**
   * v3 F3.4 (ADR 0055): the write would have run directly at scope `write`, but the profile's safety rails made it a
   * proposal: which rail, in words (`proposed because: bulk change (14 pages > 10)`).
   */
  readonly proposedBecause?: string;
}

export interface JobError {
  readonly name: string;
  readonly code: string | undefined;
  readonly message: string;
  readonly status?: number | undefined;
  readonly requestId?: string | undefined;
  readonly classification?: string | undefined;
  readonly stepNo?: number | undefined;
  readonly [key: string]: unknown;
}

export interface JobView {
  readonly id: string;
  /** v2 A1: the LegendKeeper id of the project the job works on. */
  readonly projectId: string;
  readonly kind: JobKind;
  readonly title: string;
  readonly origin: JobOrigin;
  /** Copies of `origin.principal` / `origin.approvedBy`, as stored in their own columns. */
  readonly principalId: string;
  readonly profile: string;
  readonly approvedBy: string | null;
  readonly priority: PriorityClass;
  readonly status: JobStatus;
  readonly onError: OnError;
  readonly progress: {
    readonly stepsDone: number;
    readonly stepsTotal: number;
    readonly stepsFailed: number;
  };
  readonly currentStep: number | null;
  readonly resumeAt: number | null;
  readonly waitReason: Record<string, unknown> | null;
  readonly pauseRequested: boolean;
  readonly cancelRequested: boolean;
  /**
   * CR-2026-11-R3, R3-54 (ADR 0061 part B decision 3): who asked the job to stop: 'owner' (the dashboard), 'system', or
   * the principal id of the agent that cancelled its own job; null when no cancel was asked (or before it was recorded).
   */
  readonly cancelledBy?: string | null;
  /** Set when a step ended `uncertain`: the UI flags the job for a person to check. */
  readonly uncertain: boolean;
  readonly lastError: JobError | null;
  readonly result: Record<string, unknown> | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface StepView {
  readonly jobId: string;
  readonly projectId: string;
  readonly stepNo: number;
  readonly opId: string;
  readonly opKind: OperationKind;
  readonly params: OpParams | null;
  readonly paramsArtifactId: string | null;
  readonly paramsHash: string;
  readonly options: StepOptions;
  readonly attempt0: number;
  readonly idempotencyKey: string | null;
  readonly clientIds: readonly string[];
  readonly ifMatch: string | null;
  readonly status: StepStatus;
  readonly attempts: number;
  readonly maybeSent: boolean;
  readonly requestIds: readonly string[];
  readonly resultSummary: unknown;
  readonly resultArtifactId: string | null;
  readonly error: JobError | null;
  readonly firstSentAt: number | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface JobWithSteps extends JobView {
  readonly steps: readonly StepView[];
  readonly artifacts: readonly ArtifactView[];
}

export interface ArtifactView {
  readonly id: string;
  readonly jobId: string;
  readonly projectId: string;
  readonly stepNo: number | null;
  readonly kind: 'params' | 'result' | 'items';
  readonly itemCount: number;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly truncatedReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WriterSlotView {
  readonly slot: number;
  readonly state: 'idle' | 'busy';
  readonly projectId?: string;
  readonly jobId?: string;
  readonly stepNo?: number;
  readonly opId?: string;
  readonly principalId?: string;
  readonly profile?: string;
  readonly lockKey?: string | null;
  readonly resourceId?: string | null;
  readonly documentId?: string | null;
  readonly since?: number;
}

export interface WritersView {
  readonly max: number;
  readonly busy: number;
  readonly slots: readonly WriterSlotView[];
  /** Steps waiting for a slot, oldest first. They are served round-robin across projects, then oldest first (v2 A1). */
  readonly waiting: readonly {
    readonly projectId: string;
    readonly jobId: string;
    readonly stepNo: number;
    readonly opId: string;
  }[];
}

export interface LockView {
  /** `<projectId>:doc:<id>` and so on: locks are per project and per entity (v2 A1). */
  readonly key: string;
  readonly holder: { readonly jobId: string; readonly stepNo: number; readonly since: number };
  readonly waiting: readonly { readonly jobId: string; readonly stepNo: number; readonly since: number }[];
}

export interface ControlsView {
  readonly writesPaused: boolean;
  readonly draining: boolean;
  /** CR-2026-11-R3 (fix A): present (true) while the bridge stops for a restart; it accepts no new work. */
  readonly restarting?: true;
  /**
   * Effective read-only flag: the runtime override if set, else LK_READ_ONLY. Asked for one project
   * (`controls(projectId)`), it is also true when that project's own read-only flag is on (v2 A1).
   */
  readonly readOnly: boolean;
  readonly readOnlyOverride: boolean | null;
  readonly writersMax: number;
  readonly allowMemberAdmin: boolean;
  /** Present when asked for one project: its own flag and whether it is served now (v2 A1). */
  readonly project?: {
    readonly id: string;
    readonly name: string;
    readonly readOnly: boolean;
    readonly available: boolean;
  };
}

export interface JobFilter {
  readonly status?: JobStatus | readonly JobStatus[];
  readonly originKind?: JobOrigin['kind'];
  readonly principalId?: string;
  readonly profile?: string;
  readonly kind?: JobKind;
  /** Only jobs created before this time (ms), for paging back through history. */
  readonly before?: number;
  readonly limit?: number;
}

// ============================================================================================ v2 A2: write observers

/** A write step about to be sent (or re-verified after a restart): what a write observer is told before it runs. */
export interface WriteStepInfo {
  readonly projectId: string;
  readonly jobId: string;
  readonly stepNo: number;
  readonly opId: string;
  /** The step's params as sent (client ids already minted into the body). */
  readonly params: OpParams;
  readonly priority: PriorityClass;
  /** v2 C2a: the step's options (bridge-only ones included), e.g. `deferTreeReread`. */
  readonly options?: StepOptions;
}

/** A write step's final outcome. */
export interface WriteStepResult extends WriteStepInfo {
  readonly outcome: 'succeeded' | 'failed';
  /** A failure that may have applied (the step is `uncertain`). */
  readonly uncertain: boolean;
  /** LegendKeeper's response to a successful step (undefined for a failure). */
  readonly value: unknown;
  /** Aborted when the engine stops: an observer stops its own reads then. */
  readonly signal: AbortSignal;
}

/**
 * v2 A2: told about every write step a job runs (inline writes included), so the repository tree can re-read what a
 * write changed in the same job. `beforeWrite` is synchronous and runs before the step is sent; `afterWrite` is awaited
 * before the job moves on. An observer that throws is logged and never fails the job.
 */
export interface WriteObserver {
  beforeWrite?(info: WriteStepInfo): void;
  afterWrite?(result: WriteStepResult): Promise<void> | void;
  /**
   * v2 E1a (ADR 0042): a read the job made for its own checks (a verify step, the in-step verify of a page write, a check
   * inside the lock, an observer's re-read named with the job), with what LegendKeeper answered. Synchronous and cheap:
   * the snapshot service keeps the reads made after the job's last write, so a change snapshot does not read twice.
   */
  afterRead?(info: ReadInfo): void;
  /**
   * v2 C2a: the job has finished (or stopped for good): re-read now what its `deferTreeReread` steps changed. Awaited
   * inside the job, before it is marked finished.
   */
  flushDeferred?(info: {
    readonly projectId: string;
    readonly jobId: string;
    readonly priority: PriorityClass;
    readonly signal: AbortSignal;
  }): Promise<void> | void;
  /**
   * v2 E1a (ADR 0042): the job is ending (finished, stopped or cancelled), after `flushDeferred`, before it is marked so:
   * the snapshot service takes the change snapshot of what the job wrote here, so it is part of the job (and of what the
   * caller waits for). Awaited; called for every job that reaches an end.
   */
  jobEnding?(info: {
    readonly projectId: string;
    readonly jobId: string;
    readonly priority: PriorityClass;
    readonly signal: AbortSignal;
  }): Promise<void> | void;
}

/** v2 E1a: a read a job made (see `WriteObserver.afterRead`). `value` is undefined for a 404. */
export interface ReadInfo {
  readonly projectId: string;
  readonly jobId: string;
  readonly opId: string;
  readonly params: OpParams;
  readonly value: unknown;
  /** The step whose own write this read shows (made inside that step, after its write: the in-step verify). */
  readonly afterOwnWriteOf?: number;
}

/** Options of `engine.internalRead`. */
export interface InternalReadOptions {
  /** v3 F9 (ADR 0074): P4 for a bulk pass's reads (always patient in the governor). */
  readonly priority: GovernorPriorityClass;
  /** The job the read belongs to (fair share in the governor, and the error record). */
  readonly jobId?: string;
  readonly stepNo?: number;
  readonly signal?: AbortSignal;
  /** A 404 is an answer ("it is gone"), not an error: it is not recorded in the errors table. */
  readonly notFoundIsAnswer?: boolean;
  /**
   * v3 F9 (ADR 0074): the governor's fair-share lane when the read names no job (calls of one class take turns across
   * lanes): a bulk pass's own id, so two passes at P4 share it. Ignored when `jobId` is given (the job is the lane).
   */
  readonly lane?: string;
  /** v3 F9 review: first claim within its class (`ExecuteRequest.firstClaim`): the full snapshot's reads. */
  readonly firstClaim?: boolean;
}

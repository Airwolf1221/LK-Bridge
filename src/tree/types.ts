/** Shared types of the repository tree (v2 A2, docs/tree.md, ADR 0025). */

/**
 * `root` is the AI REPOSITORY page itself; every other node is classified by its name's prefix. v2 C2c (ADR 0035): the
 * page lifecycle adds `bwrk` (`[BWRK]`, a Working page) and `barc` (`[BARC]`, an Archived page) beside `bsrc`
 * (`[BSRC]`, an Authoritative page in its normal place).
 */
export type NodeKind = 'root' | 'index' | 'bsrc' | 'bwrk' | 'barc' | 'unclassified';

/** v2 C2c: the kinds of page (not index, not root, not unclassified): one per lifecycle state. */
export type PageKind = 'bsrc' | 'bwrk' | 'barc';

/**
 * The tree of one project:
 * - `not_configured`: no AI REPOSITORY root is set; the tree does nothing;
 * - `not_built`: a root is set but its first build has not completed (or the root changed);
 * - `building`: a build is running (its listing, or reading every node's properties);
 * - `ready`: built and confirmed by a pass within the last 26 hours, with no node left stale;
 * - `stale`: built, but some node could not be re-read, or no pass has confirmed it for 26 hours.
 */
export type TreeStatus = 'not_configured' | 'not_built' | 'building' | 'ready' | 'stale';

/** How a node was last read: the first build, an update after the bridge's own write, a sweep or a check. */
export type ReadBy = 'build' | 'write' | 'sweep' | 'check';

export type PassKind = 'build' | 'sweep' | 'check';

export type PassStatus =
  'listing' | 'awaiting_confirmation' | 'reading' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export const ACTIVE_PASS_STATUSES: ReadonlySet<PassStatus> = new Set([
  'listing',
  'awaiting_confirmation',
  'reading',
]);

export interface TreeDocument {
  readonly id: string;
  readonly name: string | null;
  readonly type: string | null;
}

/** One sidebar property, summarised: enough to recompute the catalogue fields and for later audits. */
export interface SidebarBlock {
  readonly id: string | null;
  readonly kind: string;
  readonly title: string | null;
  /** Key-value properties only: each row's key and plain text. */
  readonly rows?: readonly { readonly key: string; readonly text: string }[];
}

export interface CatalogueFields {
  readonly referenceType: string | null;
  readonly scope: string | null;
  readonly indexScope: string | null;
  readonly canonicalDisplayName: string | null;
  /** Whether the key-value property the tree reads (PROPERTIES) exists on the page. */
  readonly propertiesFound: boolean;
}

/** One node of the tree, as the query layer returns it. */
export interface TreeNode {
  readonly id: string;
  readonly rawName: string;
  readonly displayName: string;
  readonly kind: NodeKind;
  /** Null only for the root. */
  readonly parentId: string | null;
  readonly rank: string | null;
  /** 0 for the root, 1 for its children. */
  readonly depth: number;
  /** From the root to this node, both included. */
  readonly path: { readonly ids: readonly string[]; readonly names: readonly string[] };
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  readonly documents: readonly TreeDocument[];
  readonly isHidden: boolean;
  /** Null until the node was read with getResource. */
  readonly isLocked: boolean | null;
  readonly referenceType: string | null;
  readonly scope: string | null;
  readonly indexScope: string | null;
  readonly canonicalDisplayName: string | null;
  /** Null until the node's properties were read. */
  readonly propertiesFound: boolean | null;
  /** The template the bridge created the page from (recorded by C2), or null. */
  readonly templateId: string | null;
  readonly lastReadAt: number;
  readonly lastReadBy: ReadBy;
  /** Its properties have never been read (only its structure is known). */
  readonly propertiesPending: boolean;
  readonly stale: boolean;
  readonly staleReason: string | null;
}

/** What every query states about the tree it answered from. */
export interface TreeMeta {
  readonly projectId: string;
  readonly status: TreeStatus;
  /** Why the status is not `ready`, in plain language, or null. */
  readonly reason: string | null;
  readonly rootId: string | null;
  /** The snapshot time of the last pass that completed (build, sweep or check), or null. */
  readonly confirmedAt: number | null;
  readonly confirmedBy: PassKind | null;
  readonly staleNodes: number;
  /** Re-reads after the bridge's own writes that have not completed (failed, or still in flight). */
  readonly pendingRereads: number;
}

export interface TreeAnswer<T> {
  readonly tree: TreeMeta;
  readonly data: T;
}

/** A name lookup hit: the node, and which of its names matched. */
export interface NameMatch {
  readonly node: TreeNode;
  readonly field: NameField;
  readonly name: string;
}

export type NameField = 'raw' | 'display' | 'alias' | 'canonical';

/** What one listResources item or one getResource response says about a resource. */
export interface Observation {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly rank: string | null;
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  readonly documents: readonly TreeDocument[];
  readonly isHidden: boolean;
  /** getResource only: what a listing does not show. */
  readonly props?: { readonly isLocked: boolean; readonly sidebar: readonly SidebarBlock[] };
}

export interface PassView {
  readonly id: string;
  readonly projectId: string;
  readonly kind: PassKind;
  readonly trigger: string;
  readonly status: PassStatus;
  readonly rootId: string;
  readonly snapshotAt: number | null;
  readonly pages: number;
  readonly listed: number;
  readonly subtree: number | null;
  readonly toRead: number | null;
  readonly readOk: number;
  readonly readFailed: number;
  readonly requests: number;
  readonly added: number;
  readonly removed: number;
  readonly corrected: number;
  readonly estimate: BuildEstimate | null;
  readonly summary: string | null;
  readonly error: string | null;
  readonly jobId: string | null;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly finishedAt: number | null;
}

/** The estimate shown before a build starts reading (bridge_estimate's arithmetic, at P3). */
export interface BuildEstimate {
  readonly listed: number;
  readonly subtree: number;
  /** getResource reads still to make (one per node under the root, the root included). */
  readonly reads: number;
  /** Listing requests already made. */
  readonly listingRequests: number;
  readonly wallClockMs: number;
  readonly fitsInDailyBudget: boolean;
  readonly tightestTier: string | null;
  readonly at: number;
}

export interface CorrectionEntry {
  readonly id: number;
  readonly at: number;
  readonly source: 'build' | 'sweep' | 'check' | 'write';
  readonly passId: string | null;
  readonly nodeId: string;
  readonly nodeName: string | null;
  readonly change: 'added' | 'removed' | 'updated' | 'reread_failed';
  readonly field: string | null;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly detail: string | null;
}

export interface RootSuggestion {
  readonly at: number;
  /** Top-level resources named "AI REPOSITORY" (case and surrounding spaces ignored). */
  readonly candidates: readonly { readonly id: string; readonly name: string }[];
  /** The one to use, when exactly one was found. */
  readonly suggested: string | null;
  readonly listed: number;
  readonly error: string | null;
}

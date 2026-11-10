/** Shared types of the asset tree (v2 A4, docs/assets.md, ADR 0027). */

/**
 * The asset tree of one project:
 * - `not_built`: the first build has not completed;
 * - `building`: the first build is walking the folders (after its estimate was confirmed);
 * - `ready`: built and confirmed by a pass within the last 26 hours, with nothing stale;
 * - `stale`: built, but something could not be confirmed (a re-read or a folder listing failed), or no pass has
 *   confirmed it for 26 hours.
 */
export type AssetTreeStatus = 'not_built' | 'building' | 'ready' | 'stale';

/** How a row was last read: the first build, an update after the bridge's own write, a refresh or a check. */
export type AssetReadBy = 'build' | 'write' | 'refresh' | 'check';

export type AssetPassKind = 'build' | 'refresh' | 'check';

export type AssetPassStatus =
  'preparing' | 'awaiting_confirmation' | 'walking' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export const ACTIVE_ASSET_PASS_STATUSES: ReadonlySet<AssetPassStatus> = new Set([
  'preparing',
  'awaiting_confirmation',
  'walking',
]);

/** A folder of the library, as the query layer returns it. */
export interface AssetFolder {
  readonly id: string;
  readonly name: string;
  /** Null: directly in the library's root. */
  readonly parentId: string | null;
  /** 1 for a folder in the root. */
  readonly depth: number;
  /** From the top folder to this one, both included. */
  readonly path: { readonly ids: readonly string[]; readonly names: readonly string[] };
  readonly isHidden: boolean;
  readonly lastReadAt: number;
  readonly lastReadBy: AssetReadBy;
  readonly stale: boolean;
  readonly staleReason: string | null;
}

/** An asset that is not a folder (an image, a map, audio). */
export interface AssetItem {
  readonly id: string;
  readonly name: string;
  /** Null: directly in the library's root. */
  readonly folderId: string | null;
  /** LegendKeeper's type: `IMAGE`, `MAP`, `AUDIO`. */
  readonly type: string;
  readonly url: string | null;
  readonly width: number | null;
  readonly height: number | null;
  /** Bytes, when LegendKeeper says (its Asset carries no size today, so usually null). */
  readonly size: number | null;
  /** Left empty until E1 downloads the image for a backup. */
  readonly sha256: string | null;
  readonly isHidden: boolean;
  readonly createdAt: string | null;
  readonly lastReadAt: number;
  readonly lastReadBy: AssetReadBy;
  readonly stale: boolean;
  readonly staleReason: string | null;
}

/** What every query states about the model it answered from. */
export interface AssetMeta {
  readonly projectId: string;
  readonly status: AssetTreeStatus;
  /** Why the status is not `ready`, in plain language, or null. */
  readonly reason: string | null;
  /** The start of the last pass that completed (build, refresh or check), or null. */
  readonly confirmedAt: number | null;
  readonly confirmedBy: AssetPassKind | null;
  readonly staleRows: number;
  /** Re-reads after the bridge's own writes that have not completed (failed, or still in flight). */
  readonly pendingRereads: number;
}

export interface AssetAnswer<T> {
  readonly tree: AssetMeta;
  readonly data: T;
}

/** What one listAssets item or one getAsset response says about an asset or folder. */
export interface AssetObservation {
  readonly id: string;
  readonly name: string;
  readonly folderId: string | null;
  /** LegendKeeper's type (`FOLDER` for a folder). */
  readonly type: string;
  readonly url: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly size: number | null;
  readonly isHidden: boolean;
  readonly createdAt: string | null;
}

export interface AssetPassView {
  readonly id: string;
  readonly projectId: string;
  readonly kind: AssetPassKind;
  readonly trigger: string;
  readonly status: AssetPassStatus;
  readonly snapshotAt: number | null;
  readonly foldersFound: number;
  readonly foldersDone: number;
  readonly foldersFailed: number;
  readonly listed: number;
  readonly pages: number;
  readonly requests: number;
  readonly verified: number;
  readonly added: number;
  readonly removed: number;
  readonly corrected: number;
  readonly estimate: AssetBuildEstimate | null;
  readonly summary: string | null;
  readonly error: string | null;
  readonly jobId: string | null;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly finishedAt: number | null;
}

/**
 * The estimate shown before a build walks past the root level. Folders are only found by listing their parent, so the
 * total cannot be known in advance: the walk makes ONE REQUEST PER FOLDER (plus one more for every further 100 items
 * in a folder). What is known after the root level is a minimum; a rebuild also knows the last inventory.
 */
export interface AssetBuildEstimate {
  /** Folders and assets seen at the root level. */
  readonly rootFolders: number;
  readonly rootAssets: number;
  /** Requests made so far (the root level). */
  readonly requestsSoFar: number;
  /** At least this many more: one per folder found so far. */
  readonly minRequestsRemaining: number;
  /** A better figure when an earlier inventory exists (its folders and pages), else equal to the minimum. */
  readonly likelyRequestsRemaining: number;
  /** What the likely figure is based on. */
  readonly basis: 'root level only' | 'the previous inventory';
  readonly previousFolders: number | null;
  readonly previousAssets: number | null;
  readonly wallClockMs: number;
  readonly fitsInDailyBudget: boolean;
  readonly tightestTier: string | null;
  readonly at: number;
}

export interface AssetCorrection {
  readonly id: number;
  readonly at: number;
  readonly source: 'build' | 'refresh' | 'check' | 'write';
  readonly passId: string | null;
  readonly itemId: string;
  readonly itemName: string | null;
  readonly itemKind: 'folder' | 'asset';
  readonly change: 'added' | 'removed' | 'updated' | 'reread_failed';
  readonly field: string | null;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly detail: string | null;
}

/** The counts the dashboard shows. */
export interface AssetCounts {
  readonly folders: number;
  readonly assets: number;
  readonly byType: Readonly<Record<string, number>>;
  /** Deepest folder (a folder in the root is at depth 1). */
  readonly maxDepth: number;
  readonly stale: number;
  /** Assets whose SHA-256 is known (E1 fills it). */
  readonly withHash: number;
}

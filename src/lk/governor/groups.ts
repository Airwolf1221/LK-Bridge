/**
 * v2 E5.5 (ADR 0047): LegendKeeper's undocumented per-operation rate tiers.
 *
 * LegendKeeper reports `X-RateLimit-*` for the tier with the fewest requests remaining, and some routes evidently have
 * tiers of their own that the spec's table does not list (about 20 a minute for image uploads and asset creation, about
 * 60 for asset deletes). A header whose limit matches no documented tier is therefore attributed to a tier LEARNED for
 * the operation's rate group, never to `write-min` or any other documented tier, and that learned tier paces only the
 * calls of its group.
 *
 * The groups are explicit. An operation not listed here is a group of its own, named by its operation id.
 */
import type { TierId } from '../registry-types.js';

/** The group of LegendKeeper's asset and image routes. */
export const ASSETS_GROUP = 'assets';

/** The signed upload PUT's operation id (the `upload_image.put` job step; not an LK API call). */
export const UPLOAD_PUT_OP = 'upload_image.put';

/**
 * Operations that share a learned tier, by group. `listAssets` and `getAsset` are reads on the same routes, but nothing
 * shows them drawing the asset tiers (the asset tree's builds read them by the thousand without ever reporting one), so
 * each stays a group of its own until the sandbox probe LIM1 or a header says otherwise.
 */
export const RATE_GROUPS: Readonly<Record<string, string>> = Object.freeze({
  createAssetFolder: ASSETS_GROUP,
  createImageUpload: ASSETS_GROUP,
  createImageAsset: ASSETS_GROUP,
  updateAsset: ASSETS_GROUP,
  deleteAsset: ASSETS_GROUP,
  [UPLOAD_PUT_OP]: ASSETS_GROUP,
});

/**
 * Operations that are paced by their group's learned tiers only once they have been seen carrying LegendKeeper's rate
 * headers themselves. The signed PUT goes to the storage host, which may never count it; until it reports a limit, it
 * does not spend the asset group's budget in the bridge's model.
 */
const JOINS_WHEN_SEEN: ReadonlySet<string> = new Set([UPLOAD_PUT_OP]);

/** The rate group an operation's learned tiers are kept under: its listed group, or its own operation id. */
export function rateGroupOf(opId: string): string {
  return RATE_GROUPS[opId] ?? opId;
}

/** True when the operation is in an explicitly listed group (so a new limit on it is never a documented tier's). */
export function isListedGroupOp(opId: string): boolean {
  return Object.hasOwn(RATE_GROUPS, opId);
}

/** Whether a call of `opId` draws a learned tier of `group` that has seen the operations `seenOps`. */
export function drawsLearnedTier(opId: string, group: string, seenOps: Iterable<string>): boolean {
  if (rateGroupOf(opId) !== group) return false;
  if (!JOINS_WHEN_SEEN.has(opId)) return true;
  for (const op of seenOps) if (op === opId) return true;
  return false;
}

/** How a learned tier is named wherever a tier is named (budget waits, 429 blocks, the estimate's tightest tier). */
export type GroupTierId = `group:${string}`;
/** A documented (configured) tier, or a learned operation tier. */
export type BudgetTierId = TierId | GroupTierId;

export function groupTierId(group: string): GroupTierId {
  return `group:${group}`;
}

/** The group a tier id names, or null for a documented tier. */
export function groupOfTierId(id: string): string | null {
  return id.startsWith('group:') ? id.slice('group:'.length) : null;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** `X-RateLimit-Reset` is in whole seconds, so a reset can lie up to a second beyond its window's end. */
const RESET_ROUNDING_MS = 1000;

/**
 * The window a reset implies (`X-RateLimit-Reset` minus now): up to 60 s a minute, up to 3,600 s an hour, otherwise a
 * day; each with the second the header's rounding to whole seconds can add.
 */
export function windowFromReset(resetInMs: number): number {
  if (resetInMs <= MINUTE_MS + RESET_ROUNDING_MS) return MINUTE_MS;
  if (resetInMs <= HOUR_MS + RESET_ROUNDING_MS) return HOUR_MS;
  return DAY_MS;
}

/** A learned tier expires once its window has passed twice without the header being seen again. */
export const EXPIRY_WINDOWS = 2;

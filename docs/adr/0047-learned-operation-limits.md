# ADR 0047: Learned operation limits, and honest estimates

- Status: **Accepted** (v2 E5.5, 16 November 2026)
- Date: 16 November 2026
- Session: v2 E5.5 (the owner's sampled rehearsal of 15–16 November 2026)
- Changes: [PLAN §5.1](../PLAN.md) "Correction from the server" (how a header is matched to a tier), PLAN §5.4
  (`bridge_estimate`); backlog item 16 (honest estimates). Builds on [ADR 0042](0042-snapshots-restore-rehearsal.md) (the
  rehearsal) and v2 E5.4's pacing note there.
- Migration: `2600` (an index on `steps (project_id, finished_at)`; no data changes).

## Context

The owner's sampled rehearsal of Arkona into the test world estimated about 10 minutes and ran for over 40. The test
world's budget footer read `writes 10/20·min` although LegendKeeper's documented write limit is 120 a minute, and that is
what is configured. The bridge's own budget samples showed the write-minute limit it believed in dropping to 20 just after
each rehearsal started (the steps before each drop: `createAssetFolder`, `createImageUpload`, `createImageAsset`, the
upload PUT and verify, and one `createResource`), to 60 after a rehearsal's root and asset folder were deleted
(`deleteAsset` and `deleteResource`), and back to 120 only at each restart.

LegendKeeper reports `X-RateLimit-Limit/Remaining/Reset` for the tier with the fewest requests remaining (PLAN §1.2). Its
asset and image routes evidently have tiers of their own that the spec's table does not list: about 20 a minute for image
uploads and asset creation, about 60 for asset deletes. `matchTier` found no tier with that limit, fell back to "LK changed
a limit: match by window", picked the shortest window that fits (`write-min`), and `observe` set
`write-min.observedLimit = 20`. `limitOf` takes the lower of configured and observed, and nothing ever cleared it, so
every write in the project was paced at 20 a minute (P3's share: 10) until a restart: about 8 writes a minute once each
write's own time was added. The estimate used 120.

## Decision

1. **An unrecognised limit never lowers a documented tier.** A header is attributed in this order:
   1. a documented tier the call draws whose limit (configured, or one learned earlier) equals the header's: matched as
      before. A genuine change of one of LegendKeeper's documented limits is still learned this way once it is known;
   2. a tier already learned for the operation's **rate group** at that limit;
   3. a documented tier whose limit LegendKeeper changed, only when the header is consistent with it: the window its
      reset implies is that tier's window, and LegendKeeper's count (limit − remaining) is within 2, or 5% of the
      reported limit, of the bridge's own count on the tier (its other calls in flight aside). An operation of a listed
      group (the asset routes) is never taken this way: its own tiers explain any new limit it reports, and at the start
      of a rehearsal both counts are small enough to agree by chance;
   4. otherwise a new **learned operation tier** for the operation's rate group.

   A header at a documented tier's configured limit now clears a limit learned for it earlier, so a wrong guess under
   rule 3 heals at the next ordinary write.

2. **Rate groups are explicit** (`src/lk/governor/groups.ts`): `assets` for `createAssetFolder`, `createImageUpload`,
   `createImageAsset`, `updateAsset`, `deleteAsset` and the signed upload PUT (`upload_image.put`). The PUT joins its
   group's tiers only once it has itself carried LegendKeeper's headers: the storage host may never count it, and until
   then it does not spend the group's budget in the bridge's model. `listAssets` and `getAsset` are reads on the same
   routes, but nothing shows them drawing the asset tiers (the asset tree's builds read them by the thousand without one
   report), so each stays a group of its own. Any other operation is a group of its own operation id.
3. **A learned tier** is keyed by group and limit, so the asset routes' 20 and 60 are two tiers of one group (a call in
   the group draws both: deletes are paced by the 20 too while it lives, which is conservative). Its window is inferred
   from the reset: up to 60 s a minute, up to 3,600 s an hour, otherwise a day, each with the second that the header's
   rounding to whole seconds adds; a later report implying a longer window widens it. It keeps the reported remaining
   and reset, snaps its count to LegendKeeper's at every report as documented tiers do, applies the class's reserve floor
   (at least one call per window), and **paces only the calls of its group**. A 429 attributed to it blocks only its
   group until `Retry-After`, and a long one parks the call with the tier named `group:<name>` (`BudgetWaitError.tier`,
   the `budget-wait` and `throttled` events, `BUDGET_EXHAUSTED`). **It expires when its window has passed twice without
   the header being seen again** (never while it is blocked or has calls in flight). Learned tiers live in memory: a
   restart learns them again at the next report.
4. **`UPLOAD_RATE_EXCEEDED` still blocks the bridge-only `upload` tier**, as before. The `upload` tier is not the home of
   the `assets` group: it is drawn by `createImageUpload`, `createImageAsset` and the PUT only (not by `createAssetFolder`,
   `updateAsset` or `deleteAsset`, whose costs come from the spec), it has no window or limit of its own, and it would
   merge the 20 and the 60 into one figure.
5. **Visible.** The Budgets page lists the learned limits per project (group, operations seen, limit, window, remaining,
   last seen, expiry); `bridge_budget` adds `learnedOperationLimits` when there are any. The footer is unchanged apart
   from ` | blocked <group> <s>s` while a group is blocked. The first sighting of a group and limit is logged once per
   process at info level, naming the project, the operation and the figures.
6. **Honest estimates (backlog 16).** `governor.estimate` uses each tier's effective limit (`limitOf`) and, for the
   operations the caller names (`ops`), the learned tiers of their groups; only those operations are paced by them. A
   write takes at least the project's **measured per-write duration**: the median wall time of its last 200 succeeded
   write and upload steps (`steps`, read at most once a minute), floored at the configured spacing. The estimate says
   which it used (`perWrite`); `bridge_estimate` reports `secondsPerWrite` and where it came from. The rehearsal and
   restore plans name their operations, run the sequential model (each learned group's steps take the longer of their
   pacing and what the group's limit allows), and say which figures they used (`estimate.figures`). The Snapshots page
   shows a running rehearsal's stage, writes and reads done against the plan, the time elapsed and a projected finish;
   the rehearsal saves its counts every few seconds while it runs.

## Consequences

- One undocumented tier can no longer slow every write in a project. The cost is a little model state per group, and a
  group's calls being paced at its learned limit for up to two of its windows after LegendKeeper last reported it.
- The estimate tracks what runs really take; but the median includes whatever pacing the measured steps met, so right
  after a period of slow pacing it reads high until about 200 new write steps have run. The plan says which figure it
  used, so this is visible.
- The real per-operation limits are not documented by LegendKeeper. The sandbox probe LIM1 (the assumptions file) records
  the headers an asset folder, a tiny upload and their deletes answer, as NOTED, so they can be written down.

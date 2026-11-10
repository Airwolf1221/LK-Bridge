# ADR 0024: The repository tree: observation order, per-project serialisation, and how it stays correct

Status: Accepted (v2 session A2, 10 November 2026). Implements PLAN-v2 4.2 (with sections 2, 10.2 and 10.6). Records the
concurrency rules PLAN-v2 asks A2 to record.

## Context

Every v2 tool trusts the repository tree: the bridge's own model of each project's AI REPOSITORY (name resolution,
ordering, placement, search, the Discover tools). It is kept current from four sources that run at the same time:

- the **first build** (a listing of every resource, then `getResource` for each node under the root, at P3);
- **updates after the bridge's own writes** (a `getResource` of what each write changed, in the same job);
- the **hourly structural sweep** (a listing; `getResource` only for nodes it has not read);
- the **daily consistency check** (a listing, then `getResource` for every node).

LegendKeeper does not maintain `updatedAt` reliably (PLAN-v2 1), so freshness cannot come from LegendKeeper's
timestamps. A pass that lists at time T and applies its findings minutes later must not undo what a write changed in
between. A listing paged while resources are added or deleted may skip one (the bridge cannot know how LegendKeeper's
cursor behaves under concurrent changes). And the process may stop at any point, between a write and its re-read, or
in the middle of a 1,500-read build.

## Decision

1. **The tree is per project and fully isolated.** Every row carries `project_id` (migration 0700); names, links and
   nodes are keyed by `(project_id, id)`; every query, pass, re-read and log entry names one project. Settings live on
   the project row (`aiRepositoryRootId` and the names the tree reads: `treePropertiesName`, `treeReferenceTypeRow`,
   `treeScopeRow`, `treeIndexScopeRow`, `treeCanonicalNameRow`; `treeSweepEnabled`), edited on the dashboard
   (audited `project.set_setting`) or with `npm run projects -- set`, and read from the database on every use, so a
   change from the CLI applies without a restart. A changed root discards that project's tree; changed names
   re-derive the catalogue fields from the stored sidebar summary without a read. Until a root is set the tree is
   `not_configured` and does nothing: no reads, no re-reads after writes, passes skip.
2. **Observation order, not wall-clock freshness.** Every read is stamped just before it is sent with an observation
   stamp: the clock in milliseconds, made strictly increasing within the process and starting above every stamp
   already stored (so a restart, or a clock that goes back, never reorders). A pass's snapshot T is a stamp taken when
   its listing starts. Each node keeps the stamp of its structure (`struct_observed_at`: name, parent, rank, tags,
   aliases, documents, hidden) and of its properties (`props_observed_at`: locked, sidebar, catalogue fields); a
   removal leaves a tombstone with its stamp. **An observation never replaces one made later.** Consequences:
   - a sweep or check that listed at T never overwrites a node an after-write update re-read after T, never deletes a
     node the bridge created after T, and never brings back one the bridge deleted after T;
   - a check's `getResource` answered before an after-write re-read of the same page cannot overwrite it;
   - two re-reads of the same page that complete out of order leave the later-sent one.
3. **Updates for one project are serialised.** Every change to a project's tree goes through one queue per project
   (`serial(projectId, fn)`); each change is one SQLite transaction. Network reads happen outside the queue, so a long
   pass never holds back an after-write update: the observation order (2) decides what wins, not who applies last.
   At most one pass per project is active (a unique index); a sweep or check that finds one running is skipped and
   says so.
4. **After a write, re-read; never predict.** The job engine tells write observers (`engine.observeWrites`) before
   each write step is sent and after its final outcome, inside the job. For the 17 operations that can change what the
   tree holds (creates, update, move, delete, restore; property and property-row writes; document create, update,
   delete, restore), the tree re-reads the affected resource(s) with `getResource` at the job's priority and applies
   LegendKeeper's answer. A move into the root, a restore and a template copy with children list and read the
   descendants the tree could not know. A delete removes the subtree once the deleted resource reads as 404 (LegendKeeper
   deletes a resource with live children only with a cascade). A definite failure re-reads nothing; an uncertain one is
   re-read. Page content writes never touch the tree.
5. **A re-read that fails is never silent.** The node is marked stale (with the reason), the failure is written to the
   correction log and the errors table, the tree's status becomes `stale`, and the re-read is retried at P3 (one
   minute, doubling to an hour; only while the project is served, so nothing spins for a stopped project). An
   interrupted re-read (the job cancelled, the engine stopping) counts as failed. The owed re-read is written to
   `tree_pending` **before** the write is sent and removed only once the tree is updated, so a crash between a write
   and its re-read is caught up at the next start (once the step is known to have finished). A completed sweep or check
   settles every failed re-read whose last attempt was stamped before its snapshot. On shutdown the tree stops its
   passes first but keeps following writes until the engine has drained. A root that reads as 404 after a write is
   marked stale, never removed with the whole tree (the next pass then fails, so the owner sees it).
6. **Absence from a listing is not proof of deletion.** A stored node that a pass's listing does not show is kept,
   marked stale, and read by the same pass: only a 404 removes it. A node the listing shows under a parent outside the
   root is removed with its subtree only when the listing shows that parent's whole chain up to a top-level resource;
   otherwise it is marked stale and read. Whenever a read shows a resource under a parent the tree does not hold, the
   parent's ancestors are read one by one until the root or a stored node (inside: they are added) or a top-level
   resource (outside) is reached, so a new folder the listing skipped is never taken for "outside". The root itself
   missing (404) fails the pass and changes nothing; a build whose root is not in the tree at its end does not complete.
7. **Passes run at P3, through the governor.** All reads are the engine's governed `internalRead` (the project's own
   governor; the system principal; LegendKeeper errors recorded, 404s as answers). A long budget wait is waited out
   on the clock instead of failing (a build also waits while its project is not served; a sweep, check or retry fails
   instead, so nothing stays stuck); the governor's P3 floor (half of every tier by default) and its class order (P3
   only while nothing of P1 or P2 waits) keep agents' work first. The build is resumable: the listing's cursor and the
   staged listing are persisted per page, and each node's read is marked with the pass that read it, so a restart
   continues where it stopped (a stale cursor restarts the listing with a new snapshot; a listing still staged is
   reconciled before reading, whatever the pass's status says). A build always stops after its
   listing and shows the estimate (`bridge_estimate`'s arithmetic, at P3) until the owner confirms. Sweeps and checks
   interrupted by a stop end as `interrupted`; the next one starts afresh.
8. **Designed for later sessions (PLAN-v2 10.2).** Nodes are updated in place, never deleted and re-inserted for a
   refresh, so later tables can hang rows on `(project_id, id)`. A3 adds type and taxonomy links in `tree_node_links`
   and builds name resolution on the exact-name helpers (`tree_names`: raw, display, alias, canonical; every match);
   C2 records the template a page came from in `template_id`.

## Review

An independent review (same session, read-only) found eleven ways the first version could end up wrong, stuck or
busy; all are fixed, most with regression tests (`test/tree/review.test.ts`): a retry timer spinning for a project that
is not served; a restart between confirming a build and applying its listing; a pass waiting for ever on a project that
is not served; a subtree removed because the listing skipped its new parent; writes during shutdown not re-read; an
interrupted re-read dropped; owed re-reads settled by the wrong time; the root's 404 after a write wiping the tree;
paths recomputed after every write (now only when the structure changed); a changed root or catalogue names applied
late (in-flight reads for an old root change nothing; the names in use are stored); duplicate re-reads of one write.

## Consequences

- Most questions about the AI REPOSITORY cost no LegendKeeper request. Each write that changes the tree costs one extra
  read (in the same job); a tree-changing write to a page outside the root costs at most one.
- The tree can be `stale` for a while after an outside edit (until the next sweep for structure, the next check for
  properties) or a failed re-read (until the retry or the next sweep). Every query states the status and when the tree
  was last confirmed, so callers decide.
- A page deleted outside the bridge costs one confirming read in the next pass; a deleted subtree is confirmed by its
  top node.
- Standing cost on a project the size of Arkona (about 3,500 resources): a sweep is about 35 listing requests, a check
  about 3,535, a first build the same as a check. The test world (about 1,450 nodes under the root): a build is about
  15 listing requests and 1,453 reads (about 1,470 requests), roughly 9 minutes at P3 with the published limits and an
  otherwise idle key (Arkona: about 23 minutes).
- The maintenance scheduler gained a `background` flag: the tree's sweep and check run alongside the other jobs, so
  the 10-second budget sampler is never held up by a 10-minute check.

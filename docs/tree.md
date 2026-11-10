# The repository tree (v2 A2)

The bridge's own model of each project's **AI REPOSITORY** (PLAN-v2 4.2): every page under the project's AI
REPOSITORY page, with its kind, place, tags, aliases, documents and catalogue fields. Later v2 tools (name resolution,
ordering, the Discover tools) answer from it, so most questions cost no LegendKeeper request. Pages outside the root
are never stored.

Design and concurrency rules: [ADR 0024](adr/0024-repository-tree.md). Source: `src/tree/`. Migration:
`0700_repository_tree.sql`. Tests: `test/tree/`, `test/ui/tree.test.tsx`.

## Setting it up on the server

1. **Set the root.** On the dashboard's **Repository Tree** page, with the project chosen in the sidebar, the bridge
   looks by itself (once, one listing at P3) for a top-level page named "AI REPOSITORY". When it finds exactly one, use
   **Use this root…**. Or set it on the **Projects** page (Settings, _AI REPOSITORY root_, **Edit**), or from the
   server's shell:

   ```bash
   sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run projects -- set test aiRepositoryRootId <resource id>
   ```

   The resource id is the one in the page's LegendKeeper address (`lk://resources/<id>`), or the one the dashboard
   suggests. A change made from the shell applies at once; no restart is needed.

2. **Start the first build.** On the Repository Tree page, **Start the first build…**, then **List the project**. The
   bridge lists every resource (about one request per 100 resources) and stops to show the estimate: how many pages
   are under the root, the requests it will make (one per page) and how long they take at P3. **Start reading**
   begins; the page shows the progress. **Cancel the build…** stops it (what was read is kept).

3. **Check the result.** When it finishes the status is **Ready**: the counts by kind, the deepest level, the
   unclassified pages and a tree you can browse. The finished build is also on the **Jobs** page.

A restart during the build continues where it stopped. The hourly sweep and the nightly check start by themselves once
the tree is built (Maintenance Jobs page).

## What each node holds

| Field                                                                | From                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| id, raw name, display name, kind                                     | the name: `[INDEX] ` → `index`, `[BSRC] ` → `bsrc` (exact prefix, its space included), else `unclassified`; the root is `root` |
| parentId, rank, depth, path (ids and display names, cached)          | the structure (depth 0 is the root, 1 its children)                                                                            |
| tags, aliases, documents (id, name, type), hidden                    | a listing or getResource                                                                                                       |
| locked, Reference Type, Scope, Index Scope, Canonical Display Name   | getResource: the key-value property titled `PROPERTIES` and its rows (names configurable, below)                               |
| sidebar summary                                                      | getResource: every sidebar property's kind and title, and key-value rows as text (for later audits)                            |
| template id                                                          | recorded by C2 for pages the bridge creates from a template (empty until then)                                                 |
| last read (when, and by `build`, `write`, `sweep` or `check`); stale | the tree itself                                                                                                                |

## Status

| Status           | Meaning                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `not_configured` | No AI REPOSITORY root is set. The tree does nothing: no reads, no re-reads after writes; sweeps and checks skip.   |
| `not_built`      | A root is set, but its first build has not completed (or the root changed, which discards the old tree).           |
| `building`       | A build is listing or reading.                                                                                     |
| `ready`          | Built, confirmed by a build, sweep or check within the last 26 hours, and no node is stale.                        |
| `stale`          | Some node could not be confirmed (a re-read failed, or it was missing from a listing), or 26 hours without a pass. |

Every query answer states the status, why it is not ready, and when the tree was last confirmed.

## How it stays current

- **After the bridge's own writes.** For every write that can change the tree (createResource, createManyResources,
  createResourceFromTemplate, updateResource, moveResource, deleteResource, restoreResource, createProperty,
  updateProperty, deleteProperty, createPropertyRow, updatePropertyRow, deletePropertyRow, createDocument,
  updateDocument, deleteDocument, restoreDocument), the job re-reads the affected page with getResource, in the same
  job and at its priority, and the tree stores what LegendKeeper answered. A move into the root, a restore and a
  template copy with children also list and read the descendants. Page content (block) writes do not touch the tree.
  A re-read that fails marks the node stale, is logged, and is retried (one minute, doubling to an hour); the next
  sweep settles it in any case. A crash between a write and its re-read is caught up at the next start.
- **Structural sweep** (`tree-sweep`, hourly, can be switched off per project). One listing of the project (about one
  request per 100 resources): new pages, renames, moves (into, out of and within the root), deletions, tags, aliases
  and documents. It reads with getResource only the pages it has never read and the stale ones (a page missing from
  the listing is read once: a 404 confirms the deletion; a page under a parent the tree does not know has that
  parent's ancestors read until its place is certain).
- **Daily consistency check** (`tree-check`, nightly at 02:30 London time, P3). The listing, then every page with
  getResource: it also finds property changes (Reference Type, Scope, Index Scope, Canonical Display Name, locked).
- **The correction log** (Repository Tree page): each value a sweep or check corrected (old and new), each page it
  added or removed, and each re-read that failed, with the pass that found it. The newest 10,000 entries per project
  are kept.

A sweep or check never undoes what the bridge itself changed after the sweep's listing (ADR 0024).

## Settings (per project)

Edited on the Projects page (audited as `project.set_setting`) or with `npm run projects -- set <project> <key> <value>`
(`-` restores the default). `npm run projects -- settings <project>` shows them.

| Key                    | Default                  | Meaning                                                                    |
| ---------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `aiRepositoryRootId`   | none                     | The AI REPOSITORY page's resource id. Changing it discards the tree.       |
| `treePropertiesName`   | `PROPERTIES`             | The title of the key-value sidebar property the catalogue fields come from |
| `treeReferenceTypeRow` | `Reference Type`         | Row keys read from that property (case and outer spaces ignored)           |
| `treeScopeRow`         | `Scope`                  |                                                                            |
| `treeIndexScopeRow`    | `Index Scope`            |                                                                            |
| `treeCanonicalNameRow` | `Canonical Display Name` |                                                                            |
| `treeSweepEnabled`     | on                       | Off: the hourly sweep skips this project (the check still runs)            |

Changing a property or row name re-derives every node's catalogue fields from the stored sidebar, with no request.

## Cost

- First build: about one listing request per 100 resources, then one getResource per page under the root (the root
  included). The test world (1,453 pages under the root, about 1,470 resources): about 1,470 requests, roughly 9
  minutes at P3 with an otherwise idle key. Arkona (about 3,500): about 3,535 requests, roughly 23 minutes.
- Sweep: the listing (about 15 requests on the test world, 35 on Arkona), plus one read per new, stale or missing page.
- Check: the same as a build.
- After a write: one getResource per affected page (plus listings and reads for descendants that came with it).

Everything runs through the project's own governor. Builds, sweeps, checks and retries run at P3, so they never use more
than the P3 floor allows and always wait for agents' work.

## The query layer (for later sessions)

`runtime.tree.queries` (`src/tree/queries.ts`); no LegendKeeper request. Each method returns `{ tree, data }`, where
`tree` is the status, the reason, the root and when the tree was last confirmed.

- `node(project, id)`, `root(project)`, `children(project, id)` (sibling order), `subtree(project, id, { maxDepth, limit })`,
  `path(project, id)`, `documents(project, id)`;
- `byKind(project, kind)`, `unclassified(project)`, `stale(project)`, `counts(project)`;
- exact-name lookups, every match, case-insensitive unless `caseSensitive: true`: `findByName(project, name, { fields })`
  (raw, display, alias, canonical), `findByRawName`, `findByDisplayName`, `findByAlias`, `findByCanonicalName`. No
  partial or fuzzy matching: A3 builds name resolution on these.

## Dashboard and admin API

The **Repository Tree** page (per project): status, counts by kind, deepest level, the running build's progress and its
estimate, the last build, sweep and check, the unclassified and stale pages, failed re-reads, the correction log, and a
simple browser (one level at a time, with each page's details).

| Route                                                                   | Does                                                                              |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /api/admin/tree?project=`                                          | Everything the page shows; looks for the root by itself when none is set          |
| `GET /api/admin/tree/children?project=&id=`                             | A node (the root by default), its path and its children                           |
| `GET /api/admin/tree/corrections?project=&limit=&before=&source=&pass=` | The correction log, newest first                                                  |
| `POST /api/admin/tree/build?project=`                                   | Starts a build's listing (`202`); audited `tree.build_prepare`                    |
| `POST /api/admin/tree/build/confirm?project=`                           | `{ confirm: true }`: starts reading; audited `tree.build_start` with the estimate |
| `POST /api/admin/tree/build/cancel?project=`                            | `{ confirm: true }`; audited `tree.build_cancel`                                  |
| `POST /api/admin/tree/suggest-root?project=`                            | Looks for the root again (`202`); audited `tree.suggest_root`                     |
| `PUT /api/admin/projects/:name/settings`                                | `{ key, value }` (`null` clears); audited `project.set_setting`                   |

Errors: `409 NOT_CONFIGURED`, `PASS_RUNNING`, `NOTHING_TO_CONFIRM`, `NOTHING_TO_CANCEL`; `400 INVALID_SETTING`.

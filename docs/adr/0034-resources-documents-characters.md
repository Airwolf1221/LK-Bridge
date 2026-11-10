# ADR 0034: The resource, document and character tools, request coordination, factsVersion and character mentions

Status: Accepted (v2 session C2b, 10 November 2026). Implements the Resources and Documents rows of PLAN-v2 section 5,
4.13 (request coordination), section 9 (the old bridge's character rules) and the owner's decisions of 10 November
2026 (deleting an Authoritative page is protected canon; mentions of a character's pages prefer its Core), on C2a's
groundwork (ADR 0032), C1's engine hooks (ADR 0031), A3's registry, placement and resolver (ADR 0026) and A2's tree
(ADR 0025). Migration 1500 is this session's. No decision in PLAN.md or PLAN-v2.md is changed; the choices below fill
the gaps.

## Context

Agents need to make, rename, move, delete and restore pages and documents, and to make characters by the old bridge's
rules, with the same guarantees as `write_page` and `set_facts`: inside the AI REPOSITORY only, one job or one proposal,
every guard again at execution, verified, journalled, never replayed. Three things in LegendKeeper's API shape the
design: `createResourceFromTemplate` takes no properties, and the copy's sidebar has new ids the plan cannot know;
`updateResource` takes no place; and no read gives a version that covers a whole sidebar.

## Decisions

1. **Twelve tools, one shape.** `create_index`, `create_resource`, `create_bare_resource`, `create_many_resources`,
   `create_character`, `update_resource`, `move_resource`, `delete_resource`, `restore_resource`, `create_document`,
   `update_document`, `delete_document`. Each plans with no write (refusing in a typed way), answers a `dryRun` with the
   plan, and submits ONE `batch_ops` job with the bridge's own steps allowed, carrying its high-level operations for a
   proposal (src/mcp/tools/write-job.ts). The policy gate and the write guard decide: a job, or one proposal (scope
   `propose`, or protected canon at any scope). Writes are `access: write`; the destructive ones (`update_*`, `move_*`,
   `delete_*`) are `destructiveHint: true`.
2. **Placement is planned once for a whole request** (src/resources/plan.ts): items are taken parents first,
   depth-first, siblings sorted; each new page gets A3's `slotAmong` neighbour among the siblings that exist before its
   write, in the write itself. Pages without a template go in `createManyResources` calls (one per run; LegendKeeper
   places a page under a parent made in the same call after its earlier siblings and allows it no anchor, so they are
   sent sorted); pages sharing an `after` anchor in one call are sent in reverse, those sharing a `before` anchor in
   order, so they land alphabetical. A page from a template is its own write; whatever it needs is sent first. The plan
   simulates every insertion, so the verify step knows each page's final neighbours.
3. **A rename re-places in the same job, not the same write.** `updateResource` takes no `after`/`before`, so a rename
   that changes the page's place adds one `moveResource` among the same siblings, under the page's lock (a job-level
   lock). Nothing else is ever moved; a rename keeps the page's prefix (a different one is refused: never a
   reclassification).
4. **Facts on a page the same job creates: bound ids** (src/facts/expand.ts `expandNewPageFacts`, engine `bindIds`).
   The facts are planned by C2a's planner on the TEMPLATE's sidebar (one read, cached for the call), so the writes name
   the template's property, row and item ids. A `bridge.expect` check of a new kind, `copy`, reads the new page's
   sidebar in the job, matches it to the template's layout (properties by kind and title in order, rows by key and value
   in rank order, items in order) and returns the template-to-copy id map; each write's `bindIds` replaces
   `path.propertyId`, `path.rowId`, `body.after`, `body.before` and `body.items[].id` from it just before the write is
   sent (stored, so a recovery resends exactly that). A copy that is not the template's layout is a conflict and
   nothing is written. The If-Match chain and the in-step row check (by key and value, no ids) are C2a's. Rejected: two
   jobs (create, then facts) — a proposal could not hold both, and the second would be an unchecked write; reading the
   copy's ids from the create's answer — the copy check reads the page in the job anyway and also proves the layout.
5. **Status `Working`** (the project's `agentDefaultStatus`) is one of those facts, on every page made from a template
   whose key-value property has a Status row; a page without one gets none, and templates carry no defaults (the owner
   confirmed). A Status the caller gives wins; `Authoritative` is judged by the canon guard as any write is.
6. **The canon guard sees a new page as its template** (src/facts/canonical.ts): at entry, after judging a
   `createResourceFromTemplate` as a new page with the template's facts, it seeds the new id's simulated sidebar with
   the template's, so the facts the same request writes to it (with the template's ids) are judged exactly. Inside the
   lock the guard judges the bound write on what is there now, as before.
7. **Deleting an Authoritative page is protected canon** (decided by the owner on 10 November 2026), as a new canon
   rule kind, `delete` (`{ key: "Status", values: ["Authoritative"] }`, seeded by default as `delete-authoritative`;
   migration 1500 adds it once to projects that store their own rules), shown and edited in the dashboard's Canon
   section. The guard judges `deleteResource` on every path: the page's sidebar (live), and with `cascade` every page of
   the subtree (from the tree, else listed live; at most 101 pages read, any beyond or any sidebar it cannot read counts
   as protected). A protected delete becomes a canonical proposal listing which pages; inside the lock the page is read
   again. Restoring needs no canonical approval: it brings back what was approved, and is how a mistaken delete is
   undone. Deleting a document of an Authoritative page is **not** guarded (flagged for the owner).
8. **Verify, cheaply.** New `bridge.verify` targets: `facts` (a page's rows by key and value in rank order and its
   collections' pages, without ids), `gone` (a deleted page), `document` (by id, or by name and type for a document the
   job made, or gone), and `resource` with a `placement` (its exact neighbours by rank). A page whose fields a listing
   shows (name, parent, tags, aliases, hidden) is checked from its parent's listing, one read per 100 siblings shared by
   every page under that parent, so a 100-page batch costs one or two reads to verify, not 100.
9. **`operation_id`** (PLAN-v2 4.13; `operation_ids`, migration 1500): optional on every create; kept per project and
   principal with a SHA-256 of the normalised request (spacing and key order do not count; `project`, `dryRun` and the
   id are left out). It is reserved atomically before planning: the same id and request returns the earlier result (the
   job as it stands now, or the proposal and its state; nothing written twice), a different request is
   `OPERATION_ID_REUSED`, an id still being planned is `OPERATION_IN_PROGRESS`. A dry run or a refusal frees it. Rows
   are kept at least as long as the journal (`max(30, retention + 1)` days).
10. **Duplicate characters** (`request_claims`, migration 1500): a claim per character name key (case, stray prefixes
    and spaces ignored), taken atomically before planning, bound to the job or proposal, and counted while it is being
    planned (five minutes), queued, running, waiting, paused, or a pending (approved, executing) proposal, across
    principals. A second request is `DUPLICATE_REQUEST` naming the first's job or proposal. Once the first has finished,
    a new request finds its page through placement's return-existing (the tree re-read the page when the job ended).
11. **Never replay failed work.** A job that stops part-way answers `WRITTEN_IN_PART` with the writes made, the writes
    not made, and the journal entries; nothing is retried, and the same request with the same `operation_id` returns
    that result.
12. **The template is recorded in the tree at once**: a `createResourceFromTemplate`'s re-read carries the template id
    in its flags and sets the node's `template_id`. A page that gets facts in the same job is re-read once, at the end
    (its create's re-read is deferred and merged with its facts' re-read, as a create).
13. **`factsVersion`** (src/jobs/sidebar-state.ts, src/facts/version.ts): `fv1_` and 24 hex characters of a SHA-256 of
    the sidebar's facts: key-value rows in rank order by id (C2a.1) and link collections' items and filters, properties
    sorted by id, other kinds (TAGS, text fields) left out. The same from `listProperties`, `getProperty`-built and
    `getResource` answers. Returned by `get_resource`, `get_resources`, `set_facts` (`before`, and `after` from the
    verify step's read) and the creates (each new page's, by name). The bridge remembers the state at each version it
    hands out (`facts_versions`, five per page, seven days) so a stale base can say what changed.
14. **`baseFactsVersion` on `set_facts`.** A base that is not the sidebar's version at planning is `VERSION_CONFLICT`
    with `differences` (or `base_unknown`), nothing written. Inside the lock a new `bridge.expect` check, `sidebar`,
    compares the WHOLE sidebar with the state the plan was built on (any change counts, conservative and predictable, as
    `write_page`'s `baseVersion`). The check is `directOnly`: proposal capture leaves it out, and from capture on the
    proposal's own captured state protects it, as before.
15. **Mentions of a character's pages** (decided by the owner on 10 November 2026; `NameResolver.preferredMention`).
    When `[[Name]]` matches several pages that all belong to ONE character (the same subject by `subjectOf`, each with a
    character role from the registry: a Core or Compact Reference by its Reference Type, or the character's `[INDEX]`
    under the character type's root that is neither a taxonomy category nor the unknown-race index), it resolves to the
    Core, else the Reference, else the index, and `write_page` and `set_facts` report it (`mentions`: the name, the page
    chosen, its role, why, and the candidates). Different subjects, a page without a role, or two of the best role stay
    ambiguous. Write targets are never chosen this way: an ambiguous `page` lists each candidate with its role.
16. **Character page names.** The registry's default page-name patterns become `{name} - Character Core` and
    `{name} - Character Reference` (the brief's names); a pattern the owner stored is kept.
17. **Proposals.** A proposal of creates reads nothing at capture for the pages it creates (an earlier operation of the
    same proposal makes them), so approval does not compare them; ids are minted at capture (C2a) and kept. A high-level
    operation may give its page-level summary line (`summaryLabel`): `New page [BSRC] X - Character Core under [INDEX]
X: 6 facts`.

## Consequences

- Costs (measured, test/resources/costs.test.ts): a Core with a new index and one caller fact, 14 reads and 9 writes; a
  Compact with no caller facts, 7 and 6; an existing page returned, 1 read; `create_resource` with two facts and a link,
  8 and 5; a bare page, 2 and 1; a re-placing rename, 6 and 2; a move, 3 and 1; a delete, 4 and 1; a restore, 3 and 1.
  `set_facts` is unchanged (4 reads, 2 writes for two facts) unless `baseFactsVersion` is given (one more read in the
  lock).
- The engine gained `bindIds`, the `copy` and `sidebar` checks and four verify targets; the canon guard the `delete`
  rule and the template seeding; the tree `setTemplate`, a `tombstone` query and merged deferred re-reads; the resolver
  `characterRole` and `preferredMention`.
- **Flagged for the owner:** deleting a map, timeline or board of an Authoritative page removes canonical content
  without canonical approval; the result notes it. Whether it should need approval is the owner's decision.
- **To verify on the test world** (the owner's live checks): that a template copy keeps its template's properties,
  keys and order (the copy check refuses otherwise, writing nothing); that `listResources` by parent gives every
  sibling with its rank (the placement check).

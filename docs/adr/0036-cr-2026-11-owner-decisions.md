# ADR 0036: Owner decisions from the mid-point review (CR-2026-11)

Status: Proposed (CR session, 11 November 2026). **Decisions 1 to 5 and 7 accepted by the owner on 11 November 2026**:
1 to 3 kept as implemented, 4, 5 and 7 implemented in session C2d ([ADR 0037](0037-whole-set-lifecycle-and-page-scoped-ids.md)).
**Decision 6 accepted** (option (a)), recorded by session D1 ([ADR 0038](0038-calendar-engine-and-chronology-sync.md)). Where a fix needed one of these decisions, the safe option is implemented and
marked "implemented". The findings are in [docs/reviews/CR-2026-11.md](../reviews/CR-2026-11.md).

## Context

The mid-point review of the write layer found that the canon and lifecycle guards could be passed by side routes the
owner's rules meant to close (ADR 0032 decision 11, ADR 0035 decision 11). Most fixes only make the existing rules hold
on every route and need no decision. A few go one step further than the rules as written, or leave a choice that
belongs to the owner.

## Decisions for the owner

1. **A page made `[BSRC]` by a route no tool declares is a canonical proposal (implemented, CR-16).** ADR 0035 decision 5
   makes an Authoritative create through the creation tools a canonical proposal. Through `lk_api_write`, `lk_api_batch`
   or `lk_op_*`, a page could be created named `[BSRC] …`, or renamed from a plain name to `[BSRC] …`, directly at scope
   `write`: an Authoritative page by its prefix without the owner's approval. Implemented: such a create or rename becomes
   a canonical proposal at every scope ("Approve and accept as canon" runs it). Alternatives: refuse it outright, naming
   `create_resource` with `status: "authoritative"` or `promote_page`; or allow it as before (the prefix alone is not a
   protected fact). **Accepted by the owner (11 November 2026): kept as implemented.**
2. **A Status written as a page mention (implemented, CR-11).** A mention shows the mentioned page's name, which
   LegendKeeper fills in (a run's `name` is read-only) and which changes when that page is renamed, so the bridge cannot
   judge it. Implemented: the lifecycle guard refuses a page mention in the Status fact (use plain text), and the canon
   guard treats a new mention in any fact a `value` rule names as a protected change. Alternative: resolve the
   mentioned page's name live and judge that, and also guard renames of every page some Status mentions (much more
   reading, and fragile). **Accepted by the owner (11 November 2026): kept as implemented.**
3. **The two lifecycle indexes are changed only by hand (implemented, CR-15).** Renaming, moving or deleting
   `[INDEX] Working` or `[INDEX] Archived` through the bridge, or giving another page one of their names, is refused: a
   rename stopped every lifecycle tool and Working create, a decoy could be confirmed by mistake, moving an index out of
   the repository made the guard lose track of its pages, and a cascade delete of `[INDEX] Working` deleted every Working
   page without approval. The owner changes them in LegendKeeper and confirms them again on the dashboard. Alternative:
   allow it as a canonical proposal. **Accepted by the owner (11 November 2026): kept as implemented.**
4. **Re-authentication for the canon and lifecycle settings (not implemented; recommended).** ADR 0028 asks the owner to
   sign in again (within 5 minutes) for key changes and project removal. Saving the canonical rules (`PUT
/projects/:name/canon`, where `rules: []` switches every protection off), the lifecycle settings (`PUT
/projects/:name/lifecycle`) and raising a connection's scope need only the session. Recommended: add the canon rules
   and the lifecycle settings to ADR 0028's list. "Approve and accept as canon" is frequent and already confirmed in the
   dialog; leave it as it is. **Accepted by the owner (11 November 2026); implemented in C2d:** saving the canon rules
   (any change, a rule switched off and `rules: []` included) and saving the lifecycle settings need the dashboard's
   re-authentication within the last 5 minutes (`REAUTH_REQUIRED` otherwise; the dashboard asks for the password, and
   the authenticator code when one is set up). "Approve and accept as canon" is unchanged.
5. **A canonical approval covers the job as approved, not each page in it (not changed).** "Approve and accept as canon"
   lets the approved job make the protected changes it shows. For a cascade delete, pages added under the deleted page
   between the approval and the job running are deleted too, without a second look (the approval's re-read compares the
   page itself, not its subtree). Everything a cascade deletes comes back with one `restore_resource` of the page. The
   alternative is to bind the approval to the pages it listed and refuse any other protected page found at execution
   (a few lines in the canon guard; a proposal that ends `conflicted` more often). **Accepted by the owner (11 November
   2026), generalised: an approval covers only what it listed; implemented in C2d.** At execution, if a proposal would
   touch any page not in its captured list, it does not run and becomes `conflicted`; pages captured but now gone
   conflict too. It applies to every tool: the pages an operation touches without naming them (a cascade delete's
   subtree, a template copied with its children, a whole lifecycle set) are listed at capture (`pageScope`), again at
   approval, and again inside the lock just before the write (`PageScopeGuard`; for a set, the job's own first check). A
   page added, gone or moved is a conflict, whatever tool made the proposal. A cascade over more than 500 pages is refused
   at capture (delete it in parts).
6. **Deleting a map's, timeline's or board's content (for D1 and D2).** The `delete-document-authoritative` rule makes
   deleting a map, timeline or board of an Authoritative page a canonical proposal. Emptying it is not judged:
   `deleteFeature`, `deleteEvent`, `deleteLane` and `replaceBoardContent` with no shapes. Decide before D1 and D2 build
   their tools whether these are canon too (the rule could take a `contentOps` list).
   **Decided by the owner on 11 November 2026: option (a), accepted.** Adding, changing or deleting timeline events,
   lanes, map features and board shapes on an Authoritative page are ordinary edits: they are not canon-gated, just as
   `write_page` content is not. Only deleting a whole map, timeline or board document of an Authoritative page is
   canonical (C2c's `delete-document-authoritative` rule). Nothing in the guards changes (none of those operations was
   gated); D1's timeline tools follow it ([ADR 0038](0038-calendar-engine-and-chronology-sync.md), decision 17).
7. **The status tags are not guarded (by design; confirm).** ADR 0035 decision 11 guards the prefix, the Status and the
   place; the tags `CANON`, `Working` and `Archived` are not, so a raw `updateResource` can take `CANON` off an
   Authoritative page. The lifecycle-consistency audit (E2) reports such pages. Decide whether the tags should be
   guarded as the prefix is. **Accepted by the owner (11 November 2026): the status tags are guarded; implemented in
   C2d.** `CANON`, `Working` and `Archived` (as the lifecycle settings name them; compared without case, invisible
   characters and look-alikes, as CR-12 and CR-14 fold keys and prefixes) are added or removed only by the lifecycle
   tools and by creates according to their `status`. `update_resource`, `updateResource` on every route (`lk_api_write`,
   `lk_api_batch`, `lk_op_updateResource`) and create bodies that add one are refused (`POLICY_DENIED`), naming the tool
   to use. Every other tag stays free. It is a per-project canon rule (`status-tags`, kind `statusTags`, on by default,
   switchable on the dashboard); migration 1750 adds it to projects that store their own rules.
   `createResourceFromTemplate` takes no tags (the creation tools retag a copy with `updateResource`, declared by their
   lifecycle marker).

## Consequences

- With decisions 1 to 3 as implemented, every side route to a lifecycle or canonical state that the review found is
  refused or proposed; the tools are unchanged.
- Decisions 4, 5 and 7 are built in C2d ([ADR 0037](0037-whole-set-lifecycle-and-page-scoped-ids.md) has the sets they
  also cover). Decision 6 is D1's to record.

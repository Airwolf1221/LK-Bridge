# ADR 0067: v3 F5a: Approved Supplementary Tags, exception rulings, ordering, bulk actions, unknown write outcomes and the caller's cancellations

- Status: **Proposed** (v3 F5a, 23 November 2026). It builds H1, H2, H3, H4, H10 and H11 of the owner-approved design
  [design/F5-orchestration.md](../design/F5-orchestration.md) (APPROVED as written, 23 November 2026, H1 to H12; copied
  into the repository unchanged). H5 (the automation framework) is F5b, H6 to H8 (orchestration) F5c, H9 (geography
  evidence) F5d. Every decision is implemented and tested against the mock LegendKeeper and fixtures; nothing in this
  session touched a live system (no LegendKeeper, no bridge connector, no dashboard, no sandbox, soak, spike, rehearsal
  or round-trip script). Where the design was silent the choice is marked **chosen**.
- Builds on [ADR 0060](0060-v3-f3f-retag-audit-and-apply.md) with [ADR 0061](0061-cr-2026-11-r3-decisions.md) part A
  decisions 5 and 8 (retagging), [ADR 0055](0055-write-scope-review-revert-rails.md),
  [ADR 0057](0057-cr-2026-11-r2-owner-decisions.md) and [ADR 0062](0062-dashboard-sessions-and-step-up.md) with its
  amendment (write scope, Review, Revert, rails, step-up), [ADR 0058](0058-v3-f3d-renames-selective-approval-resume.md)
  (items, selective approval) and PLAN §5.3, §6.3 and §6.4 (the retry matrix, errors, the journal).
- Amends: ADR 0060 decisions 1.5 (a tag outside the grammar), 1.7 (dispositions), 4 (the owner's actions) and 8 (the
  Tagging page); ADR 0052's pinned sections (one more, parsed); PLAN §5.3 (a read's timeout retried once), §6.3 (the
  classification `client`) and §6.4 (a fifth journal outcome, `superseded`, and reconciliation).
- Migrations: `4000_write_outcomes.sql` (the journal rebuilt with the fifth outcome; `write_reconciliations`) and
  `4100_tag_rulings.sql` (the owner's "Keep this tag here" rulings, agents' suggestions of either ruling, the record of
  each "Allow this tag everywhere" edit).
- Pack version: `arkona-2026-11-23-f5a` (the Tagging Standard's "Approved Supplementary Tags" pinned; its list as pack
  data, `retag.supplementary`). It supersedes `arkona-2026-11-21-r4`; the owner approves it on the Packs page.
- Numbered 0067, the next free number.

## H1: the Approved Supplementary Tags

1. **Pinned and parsed.** The tagging-standard source pins a fourth section, "Approved Supplementary Tags" (directly
   after "Excluded Routine Tags" on Arkona). Its list is pack data, `retag.supplementary = { source, section, tags }`,
   seeded from the section's text of 23 November 2026: Cosmology, Chronology, Setting Framework. The section is read by
   its governing name (F4b.1's rule), never by position. **Chosen:** the list is parsed from the sentence "… permitted
   supplementary tags …: A, B and C." (`parseSupplementaryTags`, src/packs/sections.ts): the text after the colon that
   follows "permitted supplementary tags", up to the full stop, split as "A", "A and B", "A, B and C" (a serial comma
   read too). Anything else (no such sentence, two of them, a list that does not read as tags) is not read at all.
2. **Derived at each governance check.** When the section's list differs from the version's, the check makes a NEW pack
   version with the list as the page states it (audited `pack.derive_supplementary`), waiting for the owner's approval
   like any other version: the page is the author's decision recorded, the pack only its derived translation. A
   section that cannot be read refuses the approval (`GOVERNANCE_SECTION_UNPARSABLE`); approving while the check has
   just offered a new version is refused (`NEW_VERSION_OFFERED`: the owner approves the version they see). **Chosen:**
   the list is read only where the source pins the section; a project whose source does not pin it keeps its version's
   list.
3. **In the engine** (`retagPage`): a listed tag present on the page is kept, after the grammar's slots, in its existing
   order, with a `supplementary` rationale slot; never added (the engine adds no tag that is not grammar), never
   proposed for removal (it is recognised before the Excluded Routine Tags, held identity tokens and second
   categories), and not an exception. A page whose only exception was such a tag is a correction or compliant. The two
   lists are never merged: **chosen**, a tag on both is the owner's to settle, an exception kept, saying so.
4. **Drift fails closed as before**, and now also while a newer version waits: a governance source that changed since
   the approval is recorded as drift whenever it is seen (the state `rules_changed` used to hide it), so the approved
   version computes nothing until the owner approves again.
5. **The seven pages** of the live audit of 23 November 2026 (run rtg_a461df416ac3ce1b) are fixtures; with the owner's
   classifications of 22 November all seven are corrections with exactly the owner's arrays
   (`test/packs/f5a-supplementary-engine.test.ts`, end to end in `test/packs/f5a-supplementary.test.ts`).

## H2: the owner's two actions on an exception

1. **"Keep this tag here"** (`POST /tagging/keep-here`, step-up, audited `retag.keep_here`): a ruling stored with the page
   id, the tag, the page's tag array and its SHA-256 (in order), the reason, the date and the owner principal
   (`retag_tag_rulings`). While the page's array is unchanged, the engine keeps the tag like a supplementary tag on
   that page alone; once the array differs, the ruling has lapsed and the exception says so ("the owner's ruling to keep
   it here … lapsed when the page's tags changed"). The ruling is part of the verdict's basis, so a reconciliation
   re-audits the page. Withdrawing it is one click (`POST /tagging/unkeep`, a tightening). **Chosen:** the retag apply's
   own verified write (the correction the audit proposed with the ruling in force) carries the ruling to the new array;
   any other change lapses it. **Chosen:** a tag the grammar places, a supplementary tag, one a rule removes, or a page
   outside the grammar is refused (`NOT_AN_EXCEPTION`); on a held page the tag is accepted (its other tags are not
   judged until the hold is settled).
2. **"Allow this tag everywhere"** (`POST /tagging/allow-everywhere`): the bridge edits the Tagging Standard's section
   to add the tag at the end of its list, keeping the sentence's structure ("Cosmology, Chronology and Setting
   Framework" becomes "Cosmology, Chronology, Setting Framework and Lore"; every other run, mark and attribute of the
   paragraph kept). `dryRun` (one read, no step-up) returns the paragraph before and after; the edit asks for the step-up
   and runs as ONE job of the bridge's (`replaceBlock` of that paragraph, If-Match the version read, journalled with the
   sentence before and after), audited `retag.allow_everywhere` and recorded (`retag_supplementary_edits`). Revert
   applies to it although it was the owner's own (`approvedRevertible`, as for a retag batch). When the job has
   succeeded the governance check runs, so the pack shows the usual "new version to approve". **Chosen:** refused
   (`TAG_NOT_LISTABLE`) for a tag holding a comma, a full stop, a colon or "and" (the list would no longer read
   unambiguously), and (`SECTION_NOT_EDITABLE`) when the list does not sit inside one plain text run (formatting or a
   mention inside it: the owner edits it in the app). **Chosen:** the ruling's date in the sentence is left as it is
   (the journal and the audit log carry this decision's date).
3. **Agents suggest, never act**: `arkona_retag_audit { suggestRuling: { page, tag, action: keep_here | allow_everywhere,
reason } }` records a suggestion (`retag_ruling_suggestions`, one per page, tag and principal), shown beside the
   exception on the Tagging page's new Exceptions tab. Both service methods refuse any actor but the owner (`NOT_OWNER`).

## H3: ordering in apply

Every correction is in full grammar order: the status tag, then the role's grammar from F3a's tag engine (primary,
specialist, race, culture), then the supplementary tags (and tags kept by a ruling) in their existing order, then any
exception (which blocks the apply anyway). A page whose tags are right but out of order is a correction like any other,
in the same batch item; "already in order" is compliant. The fixture: …, Khayali, Genie becomes …, Genie, Khayali.

## H4: bulk actions

1. **Proposals page.** Filters for state (the tabs), tool (the high-level operation's, else the origin's: `tool` on
   every proposal view), principal and age (`olderThanHours`), sent to the server; the list says how many match in all
   (`total`). Select all on the page, then "Select all N matching the filter" across pages. `POST /proposals/bulk-matching
{ action, filter, expect, confirm }` decides every proposal the filter matches (at most 2,000), refused with
   `PROPOSALS_CHANGED` (409) when the set changed since the count the owner confirmed. "Reject all conflicted" and
   "Reject selected": one confirmation, no step-up (a brake). "Approve selected", by ids or by filter: the step-up when
   any of them triggers a rail (ADR 0062's judgment, unchanged). The Conflicted tab has checkboxes and a reject-only bar.
   Each proposal is decided on its own, in order; **a proposal whose job is running (approved, executing) is never
   approved or rejected** (`PROPOSAL_RUNNING`, passed over before anything is tried) and every failure is listed.
   `POST /proposals/bulk` takes up to 1,000 ids (was 100).
2. **Tagging page.** "Apply all corrections" (`POST /tagging/apply-all`) proposes every deterministic correction of the
   run shown that is not in an open batch, in the usual bounded batches (the pack's batch size, each page an item, each
   batch ONE proposal); more than 10 pages in all is the owner's own bulk change (ADR 0062: the step-up). Then "Approve all
   these batches" (`POST /tagging/approve-batches`, the step-up: a bulk approval) approves them together, each whole,
   one at a time; only retag batch proposals of the project are taken.
3. Every control is a native button, select, checkbox or labelled input (keyboard and screen reader), as the rest of the
   dashboard.

## H10: unknown write outcomes are always reconciled

1. **The reconciler** (src/jobs/reconcile.ts, `OutcomeReconciler`, started with the engine) follows every journal entry
   whose outcome becomes `unknown`, and sweeps those left from before at start-up (an unresolved one is tried once
   more). It settles each:
   - **superseded** (a new journal outcome): later writes to the same document (else the same entity of the page, else
     the page) were applied. Free: the journal alone says so;
   - otherwise it reads the target back (through the governor, P2) and compares by WHAT THE JOB SENT (the step's own
     stored params; the journal's copy only when the job is gone and its body was kept), as R4 did for N3:
     **applied** (the target holds what was sent: a replace's block list, a patch's fields, a delete's entity gone, a
     create's id there), **not_applied** (the version is the one the write was based on; for an entity without a
     version, it still holds its pre-image's values for every field the write named; a create's id not there);
   - otherwise it reads again with back-off (5, 15, 40, 90 and 150 seconds: about five minutes), and if none of these
     can be decided the entry stays `unknown` and its reconciliation is `unresolved`.
2. **An unresolved write is an owner-visible finding**: the audits' new `writes` category, `write_outcome_unknown`
   (error), with the pre-image, the intended change and the high-level operation; the Overview counts the writes with
   an unknown outcome; the Journal page's entry shows its reconciliation. The job's own recovery settling an entry first
   always wins (the reconciler never overwrites an outcome that is no longer unknown, and records who settled it).
   **Chosen:** the reconciler settles the journal entry only; a failed step stays failed (Resume reads it back again).
3. **Entry 3897** (19 November 2026, `replaceDocumentBlocks` on v4t6qncz, unknown for four days) settles as
   **superseded** at the first start-up: entries 5607, 7022, 7323 and 7377 to the same document were applied after it
   (a fixture, `test/jobs/f5a-reconcile.test.ts`).
4. **The error card** says "refused before it was sent" only when the request truly never left: every error now records
   `sent` (`no`: refused before the transport, or a connection never made; `yes`: a response arrived, or the connection
   broke once the request was written: "terminated", a socket reset; `maybe`: the transport failed in a way that does
   not say), and an older record that does not say is "none recorded". A write whose connection broke after sending is
   `ambiguous: true`, and the card says "outcome unknown: it may have applied". **Chosen:** a reply whose body breaks
   off after the headers arrived ("terminated" while reading it, the 23 November error) is `RESPONSE_INTERRUPTED`,
   classification `upstream` (no longer `UNEXPECTED`, `bridge`); for a write it is never re-sent by the governor (it may
   have applied: ambiguous, settled by the reconciler), for a read it is retried as any transient failure. A connection
   refused before anything was sent is no longer marked ambiguous.

## H11: the caller's cancellations and read timeouts

1. A call the client cancelled (its own AbortSignal: in flight, queued or in a retry's back-off) is `ABORTED`, "Cancelled
   by the caller", classification **`client`** (never `bridge`); it is never retried, left out of the Overview's
   "errors in the last hour", and shown on the Errors page as "cancelled by the caller". The governor's own aborts
   (closing) stay `bridge`.
2. A read that times out (the governor's request timer, or the SDK's timer firing while the body is read: the 19 November
   `listProperties` error, which was `UNEXPECTED` and not retryable) is `TIMEOUT`, retryable, and retried ONCE (was up
   to three times like any transient failure), then reported as retryable. Writes keep their rules: a write's timeout
   is retried only as before (with its If-Match or idempotency key), never blindly, and an unknown outcome is
   reconciled (H10).

## Costs (measured against the mock, pinned by the tests)

- H1, H2 (keep here), H3: none (the audit is free). "Allow this tag everywhere": one read (the dry run) and, approved,
  one write and the governance check (one read per source).
- H4: none beyond the proposals' own jobs.
- H10: a superseded entry: none; otherwise one read per attempt, at most five.

## The sandbox check (written, not run; passing on the mock)

`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- tagging-f5a` (test/sandbox/tagging-f5a.ts,
T1 to T6; run in the ordinary suite against the mock by test/sandbox-mock/tagging-f5a.test.ts). On the test world: a
throwaway index and governance page; in the check's TEMPORARY database only, the pack's governance sources pointed at
that page and the pack approved (the test project cannot read Arkona's governance, and the retag job's policy check
reads it); a page tagged CANON, Cosmology classified Law, audited (a correction to CANON, Law, Cosmology) and applied
(read back live); "Keep this tag here" on a second page (compliant), then its tags reordered with the raw client (the
ruling lapses). Clean-up in its `finally` and the test file's `afterAll`.

## Consequences

- The owner approves `arkona-2026-11-23-f5a` on the Packs page (its new pinned section must be found on the Tagging
  Standard), audits, and uses "Apply all corrections" for the seven pages (one batch of seven), then approves it.
- Agents are told (the retag audit's description): the supplementary tags are kept wherever they appear; a ruling on an
  exception is the owner's, which they may suggest.
- One migration rebuilds the write journal (every row, id and sequence kept); its size is the journal's (30 days or
  2 GB at most).

# ADR 0068: v3 F5b: automatic actions for audits, switched on one finding code at a time

- Status: **Proposed** (v3 F5b, 23 November 2026; amendment 1 before merge, the same day). It builds H5 of the owner-approved design
  [design/F5-orchestration.md](../design/F5-orchestration.md) (APPROVED as written, 23 November 2026, H1 to H12; the
  copy in the repository is the owner's, unchanged). H1 to H4, H10 and H11 were F5a ([ADR 0067](0067-v3-f5a-supplementary-tags-rulings-bulk-actions-and-unknown-outcomes.md)).
  Every decision is implemented and tested against the mock LegendKeeper and fixtures; nothing in this session touched a
  live system (no LegendKeeper, no bridge connector, no dashboard, no sandbox, soak, spike, rehearsal or round-trip
  script). Where the design and the brief were silent the choice is marked **chosen**; the codes the owner is asked to
  confirm are in decision 2.
- Governance it satisfies: Arkona's Repository Automation (root tab `xd9gzkel`, read live by the owner on 19 November
  2026): the "Default Boundary" ("A separately approved narrow automation action must identify exact scope,
  prerequisites, transformations, verification, concurrency rules and stop conditions"; "Approval of an earlier
  development decision is not permission for a diagnostic job to execute it"), "Approved Narrow Automations" (the
  block-id sweep's paragraph: "enabling it is the activation, and this approval establishes no wider repair whitelist")
  and "Source Boundaries" ("a future one needs explicit scoped approval"). Each code the owner switches on is that
  explicit, scoped approval, recorded in "Approved Narrow Automations" in the sweep's form.
- Builds on [ADR 0056](0056-block-id-sweep.md) (the first approved narrow automation, and its pattern),
  [ADR 0054](0054-arkona-appraisal-tools-and-full-text-search.md) (the appraisal's `fix` follow-ups and the audits'
  "Propose a fix"), [ADR 0060](0060-v3-f3f-retag-audit-and-apply.md) with ADR 0067 (the retag apply, batches, grammar
  order), [ADR 0065](0065-v3-f4c-fiction.md) (the narrative audit's mechanical fixes),
  [ADR 0055](0055-write-scope-review-revert-rails.md), [ADR 0057](0057-cr-2026-11-r2-owner-decisions.md) and
  [ADR 0062](0062-dashboard-sessions-and-step-up.md) (Review, Revert, rails, step-up), and
  [ADR 0061](0061-cr-2026-11-r3-decisions.md) with CR-2026-11-R3's R3-64 and R3-65 (yielding, the task log, the clean
  shutdown).
- Amends: ADR 0055 decision A (the bridge's own work is still never on the Review page, except the Automation
  principal's direct writes and the owner's governance writes, decision 3); ADR 0060 decision 3.2 (the retag apply's
  "always propose" switch is not asked when the owner's recorded approval of "Apply automatically" runs it, decision 4);
  the policy gate (a third kind of principal, decision 4); the pack's governance sources (Repository Automation, decision
  3); ADR 0062 decision 5 (every automation setting change, "Run automation now" and resuming automation ask for the
  step-up; "Pause all automation" is a brake, one click).
- Migration: `4200_automation.sql` (settings per project and code, the journal of changes, the bridge-wide pause, runs
  and their items, the bridge-managed paragraphs, the governance writes' jobs).
- Pack version: `arkona-2026-11-23-f5b` (the caps as pack data, `automation`; Repository Automation as a governance
  source with its three sections pinned). It supersedes `arkona-2026-11-23-f5a`; the owner approves it on the Packs page.
- Numbered 0068, the next free number.

## Decision 1: the settings

1. **Per project and finding code**: `off` (the default: no row), `propose` (Propose automatically) or `apply` (Apply
   automatically), in the bridge's database (`automation_settings`), never pack data. Everything starts Off.
2. **The owner's alone, with the step-up** (`POST /api/admin/automation/codes/:code`): the service refuses any actor but
   the owner (`NOT_OWNER`); agents have no tool and no route (bridge_info only reports, decision 6). **Chosen:** every
   setting change asks for the step-up, switching off included, as the design says ("changing a setting is an owner
   action with the step-up"); the one-click brake is "Pause all automation" (ADR 0062's rule kept through it).
3. **Journalled** (`automation_changes`): the code, the mode before and after, the principal (`owner`, or `automation`
   when the engine switched it off), the date, the reason, and the governance job it caused with its state (`written`,
   `pending`, `failed`). Also audited `automation.set_mode`. Pausing, resuming and the brake are audited too.
4. **Order of writing.** Switching on writes the governance paragraph FIRST and records the setting only once that job
   has succeeded (the governance always says what is running). Switching off records the setting FIRST (a brake) and
   then amends the paragraph; an amendment that fails is kept (`governance_pending`), shown in red, and tried again
   before the next run.

## Decision 2: the eligible codes (`automatable: "mechanical"`), for the owner to confirm

`src/automation/registry.ts`. A code may carry the flag only when its fix is fully determined by the bridge, with no
choice of text, value or classification. `defineCode` refuses the flag on a code carrying any never-eligible trait, on
one that names no transformation and on one without a read-back target, and the catalogue is built through it.

| Code                          | Plain name                                  | Source    | The one transformation                                                                                                                                         |
| ----------------------------- | ------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `out_of_order`                | Sibling order                               | audits    | one `moveResource` placing the page among its siblings by the ordering rule (alphabetical; in Narratives the narrative order), under the same parent           |
| `lifecycle_tag_not_leading`   | Lifecycle tag first                         | audits    | `updateResource` with the page's own tags reordered, the lifecycle tag first; nothing added, removed or renamed (a page still holding a status tag has no fix) |
| `retag_correction`            | Tag corrections, in grammar order           | retag     | `updateResource` with the retag engine's deterministic correction under the approved policy, in grammar order (H3); never a hold or an exception               |
| `em_dash_name`                | Em dash in a page name                      | appraisal | `updateResource` with the dash in the display name replaced, the prefix kept, re-placed if its place changes; a dash in a subject's name is skipped (a rename) |
| `em_dash_text`                | Em dash in headings or prose                | appraisal | `replaceBlock` of each block holding the dash, the dash replaced, every other character, run and mark kept; a block with an inline icon left as it is          |
| `blank_paragraphs`            | Decorative blank paragraphs                 | appraisal | `deleteBlock` of each top-level paragraph with no visible text; a page made only of them is left                                                               |
| `heading_links`               | Link inside a heading                       | appraisal | `replaceBlock` of each heading holding a mention, the mention written as its plain label; the words and level kept                                             |
| `asset_extension`             | File extension in an asset name             | appraisal | `updateAsset` with the extension dropped; refused when the folder already holds that name; the image, its folder and its placements untouched                  |
| `related_noncurrent`          | Working or Archived page in Related Sources | appraisal | the one link to a Working or Archived page removed from an Authoritative page's Related Sources (set_facts' plan), the linked page read live first             |
| `narrative_number_mismatch`   | Chapter number field                        | audits    | the Chapter Number field set to the number in the page's own name, only when the audit names that one value                                                    |
| `narrative_link_broken`       | Chapter and plan links                      | audits    | the one Chapter or Chapter Plan field set to the page it belongs with                                                                                          |
| `narrative_dateline_mismatch` | Chapter dateline                            | audits    | the chapter's first block made the dateline its own In-world Date gives (or put before the text); every other block echoed exactly; never the prose            |
| `narrative_tags`              | Narrative tags                              | audits    | `updateResource` adding the narrative grammar's missing tags (Narrative, the kind, AU in an AU story); every tag the page holds kept                           |

**Never eligible** (a test asserts the flag cannot be set on any): canon and lifecycle changes
(`au_status_tag_mismatch`, `lifecycle_inconsistent`), holds (`retag_hold`, `tags_held`), exceptions (`retag_exception`,
`tags_outside_definition`), anything with follow-up `judgement` (`purpose_first`, `dependency_noncurrent`), "Pick the
right value" (the consistency codes, `consistency_birth`), deletions (`chronology_event_without_row`,
`duplicate_asset_folders`), splits (`scope_overload`, `line_break_paragraph`), renames (`em_dash_subject_name`), moves
into or out of Narratives (`narrative_lifecycle_page`), images (`asset_not_webp`, `asset_misplaced`), unsupported
blocks (`unsupported_blocks`), and, **chosen**, any code that makes a page (`narrative_main_index_missing`).

**Chosen readings of the design's words:**

- "Deletions" are entities (a page, a document, an event, a lane, a feature, an asset, a folder, a property): removing a
  decorative blank paragraph or one Related Sources link IS the transformation the design lists. Neither meets the
  deletes rail (it counts block and list removals only through the low-level tools, ADR 0057 decision 4).
- "Renames": the em-dash name fix is eligible only where it changes no subject's name (the rename steering's judgement,
  R3-59); a dash in a subject's name is skipped every time (`NOT_MECHANICAL`), so three in a row pause the code. **On an
  Authoritative page, the canon guard makes any rename a canonical change**, so it is caught (decision 4.7) and pauses
  the code: in practice `em_dash_name` applies to Working pages only, and the owner may prefer it on Propose.
- "Images": the image itself (its content, format, folder, placement). An asset's name is metadata; the extension fix
  touches nothing else.
- `missing_required_tags` (the tag-definition document's additive fix, on a project without retag rules),
  `narrative_story_map_not_first` and the identity-fact `set_facts` fixes were not on the design's list and are not
  flagged; the owner can ask for them in a later session.
- `unsupported` blocks: a document holding one is never touched by a document code (skipped `UNSUPPORTED_BLOCKS`), and
  the whole-document dateline write keeps every block it does not change, as every write must.

## Decision 3: the governance record

1. **Repository Automation is a governance source of the pack** (`repository-automation`, resource `cn8v87hh`,
   document `xd9gzkel`), pinning "Default Boundary", "Approved Narrow Automations" and "Source Boundaries".
   **Unverified:** the brief names the tab `xd9gzkel` as the governance root's; the resource is taken to be the root
   that holds the other governance tabs (`cn8v87hh`). If it is not, the pack's approval is refused with the source
   unreadable (fails closed) and the owner corrects it; automation cannot run without it.
2. **The paragraph** (`src/automation/governance.ts`), one per code, plain text in one run, written after the sweep's
   paragraph (the first paragraph of the section naming the "Assign Block IDs Sweep"; the pack's
   `automation.sweepMarker`), after the bridge's earlier paragraphs. It begins with a stable code reference and follows
   the sweep's form, for example:

   > Bridge automation blank_paragraphs: Decorative blank paragraphs (owner approval through the bridge dashboard, 23
   > November 2026). Setting: Apply automatically: after each nightly audit (or when the owner runs it from the
   > dashboard) the bridge writes the change itself as the Automation principal: journalled, listed on the Review page
   > and Revertible. Scope: pages inside the project’s AI REPOSITORY, excluding the Legacy Canon Archive and the Design
   > References; at most 25 pages a run for this code and 100 for every code together. Prerequisites: … Transformation:
   > deleteBlock of each top-level paragraph with no visible text; … Verification: every page is read back after the
   > write and compared with the read made before it: it must be identical apart from the one transformation …
   > Concurrency: one writer per page, holding the page’s lock …; a fresh live read before anything is written …;
   > If-Match on every versioned write; at the lowest priority (P3) … Stop conditions: … History: Apply automatically
   > from 23 November 2026. Enabling it is the activation, and this approval establishes no wider repair whitelist.

   No section is found (or no sweep paragraph): the setting is refused (`GOVERNANCE_SECTION_MISSING`,
   `GOVERNANCE_SWEEP_MISSING`) and nothing changes.

3. **Switching off amends the same paragraph** ("Setting: Off since 24 November 2026 (switched off by the owner): not
   running", or "by the bridge: VERIFICATION_FAILED on …"); its History keeps every change. It is never deleted.
   **Chosen:** a pause (three skips, a guard, the brake) is not written into the governance: the approval stands and the
   bridge holds it, as the dashboard shows; an engine stop (a stop condition) switches the code off and IS written.
4. **The drift choice: the pin recognises the bridge's own writes, and accepts them (chosen over unpinning).** The
   section stays pinned, so any edit made in the app (outside the bridge's paragraphs or inside them) is still drift
   and fails closed. The bridge's own write is a block-by-block job (the document checked inside the lock, If-Match
   from it, its read-back the whole document as planned). Once it has succeeded the bridge reads the document again; if
   it reads EXACTLY as planned (the content read before the write plus the planned paragraph), the approval is carried
   to the new version (`packs.carryApproval`, audited `pack.carry_approval`), and only within these limits (amended
   before merge, see the amendment below):
   - only the document written is touched: another tab of the same page (the Tagging Standard, Source Formatting,
     Character Architecture are other documents of the governance root) is never re-baselined, so an edit there,
     however close in time, is still drift;
   - every source kept on that document must, before the write, be exactly what the owner approved: the approved
     version AND each pinned section's content, by its digest;
   - after the write, every pinned section but the one the bridge wrote into ("Approved Narrow Automations") must be
     unchanged;
   - all or nothing: if any source on the document does not hold, nothing is carried.
     Anything else (an edit made meanwhile, an approval already behind) carries nothing: the pack drifts and no automation
     runs until the owner approves it again; the setting's answer says so (`approvalCarried: false`). Unpinning was not
     chosen because it would let an edit of the approvals themselves go unseen.
5. **The bridge-managed paragraphs** are recorded with their exact text (`automation_paragraphs`). A paragraph that no
   longer reads so (edited in the app), is gone, or carries the marker without a record is reported
   (`GOVERNANCE_EDITED`, with each problem) even after the owner has approved the pack again; no automation runs until
   it is set right, which a setting change of the code does (it rewrites the paragraph from the record).
6. **On the Review page, and Revertible.** Each governance write is journalled and listed on the Review page as the
   owner's (or, for a stop, the Automation principal's). Reverting the paragraph's approval (an "on" or a mode change)
   switches the code off (journalled, `via: revert`), removes or restores the record, and carries the approval over the
   revert the same way; an earlier text that still says the code runs is amended to say it is off. **Chosen:** a write
   that records a code switched off is not Revertible (`GOVERNANCE_OFF_RECORD`): reverting it would make the governance
   say a code runs while it does not; switching it on again is the way back.

## Decision 4: the engine

1. **When.** The maintenance job `automation-run`, daily at 06:30 London (after the night's full snapshot at 00:30 and
   the audit it starts, and after the 06:00 fallback audit when that is on), per project, background, P3; it writes, so
   read-only mode, a writes pause and draining skip it. **Chosen:** the job is switched on by default; with no code on,
   it does nothing. "Run automation now" on the Automation page runs it at once (the step-up).
2. **What runs**: each enabled, unpaused code in the registry's fixed order (decision 2's table). Before anything:
   Pause all automation off; the project writable, writes not paused, not draining; the governance current (decision
   4.8). Each finding (one per page per code) of the project's AI REPOSITORY, the Legacy Canon Archive and the Design
   References left out (by the appraisal's area labels), acknowledged audit findings left out.
3. **Freshness.** Every finding is re-checked live before anything is written: the target is read (the pre-image), and
   the fix is planned by the bridge's existing machinery (`arkona_appraisal_fix`'s, the audits' "Propose a fix", the
   retag apply), which reads live and refuses a finding no longer present (`FIX_STALE`: skipped and recorded). The plan
   is captured, not submitted, so the engine can apply it or gather it. **Chosen:** a page already as the fix would
   leave it (`nothing to do`, for example a sibling moved into place by the previous item) is recorded `ALREADY_DONE`
   and does not count towards the skip streak.
4. **Propose**: ONE proposal per code per run, each page an item (ADR 0058's selective approval), the steps of each
   page's plan renumbered into one job, every page's lock held, the Automation principal's, at P3; the owner approves
   the lot or some of it. Retag corrections are one batch (`retag.batchSize`).
5. **Apply**: one job per page, as the Automation principal (`AUTOMATION_PRINCIPAL`), at P3, with the plan's own checks
   inside the lock, If-Match and its own read-back; journalled, on the Review page and Revertible exactly as an agent's direct write
   is (ADR 0055 decisions A and B). Then the engine's own read-back: the target read again
   and compared with the pre-image, which must be identical apart from the code's declared fields (`changes`), those
   equal to what the plan set, a document identical block by block to the plan, at most one sidebar property changed.
   The retag apply's own verification (name, aliases, parent, documents, sidebar, every document's content) applies too.
   **Chosen:** the pack's "always propose" switch for `arkona_retag_apply` is not asked for an Apply run: the owner's
   recorded approval is the separately approved apply the Tagging Standard calls for; every other caller is unchanged.
6. **The Automation principal and the gate.** The policy gate allows it only from the engine (origin `maintenance`;
   its writes with tool `automation.*`), never over MCP, and judges the safety rails at their defaults for it (never
   bypassed). Its name is "Automation" wherever principals are shown.
7. **Limits and stop conditions.**
   - Caps: `automation.perCode` (25) and `automation.perRun` (100), pack data; a run that reaches the run's cap ends
     `stopped: cap`, the rest waiting for the next run. Every finding planned counts (a skip included).
   - The first failed verification (the job's or the engine's), an unexpected error, or a write whose outcome is unknown
     (a journal entry `unknown`, `UNCERTAIN_OUTCOME`: H10's reconciler settles it) stops the code's run and switches the
     code off, with the reason recorded and shown, and its paragraph amended.
   - Three skipped findings in a row for the same reason pause the code (the streak persists across runs; a success or
     a setting change clears it).
   - Budget: before each page, the governor's estimate at P3 (6 reads, 2 writes); waiting ends the run cleanly
     (`the P3 budget says wait`); a job that goes to `waiting_budget` ends it too and finishes by itself.
   - The guards: a change the canon guard, the lifecycle guard or a rail makes a proposal of stays that ordinary
     proposal, and the code pauses ("not as mechanical as assumed"). **Chosen:** a change a guard REFUSES (the
     lifecycle guard refuses rather than proposes) is offered again as a proposal where the guards allow one, and the
     code pauses (it is not switched off: nothing failed).
8. **Governance drift.** **Chosen:** automation runs only while the whole pack is current (every governance source as
   approved), not only Repository Automation: the retag already fails closed on any drift, and the fixes are planned
   from the approved rules. And never while a bridge-managed paragraph is not as the bridge left it.

## Decision 5: the dashboard

- **Automation** (the Quality group, `ui/src/pages/automation.tsx`): every eligible code with its plain name, an example,
  its transformation, its setting (a labelled select and Change, a confirmation saying what is recorded, then the
  step-up), whether it is paused or was switched off and why, its last run, and what it did or skipped (with links to
  the job or the Proposals page); the recent runs; "Check Repository Automation" (one read of each governance source);
  "Run automation now" (the step-up); and the never-automatic codes. **Pause all automation**: one click, no
  confirmation, no step-up (a brake, for every project); resuming asks for a confirmation and the step-up.
- **Overview**: an "Automation overnight" tile (the last 24 hours): per code, how many pages were applied, proposed,
  skipped, or stopped or caught, with links to the Review page and the Proposals page. Shown once any run has happened,
  or while automation is paused.
- Every control is a native button, select or link with a label (keyboard and screen reader), tested in a real browser.

## Decision 6: agents

`bridge_info` gains `automation`: the codes automated in the project (name, setting, paused), whether automation is
paused, and a note: the bridge fixes these after the nightly audit (or proposes the fix), so do not propose or apply the
same fixes; only the owner changes the settings. No tool changes, reads for modification or suggests a setting.

## Decision 7: memory and shutdown (CR-2026-11-R3)

- The engine is a scheduled task: each run logs `task started` and `task finished` with the memory (`automation:run`,
  besides the maintenance job's own `maintenance:automation-run`).
- On SIGTERM (`stopForRestart`) the engine stops at a step boundary: it checks before each page, a job running is
  parked by the engine at its next step boundary (and its wait ends), and the run is recorded `stopped`; the next run
  plans afresh from the live state, so nothing is written twice. Measured on the mock: repeated runs return to their
  baseline (`test/automation/shutdown-memory.test.ts`: under 8 MB over 8 runs of five codes).

## The sandbox check (written, not run; passing on the mock)

`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- automation-f5b`
(`test/sandbox/automation-f5b.ts`, A1 to A6; run in the ordinary suite against the mock by
`test/sandbox-mock/automation-f5b.test.ts`). On the test world: a throwaway index and governance page (every pinned
heading, "Approved Narrow Automations" holding the sweep's paragraph); in the check's TEMPORARY database only, the
pack's governance sources pointed at it and the pack approved; a page with a decorative blank paragraph and a page
tagged `Law, CANON`, only they snapshotted; both codes set to Apply (each paragraph written after the sweep's, the pack
still current); the run limited to the two pages (`onlyPages`); both fixes read back live; both codes switched Off
(each paragraph amended); clean-up in its `finally` and the test file's `afterAll`. **Found by its mock run:** with
every source on one page, carrying the approval for Repository Automation alone left the other sources drifted; the
approval is now carried for every source kept on the document written, each only where its content is exactly as
approved (amendment 1).

## Costs

- A setting change: one read of each governance source (the drift check), one read of Repository Automation, its job
  (the in-lock check, one write, the read-back) and one more read (the carry).
- A run: one read of each governance source, then per page about two reads (the pre-image and the fix's own) before
  planning; applied, the job (its check, one or two writes, its read-back) and the engine's read-back (one or two
  reads). The audits, the appraisal and the retag audit read the snapshots: free.

## Consequences

- After deploying, the owner approves `arkona-2026-11-23-f5b` on the Packs page (Repository Automation's three pinned
  sections must be found). Every code starts Off: the owner switches codes on one at a time on the Automation page,
  each recorded in "Approved Narrow Automations" before it takes effect, and watches the first night's tile.
- Agents learn from bridge_info which codes are automated, and are told not to duplicate them.
- `em_dash_name` on an Authoritative page is caught by the canon guard (a canonical proposal, the code paused).

## Tests

`test/automation/`: `registry.test.ts` (the eligible list; the never-eligible list cannot be flagged),
`governance.test.ts` (the step-up, agents refused, the journal; the paragraph in the sweep's form after the sweep's;
the amendment; no drift; the Review page and Revert; a manual edit detected), `engine.test.ts` (Apply, Revert, a stale
finding, the caps, a failed verification, a guard's proposal and a guard's refusal, three skips, Propose with items and
a partial approval, the brakes), `mechanical.test.ts` (each code run alone on fixtures: the mock's whole state differs
only by the transformation), `routes.test.ts` (the brake, Run now, runs, the overnight tile, bridge_info),
`shutdown-memory.test.ts` (SIGTERM at a step boundary and the next run; the task log; memory back to baseline);
`test/sandbox-mock/automation-f5b.test.ts`; the browser tests in `test/e2e/dashboard.spec.ts` ("v3 F5b": pause and
resume with the step-up, a code's setting with the step-up, the overnight tile).

## Amendment 1 (before merge, 23 November 2026): the carry-over narrowed, and the project in the address

The owner's two requests on the pull request.

1. **The approval carry-over, by content** (decision 3.4 as amended above). Before, a source kept on the document
   written was carried on a version match alone. Now each such source's pinned sections must read, before the write,
   exactly as approved (by digest), and every pinned section but "Approved Narrow Automations" must be unchanged after
   it; all or nothing. Tests (`test/automation/carry.test.ts`): a clean write carries Repository Automation alone (every
   other source's approval unchanged); the Tagging Standard edited in the app WHILE the bridge writes is drift and blocks
   automation; Repository Automation edited between the bridge's write and its read-back carries nothing; and
   `carryApproval` refuses content that differs from the approved content at the approved version, a write that
   changed another pinned section, an approval at another version, and a co-located source that does not hold.
2. **A dashboard action acts only on the project in view.** The Tagging page sends the selected project in the address
   (`?project=`), but its POST routes read it from the body only, so on a bridge serving several projects every Tagging
   action (the audit, classifications, rulings, "Allow this tag everywhere", batches, "Apply all corrections", "Approve
   all these batches", reconciliations) acted on the DEFAULT project (before this session; it mostly failed with "not
   found", but a ruling or a classification could be stored against the wrong project). Every mutating route that names
   a project now takes it through one rule (`projectFor`, src/admin/routes/util.ts): the address decides; a body naming
   another project is refused (`400 PROJECT_MISMATCH`) before anything is done; with no address, the body's (the pages
   that send it there: Audits, Appraisal, Chronology, Consistency, Maintenance); with neither, the default project, as
   every route. Applied to the Tagging, Audits, Appraisal, Chronology, Consistency, Maintenance and Automation routes.
   The other mutating routes were checked: they read `?project=` already (Review, Jobs, Snapshots, Staging, Tree,
   Registry, Mappings, Assets, Settings' project form), act bridge-wide (writes, settings, packs, security, off-site,
   evaluation, projects), name the project in the path (lifecycle), or address an id unique across projects
   (proposals). Tests (`test/admin/project-address.test.ts`, a two-project bridge, `arkona` the default and `test`):
   each of the eleven Tagging POST routes reaches the retag service with the project in the address and never the
   other; a mismatching body is refused before the service is reached; "Allow this tag everywhere" from `test`'s page is
   refused (`SOURCE_ELSEWHERE`) with Arkona's Tagging Standard untouched, and from Arkona's page edits Arkona's and
   writes nothing to `test`; the other routes refuse a mismatch; and an automation setting from `test`'s page is refused
   while from Arkona's it is written into Arkona's Repository Automation only.

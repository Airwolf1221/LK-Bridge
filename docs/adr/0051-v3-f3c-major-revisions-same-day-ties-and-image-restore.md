# ADR 0051: v3 F3c: Last Major Revision only for real revisions, same-day pairing without guessing, a deleted image restored without the staging folder, and the canon browser test

- Status: **Proposed** (v3 F3c, 16 November 2026). Every decision is implemented and tested against the mock
  LegendKeeper and fixtures. The owner approves the wording of decision 1's rule when this ADR is accepted, so the rule is
  stated below exactly as the code applies it. The choices this session made where the brief left room are marked
  **chosen**.
- Amends: [ADR 0049](0049-v3-f2-last-major-revision-default-project-and-staging.md) decision 2 (its "substantial" test
  is replaced by decision 1 here; its per-project switches stay) and decision 10 (the image restore left in
  LegendKeeper's staging folder is moved onto server staging: decision 3);
  [ADR 0048](0048-chronology-ii.md)'s F2.1 amendments (F2.1-6's "a day with as many rows as events is paired one to one
  in table and timeline order" no longer holds: decision 2); [ADR 0042](0042-snapshots-restore-rehearsal.md) decision 6
  (a restored image is no longer staged hidden in LegendKeeper: decision 3).
- Migrations: none. No decision in PLAN.md or PLAN-v2.md changes.
- Ran beside F3b (setting packs): nothing in `src/packs/`, the pack tools or the Packs page was touched. The pack tools
  plan their own Last Major Revision steps, so they do not take `lastMajorRevision` yet (see "Left").
- Nothing in this session touched a live system: no LegendKeeper, no bridge connector, no dashboard, no sandbox, soak,
  spike or round-trip script.

## Decision 1: Last Major Revision only for real revisions (owner, 16 November 2026)

"Tiny edits like this aren't enough for a major revision." Two Arkona edits set the row under F2: trimming one Subject
row ("Mehrana al-Khalid — one character across two successive incarnations" became "Mehrana al-Khalid"), and fixing
one KCY cell in a chronology table. F2's "substantial" test (every write of a switched-on category) is replaced by this
rule.

### The rule, as implemented (for the owner's approval, word for word)

An edit sets a page's Last Major Revision to today only when it is a **major revision**. It is one when any of these
holds:

1. **Page text.** Each paragraph, list item, heading and table row is one unit. The edit adds, removes or rewrites
   units, and the changed text in the whole edit is **at least 8 words**. Words are compared without punctuation,
   dashes, whitespace or capitalisation (an apostrophe inside a word keeps it one word). A rewritten unit counts the
   larger of the words it adds and the words it removes (a word replaced counts once); an added or removed unit counts
   all its words. A rewrite that changes only punctuation, dashes, whitespace or capitalisation, or is a typo fix,
   counts 0 words. All the edit's text writes on the page are counted together.
2. **A heading.** A heading added, removed or reworded always counts, whatever the number of words, unless the change
   is only punctuation, dashes, whitespace or capitalisation, or a typo fix.
3. **Sidebar facts.** A fact other than the housekeeping keys (Status, Reference Type, Last Major Revision, Supersedes)
   is added with a value, removed, emptied or changed, except in the minor cases below.
4. **Dependencies.** A page is added to or removed from the Dependencies collection. A change to Related Sources (or
   any other link collection) alone does not count.
5. **A chronology row.** A row is added or removed, or its Date or Historical Event (description) cell changes, except
   in the minor cases below. A chronology row needs no 8 words.

**What does not count** (never a major revision on its own):

- **a trimmed value** (a fact or a chronology cell): the new value is the old one cut to a prefix of itself, ending
  where a word ends; or the old one with a descriptive tail removed (everything after a dash, a colon, a semicolon or a
  comma); or with one or more parentheticals removed;
- **only punctuation, dashes, whitespace or capitalisation** changed;
- **a typo fix**: the same number of words, at most 3 of them different, each by at most 2 characters (letters added,
  removed or changed); a changed word that holds a digit is never a typo (a changed number or date is a real change);
- **a KCY-only change** in a chronology row (and the Main table's count);
- **tags, resource aliases, the page name, or a move**;
- **an empty fact added** (**chosen**: a key with no value says nothing yet).

**The override.** Every tool that can set the row takes `lastMajorRevision: "auto" | "set" | "skip"` (default `"auto"`:
the rule decides). `"set"` sets it although the rule would not (a housekeeping key or a switched-off category
included); `"skip"` leaves it although the rule would set it. Either way the row is only ever set on a page that has
one, never on a page the request creates, and never by a restore rehearsal; the lifecycle tools set it themselves, as
before. The answer (`lastMajorRevision`) and any proposal say which applied and why, for example:

- `+ Last Major Revision → date of approval (auto: 12 words of page text changed)`
- `+ Last Major Revision → date of approval (set: lastMajorRevision "set" was asked)`
- `Last Major Revision skipped: Subject: a trimmed value, not a major revision`
- `Last Major Revision skipped: lastMajorRevision "skip" was asked`

**F2's per-project switches stay.** A category switched off is never considered under `"auto"`. The kinds the rule
never counts (names, tags and moves; link collections other than Dependencies; timeline events and map features; an
audit's paragraph split) count as they did in F2 when the owner switches them on for a project. Dependencies moved
from the link-collection switch to the set_facts switch (on by default), since the rule counts them.

### How it is measured

- **When the edit is planned**, from what the calling tool already read (no extra read): `write_page` (the document's
  blocks), `set_facts` (the sidebar), and the chronology tools, whose plan attaches each table row's cells before and
  after to its write (`journalOperation.lmr`). A verdict known at planning decides at once: not a major revision means
  no Last Major Revision steps at all, and the proposal says so.
- **When the job runs**, for a text write whose old text the request did not hold (`lk_api_write`, `lk_api_batch`, a
  restore, the dashboard's text fixes): the `bridge.lmr` step measures the writes it follows from their journal
  pre-images (`replaceDocumentBlocks`, `replaceBlock`, `deleteBlock`) and what they sent (`insertBlock`), and skips the
  row when the rule says no (`Last Major Revision not set: 1 word of page text changed (fewer than 8), not a major
revision`). A write it cannot see into (`updateBlock`, a key-value block's rows) counts, as F2 did. The proposal says
  `(auto: if the edit is a major revision, measured when it runs)`.
- **Code:** the rule is `src/lmr/measure.ts` (pure); the planner `src/lmr/index.ts`; the run-time measure
  `StepExecutor.measureEdit`.

The Arkona cases: the Subject trim is skipped at planning ("a trimmed value"); the KCY fix, made with a block write, is
skipped when it runs ("1 word of page text changed"), and through the chronology tools would be "a KCY-only change in a
chronology row". Nezrin's seven-fact identity rewrite sets it ("Subject: a fact changed").

## Decision 2: same-day pairing without guessing (F2.1's open question)

F2.1 still paired a day with as many rows as events (two or more of each) one to one in table order: a guess. Now,
inside such a day (`matchRowsAndEvents`):

1. a **unique name match** pairs first (F2.1's rule, pass 2: the name names exactly one row of that date, and that row's
   name matches one event);
2. **stored links** are respected (F2.1 decision 2, pass 1, before anything else);
3. what is left on that day pairs by the date alone **only when it is one row and one event**. Two or more of each stay
   unpaired: a tie, reported as F2.1 reports one (each event as **Event in a tie** with its candidate rows and **Pair
   with this row**; a sync of one of the rows refused with `PAIRING_AMBIGUOUS` naming the candidates, with **Use this
   event** and **Make a new event** on the dashboard). Never paired by order.

A day with exactly one row and one event is unchanged. **Chosen:** F2.1's "a plain row beats a qualified anchor" now
applies only to one plain row and one event too (two plain rows against two events would again have been paired by
order). Once the owner pairs one row of a tie, the one row and one event left are unique and pair by the date.

## Decision 3: a deleted image restored without LegendKeeper's staging folder (F2's leftover)

ADR 0049 decision 10 left E1a's image restore uploading into `LK-Bridge staging`, because its proposal needed the new
asset's URL. It now follows F2's model:

- **The bytes stay on the bridge's server.** The snapshot store's bytes, exactly as stored (a PNG stays a PNG), are
  staged on the server (`images/staged/`) with the staged id the Staging page knows. Nothing is sent to LegendKeeper
  before approval.
- **The proposal describes the image, its folder and its name** (`image: { name, path, creates, stagedId }`); the new
  asset's id and URL exist only once it is approved (the job's result and the restore's record keep them:
  `plan.newAsset`).
- **Approval runs ONE job:** the folder found or created by its path (F2's find-or-create, ADR 0049 decision 9; the path
  comes from the snapshot's library, so a folder deleted since is made again), the upload straight into it under its
  name (`ImageService.serverPlacementSteps`, now shared with placing a staged image), the stored file checked, the asset
  read back, and then, when asked (`updateReferences`), each page document that showed the old URL rewritten to the new
  one (one whole-document write with the If-Match read when the restore was proposed; the URL bound in the job:
  `bindAssetUrls`), and each map image set to the new asset (`bindAssetUrls` with `field: "id"`, new).
- **If the page changed in the meantime**, its rewrite is refused by its If-Match (inside the lock, before anything is
  sent) and the job **stops after the upload**: the asset stays where it was put, the job records an
  `image_relink_failed` follow-up (and one for each relink it did not send), the restore's record says
  `image_relink_failed: the image was restored, but N page(s) changed since the proposal and still show the old URL …`
  with the pages (`plan.notRelinked`), and nothing is retried. The job still ends succeeded and the proposal executed.
  The relinks are not captured at proposal time (`judgedInLock`), so a changed page never makes the whole restore
  conflicted.
- **Nothing is ever written to `LK-Bridge staging`**, and no asset is hidden. The `stageIn: 'legendkeeper'` path is
  gone; an image restore is refused while the same image waits for another placement (`RESTORE_PENDING`). **Chosen:** an
  image that was in the library's root goes back to the root (placing a staged image still refuses the root); one whose
  folder is gone and whose path the snapshot does not hold goes to the root, and the notes say so.

## Decision 4: the stale browser test

"v2 C2a … Approve and accept as canon" failed on clean `main`: its fixture wrote Status Working → Authoritative with a
raw `updatePropertyRow`, which the C2c lifecycle guard rightly refuses. The fixture (`test/e2e/server.ts`) now goes
through `promote_page`, over MCP with the proposer's token, as an agent does: it holds the smallest AI REPOSITORY the tool
needs (its root, `[INDEX] Working`, `[INDEX] Archived`, `[INDEX] Characters`, Inae as `[BWRK]` under Working), builds
the repository tree from it and confirms the lifecycle indexes as the owner does, and puts Inae back to Working before
each proposal. The test checks the proposal's pages (renamed to `[BSRC]`, moved under `[INDEX] Characters`), the
canon banner ("Status would be set to Authoritative"), the approval as canon, and the Status read back.

It passed 5 runs out of 5, each with a fresh server, so the CI workflow now runs it in a step of its own
(`npx playwright install --with-deps chromium && npm run test:e2e -- -g "v2 C2a"`). `npm run ci` stays browser-free.
Repeated inside one server (`--repeat-each`) the second run can meet the lifecycle tool's own duplicate-request guard
while the first promotion's record closes: that is the product working, not the test being unstable.

## Consequences

- Fewer Last Major Revision writes: small edits no longer cost the extra write (and read). A large `lk_api_*` text edit
  still costs them; its decision reads the journal (no LegendKeeper request).
- Proposals and answers say what the rule decided. `write_page`, `set_facts`, `lk_api_write`, `lk_api_batch`,
  `create_timeline_event`, `update_timeline_event`, `delete_timeline_event`, `sync_timeline_event` and `restore_snapshot`
  take `lastMajorRevision`.
- Chronology: fewer pairs on busy days, more ties for the owner to settle once (a stored link then holds).
- Image restore: nothing in LegendKeeper until approved; one job instead of a staging upload and a later move.
- Tests: `test/lmr/rule.test.ts` (the rule's boundaries, the planner and the override), `test/lmr/major.test.ts` (the
  Arkona cases, Nezrin, 7 and 8 words, typo and real word, punctuation-only fact, the override both ways),
  `test/lmr/chronology.test.ts`, `test/chronology/pairing.test.ts` and `ties.test.ts` (same-day pairing),
  `test/snapshots/restore.test.ts` (a normal restore, a page changed meanwhile, a missing folder made again; nothing in
  `LK-Bridge staging`), `test/e4/rv3-image.test.ts` (byte for byte), `test/e2e/dashboard.spec.ts` (C2a).

## Left

- The setting-pack tools (F3b's) plan their own Last Major Revision steps and do not apply the rule or take
  `lastMajorRevision` yet; a later session can route them through the planner.
- The canon banner on the Proposals page prints one lifecycle change as raw JSON
  (`{"lifecycle":"promote_page",…}`): cosmetic, in the dashboard, not changed here.
- `updateBlock` keeps no pre-image, so a raw `updateBlock` through `lk_api_*` still counts whatever its size.

## For the owner after deploying

1. Accept decision 1's rule as worded above (or say what to change).
2. On the test world: a one-word `set_facts` typo fix and a 7-word `write_page` append should leave Last Major Revision
   alone (the answer says why); an 8-word append should set it.
3. Re-run the Arkona chronology check: days with two or more rows and as many events now show as ties until paired.
4. Restore a deleted test image with "update references": nothing appears in LegendKeeper until approved, and
   `LK-Bridge staging` is not used.

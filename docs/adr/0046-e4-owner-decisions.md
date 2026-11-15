# ADR 0046: Owner decisions from the second independent review (E4-2026-11)

- Status: **Proposed** (E4 session, 15 November 2026). Where a fix needed one of these decisions, the safe option is
  implemented and marked "implemented"; the owner confirms or changes each.
- Date: 15 November 2026
- Session: v2 E4 (PLAN-v2 phase E, the E4 row)
- The review: [docs/reviews/E4-2026-11.md](../reviews/E4-2026-11.md)
- Builds on: [ADR 0031](0031-write-page.md) (write_page, `PAGE_NOT_WRITABLE`), [ADR 0035](0035-page-lifecycle.md)
  (decision 10: a Working character's index moves with its Core), [ADR 0036](0036-cr-2026-11-owner-decisions.md)
  (decision 4: re-authentication; decision 5: an approval covers only what it listed), [ADR 0042](0042-snapshots-restore-rehearsal.md)
  (decision 6: `RESTORE_NOT_WRITABLE`; change snapshots), [ADR 0043](0043-google-drive-offsite-copy.md) (the off-site copy)
- Migration: none.

## Context

The second independent review found the problems listed in the review document and fixed them. Most fixes only make the
existing rules hold on every route. A few go one step further than a rule as written, change a documented behaviour, or
leave a choice that belongs to the owner. They are listed here.

## Decision 1: block-by-block page writes (implemented; PLAN-v2 E4 row, backlog 1)

`write_page` on a page LegendKeeper's API cannot take back whole (a paragraph with an inline icon) was refused as
`PAGE_NOT_WRITABLE`; a restore of such a page as `RESTORE_NOT_WRITABLE`. **Implemented:**

- the page is written **block by block** (`insertBlock`, `replaceBlock`, `deleteBlock`), touching only the blocks the
  edit changes, as ONE job holding the document's lock: an in-lock check that the page is exactly as planned (by
  content), each write's If-Match chained from the one before (a delete's from its `ETag`, ADR 0039), journal pre-images,
  and a verify of the whole page; inserts first, then replaces, then deletes, so a stop never loses text; the plan is
  replayed on a copy and must give the result exactly before anything is sent (src/pages/blockwise.ts);
- an edit that would change, remove or re-send the icon paragraph itself **stays refused** (`PAGE_NOT_WRITABLE`, reason
  `unwritable`), and so does an edit that moves blocks or would delete an `unsupported` block;
- **the undo**: a block-by-block job that stops part-way is undone automatically by the system principal, but only when
  the page is exactly as the stopped job left it (an outside edit since is never reverted: the stop is then reported
  with the journal entries). An undo is never undone (src/pages/undo.ts);
- restores use the same route: the icon paragraphs stay as the page holds them now, listed under "couldn't be restored
  exactly" when the snapshot held them otherwise.

**Kept as it was (C1):** removing the icon paragraph on purpose with `dropRegions` writes the page whole without it (a
deliberate deletion the agent names, not an edit of the paragraph). The journal keeps the page as it was, but the icon
cannot be written back by the API. Alternative: refuse dropping a keep region that holds an inline icon. **Owner to
confirm.**

## Decision 2: promoting one Core while other pages are under its index (implemented; E4-02)

ADR 0035 decision 10: promoting a Working character's Core moves its `[INDEX]` with it, and "other pages under the index
keep their state and are listed". Since C2d.1 a Working character's specialist pages are made under that index, so
promoting the Core alone took them into canon still Working (two levels down they were not even listed), and a page
added under the index after the proposal was taken along by the approval (ADR 0036 decision 5). **Implemented, the safe
option:** a single-Core `promote_page` whose index holds any other page, at any depth, is refused
(`SET_HAS_OTHER_PAGES`), naming them and the two routes: promote the set with `subtree: true` (one approval for every
page), or move the other pages out first; and the job checks inside the lock that the index still holds only the Core
(a `subtree` check), so a page added since makes the proposal `conflicted`. Alternative: keep the documented move, list
every page at every depth, and keep the in-lock subtree check. **Owner to decide.**

## Decision 3: re-authentication before a backup protection is switched off (implemented; E4-10)

ADR 0036 decision 4 asks for re-authentication before the canon rules or the lifecycle settings are saved; ADR 0043 asks
for it for the off-site copy's keys, client and folder deletes. A stolen dashboard session could still, with one click
each: switch the monthly verify off, lower its sample, push the "stale copy" warning out to 365 days, shorten how long
removed pieces stay on Drive to a day, change the folder, and disable the nightly full snapshot or the snapshot verify.
**Implemented:** each of those needs the dashboard's re-authentication within the last 5 minutes (`REAUTH_REQUIRED`);
the dashboard asks for the password. A change that strengthens a protection, the times, the bandwidth and the transfer
count, and enabling any job, stay one click. Alternative: leave them one click (audited only). **Owner to confirm.**

## Decision 4: a restore the bridge has no record of is judged as a crossing (implemented; E4-01)

`restoreResource` was not judged by the lifecycle guard at all, so restoring a deleted page could bring a `[BWRK]` page
back into canon (after its set was promoted) or an Authoritative one into the archive, with no approval, and an agent
could get a Working page to the top level and then move it into canon. **Implemented:** a restore is judged as a move
from the area the page belongs in by its own state (prefix, status tag) to the area it lands in (its old parent's, or
the top level when that parent is gone); a move of a page whose own state is Working or Archived to anywhere outside
that area is refused, whatever area it is moved from; and every `deleteResource` now keeps the page itself (name,
parent, tags) as its journal pre-image (one more read per delete), so its restore can be judged. **The consequence:** a
page the bridge has no record of deleting (deleted in the app, or before this release) cannot be restored through the
bridge while lifecycle indexes are confirmed; the owner restores it in the LegendKeeper app. Alternative: allow such a
restore unjudged (the old behaviour). **Owner to confirm.**

## Decision 5: a restored image keeps its stored bytes (implemented; E4-07)

ADR 0041 converts every image that comes in to WebP at quality 90. A restore of a deleted image went through the same
conversion, so a PNG or JPEG came back as a lossy WebP, not the image that was deleted. **Implemented:** a restore
uploads the snapshot store's bytes exactly, checked by SHA-256 (recorded as a passthrough). Alternative: convert as
before. **Owner to confirm.**

## Decision 6: timeline change snapshots (not implemented; backlog 6, proposal)

After every timeline write, the change snapshot reads the whole timeline again: 3 reads plus 1 per 100 events (about 7
on an Arkona age timeline of 430 events; a move between ages twice that). The job's own reads cannot be reused: they are
single-event reads, and a timeline piece is the settings, the lanes and every event. A correct cheaper change snapshot
needs a new piece kind (one event) in the manifest, an addition to the store's format, which is E1b's contract with the
off-site copy, the restores, the audits and the history. **Proposal:** keep the full re-read for the move to Arkona
(measured cost: about 7 reads per chronology write, against 60,000 a day) and add an `event` piece in a later session,
with its restore and audit support. Alternative: coalesce the re-reads of one timeline to at most one per 10 minutes.
**Owner to decide.** Nothing changed.

## Decision 7: footnotes are refused (implemented; E3b's open finding)

`text[^1]` with a `[^1]: note` line became a link to "note" (a one-word note) or stray text (a longer one). LegendKeeper
has no footnotes. **Implemented:** the converter refuses any footnote definition (`UNSUPPORTED_MARKDOWN`, naming each),
saying to write the note in the text or under a "Notes" heading, or to escape the bracket. A bare `[^1]` with no
definition stays text. Why refuse rather than warn: a warning leaves the wrong link or text on the page, and agents act
on refusals reliably (E3's evaluation). **Owner to confirm.**

## Decision 8: evaluation scenarios 4 and 21 (implemented; the owner's run of 15 November 2026)

- **Scenario 4:** the repository holds no copy of Asagiri Miyabi's Character Core's real headings (its Markdown fixtures
  are modelled by hand, and no snapshot or tree dump of the test world is committed), so the prompt now asks for "the
  first section (the first heading below the page's title)". **Owner to confirm**, or give the real heading to name.
- **Scenario 21:** `deduplicated: true` on a repeat run is recorded as an expected, correct outcome (the grading notes),
  rather than generating a new image each run, because an assistant producing valid PNG bytes in chat is unreliable and
  deduplication is a behaviour PLAN-v2 4.10 wants. To exercise the upload again, delete the earlier asset first.

## Consequences

- No migration. Two documented behaviours change: `write_page` and restores on icon pages (decision 1), and promoting a
  single Core with pages under its index (decision 2). Both are in the bridge guide, tools.md and the CHANGELOG.
- Every delete reads the page once more (decision 4). Every block-by-block write costs its in-lock read, one read per
  replace or delete, and its verify read.
- The owner's sandbox commands gain the concurrency probe and the maps M6e probe (the review, section 6).

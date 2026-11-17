# Changelog

## Unreleased: v3 F3.4 (17 November 2026): write scope: the Review page, Revert, safety rails, pack tool switches

[ADR 0055](adr/0055-write-scope-review-revert-rails.md) (Proposed). Migration `3200_write_scope.sql`. Nothing was run
against a live system: mocks and fixtures only; the new rehearsal script was run only as a dry run against the mock.

- **Review** (a new page at the top of the sidebar, with a badge): every job an agent ran directly at scope `write`,
  newest first, with the agent, the tool, the summary a proposal would have shown, the pages touched and the same diff;
  **Mark reviewed** and **Mark all reviewed** (confirmed with the count). Approved proposals and pack packages are not
  listed. The Overview page shows the unreviewed count.
- **Revert** (Review page and Jobs page; re-authenticated; audited `job.revert`): one job, run by the system at P1, puts
  back what a finished direct-write job changed: page text block by block, sidebar facts and links, chronology rows and
  their events in step, names, tags, aliases and moves, image placements (the image back on the Staging page from the
  bridge's server and the placed asset's deletion proposed to you; nothing written to `LK-Bridge staging`; the revert
  itself deletes nothing), and the page's previous Last Major Revision when the job changed it. Only what has not changed since; all
  or nothing unless you confirm a partial revert. Never a deletion (`restore_resource`), a proposal, a running job or a
  revert.
- **Safety rails per profile** (Clients & Access, "Always propose"; re-authenticated; audited `profile.set_rails`): even
  at scope `write`, deletes (on), bulk changes over N pages (on, N = 10), renames and moves of pages (off) and asset
  deletes and moves (on) become proposals that say why (`proposed because: bulk change (14 pages > 10)`). The rails only
  add proposals; canon and lifecycle stay proposals whatever they say.
- **Pack tool switches** (Packs page; a new version, approved as usual): `arkona_create_character`, `_owner` and
  `_relationship` always propose; `arkona_add_character_art` and F3c's `arkona_appraisal_fix` follow the agent's scope
  (the appraisal fix reads its switch from the approved version; the Appraisal page's Propose a fix always proposes). The seed
  `arkona-2026-11-17-f3-4` supersedes F3.3's mislabelled `arkona-2026-11-17-f3d`.
- **A direct `updateBlock` is measured for Last Major Revision**: read first (one read) when the page has the row and the
  mode is `auto`, so a typo fix at scope `write` is minor.
- **Write scope audited tool by tool** (ADR 0055's table). Fixed: `updateAsset` keeps a pre-image (one more read); a
  chronology date edit that re-makes its event is not a "delete" for the rail and is revertible; placing a staged image
  is not an "asset move" for the rail.
- **The write-scope rehearsal**: `sudo -u lkbridge /opt/lk-bridge/app/deploy/rehearse-write-scope.sh --project test`
  (`npm run rehearse:write-scope -- --project test`), documented in docs/runbook-deploy.md.
- **The bridge guide** has an "At write scope" section for agents: what is made at once, what is still a proposal and
  why, and that the owner reviews afterwards.
- **CI**: this session made the same change as "CI on pull requests only" below (the owner's request); the merge keeps
  that one copy.
- **In the morning**: merge F3c and F3.4 (whichever finished first goes first; the other merges `main` in), deploy once;
  approve the new pack version on the Packs page; run the rehearsal on the test world (every step should PASS); check the
  rails on Clients & Access, then raise each agent's profile to `write` (the test world first, then Arkona); look at the
  Review page as you go.

## Unreleased: CI on pull requests only (17 November 2026)

The owner is near the GitHub Actions minutes cap, so `.github/workflows/ci.yml` now:

- **runs on pull requests to `main`, and by hand** (Actions, CI, Run workflow), no longer on pushes to `main`: the pull
  request's run already tested the merge result, and every session runs the full CI locally before it finishes. A pull
  request that changes only `docs/**` or Markdown files starts no run;
- **cancels the older run** when a newer push arrives for the same pull request (`concurrency`, `cancel-in-progress`);
- **stops a run after 30 minutes** (`timeout-minutes` on the `check` job);
- **caches Playwright's browsers** (`~/.cache/ms-playwright`, keyed on the installed Playwright version): on a cache hit
  the browser test downloads no Chromium and installs only the system libraries it needs.

If `main`'s branch protection requires the CI check, a docs-only pull request will wait for it indefinitely (GitHub skips
the workflow, so no status is reported): run CI on that branch by hand, or do not require the check for such pull
requests.

## Unreleased: v3 F3c (17 November 2026): Arkona appraisal tools and full-text search

[ADR 0054](adr/0054-arkona-appraisal-tools-and-full-text-search.md) (Proposed), carrying out the owner-approved
[F3c design](design/F3c-appraisal.md) (D1 to D4 as written, with the owner's addition, section F; now with an "as built"
section). Migration `3100_appraisal.sql`. Nothing was run against a live system: every test uses the mock LegendKeeper
and fixtures built from the shapes the design quotes.

- **Full-text search over the snapshots (A1).** The bridge keeps the newest full snapshot plus every change snapshot
  since in its own database, with an SQLite FTS5 index of every page's text (blocks, sidebar facts, names and aliases),
  built after each nightly full snapshot, updated page by page from each change snapshot and brought up to date at
  every search and report. **`search` with `content: true` now uses it**: free, complete as of the newest snapshot it
  names, with the operators (phrases, OR, NOT, brackets), each result labelled by lifecycle and branch, a text hit with
  its document, section and snippet. The Legacy Canon Archive and the Design References are left out unless
  `include: ["legacy", "design"]`. **LegendKeeper's own search is now `content: "live"`** (1 read, incomplete), which
  is what `content: true` used to mean.
- **`arkona_appraise_owner` (A2)**: a page, a branch or everything against Source Formatting, in Repository
  Automation's four groups (required defects, optional polish, architectural candidates, blocked cases), each finding
  naming its rule and evidence class. The page's open audit findings are gathered, never re-checked, F3d's "lifecycle
  tag not leading" included (its reorder-only fix handed over to the audit's).
- **`arkona_change_impact` (A3)**: what depends on a page, a planned rename or a pending proposal: proven breakage
  (links to pages that are or will be deleted, archived or Working; mentions and chronology rows a rename breaks) and
  review candidates (incoming links and mentions, chronology rows, textual restatements found through the index).
- **`arkona_working_digest` (A4)**: Working pages with their Status, Scope and age (shown, never judged), pending or
  conflicted proposals, approved sets still `[BWRK]`, declared contradictions; `since` narrows it.
- **`arkona_visual_hygiene` (A5)**: asset names with an extension, non-WebP images, misplaced images, orphans, broken
  image blocks, uninterpreted Art images, conflicting Primary References: candidates only.
- **Acting on a finding (section F).** Every finding carries a `followUp`: `fix`, `judgement` (the tool and what has to
  be decided) or `none`. **`arkona_appraisal_fix { findingId }`** and **Propose a fix** on the dashboard re-read the page
  live (one read), check the finding still holds, and make ONE ordinary proposal for the owner: an em dash in a name,
  headings or prose; decorative blank paragraphs; a link in a heading; an asset name's extension; a Working or Archived
  page in an Authoritative page's Related Sources. Sibling order and tags are handed to the audits' own fixes. Last
  Major Revision follows ADR 0051's rule (these are minor). Nothing is applied without the owner's approval.
- **The dashboard's Appraisal page** (Quality): the index's freshness, size and timings; run A2 to A5 on a page or
  branch; the report in its groups, each page linked to LegendKeeper; Propose a fix only where there is one; the latest
  runs (kept in the bridge's database, never written to LegendKeeper).
- **Changed for every tool**: the Last Major Revision measure reads a mention's label as text, so dropping a heading's
  link is not a reworded heading. The audits' "Propose a fix" records who asked (an agent's handover is the agent's).

**Costs.** The search with `content: true` and the four reports: no LegendKeeper request (`live: true`: A2 2 reads a page,
at most 25; A3 1 read). "Propose a fix": 1 read, then the proposal's own cost when approved. **Measured** on a fixture of
Arkona's size (1,500 pages): the index builds in about 2.0 s, takes a five-page change snapshot in about 37 ms, answers a
phrase in about 1 ms, and takes about 21 MB of the bridge's database.

**After deploying.** Let the next nightly snapshot build the index (or press **Rebuild the index now** on the Appraisal
page once a full snapshot exists), then try the Appraisal page on one branch. Check that a finding's page link opens the
page in LegendKeeper (the link's pattern could not be checked from here). Agents that relied on `content: true` reaching
LegendKeeper now get the index; `content: "live"` keeps the old behaviour.

## Unreleased: v3 F3d (17 November 2026): the lifecycle tag leads on Arkona, AU in the lifecycle, owner routing lines

[ADR 0053](adr/0053-v3-f3d-lifecycle-tag-leads-au-in-the-lifecycle-routing-lines.md) (Proposed). No migration. Nothing was
run against a live system: mocks and fixtures only.

- **The lifecycle tag leads on Arkona** (the owner's decision; the Controlled Native Tagging Standard v1.8). A setting
  pack now says per project where the four lifecycle tools put the lifecycle tag (`lifecycleTagPosition`, `lead` or
  `append`; a project not named is `append`). Arkona's pack says `lead`: `move_to_working` gives `Working, Culture,
Language` (not `Culture, Language, Working`), `archive_page` `Archived, Magic`, `promote_page` `CANON, Culture`, and
  `unarchive_page` puts what its target needs first. Whole sets alike. Every other project, the test world included, is
  unchanged.
- **AU in the lifecycle tools** (F3b's leftover): on a project whose pack carries the AU ruling, `promote_page` and
  `unarchive_page` (back to Authoritative) give an AU page `AU`, any other page `CANON`; `move_to_working` and
  `archive_page` remove either. The guard now protects `AU` as it does `CANON`. AU pages can be promoted once the new
  pack version is approved.
- **Two new audit findings**: `lifecycle_tag_not_leading` (a `[BWRK]` or `[BARC]` page whose lifecycle tag is not
  first, or which still carries a status tag; "Propose a fix" reorders the tags only) and `au_status_tag_mismatch` (`AU`
  on a non-AU page, or `CANON` on an AU page).
- **`arkona_create_owner` adds a routing line** to the home index it files an Authoritative owner into, as the
  character tool does; with `promoteNation` the Polities index's line for the nation now points to the nation's new
  index. A home with no routing section gets none, and the preview says so. One more read to plan.
- **Raw block edits are measured for Last Major Revision.** An `updateBlock` proposed through `lk_api_write` or
  `lk_api_batch` keeps the block as captured as its "before", so a typo or a KCY-only fix no longer sets the date.
- **The canon banner speaks plainly.** A lifecycle change on the Proposals page reads "Promote: Status would be set to
  Authoritative; name [BWRK] → [BSRC]; tags Working → CANON", not raw JSON.
- **The seed `arkona-2026-11-17-f3d`** supersedes F3b.1's. **After deploying**: approve the new pack version on the Packs
  page; then run the audit and look for "lifecycle tag not leading" (each is a page the bridge archived or moved to
  Working before this fix; its fix reorders the tags). After that, AU pages can be promoted.

## Unreleased: v3 F3b.1 (16 November 2026): the pinned headings, re-mapping a pin, Working owners' specialist

An amendment to [ADR 0052](adr/0052-arkona-pack-owners-relationships-art-and-the-brief.md#f3b1-amendment-16-november-2026)
(no new ADR, no migration). Nothing was run against a live system: mocks and fixtures only.

- **Fixed: the new Arkona pack version could not be approved** ("Source Formatting has no section “Approved
  Hierarchy”…"). The F3b handoff abbreviated three headings. The seed now pins the six headings exactly as the pages
  have them: Page Names and Templates, Nation-Centred Territorial Navigation, Approved Hierarchy and Standardised
  Navigation, Active Template Suite and Sidebar Collections (Source Formatting); Exact Tag Grammar, Closed Primary
  Categories and Specialist Functions (Tagging Standard). Matching stays whole-heading: no prefix or fuzzy match.
- **Re-map a pinned heading on the Packs page.** When approval fails with `GOVERNANCE_SECTION_MISSING`, or a governance
  page renames a pinned heading, each missing heading is shown beside a picker of that page's actual headings (in
  order, with their levels). Choosing one asks for the password again, is audited (`pack.remap_section`, old and new
  heading) and makes a new pack version, so the mapping is approved with the version. API:
  `POST /api/admin/packs/:id/sections`.
- **A Working owner keeps its specialist tag** (the owner's ruling): `Working, Culture, Language`, not
  `Working, Culture`; nothing is held any more. An owner archived with `archive_page` keeps its primary and specialist
  (only the status tag is swapped; the bridge-wide tool still adds `Archived` last).
- **The seed `arkona-2026-11-16-f3b1`** supersedes F3a's and F3b's seeds: start-up offers it as a new version (token
  maps kept). After deploying, approve it once on the Packs page; it should succeed first time.

## Unreleased: v3 F3b (16 November 2026): Arkona pack: owners, relationships, art and the brief

[ADR 0052](adr/0052-arkona-pack-owners-relationships-art-and-the-brief.md) (Proposed), carrying out the owner-approved
[F3b design](design/F3b-owner-tools.md) (now with an "as built" section). No migration: the additions live in the
pack's rules, which reach the stored Arkona pack as a new version for the owner to approve. Nothing was run against a
live system: every test uses the mock LegendKeeper and fixtures built from the shapes the design quotes.

- **`arkona_create_owner`**: one non-character owner page by Arkona's rules, typed by the pack's new **owner table**
  (19 types, from Polity to Condition and the inter-polity Relationship: template, primary and specialist tags, allowed
  homes). `home` is required and checked: a home the type does not live in is refused with the allowed homes and up to
  five suitable indexes nearby; `homeOverride` with the owner's reason places it anyway, the reason in the proposal.
  Reference Type, Scope and Temporal Scope are required (ask the owner). The template's unfilled placeholder headings
  are left out.
- **Nations.** A nation that is only a compact Reference is refused (`NATION_NEEDS_INDEX`) until `promoteNation: true`
  makes its `[INDEX]`, moves the Reference in (id kept) and places the owner beside it, in one canonical proposal;
  `createSubindex` makes one national subindex as its own step.
- **The race roster** (the owner's ruling): a race, racial group or subrace (`type: "Species"` with `kind`) lives on
  Races of Arkona and its racial group and race pages; any other species and every creature in the Bestiary.
  `createCharacterNavigation` adds a new race's Characters index and its taxonomy entry so characters can be placed.
- **`arkona_create_relationship`**: a joint relationship page for two existing characters, added to both Related
  Sources in one proposal; a missing character or an existing pair is refused, naming what exists.
- **`arkona_add_character_art`**: art for an existing character (staged id, prepared upload or ChatGPT file), placed in
  its folders (found or made when the job runs) under semantic names, on its Art page, made or extended under
  "Reference Images" with each image's interpretation.
- **`arkona_character_brief`** (read): who a character is, from the bridge's own records: free, or one read with
  `live: true`.
- **The AU ruling** for every pack tool: an AU page carries `AU` in place of `CANON` (`arkona_create_character`
  changed with it); recorded in the pack with its date.
- **The staged-image takeover**: a package that names an image whose only pending activity is its own placement
  proposal (what `upload_image` with a destination does at scope `propose`) withdraws that proposal ("superseded by
  package prop_…") and places the image itself; anything else is still `STAGED_IMAGE_BUSY`, now with the hint to stage
  with no destination.
- **Governance**: the approval pins six sections of Source Formatting and the Tagging Standard by digest and is refused
  when one is missing; drift still fails closed, and now names the section. The job re-checks before it writes: a
  same-named sibling, an existing relationship, a nation index made meanwhile, a moved Reference, a staged image taken.
- **Last Major Revision by ADR 0051's rule** (F3c, merged in): every pack tool that changes an existing page
  (`arkona_create_character` with `target`, a relationship's Related Sources, an Art page extended, `promoteNation`'s
  move) dates it only for a major revision by the owner's rule, and takes `lastMajorRevision: "auto" | "set" | "skip"`;
  pages a package makes are always dated. The preview, the answer and the proposal say which applied and why.
- **The Packs page** shows the owner table, the AU rule and rulings, and each source's pinned sections with their state.
- **Docs**: the agents' guide's pack section is now "Setting packs (Arkona)", a part per tool (F3a's name still leads to
  the character part), with tested owner examples; tools.md (costs measured against the mock), packs.md, dashboard.md;
  four new evaluation scenarios (35 to 38, marked `pack: "arkona"`).

## Unreleased: v3 F3c (16 November 2026): Last Major Revision only for real revisions, same-day ties, image restore without the staging folder

[ADR 0051](adr/0051-v3-f3c-major-revisions-same-day-ties-and-image-restore.md) (Proposed; the owner approves decision 1's
rule as worded there). No migration. Nothing was run against a live system: every test uses the mock LegendKeeper and
fixtures. Nothing in `src/packs/`, the pack tools or the Packs page was touched (F3b's).

- **Last Major Revision only for real revisions** (the owner: "Tiny edits like this aren't enough for a major
  revision"). F2's "substantial" test is replaced by the owner's rule: 8 words or more of page text in the whole edit; a
  heading's wording; a real change to a fact other than the housekeeping keys; a Dependency added or removed; a
  chronology row's date or description. A trimmed value (a prefix, a descriptive tail or a parenthetical removed),
  punctuation, dashes, whitespace or capitalisation, a typo fix (at most 2 characters in at most 3 words, never a
  number), a KCY alone, tags, aliases, the name or a move do not count. Measured when the edit is planned from what the
  tool read (`write_page`, `set_facts`, the chronology tools), or when the job runs from the journal's pre-images
  (`lk_api_*`, restores, the dashboard's fixes). The two Arkona cases (a trimmed Subject, a KCY fix) no longer set it;
  Nezrin's seven-fact rewrite does. F2's per-project switches stay; Dependencies moved from the link-collection switch to
  the set_facts one ([docs/tools.md](tools.md#last-major-revision-only-for-real-revisions-v3-f2-v3-f3c)).
- **`lastMajorRevision: "auto" | "set" | "skip"`** on `write_page`, `set_facts`, `lk_api_write`, `lk_api_batch`, the four
  chronology tools and `restore_snapshot`. The answer (`lastMajorRevision`) and the proposal say which applied and why
  (`Last Major Revision skipped: Subject: a trimmed value, not a major revision`).
- **Same-day pairing without guessing** ([docs/chronology.md](chronology.md#same-day-pairing-without-guessing-v3-f3c)):
  a day with two or more rows and as many events pairs by unique names and stored links only; what is left pairs by the
  date only when it is one row and one event, and otherwise is a tie shown with F2.1's buttons. Never paired by order.
- **A deleted image is restored without `LK-Bridge staging`** ([docs/snapshots.md](snapshots.md)): its bytes wait on the
  bridge's server; the proposal names the image, its folder and its name; approval uploads it straight into its folder
  (found, or made again by its path) and rewrites the pages that showed it in the same job, with If-Match. A page edited
  meanwhile stops the job after the upload with an `image_relink_failed` follow-up (on the restore's record too), never
  retried. The upload steps of a server-staged placement are shared (`ImageService.serverPlacementSteps`); `bindAssetUrls`
  can bind an asset's id (`field: "id"`, a map image).
- **The C2a browser test passes again**: its fixture makes Inae canon through `promote_page` (the C2c lifecycle guard
  rightly refuses a raw Status write). Stable across 5 fresh runs, so CI now runs it in a step of its own; `npm run ci`
  stays browser-free.

## Unreleased: v3 F3c (16 November 2026): a grouped sidebar

A UI change only: no ADR, no migration. Nothing was run against a live system.

- **The sidebar** keeps Overview, Jobs and Proposals (with its pending count) at the top, and files every other page
  into expandable groups: Access & Account, Assets, Backups & Recovery, Limits, Monitoring, Quality, Repository and
  Setup. Groups and pages are sorted by code, not by hand. The current page's group is open; the owner's choices are
  remembered in this browser; a closed group shows its pages' counts. Group headers are buttons with `aria-expanded`,
  work by keyboard, and keep the existing look in light and dark; narrow screens keep the same structure.
- **Evaluation** has its own page (`/evaluation`, under Quality), with the helper open. It is still also a panel on
  Tool calls.
- **The router** is now a table (`ROUTES`), and a test fails when a page is neither in the sidebar nor a listed
  sub-page of one.
- See [docs/dashboard.md](dashboard.md#the-sidebar-v3-f3c).

## Unreleased: v3 F3a (16 November 2026): setting packs and the Arkona character tool

[ADR 0050](adr/0050-setting-packs-and-the-arkona-character-tool.md) (Proposed), carrying out the owner-approved
[character pack design](design/F3-character-pack.md) (now with an "as built" section). Migration `3000` (packs, their
projects, versions and reservations). Nothing was run against a live system: every test uses the mock LegendKeeper and
Arkona-shaped fixtures.

- **Setting packs** ([docs/packs.md](packs.md)): a setting's rules held as data (types, roles, templates by role, names,
  placement, sidebar facts, the closed tag grammar with its token maps, text rules), versioned, attached to projects
  (template ids worked out per project from the home project's template names), and approved by the owner against the
  governance pages they were derived from. A changed governance page, or rules edited since the approval, fails closed:
  no tags are computed and every package is refused until the owner approves again. A pack's tools carry its prefix and
  are listed only for a project it is attached to.
- **`arkona_create_character`**: one package becomes a character's whole set of linked pages (a Compact Character
  Reference, or an index with a Character Core and one page per domain given; Art pages with staged images; joint
  relationships), each from its template, named, placed under its race, its sidebar filled in template order, its tags
  computed, links resolved, then verified. A full preview first (`dryRun`); then one proposal for the owner, whatever
  the agent's scope, in the pack's first weeks. The completion gate refuses a new character without its six identity
  fields and tells the agent to ask the owner. Em dashes (and en dashes used as separators) are replaced by hyphens and
  listed; CANON or a date in a page name is refused. Last Major Revision is set on every page it creates or
  substantially changes.
- **Existing characters** (`target`): found by id, name or alias, never duplicated; new pages take the character's
  standing (Working, canon, its AU continuity); a Compact Reference that gains pages gets its own index (its id kept),
  and `upgradeToCore` makes it a Core; the index's routing section gains a line per page; blank gated fields are warned
  about and fixed when given; an Archived character, a domain it already has and a monolith split are refused. Two
  approved packages for one new character: the second job stops before writing.
- **Type-driven**: the engine reads the pack's rules; small hooks hold what data cannot say. A type defined only as data
  (a test's dummy "Polity") plans, previews, proposes and verifies through the same engine, served by a generic pack
  tool. The extension points for F3b are named in the ADR.
- **The Packs page** (dashboard, after Repository Mappings): each pack's state, governance sources and versions, projects
  and template ids, token maps, rules and versions; **Approve this pack version** and **Save token maps**, each
  re-authenticated and audited.
- **The general bridge** gained registered checks in a job's lock and verify step, a filler for a template copy's text,
  image-address binding, a tool's `listed` predicate with a live tool list, and a lifecycle guard that judges a move into
  a page made earlier in the same request.
- **Docs**: the agents' guide has a "Setting packs (Arkona characters)" section (when to use the tool, a compact and a
  developed example, the gate, `target`); tools.md, dashboard.md and four new evaluation scenarios (31 to 34, marked
  `pack: "arkona"`).

## Unreleased: v3 F2.1 (16 November 2026): chronology ties settled

[ADR 0048](adr/0048-chronology-ii.md)'s F2.1 amendments (no new ADR, no migration). From the owner's Arkona run of 16
November 2026. Nothing was run against a live system: every test uses the mock LegendKeeper and fixtures.

- **A plain row beats a qualified anchor.** An event of a plain row's exact date and shape is that row's, before any
  qualified row anchored on the same day (`pairedBy`: "plain row preferred over qualified anchor"); the qualified rows
  are offered new events. A name decides between two plain rows only when it names exactly one; ranges of the same start
  are told apart by the year they end in.
- **A caller's choice is remembered.** `sync_timeline_event` with `event_id` on an agreeing event records the link and
  answers `linked` (no LegendKeeper write; still a proposal at scope `propose`, "link row … to event …").
- **`create_new: true`** makes a new event although candidates exist, naming those passed over.
- **Refusals name their candidates** (name, date, id) in the message; the Chronology and Audits pages show **Use this
  event** for each and **Make a new event**.
- **A row by its opening words** (a unique prefix of 20 characters or more); `ROW_NOT_FOUND`, `ROW_AMBIGUOUS`,
  `ROW_PREFIX_TOO_SHORT`, `ROW_HAS_EVENT`.
- **Event in a tie.** An unpaired event that unpaired rows could own is `event_in_tie` (audits:
  `chronology_event_in_tie`) with **Pair with this row** per candidate, never a delete; the orphan refusal says "This
  event is not an orphan".
- **Six more date forms:** `On or after / On or before X`, `Before or during X`, `During or after X`, `4A 614-617` and
  `Across`, `Early / Mid / Late <year>` (approximate; `… onward`), a same-instant gloss in another era, ranges of mixed
  precision.
- **KCY of a range inside one year:** the single value by default; the range form is accepted too, never "written
  differently".

## Unreleased: v3 F2 (16 November 2026): Last Major Revision, Make default, snapshot follow-ups, server-side staging, ChatGPT files, folders found at run time

[ADR 0049](adr/0049-v3-f2-last-major-revision-default-project-and-staging.md) (Proposed); [ADR 0048](adr/0048-chronology-ii.md)
accepted with the owner's decisions A–C; PLAN-v2's E6 note says "also called v3 F1". Migrations `2800` (a chronology
link's name tail) and `2900` (server staging, migrate-staging requests). Nothing was run against a live system: every test
uses the mock LegendKeeper and fixtures.

- **A qualified event's name stays true to its row.** The date tail the bridge wrote after an event's last `–` follows
  the row's Date cell when a sync or "Propose a fix" changes the date (dropped when the row becomes plain); wording alone
  is a new `name_drift` finding with a name-only fix. Only tails the bridge wrote count; the opening words are never
  touched.
- **Last Major Revision on every substantial edit** (owner, 16 November 2026). `write_page`, block edits through
  `lk_api_write` / `lk_api_batch`, chronology table rows, restores that change text, pack tools and `set_facts` (except
  the housekeeping keys) set the page's row to today (Europe/London, `YYYY-MM-DD`) in the same job and proposal, with
  their own If-Match; a proposal is dated the day it is approved. Pages without the row are skipped silently; already
  today writes nothing; a failure after the edit is a follow-up (`lmr_failed`), never a rollback. Each category is a
  per-project switch.
- **Make default** on the Projects page stores the default project (re-authentication, audited, no restart);
  `LK_DEFAULT_PROJECT` is an override the page names; `env-sync.sh --retire-default-project` retires the line once the
  stored default agrees.
- **A partial snapshot's missing pieces** are listed on the Snapshots page and, in summary, by `list_snapshots`.
- **Pages deleted in the app** are restored from the snapshot that holds them, judged by its state (an Authoritative page
  as a canonical proposal). Every restore proposal names its snapshot and when it was taken.
- **A recreate that stopped part-way** is finished by the same request again, or **Finish** on the Snapshots page: only
  what is missing is written, never a second page or document (E4-OPEN-1 closed).
- **Unapproved images wait on the bridge's server** (owner, 16 November 2026; supersedes ADR 0041 decision 7). Staging
  sends nothing to LegendKeeper; placing uploads the image straight into its final folder with its final name and verifies
  it; the Staging page shows the bridge's own copy; discard removes it; `IMAGE_STAGING_MAX_DAYS` (90) warns, then removes;
  `IMAGE_STAGING_MIN_FREE_GB` refuses a new staging upload on a low disk. Staged images are in no snapshot or off-site
  copy. `npm run images -- migrate-staging --project <name>` moves the old `LK-Bridge staging` folder's images to the
  server and proposes deleting them and the folder. An image is never placed in the library's root, and a name already in
  the folder is numbered.
- **ChatGPT files.** `upload_image` takes a conversation attachment as `file` (`_meta["openai/fileParams"]`; the SDK passes
  `_meta` through unchanged): downloaded during the call through the guarded transport, at every scope; the magic bytes
  decide; the link is never logged, stored, journalled or returned; an expired link is `FILE_URL_EXPIRED`.
- **Folders found or created when the job runs** (the owner's report of 16 November 2026: two approved placements made
  two identical folder chains). Under a per-project asset-folder lock, byte-exact names; the job's result and journal say
  "found existing folder" or "created folder". A new audit finding, duplicate asset folders, with a merge fix.
- Small items: LS1 treats "removed with its throwaway page" as a pass with a note (`deleteFeature` is refused on such a
  map too; the LegendKeeper bug report says so); a region's old `polygon` is cleared (`polygon: []`) when `polygons` is
  written; the maintenance jobs test runs on the fake clock alone.

## Unreleased: E6 "Chronology II" (16 November 2026): qualified dates, better pairing, events without a row, named proposals

[ADR 0048](adr/0048-chronology-ii.md) (accepted 16 November 2026: owner decisions A–C as built); the new [docs/chronology.md](chronology.md); a
PLAN-v2 note after D1.1. Migration `2700` (`chronology_table_only`). Nothing was run against a live system: every test
uses the mock LegendKeeper and fixtures built from Arkona's real date forms.

- **Qualified dates read by their anchor** (src/calendar/qualified.ts). A Date cell the plain forms cannot read, such as
  `c. 4A 563; exact date unresolved`, `After Isar 6th and before Zarzakh 29th, 4A 610; …` or `Approximately House Year 8
(c. 4A 578); …`, is read by its anchor: a year, a month, a day, a range, or one bound of an open date, approximate or
  not, with everything else kept verbatim as the qualifier. A reading must be certain: relative offsets (`about nine
months after …`), two possible days, a qualifier on a day and bounds that look like dates but are not stay
  unreadable, and the check says why. The table is never rewritten; the reading is used for pairing, the row's event and
  the KCY check, never for ordering. Of the owner's 26 example forms, 25 are read; of an Arkona-shaped set of 63, 54.
- **The check.** A qualified row's KCY is checked where it is computable, its words (`(approximate)`, `onward`,
  `Unassigned - approximate date`) counted as text. An unreadable row is reported once, as an unreadable date (it was
  also a row without an event), so every row without an event is now fixable. Each age shows how its dates were read
  and how each row and event were paired.
- **Qualified rows' events.** `sync_timeline_event` and "Propose a fix" make them from the anchor: a year event, a month
  event, a range, or one point at the known bound. LegendKeeper's events have no text but the name, so a qualified
  row's event is named with the row's opening words, then `–` and its Date cell as written (owner decision A).
- **Scored pairing.** Links; the same date (with the name, then alone); then the same start and end, the same start and
  shape, the name, the same start, each taken only when it is the single best on both sides. A one-day row never takes
  a range event while a range row starts at the same minute: the Fourth Age's Divan Heirage event pairs with its own row
  and the Viziers' vote is offered its own. Every pair records how it was made (`pairedBy`).
- **A fix that changes an event's shape** (`range → single day`, or the reverse) is never one click: the finding warns,
  the dashboard asks, and `sync_timeline_event` refuses (`SHAPE_CHANGE_UNCONFIRMED`) until `confirm_shape_change: true`.
- **Table-only rows.** A row the owner never wants on the timeline is marked on the Chronology page (audited
  `chronology.table_only`): hidden from the check while its text is unchanged, back when it changes, never given an
  event, still counted in the Main count. A new **Table-only rows** card lists the marks with **Clear the mark**.
- **Events without a row.** "Propose a fix" (the Chronology and Audits pages, fix `chronology_orphan`) proposes deleting
  only the event, naming it, its date and the three rows nearest it by date; the ordinary chronology job, journalled with
  the event. Through MCP: `delete_timeline_event { event: { event_id }, orphan: true, confirm: true }` (no new tool).
  Refused when the event has a row after all (`EVENT_HAS_ROW`) or a row could be its own (`PAIRING_AMBIGUOUS`).
- **Named low-level proposals** (src/policy/op-names.ts). A proposal made by `lk_api_write` or `lk_api_batch` names the
  page, the document and the entity (an event's name and date, a feature's type and name, a block's first words, a
  property's title, a row's key with its property's title) from the pre-image it reads anyway (a row's property title
  costs one read). The summary, **Pages affected** and each operation's card show them; a name that cannot be found
  falls back to the ids and never blocks the proposal.
- **Audits.** A chronology refusal through the audits page is a 409 with its reason (it was a 500).
- **Tests.** `test/calendar/qualified.test.ts` (every form, read or deliberately unread, table-driven; the KCY words; the
  63-cell set), `test/chronology/qualified.test.ts` (the check, a sync of each shape, the Divan Heirage fixture, the
  table-only mark, the orphan fix and route, the Arkona-shaped counts), `test/chronology/pairing.test.ts` (scoring and
  the guard), `test/policy/op-names.test.ts` (deleteEvent, deleteFeature, updateBlock, the property-row writes, and the
  real capture), and the Chronology, Proposals, Audits and admin tests.
- **Docs.** ADR 0048; docs/chronology.md; the bridge guide's chronology section; docs/dashboard.md (Chronology,
  Proposals); docs/tools.md; PLAN-v2.

## Unreleased: E5.5 (16 November 2026): learned operation limits, and honest estimates (backlog 16 done)

[ADR 0047](adr/0047-learned-operation-limits.md); PLAN §1.2, §5.1 and §5.4 notes and amendment 9. Migration `2600` (an
index on `steps (project_id, finished_at)`; no data changes). Nothing was run against a live system: every test uses the
mock governor and the mock LegendKeeper, which can now model the asset routes' own tiers. The sandbox probe LIM1 is for
the owner to run.

- **The finding (the owner's sampled rehearsal, 15–16 November).** It estimated about 10 minutes and ran for over 40. The
  test world's footer read `writes 10/20·min`. LegendKeeper reports `X-RateLimit-*` for the tier with the fewest requests
  left, and its asset routes have tiers its spec does not list (about 20 a minute for asset folders and image uploads,
  about 60 for asset deletes). The governor found no tier with that limit, fell back to "match by window", took the 20
  for `write-min`, and kept it until a restart, so every write in the project went at 20 a minute (P3's share 10).
- **An unrecognised limit never lowers a documented tier.** A header is matched to a documented tier by its limit as
  before. A new limit counts as a documented tier's change only when the window its reset implies is that tier's, its
  count is near the bridge's own, and the operation is not an asset route. Otherwise it becomes a **learned tier of the
  operation's rate group**: `assets` for `createAssetFolder`, `createImageUpload`, `createImageAsset`, `updateAsset`,
  `deleteAsset` and the signed upload PUT (which joins only once it carries the headers itself); any other operation is
  a group of its own. The window comes from the reset (up to 60 s a minute, up to an hour an hour, otherwise a day). A
  learned tier paces only its group, a 429 on it blocks only its group (honouring `Retry-After`; a long one parks the
  call with the tier `group:<name>`), and it expires once its window has passed twice without being reported. A header
  at a documented tier's configured limit now clears a limit learned for it. `UPLOAD_RATE_EXCEEDED` still blocks the
  bridge-only `upload` tier; that tier is not the `assets` group's home (ADR 0047 decision 4).
- **Visible.** The Request Budgets page has a **Learned operation limits** card (group, operations seen, limit, window,
  remaining, last seen, expiry, and "refused for N s"), and the All projects view a line per project. `bridge_budget`
  adds `learnedOperationLimits` when there are any. The footer is unchanged apart from `| blocked <group> <s>s` while a
  group is refused. The first sighting of a group and limit is logged once per process (info), naming the project, the
  operation and the figures.
- **Honest estimates (backlog 16, done).** `governor.estimate` uses each tier's effective limit and, for the operations
  the caller names (`ops`), the learned tiers of their groups, and only for those. A write takes at least the project's
  **measured per-write duration**: the median wall time of its last 200 succeeded write steps (`steps`, read at most once
  a minute), floored at the configured spacing; `perWrite` says which was used, and `bridge_estimate` reports
  `secondsPerWrite` and `perWriteFrom`. The engine's job ETAs pass their operations too.
- **The rehearsal and restore plans** name their operations (a rehearsal's asset folder, uploads, PUTs and the folder's
  delete), so a learned `assets` limit paces those steps only and every other write goes at the documented limit. They
  say which figures they used (`estimate.figures`: the per-write duration and its source, each tier's limit and the
  class's share, each learned group's limit, steps and time). A restore plan now carries its estimate at P1 (the
  dashboard's Preview shows it; `restore_snapshot` says it in a few words).
- **A running rehearsal's progress.** It saves its stage and its writes, reads and uploads every few seconds, and the
  Snapshots page shows them against the plan with the time elapsed and a projected finish.
- **The sandbox probe LIM1** (`npm run test:sandbox -- assumptions`, run first in the file): an asset folder, one 70-byte
  PNG uploaded into it, both deleted by id even after a failure, and the `X-RateLimit-*` headers of every answer recorded
  as NOTED with the window each implies, then what the bridge learned. Its dry run against the mock checks the line.
- **Tests.** `test/unit/governor-learned.test.ts` (a 20 header on `createImageUpload` and a 60 on `deleteAsset` leave
  `write-min` at 120 and pace only the group; 120 and 3,000 headers match as before; a consistent new limit still lowers
  `write-min` and 120 restores it; a far-off count goes to the operation's own group; an asset route never teaches a
  documented tier; widening; expiry; a 429 blocks only the group; the first-sighting log; estimates with the group and
  the measured figure), `test/contract/learned-limits.test.ts` (the owner's sequence replayed against the mock with the
  asset routes' tiers: a root, a folder, 3 uploads, then 200 writes in under 4 minutes, not 19), `test/jobs/durations.test.ts`,
  `test/snapshots/e5-5.test.ts`, `test/admin/learned-limits.test.ts`, and the Budgets and Snapshots page tests.
- **Docs.** ADR 0047; PLAN §1.2, §5.1, §5.4 and amendment 9; `docs/dashboard.md` (Request Budgets, Snapshots);
  `docs/snapshots.md` (estimates and progress); the E4 review's assumptions (the undocumented asset tiers);
  `docs/tools.md`; the bridge guide's budgets section; `src/lk/README.md`; `test/sandbox/README.md` (LIM1).

## Unreleased: E5.4 (15 November 2026): label sizes are never sent, unreadable maps, and faster sampled rehearsals

[ADR 0046](adr/0046-e4-owner-decisions.md) decision 14 (it supersedes decision 11's label-size mapping); notes in ADR 0040
and ADR 0042; new [docs/snapshots.md](snapshots.md) and the bug report for LegendKeeper,
[docs/reviews/lk-bug-labelsize.md](reviews/lk-bug-labelsize.md). No migration. Nothing was run against a live system:
every test uses the mock LegendKeeper, which now reproduces the bug. The sandbox check LS1 is for the owner to run.

- **The finding (Arkona's second rehearsal).** E5.2 mapped the app's label sizes on write (`small` → `sm`). The rehearsal
  then wrote all 1,066 writes and failed at the comparison: `listFeatures 400 VALIDATION_ERROR`, issue `labelSize`,
  "Invalid enum value. Expected 'small' | 'medium' | 'large', received 'md'". LegendKeeper's writes take only `xs` to
  `3xl`, but `listFeatures` returns only `small`, `medium` or `large` and refuses to list a map holding anything else. So
  writing any label size makes the whole map unreadable through the API.
- **`labelSize` is never sent.** Restores (creates and updates), recreated pages and rehearsals leave it out, so a feature
  takes LegendKeeper's default. Each lists it once per map with a count: "label size not restorable: LegendKeeper's API
  can't write the app's values (small/medium/large) and can't read its own (xs–3xl)". This is neither a failure nor a
  difference. The engine refuses any `createFeature` or `updateFeature` that carries one (`lk_api_write` too), before
  anything is sent. `iconSize` is untouched.
- **The map tools refuse it.** `create_map_feature` and `update_map_feature` refuse a caller's `style.labelSize`, whatever
  the value, with `LABEL_SIZE_UNSUPPORTED`. The message gives the reason, and says to set the size in the app. Nothing
  is read or written. One constant, `LABEL_SIZE_WRITABLE` in `src/maps/features.ts`, lifts all of this when LegendKeeper
  fixes the API.
- **Comparisons ignore it:** the restore plan's same-check, the checks and verify inside the lock, the rehearsal's
  comparison, and the map tools' `holds` and compare-and-swap hash. E5.2's `small` = `sm` equivalence is removed: with
  nothing written, nothing needs it.
- **A map LegendKeeper cannot list.** In a full snapshot, that map document is the missing piece, with the reason "its
  features: LegendKeeper can't list this map's features: a feature holds a label size its API refuses to return (set its
  label size in the app)". The page and the snapshot carry on, and the snapshot is partial. A restore from it refuses
  that map rather than read it as empty. In `read_document`, `update_document`, the map tools and a restore plan, it is
  `MAP_FEATURES_UNREADABLE`, with the same advice.
- **A rehearsal never fails on one read.** Any read error in its comparison is a difference naming the page and the
  piece. The comparison carries on, and the run finishes and deletes its root as usual.
- **Faster sampled rehearsals.** A sample now copies at most 25 events of each timeline (spread over it, with every lane
  they use) and at most 40 features of each map (with their folders; a region and a path kept first). The plan's new
  `cuts` say what was left out, and the dashboard lists them under the estimate. Full mode is unchanged. The owner's
  sampled run took over two hours against an estimate of about 20 minutes, with about 730 chronology event writes.
- **A realistic estimate.** The time shown is at least the writes one after another at P3's write rate, plus the reads at
  its request rate. The rates come from the governor's own estimate (the spacing, or P3's share of a tier once the work
  needs more than a window's share). The plan shows them (`estimate.pacing`), and the dashboard says "Paced at about …
  a write and … a read".
- **The newest complete full snapshot by default.** The rehearsal picker preselects it and marks a partial one
  "(partial)".
- **The sandbox assumption LS1** (`npm run test:sandbox`, the assumptions file). It writes one label with `labelSize: 'md'`
  and expects `listFeatures` to refuse the map. If it does not, it reports NOTED: LegendKeeper has fixed it. It then
  deletes that feature by id, even after a failure, and checks that the map lists again. The dry run against the mock
  checks it passes. The error parser now also reads an issue path given as a list.
- **Docs.** ADR 0046 decision 14 (with a note on decision 11), ADR 0040 and ADR 0042 notes, the E4 review's assumptions
  (E5.2's mapping note replaced), `docs/snapshots.md` (new), `docs/dashboard.md`, `docs/tools.md`, the bridge guide's
  maps section, `test/sandbox/README.md`, and the bug report.

## Unreleased: E5.3 (15 November 2026): Arkona's first audit; Reference Types that resemble, race values by their anchor, and areas without CANON

[ADR 0046](adr/0046-e4-owner-decisions.md) decisions 12 and 13; [ADR 0044](adr/0044-audits.md)'s note of 15 November; new
[docs/audits.md](audits.md). No migration. Nothing was run against a live system: every test uses the mock and the audit
fixtures; no sandbox run is needed.

- **`unknown_reference_type` no longer flags every "… Reference" value** (588 of Arkona's 589 Facts warnings, with
  strict mode off). Sharing any word of three letters counted as resembling a registry value, so the generic "reference"
  matched "Compact Character Reference". With strict mode off, an unknown value is now flagged only when (a) it is a
  registry value in other letters, (b) the page's name carries a registry page-name pattern ("{name} - Character Core"),
  or (c) its distinctive words (without `reference`, `references`, `the`, `and`, `of`, `a`, `an`) are a non-empty subset
  of one registry value's. "Character Reference" is still flagged; "Historical Character Reference" on a "… - Character
  Core" page still expects "Character Core" with a `set_facts` fix; "Continent Reference", "Character Biography" and
  "Relationship" are not flagged. Strict mode, the known values and when a fix is offered are unchanged.
- **Qualified race values are read by their anchor** (11 Taxonomy warnings). When the whole Race / Species value matches
  no taxonomy entry, the text before the first `(`, `;` or `-` is tried ("Therian (Aggeloi)" matches Therians; a
  hyphenated name such as "Half-Elf (Northern)" is also tried whole). The page is never rewritten and no word is guessed:
  "Fire Genie (…)" stays a finding, whose message and evidence (`anchor`) name the anchor tried, so the owner can add it
  as an alias in Repository Mappings. A match by anchor is checked for placement (`race_index_mismatch`) as before.
- **Areas that are Authoritative without CANON** (ADR 0046 decision 13; the owner's rule for `[INDEX] Design References`).
  A new lifecycle setting, "Indexes whose pages are Authoritative without CANON" (index ids, empty by default; the
  Projects page's Lifecycle section, with the same confirmation and re-authentication): every page beneath a listed index,
  at any depth and outside the Working and Archived areas, is `[BSRC]` and Authoritative without the CANON tag. The
  lifecycle audit accepts that shape and reports CANON there ("no CANON (Design References area)", the area in the
  evidence); `promote_page`, `unarchive_page` and Authoritative creates landing there add no CANON; `archive_page` removes
  only what it finds. No guard assumed `[BSRC]` means CANON, so none changed.
- **Docs.** `docs/audits.md` (new: the three rules, the generic-word list, the anchor), ADR 0044's note, ADR 0046
  decisions 12 and 13, `docs/dashboard.md` (the setting) and the bridge guide (the page lifecycle).
- **After deploying**, list `[INDEX] Design References` (`b034ef351290dfba28e292b0`) in Arkona's lifecycle settings, then
  run the audit again for Arkona from the Audits page. It reads the newest snapshot, so it costs no API requests. Facts
  should drop from 589 to about 2, Taxonomy warnings from 11 to about 3, and Lifecycle errors from 3 to 1.

## Unreleased: E5.2 (15 November 2026): Arkona's map image from `assets2`, and old label sizes on map features

[ADR 0041](adr/0041-image-pipeline.md)'s note of 15 November and [ADR 0046](adr/0046-e4-owner-decisions.md) decision 11;
no new ADR and no migration. Nothing was run against a live system: every test uses the mock; no sandbox run is needed.

- **Arkona's full snapshot is complete again.** Its map's background image (page `bwrldgeo`) is served from
  `assets2.legendkeeper.com`: `assets` answers `302` to the same path there, and the bridge refused every redirect, so
  the snapshot came out partial (2 missing) and the audits, which need a complete full snapshot, never ran.
  `assets2.legendkeeper.com` is now a default asset host (`LK_ASSET_HOSTS` unset: both hosts; the dashboard's CSP
  `img-src` lists both; an image URL already on `assets2` is recognised by the snapshot). **If `LK_ASSET_HOSTS` is set,
  it is kept as it is: add `assets2.legendkeeper.com` to it.**
- **An asset download follows a redirect, and only an asset download.** `downloadAsset` follows 301, 302, 303, 307 and 308
  with a `Location`, at most 3 hops, a relative `Location` resolved against the URL that answered; every hop is checked
  as the first (https, no credentials, a host in `LK_ASSET_HOSTS`, then public addresses, the port allowlist and the
  pinned DNS) and goes through the governor; another host, `http:`, a loop or a fourth redirect is refused with the
  reason (naming the host). No key or other credential is sent on any hop. The upload's verify, the bytes kept before a
  delete, snapshot capture and image restores all download through it. The API client, OAuth and the upload PUT still
  refuse every redirect. The snapshot and the kept bytes record the URL the page holds; the page is never rewritten; the
  upload verify names the URL the file came from (`servedFrom`).
- **Old label sizes on map features no longer break restores** (Arkona's first rehearsal: `Invalid params for
createFeature: steps[1].body.labelSize`). Features drawn in the app may hold `small`, `medium` or `large`, which a write
  refuses. Restores, recreates and rehearsals now write them as `sm`, `md`, `lg`; a value that is neither old nor new is
  left out (its default applies) and listed, naming the feature, rather than failing the write. `iconSize` is
  untouched. Old and new compare as equal in the restore plan, the checks inside the lock, the rehearsal's comparison and
  the map tools, so a restored `sm` is no difference and is not "updated" again. An agent's own `labelSize: "small"` is
  still refused, now with the hint to use `sm`.
- **A refused write names what it writes.** A planned step the engine refuses gives the page, the document and the
  feature (its name and id), not only `steps[1]`; the rehearsal names its feature writes the same way.
- **Docs.** ADR 0041's note, ADR 0046 decision 11, `docs/tools.md` (`LK_ASSET_HOSTS`), `docs/dashboard.md` (the CSP), the
  runbook's outbound note, `.env.example`, and the E4 review's assumptions.

## Unreleased: E5.1, hotfix during E5 (15 November 2026): the round trip on Arkona, a fix for a count mismatch, Run now for one project, and documents in one order

[ADR 0046](adr/0046-e4-owner-decisions.md) decision 9; [ADR 0039](adr/0039-date-styles-timeline-repair-and-etag-versions.md)'s
note of 15 November; no migration. Nothing was run against a live system: no call to the owner's LegendKeeper bridge
connector, the live dashboard or any other live service. Every test uses the mock; no sandbox run is needed.

- **The Markdown round trip runs on any registered project, read-only by construction.** `deploy/markdown-roundtrip.sh
--project arkona` now works without marking Arkona as a sandbox (never mark Arkona): the script resolves its project with
  the new `resolveReadOnlyTarget` (any registered, not removed project; the key handling and every refusal as before), and
  its runtime (`createReadOnlyRuntime`) has `LK_READ_ONLY=true`, a governor allow-list (`listProjects`, `listResources`,
  `getDocumentBlocks`; anything else is refused with `OPERATION_NOT_ALLOWED` before a request) and a transport that sends
  only GET. The report's header says whether the project is a sandbox and that the run was read-only. The sandbox, soak
  and spike scripts and every sandbox test still refuse a project not marked as a sandbox (tested). It shares the
  project's hourly budget, at P3.
- **"Propose a fix" for a count mismatch.** The Chronology page's `count_mismatch` findings (when the Main table has a row
  for the age) and the audits' `chronology_count_mismatch` (`fix: 'chronology_count'`) offer it: ONE ordinary proposal
  setting that age's Event count cell in the Main table to the age table's row count, both re-read live, its summary
  showing both figures (`Fourth Arkonan Age: Main 337 → 336 (table rows 336; timeline events …)`). Approved, it changes
  only that cell, in the Main table's writing style (thousands separators, the cell's marks); a Main document changed
  before approval, or the table's row count, conflicts and writes nothing. A count that already matches answers "nothing
  to fix"; a Main table with no row for the age has no fix.
- **Maintenance: Run now for one project, and per-project status** (the owner's report of 15 November: Run now of the
  tree check with Arkona selected ran `test` first, and the page showed `test`'s result and job link while Arkona's pass,
  about 1,500 reads at P3, was still running). `POST /maintenance/:id/run` takes an optional `project`; the dashboard
  sends the selected project for a per-project job, so only that project runs, and the job's schedule is not moved.
  Without `project` every project runs, as before; scheduled runs still cover every project; a bridge-wide job ignores
  it. The audit record names the project. `GET /maintenance` gives a per-project job's line for each project (last run,
  outcome, summary, running now) and the project running now (`runningProjectId`, in memory); each job link opens in its
  own project (`?project=`); the history shows the selected project's runs, or every project's with each row named.
- **The tree no longer "corrects" a page's documents for their order** (Arkona's first check: 4 pages corrected twice
  each, the same documents swapped between name order, from `listResources`, and tab order, from `getResource`). The
  documents are compared as a set of `{ id, name, type }`, and stored in LegendKeeper's tab order: sorted by `rank` from
  `getResource`; a listing keeps the stored order (new documents after the others). A document added, removed or renamed
  is still one correction. `factsVersion`, snapshots, audits and the chronology were checked: order alone changes none.
  ADR 0046 decision 10.
- **Docs.** The E4 checklist item 3, the runbook's "Going live" and PLAN-v2 section 7: the bridge-wide `LK_READ_ONLY` is
  already `false` (the test world takes writes); Arkona stays read-only by its own Read-only setting on the Projects page,
  which item 21 lifts. Item 16 names the command. `docs/projects.md` and the runbook: only the sandbox, soak and spike
  scripts refuse a project not marked as a sandbox; a new runbook section, "Markdown round trip". `docs/maintenance.md`
  and `docs/dashboard.md`: Run now acts on the selected project; per-project status.

## Unreleased: v2 E4: the second independent review, block-by-block page writes, and the concurrency acceptance tests

[reviews/E4-2026-11.md](reviews/E4-2026-11.md); [ADR 0046](adr/0046-e4-owner-decisions.md) (proposed); no migration; PLAN-v2
phase E, the E4 row. Nothing was run against a live system: no call to the owner's LegendKeeper bridge connector, Google or any
other live service, not even a read. Every test uses the mock; the sandbox tests are written and dry-run, not run.

- **27 findings, 26 fixed, each with a test that fails on the old code** (`test/e4/`, and beside the code). Critical: a
  `restoreResource` (through `restore_resource`, `restore_snapshot` or `lk_api_write`) was never judged by the lifecycle guard,
  so a restore could bring a `[BWRK]` page into canon or a canon page into the archive (now judged as a move from the page's
  own area to where it lands; every delete keeps the page in its journal pre-image; one read more per delete); promoting one
  Core moved Working pages under its index into canon unlisted, and pages added after the proposal (now refused,
  `SET_HAS_OTHER_PAGES`, with an in-lock subtree check: ADR 0046 decision 2); verify left full snapshots partial for good
  after one damaged object was repaired, and retention then deleted every weekly full, or every full (now set complete again,
  and the newest full of any state is always kept). High: look-alike status tags and Status values could replace the genuine
  ones unseen; a full snapshot's pieces were dated at the run's end, so restores could revert writes made during it (each page
  now records `capturedAt`, an optional manifest field); abandoning a running full snapshot wrote an empty complete one; a
  restored image was re-encoded (now its stored bytes exactly: ADR 0046 decision 5); `update_timeline_event` dropped an
  event's styling when it re-made it; a disk error during `POST /uploads/<id>` stopped the bridge (now a 507 `storage`
  refusal); backup protections switched off without re-authentication (ADR 0046 decision 3; the dashboard asks); a set job
  held after its first write, and two `update_resource` calls at once, overwrote or lost tags (now an in-lock name and tag
  check, no extra request); chronology stops misreported and a resume replayed a stale plan; a stopped recreate said the page
  "already matches"; a re-proposed paragraph split duplicated text. Medium and low: one `upload_id` used twice at once, the
  tool-call log storing an unknown tool's name as sent, missing pre-images (`updateEvent`, `updateLane`, a restore's
  `updateFeature` and sidebar rows), documents taken from an older snapshot, the CLI sign-in's checks, `PLACE_FAILED`'s
  report. **Open:** finishing a stopped recreate (E4-OPEN-1).
- **Block-by-block `write_page` and restores** (backlog 1; src/pages/blockwise.ts, blockwise-job.ts, undo.ts). A page with an
  inline icon is no longer `PAGE_NOT_WRITABLE`: only the blocks the edit changes are written (`insertBlock`, then
  `replaceBlock`, then `deleteBlock`), as one job with an in-lock content check, If-Match chained from the write before (a
  delete's from its ETag), journal pre-images and a whole-page verify; the plan is replayed on a copy first. An edit of the icon
  paragraph itself, a move, or an `unsupported` loss is still refused. A write that stops part-way is undone automatically,
  only when the page is exactly as it was left (`undo` in the answer). Restores of such pages work the same way, the icon
  paragraphs left as they are. The mock now models nested blocks, `parent` inserts and ETags.
- **PLAN-v2 10.6's concurrency acceptance tests:** many simultaneous writes to one page through mixed tools (every answer
  written or an explicit conflict, nothing lost; it found the `update_resource` tag loss); an outside write between the read
  and the write for blocks, sidebar, map features, board, resource and events. **New sandbox test** `concurrency`: same-version
  writes sent straight to LegendKeeper through the governor's raw client, recorded, not fixed (about 14 writes).
- **The off-site copy carries a fresh database copy** (backlog 3): each copy run starts with `deploy/backup.sh offsite`
  (newest 3 kept, apart from `nightly` and `pre-deploy`); the verify and `offsite-restore.sh` take the newest copy of any label.
- **Regions** (backlog 4): one consistent form (a region that still carries `polygon` gets it set to the first of its new
  `polygons`); `read_document` and the snapshot text name regions that carry both; the maps sandbox gains the M6e probe.
- **Footnotes are refused** (`UNSUPPORTED_MARKDOWN`, naming each; ADR 0046 decision 7). **Guides:** task sections rank above
  the reference sections ("chronology", "timeline", "event", "date", "map", "image", "snapshot", "audit" each lead to one).
  **Scenarios:** 4 asks for the first section; 21 records `deduplicated` as right (ADR 0046 decision 8).
- **Node 24:** `.nvmrc` pins `v24.22.2` (the server's, `deploy/install-node.sh`) and CI reads it and fails on another major.
  **Tests:** realistic defaults (20 s a test, 60 s a hook); timeline change snapshots are unchanged and proposed to the owner
  (ADR 0046 decision 6).
- **The E5 checklist** (the review, section 8): everything that must be true before the Arkona key goes into the bridge.
- **Tests:** 3,672 pass (4 skipped; 3,592 before), three full runs in a row with no failure or timeout, one on Node 22 and
  two on Node 24.22.2; the full CI passes on Node 24.22.2.

## Unreleased: v2 E3b: the owner's evaluation applied, forgiving guides, steering to the Core, and the evaluation helper

[ADR 0045](adr/0045-tool-review-and-the-tool-call-log.md) (section "E3b"); migration `2500_evaluation`; PLAN-v2 phase E, the E3b
row. The owner's results: [reviews/E3-results.md](reviews/E3-results.md) (scenarios 1 to 8 in both assistants, then a shortlist;
**every run ended right**). Nothing was run against a live system: no call to the owner's LegendKeeper bridge connector, not even
a read. Every test and measurement uses the mock.

- **The owner's answers on P1 to P11 ([reviews/E3-tools.md](reviews/E3-tools.md) section 3.2).** Applied: **P1** `get_resources`
  merged into `get_resource` (`resource`, or `resources` for up to 25 as one job; `RESOURCE_REQUIRED` if neither or both); **P2**
  `bridge_proposals_mine` merged into `bridge_proposal_status` (no `proposalId` lists yours); **P3** `bridge_job_wait` merged into
  `bridge_job_status` (`wait_seconds`, 1 to 25, with a `jobId`); **P4** `lk_upload_image` and **P5** `create_bare_resource` hidden
  by default; **P6** the checkbox reads "Show low-level and rarely used tools". Not applied: P7 (`create_many_resources` stays
  visible), P8 (`lk_api_batch` stays), P9 (`baseVersion` and `baseFactsVersion` stay optional: agents passed them every time),
  P10 (two guides), P11 (the map `style` schema).
- **The old names fail helpfully for one release.** `get_resources`, `bridge_proposals_mine` and `bridge_job_wait` stay
  registered but are never listed; a call from a cached tool list answers `TOOL_RENAMED` ("renamed to get_resource: pass
  `resources` …") and does nothing. Hidden tools (`lk_upload_image`, `create_bare_resource`) still work when called, under the same
  policy; the profile setting shows them. A `propose` or `write` profile now sees **56** tools (61 before), a `read` profile
  **25** (28 before); with the setting on, 61 and 28. Sizes are in [reviews/E3-tools.md](reviews/E3-tools.md) section 6.
- **Instead of P9: "write without a base version" on the Tool calls page.** A `write_page` call that edits existing content
  without `baseVersion`, or a `set_facts` call without `baseFactsVersion`, is badged and can be filtered, so the owner can see
  whether it ever happens.
- **Forgiving guide sections** (`get_bridge_guide`, `get_markdown_guide`). Six or more `SECTION_NOT_FOUND` in the evaluation ("find
  pages", "Read a page's text (or one section)", "Promote", …). A miss is now matched loosely (case, punctuation, spacing, a
  heading's key words, synonyms such as promote / promotion / lifecycle and find / search / read, and the labels of the "Which tool?"
  table): one clear match is returned and names the exact section; several return `SECTION_AMBIGUOUS` with the candidates; none
  returns `SECTION_NOT_FOUND` with `sections`, every exact name (this replaces the `headings` list in that error). "How to decide"
  lists the exact names to ask for.
- **Steering towards the Core.** `AMBIGUOUS` for one character's pages lists each with its role and adds "a character's facts and
  Scope live on its Character Core (or Character Reference for a compact character)"; `get_resource` on a character's `[INDEX]`
  (Working and Archived ones too) adds a `character` note naming the Core or Reference with its id; the bridge guide says so.
  Writes stay strict: a name that matches several pages is never resolved for the agent.
- **`upload_image` for Working, Archived and specialist pages.** `for_page` now works for a character's Core, Reference or index
  outside the Characters index, and for a specialist page (`{name} - …`), taking the race from the character's Race / Species fact
  (the repository tree, else one live read of that page; nothing is written). The D3 race rules are unchanged. When neither route
  works the refusal says exactly what to pass (`for_character { name, race }` or a `folder`): `FOLDER_REQUIRED`,
  `CHARACTER_AMBIGUOUS`, `RACE_NOT_FOUND`.
- **New: the Evaluation panel** on the Tool calls page, and the scenarios as data
  ([reviews/scenarios.json](reviews/scenarios.json)). Choose core or all and ChatGPT or Claude; copy each prompt, Start, paste
  into a fresh chat, Done: the bridge attributes that assistant's tool calls between Start and Done. Auto-grade hints (expected
  tools present, mistake tools present, error codes seen); the owner confirms Right, Partly or Wrong. Saved runs, a results table in
  the owner's format to copy, and a comparison of two runs. Owner only; no agent tool; prompts never name a tool. See
  [dashboard.md](dashboard.md).
- **For the owner after deploying:** refresh both assistants' tool lists (ChatGPT: Plugins, the bridge, **Refresh**; claude.ai:
  disconnect and reconnect). Run the core set once with the new helper, in Claude at least, to confirm the guide misses and the
  index-first habit are gone, and that scenario 21 places the image first time.

## Unreleased: v2 E3: the tool review, shorter and steering descriptions, and the tool-call log

[ADR 0045](adr/0045-tool-review-and-the-tool-call-log.md); migration `2400_tool_calls`; PLAN-v2 phase E, the E3 row (and a new E3b
row). The review: [reviews/E3-tools.md](reviews/E3-tools.md). The owner's evaluation script:
[reviews/E3-evaluation.md](reviews/E3-evaluation.md). Nothing was run against a live system: no call to the owner's
LegendKeeper bridge connector, not even a read. Every measurement and test uses the mock.

- **Wording only on the tools** (no tool, argument, schema type or behaviour changed): every description rewritten (what it
  does; when to use it and what to use instead; the scope behaviour; the cost line; the mistake to avoid); the repeated
  argument texts shortened (`project` is in all 61 tools); the guide tools' generated description fixed ("Returns the lk-bridge
  guide guide:"); `archive_page`, `unarchive_page`, `move_to_working` and `promote_page` now describe `subtree: true`;
  `lk_api_read` and `lk_api_write` say they are the fallback. A `propose` or `write` profile's tool list went from about 146,000
  to about 124,000 characters (about 36,500 to 31,000 tokens, an estimate); a `read` profile from about 10,400 to 9,100.
- **The bridge guide is organised around tasks.** "How to decide" first (five rules, a which-tool table with a "not this"
  column, what a scope means), then find and read, edit text, change facts, create a page or a character (Working first),
  rename and delete, the lifecycle, chronology, maps, images, snapshots, audits, budgets and proposals, canon, when the
  low-level tools are right, then the reference. Read it by `section`. The generated Operations section is unchanged.
- **The server instructions** are the ten-line version of the guide: read `get_bridge_guide` ("How to decide") first, then four
  rules.
- **The Markdown guide, checked against the converter.** Corrected: `UNSUPPORTED_BLOCK_LOSS` pointed at an
  `allowUnsupportedLoss` that `write_page` does not have; a trailing backslash or two spaces also make a line break; text after
  a callout marker joins the first paragraph; a bare URL stays text; the map header's wording. Footnotes are not supported (the
  converter reads `[^1]` with a definition as a link: **not changed**, for E4 or E3b).
- **Refusals name the next step**: the engine's typed errors without a hint (`READ_ONLY`, `DRAINING`, `MEMBER_ADMIN_DISABLED`,
  `CASCADE_CONFIRM_REQUIRED`, `CANONICAL_APPROVAL_REQUIRED`, `JOB_NOT_FOUND`, `UNKNOWN_PROJECT`) get one from a table; the hints
  of `POLICY_DENIED`, `VERSION_CONFLICT`, `BUDGET_EXHAUSTED`, `UNSUPPORTED_BLOCK_LOSS` and `waiting_budget` are sharper;
  `PAGE_NOT_WRITABLE`, the lifecycle refusals (`LIFECYCLE_INDEX`, `INDEX_PAGE`, `ALREADY_ARCHIVED`, `NOT_ARCHIVED`,
  `NOT_AUTHORITATIVE`, `NOT_WORKING`, `LIFECYCLE_NOT_CONFIGURED` and its kin), the batch `WORKING_PARENT`, `PAGE_EXISTS`,
  `PARENT_NOT_INDEX` and `ROOT_PAGE` say what to do instead.
- **New: the Tool calls page** (dashboard, after Journal) and `GET /api/admin/tool-calls`. Which tools each connection really
  called: time, connection, profile and scope, tool, a summary of the arguments (names and sizes; values only for booleans,
  numbers and a short list of reference arguments; never page content or secrets), outcome (success, error code, proposal
  captured, waiting, queued), duration and the request budget used. Recorded at the MCP SDK's own `tools/call` handler, so
  invented arguments, unknown tools and read-only refusals are in it. Kept 7 days by default (a setting, 0 to 90; 0 switches
  recording off); filters by connection, tool, outcome, error code and time. Owner only; no agent tool. `scripts/tool-surface.ts`
  measures the tool list as each client receives it.
- **For the owner after deploying:** refresh both assistants' tool lists (ChatGPT: Plugins, the bridge, **Refresh**; claude.ai:
  disconnect and reconnect), run [the evaluation](reviews/E3-evaluation.md), fill in its results template and send it back
  (E3b applied it, above).

## Unreleased: v2 E2: audits (findings only, read from the snapshots)

[ADR 0044](adr/0044-audits.md); migration `2300_audits`; PLAN-v2 4.12 and the E2 row. Nothing was run against a live
system: no call to the owner's LegendKeeper bridge connector, not even a read. Every test runs against the mock; the
sandbox test is written and dry-run against the mock, not run; the owner does the live checks (below).

- **Audits read the snapshots, never LegendKeeper.** The newest complete full snapshot plus every later change snapshot,
  from the snapshot store (E1a) and the bridge's own database (registry, lifecycle records, the chronology check's last
  run). A run makes **0 requests** (tested against the mock's request log). Each finding records its source snapshot and
  that snapshot's age; a full snapshot older than 36 hours (a setting) is flagged `stale_snapshot`; with no complete full
  snapshot the run is skipped and commits nothing.
- **When they run:** after each nightly full snapshot completes (in the background), from the dashboard's **Run an audit
  now**, and from the new maintenance job `audit-run` (off by default). The placeholders `orphan-and-link-audit` and
  `tag-audit` are gone (migration 2300 removes their rows).
- **Findings**, per run: code, category, severity (error, warning, info), page, document and block, evidence (expected and
  found), source, fix. **Tracked across runs:** new, still present (with "first seen"), gone (with when); a gone finding that
  returns is new. **Acknowledge** with a reason: hidden while the same evidence persists, back (marked "evidence changed") if
  it changes; kept if the finding goes and returns unchanged. Nothing is pre-acknowledged.
- **Rules** (a per-project list, edited on the dashboard, audited, needing re-authentication like the canon rules; seeded
  from the registry: Character Core, Compact Character Reference, the Index template): selectors Reference Type, name
  prefix, ancestor name, and, new, registry type with a role, and kind; a template by registry role, name or id. The old
  bridge's codes keep their meanings (`no_matching_rule`, `ambiguous_owner_rule`, `incomplete_owner_ancestry`,
  `property_kind_mismatch`, `property_order_mismatch`, `property_presentation_mismatch`, `property_row_order_mismatch`,
  `document_type_mismatch`, `document_order_mismatch`, `missing_required_tags`, `tags_outside_definition`, `duplicate_tags`,
  `missing_target`, `inaccessible_target`, `deleted_target`); new: `ambiguous_ancestor`, `ambiguous_template`,
  `template_not_found`, `rule_selector_unknown`, `property_missing`, `property_row_missing`, `document_missing`,
  `tag_definition_invalid`, `tag_rule_unknown`. Templates are compared for structure, **never values**. The tag-definition
  source (a page and one document with exactly one `json` code block) is chosen on the dashboard.
- **The checks:** template and tag rules; internal references (missing, deleted and inaccessible kept distinct from the
  bridge's own knowledge, since a 404 does not prove deletion; **`canon_refers_to_archived`**: an Authoritative page linking
  to a `[BARC]` page); unclassified pages; ordering (reported, never moved); taxonomy drift on the snapshot (the registry's
  own drift walk, plus races not in the taxonomy, entries with no pages, entries waiting for review); fact consistency
  (Reference Type values the registry does not know, Subject and Canonical Display Name against the name); lifecycle
  consistency exactly as the E2 row states, C2d's set exception included, and incomplete lifecycle and set records with
  their pages (**never fixed**); keep-region health (paragraphs with line breaks, inline-icon pages, `unsupported` blocks
  per page, collection blocks); and D1's chronology findings folded in as their own category.
- **"Propose a fix"** (the dashboard; never applied by an audit): re-reads its target live, refuses a finding that is out of
  date, then creates ONE ordinary proposal through the machinery of an existing tool, with every guard (the owner approves it
  on the Proposals page): a paragraph with line breaks split into paragraphs **block by block** (`insertBlock` for the new
  parts, then `replaceBlock` cutting the original to its first part, so a refused write loses nothing; the compare-and-swap inside the lock, a verify step; never the whole page, so it works
  beside inline icons); `set_facts` **only when the right value is unambiguous** (Kamigawa Miyuki's Reference Type is
  `Compact Character Reference`; Mehrana al-Khalid, Founder's Subject is reported with no fix); `move_resource` under the same
  parent; an additive tag fix (never a removal; a status tag is refused by the lifecycle guard); and D1.1's
  `sync_timeline_event` through the chronology module. An optional **Re-check now** reads the finding's page live.
- **The full snapshot now also takes the templates** (they sit outside the AI REPOSITORY; an additive manifest field,
  `templates`; about 2.3 reads each, 35 a night for 14 templates) so templates can be compared without a live read
  (ADR 0042 amendment). The snapshot cost test counts them.
- **Dashboard:** the **Audits** page (after Snapshots): the latest audit (snapshot, age, stale), the summary by category and
  severity, filters (category, code, severity, page path, new, acknowledged, resolved), per-page grouping, each finding's
  evidence with a link to the page's snapshot history (`/snapshots?page=<id>`, new), acknowledge, Propose a fix, Re-check now,
  the runs with their duration and snapshot, the rules editor, the tag-definition source and the settings. Admin routes under
  `/api/admin/audits`.
- **MCP:** `audit_findings` (read, free): filters, paging, `detail: full` for the evidence. There is no agent tool to run, edit
  or acknowledge an audit. The tool counts become 62 (151 with the per-operation tools); the no-agent-escalation test's name
  pattern exempts `audit_findings` (the policy audit log stays unreachable).
- **Tests** (3,437 pass in all; `test/audits/`, `test/ui/audits.test.tsx`, `test/chronology/audits.test.ts`): every check with hand-made worlds;
  the reader over base and change snapshots; the store (new, still, gone, back; acknowledge, hide, reappear); the real stack
  on the mock world (zero requests, snapshot age, a stale snapshot, the owner's first findings, all four fixes against the real
  engine including the paragraph split beside an inline icon and the in-lock conflict, the dashboard API, `audit_findings`,
  the maintenance job); the chronology fold-in with D1.1's fix; the dashboard. The mock gained `replaceBlock`.
- **Docs:** ADR 0044, [tools.md](tools.md#audits-v2-e2), [bridge-guide.md](bridge-guide.md#audit-findings),
  [dashboard.md](dashboard.md#audits-v2-e2), [maintenance.md](maintenance.md#audits-v2-e2), PLAN-v2 (the E2 row, 4.12, the
  tool table).

**Live checks for the owner (after deploying):** run an audit from the dashboard right after a nightly or manual full snapshot;
acknowledge one finding; "Propose a fix" for one line-break paragraph and approve it; run an audit again after the next
snapshot and check that it is gone. The sandbox test (`deploy/sandbox-test.sh --project test -- audits`) is written, not run.

## Unreleased: v2 E1b: the encrypted Google Drive copy

[ADR 0043](adr/0043-google-drive-offsite-copy.md); migration `2200_offsite_copy`; the one-off Google set-up in
[drive-setup.md](drive-setup.md). Nothing was run against a live system: no call to Google, Drive or the owner's
LegendKeeper bridge connector. Every test runs against a mock Google OAuth and Drive server and a fake `rclone` that
records its arguments and acts on a local directory; the owner does the live checks.

- **Public `/about` and `/privacy` pages** (ADR 0043 addendum): Google needs a home page, a privacy policy link and
  authorised domains before it lets an external app be published; `drive-setup.md` wrongly said to leave them empty
  (corrected: step 3 now sets them, and explains the greyed-out **Publish app** button's tooltip). The bridge serves both
  pages itself: static, no sign-in, no cookie, no script, the dashboard's CSP, stylesheet at `/public.css`. New dashboard
  setting **Contact email** (no default; applies at once; the `/privacy` contact line is omitted when unset). `GET /` and
  the dashboard are unchanged; Caddy needs no change. Owners who published with a temporary link: switch the Branding
  links to the new pages; the published status is unaffected.
- **The connection, on the dashboard** (new **Off-site copy** page): the owner's own Google app (`drive.file` only,
  published so its refresh token does not expire after 7 days); the client ID and secret, the refresh token and the
  encryption keys kept in the encrypted secret store (scope `offsite`), never in the env file. Sign-in with PKCE (S256)
  and a `state` bound to the dashboard session (10 minutes, once), `access_type=offline`, `prompt=consent`; the callback
  `/admin/drive/callback` refuses a mismatched, expired or session-less answer, checks the scope, and names the account
  (`about.get`). Disconnect revokes at Google and deletes. Saving the client, connecting, disconnecting and setting keys
  need re-authentication within 5 minutes. Tokens, the client secret and the keys are never logged or shown.
- **Encryption keys:** rclone crypt with a password and a salt, names encrypted too. Generated (shown once, saved only
  after the last 6 characters of each are typed back) or the owner's own. A change after a copy exists starts a fresh full
  upload into a new folder (`copy-<n+1>`), after the owner confirms; the old folder is kept until deleted on the page.
- **The runner:** `lk-bridge-offsite.service` (separate from the bridge, `lkbridge`, idle I/O, `Nice=15`,
  `MemoryMax=768M`), started by `lk-bridge-offsite.timer` (every quarter hour; the daily copy's time, 04:45 by default,
  and the monthly verify are dashboard settings in the database) and `lk-bridge-offsite.path` (Copy now, Verify now, and
  after each nightly full snapshot). `deploy/offsite.sh` runs `dist/offsite/cli.js`. A temporary 0600 rclone config in the
  unit's private `/tmp`, removed after success, failure, a crash or a stop. Copies `objects/`, then `manifests/` (only
  those older than the run), then removed objects, `STORE.json`, then the nightly database copies; `--backup-dir` keeps
  what a sync replaces or removes in `deleted/<date>` for 30 days, then the runner purges it. Bandwidth limit and
  transfers are settings. A refresh token rclone renews during a run is saved back. Refuses an empty store, a folder this
  database never copied into (until adopted), and rclone missing or older than 1.60.
- **rclone:** the runbook installs rclone's current release from rclone.org (one line); Ubuntu 24.04's 1.60.1 works but is
  not recommended.
- **Proof:** a **verify** job (monthly, and Verify now): every manifest and 1% of the objects (at least 50) downloaded,
  decrypted and re-hashed against their names, every manifest's pieces checked present, the newest database copy through
  SQLite's `integrity_check`; findings in red. **`deploy/offsite-restore.sh`** pulls the store and the newest database
  copy for a disaster recovery, checks every object and the database, and prints the commands that put them in place.
  `offsite.sh set-client`, `connect` and `set-keys` enter the Google client, the sign-in and the keys when the dashboard
  is not up.
- **Health:** the Overview turns red when the Google sign-in is refused (Reconnect), the last good copy is older than 2
  days (a setting), or the last verify found problems.
- **Deploy:** `deploy.sh --update-self` now also installs the backup and off-site units when they differ or are missing
  (an installed copy backed up first), reloads systemd and enables the timers and the path unit, without restarting the
  bridge when nothing else changed.
- Docs: [drive-setup.md](drive-setup.md), the runbook ("Off-site copy to Google Drive", "Disaster recovery from Google
  Drive"), [dashboard.md](dashboard.md#off-site-copy-v2-e1b), [maintenance.md](maintenance.md#the-off-site-copy-v2-e1b),
  PLAN-v2 (4.11, the E1b row, settled item 4).

## Unreleased: v2 E1a follow-up: the owner's sandbox run (13 November 2026)

[ADR 0042](adr/0042-snapshots-restore-rehearsal.md) (amended: decisions 4, 7 and 9); migration `2100_snapshots_nightly`.
What the owner's sandbox run showed: every restore type, undelete, the full snapshot and the clean-up passed; U.a to U.e
(`updatedAt`), D2 (the icon name) and H (the rehearsal) failed. Nothing was run against a live system (the owner's
LegendKeeper bridge connector was not called, not even for reads); every test is against the mock, and the sandbox script
is written and dry-run against the mock, not run against LegendKeeper.

- **Full snapshots are nightly** (`snapshot-full`, every night at 00:30 London time, was Sunday), because app edits must be
  caught within a day and **LegendKeeper's `updatedAt` does not move when content changes** (U.a to U.e all failed:
  resources and documents, for blocks, sidebar rows, map features, timeline events and board content). About 2.24 reads a
  page: roughly **3,400 reads a day on Arkona against the 60,000 cap, about 340 on the test world**, at P3. A deployment
  that had not changed the schedule works out its next run again from the new default (the migration).
- **The daily changed-pages pass is removed**, not left as a dead switch: the `snapshotDailyPass` and
  `snapshotDailyPassDocuments` project settings (dashboard and settings), the `snapshot-daily` maintenance job, its service
  method, its run kind, its memory table and a manifest's per-page `updatedAt`. Migration 2100 drops the table and the stored
  settings and the job's row. The sandbox script keeps one NOTED line (`U`) with the fact.
- **Retention by age** (all settings): every full snapshot for `SNAPSHOT_KEEP_FULL_DAYS` (**30**) days, then one per ISO week
  (the latest of that week, London time) for `SNAPSHOT_KEEP_WEEKLY` (**8**) weeks, then none; the newest complete one is
  never removed; change snapshots `SNAPSHOT_KEEP_DAYS` (**30**). The Snapshots page says so. `SNAPSHOT_KEEP_WEEKLY` now means
  weeks of one-a-week, not a count of fulls. The collector and GC are unchanged and tested after a prune.
- **Images are not downloaded every night:** a library asset whose id and URL are as an earlier snapshot recorded them is
  recorded from that hash, without a download (LegendKeeper's asset URLs are content-specific, so a replaced image has a new
  URL and is downloaded, like a new one). A second full snapshot of the mock world with nothing changed: 132 reads,
  **0 downloads, 0 new objects, 0 new bytes**. An image whose stored bytes an open verify finding calls damaged is fetched
  and written again (the repair). The weekly `snapshot-verify` is where stored bytes are re-checked.
- **Icon names on writes (D2).** LegendKeeper reads an icon as `fas fa-book` and writes it as `book` (400 otherwise). Every
  place the bridge writes back what it read now converts (`fas`, `far`, `fab`, `fal`, `fat`, `fad`, `fa-solid`,
  `fa-regular`, `fa-brands`… and `fa-` removed; a bare name unchanged): a restore and a recreate (the page, map pins,
  timeline events), the rehearsal, `update_resource`'s icon and the map-feature tools' `style.iconGlyph`. **A name
  LegendKeeper still refuses no longer fails the restore:** the write is sent again once without the icon, the restore
  finishes, and the Snapshots page and the restore record list it under "couldn't be restored exactly" (new step option
  `dropIfRefused`, bridge code only). The sandbox's D2 now reports which form LegendKeeper accepts, how it reads back, and
  whether the icon came back, before the original-id check.
- **The rehearsal's refusal of itself (H).** Not the nesting first suspected (it makes one page a job): a page whose
  creation was refused (the icon) left its children naming a parent that did not exist, which the guard read as "outside the
  root" and aborted the whole run. A refused page is now a difference, its descendants are "not attempted", the rest goes
  on; and the guard (`assertInsideRoot`) also counts ids created by earlier steps of the same job as inside, while still
  refusing a foreign parent. A test with a refused parent fails on the old code with the owner's exact message.
- Tests (mock): the retention table over 120 nights and a prune with the collector and verify; the image reuse (zero
  downloads, a replaced asset, a new asset, a damaged object); every icon prefix form, a bare name, a refused icon dropped
  and listed, a recreate that succeeds; the guard over three levels in one job and a foreign parent; the removed pass in the
  settings, the jobs, the admin API and the dashboard; migration 2100.

## Unreleased: v2 E1a: snapshots, restores as proposals, the rehearsal

[ADR 0042](adr/0042-snapshots-restore-rehearsal.md); migration `2000_snapshots`. E1 is split: E1a (this) is the bridge's own
snapshots, restore and the rehearsal; E1b, next, copies the store and the database copies, encrypted, to Google Drive.
Nothing was run against a live system (the owner's LegendKeeper bridge connector was not called, not even for reads): every
test runs against the mock; the sandbox check is written and dry-run against the mock, not run against LegendKeeper.

- **The snapshot store** (`/var/lib/lk-bridge/snapshots`, `SNAPSHOT_DIR`; 0700 / 0600): every piece (a page's settings,
  its sidebar in C2a.1's form, each document by type, each image's bytes) stored once, gzip, named by the SHA-256 of its
  canonical form; `manifests/<project>/<id>.json.gz` on disk, indexed in the database; write-once files, objects before
  manifests: **the layout is E1b's contract**. D3's kept bytes are merged into it (adopted at start-up).
- **Full snapshots** weekly (Sunday 00:30, `snapshot-full`): every page under the AI REPOSITORY and the whole asset
  library, P3, giving way to agents, resumable, refused below `SNAPSHOT_MIN_FREE_GB` (**10 GB**). **Change snapshots** at
  the end of every bridge write's job, from its verify reads (they never download an image: the bridge's own uploads hand their bytes to the store, and any other image the store lacks is named by URL and taken by the next full snapshot). A **daily changed-pages pass** (`snapshot-daily`), off per
  project until the sandbox check confirms `updatedAt`. **Retention** (8 weekly, 30 days) and a collector
  (`snapshot-prune`); **verify** with findings and partial snapshots (`snapshot-verify`). Weekly schedules on the
  Maintenance Jobs page.
- **Three tools:** `list_snapshots` (free), `snapshot_diff`, `restore_snapshot` (**always a proposal**, at every scope:
  a page's documents, its sidebar, one document, a deleted page undeleted or recreated with its original or new ids, a
  deleted image back as a new asset with its references updated when the owner ticks it). The canon, lifecycle and
  decision-5 guards apply; what cannot be restored (`unsupported` blocks and inline icons no longer on the page) is listed.
  A sidebar restore covers the facts property, the link collections and every other key-value property, row by row.
- **The rehearsal:** a full snapshot of one project restored into a throwaway root of a sandbox project, with new ids,
  compared exactly (Markdown and blocks ignoring ids, sidebars, map features, timeline events, board shapes, image bytes),
  then deleted; sampled (about 50 pages covering every kind) or full with its estimate first; never into its source.
- **The Snapshots page:** the store against the disk (size, deduplication, free space, the next full snapshot's
  estimate), findings, runs, each page's history with diffs, Propose a restore, a deleted image, the rehearsal and its
  results, the snapshots, and the nightly database copies with their age. The Proposals page shows a restore's diff and
  what it cannot restore. The dashboard shows sizes in GB and TB.
- **The opt-in sandbox check** (`deploy/sandbox-test.sh --project test -- snapshots`): every piece type restored and read
  back exactly, undelete, recreate (does LegendKeeper take the original id?), `updatedAt` on (a) a block, (b) a sidebar
  row, (c) a map feature, (d) a timeline event, (e) the board, a sampled rehearsal; about 300 reads and 70 writes.
- **Fixed on the way:** the dashboard's page search in the snapshots matched documents' names, not pages'.
- **Costs** (mock): a full snapshot 2.24 reads a page; change snapshots 0 to 4 reads a write (`write_page` 1, `set_facts` 0);
  a full rehearsal about 4.3 writes and 2.2 reads a page.

## Unreleased: the owner's live checks of 12 November 2026: root moves on maps, the sandbox image folder, outsiders on archive and move to Working

Notes in [ADR 0040](adr/0040-map-feature-tools.md) (root moves), [ADR 0041](adr/0041-image-pipeline.md) (the image directory) and
[ADR 0037](adr/0037-whole-set-lifecycle-and-page-scoped-ids.md) (outsiders); no migration, no new decision. Nothing was run
against a live system (the owner's LegendKeeper bridge connector was not called, not even for reads): every test runs against
the mock, and the sandbox changes are written and dry-run against the mock, not run against LegendKeeper.

- **Moving a map feature to the top level now works.** `update_map_feature` with `folder: null` failed live with
  `VALIDATION_ERROR` (nothing written). The owner's probe on the real API: `updateFeature` with `parentId: null` is a 400
  (`parentId: "Expected string, received null"`: the schema's "(null = root)" is wrong, its `type: string` is enforced);
  `parentId: ""` with a rank succeeds and the feature reads back with `parentId: ""`; the bridge's base-62 midpoint ranks are
  accepted; a feature created at the top level reads back with no `parentId` at all. So **a move to the top level sends
  `parentId: ""`, never `null`**, and the bridge's own validation of `updateFeature` no longer lets `parentId` be null (a raw
  `lk_api_write` with null is refused locally, before it spends budget).
  - **One reading of a feature's parent** (`parentOf`, `src/maps/features.ts`): absent, `""` and `null` are the top level.
    Planning, siblings, the checks inside the lock, verify, `read_document`'s tree, the cascade, `featureFolder: null` and the
    journal summaries all use it. Asking for the top level of a feature already there sends nothing.
  - **The mock reproduces the real API**: a moved-to-top-level feature reads back with `parentId: ""`, one created there has no
    field, and `null` on `updateFeature` is refused with the same 400 and issue.
  - **Sandbox M6c** asserts `""` works (also with a midpoint rank between two siblings); a new **M6c-null** sends a raw
    `parentId: null` through the governor and records the refusal as **NOTED**, a fact about LegendKeeper and not a failure
    (the report has a new NOTED verdict and count; INCONCLUSIVE if LegendKeeper starts to accept it).
  - **Tests:** pure functions (`parentOf`, `holds`, `siblingsOf`, `findFeature`, `descendantsOf`, `verifyFeatures`,
    `buildUpdate` for the top level plain and with `after` / `before`, `buildCreate`, the registry's refusal of null), and
    through the tools: move to the top level plain and beside a named sibling, into a folder and back, verify reading `""` as the
    top level, siblings with `""` and with no field, a cascade, `read_document`, the dry run, and the mock refusing null.
- **The sandbox runtime no longer touches the app folder.** All five sandbox files failed in their first second with
  `EACCES: mkdir '/opt/lk-bridge/app/data/images/upload-tmp'`: `createSoakRuntime` passed the default tool settings
  (`images.dataDir: null`) and the runtime resolved "next to the database" from the config's `./data/bridge.db`, under the
  read-only app folder, not from the temporary database it was given. The live bridge was unaffected; CI did not notice because
  its working directory is writable (every test with default settings had been creating `./data/images/` there).
  - `createSoakRuntime` sets the image directory inside its own temporary directory.
  - **The runtime derives the default image directory from the database it was actually given** (`databaseFile`, from
    `PRAGMA database_list`), never from a working-directory-relative default. The live bridge's directory is the same.
  - **`upload-tmp/` and `kept-bytes/` are created lazily** (my call): by the first binary upload and the first kept file. A
    runtime that handles neither touches no folder at all; the start-up clean and the sweep treat a missing directory as empty.
  - **CI:** `test/tools/sandbox-runtime-readonly.test.ts` builds the sandbox runtime, and the real boot path with default
    settings, under Node's permission model with the app folder read-only, as the loader test does (it fails on the old code);
    `test/images/directory.test.ts` covers the derivation and the lazy creation.
- **Outsiders on `archive_page` and `move_to_working` with `subtree: true`.** C2d.1 listed same-subject Working pages outside a
  set only for `promote_page`; it was **not** present for the other two, so it is now: the same `outsiders` listing and flag in
  the dry run and the proposal. Archiving a Working character would have left its flat specialist pages Working, behind it. The
  advice depends on the set: move them in first (promote, archive of a Working set); a Working page cannot be moved into an
  Authoritative set, so archive each as well; after `move_to_working`, bring them in once the set is Working. `unarchive_page`
  lists none. Tests in `test/lifecycle/working-sets.test.ts`.
- **The Staging page follows agents' uploads** (owner's addendum, 12 November 2026). The page reloaded only after the owner's
  own actions in that tab (there was no stream event for staging, and it neither polled nor listened). The image service now
  sends a **`staging` event** on the engine's bus, which the dashboard's stream relays, from its own store whenever a staged
  upload is created, finishes converting or verifying (`uploaded`), is placed, discarded or fails: whatever the route (an MCP
  tool, `upload_image` with `stage: true` or any upload at `propose`, a proposal's approval, a job ending, the binary
  endpoint, the dashboard), not from the dashboard's routes. The data is `{ projectId, stagedId, change, name, state, source,
staged, old }` (the counts after the change, for the old-images report and any badge; there is no navigation count yet).
  The service now also follows a placement proposal itself: on the proposal's own events, and when any job ends, it settles
  open placements, so an approval is announced when it happens and not when someone next reads the list (a proposal approved
  with nobody looking left the record stale until then). The page listens (`useProjectReloadOn`), ignores other projects'
  events and reloads once for a burst; `staging` is in the UI's event list. Tests: `test/images/staging-events.test.ts` (an
  MCP stage, a propose-scope stage, an approval's placement, a rejected proposal, a failed upload, a discard: each on the
  engine's bus and in the real `/api/admin/stream` frames) and `test/ui/staging.test.tsx` (the list gains, loses and recounts
  without a reload; another project's event is ignored; a burst is one reload).
- **A subfolder for character and page destinations** (owner's addendum 2, 12 November 2026). Placing a staged image in, say,
  a character's Wardrobe folder was awkward: the Place form had no subfolder. It now has a **Subfolder** field for a character
  and for a page (not for a folder path, which already says where), written like the folder chain, `Wardrobe` or
  `Wardrobe / Qipao`. The bridge splits it on `/`, trims each part and refuses an empty part, `.` and `..` with a message that
  shows how to write it (`INVALID_SUBFOLDER`, one parser, `parseSubfolders`, used by every route), and passes the result as the
  existing `subfolders` list, so the folder rules are untouched (reuse, create in order, a non-folder of the same name is
  `ASSET_NAME_CONFLICT`). **Preview:** as the owner types, the form asks `POST /api/admin/staging/preview` (a dry run of the same
  planner, nothing written) and shows `Characters / Beastkin / Qishen / Mehrana al-Khalid / Wardrobe / Qipao (2 new folders)`,
  each new folder marked, or the reason it would be refused. **`upload_image`** (and so a staged image's intended destination)
  also takes `subfolders` as one path string as well as a list. The dashboard's upload box has no destination options (an
  upload is staged in the staging folder and placed afterwards), so there was nothing to add there. Tests:
  `test/images/subfolders.test.ts` (the parser, one and two levels, existing and missing folders, a non-folder conflict, bad
  paths, the string form in the MCP tool, for_page, the preview and placing), and `test/ui/staging.test.tsx` (the field, the
  preview with new folders marked and counted, the refusal shown, the body sent). Docs: dashboard, tools, bridge guide.
- **Docs:** ADR 0040 (the probe results and a corrected decision 9), ADR 0041 (the image directory), ADR 0037 (outsiders),
  `docs/tools.md`, the bridge guide, the runbook (the image directory is created on first use), `test/sandbox/README.md` and
  PLAN-v2.

## Unreleased: v2 C2d.1, Working sets built one page at a time, and moves within a lifecycle area (12 November 2026)

Notes in [ADR 0035](adr/0035-page-lifecycle.md) and [ADR 0037](adr/0037-whole-set-lifecycle-and-page-scoped-ids.md); no
migration, no new decision. Nothing was run against a live system: every test runs against the mock LegendKeeper. It
answers the owner's live test of 12 November: a Working character with a Core and two specialist pages could not be built
up one page at a time, so the set promotion covered only the index and the Core.

- **Single Working creates follow the batch rule.** `create_resource` and `create_bare_resource` with
  `status: "working"` take a `parent` that is `[INDEX] Working` (the default, unchanged) or an `[INDEX]` page inside a
  Working set (a character's own index, or any index within a Working set kept together), and place the page
  alphabetically among that index's children. Any other parent, including a `[BWRK]` page, a normal-tree index and
  anything in the Archived area, is `WORKING_PARENT`, naming the allowed ones (`allowedParents`). `create_many_resources`
  now uses the same rule (it allowed only a character index directly under Working). To build a Working character:
  `create_character` (Working), then `create_resource` (Working) with `parent` = the character's index.
- **Moves within a lifecycle area are ordinary moves** (owner, 12 November). `move_resource` of a `[BWRK]` page (or a
  Working set's `[INDEX]`, with its pages) between `[INDEX] Working` and an `[INDEX]` inside a Working set, and of a
  `[BARC]` page or an archived set's `[INDEX]` with its pages between `[INDEX] Archived` and an `[INDEX]` inside an
  archived set, and back: no lifecycle change, no canonical approval, prefix, Status and tags never change. The lifecycle
  guard is unchanged and still refuses a move into or out of either area and between the two. A move writes no record, so
  each page's record keeps its original previous place and `unarchive_page` (single or `subtree`) still returns it there;
  a Working page or set now goes back to the Working-set index it came from when that still exists, else to
  `[INDEX] Working`.
- **The set promotion lists outsiders.** The plan and dry run of `promote_page` with `subtree: true` list under
  `outsiders` the `[BWRK]` pages flat directly under `[INDEX] Working` that share the set's subject (`subjectOf`), with a
  `suggestion` to bring each in with `move_resource` first and a flag in the proposal, so the owner does not approve a
  partial promotion by accident. Nothing is moved for the agent.
- **Guidance.** The bridge guide, `docs/tools.md` and the `create_resource`, `create_bare_resource`,
  `create_many_resources`, `create_character`, `move_resource` and `unarchive_page` descriptions explain how to build a
  Working character and what a move within an area is. PLAN-v2 gains a C2d.1 row.
- **Unchanged:** the status-tag, canon and decision-5 guards, the lifecycle marker and record, and `create_index` (no
  index under a lifecycle index).
- **Tests (mock):** `test/lifecycle/working-sets.test.ts`, 13 tests: single Working creates under a Working character
  index, a nested Working set index and `[INDEX] Working`, alphabetical, refused under a `[BWRK]` page, a normal-tree
  index, `[INDEX] Archived` and an archived set; moves within each area with no approval (a page, and a set's index with
  its pages), refused into, out of and between the areas, and `unarchive_page` restoring from the record after a move
  within the archive (a page and a set); the dry run's outsiders, then a promotion that covers them once moved in; and
  the owner's scenario end to end (a Working character, two specialist pages one at a time, one approval, all four pages
  under the race index as `[BSRC]`).

## Unreleased: v2 D2, the map tools, map images and pixel coordinates (12 November 2026)

[ADR 0040](adr/0040-map-feature-tools.md). No migration. Nothing was run against a live system (the owner's LegendKeeper
bridge connector was not called, not even for reads): every test runs against the mock, and the sandbox test is written and
dry-run against the mock, not run against LegendKeeper.

- **`create_map_feature`, `update_map_feature`, `delete_map_feature` (W).** A pin, label, region, path or folder on a map
  document of a page inside the AI REPOSITORY, identified by `page` plus `document` (optional when the page has one map; a
  blank document, a page, a timeline or a board is refused with the tool to use). One job (one proposal at `propose`), with
  `dryRun`, `operation_id`, verify and the journal. 53 → 56 bridge tools.
  - **Coordinates:** `latlng` or `pixel`, never both; `points` / `polygons` for regions and paths. Pixels count from the
    image's top-left corner and are converted with the map's **live image, read inside the job**, by the schema's own formula
    (checked against the SDK's `pixelToPos` / `posToPixel`, the schema's text and the app's frame `[-y/2^z, x/2^z]` as a
    property test at 10,000 runs over random sizes, and again over random bounds); refused if the image changed since the
    pixels were chosen. Pixels are refused on a legacy tiled map and on a map with no image (naming `latlng`); outside the
    image or the bounds is refused unless `allowOutside: true`.
  - **The compare-and-swap inside the lock.** LegendKeeper does not version features, so `bridge.expect` gains a `map` check
    (a map checker, registered by name, run on the map read again inside the lock) that judges the plan's resolved request
    (the feature's hash, the folder, the sibling, the frame) and works out the body to send from the map as it is then;
    `bridge.verify` gains `mapChecked`. A feature edited, a folder or sibling gone, an image replaced, or a feature added
    under a folder being deleted since the plan is a conflict with nothing sent (a proposal ends `conflicted`).
  - **Order, folders, links, styles.** At the end of the parent by default, or `after` / `before` a named sibling; the rank is
    fractional indexing between the real neighbours (reference vectors and a property test); never alphabetical. Folders by name
    or id (several of one name refused with their paths); `folder: null` moves to the top level (assumed from the spec's
    "null = root"; the registry's validation lets `parentId` be null for `updateFeature`; to verify). `link` is a page by name
    or id, optionally a document (an ambiguous name refused with each candidate and its role, checked live, `link: null` clears);
    `style` checked against the schema's enums and formats, and refused on a type it does not apply to.
  - **Delete.** `confirm: true`. LegendKeeper leaves a folder's features when it deletes the folder, so a folder that holds
    features needs `cascade: true`: the features are deleted deepest first, then the folder, as one job; the answer lists
    everything removed, and the journal keeps every removed feature in full (each delete's own entry, and the folder's entry
    holds all that went with it, `StepOptions.journalPreImageWith`, the lane-delete lesson). A stopped cascade is resumed by
    asking again, never replayed. No record table (one document, atomic writes), so no migration.
  - **Canon:** feature edits are ordinary edits, on an Authoritative page too (ADR 0036 decision 6, option (a); tested);
    deleting the whole map document stays canonical.
- **`update_document` sets a map's image.** `mapImage` is a library asset by id or name (a name matching several is refused
  with each candidate and its folder); a **blank document becomes a map** when given one (still refused without); a
  replacement with a different pixel size **needs `confirm: true` when the map has features** (owner decision, 12 November
  2026): without it the call is refused and nothing is written (`CONFIRMATION_REQUIRED`, how many features will sit over
  different pixels and the old and new dimensions); with it the call goes ahead and the warning
  (`FEATURES_OVER_DIFFERENT_PIXELS`) stays in the result. The same size, or a map with no features, needs none. Under
  `propose` scope the proposal shows the count and approving it is the confirmation. It moves nothing; a legacy map replaced
  warns too. Verified (`maps.image`).
- **`read_document` on a map** now costs 2 reads (the document's settings carry the image) and adds the map's `width`,
  `height` and `bounds` to the header and each position in pixels beside its lat/lng (a region's or path's points too; long
  lists summarised unless `detail: "full"`); a legacy tiled map and a map with no image say so. The JSON form is unchanged.
- **Measured against the mock:** `create_map_feature` and `update_map_feature` 5 reads and 1 write; `delete_map_feature` of one
  feature 6 and 1, a cascade of 6 features 11 and 6; setting an image 7 and 1; a map read 2 reads.
- **Tests:** 127 map tests (unit, create, update, delete, propose and conflicts, canon, image, read, and the sandbox script's dry
  run) on a mock map world (a 2048×1024 map, a legacy tiled map, a blank document, folders, every type, linked and unlinked
  features, names that occur twice). The existing `read_document` map test moved from 1 read to 2.
- **Merged `main` (D3) and the sandbox wait helper.** Every write of `test/sandbox/maps.ts`, its clean-up included, now goes
  through D3's `test/sandbox/wait.ts` (`runSettled`, `waitForJob`), as the smoke, assumptions and images scripts do, so a write
  parked for budget (`waiting_budget`) or queued is waited for and never sent again. The dry run was extended: with three
  writes really held for budget on the mock (a map job's `createFeature`, a document write and the clean-up's page delete,
  each throttled for 31 s) it waits for all three, sends none twice and leaves nothing behind. D3 keeps an asset's bytes
  before any `deleteAsset`, so the dry run stands in for that download, and the clean-up now believes "already gone" only
  after a read says so (a failure that merely sounds like it no longer counts as cleaned). Tool counts: 56 → 58 bridge tools
  with D3's two (147 with the per-operation tools).
- **Sandbox (written, dry-run, not run).** `deploy/sandbox-test.sh --project test -- maps`: a throwaway page and map, two
  generated PNGs, a feature of every type by pixel position, links, a folder with a nested pin, a move, a cascade delete, an
  image replacement; PASS / FAIL / INCONCLUSIVE per check; cleans up everything (a 404 counts as cleaned). See
  test/sandbox/README.md.
- **Docs:** ADR 0040, docs/tools.md, the bridge guide (maps: pixels against lat/lng, links, folders, legacy maps), the
  Markdown guide (how maps read), docs/policy.md, test/sandbox/README.md, PLAN-v2's D2 row and notes.

## Unreleased: v2 D3, the image pipeline (12 November 2026)

[ADR 0041](adr/0041-image-pipeline.md) (with the threat review of the new endpoint). Migration 1950. Nothing was run
against a live system: every test runs against the mock LegendKeeper, and the sandbox test is written, not run.

- **`upload_image`** (W): exactly one source: `data_base64`, `url`, `upload_id` (the binary endpoint) or `staged_id`.
  The image is converted with **sharp 0.35.5** (pinned; a prebuilt binary, no compiler): WebP at quality 90, dimensions
  kept, the EXIF orientation applied, metadata dropped, transparency and every animation frame kept; a WebP is stored
  byte for byte. The type comes from the file's first bytes only. Bytes, pixels (`IMAGE_MAX_PIXELS`, 100 MP, all frames
  together) and frames (`IMAGE_MAX_FRAMES`) are capped from the header; truncated files and decompression bombs are
  refused with precise codes; one conversion at a time with a time limit.
- **One job per upload**: missing folders, the upload, then a **verification** that downloads the stored file
  (anonymously, governed and guarded, from `LK_ASSET_HOSTS`) and compares its SHA-256 (`storedBytesVerified`).
- **Deduplication** per project by the original's SHA-256 (`deduplicated: true`; `deduplicate: false` needs a new
  `operation_id`). Every upload records the original's and the WebP's hashes and sizes, dimensions, frames, alpha,
  orientation and the conversion mode.
- **Destinations** by the old bridge's rules: `folder` (id or path), `for_character` (name and race as in
  `create_character`; the taxonomy's asset folder names; an existing character folder reused wherever it is),
  `for_page`, `subfolders`; missing folders created in order, never moved; conflicts and ambiguities refused.
- **`prepare_image_upload`** (W) and the public **`POST /uploads/<upload_id>`**: a 256-bit, single-use, 5-minute
  capability bound to the file's hash, length and type, the project and the connection, sent in a header; streamed to a
  private temporary file; one generic refusal; rate limits per connection and per address; ready-made Python and curl
  scripts.
- **Staging**: `stage: true` uploads, verifies and hides an image in the project's staging folder (`imageStagingFolder`,
  default `LK-Bridge staging`); `staged_id` places it (move, unhide, rename, read back). **At scope `propose` uploads
  are staged** and the placement is the proposal (no bytes in it): the one, narrow change to chunk 8's rule.
- **The dashboard's Staging page**: upload (choose or drag), list with thumbnails, place, discard, old ones reported,
  allow a delete without bytes (re-authenticated). The CSP allows images from `assets.legendkeeper.com`.
- **Asset deletes keep their bytes** on every route (the CR-2026-11 open item): downloaded and stored
  content-addressed before `deleteAsset` is sent, referenced from the journal's pre-image; a folder's children listed
  and kept; refused (`ASSET_BYTES_NOT_KEPT`) unless the owner allows it; kept 90 days (`ASSET_BYTES_RETENTION_DAYS`).
- **Reading**: `list_assets` and `browse_asset_tree` show `bridgeUpload` (original format, dimensions, frames,
  `storedBytesVerified`, staged).
- **Engine**: `StepOptions.bindFrom` (an id an earlier step created, bound before sending; kept by proposals), the
  `upload_image` job kind's folders, verify and hide steps, a `bridge.verify` `asset` target, and the delete keeper hook.
- **Deploy**: the unit's memory ceiling is raised to `MemoryHigh=1400M` / `MemoryMax=1536M` (a conversion at the pixel
  limit peaks at about 0.5 GiB of native memory); twelve new optional settings (env.template, "Images"). No Caddy change.
- **Sandbox (the owner's run of 12 November 2026)**: the sandbox files run one after another (`fileParallelism:
false`); `smoke.ts`, `assumptions.ts` and the new `images.ts` wait for parked or queued writes, the clean-up's too
  (`test/sandbox/wait.ts`), checked against the mock with a write parked for budget. New: `images.test.ts`
  (`deploy/sandbox-test.sh --project test -- images`).
- Tools: 54 visible to a `write` or `propose` profile with the low-level tools hidden (was 52).

## Unreleased: v2 D1.1, two date styles, timeline repair from the table, and versions from the ETag (11 November 2026)

[ADR 0039](adr/0039-date-styles-timeline-repair-and-etag-versions.md). No migration. Nothing was run against a live
system: every test runs against the mock LegendKeeper, and the sandbox tests are written, not run. It answers the
owner's full sandbox run of 11 November 2026 (smoke passed; assumptions 27 of 28, B12 failed; chronology 243 failures,
242 of them one formatting difference and one real finding of data drift on the test world).

- **Two date styles.** LegendKeeper writes a year with no thousands separator on events (`Kumikas 1st, AA 1988119`);
  the tables write one (`AA 1,988,119`). The engine used the table style for both. `CalendarEngine.format` is now
  LegendKeeper's style only (`formatTable` and the parser's `render` with a style are the table's); `ParsedDate` carries
  `formatted` (LegendKeeper's) and `text` / `tableFormatted` (the table's); `calendar_date` returns both and reads
  either. Table writes use the table style, every comparison with an event's text LegendKeeper's. Engine tests
  re-pinned: the oracle, new fixtures for years over 1,000 in both styles (the Archon, First and Second Ages), and
  property tests that round-trip both styles (10,000 runs per calendar and style). The chronology check compares
  minutes, never text, so it never reported the 242; a regression test covers years over 1,000 in both styles. The
  sandbox chronology test now compares event text in LegendKeeper's style.
- **`sync_timeline_event` (W), the repair of timeline drift with the table as the authority.** Creates a table row's
  missing event (minutes, `detail`, `uri` to the age's table), or corrects the paired event's minutes, `detail`, shape
  and `uri`; never touches the table or the Main count, never renames an event. `nothing_to_do` for a correct event; an
  ambiguous pairing is refused with the candidates. One job (or one proposal under `propose`) holding the age's table
  and timeline, with `dryRun`, `operation_id`, the compare-and-swap inside the lock (including a new **row assertion**:
  the row must still be as planned), verify, the journal and resume. 52 → 53 bridge tools.
- **The chronology check** pairs rows and events in four passes (links; date and name; date alone; the same event with a
  different date) and reports a row and an event that disagree about the date as their own finding kind,
  **`date_mismatch`**; a wording difference alone is no finding. A linked pair that disagrees about its date is drift,
  not a pair. `CHRONOLOGY_DRIFT` now points at `sync_timeline_event`.
- **Dashboard: "Propose a fix"** on each `row_without_event` and `date_mismatch` finding: ONE `sync_timeline_event`
  proposal (`POST /chronology/propose-fix`, `BatchSubmit.forceProposal`, bridge code only), approved as normal on the
  Proposals page; audited `chronology.propose_fix`.
- **Versions from the `ETag` (B12).** The governor captures a response's `ETag` (unquoted); for a write LegendKeeper
  versions, a step keeps it beside its result, and the next chained If-Match takes the body's version, else the ETag
  (row writes and deletes, B13 and D25), so a chained row write needs no read of its own; with neither, the bridge
  still re-reads. Behind the per-project setting **`useEtagVersions`** (default on) until the owner's next sandbox run
  confirms it. Measured against the mock: `set_facts` changing two facts 4 reads (6 without), a four-write call 6
  reads (10 without); `archive_page` 4 reads fewer, `unarchive_page` 3, `promote_page` 2, `move_to_working` none.
- **Sandbox (written, not run).** **B12** now asserts, for a row create, update and delete, that the ETag equals the
  version the next `listPropertyRows` gives AND that LegendKeeper accepts it as If-Match; PASS only if both hold, and it
  says plainly which half did not and that `useEtagVersions` should be switched off. The chronology test reports
  table and timeline drift under its own heading, apart from the engine's failures.
- **For the owner after deploying:** run the sandbox again (`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh
--project test`); then "Run the check now" on the Chronology page, "Propose a fix" on each finding and approve;
  then run the check again: no findings. ChatGPT: refresh the tool list (Plugins page).

## Unreleased: v2 D1, the calendar engine, chronology sync and the timeline tools (11 November 2026)

[ADR 0038](adr/0038-calendar-engine-and-chronology-sync.md). Migration **1800** (chronology calendars, records, links
and checks; after C2d's 1750). Nothing was run against a live system: every test runs against the mock
LegendKeeper; the owner runs the read-only sandbox check on the server.

- **The calendar engine** (`src/calendar`), built from a LegendKeeper calendar definition alone: months every N years,
  leap-day rules, year 0 or none, the negative era counting down, `none` / `year` / `calendar` era resets and the
  format templates. It matches LegendKeeper on all 330 oracle events (start, end, detail, shape, formatted text, parsed
  date), round-trips 10,000 random dates per calendar in every form and era, and refuses unknown months and eras,
  impossible days, dates outside their era and reversed ranges precisely. All the owner's date forms are accepted.
- **New tools.** `calendar_date` (R; free while the calendar is cached), `create_timeline_event`,
  `update_timeline_event`, `delete_timeline_event` and `create_timeline_lane` (W). A chronology event's table row, its
  timeline event and its age's Main count change together in one job (one proposal under `propose`), with `dryRun`,
  `operation_id`, the documents' locks held in sorted order, the row's place and the new count decided inside the lock,
  block-level writes (an inline icon elsewhere on the page is untouched), verify, journal pre-images, and resume (never
  replay) after a part-way stop. 47 → 52 bridge tools (51 for a write profile with the low-level tools hidden).
- **Chronology settings** found by naming convention and confirmed by the owner on the new **Chronology** dashboard page
  (with how the tables write dates and KCY values, learned from the rows); audited `project.set_chronology`. Until
  confirmed, the timeline tools refuse.
- **The `chronology-check` maintenance job** (weekly, P3) and "Run the check now": findings only (rows without events,
  events without rows, rows out of order, wrong KCY values, count mismatches, wrong event links), never repairs.
- **Engine** (bridge code only): `BatchSubmit.holdDocuments` (several job-level document locks, sorted, with or without
  a page lock); `bridge.expect` checks of a whole document by a registered checker, of an event and of a lane;
  `bridge.verify` targets `checked` (with `inputFrom`), `event` and `lane`; `StepOptions.bindBody` (a write's body
  worked out by the check inside the lock) and `judgedInLock` (a proposal captures no version for such a write);
  `bridge.record` steps name their store (`lifecycle`, `chronology`). **A lane's delete now keeps its events in the
  journal pre-image, on every route** (the CR-2026-11 note).
- **Owner decision 6 of ADR 0036 recorded (option (a)):** timeline events, lanes, map features and board shapes on an
  Authoritative page are ordinary edits, not canon; only deleting a whole map, timeline or board document of one is.
- **Sandbox.** `test/sandbox/chronology.test.ts` (read-only): every row, event and age of the real chronology against
  the engine. `deploy/sandbox-test.sh --project test -- chronology` runs only the chronology check (anything after
  `--` is passed to vitest as a filter), so nothing that writes runs with it.
- **For agents:** see the bridge guide's new "Dates and the chronology". ChatGPT: refresh the tool list (Plugins page).

## Unreleased: C2d, whole-set lifecycle, the owner's CR decisions, and the sandbox run's findings (11 November 2026)

Session C2d ([ADR 0037](adr/0037-whole-set-lifecycle-and-page-scoped-ids.md);
[ADR 0036](adr/0036-cr-2026-11-owner-decisions.md) decisions 1 to 5 and 7 accepted). **Migration 1750** (deploy
normally; it adds the set record table, links page records to it, and adds the status-tags canon rule to projects that
store their own rules). Refresh both assistants' tool lists after deploying (ChatGPT: Plugins, the bridge, Refresh).
Nothing was run against a live system; every test runs against the mock.

- **Whole sets (owner, 11 November).** `archive_page`, `unarchive_page`, `move_to_working` and `promote_page` take
  `subtree: true`: a page and every page beneath it (a character's index, Core and specialist pages) change together as
  ONE canonical proposal listing every page's plan and a set summary. The set stays together (its root moves as a
  group, alphabetically; nothing beneath it moves); content pages get the single-page treatment by their own previous
  state; an index keeps `[INDEX]`, gets no Status, changes its status tag and gets a short note on archiving (a new
  lifecycle setting, "Note on an index archived with its set": **the default wording is a proposal for the owner to
  confirm**). At most 100 pages; a mixed, inconsistent or unclassified set is refused, listing pages; the dry run shows
  the page count and the estimated reads and writes. One job holds every page's lock; a part-way stop leaves an
  incomplete set record and calling the same tool again resumes. Related pages are listed for every page, without the
  set's own links. The dashboard shows a set proposal page by page, and the Archive and lifecycle page marks each page's
  record with its set.
- **An approval covers only the pages it listed** (decision 5). A cascade delete's pages, a template copy's children
  and a whole set are listed when the proposal is captured and again at approval and inside the lock: a page added,
  gone or moved since makes the proposal `conflicted`, nothing written, whatever tool made it. A cascade over 500 pages
  is refused at capture.
- **The status tags are guarded** (decision 7, a per-project canon rule `status-tags`, on by default). `CANON`,
  `Working` and `Archived` (any case; look-alikes caught) change only through the lifecycle tools and creates by their
  status; `update_resource`, `updateResource` on every route and create bodies that add one are refused, naming the
  tool. **Behaviour change:** an agent can no longer remove `CANON` from a page with `update_resource`, and
  `lk_api_write createResource` with a `CANON` tag is refused (the same create without the tag is still a canonical
  proposal, decision 1). Other tags are free.
- **Signing in again for the canon rules and the lifecycle settings** (decision 4): saving either needs the dashboard's
  re-authentication within the last 5 minutes, as keys do; the dashboard asks for it.
- **Ids below a page are keyed by the page** (the sandbox run's A1: LegendKeeper reuses a template's property, row and
  item ids in every copy). `factsVersion` is now `fv2_…` and unique to its page (a version read before the upgrade is a
  conflict once: read the page again); the copy check's id map and the check's versions are kept per page; the journal's
  `targetId` matches a row, property or block id only with its `resourceId`; the dashboard and proposal summaries name a
  row with its page. The test mocks now reuse ids too.
- **Row values are planned as LegendKeeper stores them** (the sandbox run's B16): every leading and trailing line break
  is trimmed before planning (`set_facts` plain and Markdown values, identity facts, a new page's Status, lifecycle
  facts) and in every comparison, so a value sent with a trailing new line verifies true and causes no later conflict; a
  value of only line breaks clears the row.
- **The sandbox harness (the owner's first server run).** `npm run test:sandbox` loads its config with
  `--configLoader runner` and the sandbox config switches off Vitest's file caches, so it runs as `lkbridge` without
  writing to `node_modules` (no workaround needed); a CI test runs it under Node's permission model with every write
  outside a temporary directory refused. The sandbox runtimes keep no secrets, so the four `SECRETS_MASTER_KEY` warnings
  are gone (the key still never enters the environment). The assumptions check: A1 reports reused ids as a note, B12
  makes its own create and update, B16 expects the trimmed form (and says if only one break is trimmed), and the
  clean-up counts a 404 or "already deleted" page as cleaned. The soak, spike and round-trip scripts use no TypeScript
  config (tsx caches in the system's temporary directory), so they needed no change.
- Tests: about 100 new, among them two copies of one template written at once, trailing breaks, re-authentication,
  decision 5 on a cascade and on a set (at approval and inside the lock), the status tags through every route, and for
  each set operation a 4-page character set with a nested index, the layout, the index treatment, each page's variant,
  the refusals, related pages, and a fault after every write followed by a resume (52 fault-and-resume cycles).

## Unreleased: CR-2026-11, the mid-point review of the write layer (11 November 2026)

An independent review of C1, C2a, C2b, C2c, the connections and bulk-canon hotfixes and the engine beneath them, before
phase D builds on them ([docs/reviews/CR-2026-11.md](reviews/CR-2026-11.md); owner decisions in
[ADR 0036](adr/0036-cr-2026-11-owner-decisions.md), proposed). 18 findings (8 critical, 6 high, 3 medium, 1 low), all
fixed, each with a test that fails on the old code. No migration; deploy normally. Nothing was run against a live
system.

- **The canon and lifecycle guards close every side route the review found.** A caller's `If-Match` no longer skips
  the check inside the lock; an `onError: "continue"` batch is judged on the page as it is as well as on its
  simulation; cascade deletes list and read their pages live, at entry and again in the lock; a template copied with
  its children is judged page by page; a page mention in Status is a protected change (refused by the lifecycle guard);
  look-alike keys, values and prefixes (fullwidth, zero-width, soft hyphen, Cyrillic, `[barc]`, a missing space) are
  read as what they look like; moves are judged from the page's parent as LegendKeeper holds it; a template copy without
  a name or id is fully judged; `[INDEX] Working` and `[INDEX] Archived` cannot be renamed, moved, deleted or imitated
  through the bridge. (CR-08 to CR-15, CR-17.)
- **Behaviour change for agents:** a page created or renamed `[BSRC] …` through `lk_api_write`, `lk_api_batch` or
  `lk_op_*` is now a canonical proposal at every scope, as an Authoritative create through `create_resource` already
  was (CR-16; ADR 0036 asks the owner to confirm). A Status written as a page mention is refused: write it as plain
  text. `bridge_job_cancel` refuses a job the owner approved (`OWNER_APPROVED_JOB`, CR-19).
- **Data.** `deleteProperty`, `updateProperty` (with `children`) and their infobox equivalents are guarded against
  dropping `unsupported` content, as page and block writes are (CR-02); `deleteProperty`, `deleteEvent`,
  `deleteFeature`, `deleteLane` and `deleteAsset` keep a pre-image in the journal, since LegendKeeper cannot restore
  them (CR-01; a lane's events and an asset's bytes stay open for D1, D3 and E1). How to restore from each kind of
  journal entry is in the review, section 4.
- **The engine.** A job that holds its page's lock checks the page again when it takes the lock back after a hold,
  budget wait, pause or restart, if nothing was sent yet, so an edit made meanwhile is never overwritten (CR-06); the
  scheduler walks the whole queue, so held writes never hide a job that can run (CR-04).
- **Answers.** A write whose outcome is unknown is reported as `OUTCOME_UNKNOWN` with `uncertain`, never as "not
  written" (CR-07); a lifecycle, set_facts or resource proposal stopped by its own check after approval, with nothing
  written, ends `conflicted`, not `failed` (CR-05).
- **Cost.** Every lifecycle job reads 4 times less (`archive_page` and `unarchive_page` 19 → 15, `move_to_working` and
  `promote_page` 15 → 11): the guards use the approval's re-read, and the tree re-reads the page once (CR-03). A
  cascade delete of N pages now reads about 4N times (the price of CR-09).
- **Sandbox (opt-in, for the owner):** `test/sandbox/assumptions.ts` checks on the real API the 28 assumptions the
  write layer had only checked against the mock (`npm run test:sandbox -- assumptions`; what it creates, cleans up and
  costs is in [test/sandbox/README.md](../test/sandbox/README.md)); its dry run against the mock is
  `test/tools/assumptions-dryrun.test.ts`.
- Docs: [policy.md](policy.md) (both guards), [tools.md](tools.md) (costs, `bridge_job_cancel`, `OUTCOME_UNKNOWN`),
  [bridge-guide.md](bridge-guide.md) (the two new codes), ADR 0035 (costs and an amendment), [PLAN-v2](PLAN-v2.md) (CR's
  results).
- Tests: `test/lifecycle/cr-*.test.ts`, `test/facts/cr-*.test.ts`, `test/jobs/cr-held-backlog.test.ts`,
  `test/admin/cr-proposal-routes.test.ts`, `test/tools/assumptions-dryrun.test.ts`; `test/lifecycle/costs.test.ts`
  updated.

## Unreleased: bulk "Accept selected as canon" (11 November 2026)

The owner asked for a bulk version of "Approve and accept as canon" ([ADR 0032](adr/0032-set-facts-and-canon.md), the
note on bulk; [policy.md](policy.md#protected-canonical-facts-v2-c2a); [dashboard.md](dashboard.md#proposals-the-bulk-actions-11-november-2026)).
All four lifecycle tools, Authoritative creates and the two delete rules always produce canonical proposals, which had to
be accepted one at a time. No migration; deploy normally. Rebuild the UI (`npm run build`) as usual.

- **`POST /api/admin/proposals/bulk` takes `action: "approve-as-canon"`**, with `confirm: true` (without it: `400`), at
  most 100 ids, owner only (session, CSRF and same-site checks as on every admin route). It is `approveAsCanon` for each
  id, one at a time and in order, exactly like the bulk Approve: each approval re-reads its targets, an earlier one may
  change a later one's, and a target changed after capture ends _conflicted_, not executed. Each accepted proposal has
  its own `proposal.approve_as_canon` audit row with `canonicalApprovedBy` and `bulk: true`.
- **The two kinds of approval stay distinct.** An ordinary proposal in the canon action is refused ("ordinary proposal;
  use Approve", `NOT_CANONICAL`) and left pending. A canonical proposal in the ordinary bulk Approve is still refused and
  now reported as `skipped: true` rather than as a failure.
- **The bulk bar on the Proposals page**: "Approve selected (N)" counts only ordinary proposals and says when it skipped
  canonical ones; "Accept selected as canon (M)" appears when the selection holds canonical proposals and opens a
  confirmation listing each (page-level summary line, canonical reasons, related-pages count for lifecycle proposals)
  with an "I accept these M changes as canon" box that must be ticked before the button enables. It sends the ids it
  showed, so nothing ticked afterwards is accepted, and a proposal decided elsewhere meanwhile is left out. Results
  appear per proposal: done, conflicted, skipped, or refused with the reason. The confirmation dialog gained an optional
  acknowledgement box for this.
- **Bulk reject on canonical proposals** works (rejecting needs no canon decision); now covered by a test.
- Tests: `test/lifecycle/bulk-canon.test.ts` (three canonical kinds in one bulk, one conflicted after capture, ordinary ids
  refused, plain bulk approve skipping canonical ones, bulk reject, owner only), the route's input checks in
  `test/admin/actions.test.ts`, and the confirmation in `test/ui/canon.test.tsx`.
- **Plan** ([PLAN-v2](PLAN-v2.md)): owner decisions of 11 November recorded: subtree archiving is wanted (new session
  C2d, "Subtree lifecycle", after CR, Opus 5.5 · high, can run alongside D1); related pages stay listed only by
  `archive_page` and `move_to_working`; no legacy lifecycle-inconsistent pages exist on Arkona, so no "adopt" tool is
  needed.

## Unreleased: v2 C2c, the page lifecycle (10 November 2026)

The page lifecycle as the owner decided it on 10 November 2026: Authoritative (`[BSRC]`), Working (`[BWRK]`) and
Archived (`[BARC]`) pages, four tools to move a page between them, a guard that refuses every other route, and the
related pages of a page leaving canon ([ADR 0035](adr/0035-page-lifecycle.md); the tools in
[tools.md](tools.md#the-page-lifecycle-v2-c2c); the guard and rules in [policy.md](policy.md); the agent guide's "The
page lifecycle" in [bridge-guide.md](bridge-guide.md); the link sweep in [maintenance.md](maintenance.md)). Migration 1600. Deploy normally; `--update-self` is not needed. Then, **before anything else, confirm each project's two indexes**
on the dashboard (Projects page, Lifecycle: **Confirm these indexes**): until then the lifecycle tools and Working
creates refuse. ChatGPT: refresh the bridge's tools (Plugins, the bridge, Refresh); claude.ai: disconnect and
reconnect the connector to see the new tools.

- **Behaviour change: new pages are Working by default.** `create_resource`, `create_bare_resource`,
  `create_many_resources` (per item) and `create_character` take `status: "working" | "authoritative"`, default
  `working`. A page created without a status is now `[BWRK] {name}` directly under `[INDEX] Working` (alphabetical),
  with Status `Working` and the `Working` tag, where C2b made a `[BSRC]` page under the given parent. `authoritative`
  makes the `[BSRC]` page in its normal place with Status `Authoritative` and the `CANON` tag, always as a canonical
  proposal. Working characters: a Core under its own `[INDEX] {name}` under Working, a compact page directly under
  Working; the race is still validated. `create_index` takes no status, gives an index no Status any more (C2b gave it
  `Working`), and is refused under the lifecycle indexes. The canon section's `agentDefaultStatus` ("Status of pages
  agents create") is superseded by the lifecycle settings and gone from the dashboard (the API still accepts it).
- **Four tools** (`access: write`, always the owner's canonical approval at every scope): `archive_page` (to
  `[INDEX] Archived` as `[BARC]`, with a dated note at the top of the page, Status `Archived`, Continuity Type
  `NON-CURRENT`, the Scope and Temporal Scope texts, Last Major Revision, `Archived` tag), `unarchive_page` (back from
  the lifecycle record: place, prefix, facts, tag; the note removed only if unchanged), `move_to_working` (an
  Authoritative page back to Working; its place remembered) and `promote_page` (a Working page to Authoritative under a
  destination, the remembered place suggested; a Working character's index goes with its Core). The proposal shows the
  whole plan; `dryRun` shows it without proposing; every check runs again at execution; a change that stopped part-way
  is resumed by calling the same tool again (only what is left, never replayed).
- **New kinds everywhere:** `bwrk` and `barc` in the tree, `browse_repository_tree`, `search` (`kind:bwrk`,
  `kind:barc`), `get_resource` and the dashboard's tree; names handled like `[BSRC]`; a name matching several pages of
  one subject prefers `[BSRC]` (or an index), then `[BWRK]`, then `[BARC]`. A tree built before re-derives its kinds
  from the stored names once, without a walk.
- **The lifecycle guard** (in the engine, every write path): Status changes to or from Working or Archived (and Working
  to Authoritative), renames that add, remove or change `[BWRK]` / `[BARC]`, and moves into, out of or between the
  lifecycle indexes are refused (`POLICY_DENIED`), naming the tool to use, through `set_facts`, the resource tools,
  `lk_api_write`, `lk_api_batch`, `lk_op_*` and approved proposals alike. Only the four tools' own steps pass, through a
  marker an agent's request can never carry.
- **Two recommended canon rules, switchable:** deleting an Archived `[BARC]` page, and deleting a map, timeline or board
  of an Authoritative page, need canonical approval (`delete-archived`, `delete-document-authoritative`; on by default,
  added by migration 1600 to projects that store their own rules). Every canon rule now has `enabled` and a **Switch
  off / Switch on** button on the dashboard.
- **Lifecycle settings per project** (dashboard, Projects page, Lifecycle; audited as `project.set_lifecycle`): the two
  indexes found by name and confirmed by the owner, the Status values, tags, fact names, Continuity Types and archive
  texts.
- **The lifecycle record** (`lifecycle_records`, never pruned): every lifecycle change with its page, action, date,
  principal, approver, jobs, state (complete or incomplete) and everything needed to reverse it (the previous state,
  parent, rank, name, prefix, the five facts, the tags, the note's block id and exact content). The dashboard's new
  **Archive and lifecycle** page lists it, each change linked to the journal.
- **Related pages** of a page being archived or moved to Working: the pages that link to it or mention it, from a new
  **link index** kept up to date from the bridge's own writes and refreshed by a new maintenance job, `link-sweep`
  (daily at 01:15, P3, gives way to agents, resumable; about one read per page plus one per page document), with "link
  index as of …"; plus one LegendKeeper content search, its hits marked "found by text search (may be incomplete)".
  Related pages are reported, never edited.
- **Dashboard:** a **Lifecycle change** panel on lifecycle proposals (the move and name, facts before and after, tags,
  the note as a Markdown diff, flags, related pages); the Archive and lifecycle page; the Lifecycle section of the
  Projects page; the Journal page takes `?jobId=`.
- 47 bridge tools (136 with `MCP_EXPOSE_PER_OP_TOOLS=true`), 14 maintenance jobs.

## Unreleased: v2 C2b, resources, documents and characters (10 November 2026)

The resource, document and character tools, request coordination, a base version for facts, and mention targets for
characters ([ADR 0034](adr/0034-resources-documents-characters.md); the tools in
[tools.md](tools.md#resources-documents-and-characters-v2-c2b); the rule in [policy.md](policy.md); the agent guide's
"Creating and changing pages" in [bridge-guide.md](bridge-guide.md)). Migration 1500. Deploy normally; `--update-self`
is not needed. ChatGPT: refresh the bridge's tools (Plugins, the bridge, Refresh); claude.ai: disconnect and reconnect
the connector to see the new tools.

- **Twelve tools** (`access: write`): `create_index`, `create_resource`, `create_bare_resource`,
  `create_many_resources` (up to 100, nested with `key` / `parent_key`), `create_character` (core or compact, by the old
  bridge's rules), `update_resource` (a rename keeps the prefix and re-places the page), `move_resource`,
  `delete_resource` (`confirm`, and `cascade` for children; lists every page removed), `restore_resource`,
  `create_document`, `update_document` (settings only), `delete_document` (never the last or only page document).
- **One shape for all of them:** inside the AI REPOSITORY only; ONE job, or ONE proposal under `propose` (ids minted at
  capture and kept at approval; the page-level summary first, `New page [BSRC] X - Character Core under [INDEX] X: 6
facts`); every guard again at execution; `dryRun` everywhere; each new or moved page in its alphabetical place in the
  same write; nothing else moved or reclassified; Status `Working` on pages made from a template with a Status row; the
  template recorded in the tree at once; every write verified (pages by their parent's listing, facts by a read).
- **`create_character`:** reuses an existing `[INDEX] {name}` or makes it; `{name} - Character Core` beneath it, or
  `{name} - Character Reference` under the race; an existing page is returned, not duplicated; Reference Type, Subject,
  Canonical Display Name, Race / Species (exactly as given, `Unestablished` for an unknown race) and Status written in the
  same job; an unknown race goes to Undetermined / Unknown, a declared one that does not resolve fails; nothing is
  ever invented.
- **`operation_id`** on every create (kept per project and connection with a hash of the normalised request): a repeat
  returns the earlier result (the job or its outcome, or the proposal), a different request with the same id is
  `OPERATION_ID_REUSED`. **Duplicate characters:** a second overlapping request for one character, from any connection,
  is `DUPLICATE_REQUEST` naming the first's job or proposal.
- **Failed work is never replayed:** `WRITTEN_IN_PART` lists what was written, what was not, and the journal entries.
- **Canon:** deleting a page whose Status is Authoritative (or a cascade holding one) needs canonical approval: a new
  canon rule kind, `delete`, seeded by default and added once by migration 1500 to projects that store their own rules
  (Projects page, Canon: "deleting a page with these values"). Restoring needs none. A create that sets Status
  Authoritative becomes a canonical proposal (the guard judges a new page's facts on its template's copy).
- **`factsVersion`:** the bridge's own version of a page's sidebar facts (rows by rank and id, link collections), on
  `get_resource`, `get_resources`, `set_facts` (before and after) and the creates. **`set_facts` `baseFactsVersion`:**
  any change to the sidebar since is `VERSION_CONFLICT` with what changed, nothing written, checked at planning and
  inside the lock (not kept in a proposal: its captured state protects it).
- **Mentions of a character:** `[[Name]]` matching several pages of one character goes to its Character Core, else its
  Reference, else its index, and `write_page` and `set_facts` say which (`mentions`). Different subjects stay ambiguous;
  a write target is never chosen this way (an ambiguous `page` lists each candidate's role).
- **Engine** (bridge code only): `bindIds`; `bridge.expect` checks `copy` and `sidebar` (`directOnly`); `bridge.verify`
  targets `facts`, `gone`, `document` and a `resource` `placement`; proposal capture leaves out direct-only checks and
  pages an earlier operation creates. **Tree:** `setTemplate`, a `tombstone` query, one deferred re-read per page.
  **Registry:** `characterRole`, `preferredMention`; the character page names default to `{name} - Character Core`
  and `{name} - Character Reference`.
- **Flagged for the owner:** deleting a map, timeline or board of an Authoritative page is not guarded (the result
  notes it).
- Tests: `test/resources/` (each tool, placement and ranks, names and prefixes, Status, template ids, verify, dry runs,
  proposals with minted ids, 100 nested pages and the 101st refused, a bad parent_key refused before anything is sent,
  every character case, operation_id, duplicates from two connections, canon on create, delete and restore, factsVersion
  across endpoints and in the lock, mentions, documents, measured costs, and unit tests of the planner and stores).

## Unreleased: hotfix, sidebar rows compared in rank order by id (10 November 2026)

`set_facts` on Asagiri Miyabi - Biography failed with `VERSION_CONFLICT` every time (fresh read or not, one fact or
two, nothing else editing the page), naming a row partway down the sidebar ("Scope", later "Last Major Revision").
LegendKeeper returns a key-value property's rows in **different orders from different endpoints**: `listProperties`,
`getProperty` and `getResource` in stored order, `listPropertyRows` sorted by `rank`. The plan read the first, the check
inside the lock the second, and compared them **position by position**; on any page where a row was ever inserted
between two others, every position after the first out-of-order row "changed", permanently. The mock LegendKeeper
returned one order everywhere, so the tests never saw it ([ADR 0032](adr/0032-set-facts-and-canon.md), Consequences).

- **One row order everywhere** (`src/lk/row-order.ts`): by `rank` as a plain string in code-unit order (what `<` does,
  never `localeCompare`; `a` < `aR` < `af`), ties by id. A planned new row (no id, no rank) keeps its place next to the
  row it is anchored to.
- **Rows are compared by id** (`compareRows`): a row on one side only is added or removed; a changed rank is a reorder
  and still conflicts; a planned new row is matched by key and must stand where the plan put it; rows with no id fall
  back to position. Differences name the row: `PROPERTIES “Scope” (row id).value`.
- **Every reader of sidebar rows uses it**: the planner's sidebar model (`rowsFrom`, so the plan, the template's key
  order and the canonical guard see rank order), the check inside the lock (`bridge.expect`, `listPropertyRows`), the
  verify step (`bridge.verify`, `getResource`), the in-lock expectation hash of row writes (`rowsContentHash`,
  `expectCurrent: { state: 'rows' }`), the proposal capture's fingerprint of `getProperty`, `getResource` and
  `listProperties` targets (low-level and ChatGPT proposals), the facts table and before/after rows on set_facts
  results and proposals, `get_resource`'s facts, `read_document`'s sidebar and the repository tree's sidebar summary.
  Expectations now keep each row's `rank` (optional, so older stored ones still parse and match by id).
- **Placement**: a new template fact is anchored as before (`after` / `before` a row that stays); LegendKeeper ranks it
  between the anchor and the anchor's **rank-sorted** neighbour, and the plan now expects it exactly there, so on
  Rheashira Aela's page a fact after Subject (`a`) lands before Life State (`aR`), not before Canonical Display Name
  (`b`). The verify step reports a row ranked anywhere else (`(order)`).
- **The mock behaves like LegendKeeper**: `listPropertyRows` rank-sorted; `listProperties`, `getProperty` and
  `getResource` in stored order; `createPropertyRow` ranks between rank-sorted neighbours and appends to the stored
  order, without renumbering other rows. A fixture seeds Rheashira Aela's real order and ranks.
- **Tests**: set_facts on that fixture (one changed fact, two, a new template fact and a non-template fact, Mood as a
  dry run then for real), real conflicts still caught (an outside value edit naming the row, a reorder, an added and a
  deleted row), the verify step catching a misplaced row, `lk_api_write`, proposals approved with and without an outside
  change, the canonical guard (Status still canonical, Scope not), and unit tests of the order, the comparison and the
  ranks. They fail on the previous code.
- **Upgrading**: a set_facts proposal captured before this release on a page whose two orders differ was already
  doomed to conflict; reject it and propose again. A pending low-level proposal of `updateProperty` or `deleteProperty`
  on such a page may show as conflicted at approval (its fingerprint is now taken in rank order); propose it again.

## Unreleased: v2 C2a, set_facts, protected canon and the multi-page groundwork (10 November 2026)

Sidebar facts and relationship links, the protected canonical facts rule on every write path, and the proposal and job
groundwork C2b's multi-page tools build on ([ADR 0032](adr/0032-set-facts-and-canon.md); the tool in
[tools.md](tools.md#facts-and-links-set_facts-v2-c2a); the rule in [policy.md](policy.md#protected-canonical-facts-v2-c2a);
the agent guide's "Editing facts and links" and "Canon and approval" in [bridge-guide.md](bridge-guide.md)). Migration 1300.

- **`set_facts`** (`access: write`, `destructiveHint: true`): `facts` (key → plain text, `{ "markdown": "…" }` inline
  Markdown with `[[mentions]]` resolved through A3, or `null` to remove), `links` (collection title → `{ add, remove }`
  of pages or `{ page, document }`), `property` (default the project's `factsPropertyName`, `PROPERTIES`), `dryRun`.
  Existing rows keep their key, id and place; new template facts go in template order (the tree's recorded template, or
  the Reference Type mapped through the type registry; keys cached a day), others at the bottom (with a note when no
  template can be determined). Collections keep every item's id, rank and order and their filter; adds are appended,
  "already linked" reported; one `updateProperty` with the full items list per collection. Typed refusals throughout;
  an empty plan writes nothing.
- **One job under the page's lock**: the bridge's own check of every property it changes (`bridge.expect`, inside the
  lock: any difference is a conflict and nothing is written), the row writes chaining each new version into the next
  If-Match (a write with nothing to chain from, or an unversioned `updateProperty`, compares what it reads in the lock
  with the plan first), then the generic verify step (`bridge.verify`): "written but not as planned" is recorded on the
  job, the errors table and the proposal, never retried. The journal keeps every write with the high-level operation,
  and the key-value property's pre-image on the first; the tree re-reads the page once per job.
- **Protected canonical facts** (PLAN-v2 10.3 as refined): per-project rules (Projects page, _Canon_; audited
  `project.set_canonical_rules`), seeded with `Status` = `Authoritative` (both directions), and changing an existing
  `Continuity Type` or `Continuity` (setting them where empty is allowed); the default status for pages agents create
  is `Working` (`agentDefaultStatus`, for C2b). Enforced by a write guard in the engine on EVERY path: at entry (a
  request's sidebar writes simulated in order: set_facts, `lk_api_write`, `lk_api_batch`, every `lk_op_*` property and
  property-row operation, `createResourceFromTemplate`, C2b's tools), again when an approved proposal's batch is
  submitted (a protected change without canonical approval is refused, nothing written), and inside the lock before each
  sidebar write. A protected change becomes a proposal flagged `requiresCanonicalApproval` whatever the scope, with the
  reason in the agent's result; a `read` connection is refused as before. `assessFactChange` is the shared function.
- **"Approve and accept as canon"**: the only approval of such a proposal (dashboard banner listing the protected
  changes; `POST /api/admin/proposals/:id/approve-as-canon` with `{ confirm: true }`; audited
  `proposal.approve_as_canon`; records `canonicalApprovedBy`). The ordinary Approve and bulk approval refuse it
  (`CANONICAL_APPROVAL_REQUIRED`); Reject works as normal.
- **Proposal groundwork** (PLAN-v2 10.2): a list of high-level operations per proposal; client ids minted at capture
  and used exactly at approval; a page-level summary of every proposal, shown first on the dashboard
  (`Asagiri Miyabi: sidebar, 3 facts changed, 1 link added`); set_facts proposals show a before/after facts table and
  the links added and removed; `bridge_proposal_status` shows the pages and `requiresCanonicalApproval`.
- **Engine** (bridge code only, src/jobs/README.md): `BatchSubmit.holdLock` (a job-level lock), `internal` (the bridge's
  own steps `bridge.expect` and `bridge.verify`), `proposal` (extras for a batch); step options `ifMatchFrom`,
  `expectCurrent`, `deferTreeReread`, `journalPreImage`; `engine.setWriteGuard`; `StateConflictError`,
  `CanonicalApprovalRequiredError`; generic verification gathered on the job from every verify step; observers'
  `flushDeferred`.
- Settings: `factsPropertyName`, `canonicalRules`, `agentDefaultStatus` (project settings).
- Tests: `test/facts/` (every fact and link case, template order at first, middle and last positions, unknown template,
  inline Markdown and mention errors, empty plan, dry run; the check in the lock, chained versions, the fallback after a
  removal, verify matching and mangled; the journal and the tree; protected canon through set_facts, `lk_api_write`,
  `lk_api_batch` and the per-op tools at write and propose scope, ordinary Approve refused, accept as canon, the
  re-check refusing a forged expansion, the backstop in the lock; ids minted at capture, the page-level summary, generic
  verification recording a difference; two projects isolated, the admin routes), `test/ui/canon.test.tsx`, and the
  Playwright smoke test's canonical approval.

## Unreleased: hotfix, removing connections, replace on reconnect, operation discovery (10 November 2026)

Found by the owner while testing C1 and B2 ([ADR 0033](adr/0033-removing-connections-replace-on-reconnect-and-operation-discovery.md);
the owner-facing rules in [policy.md](policy.md)). Migration 1400. Deploy normally; `--update-self` is not needed.

- **Removing connections.** A revoked or expired connection (grant or PAT) can be removed from Clients & Access:
  one transaction deletes its credentials (a grant's token family with every refresh token, access token and code; a
  PAT's row; `auth_clients` untouched), writes a **tombstone** (`removed_connections`) and the audit row
  `connection.remove` (`before`: the tombstone fields, `after`: `null`). An active connection is refused
  (`409 CONNECTION_ACTIVE`). Single Remove needs no confirmation; "Remove all revoked and expired (N)" (only when N > 0)
  lists the rows first. API: `POST /api/admin/clients/connections/:id/remove`, `POST .../remove-inactive` (returns the
  count), `PUT /api/admin/clients/settings/auto-remove-days`.
- **History still names them.** The journal, proposals, jobs and errors pages and `bridge_journal_lookup` (new `principal`
  field) name a removed connection from its tombstone, for example "ChatGPT (removed 10 Nov 2026)"; never a bare id.
- **Automatic removal.** `connections.auto_remove_days` (default 30, `0` = never; the count starts at `revoked_at`, or at
  `expires_at` for a connection that expired unrevoked); new maintenance job `connection-removal`, daily at 04:00 London,
  audited as `connection.remove` by the system. The auth prune no longer deletes grants silently.
- **Stale.** `connections.stale_after_days` (default 14, `0` = never): a "stale" badge, and "Revoke stale (N)" per
  profile with a confirmation (`PUT .../settings/stale-after-days`, `POST .../connections/revoke-stale`).
- **Replace on reconnect.** The consent page lists the same application's active connections (same `client_id` for a CIMD
  client, else the same verified redirect origin; the name never decides), ticked by default. Nothing is revoked at
  approval: the ticked ids ride on the authorisation code (`auth_codes.replaces`) and are revoked only when the code is
  exchanged successfully (re-checked: still active, still the same application; `replaced by <new grant>`; audited
  `connection.revoke`, `via: 'replaced'`). The access token is now signed before anything is stored.
- **Consent page clarity.** The new-profile label and kind show only when "New profile…" is selected (CSS `:has()`, no
  script; visible under "Only for New profile…" without `:has()`). A first scope radio, "Keep the chosen profile's
  current scope" (`keep`), is preselected whichever profile is chosen: the profile's current scope, or the default for a
  new one, never a scope-change confirmation. An explicit read, propose or write still asks (F-15). CSRF unchanged.
- **Dates.** `fmtTime` adds the year when it is not the current one ("3 Nov 2027, 02:12:35"). The revoked "Claude Code
  (PC)" PAT's expiry is 3 Nov 2027 (8 Nov 2026 + 360 days, checked against `auth_pats.expires_at`). The consent page's
  connection list always shows the year.
- **Operation discovery without the low-level tools.** `UNKNOWN_OPERATION` (in `lk_api_read`, `lk_api_write`,
  `lk_api_describe_operation`, `lk_api_paginate_all` and now `lk_api_batch`, which refuses the batch up front naming the
  call) suggests up to 5 close ids (edit distance plus append/add/create → insert, edit/set → update, remove → delete,
  fetch → get/list: `appendDocumentBlocks` → `insertBlock`, …) and names the low-level tools only when the profile shows
  them. `get_bridge_guide` (and the MCP resource) ends with an **Operations** section generated from the registry: every
  operation, grouped by tag, with kind and risk.
- **Tool-list caching** is documented (Clients & Access, `policy.md`, the bridge guide): claude.ai keeps its own copy of a
  connector's tool list, so a visibility change shows only after disconnecting and reconnecting the connector (observed on
  10 November 2026, not a guarantee); ChatGPT: Plugins, the bridge, Refresh.
- **Conflicted proposals can be rejected** (addendum). `reject` accepts `pending` or `conflicted` as one compare-and-set; the
  audit row's `before` records the real state; any other state: "Proposal … is X; only pending or conflicted proposals can
  be rejected"; `bulkReject` follows. A rejected conflicted proposal keeps its `conflict` details, gets the reason,
  `decided_by: 'owner'` and `finished_at`, moves to History, is prunable after the retention, and the proposer sees
  `rejected` with the reason. They were stuck for good before.
- Tests: `test/admin/connections.test.ts`, `test/policy/replace.test.ts`, `test/policy/mcp.test.ts` (consent),
  `test/tools/discovery.test.ts`, `test/ui/units.test.ts`, `test/ui/access.test.tsx`, `test/policy/proposals.test.ts`,
  `test/pages/proposals.test.ts`, `test/maintenance/jobs.test.ts`.

## Unreleased: v2 C1, write_page (10 November 2026)

The main way agents change the owner's pages ([ADR 0031](adr/0031-write-page.md); the tool in
[tools.md](tools.md#writing-pages-write_page-v2-c1); the agent guide's "Writing pages" in [bridge-guide.md](bridge-guide.md)).
Migration 1200.

- **`write_page`** (`access: write`, `destructiveHint: true`): `append`, `prepend`, `replace`, `replace_section`,
  `append_to_section` on a page document of the AI REPOSITORY, in Markdown, through B1's converter and A3's name
  resolution. Every converter refusal is a typed error with its details; an empty plan writes nothing; `dryRun` returns
  the plan and the Markdown diff; `detail: "full"` adds the diff. Maps, timelines and boards are refused with a pointer
  to their tools. There is no `allowUnsupportedLoss`: `unsupported` blocks are always kept.
- **Versions.** `baseVersion` (strongly recommended): an older version refuses a whole-page edit, and lets a section
  edit through only when that section is unchanged since then (the bridge remembers recent page versions it read:
  `document_versions`, filled by `read_document` and `write_page`). Never a silent merge: a conflict gives the current
  version and the section's current Markdown.
- **The bridge's own compare-and-swap.** One job, under the document lock: the version is read again inside the lock;
  a section edit whose section is unchanged is re-planned there (new: step planners, `engine.registerPlanner`),
  anything else is a conflict and nothing is sent. Then ONE `replaceDocumentBlocks` with `If-Match`, every unsupported
  block echoed.
- **Verify.** The page is read back inside the lock and compared with what was sent (ids included; the fields
  LegendKeeper may change are listed). A difference is recorded on the job, in the errors table (`VERIFY_MISMATCH`) and
  in the result ("written but not as planned"), with the journal entry for recovery; never retried.
- **Journal**: entries carry the high-level `operation` (mode, section, a SHA-256 of the Markdown, the version planned
  on, a re-plan in the lock); `bridge_journal_lookup` and the Journal page show it.
- **Proposals** (scope `propose`) hold the high-level operation and its expansion; the dashboard's proposal page shows
  the page's Markdown diff (keep regions as labelled placeholders) beside the block diff, and after approval whether
  the write was verified. Approval executes the stored expansion through the same lock, compare-and-swap and verify;
  a version change since capture, or between the approval's re-read and the write, ends `conflicted` (new transition
  `executing → conflicted` for page writes). `bridge_proposal_status` shows the operation briefly.
- **`PAGE_NOT_WRITABLE`**: a page that already holds content LegendKeeper's write schema has no form for (B1's model of
  an inline icon) cannot be written by a whole-document replace; refused at planning, naming the blocks. To verify on
  the test world.
- **`npm run roundtrip -- --list-keep <kind>`** lists every keep region of a kind (`paragraph`, …, or `all`) with its
  page, document, block id and the characters that made it read-only as escapes (`\n`, `\u0007`). Read-only. Rendering
  a newline in a text run as `<br>` was checked and does not round-trip (ADR 0031); not proposed.
- Engine: step options `verifyAfterWrite`, `journalOperation`, `replan` (bridge code only), `RunOptions.proposal`
  (`ProposalExtras`), `compareStoredBlocks`, `WriteJournal.entryIdForStep` (src/jobs/README.md).
- Tests: `test/pages/` (planning, every mode and refusal, sections at every level, the version rules, the
  compare-and-swap, verify, unsupported blocks, the journal, B1's real-page fixtures including the 335-row Fourth Age
  table, twins, proposals, concurrency, two projects, all through the real server and the official MCP client), the
  round-trip `--list-keep` dry run, a dashboard component test and a Playwright check of the Markdown diff. Tool counts:
  32 tools (29 shown to a profile without low-level tools).
- **For the owner:** ChatGPT keeps its own copy of the tool list. After deploying: Plugins, the bridge, **Refresh**.

## Unreleased: hotfix, the sandbox scripts read keys from the encrypted store (10 November 2026)

After OPS2's rollout, with the env file's key lines retired (`env-sync.sh --retire-imported-keys`), the sandbox, soak,
spike and round-trip scripts stopped with `LK_PROJECT_TEST_API_KEY is empty in /etc/lk-bridge/lk-bridge.env`: they still
read project keys from the env file only ([ADR 0030](adr/0030-sandbox-scripts-find-keys-as-the-bridge-does.md)).

- **The scripts find a key exactly as the bridge does** (`resolveProjectKey`, new in `src/secrets/project-key.ts`,
  used by `test/sandbox/target.ts`): the key in the encrypted store, opened with `SECRETS_MASTER_KEY` from the env file;
  only when nothing is stored for the project, the env file's `LK_PROJECT_<NAME>_API_KEY` (`LK_API_KEY` in the
  single-project form); a stored key that cannot be opened is refused, never replaced by the env file's. A key in
  neither place is refused with a message naming the dashboard's Projects page. Every earlier rule stands (registered,
  marked as a sandbox, the key's own project exactly the registered one), and a project removed on the dashboard is now
  refused too. Each script says on stderr where the key came from (never the key).
- **`sandbox_project_env` (deploy/lib.sh) reads no key.** It exports only `DB_PATH` and the env file's path
  (`LKB_ENV_FILE`), and drops any key or master key the caller's environment holds; the script reads just the names it
  needs from the file, so no key or master key is put in any process's environment. Without `LKB_ENV_FILE` (a
  developer's checkout) the values come from the environment as before. `project_key_var` is gone (no other user).
- **Checked, nothing else to fix:** no other script or command reads a project key from the env file. `deploy.sh`
  reads only `LK_PROJECT_ID` and `LK_PROJECT_NAME` (for migration 0600); env-sync manages the key lines and asks the
  bridge's `env-tool` (the store) to compare them; `config:check` only checks the format of keys still in the file;
  `lk-run.sh`, `healthcheck.sh`, `backup.sh` and `restore.sh` read no key.
- Tests: `test/unit/sandbox-wrappers.test.ts` runs all four wrappers end to end on a fake server (a fake LegendKeeper
  preloaded into each Node process, logging only a hash of the bearer token): the stored key with no env key, the env
  fallback, a key in neither place, a non-sandbox project, the stored key over a different env key, a stored key that
  cannot be opened, a removed project, and one end-to-end dry run of the round trip in the retired-keys state. Every run's
  stdout and stderr, every process's environment and the report are scanned for every key and master key.
  `test/unit/sandbox-target.test.ts` covers `resolveSandboxTarget` and `resolveProjectKey` directly.
- **For the owner:** nothing to change in the env file. `deploy/lib.sh` changed, so the deploy stops once to show the
  difference; run it again with `--update-self`. Then run the round trip as before:
  `sudo -u lkbridge /opt/lk-bridge/app/deploy/markdown-roundtrip.sh --project test`.

## Unreleased: v2 B2, the Discover and Read tools (10 November 2026)

The first v2 tools agents use ([ADR 0029](adr/0029-discover-and-read-tools.md); every tool in
[tools.md](tools.md#discover-and-read-tools-v2-b2); the agent guide in [bridge-guide.md](bridge-guide.md)).

- **Twelve new read tools**, all `readOnlyHint: true`, all taking `project` and ending with the budget footer:
  `browse_repository_tree`, `browse_asset_tree`, `search`, `get_resource`, `get_resources`, `list_tags`,
  `list_templates`, `list_calendars`, `list_assets`, `read_document`, `get_markdown_guide` and `get_bridge_guide`. They
  answer from the repository tree, the asset tree and the type registry (no LegendKeeper request) except where a
  description says it reads live. Every answer from the tree states its status and when it was last confirmed; a tree
  that cannot answer is refused with nothing spent. Only the AI REPOSITORY is reachable; a page outside it is refused with
  a message that `lk_api_read` can still reach it.
- **`search`** has a real query language (words, `"phrases"`, `OR`, `NOT` or `-`, parentheses, `name:` `tag:` `type:`
  `kind:` `under:` `scope:`), ranked results that say why they matched, and parse errors with a position.
  `content: true` also asks LegendKeeper's own (incomplete) search once and merges, de-duplicates and marks its results.
- **`read_document`** returns B1's Markdown with the document version and keep regions, or `outline`, or one `section`
  (a duplicate heading is refused with the options), or `format: "json"`; maps, timelines and boards are rendered
  read-only. A long page is stored and returned as a handle.
- **The guides** are tools and MCP resources (`lk-bridge://guides/bridge`, `lk-bridge://guides/markdown`). The server
  instructions are now a few sentences pointing to `get_bridge_guide`.
- **`showLowLevelTools`** (new, per profile, default off; migration 1100; audited as `profile.set_low_level_tools`;
  a checkbox on Clients & Access): when off, `lk_api_list_operations`, `lk_api_describe_operation`, `lk_api_paginate_all`
  and every `lk_op_*` are left out of the tool list. Calls to them are refused or allowed by policy exactly as before.
- Engine: `JobEngine.stepResults(project, jobId)` (the stored result of each step of a finished job), used by
  `get_resources`.
- Tests: `test/discover/` (the language, every tool through the real server and the official client on a 1,200-page
  world with the spike's asset library, a tree that is not ready or stale, result sizes, two projects, visibility), the
  tool-enumeration security test now covers the new tools and shows every tool to its attacker, and the tool-list tests
  count 31 tools (28 shown to a profile without the setting).
- Built on A4's branch while PR #23 was open; `main` (with A4 squash-merged) has been merged in.
- **For the owner:** ChatGPT keeps its own copy of the tool list. After deploying: Plugins, the bridge, **Refresh**.

## Unreleased: hotfix, the Markdown converter's matching of identical blocks (10 November 2026)

The property test "editing one paragraph changes that block only" failed once in CI on an `unsupported` block followed
by two empty paragraphs, and passed on a re-run. It was a real bug in `src/markdown/align.ts`, not a flaky test.

- **Cause.** A keep region gets a fingerprint of its own on each side, so the common-prefix step stops at it and
  identical neighbours ("twins") go into the exact LCS. With twins, several longest subsequences exist; the traceback
  broke ties by skipping a current block first, which matched the first twin in the Markdown with the **last** twin on
  the page. Editing the second of two empty paragraphs therefore kept the second's id in the first's place, removed the
  first, and wrote the edit as a new block (`removed` + `added` instead of one `changed`). Ids and attributes the
  Markdown does not show (an image's width and layout, say) could move between twins the same way. Separately, two
  identical blocks both edited in place were never paired as edits (an empty text is similar to nothing), so both lost
  their ids.
- **Fix.** Ties are broken by position, deterministically: of all longest common subsequences, the one with the least
  total displacement (|i − j| per pair) wins, and the same rule settles ties in `pairGap`. A run of identical current
  blocks with as many candidates of its kind on each side pairs in order, as a single block of its kind already did.
  Unchanged blocks keep their own ids; an edit changes exactly the block edited. The exact LCS keeps its size limit and
  speed (about 40 ms at 4 million cells, now about 24 MB at the limit instead of 8 MB).
- **Tests.** `test/markdown/twins.test.ts` (308 cases): the CI counterexample, two to four identical paragraphs (empty
  or not) between every pair of keep regions, headings, lists, tables and paragraphs, with every single and pair edit;
  twins on both sides of and between keep regions; twin images whose hidden attributes differ; twins at the start and
  end of quotes and callouts and after a keep region inside them; identical list items, table rows, lists and tables;
  `applyEdit` on a section; and the tie-breaking of `lcsPairs` and `pairGap` directly. The edit property now requires
  the edited block itself to be the one changed and the result to equal the edited page (it used to accept the edit
  landing on either twin), runs at the full `FC_RUNS` instead of a third, and keeps the counterexample as a fixed
  `examples` case.
- **Reproducible property failures.** The converter's properties go through `assertProperty` (test/markdown/helpers.ts):
  a failure logs the seed, the path, the shrunk counterexample (ready for `examples`) and the command that replays it;
  `FC_SEED` and the new `FC_PATH` replay it. CI stays at 300 runs per property.

## Unreleased: v2 A4 follow-up, the registry wiring and two deploy fixes (10 November 2026)

- **The planner uses A3's type registry** ([docs/assets.md](assets.md#placement-planning), ADR 0027). The project's
  `character` type supplies the **asset root folder name**, the **Characters index page** (below the project's own
  `charactersRootId` setting), the **unknown-race folder** (`unknownIndexName`) and the **Core Reference Type**; each
  falls back to the old bridge's literal ("Characters", "Undetermined / Unknown", "Character Core") when the project has
  no such type or leaves it empty. The folder labels still come from the character page's real ancestry in the tree,
  limited to A3's race search depth (two). Tests: both unset and set (`test/assets/plan.test.ts`), and on the real
  runtime with the real registry (`test/assets/registry.test.ts`).
- **`healthcheck.sh` waits for the bridge.** Before its first check it retries `http://127.0.0.1:<PORT>/healthz` every
  second for up to 30 seconds (`--wait SECONDS` or `LKB_HEALTH_WAIT`; 0 does not wait), so a check straight after a
  restart does not report false failures, and prints one line saying how long it waited. A bridge that never answers is
  still reported by the first check.
- **`deploy.sh --update-self` covers the systemd unit.** If `/etc/systemd/system/lk-bridge.service` differs from the
  release's `deploy/lk-bridge.service`, it shows the difference and asks, then (just before the start, so an earlier
  failure leaves the unit untouched) backs up the installed copy as `lk-bridge.service.bak.<time>`, installs the
  release's (`root:root`, 0644) and runs `systemctl daemon-reload`; the deploy's own start uses it, and a deploy with
  nothing else to do still restarts. Without the flag the end-of-deploy warning is unchanged. New setting
  `LKB_UNIT_DIR` (default `/etc/systemd/system`) for tests. Tests in the fake-root harness
  (`test/unit/deploy-env-gate.test.ts`, `deploy-health-wait.test.ts`); shellcheck is clean (its test now has a 30 s
  timeout; it takes about 4 s).
- Merged `main` (A3, then OPS2): the conflicts were the ADR index, the e2e navigation list and the proposal-prune test
  (main's 20 s timeout replaces mine).

## Unreleased: OPS2, projects, keys and the owner's sign-in on the dashboard (10 November 2026)

Projects and their API keys, the owner password and the authenticator app are managed on the dashboard; the env file
keeps only the bootstrap secrets ([ADR 0028](adr/0028-secrets-on-the-dashboard.md); how to use it in
[runbook-deploy.md](runbook-deploy.md#managing-projects-from-the-dashboard-ops2), [projects.md](projects.md) and
[auth.md](auth.md)).

- **Encrypted secret store** (migration 1000, `src/secrets/`). AES-256-GCM under a key derived from the new
  `SECRETS_MASTER_KEY` (env-sync generates it: `@generate:base64:32`), a fresh nonce per value, the project and purpose
  as associated data, a key id per row. A missing or wrong master key stops only the secrets it cannot open (their
  projects, or the owner's sign-in, fail closed with the reason); nothing crash-loops. `npm run secrets -- status`,
  `rotate-master-key` (backup first, one transaction, refuses while the bridge runs) and `reset-owner --yes`.
- **Projects on the dashboard, at runtime.** Add a project (the key checked with LegendKeeper first: project name, id
  and the key's role shown before anything is stored; then served by a new governor at once, no restart). Replace a key
  (same LegendKeeper project only; atomic; the governor is kept; a reminder to revoke the old key). Pause and drain, then
  remove (refused while jobs or proposals are pending; the project is archived, its key deleted, its history kept
  read-only). Keys are shown by their last four characters only.
- **Env keys move across once.** `LK_PROJECTS`, `LK_PROJECT_<NAME>_API_KEY` and `OWNER_PASSWORD_HASH` become optional;
  at the first start with a master key every env key and the owner's hash and TOTP secret are imported (logged and
  audited by name only). The stored value wins over the env file afterwards, with a warning on the dashboard.
- **Re-authentication** for adding, replacing or removing a key, the password and the authenticator: the password (and
  code) within the last five minutes, rate-limited together with sign-in, on top of the session, Origin and CSRF checks.
- **Account page:** password change (current password required; other sessions signed out), the authenticator app (QR
  code drawn in the browser with `qrcode-generator`, a new bundled dashboard dependency; confirmed by a code; ten
  recovery codes shown once, each usable once at sign-in), the store's state. The Overview recommends the authenticator
  strongly while it is off.
- **env-sync:** `--retire-imported-keys` (the bridge, as the service user, compares each env value with the store;
  only equal or since-replaced values are commented out; mismatches refused; names only), `--rotate-master-key`, and a
  refusal to generate a new master key over a database that holds secrets. The project rules accept a key line that is
  commented out.
- **Audit:** `project.key_check`, `project.add`, `project.replace_key`, `project.drain`, `project.undrain`,
  `project.remove`, `project.key_import`, `owner.reauth`, `owner.password_change`, `owner.totp_enrol_start`,
  `owner.totp_enable`, `owner.totp_remove`, `owner.recovery_codes_regenerate`, `owner.credential_import`,
  `owner.credentials_reset`: names and last four characters, never a value.
- **Tests:** `test/secrets/` (store, associated data, missing and wrong master keys, rotation; runtime add, replace and
  remove with governor isolation; re-authentication; the password; TOTP and recovery codes; import across restarts; a
  scan of logs, responses, events, the audit log, the error table, the HTML and the database files for every secret),
  `test/ui/account.test.tsx`, and the env-sync planner and shell tests. Existing tests that listed every migration now
  check the earlier ones only.

## Unreleased: v2 A3, the type registry, taxonomy, name resolution and ordering (10 November 2026)

Where each kind of page lives, and how the bridge finds and places pages ([docs/PLAN-v2.md](PLAN-v2.md) 4.3, 4.4, 4.5
and section 9; design in [ADR 0026](adr/0026-type-registry-and-name-resolution.md); how to use it in
[docs/registry.md](registry.md)). No MCP tools and no LegendKeeper writes: the services, storage and dashboard the
phase C write tools will use.

- **Storage (migration 0800).** Per project: types, taxonomy entries, the last read of the project's templates, and
  taxonomy drift reports. Types are stored to grow into recipes (PLAN-v2 10.2): page templates as named roles, a
  versioned, empty `recipe` document, a `pack_id` for later; nothing about Arkona is in code (the old bridge's
  conventions are seed defaults and per-type settings).
- **Type registry.** Singular and plural, root index, index template, page templates by role (`core`, `compact`, …),
  asset root folder, placement rule (`character`, with section 9's settings, or `generic`). Created and edited on the
  dashboard (audited). **Seed the Character type** finds `[INDEX] Characters` directly under the root and the templates
  by name (one `listTemplates` read through the governor; the word "Template" ignored, as LegendKeeper's copies drop
  it), and marks anything not found, or found twice, as needing review.
- **Taxonomy.** Each type's categories (plural, singular, parent, aliases, source index, asset folder, status and
  notes). Seeded once per type on request: every index under the root except character indexes (an index holding a
  Core or Compact page about itself) and the unknown-race index. Singulars from the old bridge's race list, otherwise
  simple rules, each marked for review; empty, unread, deep and duplicate indexes are marked too, with the reason.
  **Add missing** creates entries for new indexes only and never changes existing ones.
- **Drift report.** After each completed nightly tree check (a new `tree.onPassFinished` hook) and on request: indexes
  with no entry, entries whose index was deleted, renamed or moved, entries whose parent no longer matches the tree.
  Reported with links into the Repository Tree page, never fixed automatically.
- **Name resolution.** `resolve(project, query, { scope, kinds })`: ids always, raw and display names, aliases and the
  Canonical Display Name, any case; stray `[INDEX]` / `[BSRC]` prefixes cleaned (repeats collapse). Exactly one match,
  or a typed `ambiguous` with every candidate and its path, or `not_found` with near names as a hint only. No fuzzy
  matching decides anything. It is also the Markdown converter's `ctx.resolveMention` (B1).
- **Character placement.** `planCharacterPlacement` (no write): the race index (children and grandchildren of the
  type root, by the taxonomy's plural, singular and aliases), a character index to reuse or create, an existing Core or
  Compact page returned rather than duplicated, the unknown-race index with Race / Species `Unestablished` for an
  unknown or omitted race, the species value otherwise kept as given, and each new page's template and ordering slot.
  A race that does not resolve, is ambiguous or is still waiting for review is a typed refusal.
- **Ordering.** `placementFor` gives the `after` / `before` neighbour (`[INDEX]`, then `[BSRC]`, then unclassified;
  alphabetical with a base-sensitivity, numeric collator), landing next to the right neighbour even among siblings
  out of order. `outOfOrder` reports the fewest siblings that break the rule (never moves anything).
- **Dashboard.** The Repository Mappings page gains _Types_, _Taxonomy_ (a tree view and the review queue), _Drift_ and a
  read-only _Try it_ panel (resolve a name, plan a character placement, compute an ordering slot). The Repository Tree
  page opens at a page linked with `?node=<id>`. Admin routes under `/api/admin/registry`.
- **Tree (additive):** `tree.onPassFinished(fn)` and `tree.queries.sidebars(project, ids)`.
- **Tests** (`test/registry/`, `test/ui/registry.test.tsx`): seeding against a tree shaped like the test world (both
  character layouts, Humans' mix, one unknown-race index), singular forms, every resolution, placement and ordering
  case, drift (on request and from the real nightly check), and two projects fully isolated. Tests that list every
  migration now include 0800.
- **Housekeeping:** CLAUDE.md now says to work only on the session's own branch, never force-push, and merge `main` in
  rather than rebasing.

## Unreleased: v2 A4, the asset tree (10 November 2026)

The bridge's own model of each project's asset library, and the old bridge's folder placement rules as a pure planning
function ([docs/PLAN-v2.md](PLAN-v2.md) 4.6 and section 9; design in [ADR 0027](adr/0027-asset-tree.md); how to use it
in [docs/assets.md](assets.md)). No MCP tools, no uploads and no writes to LegendKeeper: D3 (images) and B2 (Discover
tools) build on its query layer and planner.

- **Storage (migration 0900).** Per project: folders (id, name, parent, depth, cached path) and assets (id, name,
  folder, type, url, width, height, size, SHA-256, hidden, created), each with when and how it was last read and a
  stale flag; an asset and a child folder reference their folder by `(project_id, id)`, so nothing can cross projects.
  Also tombstones, passes with their progress, the walk queue, the staged listing of a folder in progress, owed
  re-reads and the correction log. **Size** stays empty (LegendKeeper's `Asset` carries none) and the **SHA-256** is
  left empty for E1; a recorded hash survives a refresh and is dropped when the image's `url` changes.
- **Build.** `listAssets` returns one folder level at a time, so the build walks every folder, paged, at P3: it lists
  the root level, **shows an estimate** (a minimum of one request per folder found so far; a rebuild also a figure from
  the last inventory) and walks the rest once the owner confirms. A folder's pages are staged and applied together; a
  restart continues where it stopped (finished folders are not listed again, an interrupted one continues from its
  cursor). The test world (18 folders, 559 images) costs **22 requests**.
- **Regular refresh** (`asset-refresh`, every 6 hours, per project, background, can be switched off with the new
  project setting `assetRefreshEnabled`) and **nightly check** (`asset-check`, 02:50 London time, always runs, also
  audits the cached paths): the same walk, paced (250 ms after each request) and at P3 so it gives way to agents' work.
  What they correct goes to the correction log. A row a listing does not show is read with `getAsset` before it is
  removed (absence is not proof of deletion); a refresh never undoes what the bridge's own write changed after the
  folder was listed (the repository tree's observation order, ADR 0025).
- **Updates after the bridge's own asset writes.** `createAssetFolder`, `createImageAsset`, `updateAsset` and
  `deleteAsset` are each followed, in the same job, by a `getAsset` of what changed; the model stores LegendKeeper's
  answer, never a prediction (a create with no id in the response lists its folder; a deleted folder goes with
  everything inside it, as LegendKeeper documents). Failed re-reads are marked stale, logged and retried; a crash
  between a write and its re-read is caught up at the next start.
- **Query layer** (`runtime.assets.queries`): a folder by id or path (`foldersByPath`), children, the subtree with a
  depth limit, the assets in a folder (paged, by type), and exact-name lookups of folders and assets that return **all**
  matches (case ignored unless asked), each answer stating the model's status.
- **Placement** (`planAssetDestination`, `runtime.assets.plan`): pure, reads only the two stored trees. Reuses a folder
  named after the character wherever it is (exactly one); otherwise `Characters / Group / Race / Character` (or without
  the group when the race sits directly under Characters) from the character page's ancestry, `Undetermined / Unknown`
  for an unknown race, then the literal `subfolders`. It lists the folders reused and those that would be created, in
  order. A non-folder asset in the way is `ASSET_NAME_CONFLICT`, several folders of the name `AMBIGUOUS_FOLDER`; folders
  are never moved. The asset root folder name, the Characters index, the unknown-race folder and the Core Reference Type come from A3's character type (defaults: the old bridge's literals); the labels are the page's real ancestry.
- **Dashboard.** An **Asset Tree** page per project (status, counts, build with estimate and progress, last build,
  refresh and check, stale rows, failed re-reads, correction log, a folder browser, **Refresh now** and a read-only
  **Try it** panel for placement) and `GET|POST /api/admin/asset-tree/…` (build, confirm, cancel and refresh are
  audited; the planner is read-only).
- **Tests** (`test/assets/`, `test/ui/assets.test.tsx`): a mock library shaped like the test world; build, estimate,
  resume after a crash; refresh detecting outside changes and never undoing newer writes; every write followed; every
  placement case; two projects isolated; the maintenance jobs; the admin API and page.
- Two existing tests changed: the lists of maintenance jobs and of applied migrations name the new job and migration,
  and the proposal-prune test (91 virtual days, close to the 5 s default on a slow machine) has a 30 s timeout.

## Unreleased: v2 A2, the repository tree (10 November 2026)

The bridge's own model of each project's AI REPOSITORY ([docs/PLAN-v2.md](PLAN-v2.md) 4.2; design and concurrency rules
in [ADR 0025](adr/0025-repository-tree.md); how to use it in [docs/tree.md](tree.md)). No MCP tools yet: later
sessions (A3, B2) build on its query layer.

- **Storage (migration 0700).** One row per page under the project's root (the root included), every row with
  `project_id`: id, raw and display name, kind (`[INDEX] ` → `index`, `[BSRC] ` → `bsrc`, otherwise `unclassified`;
  the root is `root`), parent, rank, depth, path (ids and display names), tags, aliases, documents, hidden and locked,
  Reference Type, Scope, Index Scope, Canonical Display Name, a sidebar summary, the template id (for C2), when and how
  it was last read, and a stale flag. Also: every name a node answers to (for exact lookups), links for later sessions
  (A3's types and taxonomy), tombstones, passes with their progress, the listing a pass is working from, owed
  re-reads, and the correction log. The `tree-snapshot` placeholder's rows are removed.
- **Project settings are editable** (`src/projects/settings.ts`): the AI REPOSITORY root, the key-value property and the
  four row names the tree reads, and a per-project switch for the hourly sweep. On the Projects page (audited
  `project.set_setting`) and with `npm run projects -- set <project> <key> <value>` (and `settings <project>`).
  `parseSettingValue` validates both. Until a root is set the tree is `not_configured` and does nothing. When no root
  is set, the Repository Tree page looks by itself (once, one listing at P3) for exactly one top-level page named
  "AI REPOSITORY" and offers it.
- **First build.** A resumable background job at P3: it lists every resource (paged, the cursor persisted), stops to show
  the estimate (`bridge_estimate`'s arithmetic), then reads each node under the root with getResource once the owner
  confirms. A restart continues where it stopped. It never runs below the governor's P3 floor, and P1 work is served at
  once while it runs. A finished build is recorded as a job.
- **Updates after the bridge's own writes.** The job engine tells write observers before each write step and after its
  outcome (`engine.observeWrites`, awaited inside the job). For the 17 operations that can change the tree, the tree
  re-reads the affected resource(s) with getResource in the same job (descendants too for moves into the root, restores
  and template copies with children) and stores LegendKeeper's answer, never a prediction. A failed re-read marks the
  node stale, is logged and retried; a crash between a write and its re-read is caught up at the next start. Page
  content writes do not touch the tree.
- **Structural sweep** (`tree-sweep`, hourly, per project, can be switched off) and **daily consistency check**
  (`tree-check`, 02:30 London time, P3) replace the `tree-snapshot` placeholder. Each correction (old and new value,
  which pass) goes to the correction log. A page missing from a listing is read once before it is removed (a listing
  paged during changes can skip one).
- **Concurrency.** Observations are ordered by a strictly increasing stamp taken when each read is sent; an observation
  never replaces a later one, so a sweep or check never undoes a newer after-write update. Updates for one project are
  serialised; projects are fully isolated.
- **Query layer** (`runtime.tree.queries`): node, root, children (sibling order), subtree with a depth limit, path,
  documents, nodes by kind, unclassified and stale nodes, counts, and exact-name lookups (raw, display, alias,
  Canonical Display Name; every match). Every answer states the tree's status and when it was last confirmed.
- **Dashboard:** a **Repository Tree** page per project (status, counts by kind, depth, unclassified list, build
  progress and estimate, last build, sweep and check, failed re-reads, correction log, a browsable tree); editable
  settings on the Projects page. Admin routes under `/api/admin/tree` and `PUT /api/admin/projects/:name/settings`.
- **Job engine** (additive): `observeWrites` and `internalRead` (one governed read for the bridge's own bookkeeping,
  not policy-gated, never queued as a job), documented in `src/jobs/README.md`.
- **Maintenance:** a job may be `background` (its scheduled runs go alongside the others, so a long check never holds up
  the 10-second sampler) and may report `skipped` with its reason.
- **Tests** (`test/tree/`, `test/ui/tree.test.tsx`): a 2,000-node world nine levels deep with resources outside the root;
  resuming after a crash in the listing and in the reading; budget priority; every followed operation compared with the
  mock's state; sweep detection of every outside change; the check's property detection and correction log; a sweep and
  a check that must not undo newer after-write updates; two projects with the same ids, fully isolated; status
  transitions; the dashboard and the CLI.
- **Independent review:** eleven issues found by a read-only review of the tree code are fixed, with regression tests
  in `test/tree/review.test.ts` (ADR 0025, "Review").
- Existing tests that listed every migration or maintenance job now include 0700 and the two tree jobs.

## Unreleased: OPS1, env-sync and the deploy's self-check (10 November 2026)

The env file is kept in step with each release's template, and moved to the multi-project form, without anyone
hand-editing secrets ([ADR 0024](adr/0024-env-sync.md); runbook:
[Updating the env file](runbook-deploy.md#updating-the-env-file)). No change to the bridge's behaviour.

- **Markers in `deploy/env.template`.** Every variable has exactly one: `@default`, `@generate:<enc>:<bytes>`
  (`SESSION_SECRET`, `JWT_SIGNING_KEY`), `@secret` (the LegendKeeper keys, `OWNER_PASSWORD_HASH`, `OWNER_TOTP_SECRET`)
  or `@optional`. A test requires one for every variable the config loaders read, and no value on a secret.
- **`deploy/env-sync.sh`** (planner in `deploy/env-sync.mjs`), run as root from `/opt/lk-bridge/bin`: adds missing
  defaults, generates missing or blank secrets from `crypto.randomBytes`, adds a commented-out placeholder and
  `ACTION NEEDED: fill in X` for an owner-only secret, adds optional settings commented out, and comments out (with a
  dated note) settings the template no longer lists. It never changes an existing value and never prints one. `--check`
  reports only (0 in step, 1 changes needed, 2 error); otherwise it shows the summary and asks, unless `--yes`. Every
  edit: a timestamped backup beside the file, an atomic write keeping `root:lkbridge 0640`, then the bridge's own
  configuration check as `lkbridge`, with the backup put back if the edit made the file invalid.
- **`--migrate-projects`** moves `LK_API_KEY` to `LK_PROJECT_<NAME>_API_KEY` (the value moved, never shown), adds
  `LK_PROJECTS` and `LK_DEFAULT_PROJECT`, and comments out `LK_PROJECT_ID`, `LK_PROJECT_NAME` and the retired sandbox
  settings. It refuses a mixed or unexpected state and changes nothing the second time. The runbook's
  [Moving to several projects](runbook-deploy.md#moving-to-several-projects-v2-a1) now uses it.
- **`npm run config:check -- --file <env file>`** (`src/config/check.ts`): runs every start-up config loader on an env
  file and checks each project key's format (no network, no database); one `issue:` line per problem, names only.
- **`deploy.sh`**: after fetching, compares its installed copies (`deploy.sh`, `lib.sh`, `env-sync.sh`,
  `env-sync.mjs`) with the release's and stops with the difference, or installs them and re-runs itself with
  `--update-self` (a warning only with `--current`, so a rollback never downgrades them). Then runs env-sync `--check`
  against the release's template: a missing secret stops it with `ACTION NEEDED`; other differences stop it with the
  exact command, or are applied after the build with `--sync-env`. Every deploy now runs the new build's configuration
  check before the migrations and the start. `--yes` answers its questions. The drift warnings moved out of `deploy.sh`
  (the health check keeps them).
- `migrate-to-build-user.sh` installs the env-sync files too. `tsconfig.json` type-checks `deploy/*.mjs`.

## Unreleased: v2 session B1, the Markdown converter (9 November 2026)

The library every v2 Markdown read and write goes through ([docs/PLAN-v2.md](PLAN-v2.md) 4.7; decisions in
[ADR 0022](adr/0022-markdown-converter.md); the agent-facing guide is [docs/markdown.md](markdown.md)). It is a library
only: no MCP tools, no database tables, no LegendKeeper calls. No existing behaviour changes.

- **`src/markdown`.** `toMarkdown(document)` writes a page in the owner's schema (headings, paragraphs, lists, task
  lists, quotes, callouts, secret and expand blocks, code with its language, rules, simple GFM tables, images, every
  text mark, `<br>`, mentions as `[label](lk://resources/<id>)` or `…/docs/<documentId>`), and everything else as keep
  regions with a readable rendering, listed in `regions`. `fromMarkdown(markdown, base)` reads it back against the
  current page: unchanged blocks are restored verbatim (ids and every attribute), moved ones keep their ids, edited ones
  keep their ids and the settings Markdown cannot show, keep regions restore their block exactly, fenced `lk-block` JSON
  is taken as given, and `[[Name]]` goes through a resolver interface (`resolveMention`, for A3). The result is the new
  tree, a write plan (kept, changed, added, removed, moved, keep regions dropped) and warnings; an unchanged page gives
  an empty plan. `applyEdit` adds `append`, `prepend`, `replace`, `replace_section` and `append_to_section`, with
  sections addressed by heading path (`Biography > Early Life`, `Notes [2]`); `outline` and `getSection` work on
  Markdown. `renderMap`, `renderTimeline` and `renderBoard` give read-only Markdown for the other document types.
- **Refusals, never silent loss.** Typed errors (`MarkdownError`) for a missing keep region in a replace (unless named
  in `dropRegions`), the job engine's unsupported-block guard (`allowUnsupportedLoss`), unknown or repeated regions,
  unresolved or ambiguous mentions, invalid `lk-block` JSON, duplicate ids, editor limits (a documented, extensible
  list), the spec's field limits and nesting depth of 64, image URLs that are not project assets, images inside text,
  unknown HTML, and section paths that match nothing or several headings.
- **Exactness checked at run time.** Lines whose marks CommonMark would misread are written with HTML tags, and the
  whole page is parsed back before it is returned; a block that would not survive is shown as a keep region instead.
- **Parser:** micromark through `mdast-util-from-markdown`, with the GFM table, strikethrough and task-list
  extensions, plus the converter's own `[[…]]` construct (new dependencies; `fast-check` for the tests).
- **`npm run roundtrip`, with `deploy/markdown-roundtrip.sh`.** Reads every page of a project (or a subtree,
  `--root`) through the real engine at P3, read-only, about one read per page, and checks each: blocks → Markdown →
  blocks identical, and an empty plan for the unchanged write-back. It reports totals, keep regions and self-check
  fallbacks, and for each failing page the resource, the first difference and a minimal reproduction in
  `/var/lib/lk-bridge/roundtrip/`. Project selection is A1's, as for the spike and the soak: `--project <name>`, a
  project the bridge has registered and marked as a sandbox (`deploy/markdown-roundtrip.sh --project test`).
- **Tests** (`test/markdown`): property-based tests (fast-check) that generate pages within the spec's schema and prove
  blocks → Markdown → blocks is the identity with an empty plan, that the parser reads every expressible page back as
  exactly what it shows, and that the Markdown is stable; an escaping fuzz over every Markdown-significant character in
  every position and place, nested marks, whitespace at run edges, CJK, right-to-left text, combining characters, emoji
  and 100,000-character paragraphs; fixtures modelled on the test world (a `[BSRC]` article, the Fourth Arkonan Age table
  page at about 3,000 blocks, the Main chronology page with document mentions, a page with an infobox, a collection and
  an unsupported block); a test for every error and warning; the round-trip script's dry run against the mock and its
  wrapper.
- **Independent review.** A fresh agent tried to break the converter; the seven ways it found for an edit or a legacy
  page to change data without a refusal are fixed, with regression tests (ADR 0022, "Review"). Notably, a block moved
  into or out of a quote, callout, secret or expand block now keeps its id and settings.
- `docs/PLAN-v2.md` is left out of the Prettier check, as `docs/PLAN.md` already was.

## Unreleased: v2 A1, several LegendKeeper projects in one bridge (9 November 2026)

One bridge now serves several LegendKeeper projects at once (PLAN-v2 4.1; [ADR 0023](adr/0023-project-model.md),
[projects.md](projects.md)). Moving the live env file: [runbook](runbook-deploy.md#moving-to-several-projects-v2-a1).

- **Configuration.** Keys stay in the env file: `LK_PROJECTS` (names), `LK_PROJECT_<NAME>_API_KEY` (one key each),
  `LK_DEFAULT_PROJECT`, and `REQUIRE_PROJECT_FOR_WRITES` (default `true`). Everything else is in the new `projects`
  table: name, LegendKeeper id (learned from the key and checked at every start), display name, default, sandbox and
  read-only flags, and JSON settings with a typed accessor. The single-project form (`LK_API_KEY`, `LK_PROJECT_ID`,
  `LK_PROJECT_NAME`, default name `test`) still works, with a start-up warning.
- **Start-up checks per project.** Each key must authenticate and prove its project. A refused key, an unpaid plan, or a
  key that now belongs to another project stops **that project only** (shown on the Overview and the new Projects page,
  logged by variable name, never the key); an unreachable LegendKeeper is retried. The bridge listens at once and serves
  each project from the moment its check passes.
- **One governor per project** (its own key tiers and project tier, its own saved counts); the writer pool stays global
  (`WRITERS_MAX`) with turns across projects. Locks are keyed by project and entity.
- **Data.** Migration **0600** (`0600_projects.sql`) adds a required `project_id` to every table holding LegendKeeper
  data (jobs, steps, artefacts and their items, errors, budget samples, the journal and its targets, proposals and their
  operations, governor counters, maintenance runs, mapping sets, rules and field maps), with foreign keys that keep a
  child in its parent's project, project-first indexes, and the `bridge_instance` table. Existing rows go to the project
  in `LK_PROJECT_ID`; ids and sequences carry on. `npm run db:migrate` reads `LK_PROJECT_ID` from the bridge's env file
  when its environment lacks it (an older installed deploy script), and `deploy.sh` now passes it.
- **One bridge process per project** (ADR 0023): a second process on the same database is refused at start-up
  (`INSTANCE_LOCKED`), with a heartbeat and a safe take-over of a holder that is gone.
- **Tools.** Every tool takes an optional `project` (name or id): unknown projects are refused with the registered
  names (`UNKNOWN_PROJECT`); reads default to the default project; writes without `project` are refused when several
  projects are registered (`PROJECT_REQUIRED`); a project not served now is `PROJECT_UNAVAILABLE`. Every result names its
  project and ends with that project's budget line (`budget (test): …`). New **`list_projects`**. `bridge_info` and
  `bridge_budget` are per project (`allProjects: true` shows every budget). Proposals record their project and execute
  there only. The server instructions describe projects.
- **Policy** is unchanged (profiles and scopes are per connection); listings are filtered by project.
- **Maintenance.** The budget sampler samples every governor; journal and proposal pruning, proposal expiry and the
  SQLite optimise cover every project and are recorded as bridge-wide runs (`*`).
- **Dashboard.** A project switcher scopes Overview, Jobs, Errors, Budgets, Journal, Proposals and Mappings; Budgets
  shows every project side by side; the Overview lists every project's status; a new **Projects** page shows flags,
  ids, whether each key is configured and valid, and the settings (read-only), with an audited per-project **Read-only**
  switch and **Check again**.
- **Sandbox settings retired.** `LK_SANDBOX_API_KEY`, `LK_SANDBOX_PROJECT_ID` and `--allow-bridge-project` are gone. The
  sandbox, soak and spike scripts and their wrappers take `--project <name>` and refuse any project not marked as a
  sandbox; `npm run projects -- sandbox <name> on|off` (audited) is the only way to mark one. `deploy/env.template`,
  `.env.example` and the env drift check follow the new form.
- **Tests.** `test/projects/`: two mock projects with different keys behind one URL (`test/contract/multi-mock.ts`)
  checked for isolation on every surface (queries, tools, dashboard) for jobs, journal, proposals, budget counters and
  samples, errors and mappings; independent governors; writer fairness; `REQUIRE_PROJECT_FOR_WRITES`; the per-project
  read-only flag; start-up checks (wrong key, mismatched id, single-project form); the instance guard; migration 0600 on
  a v1.0.2 database built from this repository's own migrations; configuration parsing and the projects CLI. Existing
  suites now name their project.

## Unreleased: v2 phase 0 spike (9 November 2026)

A server script that checks the assumptions in [docs/PLAN-v2.md](PLAN-v2.md) against the real test world before any v2
code is built on them (PLAN-v2, section 6, session 0). It changes no application behaviour: no file under `src/` is
touched, and nothing is deployed to the running bridge.

- **`npm run spike:v2`**, with the wrapper `deploy/spike-v2.sh`. Ten checks, each reported PASS, FAIL or INFO with its
  evidence: (1) whether `createManyResources` accepts a parent minted in the same batch (and, if not, whether three
  ordered calls work); (2) search with limit 100 and 50 on a rare, a broad and a very common query, repeats per matching
  document and any hidden cap; (3) downloading three image assets through the bridge's outbound fetch guard (host,
  authentication, status, content type, length, SHA-256); (4) the Fourth Arkonan Age timeline's lanes, the first 30
  events, the raw fields of five samples and how year-only, month-range and date-range events are stored, plus the event
  schema's field list from the vendored OpenAPI spec; (5) the calendar (months, eras, formats) and LegendKeeper's own
  minute values and formatted text for sampled events, the date engine's test data; (6) the structure of the age table
  page and the Main page's index table (block kinds, header cells, run structure of a row, multi-paragraph cells, rows
  around a year-only and a range row); (7) map images and features, and whether the documented pixel formula reproduces
  the reported bounds; (8) a preview of the AI REPOSITORY tree (kinds, depth, outside count, sidebar properties of five
  articles, sibling order); (9) the Characters index, its children and grandchildren, the templates, and whether exactly
  one `[INDEX] Undetermined / Unknown` exists; (10) the asset folder tree under `Characters`.
- **Same safety rules as the soak.** It reads only `LK_SANDBOX_API_KEY` and `LK_SANDBOX_PROJECT_ID`, refuses unless the
  key's own project is exactly the sandbox project, needs `--allow-bridge-project` while the bridge serves the test
  world, uses a temporary database, and prints no secret. Every LegendKeeper call goes through the real job engine and
  governor at priority P3. **Only check 1 writes**, under one throwaway root resource that is deleted (cascade) at the
  end of the check, with a second attempt as a last safety net; the rule is enforced in code (no write outside check 1,
  only `createResource`, `createManyResources` and `deleteResource`, only under the throwaway tree), and `--skip 1` makes
  the whole run read-only.
- **Output.** The Markdown report on stdout (progress goes to stderr) and in
  `/var/lib/lk-bridge/spike/spike-v2-<timestamp>.md`, with the calendar oracle beside it as
  `spike-v2-<timestamp>-oracle.json`. Every sample is capped at 40 lines (`--sample-lines`).
- **Tests.** `test/tools/spike-v2-dryrun.test.ts` runs the whole script against the mock LegendKeeper with a stateful
  test world (`test/tools/spike-world.ts`): the guard, all ten checks and the report, the write rules, a refused nested
  batch, the clean-up after a forced failure (check 1 stopping with an error, and a failing fallback), a hidden search
  cap, and the outbound guard refusing a port or an address. `test/tools/spike-wrapper.test.ts` runs the wrapper against
  a temporary env file. CI runs both (an explicit step, as well as `npm test`), and shellchecks the wrapper with the
  other deploy scripts.

## 1.0.2 (8 November 2026): ChatGPT's `private_key_jwt` client authentication

ChatGPT's custom connector was refused at the consent page ("The application could not be verified: client metadata
document must use token_endpoint_auth_method "none""). Its client metadata document (`https://chatgpt.com/oauth/client.json`)
authenticates at the token endpoint with `private_key_jwt` (RFC 7523), signed RS256 with keys at its `jwks_uri`. The
bridge now supports that ([ADR 0021](adr/0021-private-key-jwt-client-authentication.md)). No tag is pushed from here.

**Upgrading:** deploy as usual; migration `0101_client_assertion_jti.sql` (new table `auth_client_assertion_jtis`) is
applied at start. No settings change. To fetch ChatGPT's key set the server needs outbound HTTPS to `chatgpt.com:443`,
which the document fetch already uses.

- **Metadata.** `token_endpoint_auth_methods_supported` (and the revocation equivalent) now list `private_key_jwt` after
  `none`, which stays first so Claude keeps choosing its metadata document. New
  `token_endpoint_auth_signing_alg_values_supported` (and revocation): RS256, RS384, RS512, PS256, PS384, PS512, ES256,
  ES384, ES512; never `none` or HS*.
- **CIMD validation.** `token_endpoint_auth_method` may be `none` or `private_key_jwt`. A `private_key_jwt` document needs
  exactly one of an https `jwks_uri` or an inline `jwks` of public keys; a declared `token_endpoint_auth_signing_alg` must
  be a supported asymmetric algorithm and is then the only one accepted. The non-standard
  `token_endpoint_auth_methods_supported` in a client document is ignored: it cannot make ChatGPT's client a `none`
  client. Other methods are refused with the same `client.metadata_rejected` line as before. DCR is unchanged.
- **Token and revocation endpoints.** A `private_key_jwt` client must send a valid `client_assertion` (both grants, and
  revocation) and cannot fall back to `none`; a `none` client cannot send one. Checks: signature against the client's key
  set chosen by `kid` (an unknown `kid` refetches the set once, at most once a minute), the declared algorithm, `iss` and
  `sub` equal to the `client_id`, `aud` the issuer or the token endpoint (canonical), `exp` present and at most 5 minutes
  ahead with 60 seconds of skew, `nbf` and `iat`, and a single-use `jti` kept in SQLite until it expires (so a restart
  does not allow a replay). Failures are `401 invalid_client`.
- **Key-set fetch** through the existing SSRF guard (https, port 443 unless allowlisted, public addresses, no redirects,
  4-second deadline), 64 KiB cap, cached per `Cache-Control`/`Expires` for at least 30 seconds and at most an hour,
  `User-Agent: LK-Bridge/1.0.2 (OAuth client key fetcher)`. A non-JSON answer (an HTML challenge) fails closed and is
  logged with the status or content type received. The SSRF fetcher's content-type refusal now names the type it got.
- **Logging.** `client.assertion_rejected` gives the specific reason (`no_assertion`, `bad_signature`, `wrong_alg`,
  `alg_not_allowed`, `wrong_aud`, `expired`, `exp_too_far`, `replayed_jti`, `unknown_kid`, `jwks_fetch_failed`, …),
  never the assertion. `client.jwks_fetched` and `client.assertion_accepted` record successes; `client.metadata_fetched`
  carries `auth_method`, `jwks_uri` and `signing_alg`.
- **Tests** (`test/auth/private-key-jwt.test.ts`): ChatGPT's real document shape with a local HTTPS key-set server on an
  allowlisted port and per-run RSA and EC keys; the full flow (authorise with `iss`, consent with the `chatgpt` profile,
  code exchange, refresh, revocation); every refusal; replay across a restart on the same database; key rotation; an
  HTML key-set response; Claude's and Claude Code's real documents still working with `none`.
- Docs: [auth.md](auth.md) (client authentication, ChatGPT), [auth-live-checklist.md](auth-live-checklist.md) §9,
  PLAN amendment 7.

## v1.0.1 follow-up hotfix, shipped in 1.0.2 (8 November 2026)

- **Fixed: `migrate-to-build-user.sh` always stopped at the deploy-key check** ("lkbuild cannot authenticate to
  GitHub"), even with a working key. It piped `ssh -T git@github.com` into `grep` under `set -o pipefail`, and GitHub
  ends `ssh -T` with exit status 1 even when it accepts the key. The check is now `git ls-remote <origin> HEAD`, run as
  `lkbuild` in exactly the environment `deploy.sh` uses for git (same clean environment, `PATH`, key and SSH options);
  exit status 0 passes, and on failure git's own error is printed. Nothing is removed from `lkbridge` unless it passes,
  as before. Running the script again after this fix is safe: it picks up where it stopped (the key is then already in
  `lkbuild`'s home; it completes a partly copied SSH set-up, checks the key, and only then removes the key, its SSH
  config and `known_hosts` from `lkbridge`'s home, the same files a first run removes).
- `deploy.sh` now runs git as `lkbuild` with `GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=15'`, so a deploy
  fails at once instead of waiting for an SSH prompt; the migration's check uses the same setting.
- Runbook: the manual key checks use `git ls-remote … HEAD` (meaningful exit status) and say that `ssh -T` is to be read
  by its message only. Nothing else in `deploy/` used `ssh`.
- Tests (`test/unit/deploy-files.test.ts`): the script's own check runs against a stub GitHub whose `ssh -T` exits 1
  with the success message and whose upload-pack serves a real repository (passes; the old pipe fails against the same
  stub); a refused key fails with git's message; the check's environment must match `deploy.sh`'s `as_build`; no script
  relies on `ssh -T`.

## 1.0.1 (8 November 2026)

The open items of the chunk 8 hardening review ([docs/review/2026-11-hardening.md](review/2026-11-hardening.md)): F-14,
F-15, F-16, F-17, F-19 and F-21 are fixed. No tag is pushed from here; the owner creates the release.

**Upgrading the live server needs a one-off migration** (the deploy now uses a separate build user): follow
[runbook › Migrating an existing install to v1.0.1](runbook-deploy.md#migrating-an-existing-install-to-v101). From then on
deploy with `sudo /opt/lk-bridge/bin/deploy.sh`.

**Security and operations**

- **F-17: a separate build user** ([ADR 0020](adr/0020-separate-build-user.md)). `lkbuild` owns the checkout and the
  read-only deploy key and cannot read `/etc/lk-bridge` or `/var/lib/lk-bridge`; `lkbridge` can read and run the app but
  not write it. `deploy.sh` runs as root from a root-owned copy in `/opt/lk-bridge/bin` (it refuses to run from the
  checkout) and drops to `lkbuild` for git, `npm ci` and the build, and to `lkbridge` for the backup, migrations, health
  check and restart, each with `runuser` and an empty environment. New `deploy/migrate-to-build-user.sh` (idempotent,
  `--check` mode) moves an existing install. `healthcheck.sh` gains six PASS/FAIL permission checks. No new sudo rule:
  `lkbridge` keeps exactly start, stop, restart and status; `lkbuild` has none.
- **F-19: outbound port 443 only.** The CIMD document fetch, the image source fetch (every redirect hop) and the signed
  upload PUT refuse any other port, before DNS or connecting, unless the exact `host:port` is listed in the new setting
  `OUTBOUND_EXTRA_PORTS_ALLOWLIST` (default empty; a malformed entry stops the bridge at start-up).
- **F-14: the governor keeps its counts across restarts.** Every tier's recent counts (compact buckets, stamped late so
  they can only over-count) and any active 429 block are saved at most every 10 s while they change and on shutdown, and
  restored at start without anything older than the tier's window. Missing or corrupt data starts empty with a warning.
  Migration `0500_governor_counters.sql` (one new table). The governor's interface is unchanged apart from one optional
  constructor option (`persistence`); `src/lk/README.md` documents it.

**Policy and retention**

- **F-15: consent keeps an existing profile's scope** ([ADR 0019](adr/0019-consent-keeps-existing-scope.md), the owner's
  decision). An existing profile's current scope is preselected; a new profile still starts at the default (`read`). A
  change to an existing profile's scope is applied only after a confirmation page that shows the warning that it affects
  every connection on the profile, and is audited as before.
- **F-16: `proposal-prune`.** A new daily maintenance job (03:45 London, after `journal-prune` at 03:30) deletes
  executed, rejected, expired and failed proposals that finished more than `POLICY_PROPOSAL_RETENTION_DAYS` (new, default 90) days ago, with their stored pre-state. Pending, approved, executing and conflicted proposals are never pruned. Jobs,
  journal entries and audit rows keep the proposal id as text.
- **F-21:** `bridge_info`'s shared, cached project lookup now runs as the bridge's own work, so a failure there is
  recorded against `system`, not against the caller that happened to refresh it.

**Behaviour you will notice**

- Deploying is `sudo /opt/lk-bridge/bin/deploy.sh`; `sudo -u lkbridge …/deploy.sh` stops with a message. The health
  check prints twelve PASS lines instead of six. After a failed health check the deploy now says the new version is
  still running (it used to say "stopped").
- Re-approving a connection on an existing profile no longer lowers it to `read`; changing its scope asks for a second
  confirmation.
- Image URLs, their redirects, signed upload URLs and client metadata documents on a port other than 443 are refused
  (`UPLOAD_URL_REFUSED`, `UPLOAD_TARGET_REFUSED`, or a refused CIMD client) unless allowlisted.
- The Maintenance Jobs page lists `proposal-prune` (enabled); finished proposals older than 90 days disappear from the
  Proposals page and from `bridge_proposal_status` (they answer as unknown ids). One `proposal.pruned` audit row per run
  that removed anything.
- Straight after a restart the governor may make a call wait that it used to send at once (the counts it now remembers).
  The budget page shows the remembered counts at once.
- New env names (optional, commented in `deploy/env.template`): `OUTBOUND_EXTRA_PORTS_ALLOWLIST`,
  `POLICY_PROPOSAL_RETENTION_DAYS`. The env drift check mentions them until they are copied across.

**Tests changed, and why** (none weakened)

- `test/policy/mcp.test.ts`: the existing "pick an existing profile and set its scope" test now goes through the
  confirmation page, which is the new rule; six new tests cover F-15.
- `test/tools/policy-e2e.test.ts`: "every tool sends the real principal" allows exactly one exception, `bridge_info`'s
  two cached reads with the fixed system origin (F-21); every other tool is checked as before.
- `test/auth/cimd.test.ts`, `test/tools/upload.test.ts`: their local HTTPS servers listen on random ports, so their
  guards now list those exact `host:port` pairs, as `OUTBOUND_EXTRA_PORTS_ALLOWLIST` would; the address checks are
  unchanged and new tests cover the port rule.
- `test/unit/deploy-files.test.ts`: "deploy.sh refuses to run as root" became "runs only as root, from the installed
  copy" (the new design), with new tests for the per-step users and the migration script.
- `test/maintenance/*`: the registry has five implemented jobs; `test/policy/defaults.test.ts` lists migration 0500.

## 1.0.0 (8 November 2026)

The first versioned release: everything below, from chunk 0 to the hotfix, plus chunk 8's review. The owner creates the
release and its tag on GitHub; no tag is pushed from here.

### Chunk 8: independent hardening review

Findings, threat model and statuses: [docs/review/2026-11-hardening.md](review/2026-11-hardening.md). Decisions that
extend earlier ones: [ADR 0018](adr/0018-chunk-8-hardening-decisions.md). PLAN amendment 6 (the bridge stays on the test
world).

**Security and data safety**

- **F-01 (High): owner sign-in limit.** Each attempt is counted before the Argon2 check and given back on success; a burst
  of concurrent wrong passwords used to be verified in full before the limit noticed.
- **F-02: queued work follows the live scope.** Before each new step of a job acting for an agent the policy gate is asked
  again (`phase: 'execute'`); a revoked connection or a lowered scope stops the job (`POLICY_DENIED`, rest cancelled).
  Owner-approved and internal work is not asked again.
- **F-03: `deleteBlock` is guarded** against removing `unsupported` blocks in its subtree (`allowUnsupportedLoss` overrides).
  **F-06:** an `unsupported` block without an id always counts as lost (run `assignBlockIds`).
- **F-04: proposal limits.** At most 4 MiB of pre-state per proposal (cut by bytes) and 50 pending proposals per principal.
- **F-05: the `/mcp` body limit fits `UPLOAD_MAX_BYTES` as base64** (about 13.6 MiB for the default 10 MiB; it was the MCP
  SDK's 4 MiB, so base64 images over about 3 MiB never reached the tool). Fastify's 1 MiB limit never applied to `/mcp`.
- **F-07:** at scope `propose`, `lk_upload_image` is refused before a URL source is downloaded.
- **F-08:** `/api/admin` refuses requests a browser marks `Sec-Fetch-Site: cross-site` or `same-site`, reads included.
- **F-13:** `engine.stop()` releases pending `bridge_job_wait` calls, so a shutdown never waits for a long poll.

**Required changes**

- **A: the journal records every write**, not only destructive ones: operation, target (a create's new entity), resource
  and document, principal, profile, approver, job, time, capped params (upload keys redacted) and outcome. Pre-images stay
  with the destructive writes. Migration `0201_journal_every_write.sql` (indexes on `(column, id)`, and
  `write_journal_targets` for `createManyResources`). `bridge_journal_lookup` gains `principalId`, `profile`, `outcome`,
  `withPreImage` and the `before` cursor (`nextBefore`); so does `GET /api/admin/journal`; the Journal page pages with
  **Older** / **Newest** and filters by outcome and destructive writes.
- **B: the sandbox soak**, `npm run soak:sandbox [-- --writes N]` and `deploy/soak-sandbox.sh`: about 1,000 writes and a
  matching mix of reads through the real engine and governor under one throwaway root (deleted at the end), with a report
  of time, writes per minute, 429s (target zero), retries, budget waits and peak memory. Refuses unless the key's project
  is `LK_SANDBOX_PROJECT_ID`; the wrapper also refuses the bridge's own project without `--allow-bridge-project`.
- **C: the browser smoke test** runs again (`npm run test:e2e`, all four checks pass); how to run it is in the runbook.
- **D: version 1.0.0.**

**Operations**

- **F-09: request logging.** One compact `request completed` line per served request (method, path without query, status,
  time, address) through a `LogController` subclass; unmatched paths (scanner probes) get a plain JSON 404 and are logged at
  debug only. Auth events keep their levels; Fastify's error logging is unchanged.
- **F-10: env drift.** `deploy.sh` and `healthcheck.sh` warn, by variable name only, when the env file lacks a template
  variable, misses a new optional one, or keeps a removed one.
- **Restore is a script:** `deploy/restore.sh` checks the backup first, moves the live database and its WAL files aside
  (never deletes), and puts the backup in place; `test/unit/backup-restore.test.ts` backs up a live WAL database and
  restores it. The runbook gains "Soak test", "Browser smoke test" and "Memory" sections and a rollback note for 1.0.0.
- **F-18:** the systemd comment on `EnvironmentFile=` precedence is corrected (values unchanged).

**Tests changed, and why** (none weakened)

- `test/jobs/policy.test.ts` recorded every gate call; the gate is now also asked at execution, so the recorder separates
  the two phases, and a new test pins the execution calls.
- `test/policy/defaults.test.ts` lists every migration applied after 0200; it now includes 0201.
- `test/policy/no-agent-escalation.test.ts` also runs with all 89 `lk_op_*` tools (F-12). Its "no tool administers policy"
  name check matched `lk_op_revokeInvite` (a LegendKeeper invite operation, refused unless `LK_ALLOW_MEMBER_ADMIN=true`);
  per-operation tools must instead be exactly `lk_op_<registry operation id>`.

### Hotfix: claude.ai's grant types (CIMD and DCR)

claude.ai's custom connector was refused through both "Use Claude's published identity" (CIMD) and "Register
automatically" (DCR), because it lists `urn:ietf:params:oauth:grant-type:jwt-bearer` alongside `authorization_code`
and `refresh_token` ([ADR 0017](adr/0017-unsupported-client-grant-types-ignored.md)).

- **CIMD:** a document is accepted if its `grant_types` include `authorization_code` and its `response_types`, if
  present, include `code`. Other values are ignored and logged at info level (`client.grant_types_ignored`); the
  stored registration holds only the supported ones.
- **DCR:** the client is registered with the intersection of the requested and supported grant types, and the
  registration response returns the adjusted values (RFC 7591 §3.2.1). Only a request without `authorization_code`
  is refused. Requests listing, for example, `implicit` beside `authorization_code` were refused before and are now
  registered with `authorization_code` only.
- **Token endpoint:** unchanged; the JWT bearer grant, like any other, gets `unsupported_grant_type`.
- **Diagnosable refusals:** `client.metadata_rejected`, `client.registration_rejected` and `authorize.rejected` now
  carry the `field` at fault and its offending `value` (cut to 300 characters; never a secret) beside the `client_id`
  or `client_name`. DCR refusals other than redirect URIs were not logged at all before.
- Every other check is unchanged: exact `client_id`, redirect allowlist, SSRF guard, `token_endpoint_auth_method`.
- **Tests:** a fixture with claude.ai's and Claude Code's published documents, verbatim
  (`test/auth/fixtures/claude-client-metadata.ts`); claude.ai's document accepted through consent, token issuance and
  refresh, with the JWT bearer grant still refused at the token endpoint; documents and registrations without
  `authorization_code` still refused; the DCR intersection; and the new log fields.
- **Docs:** [docs/auth.md](auth.md) (grant types and refusal logging), the live checklist, PLAN amendment 5, and
  ADR 0007's status line.

### Chunk 6: maintenance framework, repository mappings, two fixes

- **Maintenance framework** (`src/maintenance/`, [docs/maintenance.md](maintenance.md), [ADR 0016](adr/0016-maintenance-and-mappings-choices.md)):
  a registry (id, name, description, schedule, enabled, implemented, last and next run) and a scheduler that keeps its
  state in SQLite. Schedules are a fixed interval or a daily time on the Europe/London clock (23 or 25 hours apart across
  the clocks change). No backlog: at most one overdue run per job after a restart. Every run goes through the job engine
  at P3 as the `system` principal with an origin naming the job; jobs that write to LegendKeeper are skipped, and the skip
  recorded, under read-only mode or a writes pause. Owner commands (enable, disable, change schedule, run now) are
  audited and evented.
  - Implemented: `budget-sampler` (every 10 s; replaces chunk 5's interim sampler, sparklines unchanged),
    `journal-prune` (daily 03:30), `proposal-expiry` (every 5 minutes; the proposal service's own timer is now off),
    `sqlite-optimise` (weekly).
  - Placeholders, not implementable: `assign-block-ids-sweep`, `tree-snapshot`, `orphan-and-link-audit`, `tag-audit`.
  - New settings `MAINTENANCE_ENABLED`, `MAINTENANCE_DEFER_SECONDS`, `MAINTENANCE_HISTORY_RUNS`
    (`src/config/maintenance.ts`). **Removed:** `ADMIN_BUDGET_SAMPLE_SECONDS` and `AdminSettings.budgetSampleMs`.
- **Repository mappings** (`src/mappings/`, [docs/mappings.md](mappings.md)): mapping sets (at most one active), type rules
  (subtree, template or tag → semantic type, with priority), field maps (sidebar property, infobox row, or heading/block
  → expected kind), notes and timestamps; owner CRUD (audited, evented); versioned JSON export and validated import;
  a readable summary; a read-only preview through the governor at P0. No inference engine and no MCP tool.
- **Pages:** Maintenance Jobs and Repository Mappings replace chunk 5's placeholders. Admin routes under
  `/api/admin/maintenance` and `/api/admin/mappings` keep chunk 5's owner-session, Origin and CSRF rules.
- Migration `0400_maintenance_mappings.sql`.
- **Fix: `bridge_info`** called `getProject` and `listMembers` with `{ path: … }`, which the registry rejects, so it always
  reported an unknown role and no project name. It now calls them with `{}` like the dashboard's health check
  (`test/tools/info.test.ts`).
- **Fix: member and invite operations under `propose` scope.** Checked end to end for every member and invite operation at
  every scope, with and without `LK_ALLOW_MEMBER_ADMIN` (`test/policy/member-admin.test.ts`): with it off, the three
  administrative operations were already refused with `MEMBER_ADMIN_DISABLED` at capture (the dry-run of the engine's
  guards), never captured as a proposal; the matrix now pins that. It did find a real bug with it **on**: capturing a
  proposal for `removeMember`, `revokeInvite` (and calendar writes) failed with `INVALID_PARAMS`, because the target read was
  sent with an empty `path` object. Fixed in `src/policy/proposals.ts`.
- **Changes outside chunk 6's own files** (all small; each commented in the code):
  - `src/runtime.ts`: builds and starts the maintenance scheduler and the mappings layer, stops it on shutdown, removes the
    interim sampler. `src/server.ts`: `loadMaintenanceConfig` at start-up and a `maintenanceSettings` option.
  - `src/admin/sampler.ts` deleted; `src/admin/index.ts`, `src/config/admin.ts`: sampler export and setting removed.
  - `src/admin/plugin.ts`, `types.ts`, `http.ts`: the two route groups, `maintenance` and `mappings` on `AdminRuntime`,
    status codes for the two new error types.
  - `src/jobs/engine.ts`: `recordResult` takes an optional `failure` (a failed maintenance run is a `failed` job).
  - `src/policy/proposals.ts`, `src/policy/index.ts`: the `externalExpirySweep` option; the empty-`path` fix above.
  - `src/mcp/tools/bridge.ts`: the `bridge_info` fix.
  - `src/config/index.ts`: one export line. `vitest.config.ts`: the two new test directories.
  - Tests: `test/admin/helpers.ts` (scheduler off by default, `maintenance` option), `test/admin/data.test.ts` (interim
    sampler tests removed; the job is tested in `test/maintenance/`), `test/policy/helpers.ts` (`externalExpirySweep`),
    `test/policy/defaults.test.ts` (migration 0400 is applied too), `test/ui/pages.test.tsx` and `test/e2e/dashboard.spec.ts`
    (the placeholder expectations), `test/e2e/server.ts`.
  - `ui/src/app.tsx` (routes, nav), `ui/src/pages/placeholder.tsx` deleted, `ui/src/styles.css` (one rule).
  - Docs: `docs/dashboard.md`, `.env.example`, and `deploy/env.template` (chunk 7a's test requires it to list every
    `.env.example` variable: `ADMIN_BUDGET_SAMPLE_SECONDS` out, the three `MAINTENANCE_*` in).

### Chunk 7a: deployment files and the runbook

No application behaviour changed. Everything is under `deploy/`, `docs/`, `test/unit/` and the CI file.

- **`deploy/`**: `install-node.sh` (private Node 24 LTS under `/opt/lk-bridge/runtime/node`, version pinned and
  overridable, SHA-256 checked against `SHASUMS256.txt`, idempotent), `lk-bridge.service` (hardened, `TimeoutStopSec=45`
  for the engine's 20 s drain), `Caddyfile.lk-bridge` (one site block; `flush_interval -1`; no redirects, rewrites,
  `encode` or headers), `deploy.sh` (stop-to-drain, pre-deploy backup, fast-forward only, `npm ci`, build, migrate, start,
  health check; `--current` for rollback), `backup.sh` with `lk-bridge-backup.service` and `.timer` (04:15 Europe/London,
  integrity-checked, gzip, 14 nightly copies kept), `healthcheck.sh`, `sudoers.lk-bridge` (four `systemctl` commands for
  `lk-bridge`), `env.template`, and helpers `lib.sh`, `lk-run.sh` (runs the owner CLIs with the private Node and
  `DB_PATH`) and `sandbox-test.sh`.
- **`npm run test:sandbox` cannot read the bridge's env file** (vitest loads no env files, and the file is not safe to
  `source`). `deploy/sandbox-test.sh` reads only `LK_SANDBOX_API_KEY` and `LK_SANDBOX_PROJECT_ID`, exports only those, prints
  neither, and refuses to run if they equal the production key or project id.
- **[docs/runbook-deploy.md](runbook-deploy.md)**: the step-by-step deployment for this server, with every `sudo` step marked.
  [ADR 0015](adr/0015-deployment-layout.md) records the departures from PLAN §9 (private Node, `/opt/lk-bridge/app`,
  stop-to-drain because the admin API accepts only the owner's browser session).
- **Tests:** `test/unit/deploy-env-template.test.ts` derives the variables the config loaders read and require from the
  zod schemas and checks `env.template` has them all, holds only the documented production defaults and no secret;
  `test/unit/deploy-files.test.ts` checks the scripts (strict mode, executable, shellcheck when installed), the sudoers rule,
  the units (and `systemd-analyze verify` when available) and the Caddy block. CI runs `shellcheck -x deploy/*.sh`.

### Chunk 5: dashboard, admin API and live stream

- **Dashboard** at `/ui` (`ui/`, Vite + React, TypeScript strict, light and dark, bundled with no external fonts or
  scripts): Overview, Jobs (live progress, history, filters by status, origin, profile and principal, detail with steps,
  attempts, request ids, artefacts and the `uncertain` flag, controls), Errors (grouped, detail with the full LegendKeeper
  body and a request-id copy button, mark resolved), Request Budgets (a gauge per tier, upload as "reactive only", 24 h
  sparklines, observed-against-modelled drift, queue depth, editable reserve floors), Concurrent Writers (slots, locks,
  waits, `WRITERS_MAX`, pause, drain, writes per minute), Proposals (readable diffs, approve, reject with a reason, bulk,
  conflicted proposals reject-only), Clients & Access (profiles, scopes with a confirmation when raising, default scope,
  grants and PATs by profile with last use and revoke, PAT creation shown once), Journal (view only), Settings (every
  change confirmed and audited), and placeholder pages for Maintenance and Repository Mappings ("Coming in a later chunk").
- **Admin API** `/api/admin/*` and the **live stream** `/api/admin/stream` (`src/admin/`,
  [docs/dashboard.md](dashboard.md), [ADR 0013](adr/0013-dashboard-and-admin-api.md)). Owner session only (OAuth tokens
  and PATs are never accepted), Origin and CSRF on every state-changing request, strict CSP and security headers on `/ui`,
  every change through the owner commands, engine controls or runtime settings functions (audited, evented), secrets
  redacted. The stream has heartbeats, `Last-Event-ID` replay and `resync`.
- `npm run build` now builds the UI too (`ui/dist`, served at `/ui` with an SPA fallback); `npm run test:e2e` is an opt-in
  Chromium smoke test; `typecheck` also covers `ui/` and `test/ui/`. React, Vite and the test tooling are dev
  dependencies.
- **Interim budget sampler** (`src/admin/sampler.ts`): every 10 s `engine.recordBudgetSample(governor.snapshot())`,
  stopped on shutdown. Chunk 6 replaces it with the `budget-sampler` job.
- New settings `ADMIN_STREAM_HEARTBEAT_SECONDS`, `ADMIN_STREAM_REPLAY_EVENTS`, `ADMIN_BUDGET_PUSH_SECONDS`,
  `ADMIN_BUDGET_SAMPLE_SECONDS` (`src/config/admin.ts`).
- **Changes outside chunk 5's own files** (all small and additive unless noted):
  - `src/auth/http.ts`, `src/auth/pages.ts`: `Referrer-Policy: same-origin` on the sign-in, consent and sign-out pages.
    **Bug fix:** under `no-referrer` a browser sends `Origin: null` on form POSTs, so owner sign-in was refused in a real
    browser ([ADR 0014](adr/0014-auth-pages-referrer-policy.md)).
  - `src/lk/governor/governor.ts`: `setReserveFloors()` (floors change live; `settings` is now a getter).
  - `src/jobs/journal.ts`: an optional `id` filter on `journalLookup` (the journal detail view).
  - `src/runtime.ts`: applies stored dashboard settings, starts and stops the sampler, exposes `config` and `envConfig`.
  - `src/server.ts`: mounts the admin plugin (`admin` option), `loadAdminConfig` at start-up.
  - `src/config/index.ts`: one export line. `tsconfig.json`, `vitest.config.ts`, `package.json`, `.gitignore`,
    `.prettierignore`: UI build, typecheck and test wiring.
- **Known issue found, fixed in chunk 6:** `bridge_info` called `getProject` and `listMembers` with `{ path: … }`
  parameters, which the registry rejects (`INVALID_PARAMS`), so it always reported an unknown role and no project name.

### Chunk 2b: identity, scopes and proposals

- **Integration with chunk 3** (merged from `main`):
  - `createRuntime` builds the policy layer and passes the live gate and the proposal sink to the engine
    (`policy.attach(engine)` after start); new `createBridge()` in `src/server.ts` is the boot path `main` runs, so the
    runtime and the HTTP server share one policy layer. Every engine-backed tool uses `mcpOrigin(ctx, tool)` (chunk 3's
    placeholder `principalFor` is gone).
  - Visibility: `bridge_job_status`, `bridge_job_wait`, `bridge_job_cancel`, `bridge_result_page` and
    `bridge_errors_recent` show only the caller's own work; another principal's id answers like an unknown one.
    `bridge_journal_lookup` shows every principal's entries with principal, profile, approver and `mine`; job ids on
    your own entries only.
  - Uploads are not proposable: at `propose`, `lk_upload_image` and raw `createImageUpload` / `createImageAsset`
    are refused before anything is sent.
  - `UPLOAD_PUT_TIMEOUT_MS` (default 120000, 5000-600000, validated at start-up): the signed-URL PUT's own per-attempt
    deadline; `governor.execute` takes an optional `timeoutMs` (**interface addition** in `src/lk`).
  - `bridge_info` reports the caller's `profile`, `scope` and `canWriteAs`.
  - Hidden write tools stay callable so a direct call gets the read-only message; only `tools/list` is filtered.
  - Member admin is refused by the engine guard (`MEMBER_ADMIN_DISABLED`), not the gate, so agents see that code.
  - List summaries over 24,000 characters reduce items to id, name, type and parent: `listResources` at limit 100
    stays inline (it had become a stored handle). Measured default results: getDocumentBlocks on a 3,000-block page
    about 2,300 tokens, listResources at 100 about 3,900, search at 100 about 1,100 (`test/tools/result-size.test.ts`).
  - The proposal tools return compact JSON with the budget footer, like every tool; `proposal_captured` results
    carry the summary and point to `bridge_proposal_status`.
  - ADR renumbered: live policy evaluation is ADR 0012 (chunk 3's tool layer keeps 0011).

- `src/policy` ([docs/policy.md](policy.md), [ADR 0012](adr/0012-live-policy-evaluation.md)): profiles
  (`agent_profiles`: label, kind `claude` · `chatgpt` · `claude-code` · `other`, scope), scopes `read` · `propose` ·
  `write`, the default scope for new connections (`read`), and the audit log. Migration `0300_policy_init.sql` adds
  the tables and a `profile_id` on auth codes, grants and PATs; grants and PATs from before this chunk move to a
  `legacy` profile at `read`.
- The real `PolicyGate` (`LivePolicyGate`), evaluated live (≤ 1 s cache, cleared on any change): `read` denies writes
  with a clear message, `propose` turns writes into proposals, `write` allows; member admin refused unless
  `LK_ALLOW_MEMBER_ADMIN=true`; `system` allowed except on MCP origins; unknown, revoked or expired principals denied.
- The real `ProposalSink` (`ProposalService`): capture with validation, dry-run guards and governed reads of each
  target (version, fingerprint, pre-state); one proposal per request; compare-and-set states (`pending`, `approved`,
  `rejected`, `conflicted`, `expired`, `executing`, `executed`, `failed`); approval re-reads and detects conflicts,
  then submits a `batch_ops` job (stop on error) as the proposer with `approvedBy: 'owner'` and a single-use approval
  token bound to the proposal, so approval never loops and cannot be forged; restart reconciliation; expiry timer
  (`POLICY_PROPOSAL_EXPIRY_DAYS`, `POLICY_EXPIRY_SWEEP_SECONDS`); rejection with a reason.
- Owner command layer (`createPolicy().commands`, `actor: 'owner'`): profiles, scopes, default scope, connections
  (list, move, revoke), proposals (list, detail with diff data, approve, reject, bulk). Audited and evented; not
  reachable from MCP.
- Agent tools `bridge_proposal_status` and `bridge_proposals_mine` (read; own proposals only).
- Auth: the consent screen offers profile and scope (suggested from the redirect host; `read` preselected; the client
  name marked untrusted); grants and their tokens inherit the profile; `CallerIdentity.principalId`;
  `npm run pat -- create --profile <label> [--scope …]` and the profile in `list`.
- MCP: `McpToolProvider.access` (`read` | `write`), `ctx.principal` / `ctx.scope` in tool handlers, per-principal
  `tools/list`, call-time refusal of write tools for `read` connections; `buildServer({ policy })`.
- **Interface changes (src/jobs):** `JobOrigin.approval` (opaque), `ProposalCaptured.summary`, sink `JobsError`s are
  passed through, `policy` and `proposal` events on `JobEngineEvents`.
- Config: `src/config/policy.ts` (`loadPolicyConfig`).
- Tests: `test/policy/` (scope matrix over all 89 operations, live changes, capture without writes, exactly-once
  approval including double approval and crash/restart, conflicts, the unsupported-block guard at execution, partial
  failure, expiry, read-only and paused approval, forged approvals, tool lists per scope, consent, the `legacy`
  migration, PAT profiles, and an escalation test over every registered MCP tool). Chunk 4 tests updated for the
  consent fields and per-scope tool lists.

### Chunk 3: operation coverage, MCP tools, result shaping and image upload

- **Tools** (`src/mcp/tools/`, reference in `docs/tools.md`, ADR 0011): `lk_api_list_operations`, `lk_api_describe_operation`, `lk_api_read`, `lk_api_write`, `lk_api_batch`, `lk_api_paginate_all`, `lk_upload_image`, and `bridge_info`, `bridge_budget`, `bridge_estimate`, `bridge_job_status`, `bridge_job_wait`, `bridge_job_cancel`, `bridge_errors_recent`, `bridge_journal_lookup`, `bridge_result_page`; optional `lk_op_<operationId>` (89) with `MCP_EXPOSE_PER_OP_TOOLS=true`. Every tool has an `access` tag and annotations; reads are `readOnlyHint: true`, writes `false` (`lk_api_write` and `lk_api_batch` are `destructiveHint: true`).
- Result shaping: budget footer on every result; summaries by default and `detail: "full"`; results over `MCP_RESULT_MAX_CHARS` (40,000) become artefact handles paged by `bridge_result_page`; typed errors. The MCP server `instructions` carry the agent guidance.
- Image upload: new job kind `upload_image` (createImageUpload, signed-URL PUT, createImageAsset) with one custom step type; SSRF-guarded PUT and URL source; `UPLOAD_MAX_BYTES`, `UPLOAD_ALLOW_URL_SOURCE`, `UPLOAD_FETCH_TIMEOUT_MS`; crash recovery.
- Wiring: `src/runtime.ts` builds governor, LK client, engine (restart-resume before the endpoint opens) and tools; `src/server.ts` uses it, passes the MCP `instructions`, and drains the engine before closing HTTP and the database on SIGTERM.
- **Interface changes outside the tool layer** (flagged for review): `src/jobs`: `SubmitRequest` gains `UploadImageSubmit`; `createJobEngine({ customSteps })`; `engine.recordResult(...)`; `UPLOAD_PUT_STEP` and the custom step types are exported; `JobsRepo.setStepParams` and `stepResult`. `src/lk`: `defaultTransport` is exported (the platform fetch under the governor). `src/mcp/server.ts`: optional `access?: 'read' | 'write'` on `McpToolProvider`. `.env.example`: the new setting names.
- Tests (`test/tools/`): all 89 operations through `lk_api_read` / `lk_api_write` against a mock LK answering from the OpenAPI spec; the official MCP client end to end with a PAT; read/write refusals and engine guards; uploads (success, SSRF, size and type, backoff, crash and resume); tool counts with per-operation tools off and on. `npm run test:sandbox` has an opt-in smoke script (`test/sandbox/`), dry-run against the mock in `test/tools/sandbox-dryrun.test.ts`.

### Chunk 2 follow-up: principals, policy hooks and batch-create recovery

- Principals: `origin.principal` (`{ principalId, profile, label }`, default `SYSTEM_PRINCIPAL`) and optional
  `origin.approvedBy`. `principal_id` and `profile` are stored on jobs, errors and journal rows (`approved_by` on jobs
  and journal rows; migration `0200_jobs_init.sql` edited in place, as it was never deployed), shown in views, the
  `step` event and writer slots, and filterable in `listJobs`, `listErrors`, `listErrorGroups` and `journalLookup`.
- Policy hooks (no policy store or proposal workflow yet): an injectable `PolicyGate` (`allow` / `deny` / `propose`;
  default allows everything) asked about every operation, reads included, at entry of `run` and `submit`, before
  anything is queued. Batches are evaluated up front (any deny denies the batch; any propose makes one proposal).
  Deny throws `PolicyDeniedError` and records an error with classification `policy`; propose calls an injectable
  `ProposalSink` and returns `{ status: 'proposal_captured', proposalId }` (the default sink treats propose as deny).
  A gate that throws counts as a deny.
- **Interface change:** `engine.submit` is now async and may resolve with `proposal_captured`.
- `createManyResources` recovery: LK's batch create is not atomic, so after an ambiguous outcome every minted id is
  verified and only the missing items are re-submitted, with their same ids, as a new step inserted to run next. The
  step is `uncertain` only when verification cannot complete (it was: first and last item checked, partial =
  uncertain). A budget wait during verification now parks the step and keeps it ambiguous.
- ADR 0010: answers to the request-id and block-version questions from LK's spec (to be confirmed by chunk 3's sandbox
  script); batch recovery updated.
- Tests: `test/jobs/policy.test.ts`, `test/jobs/batch-recovery.test.ts` (including a batch half-created at a crash);
  the stateful LK model can fail a batch part-way.

### Chunk 2: persistence, job engine, writers, locks, journal and guards

- `src/jobs`: the job engine (`createJobEngine`). Every LK call runs as a persisted step through `lk.call` /
  `governor.execute` (one request per call, `jobId` passed for fair round-robin). Job kinds `single_op`, `batch_ops`
  (`stopOnError` or `continue`) and `paginate_all` (one governed call per page, items in a pageable artefact with
  item, page and size caps). Interface in `src/jobs/README.md`.
- `engine.run(op, params, { priority, origin })`: single reads inline (not recorded), single writes inline as one-step
  jobs; queued with `{ jobId, status: 'queued', eta }` when the estimate exceeds 20 s or writes are paused.
  `engine.wait(jobId, ms)` is bounded at 25 s.
- Idempotency keys `lkb.{jobId}.{stepNo}.{attempt0}`, reused across retries and restarts. Client ids (cuid2 shape) are
  minted for every create that accepts one and persisted before the first send.
- Restart-resume with verify-before-resend for each operation family; `governor.execute` `verify` hooks for 412,
  `DUPLICATE_ID` and `NOT_FOUND` after ambiguous retries. New step status `uncertain` (job ends `failed` with
  `uncertain: true`) when an outcome cannot be established without risking a duplicate (ADR 0010).
- `BudgetWaitError` parks a job in `waiting_budget` with a persisted resume time; resumes automatically, also after a
  restart. `waiting_lock` while a step waits for its lock.
- Writer pool (`WRITERS_MAX` 1–8, live and persisted), in-process FIFO locks per document, resource, parent, calendar
  and asset, with lock-before-slot ordering (no deadlock).
- Guards (PLAN §4): `If-Match` read immediately before versioned writes (caller versions honoured; 412 is a typed
  `VersionConflictError` with the current version, never retried); the unsupported-block guard on
  `replaceDocumentBlocks` / `replaceBlock` (nested included, `allowUnsupportedLoss: true` to override), sharing one read
  with the version and the journal pre-image; cascade confirmation; member-admin refusal; read-only mode with a
  persisted runtime override.
- Write journal with pre-images, `journalLookup(filter)` and `pruneJournal` (30 days or 2 GB). No rollback in v1.
- Controls: pause all writes (persisted), drain, cancel, pause and resume a job, retry a failed step.
- Errors table (every failed call with status, LK code, `errors[]`, `requestId`, retryable, classification), grouped by
  fingerprint with count, first and last seen and a resolved flag. Event emitter and query layer for chunk 5;
  `recordBudgetSample(snapshot)` for chunk 6's sampler.
- `src/config/jobs.ts` (`jobsSettingsFrom`, `defaultJobsSettings`), exported from the config index. Migration
  `0200_jobs_init.sql`: `jobs`, `steps`, `job_artifacts` (+ `job_artifact_items`), `errors`, `budget_samples`,
  `write_journal`, `runtime_settings`.
- Per-operation engine metadata for all 89 operations (`src/jobs/op-meta.ts`). The generated registry already carries
  `risk`, `concurrency` and `versioned` for every operation, so no registry overlay was needed.
- Test support outside `src/jobs`: chunk 1's mock LK takes an optional `respond` state model (`test/contract/mock-lk.ts`;
  default behaviour unchanged, and LK's rule that 400/401/403/404 and 5xx are not stored for idempotency replay is now
  applied); `vitest.config.ts` includes `test/jobs`.
- Tests: `test/jobs/` (crash-resume with no duplicates for creates, deletes, versioned and key-only writes; guards;
  locks and slots; controls; budget waits across restarts; job kinds; metadata for all 89 operations).
- ADR 0010 (verification families, the 23-hour window, `uncertain`, write holds, lock keys).

### Chunk 4 follow-up: ChatGPT support and review fixes

- ChatGPT is a supported client (OAuth only; ADR 0008). Redirect allowlist adds `https://chatgpt.com/connector_platform_oauth_redirect` and `https://chatgpt.com/connector/oauth/<id>`. `OAUTH_EXTRA_REDIRECT_URIS` adds exact URIs without a code change (validated at start-up; replaces the never-deployed `AUTH_EXTRA_REDIRECT_URIS`). Refused and registered redirect URIs are logged in full. `https://chatgpt.com` joins the default `/mcp` Origin allowlist.
- RFC 9207: `iss` is on every authorization response (success, denial and every error redirect) and equals the metadata `issuer`; tested for each kind.
- Scopes: `openid` and `email` are never advertised; requesting them is ignored at the authorization endpoint and now also on refresh (previously `invalid_scope`).
- DCR (and CIMD) client registrations are never expired or pruned; only explicit deletion removes them (was: unused DCR clients pruned after 24 hours).
- Tool seam: explicit `McpToolAnnotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`); `title` also sent as `annotations.title`; contradictory hints refused; `bridge_info` fully annotated as read-only.
- Refresh-token grace window (`AUTH_REFRESH_GRACE_SECONDS`, default 10; ADR 0009): a just-rotated token presented again within the window gets the same successor tokens; outside it reuse still revokes the grant.
- `TRUST_PROXY` (default `loopback`): `request.ip`, the login rate limit and the logs use the real client address from `X-Forwarded-For`; trusting every address is refused.
- Tests: `test/auth/chatgpt.test.ts` (ChatGPT-style DCR and CIMD flows, `iss` everywhere), `test/auth/grace.test.ts`, TRUST_PROXY and annotation tests, five-year client retention.
- `npm audit` triaged (`docs/dependency-audit.md`): one dev-only `minimatch` advisory via ESLint, unreachable, no non-breaking fix; production has none.
- Docs: ADRs 0008 and 0009 (ADR 0007 marked partly superseded), ChatGPT sections in `docs/auth.md` and `docs/auth-live-checklist.md`, PLAN amendments (7 November 2026).
- Rebased onto `main` after chunk 1.

### Chunk 4: MCP transport and OAuth 2.1 authorization server

- `/mcp`: Streamable HTTP through the MCP TypeScript SDK v2 (`createMcpHandler` + `toNodeHandler`), serving the 2025-era stateless protocol and the 2026-07-28 protocol. A bearer gate answers `401` with `WWW-Authenticate: Bearer resource_metadata="…"`, never redirects, validates `Origin`, and accepts OAuth access tokens or personal access tokens from the `Authorization` header only.
- Tool seam (`src/mcp/server.ts`): `McpToolProvider`, `registerTools(server, deps)`, and a stub `bridge_info` tool. Chunk 3 passes its tools to `buildServer({ tools })`.
- Authorization server (`src/auth`): RFC 9728 and RFC 8414 metadata (both paths each), Dynamic Client Registration, Client ID Metadata Documents fetched through an SSRF-hardened HTTPS client with HTTP-cache lifetimes, authorization with mandatory PKCE S256, RFC 8707 `resource` with canonical audiences, RFC 9207 `iss`, form-encoded token endpoint, rotating refresh tokens with reuse detection, `401 invalid_client` for unknown clients, RFC 7009 revocation.
- Owner login and consent: Argon2id password, optional TOTP, `__Host-` session cookie, CSRF tokens, `Origin` checks, login rate limits. The consent page shows the client, the scopes and the redirect host, with a warning for loopback-only clients.
- Personal access tokens (shown once, stored hashed) and `npm run pat`; `npm run setup:owner` prints the owner hash and optional TOTP secret.
- Auth audit events in the log, with no tokens, codes or passwords.
- `src/config/auth.ts`: zod-validated auth environment (`BRIDGE_PUBLIC_URL`, `OWNER_*`, `SESSION_SECRET`, `JWT_SIGNING_KEY`, optional `AUTH_*`).
- New shared infrastructure: `src/db/open.ts`, the migration runner `src/db/migrate.ts` (`npm run db:migrate`), migration `0100_auth_init.sql` (`auth_*` tables), and the composition root `src/server.ts` (`npm start`, `npm run dev`).
- Tests (`test/auth`, 200+ cases): a scripted OAuth client end to end, negative tests for every requirement, a real HTTPS CIMD server, and the official MCP SDK client's OAuth flow. The MCP Inspector CLI completed both PAT and OAuth flows.
- Docs: `docs/auth.md`, `docs/auth-live-checklist.md`, ADRs 0006 and 0007.

### Chunk 1: LegendKeeper client and Rate Governor

- `src/lk/governor`: the single gateway to LegendKeeper. Exact sliding-window counters for all eight counted tiers
  (write, key and project tiers plus `createManyResources` items), reactive-only upload tier, priority classes
  P0 to P3 with configurable reserve floors, FIFO per job with round-robin across jobs, write pacing (500 ms,
  stretching to 1.2 s past a projected 3,000 writes/hour), header capture on every response with snapping of
  the reported tier, 429 handling with Retry-After, refunds for requests LK never counted, and an in-flight cap.
- Retry matrix from PLAN §5.3 as a pure, tested function, including `verify` hooks for ambiguous retried writes
  and `BudgetWaitError { tier, retryAtMs }` for long waits.
- `BridgeLkError` with LK `code`, `requestId`, `errors[]`, `retryable`, `ambiguous` and a classification; the
  whole LK error catalogue is mapped by code.
- `createLkClient`: `@legendkeeper/sdk` 4.1 on the governed fetch (`maxRetries: 0`, `idempotencyKeys: false`),
  plus a registry-aware `call`. Guards: no LK request outside `execute`, one request per call, `If-Match`
  required on versioned writes.
- `governor.estimate(...)`, `formatBudgetFooter(...)`, `governor.snapshot()` and `sample` / `throttled` /
  `budget-wait` events. Injectable clock (`FakeClock` for tests).
- `idempotencyKeyFor(jobId, stepNo, attempt0)` and `costSpecFor(op, input)`.
- `src/config/lk.ts`: governor settings derived from the existing env config, plus code-level retry defaults.
- Tests: unit tests for every part above; a Fastify mock LK and contract tests (1,000-call workload at published
  and tight limits with an injected 429, a harness self-check, and fault injection through the real SDK).
- Interface documented in `src/lk/README.md`.

### Chunk 0: repository bootstrap and spec ingestion

- Scaffold: TypeScript strict ESM, ESLint (type-checked), Prettier, Vitest, `.nvmrc`, `.gitignore`, `.env.example` (names only).
- CI (`.github/workflows/ci.yml`): typecheck, lint, format, registry up-to-date, spec drift, tests, build.
- Vendored LegendKeeper OpenAPI spec (SDK 4.1.0) and `scripts/gen-registry.ts`, which generates the 89-operation registry.
- `scripts/check-spec-drift.ts`.
- Config loader (`src/config`) covering the PLAN defaults, with strict env parsing.
- ESLint guards for the governor-only rule (no raw `fetch`, no LK host literals outside `src/lk`).
- ADRs 0001 to 0005, including the MCP SDK pin (v2).

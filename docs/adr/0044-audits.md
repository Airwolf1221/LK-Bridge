# ADR 0044: Audits: findings only, read from the snapshots (v2 E2)

- Status: Accepted
- Date: 13 November 2026
- Session: v2 E2 (PLAN-v2 4.12 and phase E; the E2 row, with what C2b, C2c and C2d added to it)
- Builds on: ADR 0026 (registry, taxonomy, ordering), 0031 (keep regions; decision 12 on line breaks), 0035 and 0037 (the
  lifecycle and whole sets), 0038 and 0039 (`chronology-check`, "Propose a fix"), 0042 (the snapshot store E2 reads from)
- Migration: `2300_audits`

## Context

The old bridge audited the repository: rules chosen by Reference Type, name prefix and ancestry; a sidebar-structure
check against each rule's template; a tag-definition document; internal-reference checks. Findings only, never repairs.
v2 keeps that and adds the checks that follow from the type registry, the lifecycle, the keep regions and the
chronology. The owner's principle: **audits never change anything**, they **read the newest complete full snapshot plus
the change snapshots after it, never LegendKeeper**, and the only two things that may read LegendKeeper live are "Propose
a fix" (re-read, then an ordinary proposal) and an optional "Re-check this finding now". The nightly full snapshot
already reads every sidebar and document, so a full audit costs no API budget.

## Decisions

### Reading

1. **One reader, over the snapshot store only** (`src/audits/reader.ts`). It takes the newest complete full snapshot, lays
   every later change snapshot over it in time order (a change snapshot's page entry replaces the pieces it took, keeps
   the ones it did not; a page it records as deleted leaves the model and is remembered as deleted; a deleted document is
   dropped), and reads each page's pieces from the store. Each page remembers which snapshot supplied its newest piece,
   so **every finding records the snapshot it came from and its age** (`source.snapshotId`, `source.ageMs`). A piece the
   store cannot give is noted on its page, never fatal. An audit makes **0 requests** to LegendKeeper (tested: the mock's
   request log is unchanged by a run).
2. **Stale snapshots are flagged.** A full snapshot older than `maxSnapshotAgeHours` (default 36; the owner's setting)
   adds one `stale_snapshot` warning (category `audit`) and marks the run stale. There is no "newer" fallback: edits made
   in the LegendKeeper app are seen at the next full snapshot, which is why the owner sees the age beside every finding.
   With no complete full snapshot the run is **skipped** and commits nothing (the earlier findings stand).
3. **Extraction keeps only what the checks need** (`src/audits/model.ts`: facts, the sidebar's structure, references,
   per-block keep-region findings), never the blocks, so a model of 1,500 pages stays small. A paragraph's runs are hashed
   in key order (`runsHash`) because the store keeps keys sorted and a live read does not.
4. **The registry's own functions run on the snapshot.** `SnapshotTree` (`src/audits/snapshot-tree.ts`) is a read-only
   `RegistryTree` over the model, so `computeDrift` and `outOfOrderAmong` are the very code the dashboard's drift report and
   the ordering rule use, and agree with them on what a character index is and what order is right. Nothing is
   re-implemented.
5. **Templates are in the full snapshot now (an additive change to ADR 0042).** Template pages sit outside the AI
   REPOSITORY, so no snapshot held them and a template comparison would have needed a third live read. A full snapshot
   now also takes the project's templates (`listTemplates`, then each as a page: settings, sidebar, documents) into an
   optional manifest field `templates`, indexed with the other pieces (so retention, the collector, the verify job and the
   off-site copy treat them as they treat any piece: `manifestPieces` lists them). About 2.3 reads a template, once a
   night (a project with 14 templates: about 35 reads against 3,400 for the pages). A template read that fails does not
   fail the snapshot; the manifest then has none and the audit says so once (`templates_unavailable`) instead of
   guessing. Older manifests have none, so the first audit after the upgrade says the same until the next nightly snapshot.
   E1b copies manifests and objects as they are, so the Drive copy picks the templates up with no change.

### Running

6. **When.** After each nightly full snapshot completes (the snapshot service's `afterFull` hook, in the background), on
   demand from the dashboard, and from a maintenance job `audit-run` (the Maintenance page's Run now; a daily schedule at
   06:00 that is **off by default**, because the full snapshot already starts one). One run at a time per project. The two
   placeholder jobs `orphan-and-link-audit` and `tag-audit` are gone: this is what they were for.
7. **A run commits all or nothing.** A check that throws fails the run (state `failed`, the error kept) and commits no
   finding, so a bug can never mark the world "resolved".

### Findings

8. **Stored per run, tracked across runs** (`audit_findings`, `audit_runs`, `audit_acks`). A finding has a code, category,
   severity (error, warning, info), page (id, name, path), optional document and block, a message, **evidence** (what was
   expected and what was found), its source, and a fix where one exists. Its identity is a fingerprint of (code, page,
   document, block, the check's own key); a run that sees it again keeps its `first_seen` (**still present**), one that does
   not marks it **gone** with the time and run, and one that sees a gone finding again reopens it as **new**. The run
   records its counts (by category and severity; new, still, gone, acknowledged), its duration, the snapshot it read and that
   snapshot's age, and how many change snapshots it laid over it. Gone findings are kept 90 days.
9. **Acknowledging.** The owner acknowledges a finding with a reason (required). It is tied to the fingerprint and a hash of the
   evidence: while the same evidence persists the finding is hidden from the default view (and counted apart in the
   summary); if the evidence changes it reappears, marked "evidence changed". The acknowledgement survives the finding going
   and coming back with the same evidence. Nothing is pre-acknowledged: the owner decides about the two wrongly seeded
   taxonomy entries, Kamigawa Miyuki and the rest. Audited (`audits.acknowledge`, `audits.unacknowledge`).
10. **No agent tool runs or edits an audit.** MCP has one read tool, `audit_findings` (filters, paging, `detail: full` for the
    evidence; free). Agents act on findings through the ordinary tools, which go to proposals as usual.

### The checks

11. **Rules and templates** (`checks/rules.ts`). A rule selects pages by `referenceType` (the one unambiguous Reference Type
    row: a page with the row twice matches no `referenceType` rule), `namePrefix`, `ancestorName` (a unique ancestor by
    name along the parent chain), and, new, `registryType` with an optional `role` (`core`, `compact`, `index`) and `kind`;
    all given selectors must match. A rule's template is a **registry role**, a template **id** or a template **name** (the
    word "Template" ignored, as the registry does). The old codes keep their meanings: `no_matching_rule`,
    `ambiguous_owner_rule`, `incomplete_owner_ancestry`, `property_kind_mismatch`, `property_order_mismatch`,
    `property_presentation_mismatch`, `property_row_order_mismatch`, `document_type_mismatch`, `document_order_mismatch`,
    `missing_required_tags`, `tags_outside_definition`, `duplicate_tags`, `missing_target`, `inaccessible_target`,
    `deleted_target`. New: `ambiguous_ancestor`, `ambiguous_template`, `template_not_found`, `rule_selector_unknown`,
    and, because the old list had no code for a template item the page lacks, `property_missing`, `property_row_missing`
    (info) and `document_missing`. A page with exactly one rule is compared with its template for property titles, kinds,
    relative order, visibility and the title and display flags; key-value row keys and their order; document tab names, types
    and relative order (a blank template tab may become a populated page). **Never values. Extra owner fields and tabs are
    not errors.** Overlapping rules, duplicate names and unmatched pages are findings, never guesses.
12. **Rules are a per-project list on the dashboard** (`audit_config`): edited there, audited (`audits.set_config`, with the
    old and new values) and **needing re-authentication** within five minutes, as the canon rules do (ADR 0036 decision 4).
    Until the owner saves a list, the rules are the **seeded defaults, worked out from the registry at each run** (Character
    Core, Compact Character Reference, the Index template), so they follow the registry. The **tag-definition source** (a page
    and one of its documents) is chosen on the dashboard too.
13. **Tag rules.** The source document holds exactly one `json` code block `{ "schema": 1, "rules": [ { "id",
"required_tags", "allowed_tags"? } ] }`, a rule's id being an audit rule's id. A missing required tag is a finding with an
    **additive fix** (`update_resource`, the tag added, no tag removed); a tag outside `allowed_tags` (required tags count
    as allowed) has **no removal proposal**; duplicate tags are a finding. Unknown fields, repeated rule ids, a missing, a
    repeated or a malformed block are **a clear error**: the old bridge stopped its whole run on them, but here a run is
    findings only, so the error is one `tag_definition_invalid` finding (error severity, on the source page and document)
    and the tag rules are skipped while every other check runs. A tag rule naming no audit rule is `tag_rule_unknown`.
14. **References** (`checks/references.ts`). Every mention and collection item (sidebar and page documents) pointing at a page
    or document that is not there: `missing_target`, `deleted_target`, `inaccessible_target`, kept distinct **from what the
    bridge knows, because a page's absence is no proof of deletion (nor is a 404)**: _deleted_ needs a record (a change
    snapshot recorded it; the tree's own pass found it deleted; the snapshots' newest word on the page is its deletion);
    _inaccessible_ is a template (outside the repository), a page the snapshots once held that is gone with no deletion on
    record, or a page the tree could not find on a re-read (a 404); _missing_ is an id nothing has ever seen, or a document
    the existing target does not have. New: `canon_refers_to_archived` (warning): an Authoritative `[BSRC]` page that links
    to a `[BARC]` page, once per target (the archive tool flags related pages at the time; this catches them later).
15. **Unclassified pages** (`unclassified_page`): no recognised prefix.
16. **Ordering** (`out_of_order`): the children of an index that are not in the registry's alphabetical order (`[INDEX]`
    first, then pages, then unclassified; a case-insensitive, numeric-aware compare), the fewest pages that would have to
    move, each with the sibling it belongs after. **Reported, never moved.** Every index counts as using alphabetical
    placement unless the owner lists it as manual (a setting). The fix is `move_resource` under the same parent.
17. **Taxonomy drift** (`checks/taxonomy.ts`): the registry's drift walk on the snapshot (an index with no entry; an entry
    whose index is gone, renamed or moved; an entry whose parent disagrees with the tree; a type root that left the
    repository), plus pages whose race is not in the taxonomy (`race_not_in_taxonomy`), a page under another race's index than
    its race row names, a subrace being consistent (`race_index_mismatch`, info), entries whose index holds no pages, and
    entries still waiting for the owner's review (`taxonomy_entry_unreviewed`: a guessed singular nobody checked). Never
    fixed. The two entries A3 seeded wrongly are the owner's to name; the audit finds whichever way they are wrong: a wrong
    singular shows as `race_not_in_taxonomy` on the pages that use the right one and as an unreviewed entry; a wrong parent
    as `taxonomy_parent_mismatch`.
18. **Fact consistency**: `unknown_reference_type`, `subject_mismatch`, `canonical_name_mismatch`. A Reference Type is
    **known** if the registry (a character type's Core and Compact values), a template's name stands for it (`[BSRC] AI
Character Art Template` is `Character Art`: the snapshot's templates and the registry's last read), an audit rule names
    it, or the owner lists it. By default only a value that **resembles** a known one is flagged (`Character Reference`,
    `Historical Character Reference`), so the repository's other types do not drown the list; "strict" flags every value
    nobody knows. A character page is recognised by its Reference Type or, when that is wrong, by its name's own pattern
    (`{name} - Character Core`). **"Propose a fix" uses `set_facts` only when the right value is unambiguous**: a Reference
    Type that is a registry value in other letters, or whose page-name pattern names exactly one role (Kamigawa Miyuki:
    `Character Reference` on `... - Character Reference` is `Compact Character Reference`); a Subject that differs from the
    name only in punctuation. Mehrana al-Khalid, Founder: the Reference Type has a fix (`Character Core`), the Subject
    (`Mehrana al-Khalid` against the name's `Mehrana al-Khalid, Founder`) is reported with no fix, because the name or the
    Subject may be the wrong one.
19. **Lifecycle consistency** (`checks/lifecycle.ts`), exactly as PLAN-v2's E2 row states, C2d's set exception included:
    prefix, Status, status tag and place agree (`[BSRC]` / Authoritative / `CANON` / outside both areas; `[BWRK]` / Working /
    `Working` / directly under `[INDEX] Working`; `[BARC]` / Archived / `Archived` / directly under `[INDEX] Archived`);
    under an archived (Working) set's index every content page is `[BARC]` (`[BWRK]`); a set's indexes carry the set's status
    tag and no Status. `lifecycle_inconsistent` and `lifecycle_set_inconsistent` (errors, naming each disagreeing signal);
    an incomplete lifecycle record or set record is `lifecycle_record_incomplete` / `lifecycle_set_incomplete` with the set's
    pages. **Never fixed by an audit**: the lifecycle tools refuse an inconsistent page (`LIFECYCLE_INCONSISTENT`) and the
    owner decides. With the two indexes not confirmed, places cannot be checked and the audit says so once.
20. **Keep-region health** (`checks/lifecycle.ts`): `line_break_paragraph` (a paragraph with a line break, or another
    character Markdown cannot carry, inside a text run: the 32 of ADR 0031 decision 12), `inline_icon_page` (a page holding
    inline icons, which `write_page` cannot write back), `unsupported_blocks` (counted per page; the sidebar's own `TAGS`
    property is not counted, every page has one), `collection_blocks` (collections in page documents).
21. **Chronology** (`checks/lifecycle.ts`): D1's `chronology-check` findings, folded in from its **last stored run** (the check
    is a separate job on its own schedule; the audit reads nothing), each kind its own code (`chronology_row_without_event`,
    `chronology_date_mismatch`, …), source `chronology-check` with the check's id and time. Nothing is re-implemented. The
    two kinds D1.1 can repair keep their "Propose a fix", which is the chronology module's own (`sync_timeline_event`).

### The two live reads

22. **"Propose a fix"** (`src/audits/fixes.ts`). Never applied by an audit. It **re-reads its target live** at P1, refuses a
    finding that is out of date (`FIX_STALE`, with what is there now; nothing is proposed), builds the job from the same
    machinery as the existing tool, and submits it as **ONE proposal whatever the caller's scope** (`forceProposal`, the
    system principal from the dashboard, as D1.1's and E1a's), so the policy gate and every engine guard (canon, lifecycle,
    status tags, decision 5) still run: a tag fix naming a status tag is `POLICY_DENIED` at capture. The owner approves it on
    the Proposals page. Four fixes, each exact or absent:
    - `move_resource`: `moveResource` under the **same parent**, the neighbour taken from the live siblings by the registry's
      own `slotAmong`; inside the lock the parent's children and the page must still be as read (`bridge.expect`); verified
      afterwards.
    - `set_facts`: one existing row, through `planFacts` and `expandFacts` (the tool's own plan and expansion: chained
      If-Match, the in-lock check, the verify read), the row compared with what the finding saw.
    - `add_tags`: `updateResource` with the tags the page has now plus the missing ones; its tags must still be as read.
    - `split_paragraph`: **block by block**: `insertBlock` for the new parts (client-minted ids, fixed at proposal time),
      each `after` the one before, **then** `replaceBlock` cutting the original (its own id kept) to its first part, so a
      refused write loses nothing (a refused insert leaves the paragraph as it was; a failure after the inserts leaves the
      text twice, never less); **never the whole page, so it
      works beside inline icons** (tested: the icon paragraph and an `unsupported` block come back byte for byte). Marks and
      mentions stay in their parts; empty parts (a blank line) are dropped. **The compare-and-swap is inside the lock**: a
      registered document checker (`audits.paragraph`) requires the block to hold exactly the runs the finding saw, else the
      job stops before any write (the proposal ends `conflicted` or `failed`; nothing is written); a verify step
      (`audits.paragraph.verify`) reads the paragraphs back. The writes are `judgedInLock`, so other edits to the page do not
      make the proposal conflict. A paragraph that holds an inline icon itself, or a character other than line breaks, gets no
      fix.
23. **"Re-check this finding now"** reads the finding's page live (its settings, sidebar and page documents: 1 + N reads; for
    an ordering finding also the parent's children), swaps it into the snapshot's model and runs the owning check again. The
    finding is then still present (its evidence refreshed, its source `live`) or gone. Only page-local findings can be
    re-checked; the rest (taxonomy, the chronology, anything about more than one page) say so. A finding found gone by a
    re-check comes back as new at the next run if the snapshot still shows it, until the next full snapshot has the change.
    Both are audited (`audits.propose_fix`, `audits.recheck`).

## Consequences

- A full audit makes no request; on Arkona it reads about 6,000 small (an estimate: a page, its sidebar and about two documents)
  files from the store.
- A full snapshot costs about 35 reads more a night for the templates; the Snapshots page's cost figures include them.
- Template comparison is only as fresh as the last full snapshot (it was always going to be: templates change rarely).
- `no_matching_rule` is an info finding per page and Arkona has about 1,000 pages the three default rules do not cover; the
  owner extends the rules, or switches it off with "Report pages no rule matches". It is the old bridge's behaviour.
- The document order of a page's tabs is the order the snapshot lists them (LegendKeeper's order in `getResource`), not read
  from each document's own rank.

## To verify on the test world (the owner's live checks; the sandbox test `audits` is written, not run)

- `insertBlock` with `after` a block **inside** a container (a table cell, a list item): the fix is offered for any
  paragraph; the verify step would catch a refusal, but it has only been tried at the top level.
- `replaceBlock` with the block's own `id` in the body keeps the id and answers a version the next write accepts as If-Match.
- A text run holding `\n` can be read back from a block LegendKeeper stored (the 32 paragraphs show it does).
- `listTemplates` and `getResource` on each template in a real full snapshot (the template read).

## Note (15 November 2026, E5.3): Arkona's first audit; "resembles", and race values by their anchor

Arkona's first audit (1,609 findings) showed decisions 17 and 18 needed a tighter and a looser reading, decided in
[ADR 0046](0046-e4-owner-decisions.md) decision 12 and documented in [docs/audits.md](../audits.md):

- **Decision 18, "resembles".** With strict mode off, an unknown Reference Type is flagged only when (a) it is a registry
  value in other letters, (b) the page's name carries a registry page-name pattern, or (c) its distinctive words (the
  generic `reference`, `references`, `the`, `and`, `of`, `a`, `an` removed: `GENERIC_REFERENCE_TYPE_WORDS`) are a
  non-empty subset of one registry value's. Sharing one word of three letters, the old reading, made every "… Reference"
  value resemble "Compact Character Reference" (588 of Arkona's 589 Facts warnings). The examples of decision 18 still
  hold: `Character Reference` by (c), `Historical Character Reference` on a `… - Character Core` page by (b). Strict
  mode, the known values and when a fix is offered are unchanged.
- **Decision 17, `race_not_in_taxonomy`.** A qualified value is read by its anchor when the whole value matches no entry:
  the text before the first `(`, `;` or `-`, trimmed (a hyphenated name is tried whole as well). The page is never
  rewritten and no word is guessed; a finding names the anchor it tried (`evidence.anchor`) so the owner can add an
  alias. A match by anchor is checked for placement (`race_index_mismatch`) as a full match is.

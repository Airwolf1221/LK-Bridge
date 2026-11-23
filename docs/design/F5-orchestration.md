# LK-Bridge F5: bulk actions, audit automation and orchestration (design, for the owner's approval)

**Status:** APPROVED by the owner as written (23 Nov 2026), H1 to H12.

**Sources:**
- the owner's notes of 23 Nov 2026: bulk rejection, bulk tagging, automatic audit actions, exceptions that aren't exceptions, and the errors tagged "bridge";
- ChatGPT's report after several days at write scope, ranking five improvements;
- the owner's assistant's checks on live Arkona the same night.

**ChatGPT's central point, which this design adopts:** the next gain is orchestration, not new capability. Each tool should do more coordinated work per approved operation, without weakening any safeguard. ChatGPT explicitly asked that the approval boundaries stay as they are.

## What the live checks showed (23 Nov 2026)

- **Tagging audit:** 1,471 pages. 1,058 compliant, 0 corrections, 10 holds, 7 exceptions. The holds were down from 212.
- **The 7 exceptions** come from three tags outside the grammar: **Cosmology** (3 pages), **Setting Framework** (2) and **Chronology** (2).
  - **An exception blocks the whole page.** The owner's classifications of 22 Nov, for example `Event` on Universal Chronology, can't be applied while the page also carries one of these tags.
  - The owner has ruled the three tags **allowed everywhere**. That ruling is now recorded in the Tagging Standard, in a new section, **"Approved Supplementary Tags"**. The bridge doesn't read it yet.
- **The three errors tagged "bridge":**
  - **21 Nov 23:26, `listEvents`, ChatGPT, an inline read:** `ABORTED`, "aborted by the caller". ChatGPT cancelled the call. **Harmless.**
  - **19 Nov 01:09, `listProperties`, system, an inline read:** a timeout during the memory-pressure period. **Harmless.**
  - **19 Nov 00:02, `replaceDocumentBlocks` (ChatGPT's `write_page` on *Rashad al-Khalid & Mehrana II al-Khalid - Relationship*, section "Rashad's Freely Chosen Immortality"):** "terminated" mid-request. The journal (entry 3897) still records the outcome as **unknown four days later**.
    - The error card says "refused before it was sent". That's wrong: it was sent. It also says `ambiguous: false`, also wrong.
    - **No harm resulted:** ChatGPT rewrote the page twice on 22 Nov.
    - But an unknown outcome on a destructive write must never sit unreconciled.

## Part A: the owner's own requests

**H1. The tagging audit reads "Approved Supplementary Tags".**
- Pin the section in the pack.
- A listed tag is **permitted wherever it appears**. It's kept after the grammar's slots, never added by inference, and never proposed for removal.
- A page whose only exception is such a tag becomes an ordinary **correction**. The seven pages then receive the owner's classifications.

**H2. Two owner actions on an exception:**
- **"Keep this tag here":** a ruling for one page, tied to that page's current tag array. If the tags change, the ruling lapses and the audit asks again.
- **"Allow this tag everywhere":** the bridge adds the tag to "Approved Supplementary Tags" in the Tagging Standard, as an owner action needing the step-up. The pack then asks for the new version to be approved, as usual.
- Agents can suggest either action; only the owner can take them.

**H3. Retag apply always includes ordering** (ChatGPT's Zahira al-Rachid example). Any page being corrected comes out in grammar order in the same item, so a separate "move Genie before Khayali" proposal is never needed again.

**H4. Bulk actions on the dashboard:**
- **Proposals:** filters (state, tool, principal, age), select all, **"Reject all conflicted"** and **"Reject selected"**.
  - Rejecting is a brake: one confirmation, no step-up.
  - **"Approve selected"** needs the step-up if any selected proposal triggers a rail.
- **Tagging:** **"Apply all corrections"**: one action that makes the usual bounded batches (25 pages each, as items) and lets the owner approve them together.

**H5. Automatic actions for audits, switched on one finding code at a time.**
- **Repository Automation** already provides for this: "A separately approved narrow automation action must identify exact scope, prerequisites, transformations, verification, concurrency rules and stop conditions". The block-id sweep is the first approved narrow automation.
- **Three settings per code, changed only by the owner (step-up):**
  - **Off** (the default);
  - **Propose automatically:** after the nightly audit, the bridge makes the proposal and the owner approves it;
  - **Apply automatically:** the bridge writes it; it appears on the Review page and can be Reverted.
- **Recorded in governance:** turning a code on writes its paragraph to Repository Automation's "Approved Narrow Automations" (scope, transformation, verification, stop conditions, date). Turning it off records that too. The governance therefore always says what is running.
- **Codes that can qualify:** mechanical fixes only, where the fix is fully determined:
  - tag corrections and order, including lifecycle-tag-first;
  - sibling order;
  - em dashes;
  - decorative blank paragraphs;
  - a file extension in an asset name;
  - narrative numbering, links, datelines and tags.
- **Never automatic:** canon and lifecycle changes, holds, exceptions, anything marked `judgement`, "Pick the right value", deletions, splits and renames.
- **Safety:**
  - each automatic run has a cap per code per night (pack data);
  - it **stops at the first failed verification** and turns that code off, with the reason;
  - one dashboard switch pauses all automation;
  - every automatic write is journalled under a dedicated system principal ("Automation");
  - each morning's Overview shows what automation did overnight.

## Part B: ChatGPT's five

**H6. `arkona_identity_reconcile` (ChatGPT's first priority): bulk identity facts with tags.**
- **Input:** a list of `{ character, facts: { "Naming Culture": …, "Race / Species": …, … } }`, plus `reconcileTags` (default true) and `dryRun`.
- **For each character:** resolve the identity page (Core or Compact Reference), fresh-read it, set only the facts given, compute the tag array from the **current policy** (the retag engine, H3's ordering included), then verify both independently.
- **One job with one item per character,** so a failure is isolated to its item and the rest carry on. It's resumable. The result is itemised: done and verified, skipped (and why), or failed (and why).
- **Naming Culture and Race** values must map through the pack's token maps; an unmapped value is refused for that item only.
- **`arkona_name_check`'s culture part** runs for each Naming Culture change.
- **The rails apply as usual:** more than 10 pages is a proposal with items, so the owner can approve some and leave the rest.

**H7. `query_facts` (ChatGPT's third): field-selective batch reading.**
- **Select pages** by `type` (Reference Type), `tag`, `under`, lifecycle or kind.
- **Return only the named fields** (sidebar facts, tags, parent, Canonical Display Name, ids) as a **compact table**, paged by row.
- **Cost:** free from the tree and the stored sidebars, with their age shown; `live: true` re-reads them, within the usual limit.
- **Example:** "all Main CANON Character Cores: Canonical Display Name, Race / Species, Naming Culture, Life State, Temporal Scope, tags, parent".

**H8. `arkona_workstream_report` (ChatGPT's fifth).**
- **Scope:** a **workstream label** (a new optional `workstream` argument that every write tool accepts and the journal records), a time window or a principal.
- **One report:**
  - every page changed, with its versions;
  - what was verified;
  - pending and conflicted proposals;
  - items skipped or excluded;
  - **writes with an unknown outcome**;
  - audit findings still open on the pages touched.
- It's read-only and free.

**H9. `arkona_geography_evidence` (ChatGPT's fourth): an evidence finder only.**
- For a character, or a set of them, it lists **sentences** that state a birthplace, an upbringing, a residence, an office held in a place, or a political association. Each item gives its class, the current owner and section it comes from, and the place resolved against the geographical hierarchy where it matches a page.
- **It never infers a place** from a surname, office, culture or residence, and never writes. "Unresolved" is a legitimate answer.
- **Built last, and separately,** because it's the most interpretive. The phrasings are pack data, read by the governing name (F4b.1's rule).

## Part C: the bridge's errors

**H10. Unknown write outcomes are always reconciled.**
- When a write's outcome is unknown, the bridge **reads the target back** (with retries over a few minutes) and settles it:
  - **applied:** the version moved and the content matches what was sent;
  - **not applied:** the version is unchanged;
  - **still unknown:** neither. Anything still unknown after that becomes an **owner-visible finding**, with the pre-image and the intended change.
- **The existing entry 3897:** reconcile it as **"superseded"**, since later applied writes to the same document exist.
- **Error cards:**
  - "refused before it was sent" only when the request was truly never sent;
  - `ambiguous: true` for any write whose connection broke after sending.

**H11. Aborts by the caller aren't bridge errors.**
- A call the client cancelled (`ABORTED`) is recorded as **"cancelled by the caller"**, not a bridge error, and isn't counted in the error totals.
- **A read that times out is retried once** before it's reported.

## Part D: sequencing

**H12. Sessions:**

| Session | Contents | Notes |
|---|---|---|
| **F5a** | H1, H2, H3, H4, H10, H11 | The owner's requests and the error fixes. Small, and unblocks the seven pages |
| **F5b** | H5 | The automation framework. Its own session, since it touches governance and unattended writes |
| **F5c** | H6, H7, H8 | Orchestration |
| **F5d** | H9 | Geography evidence |
| **R5** | Review | After F5c, or after F5d if it follows straight on |

## Questions for you

Say "approved as written", or change any of H1 to H12. In particular:
- **H5:** the three settings, recording each switch in Repository Automation, and the list of codes that can qualify.
- **H2:** "Allow this tag everywhere" lets the bridge edit the Tagging Standard on your behalf, as your own action with the step-up.
- **H9:** build geography evidence now, or later.

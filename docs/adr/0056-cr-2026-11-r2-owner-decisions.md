# ADR 0056: Owner decisions from the second review (CR-2026-11-R2)

Status: **Proposed** (CR-2026-11-R2, 17 November 2026). Where a fix needed one of these decisions, the safe option is
implemented and marked "implemented"; the owner confirms it or chooses another. The findings are in
[docs/reviews/CR-2026-11-R2.md](../reviews/CR-2026-11-R2.md).

## Context

The owner moved Claude and ChatGPT to scope `write` on Arkona on 17 November 2026. The second independent review
checked everything merged since the first one (`08feec9`, 11 November) with that in mind. Most fixes only make an
existing rule hold on every route and need no decision. These go one step further than a rule as written, or leave a
choice that belongs to the owner.

## Decisions for the owner

1. **Re-authentication for every change that lets an agent's connection do more (implemented, R2-50).** ADR 0055
   decision C5 asks for the owner's re-authentication before a safety rail is switched off, because "a rail switched off
   lets more go straight through"; raising a profile from `propose` to `write` needed only the session. Implemented, as
   ADR 0028 decision 7 (within the last 5 minutes): raising a profile's scope, raising the default scope, moving a
   connection to a profile with a higher scope or to one at scope `write` (its rails may be weaker), and a personal
   access token for a profile at scope `write`. Lowering a scope, moving a connection down and a token for a lower scope
   stay one click (they are how the owner stops an agent quickly). Alternatives: (a) as implemented; (b) only the scope
   raises, not connection moves or tokens; (c) every change on Clients & Access, lowering included (not recommended: it
   slows the owner down exactly when stopping an agent).
2. **An event "without a row" beside a row whose date cannot be read (the safe half implemented, R2-49).** ADR 0048
   decision 7 refuses to delete an event an unpaired row could own: the same date, the same start, or its name. A row
   whose Date cell cannot be read has no date, so only its name can match, and the timeline's short name differs from
   the table's description by design: the event the owner made for such a row, under a short name, is offered for
   deletion. Implemented: the proposal and the tool's dry run list every unpaired row of the age whose date cannot be
   read, with a note to check them first or mark them table-only (no change to what is deleted). Options: (a) as
   implemented (the owner judges, with the rows in front of them); (b) refuse the delete (`PAIRING_AMBIGUOUS`) while any
   unpaired row of the age with an unreadable date is not marked table-only: the safest, at the price of marking such
   rows table-only once before any orphan of that age can go; (c) as (b), but only rows whose KCY cell reads as the
   event's year block it. Recommended: (b) or (c).
3. **A chronology link an agent chooses is a proposal at every scope (implemented, R2-08).** `sync_timeline_event` with
   `event_id` on an event that already agrees records "this row is that event" (ADR 0048 F2.1): no LegendKeeper write,
   but it decides what the check pairs, repairs and offers to delete from then on. At scope `propose` it was a proposal
   for that reason; at scope `write` it ran directly, and its job holds only the bridge's own steps, which the Review page
   (ADR 0055 decision A) never lists, so the owner never saw it and Revert could not offer to undo it. Implemented: a link
   is a proposal at every scope (the dashboard's "Pair with this row" already was). Alternative: (b) direct at scope
   `write` but listed on the Review page (a row in `direct_writes` for a job that recorded a link, its diff naming the
   row and the event), with Revert removing the link.
4. **Removals through the low-level tools are neither proposed nor revertible (open, R2-52).** ADR 0055 decision C1
   counts a block delete, a row delete and a collection's items as edits, not deletes, and its table lists raw row writes
   and block deletes as not revertible. Together: an agent at scope `write` can delete a whole chronology table (one
   `deleteBlock`) or empty a curated link collection (`updateProperty` with `items: []`) directly, and Revert can only
   say so; the journal keeps the pre-images to put back by hand. The high-level tools are unaffected (`write_page`,
   `set_facts` and the chronology tools are revertible). Options: (a) as now; (b) a rail "removals through the low-level
   tools" (on by default): a `deleteBlock`, `deletePropertyRow`, `deleteBlockRow` or `deleteBlockPropertyRow`, or an
   `updateProperty` that drops items, sent through `lk_api_write`, `lk_api_batch` or `lk_op_*`, becomes a proposal;
   (c) Revert puts them back from the journal (block deletes by their pre-image and the neighbour they followed;
   collection items by id). Recommended: (b) now, (c) later.
5. **Renaming an Authoritative page that keeps its `[BSRC]` prefix runs directly (not changed).** ADR 0055's table lets
   `update_resource` rename any page at scope `write` (the renames-and-moves rail is off by default), and Revert puts a
   name back. Removing the `[BSRC]` prefix is now a canonical proposal (R2-12); a rename that keeps it (`[BSRC] Old
Harbour` to `[BSRC] Old Port`) is still direct. The review's brief counted "renaming canon" as something that should
   need a proposal. Options: (a) as now; (b) any rename or move of an Authoritative page is a canonical proposal; (c)
   switch the renames-and-moves rail on by default for every profile. Recommended: (b).
6. **The rails are asked at entry only (not changed; ADR 0055 decision C3).** Switching a rail on does not stop a direct
   job already queued (WS-G3); lowering the profile's scope does (the job is asked again before each step). Options: (a)
   as now, with the dashboard saying that lowering the scope is the emergency brake; (b) ask the rails again before a
   queued direct job's first write, and stop it (the agent then proposes it). Recommended: (a).
7. **`file.download_url` is fetched when URL sources are switched off (open, R2-45).** ADR 0049 decision 11 keeps
   ChatGPT's file path (`file` with a `download_url`) working whatever `UPLOAD_ALLOW_URL_SOURCE` says, but `.env.example`
   promises "no fetching of image URLs" and `docs/tools.md` "base64 only"; any connection can make the bridge GET any
   public https URL on port 443 through `file` (every address and redirect guard still applies). Options: (a) the switch
   covers `file` too (ChatGPT's files then need it on); (b) `file` gets a switch of its own; (c) `file` only from
   ChatGPT's file hosts (an allowlist). Recommended: (c), or (a) where ChatGPT is not used. The docs now say what the
   switch covers.
8. **A folder named after a character captures that character's images (open, by design, R2-46).** ADR 0041's rule 1
   reuses a folder named after the character wherever it is, so a folder another agent makes first (`Junk / Asagiri
Miyabi`) receives every later image for her. Options: (a) as now (the Staging page and the Review page show where each
   image went); (b) prefer the Characters path, and reuse a same-named folder elsewhere only when the bridge made it, or
   recorded it, for that character.

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

1. **Re-authentication for every change that lets an agent's connection do more (implemented, R2-07).** ADR 0055
   decision C5 asks for the owner's re-authentication before a safety rail is switched off, because "a rail switched off
   lets more go straight through"; raising a profile from `propose` to `write` needed only the session. Implemented, as
   ADR 0028 decision 7 (within the last 5 minutes): raising a profile's scope, raising the default scope, moving a
   connection to a profile with a higher scope or to one at scope `write` (its rails may be weaker), and a personal
   access token for a profile at scope `write`. Lowering a scope, moving a connection down and a token for a lower scope
   stay one click (they are how the owner stops an agent quickly). Alternatives: (a) as implemented; (b) only the scope
   raises, not connection moves or tokens; (c) every change on Clients & Access, lowering included (not recommended: it
   slows the owner down exactly when stopping an agent).
2. **An event "without a row" beside a row whose date cannot be read (the safe half implemented, R2-09).** ADR 0048
   decision 7 refuses to delete an event an unpaired row could own: the same date, the same start, or its name. A row
   whose Date cell cannot be read has no date, so only its name can match, and the timeline's short name differs from
   the table's description by design: the event the owner made for such a row, under a short name, is offered for
   deletion. Implemented: the proposal and the tool's dry run list every unpaired row of the age whose date cannot be
   read, with a note to check them first or mark them table-only (no change to what is deleted). Options: (a) as
   implemented (the owner judges, with the rows in front of them); (b) refuse the delete (`PAIRING_AMBIGUOUS`) while any
   unpaired row of the age with an unreadable date is not marked table-only: the safest, at the price of marking such
   rows table-only once before any orphan of that age can go (Arkona has many qualified rows, most of them readable);
   (c) as (b), but only rows whose KCY cell reads as the event's year block it. Recommended: (b) or (c).
3. **A chronology link an agent chooses is a proposal at every scope (implemented, R2-11).** `sync_timeline_event` with
   `event_id` on an event that already agrees records "this row is that event" (ADR 0048 F2.1): no LegendKeeper write,
   but it decides what the check pairs, repairs and offers to delete from then on. At scope `propose` it was a proposal
   for that reason; at scope `write` it ran directly, and its job holds only the bridge's own steps, which the Review page
   (ADR 0055 decision A) never lists, so the owner never saw it and Revert could not offer to undo it. Implemented: a link
   is a proposal at every scope (the dashboard's "Pair with this row" already was). Alternative: (b) direct at scope
   `write` but listed on the Review page (a row in `direct_writes` for a job that recorded a link, its diff naming the
   row and the event), with Revert removing the link.

# ADR 0016: Maintenance scheduler and mappings: interpretation choices

Status: Accepted (chunk 6, 8 November 2026). No decision in PLAN.md is changed. The choices below fill gaps the plan and the
chunk 6 brief left open; each is flagged so it can be overturned.

## Context

PLAN §8 pages 6 and 7 and the chunk 6 brief specify the maintenance registry, a scheduler that runs everything at P3 as the
`system` principal, and a mappings data model. Several details needed a decision.

## Decisions

1. **`journal-prune` is implemented in this chunk**, not a placeholder as PLAN §8 page 6 lists it. The brief asks for it.
   The placeholders are the other four.
2. **A maintenance run is recorded as an engine job only when it matters, for the two high-frequency jobs.**
   `budget-sampler` (every 10 s) would add 8,640 job rows a day and bury the Jobs page. It, and `proposal-expiry`
   (288 a day), record a job only when the run fails or changes something; `journal-prune` and `sqlite-optimise` always
   do. Every run is in the run history regardless. `engine.recordResult` gained an optional `failure` so a failed run is
   a `failed` job, not a succeeded one.
3. **"Only runs when no P1 or P2 work is queued" applies to jobs that call LegendKeeper.** The governor already enforces
   it for P3 calls. The four implemented jobs use only the bridge's own database, and delaying the sampler under load would
   leave gaps in the sparklines when they matter most. A job declares `usesLk`; the scheduler holds those back.
4. **"Writes" means writes to LegendKeeper.** The read-only and paused-writes skip applies to jobs flagged `writes`;
   `journal-prune` and `sqlite-optimise` write the bridge's own tables and keep running. Under a skip the reason is recorded.
5. **`proposal-expiry` moved into the scheduler.** It was a clean change: `ProposalService` takes
   `externalExpirySweep` and starts no timer. With `MAINTENANCE_ENABLED=false` the service keeps its own timer, so
   proposals still expire. Expiry is also enforced lazily on approval, so a late sweep never lets an expired proposal run.
6. **"Weekly" is every 7 days**, an interval counted from the last run, since the schedule kinds are an interval or a daily
   time. A weekly job has no fixed weekday.
7. **Chunk 5's interim sampler and `ADMIN_BUDGET_SAMPLE_SECONDS` are removed**, not kept as an alias. The schedule is edited
   on the page. An old `.env` line is ignored.
8. **Preview does not evaluate template rules.** LegendKeeper's resource does not record its template; reporting a guess
   would be inference. They are shown as "not evaluable".
9. **An import never overwrites.** It makes a new inactive set; a clash on name is refused so the owner chooses.
10. **Mapping and maintenance routes call their own owner command layers** rather than `src/admin/actions.ts`. They keep
    ADR 0013's rule (audited, evented, not reachable from MCP) and are covered by the same route-enumerating auth and CSRF
    tests; `actions.ts` stays chunk 5's file.

## Consequences

- The Jobs page shows maintenance jobs only for the infrequent or noteworthy runs; the Maintenance page has the full history.
- A later job that writes to LegendKeeper sets `writes` and `usesLk` and gets the skip and the P3 hold for free.

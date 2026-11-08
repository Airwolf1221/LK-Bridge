# ADR 0018: Chunk 8 hardening decisions

Status: Accepted (chunk 8, 8 November 2026). Extends ADR 0012 (live policy) and PLAN §4 rule 2 and §6.4; changes no
decision in PLAN.md. Flagged for the owner's review with the chunk 8 pull request. Findings are in
[docs/review/2026-11-hardening.md](../review/2026-11-hardening.md).

## Decisions

1. **The journal records every write** (required change A). PLAN §6.4 journals destructive writes with a pre-image. Every
   write the engine sends now also gets an entry (operation, target, principal, profile, approver, job, time, capped
   params, outcome), so that Claude and ChatGPT can see each other's edits. Pre-images stay exactly where §6.4 puts them
   (the replaces, deletes, updates and moves it lists); other writes keep none. Lookups page by id with a `before` cursor,
   every filter has a `(column, id)` index (migration `0201`), and a multi-target write lists its targets in
   `write_journal_targets`. Retention is unchanged (30 days or 2 GB, `journal-prune`).
2. **The policy gate is asked again before each step of a queued job** (F-02). ADR 0012 evaluates scope at every entry;
   work queued before a revocation or a lowered scope used to run to the end. The engine now asks again (`phase:
'execute'`) before each new step of a job acting for an agent; anything but `allow` fails that step with
   `POLICY_DENIED` and cancels the rest. Owner-approved work and internal work are not asked again, so ADR 0012's "the
   owner's approval wins over the proposer's current scope" stands.
3. **`deleteBlock` is guarded against `unsupported` loss** (F-03). PLAN §4 rule 2 names the two replaces; `deleteBlock`
   removes a whole subtree that cannot be restored, so it gets the same guard and the same `allowUnsupportedLoss`
   override. An `unsupported` block without an id is always counted as lost (F-06).
4. **The `/mcp` body limit follows `UPLOAD_MAX_BYTES`** (F-05, review item 12): `max(4 MiB, ceil(max / 3) × 4 + 256 KiB)`,
   enforced by the MCP SDK after authentication. Chosen over lowering the maximum, which would also shrink URL uploads.
5. **Proposal limits** (F-04): at most 4 MiB of pre-state per proposal and 50 pending proposals per principal.
6. **Cross-site requests to `/api/admin` are refused** (F-08), reads included, by `Sec-Fetch-Site`.
7. **The soak may run against the project the bridge serves only with an explicit flag** (`--allow-bridge-project`),
   because PLAN amendment 6 keeps the bridge on the test world for now, which makes the two the same project.

## Consequences

- The journal grows with every write: at the PLAN's ceiling of 3,000 writes an hour, about 2 million entries in 30 days
  (each a few hundred bytes without a pre-image), well inside the 2 GB cap; pages stay index range scans.
- Lowering a scope or revoking a connection now also stops its queued work at the next step; the owner sees a failed job
  with `POLICY_DENIED`.
- An agent that deletes a container holding `unsupported` content gets `UNSUPPORTED_BLOCK_LOSS` and must opt in.

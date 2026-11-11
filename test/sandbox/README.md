# Sandbox tests

Opt-in checks against a real LegendKeeper **sandbox** project (never Baisheng or Arkona). Excluded from `npm test` and from public CI.

v2 A1: the target is a project the bridge serves **and that is marked as a sandbox** in the bridge's database
(`npm run projects -- sandbox <name> on`; [docs/projects.md](../../docs/projects.md)). The key is that project's own,
found as the bridge finds it (OPS2, `target.ts`): the key in the bridge's encrypted store (opened with
`SECRETS_MASTER_KEY`), or, only when nothing is stored for the project, `LK_PROJECT_<NAME>_API_KEY` (`LK_API_KEY` in the
single-project form). With `LKB_ENV_FILE` set, those few names are read from that file (the wrappers do this);
otherwise from the environment. `LK_SANDBOX_API_KEY` and `LK_SANDBOX_PROJECT_ID` are retired.

```bash
DB_PATH=… LK_PROJECT_TEST_API_KEY=… LKB_SANDBOX_PROJECT=test npm run test:sandbox
```

```bash
DB_PATH=… LKB_ENV_FILE=/path/to/lk-bridge.env LKB_SANDBOX_PROJECT=test npm run test:sandbox
```

On the server, as the service user, with no workaround (C2d):

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test
```

`lkbridge` cannot write to `node_modules` (it belongs to the build user), so nothing in the run writes there:
`npm run test:sandbox` loads `vitest.sandbox.config.ts` with `--configLoader runner` (evaluated in memory; the default
loader wrote a bundled copy to `node_modules/.vite-temp` and failed with `EACCES` on the owner's first run, 11 November
2026), and the config switches off Vitest's module cache (`fsModuleCache: false`, which removes the "could not create
.vitest-cache" warning) and its results cache. `test/tools/sandbox-config-readonly.test.ts` runs the command in CI under
Node's permission model with every write outside a temporary directory refused. The sandbox runtimes keep no secrets (a
temporary database; the project's key is handed to them), so they no longer warn that `SECRETS_MASTER_KEY` is not set;
the wrapper still keeps the master key out of every environment. The soak, spike and round-trip wrappers run `tsx`
scripts with no TypeScript config (tsx caches in the system's temporary directory), so they needed no change. Without
`LKB_SANDBOX_PROJECT` the suite is skipped. It **refuses to run** unless the project is marked as a sandbox and the key's own project (from `listProjects`) is exactly that project's stored id (`target.ts`). Everything it creates lives under one throwaway resource that is deleted (cascade) at the end; if that fails the report says which id to delete by hand.

The report (printed at the end) states each item as PASS, FAIL, INCONCLUSIVE or SKIPPED:

- **(a)** LK echoes a client-supplied `x-request-id` (ADR 0010 assumes it does);
- **(b)** the `version` on `getBlock`, `listBlockRows` and `listBlockProperties` reads equals the document version, and a row version works as `If-Match`;
- **(c)** `createManyResources` failing part-way: skipped (it cannot be tested safely); see ADR 0010 and `test/jobs/batch-recovery.test.ts`;
- **(d)** create / read / update / delete for resources, documents, blocks and rows, infobox properties, sidebar properties, timelines, map features, boards, asset folders and calendars, plus the read-only families;
- **(e)** image upload end to end;
- **(f)** a template round trip.

(a) and (b) are assumptions: a FAIL is reported but does not fail the run; a failing family (d, e, f) or leftover does. The script's logic is dry-run against a mock in `test/tools/sandbox-dryrun.test.ts`.

## The soak (chunk 8)

`npm run soak:sandbox -- --project <name> [--writes N]` (on the server: `deploy/soak-sandbox.sh --project test`) runs about 1,000 writes and a matching
mix of reads through the real engine and governor against the same sandbox project, under one throwaway root resource
that it deletes at the end, and reports the time taken, writes per minute, 429 responses (target zero), retries, budget
waits and peak memory. Same guard as above. Code: `soak.ts`; dry run against the mock: `test/tools/soak-dryrun.test.ts`.
How to run it, and why it takes about 20 minutes: docs/runbook-deploy.md, "Soak test".

## The v2 phase 0 spike

`npm run spike:v2 -- --project <name>` (on the server: `deploy/spike-v2.sh --project test`) is a read-mostly script that checks ten
assumptions of docs/PLAN-v2.md against the test world and prints a Markdown report (PASS / FAIL / INFO with evidence).
Only check 1 writes (a `createManyResources` batch whose parents are minted in the same batch), under one throwaway root
that is deleted at the end, even after a failure. Same guard as the soak; every call goes through the real engine and
governor at P3. Code: `spike-v2.ts` (checks), `spike-report.ts` (report layout); dry run against the mock:
`test/tools/spike-v2-dryrun.test.ts`. How to run it: docs/runbook-deploy.md, "Phase 0 spike".

## The write layer's assumptions (CR-2026-11)

`npm run test:sandbox` (with `LKB_SANDBOX_PROJECT`, as above; on the server `deploy/sandbox-test.sh --project test`) also
runs `assumptions.test.ts`; `npm run test:sandbox -- assumptions` runs it alone. It checks, on the real API, every
assumption the write layer makes about LegendKeeper that was only ever checked against the mock: the list, with what
breaks if one is false, is [docs/reviews/CR-2026-11.md](../../docs/reviews/CR-2026-11.md), section 6. Each check
prints PASS, FAIL or INCONCLUSIVE with what LegendKeeper answered; the run fails if any assumption FAILs or the
clean-up does.

- **What it creates:** one throwaway root resource named `lk-bridge assumptions <time>` with about 60 pages under it
  (plain names, no `[BSRC]`/`[BWRK]`/`[BARC]`/`[INDEX]` prefix, no Status, Continuity Type or Continuity row, so the
  canon and lifecycle guards never stand in the way), three templates (`lk-bridge assumptions template A1`, `… A2` and
  `… H1`, the last with one page under it), and documents, rows, a link collection and a text field on its own pages.
- **What it cleans up:** everything, at the end, even after a failure: each check's pages (one small cascade each), the
  three templates, then the root. A delete the canon guard could not judge for lack of budget is tried again after a
  minute (up to three times). If something is left, the report names each id to delete by hand.
- **Cost:** about 100 writes and up to about 500 reads (measured against the mock: 102 and 485, which includes the mock
  world's repository tree re-reading every page written; the sandbox runtime has no tree), plus up to 12 search polls
  while it waits for new text to become searchable. The clean-up's cascades are most of the reads: the canon guard lists
  and reads every page of a cascade at entry and again inside the lock. A few minutes at the bridge's write pacing.
- **Dry run:** `test/tools/assumptions-dryrun.test.ts` runs the same script against the lifecycle test world's mock, to
  check that every check runs to an answer and the clean-up works (the mock does not model every behaviour, so some
  checks FAIL there; that is expected and shows which behaviours only the real API can confirm). A second dry run
  answers as the real API did on the owner's run and checks the corrected checks below pass.
- **Corrected after the owner's first run (C2d, 11 November 2026):**
  - **A1:** LegendKeeper reuses the template's property, row and item ids in a copy. That is its behaviour, not a
    failure: the check passes and notes the reused ids (the bridge keys everything of a page by the page and the id
    together, ADR 0037).
  - **B12:** makes its own page, property, row create and row update (it used to rely on B11, and came out INCONCLUSIVE),
    and checks each write's answered version (in its body, which the bridge chains from) against the next read; an ETag
    header is reported alongside.
  - **B16:** expects the trimmed form: LegendKeeper trims a leading or trailing line break from a row value (the OpenAPI
    schema). It sends two at each end and says plainly if only one is trimmed (the bridge trims them all).
  - **Clean-up:** a page that is already gone (404, or "… is already deleted" after an earlier cascade) counts as
    cleaned; any other failure is confirmed by a read before it is reported as left over.
  - B12 adds a page, a property and two row writes: about 104 writes in all.
- **B12 again (D1.1, 11 November 2026, [ADR 0039](../../docs/adr/0039-date-styles-timeline-repair-and-etag-versions.md)):**
  the owner's run showed that a row write answers no version in its body but an `ETag` header (and a delete answering
  204 one too). The bridge now uses that ETag (unquoted) as the write's new version for the next chained If-Match
  (project setting `useEtagVersions`, default on). B12 therefore asserts, for a row create, a row update and a row
  delete, BOTH that (1) the ETag equals the version the next `listPropertyRows` gives and (2) LegendKeeper accepts it as
  `If-Match` (it is sent instead of the version read). It reports PASS only if both hold for all three, and says
  plainly which half did not. **If B12 fails on the real API, switch `useEtagVersions` off** (Projects page, or
  `npm run projects -- set <project> useEtagVersions off`): the bridge then re-reads, with no deploy. B12 now makes a
  create, an update, a delete and a second create: about 106 writes in all.

## The chronology (v2 D1)

`npm run test:sandbox` (on the server `deploy/sandbox-test.sh --project test`) also runs `chronology.test.ts`;
`npm run test:sandbox -- chronology` runs it alone (on the server `deploy/sandbox-test.sh --project test -- chronology`,
which runs nothing that writes). It is **read-only**: it writes nothing (the run fails if the
transport counted a single write). It checks the calendar engine and the chronology against the real tables and
timelines of every age (the oracle in `test/fixtures/calendar/oracle.json` covers 330 Fourth Age events; this covers all
six ages):

1. every row of every age table: the Date cell parses; the engine's KCY equals the KCY cell byte for byte (in the style
   the tables show most); the engine's date text equals the Date cell, or the difference is listed. Every failing row
   is listed with its exact text, and the distinct shapes of the Date and KCY cells are summarised (digits as `9`,
   words as `Word`);
2. every timeline event: LegendKeeper's `formattedStart` (and `formattedEnd`) read back to exactly its minutes and
   detail, and its minutes formatted back to exactly that text, **in LegendKeeper's style** (no thousands separator in a
   year: `AA 1988119`; the tables' cells, in check 1, are compared in the table style, `AA 1,988,119`: the owner's run
   of 11 November 2026 settled this, [ADR 0039](../../docs/adr/0039-date-styles-timeline-repair-and-etag-versions.md));
3. every age: one lane; every event's `uri` points at its age's table; the Main links; rows in calendar order;
4. **drift**, under its own heading (reported, not a failure of the engine): rows without an event, events without a
   row, a row and its event disagreeing about the date or shape, and the Main count against the rows and events. Rows
   and events are paired as the chronology check pairs them (links, date and name, date alone, then a same-event date
   mismatch). The result line says "PASS (the engine, both date styles and the structure)" and counts the drift
   findings; the dashboard's chronology check lists the same ones, each with "Propose a fix".

- **Which chronology:** the one the owner confirmed on the dashboard (the bridge's stored settings), else
  `LKB_CHRONOLOGY_RESOURCE`, else the test world's Universal Chronology (`h0gczxh7`).
- **Cost:** about 15 reads plus one per 100 events (the test world: about 25), at P2.
- **Dry run:** `test/chronology/sandbox-dryrun.test.ts` runs the same check against the mock chronology.
- **As the service user:** the package script loads the config with `--configLoader runner` and the config turns
  `fsModuleCache` off, so nothing is written under the release's `node_modules`.

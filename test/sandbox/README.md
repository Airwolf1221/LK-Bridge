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

On the server: `deploy/sandbox-test.sh --project test`. Without `LKB_SANDBOX_PROJECT` the suite is skipped. It **refuses to run** unless the project is marked as a sandbox and the key's own project (from `listProjects`) is exactly that project's stored id (`target.ts`). Everything it creates lives under one throwaway resource that is deleted (cascade) at the end; if that fails the report says which id to delete by hand.

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

# Projects (v2 A1)

One bridge serves several LegendKeeper projects, for example `arkona` (the live world) and `test` (the test world). Each project has its own API key, so its own rate budget, and its own jobs, journal, proposals, errors, budget history and mapping sets. Nothing of one project ever appears in another's tools or dashboard pages.

Design: [ADR 0023](adr/0023-project-model.md). Source: `src/projects/`. Tools: [tools.md](tools.md#projects). Moving the live server to this form: [runbook-deploy.md](runbook-deploy.md#moving-to-several-projects-v2-a1).

## Configuration

Keys are secrets and stay in the env file. Everything else is in the database (`projects` table).

| Variable                     | Meaning                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LK_PROJECTS`                | The projects, comma-separated, for example `arkona,test`. Names: a lowercase letter, then lowercase letters, digits or `_`; at most 32 characters |
| `LK_PROJECT_<NAME>_API_KEY`  | Each project's key: `LK_PROJECT_ARKONA_API_KEY`, `LK_PROJECT_TEST_API_KEY`. Required for every listed project                                     |
| `LK_DEFAULT_PROJECT`         | The project reads use when a tool names none. Required when more than one project is listed                                                       |
| `REQUIRE_PROJECT_FOR_WRITES` | Default `true`: a write that names no project is refused while more than one project is listed                                                    |

The LegendKeeper project id is not configured: the bridge learns it from each key at start-up, and checks it on every start after that.

**The single-project form** (v1) still works: without `LK_PROJECTS`, `LK_API_KEY` and `LK_PROJECT_ID` are one project named `LK_PROJECT_NAME` (default `test`), and the key must belong to `LK_PROJECT_ID`. The bridge logs a warning at every start naming the variables to move to. `LK_SANDBOX_API_KEY` and `LK_SANDBOX_PROJECT_ID` are no longer read.

## Start-up checks

Each key lists the projects it can see (`listProjects`, one read through that project's own governor) and must see exactly one:

| Status       | Meaning                                                                                                                                                                     | What happens                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `verifying`  | The check has not finished yet                                                                                                                                              | Refused with `PROJECT_UNAVAILABLE` until it does (usually under a second)   |
| `active`     | The key proved its project (and, for a stored project, the same id as before)                                                                                               | Served                                                                      |
| `unverified` | LegendKeeper could not be reached, or answered with a server error                                                                                                          | Refused; checked again after 15 s, then less often, up to every 10 minutes  |
| `stopped`    | The key was refused (401/403), the plan is unpaid (402), the key sees no project or several, or it belongs to another project than the one stored (or than `LK_PROJECT_ID`) | Refused until the next start, or until **Check again** on the Projects page |

A stopped project does not stop the bridge: the other projects are served, the Overview lists every project's status with the reason, and the log line names the variable holding the key, never the key. A stored project whose key now answers for another project is never re-pointed: its rows keep their id until the owner decides.

The bridge listens at once; each project is served from the moment its own check passes.

## The `project` argument

Every MCP tool takes an optional `project` (a name, any case, or a LegendKeeper id). Reads without it use the default project; writes without it are refused while several projects are registered. Every result names its project, and the budget line is that project's: `budget (arkona): …`. `list_projects` lists the projects an agent may name. Details and error codes: [tools.md](tools.md#projects).

## Dashboard

- **Project switcher** (top bar): Overview, Jobs, Errors, Budgets, Journal, Proposals and Mappings show the selected project. The choice is kept per browser. Job, proposal and error actions act within the page's project; another project's ids are "not found".
- **Budgets**: one project's tiers and history, and every project's side by side.
- **Writers**: the pool is shared, so it shows every project's writes, each with its project.
- **Projects page**: every project with its flags (default, sandbox, read-only), its LegendKeeper id and name, whether its key is configured (the variable's name) and valid, its status and reason, when it was last verified, and its settings (editable since v2 A2, audited). **Read-only** can be switched per project here (with a confirmation; audited as `project.set_read_only`). **Check again** re-runs a project's start-up check (audited as `project.verify`).

Clients, policy and settings pages are bridge-wide: a connection's profile and scope apply to every project.

## Read-only, per project

A project is read-only when the bridge is (`LK_READ_ONLY`, or the dashboard's bridge-wide switch) or when its own flag is set. The project flag can only make a project stricter. It is stored on the project row and survives restarts. `bridge_info` shows `readOnly.bridge`, `readOnly.project` and `readOnly.effective`.

## Sandbox projects

The sandbox, soak and spike scripts write to LegendKeeper, so they only run against a project marked as a sandbox. Mark the test world once, on the server, as the service user (the dashboard shows this flag but cannot change it):

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run projects -- sandbox test on
```

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run projects -- list
```

The scripts then take `--project test` and refuse any project not marked (`deploy/sandbox-test.sh`, `deploy/soak-sandbox.sh`, `deploy/spike-v2.sh`; [runbook-deploy.md](runbook-deploy.md)). Never mark Arkona.

## Project settings

Stored as JSON on the project row and read through `projectSetting()` (`src/projects/settings.ts`): `aiRepositoryRootId`, `charactersRootId`, `chronologyResourceId`, `templateIds`, and (v2 A2) the repository tree's `treePropertiesName`, `treeReferenceTypeRow`, `treeScopeRow`, `treeIndexScopeRow`, `treeCanonicalNameRow` and `treeSweepEnabled` ([tree.md](tree.md#settings-per-project)), and (v2 A4) the asset tree's `assetRefreshEnabled` (default on; [assets.md](assets.md#how-it-stays-current)).

**Editing (v2 A2).** Every setting but `templateIds` can be changed, one key at a time, on the Projects page (audited as `project.set_setting`, with the old and new value) or from the server's shell:

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run projects -- settings test
```

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run projects -- set test aiRepositoryRootId h0gczxh7
```

`-` as the value clears a setting (its default applies again). Values are validated (a resource id must look like one; names are 1 to 256 characters; the sweep switch is `on` or `off`). The running bridge reads the tree settings from the database each time, so a change from the shell applies without a restart.

## Data

Every table holding LegendKeeper data has a required `project_id` (migration 0600; the repository tree's tables, migration 0700, too): jobs and their steps and artefacts, errors, budget samples, the write journal and its targets, proposals and their operations, governor counters, maintenance runs (`*` for a bridge-wide run) and mapping sets with their rules and field maps. Child rows reference their parent by `(id, project_id)`. In code, every query takes a project id or the explicit `ALL_PROJECTS` value.

## One bridge process per project

The bridge's per-page and per-resource locks are in-process, and LegendKeeper's `If-Match` is not an atomic compare-and-swap, so two processes serving one project could overlap writes and lose one. A second process on the same database is refused at start-up (`INSTANCE_LOCKED`, naming the other process). Never put one project's key in two bridges' env files.

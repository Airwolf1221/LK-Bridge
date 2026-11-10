# ADR 0030: The sandbox scripts find a project's key exactly as the bridge does

Status: Accepted (OPS2 hotfix, 10 November 2026). Amends [ADR 0023](0023-project-model.md) decision 10 (the scripts
"use that project's key from the env file") and [ADR 0022](0022-markdown-converter.md) decision 12 (the round-trip
wrapper "exports just that and `DB_PATH`"), following [ADR 0028](0028-secrets-on-the-dashboard.md) decisions 2, 5 and 6.

## Context

After OPS2 the bridge keeps project keys in its encrypted store, and the owner retired the env file's copies with
`env-sync.sh --retire-imported-keys`. The sandbox, soak, spike and round-trip scripts still read the key from the env
file, through `sandbox_project_env` (deploy/lib.sh) and `resolveSandboxTarget` (test/sandbox/target.ts), so every one of
them stopped with `LK_PROJECT_TEST_API_KEY is empty`. Nothing else outside the bridge reads a project key from the env
file: `deploy.sh` reads `LK_PROJECT_ID` and `LK_PROJECT_NAME` only (ids and names, for migration 0600), env-sync manages
the key lines without using them and asks the bridge's own `env-tool` to compare them with the store, and the boot
check (`config:check`) only checks the format of keys still in the file.

## Decision

1. **The bridge's rule, shared.** `resolveProjectKey` (src/secrets/project-key.ts) states the rule the registry follows
   at start-up (`adoptStoredKey`): a key stored for the project's LegendKeeper id wins; only when nothing is stored is
   the env file's key used (a database from before OPS2, or a key not yet imported); a stored key that cannot be opened
   (no master key, the wrong one, a damaged row) is refused, never replaced by the env file's key, which may be the old
   key the dashboard replaced. It reads the store through `SecretStore` only.
2. **The scripts use it.** `resolveSandboxTarget` keeps every earlier rule (the project must be registered and marked
   as a sandbox, and the key's own project must be exactly the registered one) and now also refuses a project removed
   on the dashboard (the bridge does not serve it). A key in neither place is refused with a message naming the
   dashboard's Projects page. The scripts say on stderr where the key came from (the store, or the variable's name).
3. **The wrapper reads no key.** `sandbox_project_env` checks the name and that the env file is readable (it must run as
   the service user), exports `DB_PATH` and `LKB_ENV_FILE` (a path), and drops any key or master key the caller's own
   environment holds. The Node side reads just the names it needs from that file (`LK_PROJECTS`, `LK_PROJECT_NAME`,
   `LK_API_KEY`, the project's `LK_PROJECT_<NAME>_API_KEY`, `SECRETS_MASTER_KEY`, `SECRETS_MASTER_KEY_PREVIOUS`), as
   `npm run db:migrate` reads `LK_PROJECT_ID`. No key and no master key is ever put in a process's environment. Without
   `LKB_ENV_FILE` (a developer's checkout) the values come from the environment, as before.

## Consequences

- The scripts work in the post-retirement state and keep working when a key is replaced on the dashboard (they use the
  new key, as the bridge does), without any change to the env file.
- The master key is now read by the scripts as well as by the bridge, `npm run secrets` and env-sync's comparison: the
  same user (`lkbridge`), the same file. It still never leaves the process that reads it.
- Tested: every wrapper end to end on a fake server (the store with no env key, the env fallback, a key in neither
  place, a project that is not a sandbox, the stored key winning over a different env key, a stored key that cannot be
  opened, a removed project), each run's stdout and stderr and every process's environment scanned for every key and
  master key; one end-to-end dry run of the round trip in the retired-keys state against a fake LegendKeeper that sees
  only a hash of the bearer token.

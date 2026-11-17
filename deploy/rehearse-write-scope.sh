#!/usr/bin/env bash
# Runs the write-scope rehearsal (`npm run rehearse:write-scope`, v3 F3.4, ADR 0055) on the server against a SANDBOX
# project the bridge has registered, before an agent's profile is raised to scope write. Run as lkbridge, against the
# TEST WORLD only:
#
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/rehearse-write-scope.sh --project test
#
# Like soak-sandbox.sh: it exports only DB_PATH and the env file's path and reads no key; the rehearsal finds the
# project's key as the bridge does (its encrypted store first, the env file's key only when nothing is stored) and
# prints none. It refuses any project not registered as a sandbox in the bridge's database (`npm run projects --
# sandbox <name> on`), and any key whose own project is not exactly that one. It runs on its own temporary database,
# which starts as a read-only copy of the project's settings, repository tree and packs from the bridge's database (it
# never writes there); it writes to the project as a temporary write-scoped agent, reverts what it wrote, and deletes
# what it made. Each step prints PASS, FAIL or NOTED (docs/runbook-deploy.md, "Write-scope rehearsal").
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
source "${here}/lib.sh"

project=""
args=()
while (($# > 0)); do
  case "$1" in
    --project)
      project="${2:-}"
      shift 2 || shift
      ;;
    --project=*)
      project="${1#--project=}"
      shift
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done

use_private_node
sandbox_project_env "$project"

cd "${here}/.."
npm run rehearse:write-scope -- --project "$project" "${args[@]}"

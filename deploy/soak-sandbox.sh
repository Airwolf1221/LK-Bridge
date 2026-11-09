#!/usr/bin/env bash
# Runs the sandbox soak test (`npm run soak:sandbox`) on the server against a SANDBOX project the bridge has registered
# (v2 A1). Run as lkbridge, against the TEST WORLD only:
#
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/soak-sandbox.sh --project test                 # about 1,000 writes
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/soak-sandbox.sh --project test --writes 100    # a quick run
#
# Like sandbox-test.sh: it reads just that project's key variable and DB_PATH, exports only those, and prints neither.
# The soak refuses any project not registered as a sandbox in the bridge's database (`npm run projects -- sandbox <name>
# on`), and any key whose own project is not exactly that one; it creates everything under one throwaway root resource
# and deletes it at the end, and uses its own temporary database. It draws on the same LegendKeeper rate budget as the
# bridge does for that project, so run it while the bridge is quiet (docs/runbook-deploy.md, "Soak test").
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
npm run soak:sandbox -- --project "$project" "${args[@]}"

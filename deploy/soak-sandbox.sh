#!/usr/bin/env bash
# Runs the sandbox soak test (`npm run soak:sandbox`) on the server, taking LK_SANDBOX_API_KEY and LK_SANDBOX_PROJECT_ID
# from the bridge's env file. Run as lkbridge, against the TEST WORLD only:
#
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/soak-sandbox.sh                 # about 1,000 writes (20 to 25 minutes)
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/soak-sandbox.sh --writes 100    # a quick run
#   ... --allow-bridge-project   # needed while the bridge itself serves the test world (LK_PROJECT_ID = sandbox)
#
# Like sandbox-test.sh: it reads just the two sandbox variables, exports only those, and prints neither. It refuses to
# run if the sandbox project is the one the bridge serves, unless you pass --allow-bridge-project (see below). The soak itself refuses unless the key's own project is
# exactly LK_SANDBOX_PROJECT_ID, creates everything under one throwaway root resource and deletes it at the end, and uses
# its own temporary database. It draws on the same LegendKeeper rate budget as the bridge when the bridge uses the same
# project, so run it while the bridge is quiet (docs/runbook-deploy.md, "Soak test").
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
source "${here}/lib.sh"

use_private_node
sandbox_key="$(env_file_get LK_SANDBOX_API_KEY)"
sandbox_project="$(env_file_get LK_SANDBOX_PROJECT_ID)"
[[ -n "$sandbox_key" ]] || die "LK_SANDBOX_API_KEY is empty in ${LKB_ENV_FILE}. Fill it in (sandbox project key only)."
[[ -n "$sandbox_project" ]] || die "LK_SANDBOX_PROJECT_ID is empty in ${LKB_ENV_FILE}."
allow_bridge_project=0
args=()
for a in "$@"; do
  if [[ "$a" == "--allow-bridge-project" ]]; then allow_bridge_project=1; else args+=("$a"); fi
done
if [[ "$sandbox_project" == "$(env_file_get LK_PROJECT_ID)" ]]; then
  # While the bridge itself points at the test world (PLAN amendment, 8 November 2026) the two are the same project, and
  # the owner may say so explicitly. Without the flag this is refused, so that a copy-and-paste slip can never point the
  # soak at the project the bridge serves once that is the real one.
  ((allow_bridge_project)) || die "LK_SANDBOX_PROJECT_ID is the project the bridge serves (LK_PROJECT_ID). If that is still the TEST WORLD, run again with --allow-bridge-project (the soak then shares the bridge's rate budget: run it while the bridge is quiet). Never do this once the bridge serves the real project."
  warn "Soaking the project the bridge serves (allowed with --allow-bridge-project). Keep the bridge quiet until it finishes."
fi

cd "${here}/.."
LK_SANDBOX_API_KEY="$sandbox_key" LK_SANDBOX_PROJECT_ID="$sandbox_project" npm run soak:sandbox -- "${args[@]}"

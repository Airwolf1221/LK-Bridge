#!/usr/bin/env bash
# Runs the v2 phase 0 spike (`npm run spike:v2`) on the server, taking LK_SANDBOX_API_KEY and LK_SANDBOX_PROJECT_ID from
# the bridge's env file. Run as lkbridge, against the TEST WORLD only:
#
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/spike-v2.sh --allow-bridge-project
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/spike-v2.sh --allow-bridge-project --skip 1     # read-only: no check 1
#
# --allow-bridge-project is needed while the bridge itself serves the test world (LK_PROJECT_ID = sandbox). Every other
# argument goes to the script (see `npm run spike:v2 -- --help`): the known test-world ids, --skip, --out-dir, and so on.
#
# Like soak-sandbox.sh: it reads just the two sandbox variables, exports only those, and prints neither. It refuses to
# run if the sandbox project is the one the bridge serves, unless you pass --allow-bridge-project. The spike itself
# refuses unless the key's own project is exactly LK_SANDBOX_PROJECT_ID, reads everything except check 1, writes only
# under one throwaway root resource that it deletes (cascade) at the end, and uses its own temporary database. It draws
# on the same LegendKeeper rate budget as the bridge when the bridge uses the same project (reads at the lowest priority),
# so run it while the bridge is quiet.
#
# The report is printed to stdout and written to /var/lib/lk-bridge/spike/spike-v2-<timestamp>.md (the data directory),
# with the calendar oracle beside it as spike-v2-<timestamp>-oracle.json.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
source "${here}/lib.sh"

use_private_node
sandbox_key="$(env_file_get LK_SANDBOX_API_KEY)"
sandbox_project="$(env_file_get LK_SANDBOX_PROJECT_ID)"
[[ -n "$sandbox_key" ]] || die "LK_SANDBOX_API_KEY is empty in ${LKB_ENV_FILE}. Fill it in (test world key only)."
[[ -n "$sandbox_project" ]] || die "LK_SANDBOX_PROJECT_ID is empty in ${LKB_ENV_FILE}."
allow_bridge_project=0
have_out_dir=0
args=()
for a in "$@"; do
  case "$a" in
    --allow-bridge-project) allow_bridge_project=1 ;;
    --out-dir | --out-dir=*) have_out_dir=1 args+=("$a") ;;
    *) args+=("$a") ;;
  esac
done
if [[ "$sandbox_project" == "$(env_file_get LK_PROJECT_ID)" ]]; then
  # While the bridge itself points at the test world (PLAN amendment, 8 November 2026) the two are the same project, and
  # the owner may say so explicitly. Without the flag this is refused, so that a copy-and-paste slip can never point the
  # spike at the project the bridge serves once that is the real one.
  ((allow_bridge_project)) || die "LK_SANDBOX_PROJECT_ID is the project the bridge serves (LK_PROJECT_ID). If that is still the TEST WORLD, run again with --allow-bridge-project (the spike then shares the bridge's rate budget: run it while the bridge is quiet). Never do this once the bridge serves the real project."
  warn "Spiking the project the bridge serves (allowed with --allow-bridge-project). Keep the bridge quiet until it finishes."
fi
# The report goes in the data directory, which is the one place lkbridge may write (ADR 0020).
((have_out_dir)) || args+=(--out-dir "${LKB_DATA_DIR}/spike")

cd "${here}/.."
LK_SANDBOX_API_KEY="$sandbox_key" LK_SANDBOX_PROJECT_ID="$sandbox_project" npm run --silent spike:v2 -- "${args[@]}"

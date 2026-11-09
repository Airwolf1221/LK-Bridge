#!/usr/bin/env bash
# Runs the Markdown round trip (`npm run roundtrip`) on the server: every page of the project is read, converted to
# Markdown and back, and checked to come back identical with an empty write plan. READ-ONLY. It takes
# LK_SANDBOX_API_KEY and LK_SANDBOX_PROJECT_ID from the bridge's env file, as the phase 0 spike does. Run as lkbridge:
#
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/markdown-roundtrip.sh --allow-bridge-project
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/markdown-roundtrip.sh --allow-bridge-project --max-pages 50   # a trial
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/markdown-roundtrip.sh --allow-bridge-project --root <resourceId>
#
# --allow-bridge-project is needed while the bridge itself serves the test world (LK_PROJECT_ID = sandbox). Every other
# argument goes to the script (see `npm run roundtrip -- --help`).
#
# Like spike-v2.sh: it reads just the two sandbox variables, exports only those, and prints neither. The script refuses
# unless the key's own project is exactly LK_SANDBOX_PROJECT_ID, sends only reads (listProjects, listResources,
# getDocumentBlocks: about one per page) at the lowest priority, and uses its own temporary database. It draws on the
# same rate budget as the bridge when both use the same project, but gives way to agents and jobs.
#
# The report is printed and written to /var/lib/lk-bridge/roundtrip/roundtrip-<timestamp>.md (the data directory), with
# a minimal reproduction of each failing page in /var/lib/lk-bridge/roundtrip/roundtrip-<timestamp>/.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
source "${here}/lib.sh"

use_private_node
sandbox_key="$(env_file_get LK_SANDBOX_API_KEY)"
sandbox_project="$(env_file_get LK_SANDBOX_PROJECT_ID)"
[[ -n "$sandbox_key" ]] || die "LK_SANDBOX_API_KEY is empty in ${LKB_ENV_FILE}. Fill it in (the key of the project to check)."
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
  # The round trip only reads, but the rule is the spike's: pointing a script at the project the bridge serves must be
  # said explicitly, so a copy-and-paste slip never does it by accident.
  ((allow_bridge_project)) || die "LK_SANDBOX_PROJECT_ID is the project the bridge serves (LK_PROJECT_ID). The round trip only reads; to check that project, run again with --allow-bridge-project (it then shares the bridge's rate budget, at the lowest priority)."
  warn "Checking the project the bridge serves (allowed with --allow-bridge-project). Reads only, at the lowest priority."
fi
# The report goes in the data directory, which is the one place lkbridge may write (ADR 0020).
((have_out_dir)) || args+=(--out-dir "${LKB_DATA_DIR}/roundtrip")

cd "${here}/.."
LK_SANDBOX_API_KEY="$sandbox_key" LK_SANDBOX_PROJECT_ID="$sandbox_project" npm run --silent roundtrip -- "${args[@]}"

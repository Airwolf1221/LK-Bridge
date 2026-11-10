#!/usr/bin/env bash
# Runs the v2 phase 0 spike (`npm run spike:v2`) on the server against a SANDBOX project the bridge has registered
# (v2 A1). Run as lkbridge, against the TEST WORLD only:
#
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/spike-v2.sh --project test
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/spike-v2.sh --project test --skip 1     # read-only: no check 1
#
# Every other argument goes to the script (see `npm run spike:v2 -- --help`): the known test-world ids, --skip,
# --out-dir, and so on.
#
# Like soak-sandbox.sh: it exports only DB_PATH and the env file's path and reads no key; the spike finds the project's
# key as the bridge does (its encrypted store first, the env file's key only when nothing is stored) and prints none.
# The spike refuses any project not registered as a sandbox in the bridge's database (`npm run projects -- sandbox
# <name> on`), and any key whose own project is not exactly that one; it reads everything except check 1, writes only
# under one throwaway root resource that it deletes (cascade) at the end, and uses its own temporary database. It draws
# on the same LegendKeeper rate budget as the bridge does for that project (reads at the lowest priority), so run it
# while the bridge is quiet.
#
# The report is printed to stdout and written to /var/lib/lk-bridge/spike/spike-v2-<timestamp>.md (the data directory),
# with the calendar oracle beside it as spike-v2-<timestamp>-oracle.json.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
source "${here}/lib.sh"

project=""
have_out_dir=0
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
    --out-dir | --out-dir=*)
      have_out_dir=1
      args+=("$1")
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
# The report goes in the data directory, which is the one place lkbridge may write (ADR 0020).
((have_out_dir)) || args+=(--out-dir "${LKB_DATA_DIR}/spike")

cd "${here}/.."
npm run --silent spike:v2 -- --project "$project" "${args[@]}"

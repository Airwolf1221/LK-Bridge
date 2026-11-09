#!/usr/bin/env bash
# Runs the Markdown round trip (`npm run roundtrip`) on the server against a SANDBOX project the bridge has registered
# (v2 A1): every page of the project is read, converted to Markdown and back, and checked to come back identical with an
# empty write plan. READ-ONLY. Run as lkbridge:
#
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/markdown-roundtrip.sh --project test
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/markdown-roundtrip.sh --project test --max-pages 50   # a trial
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/markdown-roundtrip.sh --project test --root <resourceId>
#
# Every other argument goes to the script (see `npm run roundtrip -- --help`).
#
# Like spike-v2.sh: it reads just that project's key variable and DB_PATH, exports only those, and prints neither. The
# script refuses any project not registered as a sandbox in the bridge's database (`npm run projects -- sandbox <name>
# on`), and any key whose own project is not exactly that one; it sends only reads (listProjects, listResources,
# getDocumentBlocks: about one per page) at the lowest priority, and uses its own temporary database. It draws on the
# same rate budget as the bridge does for that project, but gives way to agents and jobs.
#
# The report is printed and written to /var/lib/lk-bridge/roundtrip/roundtrip-<timestamp>.md (the data directory), with
# a minimal reproduction of each failing page in /var/lib/lk-bridge/roundtrip/roundtrip-<timestamp>/.
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
((have_out_dir)) || args+=(--out-dir "${LKB_DATA_DIR}/roundtrip")

cd "${here}/.."
npm run --silent roundtrip -- --project "$project" "${args[@]}"

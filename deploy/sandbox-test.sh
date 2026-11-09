#!/usr/bin/env bash
# Runs `npm run test:sandbox` on the server against a SANDBOX project the bridge has registered (v2 A1). Run as
# lkbridge:
#
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test
#
# Why a wrapper: vitest does not read /etc/lk-bridge/lk-bridge.env (the bridge gets it from systemd), and the file is not
# safe to `source`. This reads just that project's key variable (LK_PROJECT_<NAME>_API_KEY, or LK_API_KEY in the
# single-project form) and DB_PATH, exports only those, and prints neither. The suite itself refuses any project that
# is not registered in the bridge's database AND marked as a sandbox there (`npm run projects -- sandbox <name> on`), and
# any key whose own project is not exactly that one. It writes to the project and deletes what it created.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
source "${here}/lib.sh"

project=""
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
    *) die "Unknown argument $1. Usage: sandbox-test.sh --project <name>" ;;
  esac
done

use_private_node
sandbox_project_env "$project"

cd "${here}/.."
LKB_SANDBOX_PROJECT="$project" npm run test:sandbox

#!/usr/bin/env bash
# Runs a command in the app directory the way the bridge sees it: the private Node first on PATH, and DB_PATH taken from
# the env file. For the owner CLIs that need them (run as lkbridge):
#
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run setup:owner
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run pat -- list
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run db:migrate
#
# Only DB_PATH is read from the env file; no secret is exported or printed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
source "${here}/lib.sh"

(($# > 0)) || die "usage: lk-run.sh <command> [args...]   e.g. lk-run.sh npm run setup:owner"
use_private_node
db_path="$(env_file_get DB_PATH)"
export DB_PATH="${db_path:-${LKB_DATA_DIR}/bridge.db}"
cd "${here}/.."
exec "$@"

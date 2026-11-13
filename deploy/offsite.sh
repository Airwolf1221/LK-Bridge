#!/usr/bin/env bash
# The off-site copy's runner (v2 E1b, ADR 0043): what lk-bridge-offsite.service starts, as lkbridge.
#
#   /opt/lk-bridge/app/deploy/offsite.sh [run|copy|verify|status|check-rclone|...]     (default: run)
#
# `run` takes the dashboard's requests and does what the schedule (in the database) says is due: the daily copy to
# Google Drive, the monthly verify, deleting an old Drive folder. See `node dist/offsite/cli.js` for every command.
# Like lk-run.sh, it runs the compiled Node entry with the bridge's private Node. The runner reads the few settings it
# needs (SECRETS_MASTER_KEY, DB_PATH, BRIDGE_PUBLIC_URL, SNAPSHOT_DIR, BACKUP_DIR) from the env file itself; nothing is
# exported, and rclone gets none of it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
source "${here}/lib.sh"

if [[ "$(id -u)" -eq 0 && -z "${LKB_ALLOW_ROOT:-}" ]]; then
  die "Run this as ${LKB_SERVICE_USER}, not root: sudo -u ${LKB_SERVICE_USER} ${here}/offsite.sh ${*:-run}"
fi
use_private_node
cd "${here}/.."
exec node "${LKB_OFFSITE_CLI:-dist/offsite/cli.js}" "${@:-run}" --env-file "$LKB_ENV_FILE"

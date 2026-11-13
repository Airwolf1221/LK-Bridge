#!/usr/bin/env bash
# Disaster recovery, the pull-and-check part (v2 E1b, ADR 0043; runbook, "Disaster recovery from Google Drive").
#
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/offsite-restore.sh [--dest DIR] [--folder "LK-Bridge backups/<server>/copy-<n>"]
#
# Pulls the snapshot store (objects/ first, then manifests/, then STORE.json) and the newest nightly database copy from
# the encrypted Google Drive copy into DIR (default /var/lib/lk-bridge/offsite-restore/<UTC time>), then checks them:
# every object re-hashed against its name, every manifest's pieces present, the database copy through SQLite's
# integrity_check (unpacked to DIR/bridge.db). It never touches the live database or store: when the check passes it
# prints the commands that move them into place.
#
# Needs: rclone installed, and the Drive client, the connection and the encryption keys entered (on the dashboard, or
# with `offsite.sh set-client`, `connect` and `set-keys` when the dashboard is not up yet). The folder defaults to the
# one the database names; `offsite.sh generations` lists the copy-<n> folders on Drive.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
source "${here}/lib.sh"

dest=""
args=()
while (($# > 0)); do
  case "$1" in
    --dest)
      dest="${2:-}"
      shift 2
      ;;
    --folder)
      args+=(--folder "${2:-}")
      shift 2
      ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed -E 's/^# ?//'
      exit 0
      ;;
    *) die "Unknown option '$1'. See --help." ;;
  esac
done

if [[ "$(id -u)" -eq 0 && -z "${LKB_ALLOW_ROOT:-}" ]]; then
  die "Run this as ${LKB_SERVICE_USER}, not root (the files it pulls must be ${LKB_SERVICE_USER}'s): sudo -u ${LKB_SERVICE_USER} ${here}/offsite-restore.sh"
fi
[[ -n "$dest" ]] || dest="${LKB_DATA_DIR}/offsite-restore/$(date -u +%Y%m%dT%H%M%SZ)"
[[ ! -e "$dest" || -z "$(ls -A -- "$dest" 2>/dev/null)" ]] || die "${dest} exists and is not empty; choose another --dest."

use_private_node
umask 077
cd "${here}/.."
set +e
node "${LKB_OFFSITE_CLI:-dist/offsite/cli.js}" restore --dest "$dest" "${args[@]}" --env-file "$LKB_ENV_FILE"
rc=$?
set -e
if ((rc != 0)); then
  echo "The pull or the check failed (above). Nothing live was touched; ${dest} holds what was pulled." >&2
  exit "$rc"
fi

db_path="$(env_file_get DB_PATH)"
db_path="${db_path:-${LKB_DATA_DIR}/bridge.db}"
data_dir="$(dirname "$db_path")"
cat <<NEXT

Everything pulled from Drive checked out. To put it in place (the bridge stopped; nothing is deleted, the current files
are moved aside):

  sudo systemctl stop lk-bridge
  sudo -u ${LKB_SERVICE_USER} mkdir -p ${data_dir}/restore-aside
  sudo -u ${LKB_SERVICE_USER} sh -c 'for f in ${db_path} ${db_path}-wal ${db_path}-shm ${data_dir}/snapshots; do [ -e "\$f" ] && mv "\$f" ${data_dir}/restore-aside/; done; true'
  sudo -u ${LKB_SERVICE_USER} mv ${dest}/bridge.db ${db_path}
  sudo -u ${LKB_SERVICE_USER} mv ${dest}/snapshots ${data_dir}/snapshots
  sudo systemctl start lk-bridge
  sudo -u ${LKB_SERVICE_USER} /opt/lk-bridge/app/deploy/healthcheck.sh

(${dest}/backups keeps the compressed database copy as it came from Drive.)
NEXT

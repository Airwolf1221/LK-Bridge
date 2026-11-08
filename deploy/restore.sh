#!/usr/bin/env bash
# Restores the bridge database from a backup made by backup.sh. The service must be STOPPED. Run as lkbridge:
#
#   sudo systemctl stop lk-bridge
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/restore.sh /var/lib/lk-bridge/backups/<file>.db.gz
#   sudo systemctl start lk-bridge
#   sudo -u lkbridge /opt/lk-bridge/app/deploy/healthcheck.sh
#
# In order, stopping at the first problem:
#   1. Refuses while the service is running.
#   2. Unpacks the backup to a temporary file beside the database and checks it (SQLite integrity_check, and that it is
#      a bridge database) BEFORE anything else is touched.
#   3. Moves the current database and its -wal and -shm files into restore-aside-<UTC time>/ beside it. Nothing is
#      deleted: delete that directory yourself once you are sure. (A stale -wal next to a restored database would
#      corrupt it, which is why they move too.)
#   4. Puts the backup in place (mode 0600). Anything written since the backup was taken is lost.
#
# A database from an older release is fine: the bridge applies any missing migrations when it starts.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
source "${here}/lib.sh"

backup="${1:-}"
[[ -n "$backup" ]] || die "usage: restore.sh <backup file (.db.gz or .db)>   (the backups are in ${LKB_DATA_DIR}/backups)"
[[ -f "$backup" ]] || die "No such backup file: ${backup}"
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 is not installed (sudo apt install -y sqlite3)."

db="${DB_PATH:-$(env_file_get DB_PATH)}"
db="${db:-${LKB_DATA_DIR}/bridge.db}"
dir="$(dirname "$db")"
systemctl_bin="${LKB_SYSTEMCTL:-/usr/bin/systemctl}"

# 1. Never under a running bridge.
if "$systemctl_bin" is-active --quiet "$LKB_SERVICE"; then
  die "${LKB_SERVICE} is running. Stop it first: sudo systemctl stop ${LKB_SERVICE}"
fi

# 2. Unpack and check the backup before touching the live database.
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp="${dir}/.restore-${stamp}.db"
trap 'rm -f "$tmp"' EXIT
if [[ "$backup" == *.gz ]]; then gunzip -c -- "$backup" >"$tmp"; else cp -- "$backup" "$tmp"; fi
[[ "$(sqlite3 "$tmp" 'PRAGMA integrity_check;')" == "ok" ]] || die "The backup fails SQLite's integrity check. Nothing was changed."
sqlite3 "$tmp" 'SELECT count(*) FROM schema_migrations;' >/dev/null 2>&1 \
  || die "The backup is not an LK-Bridge database (no schema_migrations table). Nothing was changed."

# 3. Move the current database, and its WAL and shared-memory files, aside.
aside="${dir}/restore-aside-${stamp}"
mkdir -p "$aside"
for f in "$db" "${db}-wal" "${db}-shm"; do
  if [[ -e "$f" ]]; then mv -- "$f" "${aside}/"; fi
done

# 4. Put the backup in place.
mv -- "$tmp" "$db"
chmod 0600 "$db"
trap - EXIT
log "Restored ${db} from $(basename "$backup")."
log "The previous database is in ${aside} (delete it once you are sure)."
log "Next: sudo systemctl start ${LKB_SERVICE}, then ${here}/healthcheck.sh"

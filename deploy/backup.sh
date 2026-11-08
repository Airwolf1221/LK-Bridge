#!/usr/bin/env bash
# Consistent online backup of the bridge database with `sqlite3 .backup`.
#
#   backup.sh [nightly|pre-deploy]      (default: nightly; run as lkbridge)
#
# Writes /var/lib/lk-bridge/backups/<label>-<UTC timestamp>.db.gz, mode 0600, after checking that the copy passes
# SQLite's integrity_check. Only then are old copies removed: the newest 14 `nightly` ones are kept, and the newest 5
# `pre-deploy` ones (deploy.sh takes one before every migration), so a deploy never pushes out a nightly copy.
# `.backup` is safe while the bridge is running (it takes a consistent snapshot of the WAL database).
set -euo pipefail

label="${1:-nightly}"
case "$label" in
  nightly) keep="${KEEP_NIGHTLY:-14}" ;;
  pre-deploy) keep="${KEEP_PRE_DEPLOY:-5}" ;;
  *)
    echo "usage: backup.sh [nightly|pre-deploy]" >&2
    exit 2
    ;;
esac

db="${DB_PATH:-/var/lib/lk-bridge/bridge.db}"
dir="${BACKUP_DIR:-$(dirname "$db")/backups}"

command -v sqlite3 >/dev/null 2>&1 || {
  echo "ERROR: sqlite3 is not installed (sudo apt install -y sqlite3)." >&2
  exit 1
}
[[ -f "$db" ]] || {
  echo "ERROR: database not found at ${db}." >&2
  exit 1
}

umask 077
mkdir -p "$dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp="${dir}/.${label}-${stamp}.db.partial"
final="${dir}/${label}-${stamp}.db.gz"
trap 'rm -f "$tmp" "${tmp}.gz"' EXIT

# `.timeout` waits for a busy writer instead of failing at once. The path is passed through a dot-command argument,
# so a single quote in it would break it; the paths here are fixed and contain none.
sqlite3 "$db" ".timeout 30000" ".backup '${tmp}'"

result="$(sqlite3 "$tmp" 'PRAGMA integrity_check;')"
[[ "$result" == "ok" ]] || {
  echo "ERROR: the backup failed SQLite's integrity check; it was discarded." >&2
  exit 1
}

gzip --best --stdout "$tmp" >"${tmp}.gz"
mv "${tmp}.gz" "$final"
chmod 0600 "$final"
echo "Backup written: ${final} ($(stat -c %s "$final") bytes)"

# Retention: names sort by timestamp, so everything but the last $keep goes.
mapfile -t all < <(find "$dir" -maxdepth 1 -type f -name "${label}-*.db.gz" -printf '%f\n' | sort)
if ((${#all[@]} > keep)); then
  for old in "${all[@]:0:${#all[@]}-keep}"; do
    rm -f -- "${dir}/${old}"
    echo "Removed old backup: ${old}"
  done
fi

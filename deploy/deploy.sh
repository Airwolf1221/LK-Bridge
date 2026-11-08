#!/usr/bin/env bash
# Deploys the commit at the tip of origin/main (or the commit you have checked out) and restarts the bridge.
# Run as the service user:   sudo -u lkbridge /opt/lk-bridge/app/deploy/deploy.sh [options]
#
# Options
#   --current       deploy the commit that is checked out, without fetching or fast-forwarding. This is how you roll
#                   back: `git checkout --detach <sha>` first (docs/runbook-deploy.md, "Rollback").
#   --force         redeploy even though the checkout is already at origin/main.
#   --local-health  health-check only 127.0.0.1:8787 (the public checks need the Caddy block and DNS).
#
# What it does, in order
#   1. Pre-flight: private Node 24, the env file (and a warning, names only, if it has drifted from env.template), a
#      CLEAN checkout (any local change or untracked file stops it), the sudo rule, and that origin/main is a
#      fast-forward of what is checked out. Nothing has changed yet.
#   2. Drains and stops the service: `systemctl stop lk-bridge`. SIGTERM makes the bridge stop taking new work, give
#      running jobs up to 20 s to finish, then exit; unit TimeoutStopSec=45 covers that. Anything still running after the
#      drain is picked up again by the engine's start-up recovery when the service starts.
#   3. Takes a `pre-deploy` database backup (backup.sh).
#   4. git merge --ff-only, npm ci, npm run build, database migrations.
#   5. Starts the service (`systemctl start lk-bridge`) and waits for /healthz.
#   6. Runs healthcheck.sh and prints DEPLOY SUCCEEDED or DEPLOY FAILED.
#
# Why stop instead of using the admin API to drain: /api/admin accepts only the owner's browser session (cookie plus
# CSRF token); it deliberately ignores OAuth tokens and personal access tokens (docs/dashboard.md). A script has no
# such session, and giving it one would mean storing the owner's password or a session cookie on the server. Stopping
# the service gives the same drain through the signal handler, with no credential. The cost is a minute of downtime
# while it rebuilds, which is acceptable for a single-owner bridge. If you want a gentler hand-over, press "Drain" on
# the dashboard's Writers page before you start.
#
# Replacing this very script mid-run is safe: git writes a new file (a new inode) rather than editing in place, and
# bash keeps reading the old one it already has open.
#
# Failure: if anything fails BEFORE the code changes, the old version is started again. Once the checkout has changed
# the service is left stopped and the message says exactly what to run.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
source "${here}/lib.sh"

app_dir="$(cd "${here}/.." && pwd)"
branch="${DEPLOY_BRANCH:-main}"
mode=fetch
force=0
health_args=()
while (($# > 0)); do
  case "$1" in
    --current) mode=current ;;
    --force) force=1 ;;
    --local-health) health_args+=(--local-only) ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed -E 's/^# ?//'
      exit 0
      ;;
    *) die "Unknown option '$1'. See --help." ;;
  esac
  shift
done

# `sudo -n` never prompts: if the rule is missing it fails at once instead of hanging. LKB_SUDO and LKB_SYSTEMCTL exist
# so the script can be exercised on a machine without the service (tests, a dry run).
sudo_cmd=(sudo -n)
if [[ -n "${LKB_SUDO:-}" ]]; then read -ra sudo_cmd <<<"$LKB_SUDO"; fi
systemctl_bin="${LKB_SYSTEMCTL:-/usr/bin/systemctl}"
svc() { "${sudo_cmd[@]}" "$systemctl_bin" "$1" "$LKB_SERVICE"; }

step="starting"
stopped_by_us=0
code_changed=0
prev_sha=""
new_sha=""

on_exit() {
  local rc=$?
  ((rc == 0)) && return 0
  echo >&2
  echo "==================== DEPLOY FAILED (during: ${step}) ====================" >&2
  if ((stopped_by_us)) && ((code_changed == 0)); then
    echo "Nothing was changed. Starting the previous version again ..." >&2
    if svc start; then echo "The previous version is running again." >&2; else echo "Could not start it: run 'sudo systemctl start lk-bridge' as an administrator." >&2; fi
  elif ((stopped_by_us)); then
    echo "The service is STOPPED and the checkout has changed." >&2
    echo "Read what failed above, then either fix it and run deploy.sh --current --force, or roll back:" >&2
    echo "  git -C ${app_dir} checkout --detach ${prev_sha:-<previous-sha>} && ${here}/deploy.sh --current --force" >&2
  else
    echo "Nothing was changed; the service was not touched." >&2
  fi
  echo "Logs: journalctl -u ${LKB_SERVICE} -n 100 --no-pager   (as an administrator)" >&2
  exit "$rc"
}
trap on_exit EXIT

# ---------------------------------------------------------------- 1. pre-flight
step="pre-flight checks"
[[ "$(id -u)" -ne 0 ]] || die "Do not run this as root. Run it as the service user: sudo -u lkbridge ${here}/deploy.sh"
[[ "$(id -un)" == "lkbridge" || -n "${DEPLOY_ANY_USER:-}" ]] || die "Run this as the lkbridge user (sudo -u lkbridge ...), not '$(id -un)'."
use_private_node
[[ -r "$LKB_ENV_FILE" ]] || die "Cannot read ${LKB_ENV_FILE}. Create it from deploy/env.template (runbook, 'The env file')."
# Warn (names only, never values) when the env file and deploy/env.template have drifted apart. Never fails the deploy.
env_drift_report "${here}/env.template" "$LKB_ENV_FILE"
command -v git >/dev/null 2>&1 || die "git is not installed."
cd "$app_dir"
git rev-parse --git-dir >/dev/null 2>&1 || die "${app_dir} is not a git checkout."

if [[ -n "$(git status --porcelain)" ]]; then
  git status --short >&2
  die "The checkout has local changes or untracked files (listed above). Refusing to deploy over them; remove or stash them."
fi
if [[ -z "${LKB_SUDO:-}" ]]; then
  for action in start stop restart status; do
    "${sudo_cmd[@]}" -l "$systemctl_bin" "$action" "$LKB_SERVICE" >/dev/null 2>&1 \
      || die "sudo does not allow 'systemctl ${action} ${LKB_SERVICE}' for $(id -un). Install deploy/sudoers.lk-bridge (runbook, 'The sudo rule')."
  done
fi

prev_sha="$(git rev-parse HEAD)"
if [[ "$mode" == "fetch" ]]; then
  current_branch="$(git symbolic-ref --short -q HEAD || true)"
  [[ "$current_branch" == "$branch" ]] || die "The checkout is on '${current_branch:-a detached HEAD}', not '${branch}'. To deploy that exact commit use --current; to return to ${branch}: git checkout ${branch}."
  log "Fetching origin/${branch} ..."
  git fetch --prune origin "$branch"
  git merge-base --is-ancestor HEAD "origin/${branch}" \
    || die "origin/${branch} is not a fast-forward of the checkout (local commits, or history was rewritten). Refusing to merge."
  new_sha="$(git rev-parse "origin/${branch}")"
else
  new_sha="$prev_sha"
fi

if [[ "$mode" == "fetch" && "$prev_sha" == "$new_sha" && $force -eq 0 && -f dist/server.js ]]; then
  log "Already at origin/${branch} (${prev_sha:0:9}). Nothing to deploy. Use --force to rebuild and restart anyway."
  trap - EXIT
  exit 0
fi

log "Deploying: ${prev_sha:0:9} -> ${new_sha:0:9}  (${mode} mode)"
if [[ "$mode" == "fetch" && "$prev_sha" != "$new_sha" ]]; then git log --oneline "${prev_sha}..${new_sha}" | head -20; fi

db_path="$(env_file_get DB_PATH)"
db_path="${db_path:-${LKB_DATA_DIR}/bridge.db}"
port="$(env_file_get PORT)"
port="${port:-8787}"

# ---------------------------------------------------------------- 2. drain and stop
step="stopping the service (drain)"
log "Stopping ${LKB_SERVICE} (drains for up to 20 s) ..."
stopped_by_us=1
svc stop

# ---------------------------------------------------------------- 3. backup
step="pre-deploy database backup"
if [[ -f "$db_path" ]]; then
  DB_PATH="$db_path" "${here}/backup.sh" pre-deploy
else
  log "No database at ${db_path} yet (first deploy); skipping the backup."
fi

# ---------------------------------------------------------------- 4. code, dependencies, build, migrations
step="updating the checkout"
code_changed=1
if [[ "$mode" == "fetch" ]]; then git merge --ff-only "origin/${branch}"; fi

step="npm ci"
log "Installing dependencies (npm ci) ..."
npm ci --no-audit --no-fund

step="npm run build"
log "Building ..."
npm run build
[[ -f dist/server.js ]] || die "The build produced no dist/server.js."
[[ -f ui/dist/index.html ]] || die "The build produced no ui/dist/index.html."

step="database migrations"
log "Running migrations on ${db_path} ..."
DB_PATH="$db_path" node dist/db/migrate.js

# ---------------------------------------------------------------- 5. start
step="starting the service"
log "Starting ${LKB_SERVICE} ..."
svc start

step="waiting for the bridge to answer"
up=0
for _ in $(seq 1 60); do
  if curl --silent --fail --max-time 2 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
    up=1
    break
  fi
  systemctl is-active --quiet "$LKB_SERVICE" || break
  sleep 1
done
((up)) || die "The bridge did not answer on 127.0.0.1:${port} within 60 s (or exited)."

# ---------------------------------------------------------------- 6. health check
step="health checks"
"${here}/healthcheck.sh" "${health_args[@]}"

# The unit files are installed by hand, not by this script. Say so if this release changed one.
for unit in lk-bridge.service lk-bridge-backup.service lk-bridge-backup.timer; do
  if [[ -f "/etc/systemd/system/${unit}" ]] && ! cmp -s "${here}/${unit}" "/etc/systemd/system/${unit}"; then
    warn "/etc/systemd/system/${unit} differs from deploy/${unit}. An administrator should reinstall it (runbook, 'Updating')."
  fi
done

trap - EXIT
echo
echo "==================== DEPLOY SUCCEEDED ===================="
echo "Now running ${new_sha:0:9} (was ${prev_sha:0:9})."
echo "To go back: git -C ${app_dir} checkout --detach ${prev_sha:0:9} && ${here}/deploy.sh --current --force"

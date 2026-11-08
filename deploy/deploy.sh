#!/usr/bin/env bash
# Deploys the commit at the tip of origin/main (or the commit you have checked out) and restarts the bridge.
#
# Run as root, from the ROOT-OWNED installed copy (v1.0.1, ADR 0020):
#
#   sudo /opt/lk-bridge/bin/deploy.sh [options]
#
# Never run deploy/deploy.sh from the checkout as root: the checkout belongs to the build user, so anything there could
# have been changed by code that ran during a build. This script refuses to run from inside the checkout.
#
# Options
#   --current       deploy the commit that is checked out, without fetching or fast-forwarding. This is how you roll
#                   back: check out the commit first (docs/runbook-deploy.md, "Rollback").
#   --force         redeploy even though the checkout is already at origin/main.
#   --local-health  health-check only 127.0.0.1:8787 (the public checks need the Caddy block and DNS).
#
# Who does what. Root only orchestrates: it never runs git, npm, node or a script from the checkout itself. Every phase
# drops to the user it needs, with `runuser` and a clean environment (`env -i`: no inherited variable, so no secret):
#
#   lkbuild  (owns /opt/lk-bridge/app; cannot read /etc/lk-bridge or /var/lib/lk-bridge)
#            git status / fetch / merge --ff-only, npm ci, npm run build
#   lkbridge (runs the service; reads the env file and the app; writes only /var/lib/lk-bridge; cannot write the app)
#            the pre-deploy backup, the database migrations, the health check, and the stop and start of the service
#            through its narrow sudoers rule (deploy/sudoers.lk-bridge)
#
# What it does, in order
#   1. Pre-flight: root, the installed copy, both users and the layout (lkbuild owns the app and is not in the lkbridge
#      group; the private Node 24 is root-owned), the env file readable by lkbridge (and a warning, names only, if it has
#      drifted from env.template), a CLEAN checkout, the sudo rule, and that origin/main is a fast-forward of what is
#      checked out. Nothing has changed yet.
#   2. Drains and stops the service: `systemctl stop lk-bridge` (as lkbridge, through sudo). SIGTERM makes the bridge
#      stop taking new work, give running jobs up to 20 s to finish, then exit; unit TimeoutStopSec=45 covers that.
#   3. Takes a `pre-deploy` database backup (backup.sh, as lkbridge).
#   4. As lkbuild: git merge --ff-only, npm ci, npm run build; then checks nothing in the app is writable by lkbridge.
#      As lkbridge: the database migrations.
#   5. Starts the service (as lkbridge, through sudo) and waits for /healthz.
#   6. Runs healthcheck.sh as lkbridge (with its permission checks) and prints DEPLOY SUCCEEDED or DEPLOY FAILED.
#
# Why stop instead of using the admin API to drain: /api/admin accepts only the owner's browser session (ADR 0013,
# ADR 0015). Stopping the service gives the same drain through the signal handler, with no credential on the server.
#
# Failure: if anything fails BEFORE the code changes, the old version is started again. Once the checkout has changed
# the service is left stopped and the message says exactly what to run.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
source "${here}/lib.sh"

app_dir="$LKB_APP_DIR"
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

build_user="$LKB_BUILD_USER"
svc_user="$LKB_SERVICE_USER"
build_home="$(getent passwd "$build_user" | cut -d: -f6 || true)"
svc_home="$(getent passwd "$svc_user" | cut -d: -f6 || true)"
node_path="${LKB_NODE_DIR}/bin:/usr/local/bin:/usr/bin:/bin"
# git's SSH for the build user: never prompt (a deploy must not hang), give up on a dead connection. The migration script
# checks GitHub access with exactly this environment (test/unit/deploy-files.test.ts keeps the two in step).
git_ssh_command='ssh -o BatchMode=yes -o ConnectTimeout=15'

# as_build CMD...: runs CMD as the build user in the checkout, with a clean environment and umask 022 (so lkbridge can
# read what it writes and write none of it). LKB_RUNAS exists so tests can exercise the script without two users.
as_build() {
  # shellcheck disable=SC2016 # the inner script's $1 and $@ belong to the inner bash
  ${LKB_RUNAS:-runuser -u} "$build_user" -- env -i HOME="$build_home" USER="$build_user" LOGNAME="$build_user" \
    PATH="$node_path" LANG=C.UTF-8 GIT_SSH_COMMAND="$git_ssh_command" \
    bash -c 'umask 022 && cd "$1" && shift && exec "$@"' lkb-build "$app_dir" "$@"
}

# as_service CMD...: runs CMD as the service user with a clean environment. Only non-secret settings are passed: the
# paths the scripts need (all from lib.sh, overridable for tests). The env file is read by the scripts themselves.
as_service() {
  # shellcheck disable=SC2016 # the inner script's $1 and $@ belong to the inner bash
  ${LKB_RUNAS:-runuser -u} "$svc_user" -- env -i HOME="$svc_home" USER="$svc_user" LOGNAME="$svc_user" \
    PATH="$node_path" LANG=C.UTF-8 \
    LKB_ROOT="$LKB_ROOT" LKB_NODE_DIR="$LKB_NODE_DIR" LKB_RUNTIME_DIR="$LKB_RUNTIME_DIR" LKB_APP_DIR="$LKB_APP_DIR" \
    LKB_BIN_DIR="$LKB_BIN_DIR" LKB_ENV_FILE="$LKB_ENV_FILE" LKB_DATA_DIR="$LKB_DATA_DIR" LKB_SERVICE="$LKB_SERVICE" \
    LKB_BUILD_USER="$LKB_BUILD_USER" LKB_SERVICE_USER="$LKB_SERVICE_USER" \
    ${LKB_SYSTEMCTL:+LKB_SYSTEMCTL="$LKB_SYSTEMCTL"} \
    bash -c 'umask 077 && cd "$1" && shift && exec "$@"' lkb-service "$app_dir" "$@"
}

# The service is stopped and started by lkbridge through its sudoers rule (sudo -n never prompts: a missing rule fails
# at once). LKB_SUDO and LKB_SYSTEMCTL exist so the script can be exercised on a machine without the service.
systemctl_bin="${LKB_SYSTEMCTL:-/usr/bin/systemctl}"
svc() {
  if [[ -n "${LKB_SUDO+set}" ]]; then
    # shellcheck disable=SC2086 # LKB_SUDO is a test seam holding a command prefix (empty: none)
    as_service ${LKB_SUDO} "$systemctl_bin" "$1" "$LKB_SERVICE"
  else
    as_service sudo -n "$systemctl_bin" "$1" "$LKB_SERVICE"
  fi
}

step="starting"
stopped_by_us=0
started_again=0
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
    if svc start; then echo "The previous version is running again." >&2; else echo "Could not start it: run 'sudo systemctl start lk-bridge'." >&2; fi
  elif ((started_again)); then
    echo "The NEW version was started, but a check after the start failed (above). It is still running." >&2
    echo "Fix what failed and run the health check again, or roll back:" >&2
    echo "  sudo runuser -u ${build_user} -- git -C ${app_dir} checkout --detach ${prev_sha:-<previous-sha>}" >&2
    echo "  sudo ${here}/deploy.sh --current --force" >&2
  elif ((stopped_by_us)); then
    echo "The service is STOPPED and the checkout has changed." >&2
    echo "Read what failed above, then either fix it and run deploy.sh --current --force, or roll back:" >&2
    echo "  sudo runuser -u ${build_user} -- git -C ${app_dir} checkout --detach ${prev_sha:-<previous-sha>}" >&2
    echo "  sudo ${here}/deploy.sh --current --force" >&2
  else
    echo "Nothing was changed; the service was not touched." >&2
  fi
  echo "Logs: sudo journalctl -u ${LKB_SERVICE} -n 100 --no-pager" >&2
  exit "$rc"
}
trap on_exit EXIT

# ---------------------------------------------------------------- 1. pre-flight
step="pre-flight checks"
if [[ "$(id -u)" -ne 0 && -z "${LKB_RUNAS:-}" ]]; then
  die "Run this as root, from the installed copy: sudo ${LKB_BIN_DIR}/deploy.sh   (since v1.0.1 the deploy switches to lkbuild and lkbridge itself; 'sudo -u lkbridge deploy.sh' is the old way, see docs/runbook-deploy.md)"
fi
case "$here/" in
  "$app_dir"/*) die "This is the copy inside the checkout, which the build user can change. Run the installed copy: sudo ${LKB_BIN_DIR}/deploy.sh (install or update it as the runbook says)." ;;
esac
if [[ -z "${LKB_RUNAS:-}" ]]; then
  for f in "$here" "${here}/deploy.sh" "${here}/lib.sh"; do
    [[ "$(stat -c '%u' -- "$f")" == 0 ]] || die "${f} is not owned by root. The deploy scripts run as root, so only root may own them."
    [[ $((8#$(stat -c '%a' -- "$f") & 8#022)) -eq 0 ]] || die "${f} is writable by its group or by others. chmod go-w it."
  done
fi
for u in "$build_user" "$svc_user"; do
  id -u "$u" >/dev/null 2>&1 || die "User '${u}' does not exist. An existing install must be migrated first: deploy/migrate-to-build-user.sh (runbook, 'Migrating an existing install to v1.0.1')."
done
[[ -n "$build_home" && -d "$build_home" ]] || die "${build_user} has no home directory."
lkb_in_group "$build_user" "$svc_user" && die "${build_user} is a member of group ${svc_user}, so it could read the env file. Remove it: sudo gpasswd -d ${build_user} ${svc_user}"
[[ -d "$app_dir" ]] || die "${app_dir} does not exist."
[[ "$(stat -c '%U' -- "$app_dir")" == "$build_user" ]] || die "${app_dir} is owned by $(stat -c '%U' -- "$app_dir"), not ${build_user}. Run deploy/migrate-to-build-user.sh first."
# Root runs the private Node once (its version check), so it must be root's: owned by root and writable by nobody else.
if [[ -z "${LKB_RUNAS:-}" && -e "${LKB_NODE_DIR}/bin/node" ]]; then
  [[ "$(stat -L -c '%u' -- "${LKB_NODE_DIR}/bin/node")" == 0 ]] || die "The private Node is not owned by root; reinstall it with deploy/install-node.sh."
  [[ -z "$(find "$LKB_RUNTIME_DIR" ! -type l \( ! -uid 0 -o -perm /022 \) -print -quit 2>/dev/null)" ]] \
    || die "Something under ${LKB_RUNTIME_DIR} is not root's or is writable by others. Reinstall Node with deploy/install-node.sh."
fi
use_private_node
as_service test -r "$LKB_ENV_FILE" || die "${svc_user} cannot read ${LKB_ENV_FILE}. Create it from deploy/env.template (runbook, 'The env file')."
if [[ -z "${LKB_RUNAS:-}" ]] && as_build test -r "$LKB_ENV_FILE"; then
  die "${build_user} can read ${LKB_ENV_FILE}. It must be root:${svc_user} 0640 inside /etc/lk-bridge (root:${svc_user} 0750)."
fi
# Warn (names only, never values) when the env file and deploy/env.template have drifted apart. Never fails.
env_drift_report "${app_dir}/deploy/env.template" "$LKB_ENV_FILE"
command -v git >/dev/null 2>&1 || die "git is not installed."
as_build git rev-parse --git-dir >/dev/null 2>&1 || die "${app_dir} is not a git checkout (or ${build_user} cannot read it)."

dirty="$(as_build git status --porcelain)"
if [[ -n "$dirty" ]]; then
  printf '%s\n' "$dirty" >&2
  die "The checkout has local changes or untracked files (listed above). Refusing to deploy over them; remove or stash them."
fi
if [[ -z "${LKB_SUDO+set}" ]]; then
  for action in start stop restart status; do
    as_service sudo -n -l "$systemctl_bin" "$action" "$LKB_SERVICE" >/dev/null 2>&1 \
      || die "sudo does not allow 'systemctl ${action} ${LKB_SERVICE}' for ${svc_user}. Install deploy/sudoers.lk-bridge (runbook, 'The sudo rule')."
  done
fi

prev_sha="$(as_build git rev-parse HEAD)"
if [[ "$mode" == "fetch" ]]; then
  current_branch="$(as_build git symbolic-ref --short -q HEAD || true)"
  [[ "$current_branch" == "$branch" ]] || die "The checkout is on '${current_branch:-a detached HEAD}', not '${branch}'. To deploy that exact commit use --current; to return to ${branch}: sudo runuser -u ${build_user} -- git -C ${app_dir} checkout ${branch}."
  log "Fetching origin/${branch} (as ${build_user}) ..."
  as_build git fetch --prune origin "$branch"
  as_build git merge-base --is-ancestor HEAD "origin/${branch}" \
    || die "origin/${branch} is not a fast-forward of the checkout (local commits, or history was rewritten). Refusing to merge."
  new_sha="$(as_build git rev-parse "origin/${branch}")"
else
  new_sha="$prev_sha"
fi

if [[ "$mode" == "fetch" && "$prev_sha" == "$new_sha" && $force -eq 0 && -f "${app_dir}/dist/server.js" ]]; then
  log "Already at origin/${branch} (${prev_sha:0:9}). Nothing to deploy. Use --force to rebuild and restart anyway."
  trap - EXIT
  exit 0
fi

log "Deploying: ${prev_sha:0:9} -> ${new_sha:0:9}  (${mode} mode)"
if [[ "$mode" == "fetch" && "$prev_sha" != "$new_sha" ]]; then as_build git log --oneline "${prev_sha}..${new_sha}" | head -20; fi

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
  as_service env DB_PATH="$db_path" "${app_dir}/deploy/backup.sh" pre-deploy
else
  log "No database at ${db_path} yet (first deploy); skipping the backup."
fi

# ---------------------------------------------------------------- 4. code, dependencies, build, migrations
step="updating the checkout"
code_changed=1
if [[ "$mode" == "fetch" ]]; then as_build git merge --ff-only "origin/${branch}"; fi

step="npm ci"
log "Installing dependencies (npm ci, as ${build_user}) ..."
as_build npm ci --no-audit --no-fund

step="npm run build"
log "Building (as ${build_user}) ..."
as_build npm run build
[[ -f "${app_dir}/dist/server.js" ]] || die "The build produced no dist/server.js."
[[ -f "${app_dir}/ui/dist/index.html" ]] || die "The build produced no ui/dist/index.html."

step="checking the app's permissions"
if [[ -z "${LKB_RUNAS:-}" ]]; then
  bad="$(lkb_writable_by "$svc_user" "$app_dir")"
  [[ -z "$bad" ]] || die "${svc_user} could write ${bad} (in the app). Fix: sudo chown -R ${build_user}:${build_user} ${app_dir} && sudo chmod -R go-w ${app_dir}"
fi

step="database migrations"
log "Running migrations on ${db_path} (as ${svc_user}) ..."
as_service env DB_PATH="$db_path" node dist/db/migrate.js

# ---------------------------------------------------------------- 5. start
step="starting the service"
log "Starting ${LKB_SERVICE} ..."
svc start
started_again=1

step="waiting for the bridge to answer"
up=0
for _ in $(seq 1 60); do
  if curl --silent --fail --max-time 2 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
    up=1
    break
  fi
  "$systemctl_bin" is-active --quiet "$LKB_SERVICE" || break
  sleep 1
done
((up)) || die "The bridge did not answer on 127.0.0.1:${port} within 60 s (or exited)."

# ---------------------------------------------------------------- 6. health check
step="health checks"
as_service "${app_dir}/deploy/healthcheck.sh" "${health_args[@]}"

# The unit files, the sudoers file and this script's installed copy are installed by hand, not by this script. Say so if
# this release changed one (compare only; nothing from the checkout is run or installed).
for unit in lk-bridge.service lk-bridge-backup.service lk-bridge-backup.timer; do
  if [[ -f "/etc/systemd/system/${unit}" ]] && ! cmp -s "${app_dir}/deploy/${unit}" "/etc/systemd/system/${unit}"; then
    warn "/etc/systemd/system/${unit} differs from deploy/${unit}. An administrator should reinstall it (runbook, 'Updating')."
  fi
done
for f in deploy.sh lib.sh; do
  if ! cmp -s "${app_dir}/deploy/${f}" "${here}/${f}"; then
    warn "${here}/${f} differs from deploy/${f} in this release. Review the difference (diff ${here}/${f} ${app_dir}/deploy/${f}), then reinstall it (runbook, 'Updating')."
  fi
done

trap - EXIT
echo
echo "==================== DEPLOY SUCCEEDED ===================="
echo "Now running ${new_sha:0:9} (was ${prev_sha:0:9})."
echo "To go back: sudo runuser -u ${build_user} -- git -C ${app_dir} checkout --detach ${prev_sha:0:9} && sudo ${here}/deploy.sh --current --force"

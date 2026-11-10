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
#   --sync-env      if the env file is not in step with this release's deploy/env.template, update it with env-sync
#                   (after the build, with a backup and a boot check) instead of stopping. Asks first unless --yes.
#   --update-self   if the installed deploy scripts differ from this release's, install the release's copies into
#                   /opt/lk-bridge/bin (root:root, 0755 and 0644) and run the new deploy.sh with the same options.
#                   Shows the difference and asks first unless --yes. It also covers the systemd unit: if
#                   /etc/systemd/system/lk-bridge.service differs from this release's deploy/lk-bridge.service, the
#                   difference is shown, the installed copy is backed up (lk-bridge.service.bak.<time>), the release's
#                   is installed (root:root, 0644) and `systemctl daemon-reload` is run, just before the service is
#                   started again, so the deploy's own restart starts it from the new unit (and a deploy with nothing
#                   else to do still restarts). Without --update-self a difference is only warned about, at the end.
#   --yes           answer yes to the questions --sync-env and --update-self ask.
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
#      group; the private Node 24 is root-owned), the env file readable by lkbridge, a CLEAN checkout, the sudo rule, and
#      that origin/main is a fast-forward of what is checked out. Then (OPS1) the installed deploy scripts are compared
#      with the release's own copies (any difference stops the deploy, or --update-self installs them), and the env file
#      with the release's env.template (env-sync --check: any difference stops the deploy, or --sync-env updates the
#      file after the build; a missing secret always stops it with ACTION NEEDED). Nothing has changed yet.
#   2. Drains and stops the service: `systemctl stop lk-bridge` (as lkbridge, through sudo). SIGTERM makes the bridge
#      stop taking new work, give running jobs up to 20 s to finish, then exit; unit TimeoutStopSec=45 covers that.
#   3. Takes a `pre-deploy` database backup (backup.sh, as lkbridge).
#   4. As lkbuild: git merge --ff-only, npm ci, npm run build; then checks nothing in the app is writable by lkbridge.
#      With --sync-env, env-sync updates the env file. As lkbridge: the new build's configuration check on the env file
#      (the boot check; on failure the deploy stops before the database or the service is touched), then the database
#      migrations.
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
sync_env=0
update_self=0
yes=0
health_args=()
orig_args=("$@")
while (($# > 0)); do
  case "$1" in
    --current) mode=current ;;
    --force) force=1 ;;
    --local-health) health_args+=(--local-only) ;;
    --sync-env) sync_env=1 ;;
    --update-self) update_self=1 ;;
    --yes) yes=1 ;;
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

# The installed deploy scripts (OPS1): what --update-self installs, and with which mode.
self_files=(deploy.sh:0755 lib.sh:0644 env-sync.sh:0755 env-sync.mjs:0644)
# A root-only scratch directory (mktemp -d is 0700) for this release's copies of those files and of its env.template,
# read out of git by the build user as text and never run from here.
work_dir="$(mktemp -d)"

# confirm QUESTION: asks on the terminal unless --yes was given; fails on anything but y or yes (and on no input).
confirm() {
  ((yes)) && return 0
  local answer=""
  printf '%s [y/N] ' "$1"
  read -r answer || answer=""
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

step="starting"
stopped_by_us=0
started_again=0
code_changed=0
prev_sha=""
new_sha=""

on_exit() {
  local rc=$?
  rm -rf -- "$work_dir"
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
  for f in "$here" "${here}/deploy.sh" "${here}/lib.sh" "${here}/env-sync.sh" "${here}/env-sync.mjs"; do
    [[ -e "$f" ]] || continue # a missing env-sync file is reported (and installed by --update-self) below
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

# ---------------------------------------------------------------- 1b. the installed deploy scripts (OPS1)
# Compared with the copies in the commit being deployed, so an outdated installed script is never used for a release
# that needs the new one. These files hold no secrets, so the difference is shown in full.
step="checking the installed deploy scripts"
differs=()
for spec in "${self_files[@]}"; do
  f="${spec%%:*}"
  # A release from before a file existed (a rollback to it, say) has nothing to compare it with.
  as_build git cat-file -e "${new_sha}:deploy/${f}" 2>/dev/null || continue
  as_build git show "${new_sha}:deploy/${f}" >"${work_dir}/${f}"
  cmp -s "${work_dir}/${f}" "${here}/${f}" 2>/dev/null || differs+=("$spec")
done
if ((${#differs[@]} > 0)); then
  log "The installed deploy scripts in ${here} differ from the ones in ${new_sha:0:9}:"
  for spec in "${differs[@]}"; do
    f="${spec%%:*}"
    diff -uN --label "installed ${here}/${f}" --label "release ${new_sha:0:9} deploy/${f}" "${here}/${f}" "${work_dir}/${f}" || true
  done
  differ_names="$(printf '%s ' "${differs[@]%%:*}")"
  if ((update_self)); then
    [[ -z "${LKB_SELF_UPDATED:-}" ]] || die "The deploy scripts still differ after --update-self installed them. Install them by hand (runbook, 'Updating')."
    confirm "Install ${differ_names% }into ${here} and run the new deploy.sh?" || die "Nothing was installed or changed."
    for spec in "${differs[@]}"; do
      f="${spec%%:*}"
      if [[ -z "${LKB_RUNAS:-}" ]]; then
        install -o root -g root -m "${spec##*:}" -- "${work_dir}/${f}" "${here}/${f}.new"
      else
        install -m "${spec##*:}" -- "${work_dir}/${f}" "${here}/${f}.new"
      fi
      mv -f -- "${here}/${f}.new" "${here}/${f}"
      log "Installed ${here}/${f}."
    done
    log "Running the new ${here}/deploy.sh with the same options ..."
    rm -rf -- "$work_dir"
    trap - EXIT
    export LKB_SELF_UPDATED=1
    exec "${here}/deploy.sh" "${orig_args[@]}"
  elif [[ "$mode" == "current" ]]; then
    # --current deploys a commit that is already checked out, often an older one (a rollback): never downgrade the
    # scripts that run as root by surprise. Say so, and carry on with the installed copies.
    warn "The installed deploy scripts differ from ${new_sha:0:9}'s (above). Carrying on with the installed ones (--current); add --update-self to install the commit's copies instead."
  else
    die "The installed deploy scripts (${differ_names% }) differ from this release's (difference above). Nothing was changed. Read the difference, then run: sudo ${here}/deploy.sh ${orig_args[*]+${orig_args[*]} }--update-self"
  fi
fi

# ---------------------------------------------------------------- 1b2. the systemd unit (--update-self only)
# The unit is installed by this script only when asked. It is compared with the release's copy here (nothing changes),
# and installed in step 5, between the migrations and the start, so everything before it can still fail with the old
# unit and the old version untouched. The unit holds no secrets, so the difference is shown in full.
unit_name="lk-bridge.service"
unit_installed="${LKB_UNIT_DIR}/${unit_name}"
unit_update=0
if ((update_self)) && [[ -f "$unit_installed" ]] \
  && as_build git cat-file -e "${new_sha}:deploy/${unit_name}" 2>/dev/null; then
  step="checking the installed systemd unit"
  as_build git show "${new_sha}:deploy/${unit_name}" >"${work_dir}/${unit_name}"
  if ! cmp -s "${work_dir}/${unit_name}" "$unit_installed"; then
    log "The installed ${unit_installed} differs from the one in ${new_sha:0:9}:"
    diff -u --label "installed ${unit_installed}" --label "release ${new_sha:0:9} deploy/${unit_name}" "$unit_installed" "${work_dir}/${unit_name}" || true
    confirm "Install the release's ${unit_name} (backing up the installed one) and reload systemd when the service is started again?" \
      || die "Nothing was installed or changed."
    unit_update=1
    if [[ "$mode" == "fetch" && "$prev_sha" == "$new_sha" && $force -eq 0 ]]; then
      log "Already at origin/${branch}, but the unit changes: the service is restarted to apply it."
    fi
  fi
fi

if [[ "$mode" == "fetch" && "$prev_sha" == "$new_sha" && $force -eq 0 && $unit_update -eq 0 && -f "${app_dir}/dist/server.js" ]]; then
  log "Already at origin/${branch} (${prev_sha:0:9}). Nothing to deploy. Use --force to rebuild and restart anyway."
  rm -rf -- "$work_dir"
  trap - EXIT
  exit 0
fi

# ---------------------------------------------------------------- 1c. the env file against this release's template (OPS1)
# env-sync (the installed copy, as root; names only, never a value) compares the env file with the env.template of the
# commit being deployed. Nothing changes here. A missing secret stops the deploy (only the owner can supply it); other
# differences stop it unless --sync-env was given, which applies them after the build, where the new code can check
# the result before anything else changes.
step="checking the env file against this release's env.template"
sync_args=()
env_changes=0
if as_build git cat-file -e "${new_sha}:deploy/env.template" 2>/dev/null && [[ -x "${here}/env-sync.sh" ]]; then
  as_build git show "${new_sha}:deploy/env.template" >"${work_dir}/env.template"
  as_build git show "${new_sha}:package.json" >"${work_dir}/package.json"
  sync_args=(--template "${work_dir}/env.template" --release "$(lkb_release_version "${work_dir}/package.json")")
  set +e
  gate="$(LKB_FROM_DEPLOY=1 "${here}/env-sync.sh" --check "${sync_args[@]}")"
  gate_rc=$?
  set -e
  [[ -z "$gate" ]] || printf '%s
' "$gate"
  case "$gate_rc" in
    0) ;;
    1)
      if grep -q '^ACTION NEEDED' <<<"$gate"; then
        if ((sync_env)); then
          # Only the commented-out placeholder lines: inert for the running version and for this one.
          LKB_FROM_DEPLOY=1 "${here}/env-sync.sh" --placeholders-only --yes --no-boot-check "${sync_args[@]}" || true
        fi
        die "ACTION NEEDED (above): only you can supply these values. Fill them in (sudoedit ${LKB_ENV_FILE}; $( ((sync_env)) && echo 'the placeholder lines are at the end' || echo 'or run this again with --sync-env to add placeholder lines for them')), then run the deploy again. The deploy stopped before changing anything else; the service was not touched."
      fi
      if ((sync_env == 0)); then
        die "The env file is not in step with this release's env.template (above). Nothing was changed. To let the deploy update it (after the build, with a backup and a boot check), run: sudo ${here}/deploy.sh ${orig_args[*]+${orig_args[*]} }--sync-env"
      fi
      confirm "Apply these changes to ${LKB_ENV_FILE} after the build?" || die "Nothing was changed."
      env_changes=1
      ;;
    *) die "env-sync could not check the env file (above). Nothing was changed." ;;
  esac
else
  warn "Not checking the env file against the template: ${new_sha:0:9} has no deploy/env.template, or ${here}/env-sync.sh is not installed."
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

# ---------------------------------------------------------------- 4b. env file and boot check (OPS1)
if ((env_changes)); then
  step="updating the env file (env-sync)"
  log "Updating ${LKB_ENV_FILE} (env-sync; backup first, boot check after) ..."
  LKB_FROM_DEPLOY=1 "${here}/env-sync.sh" --yes "${sync_args[@]}" \
    || die "env-sync did not update the env file (above). If it had changed it, it has put the backup back."
fi
step="boot check (the new build's configuration check)"
if lkb_has_config_check; then
  log "Boot check: the new build's configuration check on ${LKB_ENV_FILE} (as ${svc_user}) ..."
  lkb_config_check "$LKB_ENV_FILE" \
    || die "The new build would refuse the env file (problems above, by name). The database and the service were not touched. Fix the env file, then run: sudo ${here}/deploy.sh --current --force"
else
  log "This build has no configuration check (dist/config/check.js); skipping the boot check."
fi

step="database migrations"
log "Running migrations on ${db_path} (as ${svc_user}) ..."
# v2 A1 (migration 0600): rows written before multi-project support belong to the project the single-project form names
# (LK_PROJECT_ID, and LK_PROJECT_NAME, default "test"). Ids and names only, never a key.
legacy_project_id="$(env_file_get LK_PROJECT_ID)"
legacy_project_name="$(env_file_get LK_PROJECT_NAME)"
as_service env DB_PATH="$db_path" LK_PROJECT_ID="$legacy_project_id" LK_PROJECT_NAME="$legacy_project_name" node dist/db/migrate.js

# ---------------------------------------------------------------- 5. start
if ((unit_update)); then
  step="installing the systemd unit"
  unit_backup="${unit_installed}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  cp --preserve=mode,ownership,timestamps -- "$unit_installed" "$unit_backup"
  log "Backed up ${unit_installed} to ${unit_backup}."
  if [[ -z "${LKB_RUNAS:-}" ]]; then
    install -o root -g root -m 0644 -- "${work_dir}/${unit_name}" "${unit_installed}.new"
  else
    install -m 0644 -- "${work_dir}/${unit_name}" "${unit_installed}.new"
  fi
  mv -f -- "${unit_installed}.new" "$unit_installed"
  log "Installed ${unit_installed}."
  "$systemctl_bin" daemon-reload
  log "Reloaded systemd (daemon-reload); the start below uses the new unit."
fi

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

# The unit files and the sudoers file are installed by hand, not by this script. Say so if this release changed one
# (compare only; nothing from the checkout is run or installed). The deploy scripts themselves were compared in step 1b.
for unit in lk-bridge.service lk-bridge-backup.service lk-bridge-backup.timer; do
  if [[ -f "${LKB_UNIT_DIR}/${unit}" ]] && ! cmp -s "${app_dir}/deploy/${unit}" "${LKB_UNIT_DIR}/${unit}"; then
    warn "${LKB_UNIT_DIR}/${unit} differs from deploy/${unit}. An administrator should reinstall it (runbook, 'Updating')."
  fi
done

rm -rf -- "$work_dir"
trap - EXIT
echo
echo "==================== DEPLOY SUCCEEDED ===================="
echo "Now running ${new_sha:0:9} (was ${prev_sha:0:9})."
echo "To go back: sudo runuser -u ${build_user} -- git -C ${app_dir} checkout --detach ${prev_sha:0:9} && sudo ${here}/deploy.sh --current --force"

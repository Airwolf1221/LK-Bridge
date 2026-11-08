#!/usr/bin/env bash
# One-off migration of an EXISTING install (1.0.0 layout: lkbridge owns and builds the checkout) to the v1.0.1 layout
# (ADR 0020): a separate build user, lkbuild, owns /opt/lk-bridge/app and holds the read-only deploy key, and cannot
# read /etc/lk-bridge or /var/lib/lk-bridge; lkbridge can read and run the app but not write it.
#
# Run it as root from a ROOT-OWNED copy outside the checkout (the checkout is still lkbridge's until this has run):
#
#   sudo install -o root -g root -m 0700 /opt/lk-bridge/app/deploy/migrate-to-build-user.sh /root/migrate-to-build-user.sh
#   sudo /root/migrate-to-build-user.sh --check     # reports what it would do; changes nothing
#   sudo /root/migrate-to-build-user.sh             # does it, then deploys and runs the health check
#
# Options
#   --check         read-only: run every check and say what would change, then stop.
#   --no-deploy     migrate, verify and run the health check, but do not rebuild and restart.
#   --local-health  passed to deploy.sh: health-check only 127.0.0.1:8787.
#
# In order (each step looks before it acts, so running it again is safe; it stops with a clear message, and changes
# nothing more, at anything it does not expect):
#   0. Pre-flight: root, this copy is root's and outside the checkout, the tools, the 1.0.0 layout (lkbridge, the
#      checkout at v1.0.1 or later and clean, the env file, the data directory, the private Node).
#   1. Creates the system user lkbuild (no login shell, no sudo, not in group lkbridge), home /home/lkbuild (0750).
#   2. Moves the read-only GitHub deploy key, its SSH config and the pinned known_hosts from /home/lkbridge/.ssh to
#      /home/lkbuild/.ssh; checks that lkbuild can reach GitHub with it BEFORE removing lkbridge's copy. With no key to
#      move, it stops and says how to add a new one (an owner step on GitHub).
#   3. Ownership and modes: /opt/lk-bridge root 0755; the checkout lkbuild:lkbuild, nothing group- or world-writable;
#      the private Node root's and writable by nobody else; /opt/lk-bridge/bin (root) with the deploy script and its
#      library installed from the checkout; /etc/lk-bridge root:lkbridge 0750 and the env file 0640; /var/lib/lk-bridge
#      lkbridge 0700; /home/lkbridge 0750.
#   4. The sudoers file deploy/sudoers.lk-bridge (unchanged in v1.0.1), validated with `visudo -cf` before it goes live
#      if it differs; and checks that lkbuild has no sudo rights at all.
#   5. Verifies, as each user (runuser): lkbuild cannot read the env file, the database or lkbridge's home, and cannot
#      write the Node runtime; lkbridge cannot write anything in the app or the runtime, and can read the env file and
#      write the data directory.
#   6. Runs a normal deploy (/opt/lk-bridge/bin/deploy.sh --force: rebuilt by lkbuild, restarted, health-checked with
#      the new permission checks). With --no-deploy, only the health check.
set -euo pipefail

: "${LKB_ROOT:=/opt/lk-bridge}"
: "${LKB_APP_DIR:=${LKB_ROOT}/app}"
: "${LKB_BIN_DIR:=${LKB_ROOT}/bin}"
: "${LKB_RUNTIME_DIR:=${LKB_ROOT}/runtime}"
: "${LKB_NODE_DIR:=${LKB_RUNTIME_DIR}/node}"
: "${LKB_ENV_FILE:=/etc/lk-bridge/lk-bridge.env}"
: "${LKB_DATA_DIR:=/var/lib/lk-bridge}"
: "${LKB_SUDOERS_FILE:=/etc/sudoers.d/lk-bridge}"
: "${LKB_BUILD_USER:=lkbuild}"
: "${LKB_SERVICE_USER:=lkbridge}"
# Test seam only: deploy.sh's own seams (LKB_SYSTEMCTL, LKB_SUDO) are passed on when set.
B="$LKB_BUILD_USER"
S="$LKB_SERVICE_USER"
KEY_NAME=lk_bridge_deploy

check=0
deploy=1
deploy_args=()
while (($# > 0)); do
  case "$1" in
    --check) check=1 ;;
    --no-deploy) deploy=0 ;;
    --local-health) deploy_args+=(--local-health) ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed -E 's/^# ?//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown option '$1'. See --help." >&2
      exit 2
      ;;
  esac
  shift
done

log() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() {
  printf '\nSTOPPED: %s\n' "$*" >&2
  printf 'Nothing after this point was changed. Fix the cause and run the migration again (it is safe to re-run).\n' >&2
  exit 1
}
changes=0
# act DESCRIPTION CMD...: runs CMD, or in --check mode only says it would.
act() {
  local what="$1"
  shift
  changes=$((changes + 1))
  if ((check)); then
    log "  would: ${what}"
  else
    log "  ${what}"
    "$@"
  fi
}
# as USER CMD...: CMD as USER with a clean environment (no inherited variable, so no secret).
as() {
  local u="$1" home
  shift
  home="$(getent passwd "$u" | cut -d: -f6)"
  runuser -u "$u" -- env -i HOME="$home" USER="$u" LOGNAME="$u" PATH="${LKB_NODE_DIR}/bin:/usr/bin:/bin" LANG=C.UTF-8 "$@"
}
owner_of() { stat -c '%U' -- "$1"; }
mode_of() { stat -c '%a' -- "$1"; }
in_group() {
  local g
  for g in $(id -Gn "$1" 2>/dev/null); do [[ "$g" == "$2" ]] && return 0; done
  return 1
}

# ------------------------------------------------------------------------------------------------ 0. pre-flight
step "0. Pre-flight (nothing is changed here)"
[[ "$(id -u)" -eq 0 ]] || die "Run this as root: sudo $0"
self="$(readlink -f -- "${BASH_SOURCE[0]}")"
case "$self" in
  "$(readlink -f -- "$LKB_APP_DIR")"/*) die "This copy is inside the checkout, which ${S} can still change. Copy it out first: sudo install -o root -g root -m 0700 ${self} /root/migrate-to-build-user.sh, then run /root/migrate-to-build-user.sh" ;;
esac
[[ "$(stat -c '%u' -- "$self")" == 0 && $((8#$(mode_of "$self") & 8#022)) -eq 0 ]] \
  || die "${self} must be owned by root and writable only by root (sudo chown root:root ${self} && sudo chmod 0700 ${self})."
for tool in useradd runuser visudo install getent git ssh stat find chown chmod sudo cmp; do
  command -v "$tool" >/dev/null 2>&1 || die "'${tool}' is not installed."
done

id -u "$S" >/dev/null 2>&1 || die "There is no user ${S}: this is not an existing install. For a new server follow the runbook from the start."
[[ -d "$LKB_APP_DIR/.git" ]] || die "${LKB_APP_DIR} is not a git checkout."
app_owner="$(owner_of "$LKB_APP_DIR")"
[[ "$app_owner" == "$S" || "$app_owner" == "$B" ]] || die "${LKB_APP_DIR} is owned by '${app_owner}', neither ${S} (1.0.0 layout) nor ${B} (already migrated). Unexpected; check it by hand."
log "Checkout owner: ${app_owner} ($([[ "$app_owner" == "$S" ]] && echo 'not migrated yet' || echo 'already migrated'))"
{ [[ -f "${LKB_APP_DIR}/deploy/migrate-to-build-user.sh" ]] && grep -q 'ADR 0020' "${LKB_APP_DIR}/deploy/deploy.sh"; } \
  || die "The checkout is older than v1.0.1. Update it first, as ${S} (runbook, 'Migrating an existing install to v1.0.1', step 2)."
dirty="$(as "$app_owner" git -C "$LKB_APP_DIR" status --porcelain)"
[[ -z "$dirty" ]] || die "The checkout has local changes or untracked files:
${dirty}
Remove or stash them first (as ${app_owner})."
head_sha="$(as "$app_owner" git -C "$LKB_APP_DIR" rev-parse HEAD)"
remote="$(as "$app_owner" git -C "$LKB_APP_DIR" remote get-url origin)"
log "Checkout at ${head_sha} (origin ${remote})"
[[ -f "$LKB_ENV_FILE" ]] || die "No env file at ${LKB_ENV_FILE}."
[[ -d "$LKB_DATA_DIR" ]] || die "No data directory at ${LKB_DATA_DIR}."
[[ -x "${LKB_NODE_DIR}/bin/node" ]] || die "No private Node at ${LKB_NODE_DIR}/bin/node (deploy/install-node.sh)."
# Everything in the checkout must belong to lkbridge (1.0.0) or lkbuild (an earlier, interrupted run): anything else
# (root, another user) means someone changed it by hand.
owners=(! -uid "$(id -u "$S")")
id -u "$B" >/dev/null 2>&1 && owners+=(! -uid "$(id -u "$B")")
stray="$(find "$LKB_APP_DIR" -xdev ! -type l \( "${owners[@]}" \) -print -quit)"
[[ -z "$stray" ]] || die "Something in ${LKB_APP_DIR} belongs to neither ${S} nor ${B}: ${stray}. Unexpected; check it by hand."

# ------------------------------------------------------------------------------------------------ 1. the build user
step "1. The build user ${B}"
if id -u "$B" >/dev/null 2>&1; then
  log "  ${B} exists (uid $(id -u "$B"))."
  [[ "$(id -u "$B")" -lt 1000 ]] || die "${B} exists but is not a system user (uid $(id -u "$B")). Unexpected; check it by hand."
  for g in "$S" sudo admin adm wheel; do
    in_group "$B" "$g" && die "${B} is a member of group ${g}. It must not be (sudo gpasswd -d ${B} ${g}), then run this again."
  done
else
  act "create system user ${B} (home /home/${B}, no login shell)" \
    useradd --system --user-group --create-home --home-dir "/home/${B}" --shell /usr/sbin/nologin "$B"
fi
B_HOME="$(getent passwd "$B" | cut -d: -f6 || echo "/home/${B}")"
S_HOME="$(getent passwd "$S" | cut -d: -f6)"
if [[ -d "$B_HOME" ]]; then
  [[ "$(owner_of "$B_HOME")" == "$B" ]] || die "${B_HOME} is not owned by ${B}. Unexpected; check it by hand."
  [[ "$(mode_of "$B_HOME")" == 750 ]] || act "chmod 0750 ${B_HOME}" chmod 0750 "$B_HOME"
fi

# ------------------------------------------------------------------------------------------------ 2. the deploy key
step "2. The read-only deploy key"
needs_key=0
[[ "$remote" =~ ^(git@github\.com:|ssh://) ]] && needs_key=1
src="${S_HOME}/.ssh"
dst="${B_HOME}/.ssh"
github_ok() { as "$B" ssh -o BatchMode=yes -o ConnectTimeout=15 -T git@github.com 2>&1 | grep -q 'successfully authenticated'; }
if ((needs_key == 0)); then
  log "  origin is not an SSH URL (${remote}); no deploy key is needed."
elif [[ -f "${dst}/${KEY_NAME}" ]]; then
  log "  ${B} already has the key (${dst}/${KEY_NAME})."
  [[ "$(owner_of "${dst}/${KEY_NAME}")" == "$B" && "$(mode_of "${dst}/${KEY_NAME}")" == 600 ]] \
    || act "fix owner and mode of ${dst}/${KEY_NAME}" sh -c "chown ${B}:${B} '${dst}/${KEY_NAME}' && chmod 0600 '${dst}/${KEY_NAME}'"
  if [[ -e "${src}/${KEY_NAME}" ]]; then
    # An earlier run copied it but stopped before removing lkbridge's copy.
    if ((check)); then
      log "  would: check ${B} reaches GitHub, then remove ${S}'s copy of the key"
    else
      github_ok || die "${B} cannot authenticate to GitHub with ${dst}/${KEY_NAME}; ${S}'s copy was left in place. Check: sudo runuser -u ${B} -- ssh -T git@github.com"
      act "remove ${S}'s copy of the key" rm -f -- "${src}/${KEY_NAME}" "${src}/${KEY_NAME}.pub"
    fi
  fi
elif [[ -f "${src}/${KEY_NAME}" ]]; then
  { [[ -f "${src}/config" ]] && grep -Eq "IdentityFile[[:space:]]+~/\.ssh/${KEY_NAME}\$" "${src}/config"; } \
    || die "${src}/config is missing or does not use ~/.ssh/${KEY_NAME} (the runbook's set-up). Unexpected; move the key by hand or add a new one for ${B} (runbook, 'Migrating', step 'A new deploy key')."
  grep -q '^github.com ' "${src}/known_hosts" 2>/dev/null \
    || die "${src}/known_hosts has no pinned github.com key. Unexpected; pin it as the runbook's step 3 says, then run this again."
  act "create ${dst} (0700)" install -d -o "$B" -g "$B" -m 0700 "$dst"
  act "copy the key to ${dst}/${KEY_NAME} (0600)" install -o "$B" -g "$B" -m 0600 "${src}/${KEY_NAME}" "${dst}/${KEY_NAME}"
  if [[ -f "${src}/${KEY_NAME}.pub" ]]; then
    act "copy the public key" install -o "$B" -g "$B" -m 0644 "${src}/${KEY_NAME}.pub" "${dst}/${KEY_NAME}.pub"
  fi
  act "copy the SSH config (github.com uses the key)" install -o "$B" -g "$B" -m 0600 "${src}/config" "${dst}/config"
  act "copy the pinned known_hosts" install -o "$B" -g "$B" -m 0644 "${src}/known_hosts" "${dst}/known_hosts"
  if ((check)); then
    log "  would: check ${B} reaches GitHub with it, then remove ${S}'s copies"
  else
    github_ok || die "${B} cannot authenticate to GitHub with the copied key; ${S}'s copy was left in place. Check: sudo runuser -u ${B} -- ssh -T git@github.com"
    log "  ${B} reaches GitHub with the key."
    act "remove the key, its config and known_hosts from ${src}" \
      rm -f -- "${src}/${KEY_NAME}" "${src}/${KEY_NAME}.pub" "${src}/config" "${src}/known_hosts"
  fi
else
  die "No deploy key at ${src}/${KEY_NAME} or ${dst}/${KEY_NAME}. Add a new read-only deploy key for ${B} (runbook, 'Migrating', step 'A new deploy key': an owner step on GitHub), then run this again."
fi

# ------------------------------------------------------------------------------------------------ 3. ownership and modes
step "3. Ownership and modes"
[[ "$(owner_of "$LKB_ROOT")" == root && "$(mode_of "$LKB_ROOT")" == 755 ]] \
  || act "${LKB_ROOT}: root:root 0755" sh -c "chown root:root '${LKB_ROOT}' && chmod 0755 '${LKB_ROOT}'"

if ! id -u "$B" >/dev/null 2>&1 \
  || [[ -n "$(find "$LKB_APP_DIR" -xdev ! -type l \( ! -uid "$(id -u "$B")" -o ! -gid "$(id -g "$B")" -o -perm /022 \) -print -quit)" ]]; then
  act "${LKB_APP_DIR}: everything ${B}:${B}, nothing group- or world-writable (readable by all, as before)" \
    sh -c "chown -R -P ${B}:${B} '${LKB_APP_DIR}' && chmod -R u+rwX,go+rX,go-w '${LKB_APP_DIR}'"
else
  log "  ${LKB_APP_DIR} is already ${B}'s and not writable by others."
fi

if [[ -n "$(find "$LKB_RUNTIME_DIR" ! -type l \( ! -uid 0 -o -perm /022 \) -print -quit)" ]]; then
  act "${LKB_RUNTIME_DIR}: root's, writable by nobody else (the private Node)" \
    sh -c "chown -R -P root:root '${LKB_RUNTIME_DIR}' && chmod -R go-w '${LKB_RUNTIME_DIR}'"
else
  log "  ${LKB_RUNTIME_DIR} (the private Node) is root's and writable by nobody else."
fi

[[ -d "$LKB_BIN_DIR" && "$(owner_of "$LKB_BIN_DIR")" == root && "$(mode_of "$LKB_BIN_DIR")" == 755 ]] \
  || act "${LKB_BIN_DIR}: root:root 0755 (the deploy script runs from here, as root)" install -d -o root -g root -m 0755 "$LKB_BIN_DIR"
for f in deploy.sh lib.sh; do
  want_mode=0755
  [[ "$f" == lib.sh ]] && want_mode=0644
  if ! cmp -s "${LKB_APP_DIR}/deploy/${f}" "${LKB_BIN_DIR}/${f}" 2>/dev/null \
    || [[ "$(owner_of "${LKB_BIN_DIR}/${f}")" != root || "$(mode_of "${LKB_BIN_DIR}/${f}")" != "${want_mode#0}" ]]; then
    act "install ${LKB_BIN_DIR}/${f} (root, ${want_mode}) from commit ${head_sha:0:12}" \
      install -o root -g root -m "$want_mode" "${LKB_APP_DIR}/deploy/${f}" "${LKB_BIN_DIR}/${f}"
  else
    log "  ${LKB_BIN_DIR}/${f} is up to date."
  fi
done

etc_dir="$(dirname "$LKB_ENV_FILE")"
[[ "$(stat -c '%U:%G %a' -- "$etc_dir")" == "root:${S} 750" ]] \
  || act "${etc_dir}: root:${S} 0750" sh -c "chown root:${S} '${etc_dir}' && chmod 0750 '${etc_dir}'"
[[ "$(stat -c '%U:%G %a' -- "$LKB_ENV_FILE")" == "root:${S} 640" ]] \
  || act "${LKB_ENV_FILE}: root:${S} 0640" sh -c "chown root:${S} '${LKB_ENV_FILE}' && chmod 0640 '${LKB_ENV_FILE}'"
[[ "$(owner_of "$LKB_DATA_DIR")" == "$S" ]] || die "${LKB_DATA_DIR} is owned by $(owner_of "$LKB_DATA_DIR"), not ${S}. Unexpected; check it by hand."
[[ "$(mode_of "$LKB_DATA_DIR")" == 700 ]] || act "${LKB_DATA_DIR}: 0700" chmod 0700 "$LKB_DATA_DIR"
if [[ -d "${LKB_DATA_DIR}/backups" && "$(mode_of "${LKB_DATA_DIR}/backups")" != 700 ]]; then
  act "${LKB_DATA_DIR}/backups: 0700" chmod 0700 "${LKB_DATA_DIR}/backups"
fi
[[ $((8#$(mode_of "$S_HOME") & 8#007)) -eq 0 ]] || act "${S_HOME}: no access for others (0750)" chmod o-rwx "$S_HOME"

# ------------------------------------------------------------------------------------------------ 4. sudo rules
step "4. sudo rules"
if ! cmp -s "${LKB_APP_DIR}/deploy/sudoers.lk-bridge" "$LKB_SUDOERS_FILE" 2>/dev/null; then
  if ((check)); then
    log "  would: install deploy/sudoers.lk-bridge as ${LKB_SUDOERS_FILE}, after visudo -cf"
    changes=$((changes + 1))
  else
    install -m 0440 -o root -g root "${LKB_APP_DIR}/deploy/sudoers.lk-bridge" "${LKB_SUDOERS_FILE}.new"
    if ! visudo -cf "${LKB_SUDOERS_FILE}.new" >/dev/null; then
      rm -f -- "${LKB_SUDOERS_FILE}.new"
      die "deploy/sudoers.lk-bridge does not pass visudo -cf; nothing was installed."
    fi
    act "install ${LKB_SUDOERS_FILE} (validated)" mv -f -- "${LKB_SUDOERS_FILE}.new" "$LKB_SUDOERS_FILE"
  fi
else
  log "  ${LKB_SUDOERS_FILE} is up to date."
fi
visudo -c >/dev/null || die "visudo -c reports a problem in the sudo configuration. Fix it before anything else."
if id -u "$B" >/dev/null 2>&1 && sudo -n -l -U "$B" 2>/dev/null | grep -q 'may run the following'; then
  die "${B} has sudo rights (sudo -l -U ${B}). It must have none; remove the rule that grants them."
fi
log "  ${B} has no sudo rights; ${S} keeps exactly start, stop, restart and status of lk-bridge."

if ((check)); then
  echo
  log "Check finished: ${changes} change(s) would be made (listed above as 'would'). Nothing was changed."
  log "Step 5 (verification as each user) and step 6 (deploy) run only without --check."
  exit 0
fi

# ------------------------------------------------------------------------------------------------ 5. verify
step "5. Verifying, as each user"
db="$(grep -E '^[[:space:]]*DB_PATH=' "$LKB_ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d "'\"" || true)"
db="${db:-${LKB_DATA_DIR}/bridge.db}"
fails=0
must() {
  local what="$1"
  shift
  if "$@"; then log "  PASS  ${what}"; else
    log "  FAIL  ${what}"
    fails=$((fails + 1))
  fi
}
must_not() {
  local what="$1"
  shift
  if "$@"; then
    log "  FAIL  ${what}"
    fails=$((fails + 1))
  else log "  PASS  ${what}"; fi
}
must_not "${B} cannot read ${LKB_ENV_FILE}" as "$B" test -r "$LKB_ENV_FILE"
must_not "${B} cannot enter ${LKB_DATA_DIR}" as "$B" test -x "$LKB_DATA_DIR"
must_not "${B} cannot read the database" as "$B" test -r "$db"
must_not "${B} cannot read ${S}'s home" as "$B" test -r "$S_HOME"
must_not "${B} cannot write the private Node" as "$B" test -w "${LKB_NODE_DIR}/bin/node"
must "${B} can write the checkout" as "$B" test -w "$LKB_APP_DIR"
must_not "${S} cannot write the checkout's top directory" as "$S" test -w "$LKB_APP_DIR"
must "${S} cannot write anything in the checkout" test -z "$(as "$S" find "$LKB_APP_DIR" -writable -print -quit 2>/dev/null)"
must_not "${S} cannot write the private Node" as "$S" test -w "${LKB_NODE_DIR}/bin/node"
must "${S} can read ${LKB_ENV_FILE}" as "$S" test -r "$LKB_ENV_FILE"
must "${S} can write ${LKB_DATA_DIR}" as "$S" test -w "$LKB_DATA_DIR"
((fails == 0)) || die "${fails} permission check(s) failed (above)."

# ------------------------------------------------------------------------------------------------ 6. deploy
if ((deploy)); then
  step "6. A normal deploy, built by ${B} (${LKB_BIN_DIR}/deploy.sh --force)"
  "${LKB_BIN_DIR}/deploy.sh" --force "${deploy_args[@]}"
else
  step "6. Health check (as ${S}; --no-deploy given)"
  health=()
  for a in "${deploy_args[@]}"; do [[ "$a" == --local-health ]] && health+=(--local-only); done
  as "$S" "${LKB_APP_DIR}/deploy/healthcheck.sh" "${health[@]}"
fi

echo
log "MIGRATION FINISHED. From now on deploy with: sudo ${LKB_BIN_DIR}/deploy.sh"

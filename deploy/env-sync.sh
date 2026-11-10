#!/usr/bin/env bash
# Keeps the bridge's env file in step with deploy/env.template, and moves it to the multi-project form, without anyone
# hand-editing secrets (OPS1, ADR 0024). Run as root, from the ROOT-OWNED installed copy:
#
#   sudo /opt/lk-bridge/bin/env-sync.sh [options]
#
# deploy.sh runs it too: `--check` on every deploy, and the update itself with `deploy.sh --sync-env`.
#
# Options
#   --check              report only; change nothing. Exit status: 0 in step, 1 changes needed (or ACTION NEEDED), 2 error.
#   --yes                apply without asking (otherwise it shows the summary and asks first).
#   --migrate-projects   also move the single-project form (LK_API_KEY, LK_PROJECT_ID, ...) to the multi-project form
#                        (LK_PROJECTS, LK_PROJECT_<NAME>_API_KEY, LK_DEFAULT_PROJECT). Deploy the release first.
#   --template FILE      the template to compare with (default: the checkout's deploy/env.template).
#   --release VERSION    the release named in the notes it writes (default: the checkout's package.json version).
#   --placeholders-only  add only the commented-out placeholders for missing @secret variables (inert in any release).
#   --no-boot-check      skip the configuration check after an edit. Only for a file no built bridge reads yet.
#
# What it does (the template's markers decide; see the top of deploy/env.template):
#   - missing @default and @generate variables are added (with the template's comment); a generated value comes from
#     crypto.randomBytes and is never shown; a blank @generate line is filled in;
#   - missing @secret variables get a commented-out placeholder and "ACTION NEEDED: fill in X"; nothing is invented;
#   - missing @optional variables are added commented out, with their default;
#   - variables the template no longer lists are commented out with a dated note, never deleted;
#   - a value already in the file is never changed (except by --migrate-projects, which moves the key to its new name).
#
# Safety. It prints names, never a value: not one it read, moved or generated. The new file is written next to the old
# one (0600 while it is written), given the old one's owner, group and mode, and renamed over it (atomic). Before that, a
# timestamped backup is made beside it (same owner, group and mode). After the edit the bridge's own configuration check
# runs as the service user (no database, no network); if the edit made the file invalid, the backup is put back.
# The build user never reads or writes the env file: the template is read by root as text, never run.
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
source "${here}/lib.sh"

# die() exits 1; every failure of this script is "error" (2), which --check callers tell apart from "changes needed".
# The temporary files (new and restore copies, beside the env file) never outlive the script.
failing=1
tmp=""
restore_tmp=""
# shellcheck disable=SC2329 # invoked by the EXIT trap below
sync_on_exit() {
  local rc=$?
  [[ -z "$tmp" ]] || rm -f -- "$tmp" "$restore_tmp"
  if ((rc == 1 && failing)); then exit 2; fi
  exit "$rc"
}
trap sync_on_exit EXIT

check=0
yes=0
boot_check=1
template=""
release=""
core_args=()
while (($# > 0)); do
  case "$1" in
    --check) check=1 ;;
    --yes) yes=1 ;;
    --migrate-projects) core_args+=(--migrate-projects) ;;
    --placeholders-only) core_args+=(--placeholders-only) ;;
    --no-boot-check) boot_check=0 ;;
    --template)
      (($# > 1)) || die "--template needs a file."
      template="$2"
      shift
      ;;
    --release)
      (($# > 1)) || die "--release needs a version."
      release="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed -E 's/^# ?//'
      exit 0
      ;;
    *) die "Unknown option '$1'. See --help." ;;
  esac
  shift
done

# ---------------------------------------------------------------- pre-flight (nothing changes here)
if [[ "$(id -u)" -ne 0 && -z "${LKB_RUNAS:-}" ]]; then
  die "Run this as root, from the installed copy: sudo ${LKB_BIN_DIR}/env-sync.sh"
fi
case "$here/" in
  "$LKB_APP_DIR"/*) die "This is the copy inside the checkout, which the build user can change. Run the installed copy: sudo ${LKB_BIN_DIR}/env-sync.sh (runbook, 'Updating')." ;;
esac
env_file="$LKB_ENV_FILE"
env_dir="$(dirname -- "$env_file")"
if [[ -z "${LKB_RUNAS:-}" ]]; then
  for f in "$here" "${here}/env-sync.sh" "${here}/env-sync.mjs" "${here}/lib.sh" "$env_dir" "$env_file"; do
    [[ "$(stat -c '%u' -- "$f")" == 0 ]] || die "${f} is not owned by root."
  done
fi
for f in "$here" "${here}/env-sync.sh" "${here}/env-sync.mjs" "${here}/lib.sh" "$env_dir"; do
  [[ $((8#$(stat -c '%a' -- "$f") & 8#022)) -eq 0 ]] || die "${f} is writable by its group or by others. chmod go-w it."
done
[[ -f "$env_file" && ! -L "$env_file" && ! -L "$env_dir" ]] || die "${env_file} is not a regular file (or it, or its directory, is a symbolic link)."
template="${template:-${LKB_APP_DIR}/deploy/env.template}"
[[ -f "$template" && -r "$template" ]] || die "Cannot read the template ${template}."
release="${release:-$(lkb_release_version "${LKB_APP_DIR}/package.json")}"
[[ "$release" =~ ^[0-9A-Za-z.+-]{1,41}$ ]] || die "--release takes a version such as v1.2.3."
use_private_node

# core [ARGS...]: the planning step (env-sync.mjs, beside this script), with an empty environment. It prints the summary
# (names only) and a final "status: changes=N action_needed=M" line, and exits 0, 1 or 2 like --check.
core() {
  env -i PATH="${LKB_NODE_DIR}/bin:/usr/bin:/bin" LANG=C.UTF-8 \
    node "${here}/env-sync.mjs" --template "$template" --live "$env_file" --release "$release" --label "$env_file" \
    "${core_args[@]}" "$@"
}
status_of() { sed -n "s/^status: .*${1}=\([0-9]*\).*/\1/p" <<<"$2"; }

log "env-sync: ${env_file} against ${template} (${release})"
if ((check)); then
  set +e
  out="$(core)"
  rc=$?
  set -e
  grep -v '^status: ' <<<"$out" || true
  # 0 and 1 count only with the planner's status line: anything else (a crash, say) is an error, never "in step".
  if ((rc > 2)) || { ((rc < 2)) && ! grep -q '^status: changes=[0-9]* action_needed=[0-9]*$' <<<"$out"; }; then
    die "env-sync could not check the env file (above)."
  fi
  failing=0
  exit "$rc"
fi

# ---------------------------------------------------------------- plan, confirm, back up, write
tmp="${env_file}.env-sync.$$.tmp"
restore_tmp="${env_file}.env-sync-restore.$$.tmp"
set +e
out="$(core --out "$tmp")"
rc=$?
set -e
((rc != 2)) || die "env-sync could not plan the update (above). Nothing was changed."
grep -v '^status: ' <<<"$out" || true
changes="$(status_of changes "$out")"
needs="$(status_of action_needed "$out")"
[[ "$changes" =~ ^[0-9]+$ && "$needs" =~ ^[0-9]+$ ]] || die "env-sync gave no status line. Nothing was changed."
if ((changes == 0)); then
  log "Nothing to change in ${env_file}."
  failing=0
  ((needs == 0)) && exit 0
  exit 1
fi
[[ -f "$tmp" ]] || die "env-sync planned changes but wrote no new file. Nothing was changed."
if ((boot_check)) && ! lkb_has_config_check; then
  die "The built bridge in ${LKB_APP_DIR} has no configuration check (dist/config/check.js), so the edit could not be verified. Deploy this release first (sudo ${LKB_BIN_DIR}/deploy.sh), then run this again. Nothing was changed."
fi
if ((yes == 0)); then
  printf 'Apply these changes to %s? A backup is made first. [y/N] ' "$env_file"
  answer=""
  read -r answer || answer=""
  if [[ ! "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]; then
    log "Nothing was changed."
    failing=0
    exit 1
  fi
fi

backup="${env_file}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
n=0
while [[ -e "$backup" || -L "$backup" ]]; do
  n=$((n + 1))
  backup="${env_file}.bak.$(date -u +%Y%m%dT%H%M%SZ).${n}"
done
cp --preserve=mode,ownership,timestamps -- "$env_file" "$backup"
chown --reference="$env_file" -- "$tmp"
chmod --reference="$env_file" -- "$tmp"
sync -- "$tmp" 2>/dev/null || true
mv -f -- "$tmp" "$env_file"
log "Updated ${env_file} (backup: ${backup})."

# restore_backup: puts the backup back the same way (copy beside, then rename over), keeping the backup itself.
restore_backup() {
  cp --preserve=mode,ownership,timestamps -- "$backup" "$restore_tmp"
  mv -f -- "$restore_tmp" "$env_file"
}

# ---------------------------------------------------------------- boot check, restore on failure
if ((boot_check)); then
  log "Boot check: the bridge's configuration check on the new file (as ${LKB_SERVICE_USER}) ..."
  if after="$(lkb_config_check "$env_file" 2>&1)"; then
    log "Boot check passed."
  else
    printf '%s\n' "$after" >&2
    # Restore unless every problem was already there before the edit (a new install still missing its keys, say):
    # the edit must not make the file worse, but it need not fix what it did not touch.
    before="$(lkb_config_check "$backup" 2>&1 || true)"
    new_issues="$(comm -23 <(grep '^issue: ' <<<"$after" | sort -u) <(grep '^issue: ' <<<"$before" | sort -u))"
    if [[ -n "$new_issues" ]] || ! grep -q '^issue: ' <<<"$after"; then
      restore_backup
      [[ -z "$new_issues" ]] || printf 'New since the edit:\n%s\n' "$new_issues" >&2
      die "Boot check FAILED after the edit, so ${env_file} was restored from ${backup}. The bridge was not restarted."
    fi
    warn "The bridge would still refuse to start, for the same reasons as before this edit (above). The edit made nothing worse and is kept; fix those settings by hand."
    needs=$((needs + 1))
  fi
fi

if [[ -z "${LKB_FROM_DEPLOY:-}" ]]; then
  log "The running bridge still has the old settings. To apply the new ones: sudo systemctl restart ${LKB_SERVICE}"
fi
failing=0
((needs == 0)) && exit 0
exit 1

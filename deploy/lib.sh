#!/usr/bin/env bash
# Shared helpers for the deploy scripts. Source it; do not run it.
#
# Nothing here ever prints a secret. The env file is parsed for ONE named variable at a time with grep and sed; it is
# never `source`d, because its values (an Argon2 hash full of `$`, base64 secrets) are not shell-safe.

# Where things live on the server (see docs/runbook-deploy.md). Each can be overridden from the environment, which the
# tests and a dry run on another machine use.
: "${LKB_ROOT:=/opt/lk-bridge}"
: "${LKB_NODE_DIR:=${LKB_ROOT}/runtime/node}"
: "${LKB_ENV_FILE:=/etc/lk-bridge/lk-bridge.env}"
: "${LKB_DATA_DIR:=/var/lib/lk-bridge}"
: "${LKB_SERVICE:=lk-bridge}"
: "${LKB_RUNTIME_DIR:=${LKB_ROOT}/runtime}"
: "${LKB_APP_DIR:=${LKB_ROOT}/app}"
: "${LKB_BIN_DIR:=${LKB_ROOT}/bin}"
# Where the systemd unit files are installed (tests point it at a temporary directory).
: "${LKB_UNIT_DIR:=/etc/systemd/system}"
# v1.0.1 (ADR 0020): two users. LKB_BUILD_USER owns the checkout and builds it, and cannot read the secrets;
# LKB_SERVICE_USER runs the bridge, reads the env file and the app, and writes only the data directory.
: "${LKB_BUILD_USER:=lkbuild}"
: "${LKB_SERVICE_USER:=lkbridge}"

log() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# env_file_get NAME [FILE]: prints the value of NAME from the env file (the last assignment wins), without its
# surrounding single or double quotes. Prints nothing, and succeeds, when the file or the variable is absent.
env_file_get() {
  local name="$1" file="${2:-$LKB_ENV_FILE}" line
  [[ -r "$file" ]] || return 0
  line="$(grep -E "^[[:space:]]*${name}=" "$file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  line="${line#*=}"
  # Trim surrounding whitespace, then one pair of matching quotes.
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  if [[ "$line" =~ ^\'(.*)\'$ ]] || [[ "$line" =~ ^\"(.*)\"$ ]]; then
    line="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$line"
}

# sandbox_project_env NAME: for the sandbox, soak, spike and round-trip wrappers (v2 A1; OPS2 hotfix). Exports only
# DB_PATH (the bridge's database, which says whether NAME is a registered sandbox and holds the encrypted keys) and
# LKB_ENV_FILE (the env file's PATH). It reads no key: the script finds NAME's key exactly as the running bridge does
# (test/sandbox/target.ts): the key in the bridge's encrypted store, opened with SECRETS_MASTER_KEY from the env file,
# or, only when nothing is stored for NAME, the env file's LK_PROJECT_<NAME>_API_KEY (LK_API_KEY in the single-project
# form). The script reads just those few names from the file, so no key or master key is ever put in an environment.
# It refuses a project that is not registered and marked as a sandbox, and one with a key in neither place. A key the
# caller's own environment holds is dropped, so it can never stand in for the bridge's. Prints nothing.
sandbox_project_env() {
  local name="$1" db_path var
  [[ -n "$name" ]] || die "Name the sandbox project: --project <name> (a project the bridge has registered and that is marked as a sandbox: npm run projects -- list)."
  [[ "$name" =~ ^[a-z][a-z0-9_]{0,31}$ ]] || die "\"${name}\" is not a project name (lowercase letter first, then lowercase letters, digits or underscores)."
  [[ -r "$LKB_ENV_FILE" ]] || die "Cannot read ${LKB_ENV_FILE}: run this as the service user (sudo -u ${LKB_SERVICE_USER} ...), which reads the env file and the bridge's database."
  for var in $(compgen -e); do
    if [[ "$var" =~ ^(LK_PROJECT_[A-Z0-9_]+_API_KEY|LK_API_KEY|SECRETS_MASTER_KEY|SECRETS_MASTER_KEY_PREVIOUS)$ ]]; then
      unset "$var"
    fi
  done
  db_path="$(env_file_get DB_PATH)"
  export DB_PATH="${db_path:-${LKB_DATA_DIR}/bridge.db}"
  # Absolute: the wrappers change directory before the script reads it.
  LKB_ENV_FILE="$(readlink -f -- "$LKB_ENV_FILE")"
  export LKB_ENV_FILE
}

# use_private_node: puts the bridge's private Node first on PATH and checks it is the real thing.
use_private_node() {
  [[ -x "${LKB_NODE_DIR}/bin/node" ]] || die "Private Node not found at ${LKB_NODE_DIR}/bin/node. Run deploy/install-node.sh (as root) first."
  export PATH="${LKB_NODE_DIR}/bin:${PATH}"
  local v
  v="$(node --version)"
  [[ "$(command -v node)" == "${LKB_NODE_DIR}/bin/node" ]] || die "node on PATH is not the private one."
  [[ "$v" == v24.* ]] || die "Private Node is ${v}; the bridge needs Node 24."
}

# env_names FILE [active]: the variable names a file mentions, one per line, sorted. Every `NAME=` line counts, and a
# commented `# NAME=` line too (an optional setting shown with its default), unless the second argument is `active`.
# Only names are read; values are never printed.
env_names() {
  local file="$1" pattern='^[[:space:]]*#?[[:space:]]*[A-Z][A-Z0-9_]*='
  [[ "${2:-}" == active ]] && pattern='^[[:space:]]*[A-Z][A-Z0-9_]*='
  grep -oE "$pattern" "$file" | sed -E 's/^[[:space:]]*#?[[:space:]]*//; s/=$//' | sort -u || true
}

# env_drift_report [TEMPLATE] [LIVE]: compares the live env file with deploy/env.template, by NAME only, and prints a
# WARNING for each difference that matters. It never prints a value and never fails (it always returns 0):
#   - a variable the template sets that the live file does not set (the bridge uses its default, or refuses to start);
#   - an optional setting the template lists (as `# NAME=…`) that the live file does not mention at all (a release
#     added it; copy the commented line across to keep the file in step);
#   - a variable the live file sets that the template no longer lists (a release removed it; the bridge ignores it).
#
# v2 A1: the project variables are judged by their own rules, not by the template's names: each project in LK_PROJECTS
# needs its LK_PROJECT_<NAME>_API_KEY, a key line for a project not listed is ignored by the bridge, the single-project
# form (LK_API_KEY, LK_PROJECT_ID, LK_PROJECT_NAME) still works but should be moved off, and the sandbox settings are
# retired. Only names are ever printed.
env_drift_report() {
  local template="${1:-$(dirname "${BASH_SOURCE[0]}")/env.template}" live="${2:-$LKB_ENV_FILE}"
  if [[ ! -r "$template" || ! -r "$live" ]]; then
    warn "env drift check skipped: cannot read ${template} or ${live}."
    return 0
  fi
  local name count=0
  # Names judged by the project rules below rather than by the template.
  local special='^(LK_PROJECT_[A-Z0-9_]+_API_KEY|LK_API_KEY|LK_PROJECT_ID|LK_PROJECT_NAME|LK_SANDBOX_API_KEY|LK_SANDBOX_PROJECT_ID)$'
  while IFS= read -r name; do
    [[ -n "$name" && ! "$name" =~ $special ]] || continue
    warn "${live} does not set ${name}, which deploy/env.template sets. Add it (see the template) or the default applies."
    count=$((count + 1))
  done < <(comm -23 <(env_names "$template" active) <(env_names "$live" active))
  while IFS= read -r name; do
    [[ -n "$name" && ! "$name" =~ $special ]] || continue
    warn "${live} does not mention the optional setting ${name} (new in deploy/env.template). Copy its commented line across to keep the file in step."
    count=$((count + 1))
  done < <(comm -23 <(comm -13 <(env_names "$template" active) <(env_names "$template")) <(env_names "$live"))
  while IFS= read -r name; do
    [[ -n "$name" && ! "$name" =~ $special ]] || continue
    warn "${live} sets ${name}, which deploy/env.template no longer lists: the bridge ignores it. Remove the line."
    count=$((count + 1))
  done < <(comm -13 <(env_names "$template") <(env_names "$live" active))
  _env_project_drift "$live" || count=$((count + $?))
  if ((count == 0)); then log "Env file matches deploy/env.template (names only checked)."; fi
  return 0
}

# _env_project_drift LIVE: the project rules of env_drift_report. Returns the number of warnings (0 = none).
_env_project_drift() {
  local live="$1" listed name var n=0
  local -a names=()
  listed="$(env_file_get LK_PROJECTS "$live")"
  local active
  active="$(env_names "$live" active)"
  if [[ -n "$listed" ]]; then
    for name in ${listed//,/ }; do
      name="${name,,}"
      if [[ ! "$name" =~ ^[a-z][a-z0-9_]{0,31}$ ]]; then
        warn "${live}: LK_PROJECTS lists a name that is not a valid project name. The bridge will refuse to start."
        n=$((n + 1))
        continue
      fi
      names+=("$name")
      var="LK_PROJECT_${name^^}_API_KEY"
      # OPS2: a key line commented out (retired into the encrypted store) is fine; one never mentioned is worth a word.
      if ! grep -qxF "$var" <<<"$active" && ! grep -qxF "$var" <<<"$(env_names "$live")"; then
        warn "${live}: LK_PROJECTS lists project ${name} but the file does not set ${var}. The bridge serves it only if its key is in the encrypted store (added on the dashboard)."
        n=$((n + 1))
      fi
    done
    while IFS= read -r var; do
      [[ "$var" =~ ^LK_PROJECT_([A-Z0-9_]+)_API_KEY$ ]] || continue
      name="${BASH_REMATCH[1],,}"
      if [[ " ${names[*]} " != *" ${name} "* ]]; then
        warn "${live} sets ${var}, but LK_PROJECTS does not list project ${name}: the bridge ignores it. List the project or remove the line."
        n=$((n + 1))
      fi
    done <<<"$active"
    for var in LK_API_KEY LK_PROJECT_ID LK_PROJECT_NAME; do
      if grep -qxF "$var" <<<"$active"; then
        warn "${live} sets ${var}, which the bridge ignores because LK_PROJECTS is set (the single-project form). Remove the line."
        n=$((n + 1))
      fi
    done
  elif grep -qxF LK_API_KEY <<<"$active" || grep -qxF LK_PROJECT_ID <<<"$active"; then
    warn "${live} uses the single-project form (LK_API_KEY, LK_PROJECT_ID), which still works but is deprecated. Move to LK_PROJECTS, LK_PROJECT_<NAME>_API_KEY and LK_DEFAULT_PROJECT (runbook, \"Moving to several projects (v2 A1)\")."
    n=$((n + 1))
  fi
  for var in LK_SANDBOX_API_KEY LK_SANDBOX_PROJECT_ID; do
    if grep -qxF "$var" <<<"$active"; then
      warn "${live} sets ${var}, which is retired (v2 A1): the sandbox, soak and spike scripts take --project <name> instead. Remove the line."
      n=$((n + 1))
    fi
  done
  return "$n"
}

# ------------------------------------------------------------------------------------- permissions (v1.0.1, ADR 0020)

# lkb_user_can USER r|w|x PATH: succeeds when USER would be allowed to read, write or execute (search) PATH, judged from
# owners, groups and mode bits along the whole path (every parent directory needs search permission). Needs no
# privileges, so the health check can run it as the service user. It does not know about ACLs: lkb_has_acl says whether
# one is present, and callers treat that as "check by hand". Root is not special-cased; do not ask about root.
lkb_user_can() {
  local user="$1" want="$2" path="$3" uid groups
  uid="$(id -u "$user" 2>/dev/null)" || return 1
  groups=" $(id -G "$user" 2>/dev/null) "
  local p="$path" parts=() dir
  # The parents, from / down, each need x; the target needs the asked-for bit.
  dir="$(dirname -- "$p")"
  while [[ "$dir" != "/" && "$dir" != "." ]]; do
    parts=("$dir" "${parts[@]}")
    dir="$(dirname -- "$dir")"
  done
  local d
  for d in "${parts[@]}"; do
    _lkb_bit "$uid" "$groups" x "$d" || return 1
  done
  _lkb_bit "$uid" "$groups" "$want" "$p"
}

# _lkb_bit UID " GIDS " r|w|x PATH: the one permission class (owner, group or other) that applies to UID, as the kernel
# chooses it (the first that matches, not the most generous).
_lkb_bit() {
  local uid="$1" groups="$2" want="$3" path="$4" st owner group mode bits
  st="$(stat -L -c '%u %g %a' -- "$path" 2>/dev/null)" || return 1
  read -r owner group mode <<<"$st"
  mode=$((8#$mode))
  if [[ "$owner" == "$uid" ]]; then
    bits=$(((mode >> 6) & 7))
  elif [[ "$groups" == *" ${group} "* ]]; then
    bits=$(((mode >> 3) & 7))
  else
    bits=$((mode & 7))
  fi
  case "$want" in
    r) ((bits & 4)) ;;
    w) ((bits & 2)) ;;
    x) ((bits & 1)) ;;
    *) return 1 ;;
  esac
}

# lkb_has_acl PATH: succeeds when PATH carries a POSIX ACL (ls shows a "+" after the mode), which mode bits do not show.
lkb_has_acl() {
  if command -v getfacl >/dev/null 2>&1; then
    [[ -n "$(getfacl --skip-base --absolute-names -- "$1" 2>/dev/null)" ]]
    return
  fi
  local m
  # shellcheck disable=SC2012 # one known path; only the mode column is read
  m="$(ls -ld -- "$1" 2>/dev/null | awk '{print $1}')"
  [[ "$m" == *+ ]]
}

# lkb_in_group USER GROUP: succeeds when USER is a member of GROUP (primary or supplementary).
lkb_in_group() {
  local g
  for g in $(id -Gn "$1" 2>/dev/null); do [[ "$g" == "$2" ]] && return 0; done
  return 1
}

# lkb_writable_by USER DIR: prints the first path under DIR (DIR included) that USER could write by its mode bits, or
# nothing. Owned by USER, or group-writable by one of USER's groups, or writable by anyone. Symlinks are not followed.
lkb_writable_by() {
  local user="$1" dir="$2" uid g expr=()
  uid="$(id -u "$user" 2>/dev/null)" || return 0
  expr=(-uid "$uid" -o -perm -o+w)
  for g in $(id -G "$user"); do expr+=(-o \( -gid "$g" -perm -g+w \)); done
  find "$dir" \( -type f -o -type d \) \( "${expr[@]}" \) -print -quit 2>/dev/null
}

# ---------------------------------------------------------------------------------------- env file and boot check (OPS1)

# lkb_config_check ENV_FILE: the bridge's own configuration check (`npm run config:check`, dist/config/check.js) on
# ENV_FILE, run as the service user with an empty environment, from the built app. No database, no network. Prints one
# `issue: NAME: …` line per problem (names, never values) and fails when the bridge would refuse to start.
# LKB_RUNAS, as in deploy.sh, lets the tests run it without a second user.
lkb_config_check() {
  local file="$1" home
  home="$(getent passwd "$LKB_SERVICE_USER" | cut -d: -f6 || true)"
  # shellcheck disable=SC2016 # the inner script's $1 and $2 belong to the inner bash
  ${LKB_RUNAS:-runuser -u} "$LKB_SERVICE_USER" -- env -i HOME="${home:-/}" USER="$LKB_SERVICE_USER" \
    LOGNAME="$LKB_SERVICE_USER" PATH="${LKB_NODE_DIR}/bin:/usr/bin:/bin" LANG=C.UTF-8 \
    bash -c 'umask 077 && cd "$1" && exec node dist/config/check.js --file "$2"' lkb-config-check "$LKB_APP_DIR" "$file"
}

# lkb_has_config_check: succeeds when the built app has the configuration check (releases from OPS1 on).
lkb_has_config_check() { [[ -f "${LKB_APP_DIR}/dist/config/check.js" ]]; }

# lkb_secrets_tool MODE ENV_FILE: the bridge's own view of its encrypted store (OPS2, dist/secrets/env-tool.js), run as
# the service user with an empty environment, like the configuration check. MODE `compare` prints one
# `<verdict> <NAME>` line per env value the store can hold (equal, superseded, differs, not_stored, unreadable); MODE
# `status` prints `stored=<n> available=<yes|no>`. Names and verdicts only, never a value.
lkb_secrets_tool() {
  local mode="$1" file="$2" home
  home="$(getent passwd "$LKB_SERVICE_USER" | cut -d: -f6 || true)"
  # shellcheck disable=SC2016 # the inner script's $1, $2 and $3 belong to the inner bash
  ${LKB_RUNAS:-runuser -u} "$LKB_SERVICE_USER" -- env -i HOME="${home:-/}" USER="$LKB_SERVICE_USER" \
    LOGNAME="$LKB_SERVICE_USER" PATH="${LKB_NODE_DIR}/bin:/usr/bin:/bin" LANG=C.UTF-8 \
    bash -c 'umask 077 && cd "$1" && exec node dist/secrets/env-tool.js --file "$2" "$3"' lkb-secrets-tool "$LKB_APP_DIR" "$file" "$mode"
}

# lkb_has_secrets_tool: succeeds when the built app has the secret store's tool (releases from OPS2 on).
lkb_has_secrets_tool() { [[ -f "${LKB_APP_DIR}/dist/secrets/env-tool.js" ]]; }

# lkb_release_version FILE: the "version" of a package.json (text read as data, never run), as vX.Y.Z; "unknown" if none.
lkb_release_version() {
  local v
  v="$(grep -m1 -oE '"version"[[:space:]]*:[[:space:]]*"[0-9A-Za-z.+-]{1,40}"' "$1" 2>/dev/null | sed -E 's/.*"([^"]+)"$/\1/' || true)"
  printf 'v%s' "${v:-unknown}"
}

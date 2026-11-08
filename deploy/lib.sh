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
env_drift_report() {
  local template="${1:-$(dirname "${BASH_SOURCE[0]}")/env.template}" live="${2:-$LKB_ENV_FILE}"
  if [[ ! -r "$template" || ! -r "$live" ]]; then
    warn "env drift check skipped: cannot read ${template} or ${live}."
    return 0
  fi
  local name count=0
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    warn "${live} does not set ${name}, which deploy/env.template sets. Add it (see the template) or the default applies."
    count=$((count + 1))
  done < <(comm -23 <(env_names "$template" active) <(env_names "$live" active))
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    warn "${live} does not mention the optional setting ${name} (new in deploy/env.template). Copy its commented line across to keep the file in step."
    count=$((count + 1))
  done < <(comm -23 <(comm -13 <(env_names "$template" active) <(env_names "$template")) <(env_names "$live"))
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    warn "${live} sets ${name}, which deploy/env.template no longer lists: the bridge ignores it. Remove the line."
    count=$((count + 1))
  done < <(comm -13 <(env_names "$template") <(env_names "$live" active))
  if ((count == 0)); then log "Env file matches deploy/env.template (names only checked)."; fi
  return 0
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

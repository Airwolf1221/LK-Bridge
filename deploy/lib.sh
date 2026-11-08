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

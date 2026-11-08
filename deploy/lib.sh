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

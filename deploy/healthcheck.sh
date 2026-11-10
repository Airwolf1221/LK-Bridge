#!/usr/bin/env bash
# Health checks for a running bridge, run from the server itself. Prints PASS or FAIL for each check and exits 1 if
# any failed.
#
#   healthcheck.sh [--local-only] [--via-loopback] [--url https://host] [--wait SECONDS]
#
#   --local-only    only check that 127.0.0.1:8787 answers (use before Caddy has the site block)
#   --via-loopback  make the public checks connect to 127.0.0.1:443 (still through Caddy and TLS, with the right name).
#                   Use it if the server cannot reach its own public address ("hairpin" NAT).
#   --url           the public URL (default: BRIDGE_PUBLIC_URL from the env file, else https://lk.ottomoons.co.uk)
#   --wait SECONDS  before the first check, wait up to this long for the bridge to answer on 127.0.0.1 (/healthz),
#                   retrying every second, so a check straight after a restart does not report false failures. Default
#                   30, or LKB_HEALTH_WAIT from the environment; 0 does not wait. One line says how long it waited. If
#                   the bridge never answers, the checks below run anyway and report it.
#
# It sends no credentials and prints no response bodies. When it can read the env file it also warns, by variable NAME
# only, if the file has drifted from deploy/env.template.
#
# Permission checks (v1.0.1, ADR 0020), run in every mode: the build user (lkbuild) cannot read the env file or the data
# directory and is not in the lkbridge group; the service user (lkbridge) cannot write anything in the app; the private
# Node is root's and writable by neither. Run it as lkbridge (deploy.sh does), which makes the write check exact.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
source "${here}/lib.sh"

local_only=0
via_loopback=0
public_url=""
wait_seconds="${LKB_HEALTH_WAIT:-30}"
while (($# > 0)); do
  case "$1" in
    --local-only) local_only=1 ;;
    --via-loopback) via_loopback=1 ;;
    --url)
      shift
      public_url="${1:-}"
      ;;
    --wait)
      shift
      wait_seconds="${1:-}"
      ;;
    *)
      echo "usage: healthcheck.sh [--local-only] [--via-loopback] [--url https://host] [--wait SECONDS]" >&2
      exit 2
      ;;
  esac
  shift
done

command -v curl >/dev/null 2>&1 || die "curl is required."
[[ "$wait_seconds" =~ ^[0-9]{1,4}$ ]] || die "--wait (or LKB_HEALTH_WAIT) must be a whole number of seconds, not '${wait_seconds}'."

port="$(env_file_get PORT)"
port="${port:-8787}"
[[ -n "$public_url" ]] || public_url="${BRIDGE_PUBLIC_URL:-$(env_file_get BRIDGE_PUBLIC_URL)}"
public_url="${public_url:-https://lk.ottomoons.co.uk}"
public_url="${public_url%/}"
host="${public_url#https://}"
host="${host%%/*}"

curl_opts=(--silent --show-error --max-time 10 --connect-timeout 5)
if ((via_loopback)); then
  curl_opts+=(--resolve "${host}:443:127.0.0.1")
fi

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() {
  printf 'FAIL  %s: %s\n' "$1" "$2"
  failures=$((failures + 1))
}

# One request, headers only: sets $status, $headers (lower-cased names, CR removed) and $location.
fetch_headers() { # method url [curl args...]
  local method="$1" url="$2"
  shift 2
  local out
  if ! out="$(curl "${curl_opts[@]}" --output /dev/null --dump-header - --request "$method" "$@" "$url" 2>&1)"; then
    status="000"
    headers="$out"
    location=""
    return 1
  fi
  out="$(printf '%s' "$out" | tr -d '\r')"
  status="$(printf '%s\n' "$out" | grep -E '^HTTP/' | tail -n 1 | awk '{print $2}')"
  headers="$(printf '%s\n' "$out" | sed -E 's/^([A-Za-z0-9-]+):/\L\1:/')"
  location="$(printf '%s\n' "$headers" | grep -E '^location:' | head -n 1 | sed -E 's/^location:[[:space:]]*//' || true)"
  return 0
}

# 0. Wait for the bridge to be ready (a check straight after a restart would otherwise report false failures): retry
# /healthz every second for up to $wait_seconds. It always prints one line saying how long it waited. A bridge that
# never answers is not an error here: check 1 below reports it.
wait_for_bridge() {
  # Milliseconds from EPOCHREALTIME (bash 5), so the whole seconds printed are not off by one at a clock tick; $SECONDS
  # is the fallback.
  local started waited
  now_ms() {
    if [[ -n "${EPOCHREALTIME:-}" ]]; then
      local t="${EPOCHREALTIME/[.,]/}"
      echo $((t / 1000))
    else
      echo $((SECONDS * 1000))
    fi
  }
  started="$(now_ms)"
  while :; do
    if curl --silent --max-time 3 --connect-timeout 2 "http://127.0.0.1:${port}/healthz" 2>/dev/null | grep -q '"ok":true'; then
      waited=$((($(now_ms) - started) / 1000))
      printf 'Waited %s s for the bridge to answer on 127.0.0.1:%s (ready).\n' "$waited" "$port"
      return 0
    fi
    waited=$((($(now_ms) - started) / 1000))
    if ((waited >= wait_seconds)); then
      if ((wait_seconds == 0)); then
        printf 'Did not wait for the bridge (--wait 0); it is not answering on 127.0.0.1:%s yet.\n' "$port"
      else
        printf 'Waited %s s for the bridge to answer on 127.0.0.1:%s; it did not (the checks below will say).\n' "$waited" "$port"
      fi
      return 0
    fi
    sleep 1
  done
}
wait_for_bridge

# 1. The bridge itself answers on the loopback port.
name="bridge answers on 127.0.0.1:${port} (/healthz)"
body="$(curl "${curl_opts[@]}" --write-out '\n%{http_code}' "http://127.0.0.1:${port}/healthz" 2>&1 || true)"
code="$(printf '%s\n' "$body" | tail -n 1)"
if [[ "$code" == "200" ]] && printf '%s' "$body" | grep -q '"ok":true'; then
  pass "$name"
else
  fail "$name" "got HTTP ${code:-none}"
fi

# 1b. Permissions (v1.0.1, ADR 0020). Judged from owners, groups and modes, so no privilege is needed; exact for the
# write check when run as the service user (find -writable asks the kernel). An ACL anywhere on the way is a FAIL:
# mode bits cannot show what it allows, so check it by hand.
check_permissions() {
  local b="$LKB_BUILD_USER" s="$LKB_SERVICE_USER" name db hit p
  db="$(env_file_get DB_PATH)"
  db="${db:-${LKB_DATA_DIR}/bridge.db}"

  name="${b} exists and is not in group ${s}"
  if ! id -u "$b" >/dev/null 2>&1; then
    fail "$name" "no user ${b}: this install has not been migrated (deploy/migrate-to-build-user.sh)"
    return 0
  elif lkb_in_group "$b" "$s"; then
    fail "$name" "${b} is in group ${s}, so it can read the env file"
  else
    pass "$name"
  fi

  for p in "$(dirname "$LKB_ENV_FILE")" "$LKB_ENV_FILE" "$LKB_DATA_DIR"; do
    if lkb_has_acl "$p"; then fail "no ACL on ${p}" "it has an ACL; mode bits cannot show what it allows (getfacl ${p})"; fi
  done

  name="${b} cannot read the secrets (${LKB_ENV_FILE})"
  if lkb_user_can "$b" r "$LKB_ENV_FILE"; then fail "$name" "it can; the file must be root:${s} 0640 in a root:${s} 0750 directory"; else pass "$name"; fi

  name="${b} cannot read the database (${LKB_DATA_DIR})"
  if lkb_user_can "$b" x "$LKB_DATA_DIR" || lkb_user_can "$b" r "$LKB_DATA_DIR" || lkb_user_can "$b" r "$db"; then
    fail "$name" "it can; ${LKB_DATA_DIR} must be ${s}:${s} 0700"
  else
    pass "$name"
  fi

  name="${s} cannot write the app (${LKB_APP_DIR})"
  if [[ "$(id -un)" == "$s" ]]; then
    hit="$(find "$LKB_APP_DIR" -writable -print -quit 2>/dev/null || true)"
  else
    hit="$(lkb_writable_by "$s" "$LKB_APP_DIR")"
  fi
  if [[ -n "$hit" ]]; then fail "$name" "it can write ${hit}; fix: sudo chown -R ${b}:${b} ${LKB_APP_DIR} && sudo chmod -R go-w ${LKB_APP_DIR}"; else pass "$name"; fi

  name="${s} can read the app and the env file"
  if lkb_user_can "$s" r "${LKB_APP_DIR}/dist/server.js" && lkb_user_can "$s" r "$LKB_ENV_FILE"; then pass "$name"; else fail "$name" "the service could not start; check the modes of ${LKB_APP_DIR} and ${LKB_ENV_FILE}"; fi

  name="the private Node (${LKB_RUNTIME_DIR}) is root's and writable by neither user"
  hit="$(find "$LKB_RUNTIME_DIR" ! -type l \( ! -uid 0 -o -perm /022 \) -print -quit 2>/dev/null || true)"
  if [[ -n "$hit" ]]; then fail "$name" "${hit} is not root's or is writable by others; reinstall with deploy/install-node.sh"; else pass "$name"; fi
}
check_permissions

if ((local_only)); then
  ((failures == 0)) && echo "Local checks passed." || echo "Some checks FAILED."
  ((failures == 0)) && exit 0 || exit 1
fi

# 2. /mcp without credentials: 401, not a redirect, with the exact challenge Claude needs.
expected_challenge="Bearer resource_metadata=\"${public_url}/.well-known/oauth-protected-resource/mcp\""
name="POST ${public_url}/mcp gives 401 with the exact WWW-Authenticate"
if ! fetch_headers POST "${public_url}/mcp" --header 'content-type: application/json' --data '{}'; then
  fail "$name" "request failed: ${headers}"
elif [[ "$status" =~ ^3 ]]; then
  fail "$name" "got a redirect (HTTP ${status} to ${location}); /mcp must never redirect"
elif [[ "$status" != "401" ]]; then
  fail "$name" "expected HTTP 401, got ${status}"
else
  actual="$(printf '%s\n' "$headers" | grep -E '^www-authenticate:' | head -n 1 | sed -E 's/^www-authenticate:[[:space:]]*//')"
  if [[ "$actual" == "$expected_challenge" ]]; then
    pass "$name"
  else
    fail "$name" "WWW-Authenticate was '${actual}', expected '${expected_challenge}'"
  fi
fi

# 2b. The trailing-slash form must not redirect either.
name="${public_url}/mcp/ does not redirect"
if ! fetch_headers POST "${public_url}/mcp/" --header 'content-type: application/json' --data '{}'; then
  fail "$name" "request failed: ${headers}"
elif [[ "$status" =~ ^3 ]]; then
  fail "$name" "got a redirect (HTTP ${status} to ${location})"
else
  pass "$name (HTTP ${status})"
fi

# 3. The discovery documents: 200 and JSON.
for path in /.well-known/oauth-protected-resource/mcp /.well-known/oauth-authorization-server; do
  name="GET ${public_url}${path} is 200 JSON"
  if ! out="$(curl "${curl_opts[@]}" --write-out '\n%{http_code} %{content_type}' "${public_url}${path}" 2>&1)"; then
    fail "$name" "request failed"
    continue
  fi
  meta="$(printf '%s\n' "$out" | tail -n 1)"
  doc="$(printf '%s\n' "$out" | sed '$d')"
  if [[ "${meta%% *}" == "200" && "$meta" == *json* && "$doc" == "{"* ]]; then
    pass "$name"
  else
    fail "$name" "got '${meta}'"
  fi
done

# 4. The dashboard sends a signed-out visitor to sign-in, and serves nothing first.
name="GET ${public_url}/ui redirects to sign-in"
if ! fetch_headers GET "${public_url}/ui"; then
  fail "$name" "request failed: ${headers}"
elif [[ "$status" =~ ^3 && "$location" == *"/oauth/login"* ]]; then
  pass "$name (HTTP ${status})"
else
  fail "$name" "expected a redirect to /oauth/login, got HTTP ${status} ${location}"
fi

# 5. The env file against deploy/env.template, by name only (warnings; never a failure, never a value).
if [[ -r "$LKB_ENV_FILE" ]]; then env_drift_report "${here}/env.template" "$LKB_ENV_FILE"; fi

if ((failures == 0)); then
  echo "All checks passed."
else
  echo "${failures} check(s) FAILED."
  exit 1
fi

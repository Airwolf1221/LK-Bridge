#!/usr/bin/env bash
# Health checks for a running bridge, run from the server itself. Prints PASS or FAIL for each check and exits 1 if
# any failed.
#
#   healthcheck.sh [--local-only] [--via-loopback] [--url https://host]
#
#   --local-only    only check that 127.0.0.1:8787 answers (use before Caddy has the site block)
#   --via-loopback  make the public checks connect to 127.0.0.1:443 (still through Caddy and TLS, with the right name).
#                   Use it if the server cannot reach its own public address ("hairpin" NAT).
#   --url           the public URL (default: BRIDGE_PUBLIC_URL from the env file, else https://lk.ottomoons.co.uk)
#
# It sends no credentials and prints no response bodies. When it can read the env file it also warns, by variable NAME
# only, if the file has drifted from deploy/env.template.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
source "${here}/lib.sh"

local_only=0
via_loopback=0
public_url=""
while (($# > 0)); do
  case "$1" in
    --local-only) local_only=1 ;;
    --via-loopback) via_loopback=1 ;;
    --url)
      shift
      public_url="${1:-}"
      ;;
    *)
      echo "usage: healthcheck.sh [--local-only] [--via-loopback] [--url https://host]" >&2
      exit 2
      ;;
  esac
  shift
done

command -v curl >/dev/null 2>&1 || die "curl is required."

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

# 1. The bridge itself answers on the loopback port.
name="bridge answers on 127.0.0.1:${port} (/healthz)"
body="$(curl "${curl_opts[@]}" --write-out '\n%{http_code}' "http://127.0.0.1:${port}/healthz" 2>&1 || true)"
code="$(printf '%s\n' "$body" | tail -n 1)"
if [[ "$code" == "200" ]] && printf '%s' "$body" | grep -q '"ok":true'; then
  pass "$name"
else
  fail "$name" "got HTTP ${code:-none}"
fi

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

# Live-server auth checklist (for chunk 7)

Chunk 4 could not reach claude.ai or ChatGPT, and they could not reach the sandbox, so these checks need the real server. Replace `lk.example.com` with your hostname. Keep `journalctl -u lk-bridge -f` open in a second PuTTY window throughout: every step below has an `auth …` event to look for. If a connection fails in Claude, copy the `ofid_…` reference from the error URL straight away; it expires.

## 1. Before connecting anything

1. **DNS.** From a machine outside your network: `dig +short A lk.example.com` returns only the server's public IPv4 address (no private or CGNAT address, and an `A` record exists, not only `AAAA`).
2. **Configuration.** `BRIDGE_PUBLIC_URL=https://lk.example.com` exactly: `https`, lowercase, no path, no trailing slash. The bridge starts without a configuration error.
3. **No redirect on the MCP URL.** `curl -sI https://lk.example.com/mcp` shows `HTTP/2 401` (not 301/302/307/308), and `curl -sI https://lk.example.com/mcp/` is not a redirect either. Caddy must not add `www.` or trailing-slash redirects.
4. **The challenge survives Caddy.**
   `curl -s -o /dev/null -D - -X POST https://lk.example.com/mcp -H 'content-type: application/json' -d '{}'` shows exactly
   `www-authenticate: Bearer resource_metadata="https://lk.example.com/.well-known/oauth-protected-resource/mcp"`.
5. **Discovery documents** each return `200` and JSON:
   - `curl -s https://lk.example.com/.well-known/oauth-protected-resource/mcp` and `…/oauth-protected-resource`: `resource` is exactly `https://lk.example.com/mcp`, `authorization_servers` is `["https://lk.example.com"]`.
   - `curl -s https://lk.example.com/.well-known/oauth-authorization-server` and `…/openid-configuration`: every URL starts with `https://lk.example.com`, and `client_id_metadata_document_supported` is `true`.
6. **Latency** from outside: `curl -s -o /dev/null -w '%{time_total}\n' -X POST https://lk.example.com/oauth/token -d grant_type=refresh_token -d client_id=x` prints well under 1 second (Claude allows 10).
7. **Client IP behind Caddy (`TRUST_PROXY`).** Leave `TRUST_PROXY` unset (it defaults to `loopback`, right when Caddy runs on the same host and the bridge listens on `127.0.0.1`). One failed sign-in at `https://lk.example.com/oauth/login` must log `auth login.failed` with your real public IP in `ip`, not `127.0.0.1`. If it shows `127.0.0.1`, Caddy is not on loopback or is not sending `X-Forwarded-For`: set `TRUST_PROXY` to Caddy's address and check again, because otherwise the per-address login limit locks everyone out at once. Also confirm the bridge port is not reachable from outside (`curl http://<public-ip>:8787/healthz` from another machine must fail), so nobody can bypass Caddy and forge `X-Forwarded-For`.
8. **Firewall.** Nothing (ufw, Caddy, a CDN) blocks Anthropic's egress range `160.79.104.0/21`, and ports 80 and 443 are open.
9. **Clock.** `timedatectl` shows the clock synchronised (TOTP and token expiry depend on it).
10. **Owner sign-in.** Run `npm run setup:owner`, paste the lines into the env file, restart, and sign in at `https://lk.example.com/oauth/login`. In the browser's developer tools the cookie is `__Host-lkb_session` with HttpOnly, Secure and SameSite=Lax. If you enabled TOTP, a code is required, and the same code cannot be used twice.

## 2. claude.ai (web), automatic registration (DCR)

1. _Customize → Connectors → Add custom connector_, URL `https://lk.example.com/mcp`, authentication _Sign in now_, OAuth client _Register automatically_.
2. Log: `auth client.registered` with `redirect_hosts` = `claude.ai`, then `auth consent.shown`.
3. The consent page shows the application name Claude registered, the "has not been verified" note, **claude.ai** as the destination, and the scopes `mcp` and `offline_access`. There is no loopback warning.
4. Approve. Log: `auth consent.granted`, then `auth token.issued` with `refresh: true` and `scope: "mcp offline_access"`. The connector shows as connected.
5. In a chat, ask Claude to call `bridge_info`. It answers with the version and `caller.kind: "oauth"`.
6. `journalctl -u lk-bridge | grep -E 'lkb_(rt|ac|pat|cs)_|eyJ[A-Za-z0-9_-]+\.eyJ'` prints nothing (no secret in the log).

## 3. claude.ai, Claude's published identity (CIMD)

1. Remove the connector, then add it again choosing _Use Claude's published identity_.
2. Log: `auth client.metadata_fetched` with Claude's `client_id` URL and `cache_seconds`. **Write the URL down**: the docs give Claude Code's (`https://claude.ai/oauth/claude-code-client-metadata`) but not the one the hosted apps use.
3. The consent page names the host serving that document, then "It calls itself …", and shows **claude.ai** as the destination.
4. Approve, then call `bridge_info` as before.
5. If instead you see `auth client.metadata_rejected`, the `reason` field says why (for example a fetch timeout from the server, or a redirect URI outside the allowlist). Note it and fall back to DCR.

## 4. Desktop and mobile

1. Claude Desktop shows the connector (it shares the claude.ai account) and can call `bridge_info`.
2. The mobile app can _use_ the connector (it cannot add one) and can call `bridge_info`.

## 5. Token refresh

1. Leave the connector idle for over an hour (the access token lifetime), or for a quicker check set `AUTH_ACCESS_TOKEN_TTL_SECONDS=300` and restart.
2. Call `bridge_info` again. Log: `auth token.refreshed` for the same `grant_id`, and **no** `auth token.reuse_detected`.
3. `auth token.refresh_replayed` is fine: Claude sent the same refresh token twice within `AUTH_REFRESH_GRACE_SECONDS` (default 10) and both requests got the same new tokens (ADR 0009). Note how often it happens.
4. If `token.reuse_detected` appears without any attack, the duplicate refresh arrived more than the grace window after the first. Record the times and the `grant_id`; a longer window (up to 60 seconds) is a configuration change.
5. Restore the access-token lifetime if you changed it.

## 6. Recovery paths

1. **Deleted client.** Delete the DCR client (`sqlite3 /var/lib/lk-bridge/bridge.db "DELETE FROM auth_clients WHERE client_id='lkb_c_…'"`, or the dashboard once chunk 5 lands), then use the connector after the access token expires. Log: `auth token.rejected` with `error: "invalid_client"`. Claude should re-register and ask you to approve again. Note whether it does so by itself or shows an error.
2. **Disconnect.** Removing the connector in Claude may call `/oauth/revoke` (log `auth token.revoked`); if no event appears, Claude does not revoke, which is fine.
3. **Origin.** Search the log for `mcp.rejected` with `reason: "origin"`. Any hit means a Claude or ChatGPT surface sent an `Origin` not in `AUTH_MCP_ALLOWED_ORIGINS`; add exactly that origin.

## 7. Claude Code

1. **OAuth:** `claude mcp add --transport http lk-bridge https://lk.example.com/mcp --scope user`, then `/mcp` in Claude Code and choose to authenticate.
   - Log: `auth client.metadata_fetched` for `https://claude.ai/oauth/claude-code-client-metadata`. (If Claude Code falls back to DCR you will see `client.registered` with `redirect_hosts` on `localhost` or `127.0.0.1`.)
   - The consent page shows **localhost (this computer)** or **127.0.0.1 (this computer)** and the warning that the application only accepts sign-ins on your own computer.
   - Approve; `/mcp` shows lk-bridge connected; `bridge_info` works.
2. **PAT:** `npm run pat -- create --name "Claude Code"`, then
   `claude mcp add --transport http lk-bridge-pat https://lk.example.com/mcp --scope user -H "Authorization: Bearer <token>"`.
   `bridge_info` reports `caller.kind: "pat"`. Then `npm run pat -- revoke <id>`: the next call fails with 401.

## 8. Sign-in hardening

1. Five wrong passwords from one address, then the right one: the sixth attempt is refused with "Too many failed attempts" until 15 minutes pass (`auth login.rate_limited`).
2. Open the consent page, wait more than ten minutes, then approve: you get "This authorisation request has expired", not a code.

## 9. ChatGPT (Developer Mode, OAuth only)

Setup steps are in `docs/auth.md` › ChatGPT. Then:

1. **Discovery.** Creating the connector produces, in order: `auth mcp.rejected` (status 401), then either `auth client.registered` (DCR) or `auth client.metadata_fetched` (CIMD), then `auth consent.shown`.
2. **Record the redirect URI.** Copy the callback URL ChatGPT shows (if any) and the `redirect_uris` from `client.registered` (or the `client_id` URL from `client.metadata_fetched`). Write both down. They should be `https://chatgpt.com/connector_platform_oauth_redirect` or `https://chatgpt.com/connector/oauth/<id>`.
3. **If registration fails** with "invalid redirect URI" in ChatGPT: the log line `client.registration_rejected` holds the exact `redirect_uri`. Add it to `OAUTH_EXTRA_REDIRECT_URIS` in the env file (exactly as logged), restart, and create the connector again.
4. **Consent page** shows **chatgpt.com** as the destination, the scopes `mcp` and `offline_access`, and no loopback warning. Approve. Log: `consent.granted`, then `token.issued` with `refresh: true`.
5. **`resource` and `iss`.** No `token.rejected` with `invalid_target` (ChatGPT's `resource` matched) or `invalid_grant` around the exchange. If ChatGPT reports an issuer mismatch, compare `BRIDGE_PUBLIC_URL` with the `issuer` in `/.well-known/oauth-authorization-server`: they must be identical.
6. **Read check.** In a new chat with the connector enabled, ask ChatGPT to call `bridge_info`. It answers with the version and `caller.kind: "oauth"`, without asking for write confirmation.
7. **Write-confirmation check.** Not applicable until chunk 3 adds write tools. Then: ask for a harmless write on the sandbox project and check that ChatGPT asks for confirmation before the call, and that read tools do not.
8. **Reuse.** Disconnect and reconnect the connector (or wait for ChatGPT's next sign-in): if it reuses its registration, no new `client.registered` appears and the old `client_id` keeps working.
9. **Refresh.** After an hour of use, `token.refreshed` appears for the ChatGPT `client_id` and the connector keeps working.

Record each step as passed or failed, with the time and any `ofid_` reference, for chunk 8's review.

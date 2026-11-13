/**
 * Google OAuth 2.0 for the off-site copy (v2 E1b, ADR 0043): the authorisation-code flow with PKCE (S256), offline
 * access (a refresh token) and the one scope `drive.file`; the token refresh; revocation; and the one Drive call that
 * names the account, `about.get` with `fields=user`, which `drive.file` alone is allowed to make.
 *
 * Every endpoint is configurable (`GoogleEndpoints`) so tests point it at a mock; production uses Google's. Requests go
 * through an injected `fetch` with a timeout. Errors carry Google's error code (`invalid_grant`, `invalid_client`, …)
 * and a message with anything token-like removed (`redactSecrets`); a token, the client secret or a code never appears
 * in an error, a log line or a response.
 */
import { createHash, randomBytes } from 'node:crypto';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export interface GoogleEndpoints {
  readonly authorize: string;
  readonly token: string;
  readonly revoke: string;
  /** Drive API v3 base, e.g. `https://www.googleapis.com/drive/v3`. */
  readonly drive: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  drive: 'https://www.googleapis.com/drive/v3',
};

export interface GoogleClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface TokenSet {
  readonly accessToken: string;
  /** Present on the first exchange (`prompt=consent`); Google rarely sends a new one on refresh. */
  readonly refreshToken: string | null;
  readonly expiresAt: number;
  readonly scope: string;
  readonly tokenType: string;
}

export type GoogleErrorCode =
  | 'invalid_grant'
  | 'invalid_client'
  | 'unauthorized_client'
  | 'invalid_request'
  | 'access_denied'
  | 'insufficient_scope'
  | 'network'
  | 'http';

export class GoogleError extends Error {
  override readonly name = 'GoogleError';
  constructor(
    readonly code: GoogleErrorCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(redactSecrets(message));
  }

  /** Google refused the refresh token or the client: only reconnecting (or fixing the client) helps. */
  get needsReconnect(): boolean {
    return (
      this.code === 'invalid_grant' || this.code === 'invalid_client' || this.code === 'unauthorized_client'
    );
  }
}

/**
 * Removes anything shaped like a Google credential from text: access tokens (`ya29.`), refresh tokens (`1//`), client
 * secrets (`GOCSPX-`), authorisation codes (`4/`), bearer headers, and any of `extra` (the exact values in hand).
 */
export function redactSecrets(text: string, extra: readonly (string | null | undefined)[] = []): string {
  let s = text;
  for (const v of extra) if (v && v.length >= 6) s = s.split(v).join('[redacted]');
  return s
    .replace(/ya29\.[\w.-]+/g, '[redacted]')
    .replace(/\b1\/\/[\w.-]+/g, '[redacted]')
    .replace(/GOCSPX-[\w-]+/g, '[redacted]')
    .replace(/\b4\/[\w.-]{10,}/g, '[redacted]')
    .replace(/(bearer\s+)[\w.~+/-]+=*/gi, '$1[redacted]')
    .replace(
      /("(?:access_token|refresh_token|client_secret|code|code_verifier|password|password2)"\s*:\s*")[^"]*"/g,
      '$1[redacted]"',
    )
    .replace(
      /((?:access_token|refresh_token|client_secret|code_verifier|password2?)\s*=\s*)\S+/g,
      '$1[redacted]',
    );
}

/** A PKCE pair: a 43-character verifier (32 random bytes) and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function randomState(): string {
  return randomBytes(32).toString('base64url');
}

export interface GoogleOAuthOptions {
  readonly endpoints?: GoogleEndpoints;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export class GoogleOAuth {
  readonly endpoints: GoogleEndpoints;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(o: GoogleOAuthOptions = {}) {
    this.endpoints = o.endpoints ?? GOOGLE_ENDPOINTS;
    // The ban on global fetch keeps LegendKeeper behind the governor (ADR 0003). These are Google's fixed OAuth and
    // Drive endpoints (ADR 0043), never LegendKeeper, so the global fetch is the right tool here.
    // eslint-disable-next-line no-restricted-globals -- Google's endpoints, not LegendKeeper (ADR 0043)
    this.fetchFn = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.now = o.now ?? Date.now;
  }

  /** The URL the owner's browser is sent to. `prompt=consent` makes Google issue a refresh token every time. */
  authorizeUrl(p: {
    clientId: string;
    redirectUri: string;
    state: string;
    challenge: string;
    loginHint?: string;
  }): string {
    const u = new URL(this.endpoints.authorize);
    u.searchParams.set('client_id', p.clientId);
    u.searchParams.set('redirect_uri', p.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', DRIVE_FILE_SCOPE);
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('state', p.state);
    u.searchParams.set('code_challenge', p.challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    if (p.loginHint) u.searchParams.set('login_hint', p.loginHint);
    return u.toString();
  }

  async exchange(
    client: GoogleClient,
    p: { code: string; verifier: string; redirectUri: string },
  ): Promise<TokenSet> {
    const t = await this.tokenRequest(
      {
        grant_type: 'authorization_code',
        code: p.code,
        code_verifier: p.verifier,
        redirect_uri: p.redirectUri,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      },
      [p.code, p.verifier, client.clientSecret],
    );
    if (!t.refreshToken) {
      throw new GoogleError(
        'invalid_grant',
        'Google did not issue a refresh token. Remove the app’s access in your Google account (Security → third-party access) and connect again.',
      );
    }
    return t;
  }

  async refresh(client: GoogleClient, refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest(
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      },
      [refreshToken, client.clientSecret],
    );
  }

  /** Revokes a token at Google (the refresh token revokes the whole grant). True when Google confirmed it. */
  async revoke(token: string): Promise<{ ok: boolean; message: string | null }> {
    try {
      const res = await this.call(this.endpoints.revoke, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      });
      if (res.ok) return { ok: true, message: null };
      const body = await res.text().catch(() => '');
      // Google answers 400 invalid_token for a token it no longer knows: it is revoked either way.
      if (res.status === 400 && /invalid_token/.test(body))
        return { ok: true, message: 'Google no longer knew the token.' };
      return {
        ok: false,
        message: redactSecrets(`Google answered ${res.status}: ${body.slice(0, 200)}`, [token]),
      };
    } catch (e) {
      return {
        ok: false,
        message: redactSecrets(`Google could not be reached: ${(e as Error).message}`, [token]),
      };
    }
  }

  /** The connected account (`about.get`, `fields=user`), which `drive.file` alone may call. */
  async account(accessToken: string): Promise<{ email: string | null; name: string | null }> {
    let res: Response;
    try {
      res = await this.call(`${this.endpoints.drive}/about?fields=user`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
    } catch (e) {
      throw new GoogleError('network', `Google Drive could not be reached: ${(e as Error).message}`);
    }
    const body = await res.text();
    if (!res.ok) {
      const code: GoogleErrorCode = res.status === 403 ? 'insufficient_scope' : 'http';
      throw new GoogleError(code, `Google Drive answered ${res.status} to about.get`, res.status);
    }
    let json: { user?: { emailAddress?: unknown; displayName?: unknown } } = {};
    try {
      json = JSON.parse(body) as typeof json;
    } catch {
      // fall through with nulls
    }
    const email = typeof json.user?.emailAddress === 'string' ? json.user.emailAddress.slice(0, 320) : null;
    const name = typeof json.user?.displayName === 'string' ? json.user.displayName.slice(0, 200) : null;
    return { email, name };
  }

  // ============================================================================================ internals

  private async call(url: string, init: RequestInit): Promise<Response> {
    return this.fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
  }

  private async tokenRequest(form: Record<string, string>, secrets: readonly string[]): Promise<TokenSet> {
    let res: Response;
    try {
      res = await this.call(this.endpoints.token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
      });
    } catch (e) {
      throw new GoogleError(
        'network',
        redactSecrets(`Google could not be reached: ${(e as Error).message}`, secrets),
      );
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // handled below
    }
    if (!res.ok) {
      const err = typeof json.error === 'string' ? json.error : 'http';
      const desc = typeof json.error_description === 'string' ? json.error_description : '';
      const code: GoogleErrorCode = (
        [
          'invalid_grant',
          'invalid_client',
          'unauthorized_client',
          'invalid_request',
          'access_denied',
        ] as const
      ).includes(err as 'invalid_grant')
        ? (err as GoogleErrorCode)
        : 'http';
      throw new GoogleError(
        code,
        redactSecrets(
          `Google refused the token request (${res.status} ${err}${desc ? `: ${desc.slice(0, 200)}` : ''})`,
          secrets,
        ),
        res.status,
      );
    }
    const access = json.access_token;
    if (typeof access !== 'string' || access === '') {
      throw new GoogleError('http', 'Google’s token response had no access token.');
    }
    const scope = typeof json.scope === 'string' ? json.scope : DRIVE_FILE_SCOPE;
    return {
      accessToken: access,
      refreshToken:
        typeof json.refresh_token === 'string' && json.refresh_token !== '' ? json.refresh_token : null,
      expiresAt: this.now() + (typeof json.expires_in === 'number' ? json.expires_in : 3599) * 1000,
      scope,
      tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
    };
  }
}

/** Plain-language reason for the dashboard, from a refresh failure. */
export function reconnectReason(e: GoogleError): string {
  if (e.code === 'invalid_grant')
    return 'Google refused the saved sign-in (invalid_grant): it was revoked, expired (an app left in Testing expires after 7 days), or the Google password changed. Reconnect.';
  if (e.code === 'invalid_client' || e.code === 'unauthorized_client')
    return 'Google refused the client ID or secret (invalid_client): paste the client again, then reconnect.';
  return e.message;
}

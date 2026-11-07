import type { AuthConfig } from '../config/auth.js';
import type { PatService } from './pats.js';
import { PAT_PREFIX } from './pats.js';
import { SCOPE_MCP, parseScope } from './scopes.js';
import type { TokenService } from './tokens.js';

/**
 * Resource-server side of OAuth at `/mcp` (RFC 6750, RFC 9728 §5.1, MCP authorization).
 *
 * - No (or non-Bearer) credentials: `401` with exactly
 *   `WWW-Authenticate: Bearer resource_metadata="<public>/.well-known/oauth-protected-resource/mcp"`.
 * - A bad, expired, revoked or wrong-audience token: `401` with `error="invalid_token"`.
 * - A valid token without the needed scope: `403` with `error="insufficient_scope"`.
 * Tokens are read only from the `Authorization` header, never from the query string or body.
 */

export interface CallerIdentity {
  readonly kind: 'oauth' | 'pat';
  /** OAuth client id, or `pat:<id>` for a personal access token. */
  readonly clientId: string;
  readonly scopes: readonly string[];
  /** JWT `jti` or PAT id. Safe to log. */
  readonly tokenId: string;
  readonly expiresAt?: number;
  readonly label?: string;
}

export type BearerResult =
  | { readonly ok: true; readonly caller: CallerIdentity; readonly token: string }
  | {
      readonly ok: false;
      readonly status: 401 | 403;
      readonly wwwAuthenticate: string;
      readonly body: { readonly error: string; readonly error_description: string };
    };

/** RFC 6750 §2.1 b64token. */
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

const quote = (s: string) => `"${s.replace(/["\\]/g, '')}"`;

export class BearerGuard {
  constructor(
    private readonly deps: {
      readonly config: AuthConfig;
      readonly tokens: TokenService;
      readonly pats: PatService;
    },
  ) {}

  /** The exact challenge for a request without credentials (requirement 1). */
  get challenge(): string {
    return `Bearer resource_metadata=${quote(this.deps.config.resourceMetadataUrl)}`;
  }

  private invalidToken(description: string): BearerResult {
    return {
      ok: false,
      status: 401,
      wwwAuthenticate: `Bearer error="invalid_token", error_description=${quote(description)}, resource_metadata=${quote(this.deps.config.resourceMetadataUrl)}`,
      body: { error: 'invalid_token', error_description: description },
    };
  }

  async authenticate(
    authorization: string | undefined,
    requiredScopes: readonly string[] = [SCOPE_MCP],
  ): Promise<BearerResult> {
    const header = authorization?.trim();
    if (!header || !/^bearer(\s|$)/i.test(header)) {
      return {
        ok: false,
        status: 401,
        wwwAuthenticate: this.challenge,
        body: { error: 'invalid_token', error_description: 'A bearer token is required' },
      };
    }
    const token = header.replace(/^bearer\s*/i, '');
    if (token === '' || !B64TOKEN.test(token)) return this.invalidToken('Malformed bearer token');

    let caller: CallerIdentity;
    if (token.startsWith(PAT_PREFIX)) {
      const pat = this.deps.pats.verify(token);
      if (!pat) return this.invalidToken('The personal access token is invalid, expired or revoked');
      caller = {
        kind: 'pat',
        clientId: `pat:${pat.id}`,
        scopes: parseScope(pat.scope),
        tokenId: pat.id,
        label: pat.name,
        ...(pat.expiresAt !== null ? { expiresAt: pat.expiresAt } : {}),
      };
    } else {
      const check = await this.deps.tokens.verifyAccessToken(token);
      if (!check.ok) return this.invalidToken(check.reason);
      caller = {
        kind: 'oauth',
        clientId: check.token.clientId,
        scopes: check.token.scopes,
        tokenId: check.token.jti,
        expiresAt: check.token.expiresAt,
      };
    }

    const missing = requiredScopes.filter((s) => !caller.scopes.includes(s));
    if (missing.length > 0) {
      return {
        ok: false,
        status: 403,
        wwwAuthenticate: `Bearer error="insufficient_scope", scope=${quote(requiredScopes.join(' '))}, resource_metadata=${quote(this.deps.config.resourceMetadataUrl)}`,
        body: {
          error: 'insufficient_scope',
          error_description: `This request needs scope: ${requiredScopes.join(' ')}`,
        },
      };
    }
    return { ok: true, caller, token };
  }
}

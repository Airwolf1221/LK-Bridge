import { isIP } from 'node:net';
import * as z from 'zod';
import { type OutboundPortAllowlist, parseOutboundPortAllowlist } from '../auth/ports.js';

/**
 * Configuration for the OAuth 2.1 authorization server, owner login and the MCP resource server
 * (chunk 4). Parsed separately from the main config so the auth surface can be built and tested
 * without LegendKeeper credentials. Errors name variables, never values.
 */

export class AuthConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid auth configuration:\n - ${issues.join('\n - ')}`);
    this.name = 'AuthConfigError';
  }
}

export interface AuthConfig {
  /** Normalised public origin, e.g. `https://lk.example.com` (lowercase host, no default port, no slash). */
  readonly publicUrl: string;
  /** OAuth issuer identifier. Equal to {@link publicUrl}. */
  readonly issuer: string;
  /** The MCP endpoint URL users enter in Claude, e.g. `https://lk.example.com/mcp`. Already canonical. */
  readonly mcpUrl: string;
  /** RFC 9728 metadata URL advertised in `WWW-Authenticate`. */
  readonly resourceMetadataUrl: string;
  /** True when the public URL is HTTPS: cookies get `Secure` and the `__Host-` prefix. */
  readonly secureCookies: boolean;
  readonly owner: {
    readonly username: string;
    /** Argon2id PHC string produced by `npm run setup:owner`. */
    readonly passwordHash: string;
    /** Base32 TOTP secret; TOTP is required at login when set. */
    readonly totpSecret?: string;
  };
  readonly sessionSecret: string;
  readonly jwtSigningKey: string;
  readonly ttl: {
    readonly accessTokenSeconds: number;
    readonly refreshTokenSeconds: number;
    readonly refreshFamilyMaxSeconds: number;
    readonly authCodeSeconds: number;
    readonly sessionSeconds: number;
    readonly consentSeconds: number;
    /** How long a just-rotated refresh token may be presented again for the same successor. 0 disables. */
    readonly refreshGraceSeconds: number;
  };
  readonly cimd: {
    readonly timeoutMs: number;
    readonly maxBytes: number;
    readonly defaultCacheSeconds: number;
    readonly maxCacheSeconds: number;
  };
  /** Extra exact redirect URIs from `OAUTH_EXTRA_REDIRECT_URIS` (for example a new ChatGPT callback). */
  readonly extraRedirectUris: readonly string[];
  /** Browser origins allowed to call `/mcp` besides the public origin and loopback. */
  readonly mcpAllowedOrigins: readonly string[];
  /**
   * Fastify `trustProxy`: the proxy addresses whose `X-Forwarded-For` is believed, or `false` to
   * believe none. Default `['loopback']` (Caddy on the same host).
   */
  readonly trustProxy: readonly string[] | false;
  /**
   * OUTBOUND_EXTRA_PORTS_ALLOWLIST: `host:port` pairs the CIMD document fetch may use besides port 443 (v1.0.1,
   * src/auth/ports.ts). Empty by default. Optional so that hand-built test configs keep working: absent means none.
   */
  readonly outboundExtraPorts?: OutboundPortAllowlist;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Argon2id PHC string, e.g. `$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>`. */
export const ARGON2ID_PHC = /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

const intFrom = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const secret = (name: string) =>
  z
    .string({ error: `${name} is required (generate with: openssl rand -base64 48)` })
    .min(32, { error: `${name} must be at least 32 characters (generate with: openssl rand -base64 48)` });

const csv = z
  .string()
  .optional()
  .transform((raw) =>
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const authEnvSchema = z.object({
  BRIDGE_PUBLIC_URL: z.string({ error: 'BRIDGE_PUBLIC_URL is required, e.g. https://lk.example.com' }),
  OWNER_USERNAME: z
    .string()
    .regex(/^[A-Za-z0-9._@-]{1,64}$/, { error: 'OWNER_USERNAME must be 1-64 of A-Z a-z 0-9 . _ @ -' })
    .default('owner'),
  OWNER_PASSWORD_HASH: z
    .string({ error: 'OWNER_PASSWORD_HASH is required; run `npm run setup:owner` to generate it' })
    .regex(ARGON2ID_PHC, {
      error: 'OWNER_PASSWORD_HASH must be an Argon2id hash produced by `npm run setup:owner`',
    }),
  OWNER_TOTP_SECRET: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === '' ? undefined : v.trim().replace(/=+$/, '').toUpperCase(),
    )
    .refine((v) => v === undefined || (/^[A-Z2-7]+$/.test(v) && Math.floor((v.length * 5) / 8) >= 16), {
      error: 'OWNER_TOTP_SECRET must be base32 and at least 128 bits (setup:owner prints one)',
    }),
  SESSION_SECRET: secret('SESSION_SECRET'),
  JWT_SIGNING_KEY: secret('JWT_SIGNING_KEY'),

  AUTH_ACCESS_TOKEN_TTL_SECONDS: intFrom(3600, 60, 86400),
  AUTH_REFRESH_TOKEN_TTL_SECONDS: intFrom(30 * 86400, 3600, 365 * 86400),
  AUTH_REFRESH_FAMILY_MAX_SECONDS: intFrom(90 * 86400, 3600, 730 * 86400),
  AUTH_CODE_TTL_SECONDS: intFrom(300, 30, 600),
  AUTH_SESSION_TTL_SECONDS: intFrom(12 * 3600, 300, 30 * 86400),
  AUTH_REFRESH_GRACE_SECONDS: intFrom(10, 0, 60),

  AUTH_CIMD_TIMEOUT_MS: intFrom(4000, 100, 8000),
  AUTH_CIMD_MAX_BYTES: intFrom(8192, 512, 65536),

  OAUTH_EXTRA_REDIRECT_URIS: csv,
  OUTBOUND_EXTRA_PORTS_ALLOWLIST: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
  AUTH_MCP_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((raw) =>
      (raw ?? 'https://claude.ai,https://claude.com,https://chatgpt.com')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
});

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function parsePublicUrl(raw: string, issues: string[]): { origin: string; secure: boolean } | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    issues.push('BRIDGE_PUBLIC_URL: must be an absolute URL, e.g. https://lk.example.com');
    return undefined;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    issues.push('BRIDGE_PUBLIC_URL: must use https (plain http is allowed only for localhost testing)');
  }
  if (url.username || url.password) issues.push('BRIDGE_PUBLIC_URL: must not contain credentials');
  if (url.search || url.hash || raw.includes('#') || raw.includes('?')) {
    issues.push('BRIDGE_PUBLIC_URL: must not contain a query or fragment');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    issues.push('BRIDGE_PUBLIC_URL: must be an origin with no path, e.g. https://lk.example.com');
  }
  return { origin: url.origin, secure: url.protocol === 'https:' };
}

/**
 * Each extra redirect URI must be an exact, already-normalised absolute URL: https (http only on
 * loopback), no credentials, no fragment, no wildcard. Redirect URIs are compared as exact strings,
 * so a value the URL parser would rewrite (upper-case host, default port) could never match.
 */
function checkRedirectList(list: readonly string[], issues: string[]): void {
  for (const entry of list) {
    let u: URL | undefined;
    try {
      u = new URL(entry);
    } catch {
      u = undefined;
    }
    const ok =
      u !== undefined &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname))) &&
      !u.username &&
      !u.password &&
      !entry.includes('#') &&
      !entry.includes('*') &&
      entry.length <= 2048;
    if (!ok) {
      issues.push(
        `OAUTH_EXTRA_REDIRECT_URIS: "${entry.slice(0, 200)}" must be an exact https URL (http only on localhost), with no fragment, credentials or wildcard`,
      );
    } else if (u && u.href !== entry) {
      issues.push(`OAUTH_EXTRA_REDIRECT_URIS: write "${entry.slice(0, 200)}" exactly as ${u.href}`);
    }
  }
}

const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** TRUST_PROXY: `loopback` (default), `none`, or a comma list of addresses, CIDR ranges and keywords. */
function parseTrustProxy(raw: string | undefined, issues: string[]): readonly string[] | false {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'loopback') return ['loopback'];
  if (value === 'none' || value === 'false' || value === 'off') return false;
  if (value === 'true' || value === '*' || value === 'all') {
    issues.push(
      'TRUST_PROXY: trusting every address would let any client forge X-Forwarded-For; list the proxy addresses instead (default: loopback)',
    );
    return false;
  }
  const out: string[] = [];
  for (const entry of value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)) {
    const [addr = '', prefix, extra] = entry.split('/');
    const family = isIP(addr);
    const prefixOk =
      prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 6 ? 128 : 32));
    if (PROXY_KEYWORDS.has(entry) || (family !== 0 && prefixOk && extra === undefined)) {
      out.push(entry);
    } else {
      issues.push(
        `TRUST_PROXY: "${entry.slice(0, 100)}" is not an IP address, a CIDR range, or one of loopback, linklocal, uniquelocal`,
      );
    }
  }
  return out;
}

function normaliseOrigins(list: readonly string[], issues: string[]): string[] {
  const out: string[] = [];
  for (const entry of list) {
    try {
      const u = new URL(entry);
      if (u.origin === 'null' || (u.pathname !== '/' && u.pathname !== '')) throw new Error('bad');
      out.push(u.origin);
    } catch {
      issues.push('AUTH_MCP_ALLOWED_ORIGINS: each entry must be an origin such as https://claude.ai');
      return [];
    }
  }
  return out;
}

/** Parses and validates the auth environment variables. Throws {@link AuthConfigError}. */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const parsed = authEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new AuthConfigError(
      parsed.error.issues.map((i) => {
        const name = i.path.join('.') || '(root)';
        return i.message.startsWith(name) ? i.message : `${name}: ${i.message}`;
      }),
    );
  }
  const e = parsed.data;
  const issues: string[] = [];
  const pub = parsePublicUrl(e.BRIDGE_PUBLIC_URL, issues);
  if (e.SESSION_SECRET === e.JWT_SIGNING_KEY) {
    issues.push('SESSION_SECRET and JWT_SIGNING_KEY must be different values');
  }
  if (e.AUTH_REFRESH_FAMILY_MAX_SECONDS < e.AUTH_REFRESH_TOKEN_TTL_SECONDS) {
    issues.push('AUTH_REFRESH_FAMILY_MAX_SECONDS must be at least AUTH_REFRESH_TOKEN_TTL_SECONDS');
  }
  checkRedirectList(e.OAUTH_EXTRA_REDIRECT_URIS, issues);
  const origins = normaliseOrigins(e.AUTH_MCP_ALLOWED_ORIGINS, issues);
  const trustProxy = parseTrustProxy(e.TRUST_PROXY, issues);
  let outboundExtraPorts: OutboundPortAllowlist = new Set<string>();
  try {
    outboundExtraPorts = parseOutboundPortAllowlist(e.OUTBOUND_EXTRA_PORTS_ALLOWLIST);
  } catch (err) {
    issues.push((err as Error).message);
  }
  if (issues.length > 0 || !pub) throw new AuthConfigError(issues);

  const publicUrl = pub.origin;
  return {
    publicUrl,
    issuer: publicUrl,
    mcpUrl: `${publicUrl}/mcp`,
    resourceMetadataUrl: `${publicUrl}/.well-known/oauth-protected-resource/mcp`,
    secureCookies: pub.secure,
    owner: {
      username: e.OWNER_USERNAME,
      passwordHash: e.OWNER_PASSWORD_HASH,
      ...(e.OWNER_TOTP_SECRET ? { totpSecret: e.OWNER_TOTP_SECRET } : {}),
    },
    sessionSecret: e.SESSION_SECRET,
    jwtSigningKey: e.JWT_SIGNING_KEY,
    ttl: {
      accessTokenSeconds: e.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenSeconds: e.AUTH_REFRESH_TOKEN_TTL_SECONDS,
      refreshFamilyMaxSeconds: e.AUTH_REFRESH_FAMILY_MAX_SECONDS,
      authCodeSeconds: e.AUTH_CODE_TTL_SECONDS,
      sessionSeconds: e.AUTH_SESSION_TTL_SECONDS,
      consentSeconds: 600,
      refreshGraceSeconds: e.AUTH_REFRESH_GRACE_SECONDS,
    },
    cimd: {
      timeoutMs: e.AUTH_CIMD_TIMEOUT_MS,
      maxBytes: e.AUTH_CIMD_MAX_BYTES,
      defaultCacheSeconds: 600,
      maxCacheSeconds: 86400,
    },
    extraRedirectUris: e.OAUTH_EXTRA_REDIRECT_URIS,
    mcpAllowedOrigins: origins,
    trustProxy,
    outboundExtraPorts,
  };
}

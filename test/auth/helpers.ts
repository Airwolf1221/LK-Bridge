import { createHash, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import type { AuthServices } from '../../src/auth/services.js';
import { generateTotpSecret } from '../../src/auth/totp.js';
import { type AuthConfig, loadAuthConfig } from '../../src/config/auth.js';
import { runMigrations } from '../../src/db/migrate.js';
import { type Db, openDatabase } from '../../src/db/open.js';
import type { McpToolProvider } from '../../src/mcp/server.js';
import type { Policy } from '../../src/policy/index.js';
import { type BuildServerOptions, buildServer } from '../../src/server.js';

/**
 * Test harness: a real bridge listening on 127.0.0.1 with throwaway secrets, configured with an
 * HTTPS public URL as in production. The scripted clients reach it the way Claude reaches the
 * real server through Caddy: every `https://lk.example.test/...` URL taken from metadata is sent
 * to the local port instead (the "proxy" rewrite), so the bridge itself never knows it is a test.
 */

export const PUBLIC_URL = 'https://lk.example.test';

let cachedHash: { password: string; hash: string } | undefined;

/** A random owner password and a cheap Argon2id hash of it (cheap so tests stay fast). */
export async function ownerCredentials(): Promise<{ password: string; hash: string }> {
  if (!cachedHash) {
    const password = randomBytes(18).toString('base64url');
    cachedHash = {
      password,
      hash: await hashPassword(password, { memoryCost: 1024, timeCost: 1, parallelism: 1 }),
    };
  }
  return cachedHash;
}

export function throwawaySecret(): string {
  return randomBytes(48).toString('base64');
}

export interface Clock {
  now(): number;
  advance(seconds: number): void;
}

export function testClock(): Clock {
  let offset = 0;
  return {
    now: () => Math.floor(Date.now() / 1000) + offset,
    advance: (s) => {
      offset += s;
    },
  };
}

export interface TestBridge {
  readonly app: FastifyInstance;
  readonly services: AuthServices;
  readonly policy: Policy;
  readonly config: AuthConfig;
  readonly db: Db;
  readonly base: string;
  readonly publicUrl: string;
  readonly mcpUrl: string;
  readonly password: string;
  readonly totpSecret: string | undefined;
  readonly clock: Clock;
  readonly logs: string[];
  /** Maps a public URL to the local listener (the TLS-terminating proxy in production). */
  local(url: string): string;
  /** `fetch` through the proxy rewrite, never following redirects. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

export interface StartBridgeOptions {
  readonly publicUrl?: string;
  readonly totp?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly tools?: readonly McpToolProvider[];
  readonly authOverrides?: BuildServerOptions['authOverrides'];
}

export async function startBridge(o: StartBridgeOptions = {}): Promise<TestBridge> {
  const { password, hash } = await ownerCredentials();
  const totpSecret = o.totp ? generateTotpSecret() : undefined;
  const config = loadAuthConfig({
    BRIDGE_PUBLIC_URL: o.publicUrl ?? PUBLIC_URL,
    OWNER_PASSWORD_HASH: hash,
    SESSION_SECRET: throwawaySecret(),
    JWT_SIGNING_KEY: throwawaySecret(),
    ...(totpSecret ? { OWNER_TOTP_SECRET: totpSecret } : {}),
    ...o.env,
  });
  const db = openDatabase(':memory:');
  runMigrations(db);
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs.push(chunk.toString('utf8'));
      cb();
    },
  });
  const clock = testClock();
  const { app, services, policy } = await buildServer({
    authConfig: config,
    db,
    logLevel: 'info',
    logStream,
    pruneIntervalMs: 0,
    ...(o.tools ? { tools: o.tools } : {}),
    authOverrides: { now: () => clock.now(), ...o.authOverrides },
  });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const local = (url: string) =>
    url.startsWith(config.publicUrl) ? base + url.slice(config.publicUrl.length) : url;
  return {
    app,
    services,
    policy,
    config,
    db,
    base,
    publicUrl: config.publicUrl,
    mcpUrl: config.mcpUrl,
    password,
    totpSecret,
    clock,
    logs,
    local,
    fetch: (url, init) => fetch(local(url), { redirect: 'manual', ...init }),
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// PKCE and parsing helpers

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function formBody(params: Readonly<Record<string, string | readonly string[] | undefined>>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    for (const item of typeof v === 'string' ? [v] : v) p.append(k, item);
  }
  return p.toString();
}

export function hiddenField(html: string, name: string): string {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!m?.[1]) throw new Error(`no ${name} field in page`);
  return m[1].replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

/** Parses a `WWW-Authenticate: Bearer k="v", ...` header. */
export function parseChallenge(header: string | null): { scheme: string; params: Record<string, string> } {
  if (!header) throw new Error('no WWW-Authenticate header');
  const [scheme = '', ...rest] = header.split(' ');
  const params: Record<string, string> = {};
  for (const m of rest.join(' ').matchAll(/([a-z_]+)="([^"]*)"/g)) params[m[1] as string] = m[2] as string;
  return { scheme, params };
}

export const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'scripted-client', version: '1.0.0' },
  },
});

export const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

/** Reads the first JSON-RPC message from a JSON or SSE response body. */
export async function rpcResult(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    if (!line) throw new Error(`no SSE data in ${text}`);
    return JSON.parse(line.slice(6)) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// A minimal browser (cookie jar, manual redirects) and the owner's actions in it

export class Browser {
  readonly cookies = new Map<string, string>();
  /** Headers sent on every request, e.g. the X-Forwarded-For a reverse proxy would add. */
  readonly headers: Record<string, string> = {};

  readonly base: string;

  constructor(
    private readonly bridge: TestBridge,
    private readonly origin: string | undefined = bridge.publicUrl,
  ) {
    this.base = bridge.publicUrl;
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [k, v] of Object.entries(this.headers)) if (!headers.has(k)) headers.set(k, v);
    if (this.cookies.size > 0) {
      headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    if ((init.method ?? 'GET') === 'POST' && this.origin && !headers.has('origin')) {
      headers.set('origin', this.origin);
    }
    const res = await this.bridge.fetch(url, { ...init, headers });
    for (const c of res.headers.getSetCookie()) {
      const [pair = ''] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === '' || /max-age=0/i.test(c) || /expires=Thu, 01 Jan 1970/i.test(c))
        this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  post(
    url: string,
    form: Readonly<Record<string, string | undefined>>,
    headers: Record<string, string> = {},
  ) {
    return this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: formBody(form),
    });
  }

  /** Signs in through the login form; returns the response to the POST. */
  async login(returnTo = '', overrides: { password?: string; totp?: string; username?: string } = {}) {
    const page = await this.request(
      `${this.base}/oauth/login${returnTo ? `?${new URLSearchParams({ return_to: returnTo }).toString()}` : ''}`,
    );
    const html = await page.text();
    return this.post(`${this.base}/oauth/login`, {
      csrf_token: hiddenField(html, 'csrf_token'),
      return_to: returnTo,
      username: overrides.username ?? 'owner',
      password: overrides.password ?? this.bridge.password,
      ...(overrides.totp !== undefined ? { totp: overrides.totp } : {}),
    });
  }
}

export interface AuthorizeParams {
  readonly clientId: string;
  readonly redirectUri?: string;
  readonly challenge?: string;
  readonly method?: string;
  readonly state?: string;
  readonly scope?: string;
  readonly resource?: string | readonly string[];
  readonly responseType?: string;
  readonly extra?: Readonly<Record<string, string>>;
}

export function authorizeUrl(p: AuthorizeParams, base: string = PUBLIC_URL): string {
  const q = formBody({
    response_type: p.responseType ?? 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    code_challenge: p.challenge,
    code_challenge_method: p.method,
    state: p.state,
    scope: p.scope,
    resource: p.resource,
    ...p.extra,
  });
  return `${base}/oauth/authorize?${q}`;
}

export interface ConsentPage {
  readonly html: string;
  readonly requestId: string;
  readonly csrf: string;
}

/**
 * Drives the browser from the authorization URL to the consent page, signing in on the way if
 * the bridge asks. Returns the consent page, or the response if the bridge did not show one.
 */
export async function reachConsent(browser: Browser, url: string): Promise<ConsentPage | Response> {
  let res = await browser.request(url);
  if (res.status === 302 && (res.headers.get('location') ?? '').startsWith('/oauth/login')) {
    const loginUrl = new URL(res.headers.get('location') as string, browser.base);
    const returnTo = loginUrl.searchParams.get('return_to') ?? '';
    const loggedIn = await browser.login(returnTo);
    expect(loggedIn.status).toBe(303);
    expect(loggedIn.headers.get('location')).toBe(returnTo);
    res = await browser.request(new URL(returnTo, browser.base).toString());
  }
  if (res.status !== 200) return res;
  const html = await res.text();
  return { html, requestId: hiddenField(html, 'request_id'), csrf: hiddenField(html, 'csrf_token') };
}

/** The profile and scope fields a consent page preselects (what a browser would submit unchanged). */
export function consentDefaults(html: string): Record<string, string> {
  const unescape = (v: string) => v.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
  const out: Record<string, string> = {};
  const select = (name: string) => {
    const m = new RegExp(`<select id="${name}" name="${name}">([\\s\\S]*?)</select>`).exec(html);
    const opt = m?.[1] ? /<option value="([^"]*)" selected>/.exec(m[1]) : null;
    if (opt?.[1] !== undefined) out[name] = unescape(opt[1]);
  };
  select('profile');
  select('new_kind');
  const label = /name="new_label" value="([^"]*)"/.exec(html);
  if (label?.[1] !== undefined) out.new_label = unescape(label[1]);
  const scope = /name="scope" value="([a-z]+)" checked/.exec(html);
  if (scope?.[1]) out.scope = scope[1];
  return out;
}

export async function decide(
  browser: Browser,
  page: ConsentPage,
  decision: 'approve' | 'deny',
  fields: Readonly<Record<string, string>> = {},
): Promise<{ res: Response; location: URL }> {
  const res = await browser.post(`${browser.base}/oauth/consent`, {
    request_id: page.requestId,
    csrf_token: page.csrf,
    decision,
    ...consentDefaults(page.html),
    ...fields,
  });
  expect(res.status).toBe(303);
  return { res, location: new URL(res.headers.get('location') as string) };
}

/** Full authorization: authorize → (login) → consent → approve. Returns the callback URL. */
export async function authorizeAndApprove(browser: Browser, p: AuthorizeParams): Promise<URL> {
  const page = await reachConsent(browser, authorizeUrl(p, browser.base));
  if (page instanceof Response)
    throw new Error(`expected consent page, got ${page.status} ${await page.text()}`);
  return (await decide(browser, page, 'approve')).location;
}

export async function registerClient(
  bridge: TestBridge,
  metadata: Record<string, unknown>,
): Promise<Response> {
  return bridge.fetch(`${bridge.publicUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(metadata),
  });
}

export async function registerPublicClient(
  bridge: TestBridge,
  redirectUris: readonly string[] = ['https://claude.ai/api/mcp/auth_callback'],
): Promise<string> {
  const res = await registerClient(bridge, {
    client_name: 'Claude',
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

export async function tokenRequest(
  bridge: TestBridge,
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
  headers: Record<string, string> = {},
): Promise<{ res: Response; body: Record<string, unknown>; ms: number }> {
  const started = performance.now();
  const res = await bridge.fetch(`${bridge.publicUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: formBody(params),
  });
  const text = await res.text();
  const ms = performance.now() - started;
  return { res, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, ms };
}

export async function mcpPost(
  bridge: TestBridge,
  token: string | undefined,
  body = INIT_BODY,
  extra: Record<string, string> = {},
) {
  return bridge.fetch(bridge.mcpUrl, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body,
  });
}

/** Runs a complete DCR + PKCE flow and returns the tokens. */
export async function fullFlow(
  bridge: TestBridge,
  opts: { redirectUri?: string; scope?: string; clientId?: string } = {},
): Promise<{ clientId: string; access: string; refresh: string; scope: string; browser: Browser }> {
  const redirectUri = opts.redirectUri ?? 'https://claude.ai/api/mcp/auth_callback';
  const clientId = opts.clientId ?? (await registerPublicClient(bridge, [redirectUri]));
  const browser = new Browser(bridge);
  const { verifier, challenge } = pkcePair();
  const cb = await authorizeAndApprove(browser, {
    clientId,
    redirectUri,
    challenge,
    method: 'S256',
    state: 'st',
    scope: opts.scope ?? 'mcp offline_access',
    resource: bridge.mcpUrl,
  });
  const { res, body } = await tokenRequest(bridge, {
    grant_type: 'authorization_code',
    code: cb.searchParams.get('code') ?? undefined,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: clientId,
    resource: bridge.mcpUrl,
  });
  expect(res.status, JSON.stringify(body)).toBe(200);
  return {
    clientId,
    access: body.access_token as string,
    refresh: body.refresh_token as string,
    scope: body.scope as string,
    browser,
  };
}

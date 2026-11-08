/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- parsed JSON replies and mock data in tests */
/**
 * Harness for the dashboard tests: the REAL bridge (`createBridge`: auth, /mcp, runtime, admin API, static UI) on a
 * local port with chunk 1's mock LK behind it, a real clock (write spacing 0), and helpers for the owner's session,
 * CSRF token, a streaming SSE reader, and a bearer token from a real OAuth flow.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { adminPlugin, ADMIN_CSRF_PURPOSE } from '../../src/admin/index.js';
import type { AuthServices } from '../../src/auth/services.js';
import { loadAuthConfig } from '../../src/config/auth.js';
import {
  DEFAULT_TOOLS_SETTINGS,
  defaultAdminSettings,
  loadConfig,
  type AdminSettings,
} from '../../src/config/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/open.js';
import { systemClock } from '../../src/lk/index.js';
import type { Policy } from '../../src/policy/index.js';
import type { Runtime } from '../../src/runtime.js';
import { createBridge } from '../../src/server.js';
import { ownerCredentials, throwawaySecret, type TestBridge } from '../auth/helpers.js';
import { MockLk, type MockRequest, type MockResponse } from '../contract/mock-lk.js';

export const API_KEY = 'mock-key-not-real';
export const PROJECT = 'proj_mock';
export const PUBLIC_URL = 'https://lk.example.test';

export interface AdminStackOptions {
  readonly respond?: (req: MockRequest) => MockResponse | undefined;
  readonly env?: Record<string, string>;
  readonly admin?: Partial<AdminSettings>;
  readonly dbPath?: string;
  /** Write a minimal built dashboard here (index.html and one asset) so /ui can be served. Default: yes. */
  readonly withUi?: boolean;
}

export interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: any;
}

export interface CallOptions {
  readonly body?: unknown;
  /** Defaults to the owner's cookie. `null`: no cookie. */
  readonly cookie?: string | null;
  /** Defaults to the real CSRF token for the session. `null`: send none. */
  readonly csrf?: string | null;
  /** Defaults to the bridge's public URL. `null`: send none. */
  readonly origin?: string | null;
  readonly authorization?: string;
}

export interface AdminStack {
  readonly runtime: Runtime;
  readonly policy: Policy;
  readonly services: AuthServices;
  readonly db: Db;
  readonly dbPath: string;
  readonly base: string;
  readonly uiDir: string;
  readonly mock: MockLk;
  readonly bridge: TestBridge;
  /** The owner's session cookie value, its header, and the CSRF token the dashboard would use. */
  readonly sessionToken: string;
  readonly cookie: string;
  readonly csrf: string;
  /** Every method and URL the admin plugin registers (collected from Fastify's `onRoute`). */
  readonly routes: readonly { method: string; url: string }[];
  call(method: string, path: string, o?: CallOptions): Promise<Reply>;
  get(path: string, o?: CallOptions): Promise<Reply>;
  post(path: string, body?: unknown, o?: CallOptions): Promise<Reply>;
  put(path: string, body?: unknown, o?: CallOptions): Promise<Reply>;
  /** Audit rows (newest first) and the policy events seen on the engine's emitter. */
  audit(action?: string): ReturnType<Policy['commands']['listAudit']>;
  events: { action: string; actor: string; target: string | null }[];
  /** Holds every LegendKeeper request matching `match` until the returned function is called. */
  hold(match: (method: string, url: string) => boolean): () => void;
  /** Like `hold`, but requests are let through one at a time: `releaseOne()` frees the oldest waiting request. */
  gate(match: (method: string, url: string) => boolean): {
    waiting(): number;
    releaseOne(): void;
    releaseAll(): void;
  };
  close(): Promise<void>;
}

export async function startAdminStack(o: AdminStackOptions = {}): Promise<AdminStack> {
  const mock = new MockLk({
    clock: systemClock,
    apiKey: API_KEY,
    ...(o.respond ? { respond: o.respond } : {}),
  });
  const lkUrl = await mock.start();
  const dir = mkdtempSync(join(tmpdir(), 'lkb-admin-'));
  const dbPath = o.dbPath ?? join(dir, 'bridge.db');
  const uiDir = join(dir, 'ui-dist');
  if (o.withUi !== false) {
    mkdirSync(join(uiDir, 'assets'), { recursive: true });
    writeFileSync(
      join(uiDir, 'index.html'),
      '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>LK-Bridge</title></head><body><div id="root"></div><script type="module" src="/ui/assets/app.js"></script></body></html>',
    );
    writeFileSync(join(uiDir, 'assets', 'app.js'), 'export {};');
  }
  const db = openDatabase(dbPath);
  runMigrations(db);
  const envConfig = {
    BRIDGE_PUBLIC_URL: PUBLIC_URL,
    LK_API_KEY: API_KEY,
    LK_PROJECT_ID: PROJECT,
    LK_BASE_URL: lkUrl,
    LK_READ_ONLY: 'false',
    WRITE_SPACING_MS: '0',
    WRITE_SPACING_STRETCHED_MS: '0',
    LOG_LEVEL: 'silent',
    SESSION_SECRET: throwawaySecret(),
    JWT_SIGNING_KEY: throwawaySecret(),
    ...o.env,
  };
  const config = loadConfig(envConfig);
  const { password, hash } = await ownerCredentials();
  const authConfig = loadAuthConfig({
    BRIDGE_PUBLIC_URL: PUBLIC_URL,
    OWNER_PASSWORD_HASH: hash,
    SESSION_SECRET: throwawaySecret(),
    JWT_SIGNING_KEY: throwawaySecret(),
  });
  const adminSettings = defaultAdminSettings({
    streamHeartbeatMs: 200,
    budgetPushMs: 150,
    budgetSampleMs: 0, // the sampler has its own test
    ...o.admin,
  });
  const holds: { match: (method: string, url: string) => boolean; gate: Promise<void> }[] = [];
  const { app, services, runtime } = await createBridge({
    config,
    authConfig,
    toolsSettings: DEFAULT_TOOLS_SETTINGS,
    db,
    version: '0.0.0-test',
    logLevel: 'silent',
    pruneIntervalMs: 0,
    adminSettings,
    uiDir,
    lkTransport: async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const url = input instanceof Request ? input.url : input.toString();
      for (const h of [...holds]) if (h.match(method, url)) await h.gate;
      return fetch(input, init);
    },
  });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const policy = runtime.policy;

  const events: AdminStack['events'] = [];
  runtime.engine.events.on('policy', (e) =>
    events.push({ action: e.action, actor: e.actor, target: e.target }),
  );

  // A second, throwaway Fastify instance that only enumerates the routes the admin plugin registers.
  const probe = Fastify({ logger: false });
  const routes: { method: string; url: string }[] = [];
  probe.addHook('onRoute', (r) => {
    for (const m of [r.method].flat())
      if (m !== 'HEAD' && m !== 'OPTIONS') routes.push({ method: m, url: r.url });
  });
  await probe.register(adminPlugin, {
    runtime,
    services,
    settings: adminSettings,
    version: '0.0.0-test',
    uiDir,
  });
  await probe.ready();
  await probe.close();

  const sessionToken = services.owner.createSession('127.0.0.1', 'vitest');
  const cookie = `${services.owner.sessionCookie}=${sessionToken}`;
  const csrf = services.owner.csrfToken(sessionToken, ADMIN_CSRF_PURPOSE);

  const call: AdminStack['call'] = async (method, path, c = {}) => {
    const headers: Record<string, string> = {};
    if (c.cookie !== null) headers.cookie = c.cookie ?? cookie;
    if (c.csrf !== null && method !== 'GET') headers['x-csrf-token'] = c.csrf ?? csrf;
    if (c.origin !== null) headers.origin = c.origin ?? PUBLIC_URL;
    if (c.authorization) headers.authorization = c.authorization;
    let body: string | undefined;
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(c.body ?? {});
    }
    const res = await fetch(base + path, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: 'manual',
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, text, json };
  };

  const local = (url: string) => (url.startsWith(PUBLIC_URL) ? base + url.slice(PUBLIC_URL.length) : url);
  const bridge: TestBridge = {
    app,
    services,
    policy,
    config: authConfig,
    db,
    base,
    publicUrl: authConfig.publicUrl,
    mcpUrl: authConfig.mcpUrl,
    password,
    totpSecret: undefined,
    clock: { now: () => Math.floor(Date.now() / 1000), advance: () => undefined },
    logs: [],
    local,
    fetch: (url, init) => fetch(local(url), { redirect: 'manual', ...init }),
    close: () => Promise.resolve(),
  };

  return {
    runtime,
    policy,
    services,
    db,
    dbPath,
    base,
    uiDir,
    mock,
    bridge,
    sessionToken,
    cookie,
    csrf,
    routes,
    call,
    get: (path, c) => call('GET', path, c),
    post: (path, body, c) => call('POST', path, { ...c, body }),
    put: (path, body, c) => call('PUT', path, { ...c, body }),
    audit: (action) => policy.commands.listAudit('owner', { limit: 500, ...(action ? { action } : {}) }),
    events,
    hold(match) {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      const h = { match, gate };
      holds.push(h);
      return () => {
        holds.splice(holds.indexOf(h), 1);
        release();
      };
    },
    gate(match) {
      const queue: (() => void)[] = [];
      const h = {
        match,
        get gate(): Promise<void> {
          return new Promise<void>((resolve) => queue.push(resolve));
        },
      };
      holds.push(h);
      return {
        waiting: () => queue.length,
        releaseOne: () => queue.shift()?.(),
        releaseAll: () => {
          holds.splice(holds.indexOf(h), 1);
          while (queue.length) queue.shift()?.();
        },
      };
    },
    async close() {
      await runtime.shutdown(500);
      await app.close();
      db.close();
      await mock.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------------------------- SSE reader

export interface SseFrame {
  readonly id?: string;
  readonly event: string;
  readonly data: any;
}

export interface SseConnection {
  readonly status: number;
  readonly headers: Headers;
  readonly frames: SseFrame[];
  /** Resolves with the first frame (already seen or still to come) that matches. */
  waitFor(match: (f: SseFrame) => boolean, timeoutMs?: number): Promise<SseFrame>;
  /** Resolves when the server ends the stream. */
  readonly ended: Promise<void>;
  close(): void;
}

export async function openStream(
  stack: Pick<AdminStack, 'base' | 'cookie'>,
  o: { lastEventId?: string; cookie?: string | null } = {},
): Promise<SseConnection> {
  const ac = new AbortController();
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (o.cookie !== null) headers.cookie = o.cookie ?? stack.cookie;
  if (o.lastEventId) headers['last-event-id'] = o.lastEventId;
  const res = await fetch(`${stack.base}/api/admin/stream`, { headers, signal: ac.signal });
  const frames: SseFrame[] = [];
  const waiters: { match: (f: SseFrame) => boolean; resolve: (f: SseFrame) => void }[] = [];
  let finish: () => void = () => undefined;
  const ended = new Promise<void>((r) => (finish = r));
  void (async () => {
    if (!res.body) return finish();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let id: string | undefined;
          let event = 'message';
          let data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('id: ')) id = line.slice(4);
            else if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data === '' && event === 'message') continue; // `retry:` lines and comments
          const frame: SseFrame = { ...(id ? { id } : {}), event, data: data ? JSON.parse(data) : undefined };
          frames.push(frame);
          for (const w of [...waiters]) {
            if (w.match(frame)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(frame);
            }
          }
        }
      }
    } catch {
      // aborted
    }
    finish();
  })();
  return {
    status: res.status,
    headers: res.headers,
    frames,
    ended,
    waitFor(match, timeoutMs = 4000) {
      const seen = frames.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise<SseFrame>((resolve, reject) => {
        const t = setTimeout(
          () =>
            reject(
              new Error(
                `no matching stream frame within ${timeoutMs} ms; saw ${frames.map((f) => f.event).join(', ')}`,
              ),
            ),
          timeoutMs,
        );
        waiters.push({ match, resolve: (f) => (clearTimeout(t), resolve(f)) });
      });
    },
    close: () => ac.abort(),
  };
}

export async function until(done: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 15));
  }
}

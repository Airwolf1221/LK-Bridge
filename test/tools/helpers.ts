/**
 * Harness for the tool tests: the REAL server (auth, /mcp, runtime) on a local port, chunk 1's mock LK behind it,
 * and the official MCP client connected with a personal access token. Real clock; write spacing is set to 0 so
 * tests do not wait, everything else is the production configuration.
 */
import type { Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadAuthConfig } from '../../src/config/auth.js';
import { loadConfig, DEFAULT_TOOLS_SETTINGS, type ToolsSettings } from '../../src/config/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/open.js';
import { systemClock } from '../../src/lk/index.js';
import type { AuthServices } from '../../src/auth/services.js';
import type { Policy, Scope } from '../../src/policy/index.js';
import type { Runtime } from '../../src/runtime.js';
import { createBridge, stopBridgeForRestart, type BridgeStopReport } from '../../src/server.js';
import type { GuardOptions } from '../../src/mcp/tools/upload-http.js';
import { MockLk, type MockRequest, type MockResponse } from '../contract/mock-lk.js';
import { ownerCredentials, throwawaySecret } from '../auth/helpers.js';

export const API_KEY = 'mock-key-not-real';
export const PROJECT = 'proj_mock';

/**
 * CR-2026-11-R3 (fix B): the opt-in memory measurement (`LKB_MEASURE=1`, test/review/r3-fixes/memory.test.ts) measures
 * memory, not LegendKeeper's budget: a 700-page rename makes about 8,000 requests, which at LegendKeeper's 300 a minute
 * and 6,000 an hour (the mock's, and the governor's) take most of an hour. Only then, the mock and the bridge are given
 * tiers large enough to run it at once. Never set in the ordinary suite.
 */
const MEASURE_LIMITS =
  process.env.LKB_MEASURE === '1'
    ? {
        'key-min': 1_000_000,
        'key-hour': 1_000_000,
        'key-day': 10_000_000,
        'project-hour': 1_000_000,
        'write-min': 1_000_000,
        'write-hour': 1_000_000,
        'items-min': 1_000_000,
        'items-hour': 1_000_000,
      }
    : undefined;
export const PUBLIC_URL = 'https://lk.example.test';

export interface StackOptions {
  readonly respond?: (req: MockRequest) => MockResponse | undefined;
  readonly env?: Record<string, string>;
  readonly tools?: Partial<ToolsSettings>;
  readonly uploadGuard?: GuardOptions;
  /** Reuse this database file (restart tests). */
  readonly dbPath?: string;
  readonly limits?: ConstructorParameters<typeof MockLk>[0]['limits'];
  /** v2 E5.5: undocumented per-operation tiers on the mock LegendKeeper (the asset routes'). */
  readonly opTiers?: ConstructorParameters<typeof MockLk>[0]['opTiers'];
  /** Scope of the default token's profile (`tools-test`). Default `write`, so every tool is exercised. */
  readonly scope?: Scope;
  /** v3 F2: every log line, at trace level (to assert what is never logged). Default: silent. */
  readonly logStream?: Writable;
  /** CR-2026-11-R3 (fix A): wraps the bridge's requests to the mock LegendKeeper (delay one, say). Default: fetch. */
  readonly lkTransport?:
    ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) | undefined;
}

export interface Stack {
  readonly mock: MockLk;
  readonly runtime: Runtime;
  readonly db: Db;
  readonly dbPath: string;
  readonly base: string;
  readonly token: string;
  readonly policy: Policy;
  readonly services: AuthServices;
  /** A PAT on profile `label` (created at `scope` if absent), and its id. */
  newToken(label: string, scope: Scope): { token: string; patId: string; profileId: string };
  /** Connects with the default token, or another one. */
  connect(token?: string): Promise<Client>;
  /** Calls a tool and returns the parsed JSON, the footer line and the isError flag. */
  call(client: Client, name: string, args?: Record<string, unknown>): Promise<ToolCall>;
  /**
   * CR-2026-11-R3 (fix A): a restart as a deploy makes one: the bridge is stopped exactly as SIGTERM stops it
   * (`stopBridgeForRestart`), then a new bridge starts on the same database file, the same configuration and the same
   * mock LegendKeeper. `runtime`, `db`, `base`, `policy` and `services` then name the new bridge's; clients connected
   * before must connect again. `beforeStart` runs between the two (the database is closed then).
   */
  restart(o?: {
    readonly stop?: Parameters<typeof stopBridgeForRestart>[1];
    /** Sent as soon as the stop has begun (with the stopping bridge's address): what a caller then gets. */
    readonly duringStop?: (base: string) => Promise<unknown>;
    readonly beforeStart?: () => void | Promise<void>;
  }): Promise<BridgeStopReport>;
  close(): Promise<void>;
}

export interface ToolCall {
  readonly body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  readonly text: string;
  readonly footer: string;
  readonly isError: boolean;
}

export async function startStack(o: StackOptions = {}): Promise<Stack> {
  const mock = new MockLk({
    clock: systemClock,
    apiKey: API_KEY,
    ...(o.respond ? { respond: o.respond } : {}),
    ...(MEASURE_LIMITS
      ? { limits: { ...o.limits, ...MEASURE_LIMITS } }
      : o.limits
        ? { limits: o.limits }
        : {}),
    ...(o.opTiers ? { opTiers: o.opTiers } : {}),
  });
  const lkUrl = await mock.start();
  const dir = o.dbPath ? undefined : mkdtempSync(join(tmpdir(), 'lkb-tools-'));
  const dbPath = o.dbPath ?? join(dir!, 'bridge.db');
  const config = loadConfig({
    BRIDGE_PUBLIC_URL: PUBLIC_URL,
    LK_API_KEY: API_KEY,
    LK_PROJECT_ID: PROJECT,
    LK_BASE_URL: lkUrl,
    LK_READ_ONLY: 'false',
    WRITE_SPACING_MS: '0',
    WRITE_SPACING_STRETCHED_MS: '0',
    // v3 F9 (ADR 0074): the bulk passes (full snapshots, tree builds) at the pace P3 had before F9 (50% of each tier),
    // so the mock worlds that take several full snapshots in a row test their logic, not the 30% default's pacing.
    RESERVE_FLOOR_BULK: '0.5',
    LOG_LEVEL: 'silent',
    SESSION_SECRET: throwawaySecret(),
    JWT_SIGNING_KEY: throwawaySecret(),
    ...o.env,
    // Measurement mode: merged over a world's own (its env's LK_TIER_LIMITS, if any), never replaced by it.
    ...(MEASURE_LIMITS
      ? {
          LK_TIER_LIMITS: JSON.stringify({
            ...(JSON.parse(o.env?.LK_TIER_LIMITS ?? '{}') as Record<string, number>),
            ...MEASURE_LIMITS,
          }),
        }
      : {}),
  });
  const toolsSettings: ToolsSettings = {
    ...DEFAULT_TOOLS_SETTINGS,
    ...o.tools,
    upload: { ...DEFAULT_TOOLS_SETTINGS.upload, ...o.tools?.upload },
  };
  const { password: _p, hash } = await ownerCredentials();
  const authConfig = loadAuthConfig({
    BRIDGE_PUBLIC_URL: PUBLIC_URL,
    OWNER_PASSWORD_HASH: hash,
    SESSION_SECRET: throwawaySecret(),
    JWT_SIGNING_KEY: throwawaySecret(),
  });
  // The real boot path: runtime (engine with the live policy gate) and server, sharing one policy layer.
  const boot = async () => {
    const db = openDatabase(dbPath);
    runMigrations(db);
    const built = await createBridge({
      config,
      authConfig,
      toolsSettings,
      db,
      version: '0.0.0-test',
      logLevel: o.logStream ? 'trace' : 'silent',
      ...(o.logStream ? { logStream: o.logStream } : {}),
      pruneIntervalMs: 0,
      // The mock LK is plain http on loopback; everything else (the upload host) goes through the real guard.
      lkTransport: o.lkTransport ?? ((input, init) => fetch(input, init)),
      ...(o.uploadGuard ? { uploadGuard: o.uploadGuard } : {}),
    });
    const base = await built.app.listen({ host: '127.0.0.1', port: 0 });
    return { ...built, db, base };
  };
  let live = await boot();
  const { runtime } = live;
  const policy = runtime.policy;
  const newToken: Stack['newToken'] = (label, scope) => {
    const policy = live.runtime.policy;
    const services = live.services;
    const profile =
      policy.store.getProfileByLabel(label) ??
      policy.commands.createProfile('owner', { label, kind: 'other', scope });
    const created = services.pats.create({ name: label, profileId: profile.id });
    return { token: created.token, patId: created.pat.id, profileId: profile.id };
  };
  const token = newToken('tools-test', o.scope ?? 'write').token;
  const clients: Client[] = [];
  const stack: Stack = {
    mock,
    get runtime() {
      return live.runtime;
    },
    get db() {
      return live.db;
    },
    dbPath,
    get base() {
      return live.base;
    },
    token,
    get policy() {
      return live.runtime.policy;
    },
    get services() {
      return live.services;
    },
    newToken,
    async connect(with_ = token) {
      const client = new Client({ name: 'lk-bridge-tools-tests', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${live.base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${with_}` } },
      });
      await client.connect(transport);
      clients.push(client);
      return client;
    },
    async call(client, name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      const content = res.content as { type: string; text?: string }[];
      const text = content.map((c) => c.text ?? '').join('\n');
      const lines = text.split('\n');
      const footer = lines.at(-1) ?? '';
      const json = lines.slice(0, -1).join('\n');
      const body = parseBody(json, text);
      return { body, text, footer, isError: res.isError === true };
    },
    async restart(r = {}) {
      for (const c of clients.splice(0)) await c.close().catch(() => undefined);
      const stopping = stopBridgeForRestart(live, r.stop);
      const during = r.duringStop?.(live.base);
      const report = await stopping;
      await during;
      await r.beforeStart?.();
      live = await boot();
      await live.runtime.ready;
      return report;
    },
    async close() {
      for (const c of clients) await c.close().catch(() => undefined);
      await live.runtime.shutdown(500);
      await live.app.close();
      live.db.close();
      await mock.stop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
  return stack;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseBody(json: string, text: string): Record<string, any> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { unparsed: text };
  }
}

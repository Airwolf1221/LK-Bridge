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
import { createBridge } from '../../src/server.js';
import type { GuardOptions } from '../../src/mcp/tools/upload-http.js';
import { MockLk, type MockRequest, type MockResponse } from '../contract/mock-lk.js';
import { ownerCredentials, throwawaySecret } from '../auth/helpers.js';

export const API_KEY = 'mock-key-not-real';
export const PROJECT = 'proj_mock';
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
    ...(o.limits ? { limits: o.limits } : {}),
    ...(o.opTiers ? { opTiers: o.opTiers } : {}),
  });
  const lkUrl = await mock.start();
  const dir = o.dbPath ? undefined : mkdtempSync(join(tmpdir(), 'lkb-tools-'));
  const dbPath = o.dbPath ?? join(dir!, 'bridge.db');
  const db = openDatabase(dbPath);
  runMigrations(db);
  const config = loadConfig({
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
  const { app, services, runtime } = await createBridge({
    config,
    authConfig,
    toolsSettings,
    db,
    version: '0.0.0-test',
    logLevel: o.logStream ? 'trace' : 'silent',
    ...(o.logStream ? { logStream: o.logStream } : {}),
    pruneIntervalMs: 0,
    // The mock LK is plain http on loopback; everything else (the upload host) goes through the real guard.
    lkTransport: (input, init) => fetch(input, init),
    ...(o.uploadGuard ? { uploadGuard: o.uploadGuard } : {}),
  });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const policy = runtime.policy;
  const newToken: Stack['newToken'] = (label, scope) => {
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
    runtime,
    db,
    dbPath,
    base,
    token,
    policy,
    services,
    newToken,
    async connect(with_ = token) {
      const client = new Client({ name: 'lk-bridge-tools-tests', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
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
    async close() {
      for (const c of clients) await c.close().catch(() => undefined);
      await runtime.shutdown(500);
      await app.close();
      db.close();
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

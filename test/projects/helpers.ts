/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON tool results */
/**
 * v2 A1 harness: TWO mock LegendKeeper projects with different keys running at once behind one URL (as LegendKeeper
 * serves every project at the same address), and the REAL bridge (`createBridge`: auth, /mcp, runtime, admin API)
 * configured with `LK_PROJECTS=alpha,beta`. Each project has its own `MockLk` (its own rate windows and record of
 * calls) and its own `LkModel` (its own resources and documents), so anything that crosses from one project to the
 * other shows up in the wrong model, the wrong mock, or the wrong project's queries.
 */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/client';
import { systemClock } from '../../src/lk/index.js';
import { startAdminStack, type AdminStack, type AdminStackOptions, type Reply } from '../admin/helpers.js';
import { MockLk, type CountedTier } from '../contract/mock-lk.js';
import { MultiMockLk } from '../contract/multi-mock.js';
import { LkModel } from '../jobs/lk-model.js';

/** Throwaway mock keys (never real); each one belongs to exactly one mock project. */
export const KEYS = { alpha: 'mock-key-alpha-not-real', beta: 'mock-key-beta-not-real' } as const;
/** The LegendKeeper project id each key belongs to. */
export const IDS = { alpha: 'lkp_alpha', beta: 'lkp_beta' } as const;
export type Name = keyof typeof KEYS;
export const NAMES: readonly Name[] = ['alpha', 'beta'];

export interface ToolCall {
  readonly body: Record<string, any>;
  readonly text: string;
  readonly footer: string;
  readonly isError: boolean;
}

export interface TwoProjects {
  readonly stack: AdminStack;
  readonly models: Record<Name, LkModel>;
  readonly mocks: Record<Name, MockLk>;
  readonly front: MultiMockLk;
  /** The dashboard API (`/api/admin/...`) as the signed-in owner. */
  readonly admin: {
    get(path: string): Promise<Reply>;
    post(path: string, body?: unknown): Promise<Reply>;
    put(path: string, body?: unknown): Promise<Reply>;
  };
  /** A PAT for a new connection with its own profile (`scope`), and an MCP client using it. */
  connect(label: string, scope: 'read' | 'propose' | 'write'): Promise<{ client: Client; patId: string }>;
  /** Calls a tool and returns the parsed JSON, the footer line and the isError flag. */
  call(client: Client, name: string, args?: Record<string, unknown>): Promise<ToolCall>;
  /** Requests each mock project received (by method), for "nothing reached the other project". */
  writesAt(name: Name): number;
  close(): Promise<void>;
}

export interface TwoProjectsOptions {
  /** Extra env (for example `REQUIRE_PROJECT_FOR_WRITES`); `LK_PROJECTS` etc. may be overridden. */
  readonly env?: Record<string, string>;
  /** Per-project mock rate limits. */
  readonly limits?: Partial<Record<Name, Partial<Record<CountedTier, number>>>>;
  /** The LegendKeeper project id each mock reports for its key (default `IDS`). */
  readonly reportedIds?: Partial<Record<Name, string>>;
  /** Further admin-stack options (a database path, captured logs, retry timings). */
  readonly stack?: Omit<AdminStackOptions, 'env' | 'lkBaseUrl'>;
}

export function seed(model: LkModel, name: Name): void {
  model.seedResource(`${name}_root`, { name: `${name} root` });
  model.seedResource(`${name}_doc`, {
    name: `${name} doc`,
    blocks: [{ id: `${name}_p1`, kind: 'paragraph', content: [{ text: `${name} text` }] }],
  });
}

export async function startTwoProjects(o: TwoProjectsOptions = {}): Promise<TwoProjects> {
  const models = {} as Record<Name, LkModel>;
  const mocks = {} as Record<Name, MockLk>;
  for (const name of NAMES) {
    const model = new LkModel(() => systemClock.now());
    seed(model, name);
    models[name] = model;
    mocks[name] = new MockLk({
      clock: systemClock,
      apiKey: KEYS[name],
      projectId: o.reportedIds?.[name] ?? IDS[name],
      projectName: `Project ${name}`,
      respond: model.respond,
      ...(o.limits?.[name] ? { limits: o.limits[name] } : {}),
    });
    await mocks[name].start();
  }
  const front = new MultiMockLk(new Map(NAMES.map((n) => [KEYS[n], mocks[n]])));
  const url = await front.start();
  const stack = await startAdminStack({
    ...o.stack,
    lkBaseUrl: url,
    env: {
      // The single-project form is off: an empty value counts as unset.
      LK_API_KEY: '',
      LK_PROJECT_ID: '',
      LK_PROJECTS: 'alpha,beta',
      LK_PROJECT_ALPHA_API_KEY: KEYS.alpha,
      LK_PROJECT_BETA_API_KEY: KEYS.beta,
      LK_DEFAULT_PROJECT: 'alpha',
      ...o.env,
    },
  });
  const clients: Client[] = [];
  const policy = stack.policy;
  return {
    stack,
    models,
    mocks,
    front,
    admin: {
      get: (path) => stack.get(`/api/admin${path}`),
      post: (path, body) => stack.post(`/api/admin${path}`, body),
      put: (path, body) => stack.put(`/api/admin${path}`, body),
    },
    async connect(label, scope) {
      const profile =
        policy.store.getProfileByLabel(label) ??
        policy.commands.createProfile('owner', { label, kind: 'other', scope });
      const created = stack.services.pats.create({ name: label, profileId: profile.id });
      const client = new Client({ name: 'lk-bridge-projects-tests', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${stack.base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${created.token}` } },
        }),
      );
      clients.push(client);
      return { client, patId: created.pat.id };
    },
    async call(client, name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      const content = res.content as { type: string; text?: string }[];
      const text = content.map((c) => c.text ?? '').join('\n');
      const lines = text.split('\n');
      const footer = lines.at(-1) ?? '';
      let body: Record<string, any>;
      try {
        body = JSON.parse(lines.slice(0, -1).join('\n')) as Record<string, any>;
      } catch {
        body = { unparsed: text };
      }
      return { body, text, footer, isError: res.isError === true };
    },
    writesAt: (name) => mocks[name].calls.filter((c) => c.method !== 'GET').length,
    async close() {
      for (const c of clients) await c.close().catch(() => undefined);
      await stack.close();
      await front.stop();
      for (const name of NAMES) await mocks[name].stop();
    },
  };
}

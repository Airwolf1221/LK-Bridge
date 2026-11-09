/* eslint-disable @typescript-eslint/no-unsafe-assignment -- parsed JSON replies and mock data in tests */
/**
 * Harness for the dashboard component tests (jsdom): a scriptable fake of the admin API (`fetch`), a fake
 * `EventSource` the test pushes stream events into, and a `renderApp` that mounts the real <App> at a given path.
 */
import { render, type RenderResult } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { apiConfig } from '../../ui/src/api';
import { App } from '../../ui/src/app';
import type { SourceFactory, SourceLike } from '../../ui/src/stream';
import type { SessionInfo } from '../../ui/src/types';

export const SESSION: SessionInfo = {
  authenticated: true,
  username: 'owner',
  csrfToken: 'csrf-token-for-tests',
  logoutCsrfToken: 'logout-token',
  logoutPath: '/oauth/logout',
  version: '9.9.9',
  publicUrl: 'https://lk.example.test',
};

// --------------------------------------------------------------------------------------------- event source

export class FakeSource implements SourceLike {
  static all: FakeSource[] = [];
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  readyState = 0;
  closed = false;
  private readonly handlers = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, l: (e: MessageEvent<string>) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), l]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  /** Pushes a stream event, as the bridge frames it: `{ at, data }`. */
  emit(type: string, data: unknown, at = Date.now()): void {
    for (const h of this.handlers.get(type) ?? [])
      h({ data: JSON.stringify({ at, data }) } as MessageEvent<string>);
  }
  fail(): void {
    this.onerror?.(new Event('error'));
  }
}

export const lastSource = (): FakeSource => {
  const s = FakeSource.all.filter((x) => !x.closed).at(-1);
  if (!s) throw new Error('no open stream');
  return s;
};

export const factory: SourceFactory = (url) => new FakeSource(url);

// ------------------------------------------------------------------------------------------------- fake API

export interface Call {
  method: string;
  path: string;
  query: string;
  body: unknown;
  headers: Record<string, string>;
}

type Handler = (call: Call) => unknown;
export type Routes = Record<string, unknown>;

export interface Api {
  calls: Call[];
  routes: Routes;
  /** Calls whose method and path match. */
  find(method: string, path: string | RegExp): Call[];
}

/** `routes` keys are `"GET /overview"`; a value is a JSON body or a function of the call. Unmatched: 404. */
export function installApi(routes: Routes): Api {
  const api: Api = {
    calls: [],
    routes,
    find: (method, path) =>
      api.calls.filter(
        (c) => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path)),
      ),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        'https://lk.example.test',
      );
      const path = url.pathname.replace(/^\/api\/admin/, '');
      const method = (init?.method ?? 'GET').toUpperCase();
      const call: Call = {
        method,
        path,
        query: url.search,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      };
      api.calls.push(call);
      const handler = api.routes[`${method} ${path}`];
      if (handler === undefined) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: 'NOT_FOUND', message: `no mock for ${method} ${path}` } }),
            { status: 404 },
          ),
        );
      }
      const out = typeof handler === 'function' ? (handler as Handler)(call) : handler;
      const res =
        out && typeof out === 'object' && 'status' in out && 'body' in out
          ? (out as { status: number; body: unknown })
          : { status: 200, body: out };
      return Promise.resolve(
        new Response(JSON.stringify(res.body), {
          status: res.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return api;
}

// -------------------------------------------------------------------------------------------- render helper

export function renderApp(path: string, session: SessionInfo = SESSION): RenderResult {
  FakeSource.all = [];
  window.history.replaceState({}, '', path);
  apiConfig.csrfToken = session.csrfToken;
  apiConfig.base = '';
  return render(<App session={session} createSource={factory} />);
}

/** Lets the app finish its first loads and opens the stream (`hello`, as the bridge sends it). */
export async function openStream(): Promise<FakeSource> {
  const { waitFor } = await import('@testing-library/react');
  await waitFor(() => expect(FakeSource.all.length).toBeGreaterThan(0));
  const s = lastSource();
  const { act } = await import('@testing-library/react');
  act(() => {
    s.open();
    s.emit('hello', { bootId: 'abcd1234', lastId: 0, resumed: false, heartbeatMs: 15_000 });
  });
  return s;
}

// --------------------------------------------------------------------------------------------- mock data

/** The two projects of the mock bridge (v2 A1): `baisheng` (the default) and `test` (a sandbox). */
export const PROJECT_ID = 'lkp_baisheng';
export const OTHER_PROJECT_ID = 'lkp_test';

/** The `project` query parameter of a request (null: none). */
export const projectOf = (call: Pick<Call, 'query'>): string | null =>
  new URLSearchParams(call.query).get('project');

export const project = (over: Record<string, unknown> = {}) => ({
  name: 'baisheng',
  id: PROJECT_ID,
  displayName: 'Baisheng',
  isDefault: true,
  isSandbox: false,
  readOnly: false,
  configured: true,
  registered: true,
  status: 'active',
  reason: null,
  keyVariable: 'LK_PROJECT_BAISHENG_API_KEY',
  keyPresent: true,
  keyValid: true,
  verifiedAt: Date.now() - 3_600_000,
  checkedAt: Date.now() - 60_000,
  settings: {},
  settingsProblem: null,
  ...over,
});

export const otherProject = (over: Record<string, unknown> = {}) =>
  project({
    name: 'test',
    id: OTHER_PROJECT_ID,
    displayName: 'Test world',
    isDefault: false,
    isSandbox: true,
    keyVariable: 'LK_PROJECT_TEST_API_KEY',
    ...over,
  });

export const SETTING_KEYS = [
  { key: 'aiRepositoryRootId', label: 'AI REPOSITORY root', kind: 'resource id' },
  { key: 'charactersRootId', label: 'Characters root', kind: 'resource id' },
  { key: 'chronologyResourceId', label: 'Chronology resource', kind: 'resource id' },
  { key: 'templateIds', label: 'Template ids', kind: 'role → template id' },
];

/** `GET /projects`. */
export const projectsJson = (projects: unknown[] = [project(), otherProject()]) => ({
  default: 'baisheng',
  requireProjectForWrites: true,
  singleProjectForm: false,
  settingKeys: SETTING_KEYS,
  projects,
});

/** A live `budget` event: every project's budget by LegendKeeper id (default: only the default project's). */
export const budgetEvent = (
  projects: Record<string, { snapshot: unknown; writesPerMinute: number; name?: string }>,
) => ({
  projects: Object.fromEntries(
    Object.entries(projects).map(([id, b]) => [
      id,
      { name: b.name ?? (id === PROJECT_ID ? 'baisheng' : 'test'), ...b },
    ]),
  ),
});

export const tier = (
  id: string,
  used: number,
  limit: number | null,
  extra: Record<string, unknown> = {},
) => ({
  tier: id,
  limit,
  configuredLimit: limit,
  used,
  remaining: limit === null ? null : limit - used,
  windowMs: limit === null ? null : 60_000,
  resetAtMs: limit === null ? null : Date.now() + 30_000,
  blockedUntilMs: null,
  inFlight: 0,
  reactiveOnly: limit === null,
  drift: null,
  ...extra,
});

export const snapshot = (over: Record<string, Record<string, unknown>> = {}) => ({
  atMs: Date.now(),
  tiers: Object.fromEntries(
    [
      ['write-min', 12, 120],
      ['write-hour', 40, 3000],
      ['key-min', 30, 300],
      ['key-hour', 900, 6000],
      ['key-day', 5000, 60000],
      ['project-hour', 2000, 12000],
      ['items-min', 0, 600],
      ['items-hour', 0, 6000],
      ['upload', 0, null],
    ].map(([id, used, limit]) => [
      id,
      tier(id as string, used as number, limit as number | null, over[id as string] ?? {}),
    ]),
  ),
  queues: { P0: 0, P1: 1, P2: 14, P3: 0 },
  inFlight: 2,
  writeSpacingMs: 500,
  nextWriteAtMs: null,
});

export const controls = (over: Record<string, unknown> = {}) => ({
  writesPaused: false,
  draining: false,
  readOnly: false,
  readOnlyOverride: null,
  writersMax: 2,
  allowMemberAdmin: false,
  ...over,
});

export const job = (over: Record<string, unknown> = {}) => ({
  id: 'job_1',
  projectId: PROJECT_ID,
  kind: 'batch_ops',
  title: 'Rewrite the Kingdom page',
  origin: { kind: 'mcp', tool: 'lk_api_batch' },
  principalId: 'pat_abc',
  profile: 'Claude Code',
  approvedBy: null,
  priority: 'P2',
  status: 'running',
  progress: { stepsDone: 2, stepsTotal: 10, stepsFailed: 0 },
  currentStep: 3,
  resumeAt: null,
  waitReason: null,
  pauseRequested: false,
  cancelRequested: false,
  uncertain: false,
  lastError: null,
  result: null,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 1000,
  startedAt: Date.now() - 55_000,
  finishedAt: null,
  ...over,
});

export const step = (over: Record<string, unknown> = {}) => ({
  jobId: 'job_1',
  projectId: PROJECT_ID,
  stepNo: 1,
  opId: 'replaceDocumentBlocks',
  opKind: 'write',
  params: { path: { documentId: 'doc1' }, body: { blocks: [] } },
  attempt0: 0,
  idempotencyKey: null,
  clientIds: [],
  ifMatch: 'v3',
  status: 'succeeded',
  attempts: 1,
  maybeSent: false,
  requestIds: ['lkb.req-001'],
  resultSummary: { id: 'doc1' },
  error: null,
  startedAt: null,
  finishedAt: null,
  retry: { allowed: false, ambiguous: false, warning: null },
  ...over,
});

export const profiles = [
  { id: 'prof_claude', label: 'Claude', kind: 'claude', scope: 'read', connections: 1 },
  { id: 'prof_cc', label: 'claude-code', kind: 'claude-code', scope: 'write', connections: 1 },
];

export const connections = [
  {
    id: 'grant_1',
    type: 'grant',
    label: 'Claude (untrusted name)',
    clientId: 'c1',
    profileId: 'prof_claude',
    profile: 'Claude',
    scope: 'read',
    createdAt: Date.now() - 86_400_000,
    lastUsedAt: Date.now() - 120_000,
    expiresAt: null,
    revokedAt: null,
    active: true,
  },
  {
    id: 'pat_1',
    type: 'pat',
    label: 'Laptop',
    clientId: null,
    profileId: 'prof_cc',
    profile: 'claude-code',
    scope: 'write',
    createdAt: Date.now() - 3_600_000,
    lastUsedAt: null,
    expiresAt: Date.now() + 86_400_000 * 30,
    revokedAt: null,
    active: true,
  },
];

export const baseRoutes = (): Routes => ({
  'GET /projects': projectsJson(),
  // The selected project's counts by state; `byProject` holds every project's pending count.
  'GET /proposals/counts': (c: Call) => {
    const name = projectOf(c) ?? 'baisheng';
    return name === 'test'
      ? {
          project: { id: OTHER_PROJECT_ID, name },
          counts: { pending: 5 },
          byProject: { baisheng: 2, test: 5 },
        }
      : {
          project: { id: PROJECT_ID, name },
          counts: { pending: 2, conflicted: 1 },
          byProject: { baisheng: 2, test: 5 },
        };
  },
  'GET /clients': {
    profiles,
    defaultScope: 'read',
    connections,
    kinds: ['claude', 'chatgpt', 'claude-code', 'other'],
    scopes: ['read', 'propose', 'write'],
  },
});

/** Per-file setup: jest-dom matchers, cleanup, and no stubs left behind. Call at the top level of a test file. */
export function useDom(): void {
  void import('@testing-library/jest-dom/vitest');
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON tool results */
/**
 * OPS2 harness: the REAL bridge (`createBridge` through the dashboard harness) in front of several mock LegendKeeper
 * projects behind one URL. Unlike v2 A1's front, a project here may answer to more than one key (so a key can be
 * replaced by another key of the SAME project), and the front records which key each request carried, so a test can
 * prove that a replaced key is no longer used and that a project's calls never reach another project.
 *
 * Every key and secret here is a throwaway test value, made at run time.
 */
import { randomBytes } from 'node:crypto';
import { StreamableHTTPClientTransport, Client } from '@modelcontextprotocol/client';
import Fastify from 'fastify';
import { systemClock } from '../../src/lk/index.js';
import { startAdminStack, type AdminStack, type AdminStackOptions, type Reply } from '../admin/helpers.js';
import { MockLk } from '../contract/mock-lk.js';
import { LkModel } from '../jobs/lk-model.js';

/** A distinctive throwaway key (never real): easy to find in any output a test scans. */
export const testKey = (label: string): string =>
  `TESTKEY${label.toUpperCase().replace(/[^A-Z0-9]/g, '')}-${randomBytes(12).toString('hex')}`;

export interface MockProject {
  readonly name: string;
  readonly id: string;
  /** The keys LegendKeeper accepts for this project (the first is the mock's own). */
  readonly keys: string[];
  readonly model: LkModel;
  readonly mock: MockLk;
  /** The key each request to this project carried, in order. */
  readonly used: string[];
}

export interface Managed {
  readonly stack: AdminStack;
  readonly projects: Record<string, MockProject>;
  readonly lkUrl: string;
  /** Another key LegendKeeper accepts for `name`'s project (for a replacement). */
  addKey(name: string): string;
  /** A key LegendKeeper refuses (401). */
  readonly refusedKey: string;
  admin: {
    get(path: string): Promise<Reply>;
    post(path: string, body?: unknown): Promise<Reply>;
    put(path: string, body?: unknown): Promise<Reply>;
  };
  /** Re-authenticates the stack's owner session (password, and `totp` when given). */
  reauth(totp?: string): Promise<Reply>;
  connect(label: string, scope: 'read' | 'propose' | 'write'): Promise<Client>;
  call(
    client: Client,
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ body: any; text: string; isError: boolean }>;
  close(): Promise<void>;
}

export interface ManagedOptions {
  /** The LegendKeeper projects that exist (each gets a mock). */
  readonly lk: readonly { readonly name: string; readonly id?: string }[];
  /** Which of them the env file lists (LK_PROJECTS), with their first key. Default: none. */
  readonly envProjects?: readonly string[];
  readonly env?: Record<string, string>;
  readonly stack?: Omit<AdminStackOptions, 'env' | 'lkBaseUrl'>;
  /** Keys to reuse (a second start against the same database). */
  readonly keys?: Record<string, string>;
  /** Further keys LegendKeeper accepts for a project from the start (a key stored by an earlier run). */
  readonly extraKeys?: Record<string, readonly string[]>;
}

export async function startManaged(o: ManagedOptions): Promise<Managed> {
  const projects: Record<string, MockProject> = {};
  const byKey = new Map<string, MockProject>();
  for (const p of o.lk) {
    const model = new LkModel(() => systemClock.now());
    model.seedResource(`${p.name}_root`, { name: `${p.name} root` });
    // An owner the key can see with an email: LegendKeeper shows emails to ADMIN keys only.
    model.members.set('u1', { id: 'u1', role: 'OWNER', email: 'owner@example.test' });
    const key = o.keys?.[p.name] ?? testKey(p.name);
    const mock = new MockLk({
      clock: systemClock,
      apiKey: key,
      projectId: p.id ?? `lkp_${p.name}`,
      projectName: `Project ${p.name}`,
      respond: model.respond,
    });
    await mock.start();
    const mp: MockProject = { name: p.name, id: p.id ?? `lkp_${p.name}`, keys: [key], model, mock, used: [] };
    projects[p.name] = mp;
    byKey.set(key, mp);
    for (const k of o.extraKeys?.[p.name] ?? []) {
      mp.keys.push(k);
      byKey.set(k, mp);
    }
  }
  const front = Fastify({ logger: false });
  front.removeAllContentTypeParsers();
  front.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  front.all('/api/v3/*', async (req, reply) => {
    const auth = req.headers.authorization ?? '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const target = byKey.get(key);
    if (!target) {
      return reply
        .code(401)
        .type('application/json')
        .send({ message: 'mock UNAUTHENTICATED', code: 'UNAUTHENTICATED' });
    }
    target.used.push(key);
    const headers: Record<string, string> = { authorization: `Bearer ${target.keys[0]}` };
    for (const h of ['idempotency-key', 'if-match', 'x-request-id', 'content-type']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    const res = await fetch(`${target.mock.url}${req.url}`, {
      method: req.method,
      headers,
      ...(req.body instanceof Buffer && req.body.length > 0 ? { body: req.body } : {}),
    });
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (/^(x-ratelimit-|retry-after|x-request-id|idempotent-replay|content-type)/.test(k)) out[k] = v;
    });
    const text = await res.text();
    return reply
      .code(res.status)
      .headers(out)
      .send(text === '' ? undefined : text);
  });
  const lkUrl = await front.listen({ port: 0, host: '127.0.0.1' });

  const env: Record<string, string> = { LK_API_KEY: '', LK_PROJECT_ID: '' };
  const listed = o.envProjects ?? [];
  if (listed.length > 0) {
    env.LK_PROJECTS = listed.join(',');
    env.LK_DEFAULT_PROJECT = listed[0]!;
    for (const n of listed) env[`LK_PROJECT_${n.toUpperCase()}_API_KEY`] = projects[n]!.keys[0]!;
  }
  const stack = await startAdminStack({ ...o.stack, lkBaseUrl: lkUrl, env: { ...env, ...o.env } });
  const clients: Client[] = [];
  const admin = {
    get: (path: string) => stack.get(`/api/admin${path}`),
    post: (path: string, body?: unknown) => stack.post(`/api/admin${path}`, body),
    put: (path: string, body?: unknown) => stack.put(`/api/admin${path}`, body),
  };
  return {
    stack,
    projects,
    lkUrl,
    refusedKey: testKey('refused'),
    addKey(name) {
      const p = projects[name]!;
      const k = testKey(`${name}two`);
      p.keys.push(k);
      byKey.set(k, p);
      return k;
    },
    admin,
    reauth: (totp) =>
      admin.post('/security/reauth', { password: stack.bridge.password, ...(totp ? { totp } : {}) }),
    async connect(label, scope) {
      const policy = stack.policy;
      const profile =
        policy.store.getProfileByLabel(label) ??
        policy.commands.createProfile('owner', { label, kind: 'other', scope });
      const created = stack.services.pats.create({ name: label, profileId: profile.id });
      const client = new Client({ name: 'lk-bridge-ops2-tests', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${stack.base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${created.token}` } },
        }),
      );
      clients.push(client);
      return client;
    },
    async call(client, name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      const content = res.content as { type: string; text?: string }[];
      const text = content.map((c) => c.text ?? '').join('\n');
      const lines = text.split('\n');
      let body: any;
      try {
        body = JSON.parse(lines.slice(0, -1).join('\n'));
      } catch {
        body = { unparsed: text };
      }
      return { body, text, isError: res.isError === true };
    },
    async close() {
      for (const c of clients) await c.close().catch(() => undefined);
      await stack.close();
      await front.close();
      for (const p of Object.values(projects)) await p.mock.stop();
    },
  };
}

/** Adds a project through the dashboard the way the owner does: re-authenticate, check the key, confirm. */
export async function addProject(
  m: Managed,
  name: string,
  key: string,
): Promise<{ check: Reply; confirm: Reply }> {
  const r = await m.reauth();
  if (r.status !== 200) throw new Error(`re-authentication failed: ${r.status} ${r.text}`);
  const check = await m.admin.post('/projects/check', { name, apiKey: key });
  if (check.status !== 200) return { check, confirm: check };
  const confirm = await m.admin.post('/projects/confirm', { checkId: check.json.checkId, confirm: true });
  return { check, confirm };
}

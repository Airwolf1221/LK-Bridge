/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies and mock data in tests */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '../../src/lk/index.js';
import { LkModel } from '../jobs/lk-model.js';
import { openStream, startAdminStack, until, type AdminStack, type SseConnection } from './helpers.js';

const model = new LkModel(() => systemClock.now());
let stack: AdminStack;
const open: SseConnection[] = [];
const connect = async (o: Parameters<typeof openStream>[1] = {}) => {
  const c = await openStream(stack, o);
  open.push(c);
  return c;
};

beforeAll(async () => {
  stack = await startAdminStack({ respond: model.respond, admin: { streamReplayEvents: 40 } });
});
afterAll(async () => {
  for (const c of open) c.close();
  await stack.close();
});

const runJob = async (name: string) => {
  const r = (await stack.runtime.engine.submit({
    kind: 'batch_ops',
    title: name,
    origin: { kind: 'ui', tool: 'stream-test' },
    steps: [{ op: 'createResource', params: { body: { name } } }],
  })) as { jobId: string };
  await until(() => stack.runtime.engine.queries.getJob(r.jobId)?.status === 'succeeded');
  return r.jobId;
};

describe('the live stream', () => {
  it('needs the owner session and says so in JSON', async () => {
    const r = await stack.get('/api/admin/stream', { cookie: null });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('UNAUTHENTICATED');
  });

  it('opens as an event stream with a hello and a first budget snapshot', async () => {
    const c = await connect();
    expect(c.status).toBe(200);
    expect(c.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(c.headers.get('cache-control')).toMatch(/no-store/);
    const hello = await c.waitFor((f) => f.event === 'hello');
    expect(hello.data.data).toMatchObject({ resumed: false, heartbeatMs: 200 });
    const budget = await c.waitFor((f) => f.event === 'budget');
    expect(budget.data.data.snapshot.tiers['write-min']).toMatchObject({ limit: 120, windowMs: 60_000 });
    expect(budget.data.data.snapshot.tiers.upload.reactiveOnly).toBe(true);
    expect(budget.data.data.writesPerMinute).toBeTypeOf('number');
  });

  it('carries engine, governor and policy events as they happen', async () => {
    const c = await connect();
    const jobId = await runJob('Live job');
    const created = await c.waitFor(
      (f) => f.event === 'job' && f.data.data.job.id === jobId && f.data.data.type === 'created',
    );
    expect(created.id).toMatch(/^[0-9a-f]{8}-\d+$/);
    await c.waitFor(
      (f) => f.event === 'job' && f.data.data.job.id === jobId && f.data.data.job.status === 'succeeded',
    );
    await c.waitFor((f) => f.event === 'step' && f.data.data.jobId === jobId);
    await c.waitFor((f) => f.event === 'writers');

    await stack.put('/api/admin/writers/max', { value: 3 });
    await c.waitFor((f) => f.event === 'controls' && f.data.data.writersMax === 3);
    await c.waitFor((f) => f.event === 'policy' && f.data.data.action === 'writers.set_max');
    await stack.put('/api/admin/writers/max', { value: 2 });

    // Budget snapshots keep coming without anyone asking.
    const n = c.frames.filter((f) => f.event === 'budget').length;
    await until(() => c.frames.filter((f) => f.event === 'budget').length >= n + 2);
  });

  it('sends heartbeats as events a page can watch for', async () => {
    const c = await connect();
    await c.waitFor((f) => f.event === 'heartbeat');
    await until(() => c.frames.filter((f) => f.event === 'heartbeat').length >= 2);
  });

  it('never puts a secret in an event', async () => {
    const c = await connect();
    stack.runtime.engine.events.emit('error', {
      id: 1,
      at: Date.now(),
      opId: 'createImageUpload',
      jobId: null,
      stepNo: null,
      principalId: 'system',
      profile: 'system',
      status: 500,
      code: 'X',
      message: 'boom',
      issues: [],
      path: '',
      requestId: 'r',
      retryable: false,
      classification: 'bridge',
      fingerprint: 'fp',
      resolvedAt: null,
      detail: {
        uploadUrl: 'https://storage.example/signed?sig=SECRETSIG',
        headers: { authorization: 'Bearer SECRETTOKEN' },
        dataBase64: 'AAAA',
      },
    });
    const f = await c.waitFor((x) => x.event === 'error' && x.data.data.fingerprint === 'fp');
    const text = JSON.stringify(f);
    expect(text).not.toContain('SECRETSIG');
    expect(text).not.toContain('SECRETTOKEN');
    expect(text).not.toContain('AAAA');
    expect(f.data.data.detail.uploadUrl).toBe('[redacted]');
  });
});

describe('reconnection', () => {
  it('replays what a returning dashboard missed, in order, and nothing it already had', async () => {
    const c1 = await connect();
    await c1.waitFor((f) => f.event === 'hello');
    await runJob('Before leaving');
    await until(() => c1.frames.some((f) => f.id && f.event === 'job'));
    await new Promise((r) => setTimeout(r, 100));
    const lastSeen = [...c1.frames].reverse().find((f) => f.id)!.id!;
    c1.close();

    const missedJob = await runJob('While away');
    const c2 = await connect({ lastEventId: lastSeen });
    const hello = await c2.waitFor((f) => f.event === 'hello');
    expect(hello.data.data.resumed).toBe(true);
    await c2.waitFor((f) => f.event === 'job' && f.data.data.job.id === missedJob);
    const replayed = c2.frames.filter((f) => f.id);
    const nums = replayed.map((f) => Number(f.id!.split('-')[1]));
    const seenNum = Number(lastSeen.split('-')[1]);
    expect(nums.every((n) => n > seenNum)).toBe(true);
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    expect(c2.frames.some((f) => f.event === 'resync')).toBe(false);
  });

  it('resumes cleanly at the very end (nothing missed)', async () => {
    const c1 = await connect();
    await c1.waitFor((f) => f.event === 'hello');
    const last = c1.frames.find((f) => f.event === 'hello')!.data.data.lastId as number;
    const boot = c1.frames.find((f) => f.event === 'hello')!.data.data.bootId as string;
    c1.close();
    const c2 = await connect({ lastEventId: `${boot}-${last}` });
    expect((await c2.waitFor((f) => f.event === 'hello')).data.data.resumed).toBe(true);
  });

  it('tells a dashboard to resync when its position is from another server run', async () => {
    const c = await connect({ lastEventId: 'deadbeef-12' });
    const f = await c.waitFor((x) => x.event === 'resync');
    expect(f.data.data.reason).toBe('position_unavailable');
    expect(c.frames.some((x) => x.event === 'hello')).toBe(false);
    // Garbage is treated the same way.
    const g = await connect({ lastEventId: 'not an id' });
    await g.waitFor((x) => x.event === 'resync');
  });

  it('tells a dashboard to resync when it was away longer than the replay buffer reaches', async () => {
    const c1 = await connect();
    const hello = await c1.waitFor((f) => f.event === 'hello');
    const boot = hello.data.data.bootId as string;
    const from = hello.data.data.lastId as number;
    c1.close();
    // More than the 40 buffered events happen while it is away.
    for (let i = 0; i < 12; i++) await runJob(`Busy ${i}`);
    const c2 = await connect({ lastEventId: `${boot}-${Math.max(0, from - 1)}` });
    await c2.waitFor((f) => f.event === 'resync');
  });
});

describe('sessions on the stream', () => {
  it('ends the stream, with a reason, when the owner signs out', async () => {
    const token = stack.services.owner.createSession('127.0.0.1', 'vitest');
    const cookie = `${stack.services.owner.sessionCookie}=${token}`;
    const c = await connect({ cookie });
    await c.waitFor((f) => f.event === 'hello');
    stack.services.owner.logout(token, '127.0.0.1');
    const f = await c.waitFor((x) => x.event === 'unauthenticated');
    expect(f.data.data.reason).toBe('session_ended');
    await c.ended;
  });
});

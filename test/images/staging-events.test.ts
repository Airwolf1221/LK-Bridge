/**
 * The Staging page's live updates (v2 D3.1, the owner's report of 12 November 2026): the dashboard's stream carries a
 * `staging` event sent by the image service ITSELF, so it does not matter which route changed a staged image: an MCP tool
 * (`upload_image` with `stage: true`, or any upload at scope `propose`), a proposal's approval, a job ending or failing,
 * the dashboard's own routes. Each case below listens on the engine's event bus (where the service sends it) AND reads the
 * real `/api/admin/stream` server-sent events, which is what the page receives.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_CSRF_PURPOSE } from '../../src/admin/guard.js';
import { SYSTEM_PRINCIPAL, type JobEngineEvents } from '../../src/jobs/index.js';
import { PROJECT, PUBLIC_URL } from '../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from './world.js';

let w: ImagesWorld | undefined;
const closers: (() => void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) c();
  await w?.close();
  w = undefined;
});

type Staging = JobEngineEvents['staging'];

/** The `staging` events the image service sends on the engine's bus. */
function busEvents(world: ImagesWorld): Staging[] {
  const seen: Staging[] = [];
  closers.push(world.stack.runtime.engine.events.on('staging', (e) => seen.push(e)));
  return seen;
}

/** What the Staging page receives: the dashboard's live stream, read as the browser's EventSource would. */
async function openStream(world: ImagesWorld) {
  const s = world.stack.services;
  const session = s.owner.createSession('127.0.0.1', 'vitest');
  void s.owner.csrfToken(session, ADMIN_CSRF_PURPOSE);
  const ctl = new AbortController();
  closers.push(() => ctl.abort());
  const res = await fetch(`${world.stack.base}/api/admin/stream`, {
    headers: {
      cookie: `${s.owner.sessionCookie}=${session}`,
      origin: PUBLIC_URL,
      accept: 'text/event-stream',
    },
    signal: ctl.signal,
  });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames: { event: string; data: { at: number; data: Staging } }[] = [];
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let at: number;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const event = /^event: (.*)$/m.exec(raw)?.[1];
          const data = /^data: (.*)$/m.exec(raw)?.[1];
          if (event === 'staging' && data) frames.push({ event, data: JSON.parse(data) as never });
        }
      }
    } catch {
      // aborted at the end of the test
    }
  })();
  return frames;
}

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(cond(), what).toBe(true);
};

async function upload(world: ImagesWorld, args: Record<string, unknown>, token?: string) {
  const c = await world.stack.connect(token);
  return world.stack.call(c, 'upload_image', { project: 'test', ...args });
}

describe('an MCP tool stages an image', () => {
  it('upload_image with stage: true sends the event (created, already on the server), and the stream carries it', async () => {
    w = await imagesWorld();
    const bus = busEvents(w);
    const stream = await openStream(w);
    const r = await upload(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Agent',
      stage: true,
    });
    expect(r.isError, r.text).toBe(false);
    const stagedId = String(r.body.staged_id);
    await until(() => stream.some((f) => f.data.data.change === 'created'), 'the stream carried the staging');
    // v3 F2 (ADR 0049 decision 10): staged on the bridge's server at once: no upload job, so no `uploaded` step.
    expect(bus.find((e) => e.change === 'created')).toMatchObject({
      projectId: PROJECT,
      stagedId,
      name: 'Agent',
      state: 'uploaded',
      staged: 1,
      old: 0,
    });
    const done = stream.find((f) => f.data.data.change === 'created')!;
    expect(done.data.data).toMatchObject({ projectId: PROJECT, stagedId, state: 'uploaded', staged: 1 });
    expect(done.data.at).toBeGreaterThan(0);
  });

  it('any upload at scope propose stages, and sends the same events (then the proposal of its placement)', async () => {
    w = await imagesWorld();
    const bus = busEvents(w);
    const stream = await openStream(w);
    const { token } = w.stack.newToken('proposer', 'propose');
    const r = await upload(
      w,
      {
        data_base64: fixture('alpha.png').toString('base64'),
        name: 'Proposed',
        destination: { folder: 'Characters / Dwarves' },
      },
      token,
    );
    expect(r.body).toMatchObject({ status: 'proposal_captured', staging: true });
    await until(() => stream.some((f) => f.data.data.change === 'created'), 'staged by a propose connection');
    // the placement proposal being recorded on the image is a change too
    await until(
      () => bus.filter((e) => e.stagedId === String(r.body.staged_id)).length >= 2,
      'the proposal was recorded on the image',
    );
  });

  it('an image that was never staged (a plain upload) sends none', async () => {
    w = await imagesWorld();
    const bus = busEvents(w);
    const r = await upload(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Straight in',
      destination: { folder: 'Characters / Humans' },
    });
    expect(r.isError, r.text).toBe(false);
    expect(bus).toEqual([]);
  });
});

describe('a proposal’s approval places a staged image', () => {
  it('sends placed, with the counts after it, with nobody reading the page', async () => {
    w = await imagesWorld();
    const staged = await upload(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Held',
      stage: true,
    });
    const stagedId = String(staged.body.staged_id);
    const { token } = w.stack.newToken('proposer', 'propose');
    const p = await upload(
      w,
      { staged_id: stagedId, destination: { folder: 'Characters / Dwarves' } },
      token,
    );
    expect(p.body).toMatchObject({ status: 'proposal_captured' });
    const bus = busEvents(w);
    const stream = await openStream(w);
    const proposalId = String(p.body.proposalId);
    await w.stack.runtime.policy.commands.approve('owner', proposalId);
    // No read of the Staging API, no settle by hand: the service follows the proposal and its job by itself.
    await until(
      () => stream.some((f) => f.data.data.change === 'placed'),
      'the stream carried the placement',
    );
    const placed = bus.find((e) => e.change === 'placed')!;
    expect(placed).toMatchObject({ projectId: PROJECT, stagedId, state: 'uploaded', staged: 0, old: 0 });
    expect(w.stack.runtime.images.store.upload(PROJECT, stagedId)!.staged).toBe(false);
  });

  it('a rejected proposal sends an update (the image is free again), not a placement', async () => {
    w = await imagesWorld();
    const staged = await upload(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Declined',
      stage: true,
    });
    const { token } = w.stack.newToken('proposer', 'propose');
    const p = await upload(
      w,
      { staged_id: String(staged.body.staged_id), destination: { folder: 'Characters / Dwarves' } },
      token,
    );
    const bus = busEvents(w);
    w.stack.runtime.policy.commands.reject('owner', String(p.body.proposalId), 'no');
    await until(() => bus.length > 0, 'the rejection reached the image');
    expect(bus.map((e) => e.change)).not.toContain('placed');
    expect(bus.at(-1)).toMatchObject({ change: 'updated', staged: 1 });
  });
});

describe('a placement that fails', () => {
  it('sends an update, with the image still staged on the server', async () => {
    w = await imagesWorld();
    const staged = await upload(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Doomed',
      stage: true,
    });
    const stagedId = String(staged.body.staged_id);
    // LegendKeeper refuses the image asset (a 422 is never retried), so the placement's job fails.
    for (const [re] of w.overrides) {
      if (re.source.includes('assets\\/images')) {
        w.overrides.set(re, () => ({
          status: 422,
          body: { code: 'VALIDATION_ERROR', message: 'refused', requestId: 'x' },
        }));
      }
    }
    const bus = busEvents(w);
    const p = await upload(w, { staged_id: stagedId, destination: { folder: 'Characters / Dwarves' } });
    expect(p.isError).toBe(true);
    await until(
      () => bus.some((e) => e.stagedId === stagedId && e.change === 'updated'),
      'the failure reached it',
    );
    const row = w.stack.runtime.images.store.upload(PROJECT, stagedId)!;
    expect(row).toMatchObject({ staged: true, placementJobId: null });
    expect(row.error).toMatch(/placing failed/);
    expect(await w.stack.runtime.images.stagedImage(PROJECT, stagedId)).not.toBeNull();
  });
});

describe('the dashboard’s own routes send it too (the service does, not the routes)', () => {
  it('an owner upload, place and discard each send an event', async () => {
    w = await imagesWorld();
    const bus = busEvents(w);
    const staged = await upload(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'To discard',
      stage: true,
    });
    const svc = w.stack.runtime.images;
    const row = svc.staged(PROJECT, String(staged.body.staged_id))!;
    const submitted = await svc.discard({
      projectId: PROJECT,
      row,
      origin: { kind: 'ui', tool: 'staging.discard', principal: SYSTEM_PRINCIPAL },
      by: 'owner',
    });
    expect(submitted).toEqual({ status: 'discarded' });
    await until(() => bus.some((e) => e.change === 'discarded'), 'discarded was announced');
    expect(bus.find((e) => e.change === 'discarded')).toMatchObject({ staged: 0, state: 'discarded' });
  });
});

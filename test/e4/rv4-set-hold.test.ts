/**
 * RV4: a whole-set lifecycle job (ADR 0037) that is held (writes paused) AFTER its first write and BEFORE a later page's
 * rename and status tags. CR-06's fix (`recheckOnRelock`) checks again only when nothing has been sent, on the claim that
 * "the writes after it carry their own checks". A set's later `updateResource` steps carry none: the tags (and name) are
 * the list planned at the start, so an edit made meanwhile in the app is overwritten when writes resume.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { PROJECT } from '../tools/helpers.js';
import { seedSet } from '../lifecycle/sets.js';
import { lifecycleWorld, type LifecycleWorld } from '../lifecycle/world.js';

let w: LifecycleWorld;
let client: Client;
const LIMITS = {
  'key-min': 50000,
  'write-min': 20000,
  'key-hour': 600000,
  'write-hour': 300000,
  'project-hour': 600000,
  'key-day': 6000000,
};
beforeAll(async () => {
  w = await lifecycleWorld({ env: { LK_TIER_LIMITS: JSON.stringify(LIMITS) }, limits: LIMITS });
  client = await w.stack.connect();
});
afterAll(async () => w.close());

const until = async (fn: () => boolean, ms = 10_000) => {
  for (let i = 0; i < ms / 10 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
};

it('a set archive held after its first write does not overwrite a tag added in the app to a later page', async () => {
  const engine = w.stack.runtime.engine;
  const s = await seedSet(w, 'authoritative');
  const r = await w.stack.call(client, 'archive_page', { project: 'test', page: s.root, subtree: true });
  expect(r.body.status, r.text).toBe('proposal_captured');
  // The owner pauses writes just as the job's FIRST write (the root's status tag) is made.
  let paused = false;
  w.stack.mock.inject(
    (c) => {
      if (
        !paused &&
        c.method === 'PATCH' &&
        /\/resources\/[^/]+\/?$/.test(c.path) &&
        c.path.includes(s.root)
      ) {
        paused = true;
        engine.controls.pauseWrites('test');
      }
      return false;
    },
    { kind: 'drop' },
  );
  const id = String(r.body.proposalId);
  await w.stack.runtime.policy.commands.approveAsCanon('owner', id);
  const proposals = w.stack.runtime.policy.proposals;
  await until(() => proposals.get(id)!.jobId !== null && proposals.get(id)!.jobId !== undefined);
  const jobId = proposals.get(id)!.jobId!;
  await until(() => paused && engine.queries.getJob(PROJECT, jobId)?.waitReason?.held === 'writes_paused');
  expect(
    engine.queries.getJob(PROJECT, jobId)?.waitReason?.held,
    'the job is held after its first write',
  ).toBe('writes_paused');
  // The root's tag was written; the Portraits page was not touched yet.
  expect(w.repo.res.get(s.root)!.tags).toContain('Archived');
  const portraits = w.repo.res.get(s.portraits)!;
  expect(portraits.name.startsWith('[BSRC] ')).toBe(true);
  // Meanwhile the owner tags the Portraits page in the LegendKeeper app.
  portraits.tags = [...portraits.tags, 'added-in-the-app'];
  engine.controls.resumeWrites('test');
  const done = await engine.wait(PROJECT, jobId, 20_000);
  // Safe: the tag the app added survives (or the job stops on a conflict, leaving it).
  expect(
    w.repo.res.get(s.portraits)!.tags,
    `job ${done.status} ${JSON.stringify(done.lastError ?? null)}`,
  ).toContain('added-in-the-app');
});

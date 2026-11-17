/**
 * CR-2026-11-R2 (R2-09): "Mark all reviewed" (ADR 0055 decision A3) is "refused with REVIEW_CHANGED (409) when the set
 * changed in the meantime". The request carried only the count: one item marked reviewed elsewhere and a new direct
 * write arriving left the count the same, and the new item, which the owner never saw, was marked reviewed. The list
 * now answers a fingerprint of the exact set, and "Mark all reviewed" with it marks nothing when the set differs.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PatService } from '../../src/auth/pats.js';
import { AuthStore } from '../../src/auth/store.js';
import { startAdminStack, PROJECT, type AdminStack } from './helpers.js';

let s: AdminStack;
let agent: { principalId: string; profile: string; label: string };

beforeAll(async () => {
  s = await startAdminStack();
  const profile = s.policy.commands.createProfile('owner', {
    label: 'r2 mark-all',
    kind: 'other',
    scope: 'write',
  });
  const created = new PatService({
    store: new AuthStore(s.db),
    event: () => undefined,
    now: () => Math.floor(Date.now() / 1000),
  }).create({ name: 'r2 mark-all agent', profileId: profile.id });
  agent = s.policy.store.lookupPrincipal(created.pat.id)!.principal;
});
afterAll(async () => {
  await s?.close();
});

async function directWrite(n: number): Promise<string> {
  const r = await s.runtime.engine.run(
    'createResource',
    { body: { name: `R2 mark-all page ${n} ${Date.now()}` } },
    { project: PROJECT, origin: { kind: 'mcp', tool: 'lk_api_write', principal: agent } },
  );
  const id = (r as { jobId: string }).jobId;
  await s.runtime.engine.wait(PROJECT, id, 10_000);
  return id;
}

it('a set that changed under the same count is not marked: the new item stays unreviewed', async () => {
  const a = await directWrite(1);
  await directWrite(2);
  const seen = await s.get('/api/admin/review?state=unreviewed');
  expect(seen.status).toBe(200);
  const body = seen.json as { counts: { matching: number }; markAll?: { fingerprint?: string } };
  const n = body.counts.matching;
  expect(n).toBe(2);
  expect(typeof body.markAll?.fingerprint, JSON.stringify(body)).toBe('string');
  // Meanwhile: one item reviewed in another tab, and a new direct write arrives. The count is still 2.
  expect((await s.post('/api/admin/review/mark', { ids: [a] })).status).toBe(200);
  const c = await directWrite(3);
  expect(s.runtime.review!.store.count(PROJECT, { state: 'unreviewed' })).toBe(2);
  const r = await s.post('/api/admin/review/mark-all', {
    filter: {},
    expect: n,
    fingerprint: body.markAll!.fingerprint,
    confirm: true,
  });
  expect(r.status, r.text).toBe(409);
  expect((r.json as { error: { code: string } }).error.code).toBe('REVIEW_CHANGED');
  expect(s.runtime.review!.store.get(PROJECT, c)!.reviewedAt).toBeNull();
});

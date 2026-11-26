/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- parsed JSON */
/**
 * v3 F3.4 (ADR 0055): the admin API of write scope. Revert needs the owner's re-authentication and is audited
 * (`job.revert`), a refusal included; the Review queue lists an agent's direct write (never the bridge's own work), its
 * counts and detail, and marking reviewed is audited. (The safety rails and the pack tools' switches, and their routes,
 * were removed in v3 F12, ADR 0081: their tests went with them.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PatService } from '../../src/auth/pats.js';
import { AuthStore } from '../../src/auth/store.js';
import { startAdminStack, PROJECT, type AdminStack } from './helpers.js';

let s: AdminStack;
let agentPrincipal: { principalId: string; profile: string; label: string };
let profileId: string;

beforeAll(async () => {
  s = await startAdminStack();
  const profile = s.policy.commands.createProfile('owner', {
    label: 'review-api-agent',
    kind: 'other',
    scope: 'write',
  });
  profileId = profile.id;
  const created = new PatService({
    store: new AuthStore(s.db),
    event: () => undefined,
    now: () => Math.floor(Date.now() / 1000),
  }).create({ name: 'review api agent', profileId });
  agentPrincipal = s.policy.store.lookupPrincipal(created.pat.id)!.principal;
});
afterAll(async () => {
  await s?.close();
});

const reauth = () =>
  s.db
    .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
    .run(Math.floor(Date.now() / 1000), s.services.sessionHash(s.sessionToken));
const expire = () =>
  s.db
    .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
    .run(null, s.services.sessionHash(s.sessionToken)); // no step-up at all

/** One direct write by the agent (an alias on a page), run to its end. */
async function directWrite(): Promise<string> {
  const r = await s.runtime.engine.run(
    'createResource',
    { body: { name: `Review API page ${Date.now()}` } },
    { project: PROJECT, origin: { kind: 'mcp', tool: 'lk_api_write', principal: agentPrincipal } },
  );
  expect(r.status).toBe('succeeded');
  const id = (r as { jobId: string }).jobId;
  await s.runtime.engine.wait(PROJECT, id, 10_000);
  return id;
}

describe('the Review API', () => {
  it('lists an agent’s direct write, counts it, details it, and marks it reviewed (audited)', async () => {
    const jobId = await directWrite();
    const list = await s.get('/api/admin/review');
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(list.json.items.map((i: { jobId: string }) => i.jobId)).toContain(jobId);
    const counts = await s.get('/api/admin/review/counts');
    expect(counts.json.unreviewed).toBeGreaterThanOrEqual(1);
    const one = await s.get(`/api/admin/review/${jobId}`);
    expect(one.status).toBe(200);
    expect(one.json.item).toMatchObject({ jobId, tool: 'lk_api_write' });
    // v3 F12 (ADR 0081): a page the job created is revertible (Revert deletes it again while untouched).
    expect(one.json.item.revertible, JSON.stringify(one.json.item)).toBe(true);
    const mark = await s.post('/api/admin/review/mark', { ids: [jobId] });
    expect(mark.status, JSON.stringify(mark.json)).toBe(200);
    expect(mark.json.marked).toEqual([jobId]);
    expect(s.audit('review.mark')[0]!.target).toBe(jobId);
  });

  it('the bridge’s own work is never listed', async () => {
    const r = await s.runtime.engine.run(
      'createResource',
      { body: { name: 'Bridge’s own page' } },
      { project: PROJECT, origin: { kind: 'ui', tool: 'test' } },
    );
    const id = (r as { jobId: string }).jobId;
    await s.runtime.engine.wait(PROJECT, id, 10_000);
    expect((await s.get(`/api/admin/review/${id}`)).status).toBe(404);
  });

  it('“Mark all reviewed” marks nothing when the confirmed count is out of date (409)', async () => {
    await directWrite();
    const n = (await s.get('/api/admin/review/counts')).json.unreviewed as number;
    const stale = await s.post('/api/admin/review/mark-all', { filter: {}, expect: n + 5, confirm: true });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('REVIEW_CHANGED');
    const ok = await s.post('/api/admin/review/mark-all', { filter: {}, expect: n, confirm: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.marked).toHaveLength(n);
    expect(s.audit('review.mark_all')).toHaveLength(1);
  });
});

describe('Revert through the API', () => {
  it('needs no fresh code (ADR 0081), and every attempt is audited as job.revert', async () => {
    const jobId = await directWrite();
    expire();
    // The preview reads. The job only created a page, which Revert deletes again while untouched (v3 F12, ADR 0081);
    // this stack's mock answers every read with a stub page (another name, a page under it), so it reads as changed
    // since, and is kept.
    const preview = await s.get(`/api/admin/jobs/${jobId}/revert`);
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
    expect(preview.json.preview.targets[0], JSON.stringify(preview.json.preview.targets)).toMatchObject({
      kind: 'entity',
      state: 'changed',
    });
    const before = s.audit('job.revert').length;
    const r = await s.post(`/api/admin/jobs/${jobId}/revert`, { confirm: true });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error.code).toBe('NOTHING_TO_REVERT');
    expect(r.json.error.targets).toHaveLength(1);
    const audit = s.audit('job.revert');
    expect(audit).toHaveLength(before + 1);
    expect(audit[0]!).toMatchObject({
      target: jobId,
      after: { outcome: 'refused', code: 'NOTHING_TO_REVERT' },
    });
  });

  it('an unknown job is 404, audited too', async () => {
    const r = await s.post('/api/admin/jobs/job_unknown/revert', { confirm: true });
    expect(r.status).toBe(404);
    expect(s.audit('job.revert')[0]!.target).toBe('job_unknown');
  });
});

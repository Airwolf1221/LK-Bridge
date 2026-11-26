/**
 * R2-revert, attack (e): run a revert without the owner's re-authentication or `confirm`, or as an agent.
 *
 * The admin route (src/admin/routes/review.ts) re-authenticates (10 minutes since ADR 0062), requires `confirm: true` (strict body), and
 * every /api/admin route refuses bearer tokens. No MCP tool reaches the revert service (src/runtime.ts wires it to the
 * admin route only). These are controls: each should HOLD.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PatService } from '../../../src/auth/pats.js';
import { AuthStore } from '../../../src/auth/store.js';
import { startAdminStack, PROJECT, type AdminStack } from '../../admin/helpers.js';

let s: AdminStack;
let agentToken: string;
let agentPrincipal: { principalId: string; profile: string; label: string };

beforeAll(async () => {
  s = await startAdminStack();
  const profile = s.policy.commands.createProfile('owner', {
    label: 'r2-route-agent',
    kind: 'other',
    scope: 'write',
  });
  const created = new PatService({
    store: new AuthStore(s.db),
    event: () => undefined,
    now: () => Math.floor(Date.now() / 1000),
  }).create({ name: 'r2 route agent', profileId: profile.id });
  agentToken = created.token;
  agentPrincipal = s.policy.store.lookupPrincipal(created.pat.id)!.principal;
});
afterAll(async () => s?.close());

const reauth = () =>
  s.db
    .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
    .run(Math.floor(Date.now() / 1000), s.services.sessionHash(s.sessionToken));
const expire = () =>
  s.db
    .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
    .run(null, s.services.sessionHash(s.sessionToken)); // no step-up on the session (ADR 0081)

async function directWrite(): Promise<string> {
  const r = await s.runtime.engine.run(
    'createResource',
    { body: { name: `R2 route page ${Date.now()}` } },
    { project: PROJECT, origin: { kind: 'mcp', tool: 'lk_api_write', principal: agentPrincipal } },
  );
  const id = (r as { jobId: string }).jobId;
  await s.runtime.engine.wait(PROJECT, id, 10_000);
  return id;
}

describe('who may start a revert', () => {
  it('an agent’s bearer token never reaches the revert (no audit row, 401)', async () => {
    const jobId = await directWrite();
    reauth();
    const before = s.audit('job.revert').length;
    const r = await s.post(
      `/api/admin/jobs/${jobId}/revert`,
      { confirm: true, confirmPartial: true },
      { cookie: null, csrf: null, authorization: `Bearer ${agentToken}` },
    );
    expect(r.status).toBe(401);
    expect(s.audit('job.revert')).toHaveLength(before);
  });

  it('without confirm: true (absent, a string, or with extra fields) nothing is planned', async () => {
    const jobId = await directWrite();
    reauth();
    const before = s.audit('job.revert').length;
    for (const body of [{}, { confirm: 'true' }, { confirmPartial: true }, { confirm: true, force: true }]) {
      const r = await s.post(`/api/admin/jobs/${jobId}/revert`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(s.audit('job.revert')).toHaveLength(before);
  });

  it('without the CSRF token, or from another site, nothing is planned (ADR 0081: no fresh code is asked)', async () => {
    const jobId = await directWrite();
    const before = s.audit('job.revert').length;
    expire();
    expect((await s.post(`/api/admin/jobs/${jobId}/revert`, { confirm: true }, { csrf: null })).status).toBe(
      403,
    );
    expect(
      (
        await s.post(
          `/api/admin/jobs/${jobId}/revert`,
          { confirm: true },
          {
            headers: { 'sec-fetch-site': 'cross-site' },
          },
        )
      ).status,
    ).toBe(403);
    expect(s.audit('job.revert')).toHaveLength(before);
  });

  it('a job of another project is not found there', async () => {
    const jobId = await directWrite();
    const r = await s.runtime.reverts.revert('owner', 'proj_other', jobId);
    expect(r).toMatchObject({ status: 'refused', code: 'JOB_NOT_FOUND' });
    const p = await s.runtime.reverts.preview('proj_other', jobId);
    expect(p.eligible).toMatchObject({ ok: false, code: 'JOB_NOT_FOUND' });
  });
});

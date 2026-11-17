/**
 * R2-PACKS ATK-24 (HELD expected): the pack and appraisal admin routes cannot be used by an agent, and the owner's
 * switch change needs a fresh re-authentication (src/admin/routes/packs.ts:113-121 `requireReauth`). An agent's
 * personal access token (scope write) is sent as a bearer token, with no owner cookie; then the owner's own session
 * with its re-authentication expired.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PatService } from '../../../src/auth/pats.js';
import { AuthStore } from '../../../src/auth/store.js';
import { startAdminStack, type AdminStack } from '../../admin/helpers.js';

let s: AdminStack;
let pat: string;
beforeAll(async () => {
  s = await startAdminStack();
  await s.runtime.ready;
  s.runtime.packs.ensureSeeded();
  const profile = s.policy.commands.createProfile('owner', {
    label: 'r2-admin-agent',
    kind: 'other',
    scope: 'write',
  });
  pat = new PatService({
    store: new AuthStore(s.db),
    event: () => undefined,
    now: () => Math.floor(Date.now() / 1000),
  }).create({ name: 'r2 admin agent', profileId: profile.id }).token;
});
afterAll(async () => {
  await s?.close();
});

const expire = () =>
  s.db
    .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
    .run(Math.floor(Date.now() / 1000) - 301, s.services.sessionHash(s.sessionToken));

describe('ATK-24: the switch and the fix routes are the owner’s, re-authenticated', () => {
  it('an agent’s bearer token cannot change a switch, approve the pack, or propose an appraisal fix', async () => {
    const v0 = s.runtime.packs.get('arkona')!.version;
    const asAgent = { cookie: null, csrf: null, authorization: `Bearer ${pat}` } as const;
    const tools = await s.call('PUT', '/api/admin/packs/arkona/tools', {
      ...asAgent,
      body: { tools: { arkona_create_character: 'scope' }, confirm: true },
    });
    const approve = await s.call('POST', '/api/admin/packs/arkona/approve', {
      ...asAgent,
      body: { confirm: true },
    });
    const fix = await s.call('POST', '/api/admin/appraisal/findings/af_0123456789abcdef0123/propose-fix', {
      ...asAgent,
      body: { confirm: true, project: 'test' },
    });
    expect({
      tools: tools.status >= 400,
      approve: approve.status >= 400,
      fix: fix.status >= 400,
      version: s.runtime.packs.get('arkona')!.version,
    }).toEqual({ tools: true, approve: true, fix: true, version: v0 });
  });

  it('the owner’s session without a fresh re-authentication cannot change a switch', async () => {
    const v0 = s.runtime.packs.get('arkona')!.version;
    expire();
    const r = await s.put('/api/admin/packs/arkona/tools', {
      tools: { arkona_create_character: 'scope' },
      confirm: true,
    });
    expect({ status: r.status, version: s.runtime.packs.get('arkona')!.version }).toEqual({
      status: 403,
      version: v0,
    });
  });
});

/**
 * R2-PACKS ATK-24 (HELD expected): the pack and appraisal admin routes cannot be used by an agent. An agent's personal
 * access token (scope write) is sent as a bearer token, with no owner cookie. (The pack tools' switches and their route
 * were removed in v3 F12, ADR 0081, with the test of the switch's re-authentication.)
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

describe('ATK-24: the pack and the fix routes are the owner’s', () => {
  it('an agent’s bearer token cannot approve the pack or propose an appraisal fix', async () => {
    const v0 = s.runtime.packs.get('arkona')!.version;
    const asAgent = { cookie: null, csrf: null, authorization: `Bearer ${pat}` } as const;
    const approve = await s.call('POST', '/api/admin/packs/arkona/approve', {
      ...asAgent,
      body: { confirm: true },
    });
    const fix = await s.call('POST', '/api/admin/appraisal/findings/af_0123456789abcdef0123/propose-fix', {
      ...asAgent,
      body: { confirm: true, project: 'test' },
    });
    expect({
      approve: approve.status >= 400,
      fix: fix.status >= 400,
      version: s.runtime.packs.get('arkona')!.version,
    }).toEqual({ approve: true, fix: true, version: v0 });
  });
});

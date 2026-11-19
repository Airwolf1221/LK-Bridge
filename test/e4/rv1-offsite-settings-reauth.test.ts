/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON replies */
/**
 * RV1-4: `PUT /api/admin/offsite/settings` needs only the session (src/admin/routes/offsite.ts), yet it can switch off
 * the off-site copy's protections: the monthly verify (`verifyEnabled: false`), the stale-copy alarm that turns the
 * Overview red (`staleAfterDays: 365`, ADR 0043 decision 4 "health that cannot go unnoticed"), and the 30-day
 * `deleted/<date>` safety net on Drive (`deletedRetentionDays: 1`). ADR 0036 decision 4 and ADR 0044 decision 12 put
 * every setting that switches a protection off behind the re-authentication (canon rules, lifecycle settings, audit
 * rules); a stolen dashboard session can silence the backup's alarms without the password.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startAdminStack, type AdminStack } from '../admin/helpers.js';
import { MockGoogle } from '../offsite/mock-google.js';

let google: MockGoogle;
let stack: AdminStack;

beforeEach(async () => {
  google = new MockGoogle();
  await google.start();
  stack = await startAdminStack({ googleOAuth: { endpoints: google.endpoints } });
  stack.db.prepare('UPDATE auth_owner_sessions SET reauth_at = NULL').run(); // signed in, not stepped up
});
afterEach(async () => {
  await stack.close();
  await google.stop();
});

describe('RV1-4: off-site settings that switch a protection off', () => {
  it('need a re-authentication within 10 minutes (REAUTH_REQUIRED without one), and change nothing', async () => {
    const before = (await stack.get('/api/admin/offsite')).json.settings;
    for (const settings of [{ verifyEnabled: false }, { staleAfterDays: 365 }, { deletedRetentionDays: 1 }]) {
      const r = await stack.put('/api/admin/offsite/settings', { settings });
      expect.soft(r.status, JSON.stringify(settings)).toBe(403);
      expect.soft(r.json?.error?.code, JSON.stringify(settings)).toBe('REAUTH_REQUIRED');
    }
    const after = (await stack.get('/api/admin/offsite')).json.settings;
    expect(after).toEqual(before);
  });

  it('switching off the nightly full snapshot or the snapshot verify (E1a jobs) needs one too', async () => {
    for (const id of ['snapshot-full', 'snapshot-verify']) {
      expect((await stack.get(`/api/admin/maintenance/${id}`)).json.job.enabled, id).toBe(true);
      const r = await stack.post(`/api/admin/maintenance/${id}/disable`, {});
      expect.soft(r.status, id).toBe(403);
      expect.soft(r.json?.error?.code, id).toBe('REAUTH_REQUIRED');
      expect.soft((await stack.get(`/api/admin/maintenance/${id}`)).json.job.enabled, id).toBe(true);
    }
  });
});

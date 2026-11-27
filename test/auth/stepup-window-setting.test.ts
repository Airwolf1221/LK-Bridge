/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies in tests */
/**
 * ADR 0081: the step-up's window is the setting `AUTH_STEP_UP_WINDOW_SECONDS` (default 43,200 seconds, 12 hours; 5
 * minutes to 7 days), replacing the fixed 10 minutes. A step-up older than the window is refused, one within it accepted;
 * the Account page is told the window (`GET /security`), and the requests' refusal names it in words.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { stepUpWindowInWords } from '../../src/auth/owner.js';
import { loadAuthConfig } from '../../src/config/auth.js';
import { registryEntry } from '../../src/config/registry.js';
import { PUBLIC_URL, startAdminStack, type AdminStack } from '../admin/helpers.js';
import { nowS, ownerSession } from '../review/r4-sessions/helpers.js';
import { throwawaySecret } from './helpers.js';
import { STEP_UP_PROBE } from './stepup-routes.js';

let s: AdminStack | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const base = {
  BRIDGE_PUBLIC_URL: PUBLIC_URL,
  OWNER_PASSWORD_HASH: '$argon2id$v=19$m=1024,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA',
  SESSION_SECRET: throwawaySecret(),
  JWT_SIGNING_KEY: throwawaySecret(),
};
const windowOf = (v?: string) => {
  try {
    return loadAuthConfig({ ...base, ...(v !== undefined ? { AUTH_STEP_UP_WINDOW_SECONDS: v } : {}) }).ttl
      .stepUpSeconds;
  } catch {
    return 'refused';
  }
};

describe('AUTH_STEP_UP_WINDOW_SECONDS', () => {
  it('defaults to 12 hours, takes a value set, and is bounded to 5 minutes to 7 days', () => {
    expect(windowOf()).toBe(43_200);
    expect(windowOf('3600')).toBe(3600);
    expect([windowOf('299'), windowOf('300'), windowOf('604800'), windowOf('604801'), windowOf('0')]).toEqual(
      ['refused', 300, 604_800, 'refused', 'refused'],
    );
    const e = registryEntry('AUTH_STEP_UP_WINDOW_SECONDS');
    expect(e?.secret).toBe(false);
    expect(e?.applies).toBe('next_start');
  });

  it('names the window in words', () => {
    expect([43_200, 600, 3600, 86_400, 604_800, 5400, 90].map((v) => stepUpWindowInWords(v))).toEqual([
      '12 hours',
      '10 minutes',
      '1 hour',
      '1 day',
      '7 days',
      '90 minutes',
      '90 seconds',
    ]);
  });

  it('by default, a step-up 11 hours old is accepted and one over 12 hours old is refused', async () => {
    s = await startAdminStack();
    const o = ownerSession(s, s.bridge.publicUrl);
    o.setReauth(nowS() - 11 * 3600);
    const within = await o.call('POST', STEP_UP_PROBE, {});
    expect(within.status, within.text).toBe(200);
    o.setReauth(nowS() - 12 * 3600 - 60);
    const older = await o.call('POST', STEP_UP_PROBE, {});
    expect([older.status, older.json?.error?.code]).toEqual([403, 'REAUTH_REQUIRED']);
    expect(older.json?.error?.message).toContain('within the last 12 hours');
    const security = await o.call('GET', '/api/admin/security');
    expect(security.json?.reauth).toEqual({ until: null, windowSeconds: 43_200 });
  });

  it('a window set applies: one hour', async () => {
    s = await startAdminStack({ authEnv: { AUTH_STEP_UP_WINDOW_SECONDS: '3600' } });
    expect(s.services.owner.stepUpWindowSeconds).toBe(3600);
    const o = ownerSession(s, s.bridge.publicUrl);
    o.setReauth(nowS() - 3500);
    expect((await o.call('POST', STEP_UP_PROBE, {})).status).toBe(200);
    const security = await o.call('GET', '/api/admin/security');
    expect(security.json?.reauth?.windowSeconds).toBe(3600);
    expect(security.json?.reauth?.until).toBe((o.reauthAt()! + 3600) * 1000);
    o.setReauth(nowS() - 3700);
    const older = await o.call('POST', STEP_UP_PROBE, {});
    expect([older.status, older.json?.error?.code]).toEqual([403, 'REAUTH_REQUIRED']);
    expect(older.json?.error?.message).toContain('within the last 1 hour');
  });
});

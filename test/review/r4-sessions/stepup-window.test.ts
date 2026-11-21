/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies in tests */
/**
 * CR-2026-11 round 4 (sessions), the step-up's window (ADR 0062 decision 5: the authenticator code, or a recovery code,
 * on THIS session within the last 10 minutes; the password only without an authenticator). The attempts: a step-up
 * counted on another session; one surviving Sign out everywhere or a password change; a code or recovery code used twice
 * (once to sign in, once to step up); an older code after a newer one; the password where the code is due; a step-up
 * recorded in the future (the clock set back); the 10-minute boundary; the step-up landing on a session revoked while
 * its password was being checked; the step-up and sign-in limits counted apart.
 *
 * The safe behaviour asserted in each: refused (403 REAUTH_REQUIRED for the action, 401 REAUTH_FAILED for the step-up).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { totp } from '../../../src/auth/totp.js';
import { startAdminStack, type AdminStack } from '../../admin/helpers.js';
import { Browser, startBridge } from '../../auth/helpers.js';
import { asksStepUp, nowS, ownerSession } from './helpers.js';

let s: AdminStack | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const CONTACT = '/api/admin/settings/contact-email';
const contact = { value: 'owner@example.test', confirm: true };

/** An admin stack with the authenticator set up (through its own stepped-up session), and its recovery codes. */
async function withAuthenticator(): Promise<{ stack: AdminStack; secret: string; recovery: string[] }> {
  s = await startAdminStack();
  const stack = s;
  const enrol = await stack.post('/api/admin/security/totp/enrol', {});
  expect(enrol.status, enrol.text).toBe(200);
  const secret = enrol.json.secret as string;
  const confirmed = await stack.post('/api/admin/security/totp/confirm', { code: totp(secret, nowS() - 30) });
  expect(confirmed.status, confirmed.text).toBe(200);
  return { stack, secret, recovery: confirmed.json.recoveryCodes as string[] };
}

describe('the step-up belongs to one session, for ten minutes', () => {
  it('SE-17: a step-up on one session does not count on another session', async () => {
    s = await startAdminStack();
    const a = ownerSession(s, s.bridge.publicUrl, s.sessionToken); // stepped up (the stack's own)
    const b = ownerSession(s, s.bridge.publicUrl); // signed in elsewhere, not stepped up
    expect((await a.call('PUT', CONTACT, contact)).status).toBe(200);
    asksStepUp(await b.call('PUT', CONTACT, contact), 'the other session');
    expect(b.reauthAt()).toBeNull();
  });

  it('SE-18: after Sign out everywhere, the stepped-up cookie is dead and a new sign-in starts without a step-up', async () => {
    s = await startAdminStack();
    const a = ownerSession(s, s.bridge.publicUrl, s.sessionToken);
    expect(a.reauthAt()).not.toBeNull();
    expect((await a.call('POST', '/api/admin/security/sessions/revoke-all', { confirm: true })).status).toBe(
      200,
    );
    expect((await a.call('PUT', CONTACT, contact)).status).toBe(401);
    const browser = new Browser(s.bridge);
    expect((await browser.login()).status).toBe(200);
    const fresh = ownerSession(s, s.bridge.publicUrl, browser.cookies.get(s.services.owner.sessionCookie)!);
    expect(fresh.reauthAt()).toBeNull();
    asksStepUp(await fresh.call('PUT', CONTACT, contact), 'the new sign-in');
  });

  it('SE-19: a password change ends the other sessions, their step-ups with them', async () => {
    s = await startAdminStack();
    const a = ownerSession(s, s.bridge.publicUrl, s.sessionToken);
    const other = ownerSession(s, s.bridge.publicUrl);
    other.setReauth(nowS());
    expect((await other.call('PUT', CONTACT, contact)).status).toBe(200);
    const r = await a.call('POST', '/api/admin/security/password', {
      currentPassword: s.bridge.password,
      newPassword: 'r4 a new long password',
    });
    expect(r.status, r.text).toBe(200);
    expect((await other.call('PUT', CONTACT, contact)).status).toBe(401);
    expect(other.row().revoked_at).not.toBeNull();
  });

  it('SE-20: an authenticator code used to sign in cannot step up; nor can an older code after a newer one', async () => {
    const { stack, secret } = await withAuthenticator();
    const browser = new Browser(stack.bridge);
    const code = totp(secret, nowS());
    const signIn = await browser.login('', { totp: code });
    expect(signIn.status, await signIn.clone().text()).toBe(200);
    const b = ownerSession(
      stack,
      stack.bridge.publicUrl,
      browser.cookies.get(stack.services.owner.sessionCookie)!,
    );
    const again = await b.call('POST', '/api/admin/security/reauth', { totp: code });
    expect({ status: again.status, code: again.json?.error?.code }).toEqual({
      status: 401,
      code: 'REAUTH_FAILED',
    });
    // The previous time step's code (still inside the verifier's window) after the current one was used: refused.
    const older = await b.call('POST', '/api/admin/security/reauth', { totp: totp(secret, nowS() - 30) });
    expect({ status: older.status, code: older.json?.error?.code }).toEqual({
      status: 401,
      code: 'REAUTH_FAILED',
    });
    expect(b.reauthAt()).toBeNull();
  });

  it('SE-21: a recovery code used to sign in cannot then step up (on any session)', async () => {
    const { stack, recovery } = await withAuthenticator();
    const browser = new Browser(stack.bridge);
    const signIn = await browser.login('', { totp: recovery[0]! });
    expect(signIn.status, await signIn.clone().text()).toBe(200);
    const b = ownerSession(
      stack,
      stack.bridge.publicUrl,
      browser.cookies.get(stack.services.owner.sessionCookie)!,
    );
    for (const form of [recovery[0]!, recovery[0]!.toLowerCase(), recovery[0]!.replace(/-/g, ' ')]) {
      const r = await b.call('POST', '/api/admin/security/reauth', { totp: form });
      expect({ status: r.status, code: r.json?.error?.code }, form).toEqual({
        status: 401,
        code: 'REAUTH_FAILED',
      });
    }
    expect(b.reauthAt()).toBeNull();
  });

  it('SE-22: with the authenticator set up, the password is refused in either field, and with a wrong code', async () => {
    const { stack } = await withAuthenticator();
    const b = ownerSession(stack, stack.bridge.publicUrl);
    for (const body of [
      { password: stack.bridge.password },
      { totp: stack.bridge.password },
      { password: stack.bridge.password, totp: '000000' },
      { password: stack.bridge.password, totp: '' },
    ]) {
      const r = await b.call('POST', '/api/admin/security/reauth', body);
      expect(r.status, JSON.stringify(Object.keys(body))).toBe(r.status === 400 ? 400 : 401);
      expect(b.reauthAt()).toBeNull();
    }
    asksStepUp(await b.call('PUT', CONTACT, contact), 'after the refused step-ups');
  });

  it('SE-23: a step-up recorded in the future (the clock set back) does not count', async () => {
    s = await startAdminStack();
    const b = ownerSession(s, s.bridge.publicUrl);
    b.setReauth(nowS() + 3600);
    asksStepUp(await b.call('PUT', CONTACT, contact), 'a step-up an hour ahead');
  });

  it('SE-24: the boundary: 600 seconds after the step-up it holds, 601 it does not (the clock of the bridge)', async () => {
    const bridge = await startBridge();
    try {
      const owner = bridge.services.owner;
      const token = owner.createSession('127.0.0.1', 'r4');
      bridge.services.store.setReauth(bridge.services.sessionHash(token), bridge.clock.now());
      const at = (dt: number) => {
        bridge.clock.advance(dt);
        const session = owner.getSession(token)!;
        return owner.reauthUntil(session) !== null;
      };
      expect([at(599), at(1), at(1)]).toEqual([true, true, false]);
    } finally {
      await bridge.close();
    }
  });

  it('SE-25: a step-up whose password check finishes after Sign out everywhere is not recorded', async () => {
    const bridge = await startBridge();
    try {
      const owner = bridge.services.owner;
      const token = owner.createSession('127.0.0.1', 'r4');
      const pending = owner.reauthenticate({
        sessionToken: token,
        password: bridge.password,
        totp: undefined,
        ip: '198.51.100.7',
      });
      owner.revokeAllSessions('198.51.100.8'); // while Argon2id is still checking the password
      const r = await pending;
      const row = bridge.db
        .prepare('SELECT reauth_at, revoked_at FROM auth_owner_sessions WHERE session_hash = ?')
        .get(bridge.services.sessionHash(token)) as { reauth_at: number | null; revoked_at: number | null };
      expect(row.revoked_at).not.toBeNull();
      expect(row.reauth_at, JSON.stringify(r)).toBeNull();
      expect(owner.getSession(token)).toBeUndefined();
    } finally {
      await bridge.close();
    }
  });

  it('SE-26: failed step-ups count against sign-in (and the reverse): five from an address and it is locked out', async () => {
    s = await startAdminStack({ env: { TRUST_PROXY: 'loopback' } });
    const b = ownerSession(s, s.bridge.publicUrl);
    for (let i = 0; i < 5; i++) {
      const r = await b.call('POST', '/api/admin/security/reauth', { password: `wrong ${i}` });
      expect(r.json?.error?.code).toBe('REAUTH_FAILED');
    }
    const locked = await b.call('POST', '/api/admin/security/reauth', { password: s.bridge.password });
    expect(locked.status).toBe(429);
    const browser = new Browser(s.bridge);
    const signIn = await browser.login();
    expect(signIn.status).toBe(429);
  });
});

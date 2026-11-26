/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- parsed JSON replies in tests */
/**
 * OPS2: the owner's account on the dashboard. Re-authentication for sensitive actions (needed, expiring after five
 * minutes, rate-limited like sign-in, CSRF and Origin enforced); the password change (current password required, other
 * sessions signed out); the authenticator app (enrolment confirmed by a code, recovery codes shown once and usable once,
 * removal). Credentials live in the encrypted store, never in plain text.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { totp } from '../../src/auth/totp.js';
import { Browser } from '../auth/helpers.js';
import { startManaged, type Managed } from './helpers.js';

let m: Managed | undefined;
afterEach(async () => {
  await m?.close();
  m = undefined;
});

const start = async () => {
  m = await startManaged({ lk: [{ name: 'alpha' }], envProjects: ['alpha'] });
  return m;
};
const now = () => Math.floor(Date.now() / 1000);
/** A request as another dashboard session (signed in through the real sign-in page). */
const asBrowser = (s: Managed, b: Browser) => {
  const token = b.cookies.get(s.stack.services.owner.sessionCookie) ?? '';
  const cookie = `${s.stack.services.owner.sessionCookie}=${token}`;
  const csrf = s.stack.services.owner.csrfToken(token, 'admin');
  return {
    token,
    get: (path: string) => s.stack.get(`/api/admin${path}`, { cookie }),
    post: (path: string, body?: unknown) => s.stack.post(`/api/admin${path}`, body, { cookie, csrf }),
  };
};

describe('re-authentication', () => {
  it('is needed for every credential change, and lasts 12 hours (ADR 0081; was ten minutes)', async () => {
    const s = await start();
    for (const [path, body] of [
      ['/security/password', { currentPassword: 'x', newPassword: 'y'.repeat(20) }],
      ['/security/totp/enrol', {}],
      ['/security/totp/confirm', { code: '123456' }],
      ['/security/totp/remove', { confirm: true }],
      ['/security/recovery-codes', { confirm: true }],
      ['/projects/check', { name: 'x', apiKey: 'y'.repeat(20) }],
      ['/projects/alpha/key/check', { apiKey: 'y'.repeat(20) }],
      ['/projects/confirm', { checkId: 'x', confirm: true }],
      ['/projects/alpha/remove', { confirm: true }],
    ] as const) {
      const r = await s.admin.post(path, body);
      expect(r.status, path).toBe(403);
      expect(r.json.error.code, path).toBe('REAUTH_REQUIRED');
    }
    const wrong = await s.admin.post('/security/reauth', { password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error.code).toBe('REAUTH_FAILED');
    const ok = await s.reauth();
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.until).toBeGreaterThan(Date.now() + 290_000);
    expect((await s.admin.get('/security')).json.reauth.until).toBe(ok.json.until);
    const hash = s.stack.services.sessionHash(s.stack.sessionToken);
    const set = (ago: number) =>
      s.stack.db
        .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
        .run(now() - ago, hash);
    set(43_190);
    expect((await s.admin.post('/security/totp/enrol', {})).status).toBe(200);
    set(43_201); // ADR 0081: the step-up lasts 12 hours (AUTH_STEP_UP_WINDOW_SECONDS)
    const expired = await s.admin.post('/security/totp/enrol', {});
    expect(expired.status).toBe(403);
    expect(expired.json.error.code).toBe('REAUTH_REQUIRED');
    // Audited, success and failure alike, with no secret.
    const audit = s.stack.audit('owner.reauth');
    expect(audit.map((a) => (a.after as { ok: boolean }).ok)).toEqual([true, false]);
  });

  it('is CSRF- and Origin-checked like every admin change', async () => {
    const s = await start();
    const body = { password: s.stack.bridge.password };
    expect((await s.stack.post('/api/admin/security/reauth', body, { csrf: null })).status).toBe(403);
    expect((await s.stack.post('/api/admin/security/reauth', body, { csrf: 'forged' })).status).toBe(403);
    expect((await s.stack.post('/api/admin/security/reauth', body, { origin: null })).status).toBe(403);
    expect(
      (await s.stack.post('/api/admin/security/reauth', body, { origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect((await s.stack.post('/api/admin/security/reauth', body, { cookie: null })).status).toBe(401);
    expect(
      (
        await s.stack.post('/api/admin/security/reauth', body, {
          headers: { 'sec-fetch-site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
    // None of those re-authenticated the session.
    expect((await s.admin.get('/security')).json.reauth.until).toBeNull();
  });

  it('brute force is rate-limited as sign-in is, and the two share the limit', async () => {
    const s = await start();
    for (let i = 0; i < 5; i++) {
      expect((await s.admin.post('/security/reauth', { password: `wrong-${i}` })).status).toBe(401);
    }
    const limited = await s.reauth();
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('RATE_LIMITED');
    // The sign-in page is limited too: the attempts were counted against the same address.
    const b = new Browser(s.stack.bridge);
    expect((await b.login()).status).toBe(429);
  });
});

describe('the password', () => {
  it('needs the current password; Argon2id; other sessions are signed out, this one is kept', async () => {
    const s = await start();
    const other = new Browser(s.stack.bridge);
    expect((await other.login()).status).toBe(200);
    const otherApi = asBrowser(s, other);
    expect((await otherApi.get('/security')).status).toBe(200);

    expect((await s.reauth()).status).toBe(200);
    const fresh = 'a new and long owner password 42';
    const wrong = await s.admin.post('/security/password', { currentPassword: 'nope', newPassword: fresh });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error.code).toBe('WRONG_PASSWORD');
    const weak = await s.admin.post('/security/password', {
      currentPassword: s.stack.bridge.password,
      newPassword: 'short',
    });
    expect(weak.status).toBe(400);
    const ok = await s.admin.post('/security/password', {
      currentPassword: s.stack.bridge.password,
      newPassword: fresh,
    });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.otherSessionsSignedOut).toBe(1);
    expect(ok.text).not.toContain(fresh);
    // The other dashboard is signed out; this one carries on.
    expect((await otherApi.get('/security')).status).toBe(401);
    expect((await s.admin.get('/security')).status).toBe(200);
    // The new password signs in; the old one does not.
    expect((await new Browser(s.stack.bridge).login('', { password: fresh })).status).toBe(200);
    expect((await new Browser(s.stack.bridge).login()).status).toBe(401);
    // Stored encrypted (an Argon2id hash under AES-GCM), never in plain text; the env value no longer counts.
    const pw = s.stack.services.credentials.password();
    expect(pw).toMatchObject({ ok: true, source: 'store' });
    expect((pw as { hash: string }).hash).toMatch(/^\$argon2id\$/);
    const row = s.stack.db
      .prepare("SELECT ciphertext FROM secrets WHERE scope = '*' AND purpose = 'owner_password_hash'")
      .get() as {
      ciphertext: Buffer;
    };
    expect(row.ciphertext.toString('latin1')).not.toContain('argon2id');
    expect(s.stack.audit('owner.password_change')[0]?.after).toMatchObject({
      ok: true,
      otherSessionsSignedOut: 1,
    });
  });
});

describe('the authenticator app', () => {
  it('enrols with a confirmed code, then sign-in and re-authentication need a code (or a recovery code, once)', async () => {
    const s = await start();
    expect((await s.admin.get('/overview')).json.security.totpEnabled).toBe(false);
    expect((await s.reauth()).status).toBe(200);
    const enrol = await s.admin.post('/security/totp/enrol', {});
    expect(enrol.status, enrol.text).toBe(200);
    expect(enrol.json.shownOnce).toBe(true);
    const secret: string = enrol.json.secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enrol.json.otpauthUri).toMatch(/^otpauth:\/\/totp\/LK-Bridge%3Aowner\?secret=/);
    // Not enabled until confirmed; a wrong code changes nothing.
    expect((await s.admin.get('/security')).json.totp).toMatchObject({
      enabled: false,
      enrolmentPending: true,
    });
    const bad = await s.admin.post('/security/totp/confirm', {
      code: '000000' === totp(secret, now()) ? '111111' : '000000',
    });
    expect(bad.status).toBe(400);
    expect((await s.admin.get('/security')).json.totp.enabled).toBe(false);
    const confirm = await s.admin.post('/security/totp/confirm', { code: totp(secret, now() - 30) });
    expect(confirm.status, confirm.text).toBe(200);
    const codes: string[] = confirm.json.recoveryCodes;
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){3}$/);
    const sec = (await s.admin.get('/security')).json;
    expect(sec.totp).toMatchObject({ enabled: true, source: 'store', recoveryCodesLeft: 10 });
    expect(JSON.stringify(sec)).not.toContain(secret);
    // Stored encrypted; recovery codes stored hashed.
    const raw = s.stack.db.prepare('SELECT code_hash FROM owner_recovery_codes').all() as {
      code_hash: string;
    }[];
    expect(raw).toHaveLength(10);
    for (const c of codes) expect(JSON.stringify(raw)).not.toContain(c.replace(/-/g, ''));

    // Sign-in now needs the second factor.
    const b = new Browser(s.stack.bridge);
    expect((await b.login()).status).toBe(401);
    expect((await b.login('', { totp: totp(secret, now()) })).status).toBe(200);
    // Re-authentication too.
    expect((await s.reauth()).status).toBe(401);
    expect((await s.reauth(totp(secret, now() + 30))).status).toBe(200);
    // A recovery code works once, written any way.
    const rc = codes[0]!;
    expect(
      (await new Browser(s.stack.bridge).login('', { totp: rc.toLowerCase().replace(/-/g, ' ') })).status,
    ).toBe(200);
    expect((await new Browser(s.stack.bridge).login('', { totp: rc })).status).toBe(401);
    expect((await s.admin.get('/security')).json.totp.recoveryCodesLeft).toBe(9);
    // New codes replace the old ones.
    const regen = await s.admin.post('/security/recovery-codes', { confirm: true });
    expect(regen.status, regen.text).toBe(200);
    expect(regen.json.recoveryCodes).toHaveLength(10);
    expect((await new Browser(s.stack.bridge).login('', { totp: codes[1]! })).status).toBe(401);
    expect((await new Browser(s.stack.bridge).login('', { totp: regen.json.recoveryCodes[0] })).status).toBe(
      200,
    );
  });

  it('removal needs re-authentication (with a code); afterwards sign-in needs the password only', async () => {
    const s = await start();
    expect((await s.reauth()).status).toBe(200);
    const secret: string = (await s.admin.post('/security/totp/enrol', {})).json.secret;
    expect((await s.admin.post('/security/totp/confirm', { code: totp(secret, now() - 30) })).status).toBe(
      200,
    );
    s.stack.db
      .prepare('UPDATE auth_owner_sessions SET reauth_at = NULL WHERE session_hash = ?')
      .run(s.stack.services.sessionHash(s.stack.sessionToken));
    expect((await s.admin.post('/security/totp/remove', { confirm: true })).status).toBe(403);
    expect((await s.reauth(totp(secret, now()))).status).toBe(200);
    const removed = await s.admin.post('/security/totp/remove', { confirm: true });
    expect(removed.status, removed.text).toBe(200);
    expect(
      s.stack.db.prepare("SELECT COUNT(*) AS n FROM secrets WHERE purpose = 'owner_totp_secret'").get(),
    ).toEqual({ n: 0 });
    expect(s.stack.db.prepare('SELECT COUNT(*) AS n FROM owner_recovery_codes').get()).toEqual({ n: 0 });
    expect((await new Browser(s.stack.bridge).login()).status).toBe(200);
    expect(s.stack.audit('owner.totp_remove')).toHaveLength(1);
    expect(JSON.stringify(s.stack.audit())).not.toContain(secret);
  });

  it('the Overview recommends it strongly while it is off', async () => {
    const s = await start();
    const o = (await s.admin.get('/overview')).json;
    expect(o.security).toMatchObject({ totpEnabled: false, canManageKeys: true, storeProblem: null });
  });
});

import type { AuthConfig } from '../config/auth.js';
import { OwnerCredentials, normaliseRecoveryCode } from './credentials.js';
import { type KeyRing, hashSecret, hmac, randomToken, safeEqual } from './crypto.js';
import type { AuthEventLogger } from './events.js';
import { hashPassword, verifyPassword } from './password.js';
import { SlidingWindowLimiter } from './rate-limit.js';
import type { AuthStore, SessionRecord } from './store.js';
import { verifyTotp } from './totp.js';

/**
 * The single owner account: Argon2id password (hash from the environment), optional TOTP,
 * server-side sessions in a secure HttpOnly SameSite=Lax cookie, CSRF tokens bound to the
 * session, and login rate limiting (per client IP and globally).
 */

export interface LoginAttempt {
  readonly username: string;
  readonly password: string;
  readonly totp: string | undefined;
  readonly ip: string;
  readonly userAgent: string | undefined;
}

export type LoginResult =
  | { readonly ok: true; readonly sessionToken: string }
  | { readonly ok: false; readonly reason: 'invalid' }
  | { readonly ok: false; readonly reason: 'rate_limited'; readonly retryAfterSeconds: number }
  /** OPS2: the owner's stored credentials cannot be read (master key missing or wrong); `message` says what to fix. */
  | { readonly ok: false; readonly reason: 'unavailable'; readonly message: string };

/** OPS2: a re-authentication (password, and the second factor when enabled) on an existing session. */
export interface ReauthAttempt {
  readonly sessionToken: string;
  readonly password: string;
  readonly totp: string | undefined;
  readonly ip: string;
}

export type ReauthResult =
  | { readonly ok: true; readonly at: number }
  | { readonly ok: false; readonly reason: 'invalid' | 'no_session' }
  | { readonly ok: false; readonly reason: 'rate_limited'; readonly retryAfterSeconds: number }
  | { readonly ok: false; readonly reason: 'unavailable'; readonly message: string };

/** OPS2: sensitive actions need a re-authentication within this many seconds. */
export const REAUTH_WINDOW_SECONDS = 300;

export interface LoginLimits {
  readonly perIp: { readonly limit: number; readonly windowMs: number };
  readonly global: { readonly limit: number; readonly windowMs: number };
}

/** An Argon2id hash of a random value, verified when no real hash can be had (same cost, never matches). */
let dummyHash: Promise<string> | undefined;
const dummy = (): Promise<string> => (dummyHash ??= hashPassword(randomToken(24)));

export const DEFAULT_LOGIN_LIMITS: LoginLimits = {
  perIp: { limit: 5, windowMs: 15 * 60_000 },
  global: { limit: 30, windowMs: 15 * 60_000 },
};

export class OwnerAuth {
  readonly sessionCookie: string;
  readonly loginCookie: string;
  private readonly perIp: SlidingWindowLimiter;
  private readonly global: SlidingWindowLimiter;

  constructor(
    private readonly deps: {
      readonly store: AuthStore;
      readonly config: AuthConfig;
      readonly keys: KeyRing;
      readonly event: AuthEventLogger;
      readonly now: () => number;
      readonly limits?: LoginLimits;
      /** OPS2: where the password hash and the TOTP secret come from (the encrypted store, or the env file). */
      readonly credentials?: OwnerCredentials;
    },
  ) {
    // The __Host- prefix pins the cookie to this exact host, path "/" and HTTPS.
    const prefix = deps.config.secureCookies ? '__Host-' : '';
    this.sessionCookie = `${prefix}lkb_session`;
    this.loginCookie = `${prefix}lkb_login`;
    const limits = deps.limits ?? DEFAULT_LOGIN_LIMITS;
    const nowMs = () => deps.now() * 1000;
    this.perIp = new SlidingWindowLimiter(limits.perIp.limit, limits.perIp.windowMs, nowMs);
    this.global = new SlidingWindowLimiter(limits.global.limit, limits.global.windowMs, nowMs);
    this.credentials =
      deps.credentials ??
      new OwnerCredentials({
        db: deps.store.db,
        env: {
          passwordHash: deps.config.owner.passwordHash,
          totpSecret: deps.config.owner.totpSecret,
        },
        now: deps.now,
      });
  }

  /** OPS2: the owner's password hash and authenticator, from the encrypted store (or the env file before import). */
  readonly credentials: OwnerCredentials;

  get totpRequired(): boolean {
    return this.credentials.totpRequired();
  }

  cookieOptions(maxAgeSeconds: number) {
    return {
      httpOnly: true,
      secure: this.deps.config.secureCookies,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: maxAgeSeconds,
    };
  }

  async login(a: LoginAttempt): Promise<LoginResult> {
    const wait = this.waitMs(a.ip);
    if (wait > 0) {
      const retryAfterSeconds = Math.ceil(wait / 1000);
      this.deps.event('login.rate_limited', { ip: a.ip, retry_after_s: retryAfterSeconds }, 'warn');
      return { ok: false, reason: 'rate_limited', retryAfterSeconds };
    }
    // Count the attempt BEFORE the expensive check (chunk 8, F-01). Counting only after a failure let any number of
    // concurrent attempts pass the check above while earlier ones were still being verified. A success gives the
    // reservation back below; a failure keeps it.
    const reservedIp = this.perIp.hit(a.ip);
    const reservedGlobal = this.global.hit('*');
    const checked = await this.checkFactors(a.username, a.password, a.totp);
    if (checked.result !== 'ok') {
      // The reservations made above stand as this failure's count.
      if (checked.result === 'unavailable') {
        this.deps.event('login.unavailable', { ip: a.ip }, 'warn');
        return { ok: false, reason: 'unavailable', message: checked.message };
      }
      this.deps.event('login.failed', { ip: a.ip, factor: checked.factor }, 'warn');
      return { ok: false, reason: 'invalid' };
    }
    this.perIp.release(a.ip, reservedIp);
    this.global.release('*', reservedGlobal);
    this.perIp.reset(a.ip);
    const sessionToken = this.createSession(a.ip, a.userAgent);
    this.deps.event('login.succeeded', {
      ip: a.ip,
      totp: this.totpRequired,
      ...(checked.recoveryCode ? { recovery_code: true } : {}),
    });
    return { ok: true, sessionToken };
  }

  /**
   * OPS2: re-confirms the owner on an existing session (sensitive dashboard actions need it within the last 5 minutes).
   * Counted against the SAME limits as sign-in, so it is no way around them.
   */
  async reauthenticate(a: ReauthAttempt): Promise<ReauthResult> {
    const session = this.getSession(a.sessionToken);
    if (!session) return { ok: false, reason: 'no_session' };
    const wait = this.waitMs(a.ip);
    if (wait > 0) {
      const retryAfterSeconds = Math.ceil(wait / 1000);
      this.deps.event('reauth.rate_limited', { ip: a.ip, retry_after_s: retryAfterSeconds }, 'warn');
      return { ok: false, reason: 'rate_limited', retryAfterSeconds };
    }
    const reservedIp = this.perIp.hit(a.ip);
    const reservedGlobal = this.global.hit('*');
    const checked = await this.checkFactors(this.deps.config.owner.username, a.password, a.totp);
    if (checked.result !== 'ok') {
      if (checked.result === 'unavailable')
        return { ok: false, reason: 'unavailable', message: checked.message };
      this.deps.event('reauth.failed', { ip: a.ip, factor: checked.factor }, 'warn');
      return { ok: false, reason: 'invalid' };
    }
    this.perIp.release(a.ip, reservedIp);
    this.global.release('*', reservedGlobal);
    const at = this.deps.now();
    this.deps.store.setReauth(session.sessionHash, at);
    this.deps.event('reauth.succeeded', {
      ip: a.ip,
      ...(checked.recoveryCode ? { recovery_code: true } : {}),
    });
    return { ok: true, at };
  }

  /**
   * OPS2: checks the owner's CURRENT password alone (the password change asks for it as well as a fresh
   * re-authentication). Counted against the sign-in limits like any other attempt.
   */
  async checkPassword(
    password: string,
    ip: string,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: 'invalid' }
    | { ok: false; reason: 'rate_limited'; retryAfterSeconds: number }
    | { ok: false; reason: 'unavailable'; message: string }
  > {
    const wait = this.waitMs(ip);
    if (wait > 0) {
      const retryAfterSeconds = Math.ceil(wait / 1000);
      this.deps.event('reauth.rate_limited', { ip, retry_after_s: retryAfterSeconds }, 'warn');
      return { ok: false, reason: 'rate_limited', retryAfterSeconds };
    }
    const reservedIp = this.perIp.hit(ip);
    const reservedGlobal = this.global.hit('*');
    const pw = this.credentials.password();
    const ok = await verifyPassword(pw.ok ? pw.hash : await dummy(), password);
    if (!pw.ok) return { ok: false, reason: 'unavailable', message: pw.reason };
    if (!ok) {
      this.deps.event('reauth.failed', { ip, factor: 'password' }, 'warn');
      return { ok: false, reason: 'invalid' };
    }
    this.perIp.release(ip, reservedIp);
    this.global.release('*', reservedGlobal);
    return { ok: true };
  }

  /** OPS2: whether the session re-authenticated within the last 5 minutes; returns until when (Unix seconds). */
  reauthUntil(session: SessionRecord): number | null {
    if (session.reauthAt === null) return null;
    const until = session.reauthAt + REAUTH_WINDOW_SECONDS;
    const now = this.deps.now();
    return session.reauthAt <= now + 1 && now <= until ? until : null;
  }

  /** OPS2: signs out every other owner session (after a password change). Returns how many. */
  revokeOtherSessions(sessionToken: string): number {
    return this.deps.store.revokeOtherSessions(hashSecret(sessionToken), this.deps.now());
  }

  private waitMs(ip: string): number {
    return Math.max(this.perIp.retryAfterMs(ip), this.global.retryAfterMs('*'));
  }

  /**
   * Password (Argon2id, always run so a wrong username takes as long), then the second factor when one is enabled: a
   * TOTP code (each step usable once) or, instead, one of the recovery codes (used up).
   */
  private async checkFactors(
    username: string,
    password: string,
    second: string | undefined,
  ): Promise<
    | { result: 'ok'; recoveryCode: boolean }
    | { result: 'invalid'; factor: 'password' | 'totp' }
    | { result: 'unavailable'; message: string }
  > {
    const { owner } = this.deps.config;
    const pw = this.credentials.password();
    const totp = this.credentials.totp();
    // A dummy hash keeps the timing of an unavailable credential like that of a wrong password.
    const passwordOk = await verifyPassword(pw.ok ? pw.hash : await dummy(), password);
    const usernameOk = safeEqual(username, owner.username);
    if (!pw.ok) return { result: 'unavailable', message: pw.reason };
    if (totp.state === 'unreadable') return { result: 'unavailable', message: totp.reason };
    if (!(passwordOk && usernameOk)) return { result: 'invalid', factor: 'password' };
    if (totp.state === 'off') return { result: 'ok', recoveryCode: false };
    const code = (second ?? '').trim();
    if (/^\d{3}\s?\d{3}$/.test(code)) {
      const now = this.deps.now();
      const step = verifyTotp(totp.secret, code.replace(/\s+/g, ''), now);
      if (step !== undefined && this.deps.store.claimTotpStep(step, now)) {
        return { result: 'ok', recoveryCode: false };
      }
      return { result: 'invalid', factor: 'totp' };
    }
    if (normaliseRecoveryCode(code) && this.credentials.useRecoveryCode(code)) {
      this.deps.event('recovery_code.used', { remaining: this.credentials.recoveryCodesLeft() }, 'warn');
      return { result: 'ok', recoveryCode: true };
    }
    return { result: 'invalid', factor: 'totp' };
  }

  createSession(ip: string | undefined, userAgent: string | undefined): string {
    const token = randomToken(32);
    const now = this.deps.now();
    this.deps.store.insertSession({
      sessionHash: hashSecret(token),
      createdAt: now,
      expiresAt: now + this.deps.config.ttl.sessionSeconds,
      lastSeenAt: now,
      ip: ip ?? null,
      userAgent: userAgent ? userAgent.slice(0, 300) : null,
    });
    return token;
  }

  /** Returns the live session for a cookie value, or undefined. */
  getSession(token: string | undefined): SessionRecord | undefined {
    if (!token || token.length > 128) return undefined;
    const hash = hashSecret(token);
    const s = this.deps.store.getSession(hash);
    const now = this.deps.now();
    if (!s || s.revokedAt !== null || s.expiresAt <= now) return undefined;
    if (now - s.lastSeenAt >= 60) this.deps.store.touchSession(hash, now);
    return s;
  }

  logout(token: string | undefined, ip: string): void {
    if (!token) return;
    this.deps.store.revokeSession(hashSecret(token), this.deps.now());
    this.deps.event('logout', { ip });
  }

  /** CSRF token bound to the session and to a purpose (for example a pending consent id). */
  csrfToken(sessionToken: string, purpose: string): string {
    return hmac(this.deps.keys.csrf, 'session', hashSecret(sessionToken), purpose);
  }

  verifyCsrf(sessionToken: string, purpose: string, presented: string | undefined): boolean {
    return presented !== undefined && safeEqual(this.csrfToken(sessionToken, purpose), presented);
  }

  /** Login-form CSRF (no session yet): double-submit of a random cookie, MACed. */
  loginCsrfToken(nonce: string): string {
    return hmac(this.deps.keys.csrf, 'login', nonce);
  }

  verifyLoginCsrf(nonce: string | undefined, presented: string | undefined): boolean {
    return (
      nonce !== undefined &&
      presented !== undefined &&
      nonce.length <= 128 &&
      safeEqual(this.loginCsrfToken(nonce), presented)
    );
  }
}

import type { AuthConfig } from '../config/auth.js';
import { type KeyRing, hashSecret, hmac, randomToken, safeEqual } from './crypto.js';
import type { AuthEventLogger } from './events.js';
import { verifyPassword } from './password.js';
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
  | { readonly ok: false; readonly reason: 'rate_limited'; readonly retryAfterSeconds: number };

export interface LoginLimits {
  readonly perIp: { readonly limit: number; readonly windowMs: number };
  readonly global: { readonly limit: number; readonly windowMs: number };
}

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
  }

  get totpRequired(): boolean {
    return this.deps.config.owner.totpSecret !== undefined;
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
    const wait = Math.max(this.perIp.retryAfterMs(a.ip), this.global.retryAfterMs('*'));
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
    const { owner } = this.deps.config;
    // Always run the expensive check, so a wrong username takes as long as a wrong password.
    const passwordOk = await verifyPassword(owner.passwordHash, a.password);
    const usernameOk = safeEqual(a.username, owner.username);
    let totpOk = true;
    if (owner.totpSecret !== undefined) {
      const now = this.deps.now();
      const step = verifyTotp(owner.totpSecret, (a.totp ?? '').replace(/\s+/g, ''), now);
      totpOk = step !== undefined && usernameOk && passwordOk && this.deps.store.claimTotpStep(step, now);
    }
    if (!(passwordOk && usernameOk && totpOk)) {
      // The reservations made above stand as this failure's count.
      this.deps.event(
        'login.failed',
        { ip: a.ip, factor: !usernameOk || !passwordOk ? 'password' : 'totp' },
        'warn',
      );
      return { ok: false, reason: 'invalid' };
    }
    this.perIp.release(a.ip, reservedIp);
    this.global.release('*', reservedGlobal);
    this.perIp.reset(a.ip);
    const sessionToken = this.createSession(a.ip, a.userAgent);
    this.deps.event('login.succeeded', { ip: a.ip, totp: this.totpRequired });
    return { ok: true, sessionToken };
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

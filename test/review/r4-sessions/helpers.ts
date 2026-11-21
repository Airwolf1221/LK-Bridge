/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON replies in tests */
/**
 * CR-2026-11 round 4 (sessions): shared helpers for the adversarial tests of ADR 0062's session model (the sliding
 * session, Sign out everywhere, the step-up and the three bounce pages). Each test asserts the SAFE behaviour: it passes
 * when the attempt held and fails when it got through. Everything runs against the in-repo bridge and the mock
 * LegendKeeper; nothing here calls a live system.
 */
import { ADMIN_CSRF_PURPOSE } from '../../../src/admin/index.js';
import type { AuthServices } from '../../../src/auth/services.js';
import type { Db } from '../../../src/db/open.js';
import type { AdminStack, Reply } from '../../admin/helpers.js';

export const nowS = (): number => Math.floor(Date.now() / 1000);
export const DAY = 86_400;

/** Anything with a bridge listening at `base` and its auth services (the admin stack or the tools stack). */
export interface Served {
  readonly base: string;
  readonly services: AuthServices;
  readonly db: Db;
}

export interface Owner {
  readonly token: string;
  readonly cookie: string;
  readonly csrf: string;
  call(
    method: string,
    path: string,
    body?: unknown,
    o?: { headers?: Record<string, string>; csrf?: string | null; origin?: string | null },
  ): Promise<Reply>;
  /** When this session last stepped up (Unix seconds), or null. */
  reauthAt(): number | null;
  setReauth(at: number | null): void;
  row(): { expires_at: number; last_seen_at: number; revoked_at: number | null; reauth_at: number | null };
}

/**
 * A signed-in owner session that has NOT stepped up (what a stolen session cookie gives an attacker), with its CSRF
 * token, calling the bridge as the dashboard does (Origin = the public URL, `Sec-Fetch-Site: same-origin`).
 */
export function ownerSession(
  s: Served,
  publicUrl = 'https://lk.example.test',
  token = s.services.owner.createSession('127.0.0.1', 'r4-sessions'),
): Owner {
  const cookie = `${s.services.owner.sessionCookie}=${token}`;
  const csrf = s.services.owner.csrfToken(token, ADMIN_CSRF_PURPOSE);
  const hash = s.services.sessionHash(token);
  const call: Owner['call'] = async (method, path, body, o = {}) => {
    const headers: Record<string, string> = { cookie, 'sec-fetch-site': 'same-origin' };
    if (o.origin !== null) headers.origin = o.origin ?? publicUrl;
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      if (o.csrf !== null) headers['x-csrf-token'] = o.csrf ?? csrf;
    }
    Object.assign(headers, o.headers);
    const res = await fetch(s.base + path, {
      method,
      headers,
      ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
      redirect: 'manual',
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, text, json };
  };
  const row = () =>
    s.db
      .prepare(
        'SELECT expires_at, last_seen_at, revoked_at, reauth_at FROM auth_owner_sessions WHERE session_hash = ?',
      )
      .get(hash) as ReturnType<Owner['row']>;
  return {
    token,
    cookie,
    csrf,
    call,
    row,
    reauthAt: () => row().reauth_at,
    setReauth: (at) =>
      s.db.prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?').run(at, hash),
  };
}

/** The admin stack's own session, its step-up taken away (a session signed in but not stepped up). */
export function notSteppedUp(stack: AdminStack): Owner {
  const o = ownerSession(stack, stack.bridge.publicUrl, stack.sessionToken);
  o.setReauth(null);
  return o;
}

/**
 * A GET whose request target is sent byte for byte, over a socket (a browser would percent-encode quotes, brackets,
 * tabs and backslashes; another client need not). Resolves with the status, the headers (lower-case) and the body.
 */
export async function rawGet(
  base: string,
  target: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const { connect } = await import('node:net');
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const sock = connect(Number(u.port), u.hostname, () => {
      const lines = [`GET ${target} HTTP/1.1`, `Host: ${u.host}`, 'Connection: close'];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      sock.write(Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'));
    });
    let buf = '';
    sock.setEncoding('latin1');
    sock.on('data', (d: string) => (buf += d));
    sock.on('error', reject);
    sock.on('end', () => {
      const [head = '', ...rest] = buf.split('\r\n\r\n');
      const [statusLine = '', ...hs] = head.split('\r\n');
      const out: Record<string, string> = {};
      for (const h of hs) {
        const i = h.indexOf(':');
        if (i > 0) out[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
      }
      let body = rest.join('\r\n\r\n');
      if (out['transfer-encoding'] === 'chunked') {
        let decoded = '';
        let rem = body;
        for (;;) {
          const nl = rem.indexOf('\r\n');
          if (nl < 0) break;
          const size = parseInt(rem.slice(0, nl), 16);
          if (!size) break;
          decoded += rem.slice(nl + 2, nl + 2 + size);
          rem = rem.slice(nl + 2 + size + 2);
        }
        body = decoded;
      }
      resolve({ status: Number(statusLine.split(' ')[1] ?? 0), headers: out, body });
    });
  });
}

/** Expects a 403 REAUTH_REQUIRED. */
export function asksStepUp(r: Reply, what: string): void {
  if (r.status !== 403 || r.json?.error?.code !== 'REAUTH_REQUIRED')
    throw new Error(`${what}: expected 403 REAUTH_REQUIRED, got ${r.status} ${r.text.slice(0, 300)}`);
}

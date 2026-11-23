/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- parsed JSON replies */
/**
 * v3 F5b (ADR 0068): the owner's dashboard session in a test world: requests to the admin API with the session cookie
 * and CSRF token, and the step-up set (or lapsed) directly on the session, as the admin tests do.
 */
import { ADMIN_CSRF_PURPOSE } from '../../src/admin/guard.js';
import { PUBLIC_URL } from '../tools/helpers.js';
import type { RetagWorld } from '../packs/retag-world.js';

export interface OwnerHttp {
  get(path: string): Promise<{ status: number; json: any }>;
  post(path: string, body: unknown): Promise<{ status: number; json: any }>;
  /** The step-up made now (it holds for ten minutes). */
  stepUp(): void;
  /** The step-up lapsed (eleven minutes ago). */
  expire(): void;
}

export function ownerHttp(w: Pick<RetagWorld, 'stack'>): OwnerHttp {
  const s = w.stack.services;
  const session = s.owner.createSession('127.0.0.1', 'vitest');
  const headers = {
    cookie: `${s.owner.sessionCookie}=${session}`,
    origin: PUBLIC_URL,
    'x-csrf-token': s.owner.csrfToken(session, ADMIN_CSRF_PURPOSE),
    'content-type': 'application/json',
  };
  const setReauth = (at: number) =>
    w.stack.db
      .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
      .run(at, s.sessionHash(session));
  const url = (path: string) =>
    `${w.stack.base}/api/admin${path}${path.includes('?') ? '&' : '?'}project=test`;
  return {
    async get(path) {
      const res = await fetch(url(path), { headers });
      return { status: res.status, json: await res.json() };
    },
    async post(path, body) {
      const res = await fetch(url(path), { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    },
    stepUp: () => setReauth(Math.floor(Date.now() / 1000)),
    expire: () => setReauth(Math.floor(Date.now() / 1000) - 660),
  };
}

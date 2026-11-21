/**
 * CR-2026-11-R4 (ADR 0062 decision 1; the review's SE-42 and SE-43): the dashboard marks every request it sends without
 * the owner's input (`X-LKB-Background: 1`), and the bridge checks such a request as the live stream's periodic check
 * is: the session must be live, but its end does not move and its cookie is not renewed. Opening the live stream (which
 * the dashboard does by itself after every drop, and an EventSource cannot mark) is never a use either. The owner's
 * own requests still are. The dashboard's side is test/ui/background.test.tsx. Mocks only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { openStream, startAdminStack, type AdminStack } from '../admin/helpers.js';

const DAY = 86_400;
const nowS = () => Math.floor(Date.now() / 1000);

let s: AdminStack | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

/** The stack's session as if last used `ago` seconds ago (its end 30 days after that). */
function usedAgo(stack: AdminStack, ago: number): number {
  const at = nowS() - ago;
  stack.db
    .prepare('UPDATE auth_owner_sessions SET last_seen_at = ?, expires_at = ? WHERE session_hash = ?')
    .run(at, at + 30 * DAY, stack.services.sessionHash(stack.sessionToken));
  return at + 30 * DAY;
}
const row = (stack: AdminStack) =>
  stack.db
    .prepare('SELECT expires_at, last_seen_at FROM auth_owner_sessions WHERE session_hash = ?')
    .get(stack.services.sessionHash(stack.sessionToken)) as { expires_at: number; last_seen_at: number };
const sessionCookieOf = (stack: AdminStack, headers: Headers) =>
  headers.getSetCookie().find((c) => c.startsWith(`${stack.services.owner.sessionCookie}=`));

const OWN = { headers: { 'x-lkb-background': '1' } } as const;

describe("the dashboard's own requests are not a use of the session", () => {
  it('a marked read, a marked page of data and the step-up check: the session is checked, its end does not move', async () => {
    const stack = (s = await startAdminStack());
    const ends = usedAgo(stack, DAY);
    for (const path of [
      '/api/admin/session',
      '/api/admin/maintenance',
      '/api/admin/security',
      '/api/admin/overview',
    ]) {
      const r = await stack.get(path, OWN);
      expect(r.status, `${path}: ${r.text.slice(0, 200)}`).toBe(200);
      expect(sessionCookieOf(stack, r.headers), path).toBeUndefined();
      expect(row(stack).expires_at, path).toBe(ends);
    }
    // A marked change is checked as any change is (Origin, CSRF, the step-up): marking it only means it is not a use.
    const marked = await stack.put(
      '/api/admin/settings/contact-email',
      { value: 'owner@example.test', confirm: true },
      OWN,
    );
    expect(marked.status, marked.text).toBe(200);
    expect(row(stack).expires_at).toBe(ends);
    expect((await stack.post('/api/admin/writes/pause', {}, { ...OWN, csrf: null })).status).toBe(403);
    // The same read unmarked is the owner's: a use, the end 30 days on and the cookie renewed.
    const used = await stack.get('/api/admin/maintenance');
    expect(used.status).toBe(200);
    expect(sessionCookieOf(stack, used.headers)).toMatch(/; Max-Age=2592000/);
    expect(row(stack).expires_at).toBeGreaterThanOrEqual(nowS() + 30 * DAY - 2);
  });

  it('only the value 1 marks a request; a marked request of an ended session is refused as any is', async () => {
    const stack = (s = await startAdminStack());
    const ends = usedAgo(stack, DAY);
    expect((await stack.get('/api/admin/session', { headers: { 'x-lkb-background': 'yes' } })).status).toBe(
      200,
    );
    expect(row(stack).expires_at).toBeGreaterThan(ends); // not the mark: a use
    usedAgo(stack, 30 * DAY + 5); // ended
    expect((await stack.get('/api/admin/session', OWN)).status).toBe(401);
  });

  it('opening the live stream is not a use (the dashboard opens it again by itself after each drop)', async () => {
    const stack = (s = await startAdminStack());
    const ends = usedAgo(stack, DAY);
    const stream = await openStream(stack);
    try {
      expect(stream.status).toBe(200);
      await stream.waitFor((f) => f.event === 'hello');
      expect(sessionCookieOf(stack, stream.headers)).toBeUndefined();
      expect(row(stack).expires_at).toBe(ends);
    } finally {
      stream.close();
    }
    // A stream of a session that has ended is still refused.
    usedAgo(stack, 30 * DAY + 5);
    expect((await openStream(stack)).status).toBe(401);
  });
});

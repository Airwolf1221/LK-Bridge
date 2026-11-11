/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies in tests */
/**
 * C2d, Part 3 (ADR 0036 decision 4, accepted by the owner on 11 November 2026): saving the canon rules (any change,
 * switching a rule off and `rules: []` included) and saving the lifecycle settings need the owner to have signed in
 * again within the last 5 minutes, as the other sensitive actions do (ADR 0028). Nothing is saved without it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CANONICAL_RULES } from '../../src/facts/rules.js';
import { startManaged, type Managed } from './helpers.js';

let m: Managed | undefined;
afterEach(async () => {
  await m?.close();
  m = undefined;
});
const now = () => Math.floor(Date.now() / 1000);

describe('re-authentication for the canon rules and the lifecycle settings', () => {
  it('every save is refused without it, nothing changes; with it each saves; it lasts five minutes', async () => {
    const s = (m = await startManaged({ lk: [{ name: 'alpha' }], envProjects: ['alpha'] }));
    const rulesNow = async (): Promise<{ rules: { enabled?: boolean }[] }> =>
      (await s.admin.get('/projects/alpha/canon')).json as { rules: { enabled?: boolean }[] };
    const before = await rulesNow();
    const off = DEFAULT_CANONICAL_RULES.map((r, i) => (i === 0 ? { ...r, enabled: false } : r));
    const attempts: [string, unknown][] = [
      ['/projects/alpha/canon', { rules: [], confirm: true }],
      ['/projects/alpha/canon', { rules: off, confirm: true }],
      ['/projects/alpha/canon', { rules: [DEFAULT_CANONICAL_RULES[0]], confirm: true }],
      ['/projects/alpha/canon', { rules: null, confirm: true }],
      [
        '/projects/alpha/lifecycle',
        { confirm: true, tags: { canon: 'CANON', working: 'WIP', archived: 'Archived' } },
      ],
      ['/projects/alpha/lifecycle', { confirm: true, reset: true }],
    ];
    for (const [path, body] of attempts) {
      const r = await s.admin.put(path, body);
      expect(r.status, `${path} ${JSON.stringify(body)}`).toBe(403);
      expect(r.json.error.code).toBe('REAUTH_REQUIRED');
    }
    expect(await rulesNow()).toEqual(before);
    expect((await s.admin.get('/projects/alpha/lifecycle')).json.config.tags.working).toBe('Working');
    expect(s.stack.audit('project.set_canonical_rules')).toEqual([]);
    expect(s.stack.audit('project.set_lifecycle')).toEqual([]);

    expect((await s.reauth()).status).toBe(200);
    const saved = await s.admin.put('/projects/alpha/canon', { rules: off, confirm: true });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json.rules[0].enabled).toBe(false);
    const lc = await s.admin.put('/projects/alpha/lifecycle', {
      confirm: true,
      tags: { canon: 'CANON', working: 'WIP', archived: 'Archived' },
    });
    expect(lc.status, lc.text).toBe(200);
    expect(lc.json.config.tags.working).toBe('WIP');

    // The window is five minutes, as for keys.
    const hash = s.stack.services.sessionHash(s.stack.sessionToken);
    s.stack.db
      .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
      .run(now() - 301, hash);
    const late = await s.admin.put('/projects/alpha/canon', { rules: null, confirm: true });
    expect(late.status).toBe(403);
    const lateLc = await s.admin.put('/projects/alpha/lifecycle', { confirm: true, reset: true });
    expect(lateLc.status).toBe(403);
    expect((await rulesNow()).rules[0].enabled).toBe(false);
  });
});

/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies in tests */
/**
 * C2d, Part 3 (ADR 0036 decision 4) had saving the canon rules (any change, switching a rule off and `rules: []`
 * included) and saving the lifecycle settings ask for a step-up, as the key changes do (ADR 0028). ADR 0081 (the owner,
 * 26 November 2026: "A code at sign-in is enough"): they are settings, not credentials, so a session signed in but not
 * stepped up saves them; each save is still confirmed (`confirm: true`) and audited.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CANONICAL_RULES } from '../../src/facts/rules.js';
import { startManaged, type Managed } from './helpers.js';

let m: Managed | undefined;
afterEach(async () => {
  await m?.close();
  m = undefined;
});

/** The admin stack's own session, its step-up taken away. */
const notSteppedUp = (s: Managed) =>
  s.stack.db
    .prepare('UPDATE auth_owner_sessions SET reauth_at = NULL WHERE session_hash = ?')
    .run(s.stack.services.sessionHash(s.stack.sessionToken));

describe('the canon rules and the lifecycle settings (ADR 0081: no fresh code)', () => {
  it('every save goes through without a step-up, confirmed and audited', async () => {
    const s = (m = await startManaged({ lk: [{ name: 'alpha' }], envProjects: ['alpha'] }));
    notSteppedUp(s);
    const off = DEFAULT_CANONICAL_RULES.map((r, i) => (i === 0 ? { ...r, enabled: false } : r));
    const attempts: [string, unknown][] = [
      ['/projects/alpha/canon', { rules: [], confirm: true }],
      ['/projects/alpha/canon', { rules: [DEFAULT_CANONICAL_RULES[0]], confirm: true }],
      ['/projects/alpha/canon', { rules: null, confirm: true }],
      ['/projects/alpha/canon', { rules: off, confirm: true }],
      ['/projects/alpha/lifecycle', { confirm: true, reset: true }],
      [
        '/projects/alpha/lifecycle',
        { confirm: true, tags: { canon: 'CANON', working: 'WIP', archived: 'Archived' } },
      ],
    ];
    for (const [path, body] of attempts) {
      const r = await s.admin.put(path, body);
      expect(r.status, `${path} ${JSON.stringify(body)}: ${r.text}`).toBe(200);
    }
    const rules = (await s.admin.get('/projects/alpha/canon')).json as { rules: { enabled?: boolean }[] };
    expect(rules.rules[0]!.enabled).toBe(false);
    expect((await s.admin.get('/projects/alpha/lifecycle')).json.config.tags.working).toBe('WIP');
    expect(s.stack.audit('project.set_canonical_rules')).toHaveLength(4);
    expect(s.stack.audit('project.set_lifecycle')).toHaveLength(2);
    // Unconfirmed: refused, as before.
    expect((await s.admin.put('/projects/alpha/canon', { rules: null })).status).toBe(400);
  });
});

describe('E5.3: the indexes whose pages are Authoritative without CANON (ADR 0046 decision 13)', () => {
  it('saving the list needs no fresh code, like the other lifecycle settings; an id that is no index is refused', async () => {
    const s = (m = await startManaged({ lk: [{ name: 'alpha' }], envProjects: ['alpha'] }));
    notSteppedUp(s);
    const body = { confirm: true, canonExemptIndexes: [] as string[] };
    // Not an index in this project's tree: refused with the reason, nothing saved.
    const unknown = await s.admin.put('/projects/alpha/lifecycle', {
      ...body,
      canonExemptIndexes: ['nowhere1'],
    });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error.code).toBe('INDEX_NOT_FOUND');
    expect(s.stack.audit('project.set_lifecycle')).toEqual([]);
    const saved = await s.admin.put('/projects/alpha/lifecycle', body);
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json.config.canonExemptIndexes).toEqual([]);
    expect(s.stack.audit('project.set_lifecycle')).toHaveLength(1);
  });
});

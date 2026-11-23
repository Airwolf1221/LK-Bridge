/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies */
/**
 * v3 F5a (ADR 0067, H2 and H4): the Tagging page's new routes and ADR 0062's rule. "Keep this tag here" and "Approve all
 * these batches" ask for the step-up; "Allow this tag everywhere" asks for it except as a dry run; withdrawing a ruling
 * is one click (a tightening); agents have no route to any of them (their tool only suggests).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { startAdminStack, type AdminStack } from './helpers.js';

let s: AdminStack;
beforeAll(async () => {
  s = await startAdminStack({
    respond: (req: MockRequest): MockResponse | undefined => {
      const m = /\/resources\/govroot1\/docs\/(gov[a-z]+)\/blocks\/?$/.exec(req.path);
      if (req.method === 'GET' && m)
        return { status: 200, body: { id: m[1], version: 'v1', schema: 1, text: '', blocks: [] } };
      return undefined;
    },
  });
  await s.runtime.ready;
  s.runtime.packs.ensureSeeded();
  s.runtime.packs.store.setGovernance(
    'arkona',
    ['character-architecture', 'source-formatting', 'tagging-standard'].map((key) => ({
      key,
      project: 'test',
      resourceId: 'govroot1',
      documentId: `gov${key.replace(/-/g, '').slice(0, 8)}`,
      name: key,
    })),
  );
  stepUp();
  const ok = await s.post('/api/admin/packs/arkona/approve', { confirm: true });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
});
afterAll(async () => {
  await s?.close();
});

const setReauth = (at: number) =>
  s.db
    .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
    .run(at, s.services.sessionHash(s.sessionToken));
const stepUp = () => setReauth(Math.floor(Date.now() / 1000));
const expire = () => setReauth(Math.floor(Date.now() / 1000) - 601);

describe('the F5a Tagging routes', () => {
  it('"Keep this tag here" asks for the step-up', async () => {
    expire();
    const r = await s.post('/api/admin/tagging/keep-here', {
      pageId: 'pg1',
      tag: 'Lore',
      reason: 'x',
      confirm: true,
    });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('REAUTH_REQUIRED');
  });

  it('withdrawing a ruling is one click', async () => {
    expire();
    const r = await s.post('/api/admin/tagging/unkeep', { pageId: 'pg1', tag: 'Lore', confirm: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.removed).toBe(false);
  });

  it('"Allow this tag everywhere": a dry run needs no step-up; the edit asks', async () => {
    expire();
    const dry = await s.post('/api/admin/tagging/allow-everywhere', { tag: 'Lore', dryRun: true });
    expect(dry.status).not.toBe(403);
    // This world's Tagging Standard is not a page of the project as named: refused, nothing written.
    expect(dry.json.error.code).toMatch(/SOURCE_ELSEWHERE|SECTION_NOT_READABLE|RETAG_UNAVAILABLE/);
    const edit = await s.post('/api/admin/tagging/allow-everywhere', { tag: 'Lore', confirm: true });
    expect(edit.status).toBe(403);
    expect(edit.json.error.code).toBe('REAUTH_REQUIRED');
    const unconfirmed = await s.post('/api/admin/tagging/allow-everywhere', { tag: 'Lore' });
    expect(unconfirmed.json.error.code).toBe('CONFIRM_REQUIRED');
  });

  it('"Approve all these batches" asks for the step-up, and takes retag batches only', async () => {
    expire();
    const r = await s.post('/api/admin/tagging/approve-batches', { proposalIds: ['prop_x'], confirm: true });
    expect(r.status).toBe(403);
    stepUp();
    const notBatch = await s.post('/api/admin/tagging/approve-batches', {
      proposalIds: ['prop_x'],
      confirm: true,
    });
    expect(notBatch.status).toBe(400);
    expect(notBatch.json.error.code).toBe('NOT_A_RETAG_BATCH');
  });

  it('"Apply all corrections" of a run that is not there is refused before anything is proposed', async () => {
    stepUp();
    const r = await s.post('/api/admin/tagging/apply-all', { runId: 'rtg_0123456789abcdef', confirm: true });
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('RUN_NOT_FOUND');
  });
});

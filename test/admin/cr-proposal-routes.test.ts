/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/**
 * Security review (cr): the proposal decision routes added since v1.0.2 validate their input before deciding anything.
 * (These pass on the reviewed code; they pin the behaviour the review relied on.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAdminStack, type AdminStack } from './helpers.js';

let stack: AdminStack;
beforeAll(async () => {
  stack = await startAdminStack();
});
afterAll(async () => stack.close());

describe('POST /api/admin/proposals/bulk (approve-as-canon)', () => {
  // v3 F5a (ADR 0067, H4): at most 1,000 ids (was 100: a selection may span pages).
  it('needs confirm: true (literal), at most 1,000 ids, and a session with CSRF', async () => {
    const ids = ['prop_x'];
    expect((await stack.post('/api/admin/proposals/bulk', { action: 'approve-as-canon', ids })).status).toBe(
      400,
    );
    expect(
      (await stack.post('/api/admin/proposals/bulk', { action: 'approve-as-canon', ids, confirm: 'true' }))
        .status,
    ).toBe(400);
    const many = Array.from({ length: 1001 }, (_, i) => `prop_${i}`);
    expect(
      (
        await stack.post('/api/admin/proposals/bulk', {
          action: 'approve-as-canon',
          ids: many,
          confirm: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await stack.post(
          '/api/admin/proposals/bulk',
          { action: 'approve-as-canon', ids, confirm: true },
          { csrf: null },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await stack.post(
          '/api/admin/proposals/bulk',
          { action: 'approve-as-canon', ids, confirm: true },
          { cookie: null, authorization: `Bearer ${'x'.repeat(40)}` },
        )
      ).status,
    ).toBe(401);
    // Unknown ids are reported per id, never approved.
    const r = await stack.post('/api/admin/proposals/bulk', {
      action: 'approve-as-canon',
      ids: ['prop_nope', 'prop_nope'],
      confirm: true,
    });
    expect(r.status).toBe(200);
    expect(r.json.results).toHaveLength(1);
    expect(r.json.results[0]).toMatchObject({ ok: false, error: { code: 'PROPOSAL_NOT_FOUND' } });
  });

  it('single approve-as-canon needs confirm: true', async () => {
    expect((await stack.post('/api/admin/proposals/prop_x/approve-as-canon', {})).status).toBe(400);
  });
});

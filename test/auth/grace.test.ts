import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type TestBridge,
  fullFlow,
  mcpPost,
  registerPublicClient,
  startBridge,
  tokenRequest,
} from './helpers.js';

/**
 * Follow-up item G (ADR 0009): a just-rotated refresh token presented again within the grace
 * window gets the same successor tokens; outside it, reuse revokes the whole grant.
 */

let bridge: TestBridge;
beforeAll(async () => {
  bridge = await startBridge();
});
afterAll(() => bridge.close());

const refresh = (token: string, clientId: string) =>
  tokenRequest(bridge, { grant_type: 'refresh_token', refresh_token: token, client_id: clientId });

describe('refresh-token grace window (default 10 seconds)', () => {
  it('returns the same successor tokens to concurrent refreshes with one token', async () => {
    const a = await fullFlow(bridge);
    const [first, second] = await Promise.all([
      refresh(a.refresh, a.clientId),
      refresh(a.refresh, a.clientId),
    ]);
    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    expect(second.body).toEqual(first.body);
    // The grant is intact: the successor works and rotates normally.
    expect((await mcpPost(bridge, first.body.access_token as string)).status).toBe(200);
    const next = await refresh(first.body.refresh_token as string, a.clientId);
    expect(next.res.status).toBe(200);
    expect(bridge.logs.join('')).toContain('"event":"token.refresh_replayed"');
  });

  it('replays within the window, measured from the rotation', async () => {
    const a = await fullFlow(bridge);
    const first = await refresh(a.refresh, a.clientId);
    bridge.clock.advance(9);
    try {
      const late = await refresh(a.refresh, a.clientId);
      expect(late.res.status).toBe(200);
      expect(late.body).toEqual(first.body);
    } finally {
      bridge.clock.advance(-9);
    }
  });

  it('outside the window, reuse revokes the whole grant', async () => {
    const a = await fullFlow(bridge);
    const first = await refresh(a.refresh, a.clientId);
    expect(first.res.status).toBe(200);
    bridge.clock.advance(11);
    try {
      const reuse = await refresh(a.refresh, a.clientId);
      expect(reuse.res.status).toBe(400);
      expect(reuse.body.error).toBe('invalid_grant');
      expect((await mcpPost(bridge, first.body.access_token as string)).status).toBe(401);
      const successor = await refresh(first.body.refresh_token as string, a.clientId);
      expect(successor.body.error).toBe('invalid_grant');
    } finally {
      bridge.clock.advance(-11);
    }
  });

  it('never replays to another client: that still revokes the grant', async () => {
    const a = await fullFlow(bridge);
    const first = await refresh(a.refresh, a.clientId);
    const thief = await registerPublicClient(bridge);
    const stolen = await refresh(a.refresh, thief);
    expect(stolen.body.error).toBe('invalid_grant');
    expect((await mcpPost(bridge, first.body.access_token as string)).status).toBe(401);
  });

  it('does not replay once the grant has been revoked', async () => {
    const a = await fullFlow(bridge);
    const first = await refresh(a.refresh, a.clientId);
    const payload = String(first.body.access_token).split('.')[1] as string;
    const { jti } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { jti: string };
    const family = bridge.services.store.getAccess(jti)?.familyId as string;
    bridge.services.store.revokeFamily(family, 'test', bridge.clock.now());
    const replay = await refresh(a.refresh, a.clientId);
    expect(replay.body.error).toBe('invalid_grant');
  });
});

describe('grace window disabled (AUTH_REFRESH_GRACE_SECONDS=0)', () => {
  it('revokes the grant on any reuse, even immediately', async () => {
    const strict = await startBridge({ env: { AUTH_REFRESH_GRACE_SECONDS: '0' } });
    try {
      const a = await fullFlow(strict);
      const first = await tokenRequest(strict, {
        grant_type: 'refresh_token',
        refresh_token: a.refresh,
        client_id: a.clientId,
      });
      expect(first.res.status).toBe(200);
      const again = await tokenRequest(strict, {
        grant_type: 'refresh_token',
        refresh_token: a.refresh,
        client_id: a.clientId,
      });
      expect(again.body.error).toBe('invalid_grant');
      expect((await mcpPost(strict, first.body.access_token as string)).status).toBe(401);
    } finally {
      await strict.close();
    }
  });
});

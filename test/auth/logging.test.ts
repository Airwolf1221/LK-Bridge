/**
 * Chunk 8 (F-09): request logging. Internet scanners probe the server constantly; their 404s must not bury the auth
 * events. One compact line per matched request at info, unmatched paths at debug only, never a query string or body.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLIC_URL, startBridge, type TestBridge } from './helpers.js';

let bridge: TestBridge;
beforeAll(async () => {
  bridge = await startBridge();
});
afterAll(async () => {
  await bridge.close();
});

const parsed = () => bridge.logs.map((l) => JSON.parse(l) as Record<string, unknown>);

describe('request logging', () => {
  it('logs scanner probes of unknown paths at debug only, and answers them with a plain 404', async () => {
    const before = bridge.logs.length;
    for (const path of ['/info.php', '/actuator/env', '/wp-login.php?redirect_to=x', '/.env', '/wp-admin/']) {
      const r = await bridge.fetch(`${PUBLIC_URL}${path}`, { method: path === '/.env' ? 'POST' : 'GET' });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'not_found' });
    }
    // The bridge logs at info here, so nothing at all reaches the log for them.
    expect(bridge.logs.slice(before)).toEqual([]);
  });

  it('writes one compact line per matched request: method, path without query, status, time, address', async () => {
    const before = bridge.logs.length;
    await (await bridge.fetch(`${PUBLIC_URL}/healthz?probe=secret-looking-value`)).text();
    const lines = parsed().slice(before);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      msg: 'request completed',
      method: 'GET',
      url: '/healthz',
      status: 200,
    });
    expect(typeof lines[0]!.ip).toBe('string');
    expect(typeof lines[0]!.ms).toBe('number');
    expect(JSON.stringify(lines)).not.toContain('secret-looking-value');
  });

  it('keeps auth events at their levels: an unauthenticated /mcp call is still a warning', async () => {
    const before = bridge.logs.length;
    const r = await bridge.fetch(`${PUBLIC_URL}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(401);
    const lines = parsed().slice(before);
    expect(lines.find((l) => l.event === 'mcp.rejected')).toMatchObject({ level: 40 });
    expect(lines.filter((l) => l.msg === 'request completed')).toHaveLength(1);
  });
});

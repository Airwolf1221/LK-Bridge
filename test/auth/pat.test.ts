import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPatCommand } from '../../src/auth/cli/pat.js';
import { hashSecret } from '../../src/auth/crypto.js';
import { PAT_PREFIX } from '../../src/auth/pats.js';
import { type TestBridge, mcpPost, parseChallenge, startBridge } from './helpers.js';

/** Requirement 12: personal access tokens. */

let bridge: TestBridge;
beforeAll(async () => {
  bridge = await startBridge();
});
afterAll(() => bridge.close());

describe('personal access tokens', () => {
  it('are shown once at creation and stored only as a hash', () => {
    const { token, pat } = bridge.services.pats.create({ name: 'Claude Code laptop' });
    expect(token.startsWith(PAT_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThan(40);
    expect(pat.hint).toBe(token.slice(-4));
    const rows = bridge.db.prepare('SELECT * FROM auth_pats').all();
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).toContain(hashSecret(token));
    const listed = bridge.services.pats.list();
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(JSON.stringify(listed)).not.toContain(hashSecret(token));
    expect(listed.find((p) => p.id === pat.id)?.name).toBe('Claude Code laptop');
  });

  it('are accepted as Bearer tokens at /mcp until revoked', async () => {
    const { token, pat } = bridge.services.pats.create({ name: 'revoke me' });
    expect((await mcpPost(bridge, token)).status).toBe(200);
    expect(bridge.services.pats.list().find((p) => p.id === pat.id)?.lastUsedAt).not.toBeNull();
    expect(bridge.services.pats.revoke(pat.id)).toBe(true);
    expect(bridge.services.pats.revoke(pat.id)).toBe(false);
    const res = await mcpPost(bridge, token);
    expect(res.status).toBe(401);
    expect(parseChallenge(res.headers.get('www-authenticate')).params.error).toBe('invalid_token');
  });

  it('stop working after their expiry', async () => {
    const { token } = bridge.services.pats.create({ name: 'short', expiresInDays: 1 });
    expect((await mcpPost(bridge, token)).status).toBe(200);
    bridge.clock.advance(86401);
    try {
      expect((await mcpPost(bridge, token)).status).toBe(401);
    } finally {
      bridge.clock.advance(-86401);
    }
  });

  it('refuses bad names and expiries', () => {
    expect(() => bridge.services.pats.create({ name: '' })).toThrow();
    expect(() => bridge.services.pats.create({ name: 'x'.repeat(101) })).toThrow();
    expect(() => bridge.services.pats.create({ name: 'ok', expiresInDays: 0 })).toThrow();
    expect(() => bridge.services.pats.create({ name: 'ok', expiresInDays: 1.5 })).toThrow();
  });

  it('are logged by id, never by value', () => {
    const { token, pat } = bridge.services.pats.create({ name: 'logged' });
    bridge.services.pats.revoke(pat.id);
    const logs = bridge.logs.join('');
    expect(logs).toContain(`"pat_id":"${pat.id}"`);
    expect(logs).not.toContain(token);
  });
});

describe('npm run pat', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lkb-pat-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('creates, lists and revokes tokens in the database, logging events by id', () => {
    const db = join(dir, 'bridge.db');
    const logged: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _e, cb) {
        logged.push(chunk.toString());
        cb();
      },
    });
    const run = (argv: string[], out: (s: string) => void) => runPatCommand(argv, db, out, sink);
    const out: string[] = [];
    expect(run(['create', '--name', 'cli token', '--expires-days', '30'], (s) => out.push(s))).toBe(0);
    const token = /(lkb_pat_[A-Za-z0-9_-]+)/.exec(out.join('\n'))?.[1] as string;
    expect(token).toBeDefined();
    const id = /Created (pat_[A-Za-z0-9_-]+)/.exec(out.join('\n'))?.[1] as string;
    out.length = 0;
    expect(run(['list'], (s) => out.push(s))).toBe(0);
    expect(out.join('\n')).toContain(id);
    expect(out.join('\n')).not.toContain(token);
    expect(readFileSync(db).includes(Buffer.from(token))).toBe(false);
    expect(run(['revoke', id], () => undefined)).toBe(0);
    expect(run(['revoke', id], () => undefined)).toBe(1);
    expect(run(['nonsense'], () => undefined)).toBe(2);
    expect(logged.join('')).toContain('"event":"pat.created"');
    expect(logged.join('')).not.toContain(token);
  });
});

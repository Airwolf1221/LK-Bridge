import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_TIER_LIMITS, loadConfig } from '../../src/config/index.js';

const base = {
  BRIDGE_PUBLIC_URL: 'https://lk.example.test',
  LK_API_KEY: 'test-key-not-real',
  LK_PROJECT_ID: 'proj_test',
  SESSION_SECRET: 'x'.repeat(32),
  JWT_SIGNING_KEY: 'y'.repeat(32),
};

describe('loadConfig', () => {
  it('applies plan defaults', () => {
    const c = loadConfig(base);
    expect(c.server).toMatchObject({ host: '127.0.0.1', port: 8787 });
    expect(c.lk.readOnly).toBe(true);
    expect(c.lk.allowMemberAdmin).toBe(false);
    expect(c.writers.max).toBe(2);
    expect(c.mcp.exposePerOpTools).toBe(false);
    expect(c.governor.reserveFloors).toEqual({ interactive: 0.1, job: 0.25, maintenance: 0.5 });
    expect(c.governor).toMatchObject({ writeSpacingMs: 500, writeSpacingStretchedMs: 1200 });
    expect(c.lk.tierLimits).toEqual(DEFAULT_TIER_LIMITS);
    expect(c.journal.retentionDays).toBe(30);
  });

  it('parses booleans strictly and overrides tier limits', () => {
    const c = loadConfig({ ...base, LK_READ_ONLY: 'false', LK_TIER_LIMITS: '{"write-min":60,"upload":10}' });
    expect(c.lk.readOnly).toBe(false);
    expect(c.lk.tierLimits['write-min']).toBe(60);
    expect(c.lk.tierLimits.upload).toBe(10);
    expect(c.lk.tierLimits['key-min']).toBe(300);
    expect(() => loadConfig({ ...base, LK_READ_ONLY: 'maybe' })).toThrow(ConfigError);
  });

  it('rejects bad input and names variables without echoing values', () => {
    expect(() => loadConfig({})).toThrow(/LK_API_KEY/);
    expect(() => loadConfig({ ...base, WRITERS_MAX: '9' })).toThrow(/WRITERS_MAX/);
    expect(() => loadConfig({ ...base, LK_TIER_LIMITS: '{bad' })).toThrow(/LK_TIER_LIMITS/);
    expect(() => loadConfig({ ...base, LK_TIER_LIMITS: '{"nope":1}' })).toThrow(/LK_TIER_LIMITS/);
    expect(() => loadConfig({ ...base, RESERVE_FLOOR_INTERACTIVE: '0.9' })).toThrow(/RESERVE_FLOOR/);
    try {
      loadConfig({ ...base, SESSION_SECRET: 'secret-short' });
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-short');
    }
  });
});

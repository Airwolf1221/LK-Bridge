/**
 * RV1-5: the recovery CLI's `offsite.sh connect` (src/offsite/cli.ts, case 'connect') swaps Google's code for tokens
 * and stores the refresh token without the two checks the dashboard's sign-in makes (ADR 0043 decision 2 and its threat
 * review, "Scope creep"; OffsiteService.completeConnect): a grant WITHOUT drive.file is stored and reported
 * "Connected" (it is neither refused nor revoked), and the previous refresh token is overwritten without being revoked
 * at Google, so the old grant lingers.
 *
 * In process, against the mock Google; stdin is a PassThrough fed with the address Google "sent the browser to".
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runOffsiteCli } from '../../src/offsite/cli.js';
import { OFFSITE_SCOPE } from '../../src/secrets/store.js';
import { makeWorld, PUBLIC_URL, type World } from '../offsite/world.js';

let w: World | undefined;
const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
afterEach(async () => {
  Object.defineProperty(process, 'stdin', stdin);
  delete process.env.LKB_TEST_GOOGLE_BASE;
  await w?.close();
  w = undefined;
});

/** Runs `connect`, approving at the mock Google with `scope`; returns the exit code and the output. */
async function connect(world: World, scope?: string): Promise<{ code: number; out: string[] }> {
  const envFile = join(world.dir, 'lk-bridge.env');
  writeFileSync(
    envFile,
    `SECRETS_MASTER_KEY=${world.masterKey}\nDB_PATH=${world.dbPath}\nBRIDGE_PUBLIC_URL=${PUBLIC_URL}\n`,
  );
  process.env.LKB_TEST_GOOGLE_BASE = world.google.base;
  const input = new PassThrough();
  Object.defineProperty(process, 'stdin', { value: input, configurable: true });
  const out: string[] = [];
  const code = await runOffsiteCli(['connect', '--env-file', envFile], (s) => {
    out.push(s);
    if (s.startsWith(world.google.endpoints.authorize)) {
      const a = world.google.approve(s, scope ? { scope } : {});
      input.write(
        `${a.redirectUri}?state=${encodeURIComponent(a.state)}&code=${encodeURIComponent(a.code)}\n`,
      );
    }
  });
  return { code, out };
}

describe('RV1-5: the CLI sign-in', () => {
  it('refuses (and revokes) a grant without drive.file, keeping the saved connection', async () => {
    w = await makeWorld();
    const before = w.secrets.read(OFFSITE_SCOPE, 'drive_refresh_token');
    const r = await connect(w, 'openid');
    const after = w.secrets.read(OFFSITE_SCOPE, 'drive_refresh_token');
    expect.soft(r.code, r.out.join('\n')).not.toBe(0);
    expect.soft(after).toEqual(before);
    expect.soft(w.google.revoked.length).toBe(1);
  });

  it('revokes the previous refresh token when it replaces it', async () => {
    w = await makeWorld();
    const old = w.secrets.read(OFFSITE_SCOPE, 'drive_refresh_token');
    expect(old.ok).toBe(true);
    const r = await connect(w);
    expect(r.code, r.out.join('\n')).toBe(0);
    const now = w.secrets.read(OFFSITE_SCOPE, 'drive_refresh_token');
    expect(now.ok && old.ok && now.value !== old.value).toBe(true);
    expect(w.google.revoked).toContain(old.ok ? old.value : '');
  });
});

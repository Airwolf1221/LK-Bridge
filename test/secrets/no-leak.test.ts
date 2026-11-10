/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- parsed JSON replies */
/**
 * OPS2: no secret ever leaves the bridge except where it must, once. One run does everything this release adds (import,
 * add, replace and remove a project, a refused key, a failed re-authentication, the password change, the authenticator
 * with its recovery codes, agent calls that succeed and fail), then scans every place a secret could leak:
 *
 * - the log (every line, info level and up), every API response, the live stream's events, the audit log, the error
 *   table, the dashboard and sign-in HTML, and the database files (the file, its WAL and shared memory) as bytes.
 *
 * The only exceptions are the two responses made to show a secret once (`shownOnce`): the authenticator secret when
 * enrolment starts, and recovery codes when they are made. Those are checked to hold nothing else.
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../../src/auth/totp.js';
import { Browser } from '../auth/helpers.js';
import { openStream, type SseConnection, type Reply } from '../admin/helpers.js';
import { startManaged, testKey, type Managed } from './helpers.js';

let m: Managed;
let stream: SseConnection;
const responses: { path: string; text: string }[] = [];
const shownOnce: { path: string; text: string }[] = [];
const secrets: Record<string, string> = {};

const now = () => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const master = testKey('master');
  secrets.master = master;
  m = await startManaged({
    lk: [{ name: 'alpha' }, { name: 'gamma' }],
    envProjects: ['alpha'],
    env: { SECRETS_MASTER_KEY: master },
    stack: { captureLogs: true },
  });
  secrets.alpha = m.projects.alpha!.keys[0]!;
  secrets.gamma = m.projects.gamma!.keys[0]!;
  secrets.refused = m.refusedKey;
  secrets.password = m.stack.bridge.password;
  stream = await openStream(m.stack);
  await stream.waitFor((f) => f.event === 'hello');

  const record = (path: string, r: Reply, once = false) => {
    (once ? shownOnce : responses).push({ path, text: r.text });
    return r;
  };
  const post = async (path: string, body?: unknown, once = false) =>
    record(path, await m.admin.post(path, body), once);
  const get = async (path: string) => record(path, await m.admin.get(path));
  const reauth = async (code?: string) =>
    post('/security/reauth', { password: secrets.password, ...(code ? { totp: code } : {}) });

  await post('/security/reauth', { password: 'a wrong password for the log' });
  await reauth();
  // Add gamma (and a refused key on the way).
  await post('/projects/check', { name: 'zeta', apiKey: secrets.refused });
  const check = await post('/projects/check', { name: 'gamma', apiKey: secrets.gamma });
  await post('/projects/confirm', { checkId: check.json.checkId, confirm: true });
  // Agents use it: a read that works and one that fails at LegendKeeper (an error row).
  const client = await m.connect('leak-writer', 'write');
  for (const id of ['gamma_root', 'gamma_missing']) {
    const r = await m.call(client, 'lk_api_read', {
      operationId: 'getResource',
      params: { path: { resourceId: id } },
      project: 'gamma',
    });
    responses.push({ path: `tool ${id}`, text: r.text });
  }
  await m.call(client, 'lk_api_write', {
    operationId: 'updateResource',
    params: { path: { resourceId: 'gamma_missing' }, body: { name: 'x' } },
    project: 'gamma',
  });
  // Replace gamma's key.
  secrets.gamma2 = m.addKey('gamma');
  const rc = await post('/projects/gamma/key/check', { apiKey: secrets.gamma2 });
  await post('/projects/confirm', { checkId: rc.json.checkId, confirm: true });
  await post('/projects/gamma/key/check', { apiKey: secrets.alpha }); // refused: another project's key
  // The password.
  secrets.newPassword = 'the owner’s new password, long enough 7';
  await post('/security/password', { currentPassword: secrets.password, newPassword: secrets.newPassword });
  secrets.password = secrets.newPassword;
  // The authenticator and its recovery codes.
  const enrol = await post('/security/totp/enrol', {}, true);
  secrets.totp = enrol.json.secret;
  const confirm = await post('/security/totp/confirm', { code: totp(secrets.totp, now() - 30) }, true);
  confirm.json.recoveryCodes.forEach((c: string, i: number) => (secrets[`recovery${i}`] = c));
  await reauth(totp(secrets.totp, now()));
  const regen = await post('/security/recovery-codes', { confirm: true }, true);
  regen.json.recoveryCodes.forEach((c: string, i: number) => (secrets[`recoveryNew${i}`] = c));
  // Sign in with a recovery code (the sign-in page, as a browser).
  const b = new Browser(m.stack.bridge);
  const page = await b.login('', { password: secrets.password, totp: secrets.recoveryNew0 });
  responses.push({ path: 'POST /oauth/login', text: await page.text() });
  // Remove gamma (decide nothing: it has no open work).
  await reauth(totp(secrets.totp, now() + 30));
  await post('/projects/gamma/remove', { confirm: true });
  // Every read the dashboard makes.
  for (const p of [
    '/session',
    '/overview',
    '/overview?project=gamma',
    '/projects',
    '/security',
    '/audit?limit=500',
    '/errors?project=gamma&resolved=all',
    '/jobs?project=gamma&view=history',
    '/journal?project=gamma',
    '/clients',
    '/settings',
  ]) {
    await get(p);
  }
  const ui = await m.stack.get('/ui/');
  responses.push({ path: '/ui/', text: ui.text });
  const login = await new Browser(m.stack.bridge).request(`${m.stack.bridge.publicUrl}/oauth/login`);
  responses.push({ path: 'GET /oauth/login', text: await login.text() });
  await new Promise((r) => setTimeout(r, 300)); // let the stream catch up
});
afterAll(async () => {
  stream?.close();
  await m?.close();
});

/** Every secret of the run, and a few derived forms a careless log might carry. */
function needles(except: readonly string[] = []): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, v] of Object.entries(secrets)) {
    if (except.some((e) => name.startsWith(e))) continue;
    out.push([name, v]);
    if (name.startsWith('recovery')) out.push([`${name} (bare)`, v.replace(/-/g, '')]);
  }
  return out;
}

function expectClean(where: string, text: string, except: readonly string[] = []): void {
  for (const [name, v] of needles(except)) {
    expect(text.includes(v), `${name} leaked into ${where}`).toBe(false);
  }
}

describe('no secret leaks (OPS2)', () => {
  it('did everything it set out to (so the scans below mean something)', () => {
    expect(Object.keys(secrets).length).toBeGreaterThan(25);
    expect(m.stack.audit('project.add')).toHaveLength(1);
    expect(m.stack.audit('project.replace_key')).toHaveLength(1);
    expect(m.stack.audit('project.remove')).toHaveLength(1);
    expect(m.stack.audit('owner.password_change').length).toBeGreaterThan(0);
    expect(m.stack.audit('owner.totp_enable').length).toBeGreaterThan(0);
    expect(
      m.stack.db.prepare("SELECT COUNT(*) AS n FROM errors WHERE project_id = 'lkp_gamma'").get(),
    ).not.toEqual({
      n: 0,
    });
  });

  it('not in the log', () => {
    const log = m.stack.logs.join('');
    expect(log.length).toBeGreaterThan(1000);
    expectClean('the log', log);
  });

  it('not in any API response, nor the dashboard or sign-in HTML', () => {
    expect(responses.length).toBeGreaterThan(25);
    for (const r of responses) expectClean(`the response to ${r.path}`, r.text);
  });

  it('the two show-once responses hold only what they show', () => {
    const [enrol, confirm, regen] = shownOnce;
    expect(enrol!.text).toContain(secrets.totp);
    expectClean('the enrolment response', enrol!.text, ['totp']);
    expectClean('the confirmation response', confirm!.text, ['recovery']);
    expectClean('the new recovery codes response', regen!.text, ['recoveryNew']);
  });

  it('not in the live stream’s events', () => {
    expect(stream.frames.length).toBeGreaterThan(5);
    expectClean('the stream', JSON.stringify(stream.frames));
  });

  it('not in the audit log or the error table', () => {
    const audit = m.stack.db.prepare('SELECT * FROM audit_log').all();
    expect(audit.length).toBeGreaterThan(10);
    expectClean('the audit log', JSON.stringify(audit));
    expectClean('the error table', JSON.stringify(m.stack.db.prepare('SELECT * FROM errors').all()));
    expectClean('the journal', JSON.stringify(m.stack.db.prepare('SELECT * FROM write_journal').all()));
    expectClean('the jobs', JSON.stringify(m.stack.db.prepare('SELECT * FROM jobs').all()));
    expectClean('the steps', JSON.stringify(m.stack.db.prepare('SELECT * FROM steps').all()));
  });

  it('not in the database files as plain text', () => {
    m.stack.db.pragma('wal_checkpoint(PASSIVE)');
    const files = [m.stack.dbPath, `${m.stack.dbPath}-wal`, `${m.stack.dbPath}-shm`].filter((f) =>
      existsSync(f),
    );
    for (const f of files) {
      const bytes = readFileSync(f);
      for (const [name, v] of needles()) {
        expect(bytes.includes(Buffer.from(v, 'utf8')), `${name} is in ${f} as plain text`).toBe(false);
      }
    }
  });
});

/**
 * OPS2: the encrypted secret store itself. AES-256-GCM with a fresh nonce per value; the row's scope and purpose as
 * associated data (a ciphertext moved to another project's row, or another purpose, does not open); a missing or wrong
 * master key reported clearly for the affected rows only; the previous key during a rotation; the rotation command with
 * its backup; and no secret in the database files as plain text.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/open.js';
import { runSecretsCli } from '../../src/secrets/cli.js';
import { SecretStore, SecretStoreError } from '../../src/secrets/store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshDb(): { db: Db; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lkb-secrets-'));
  dirs.push(dir);
  const path = join(dir, 'bridge.db');
  const db = openDatabase(path);
  runMigrations(db);
  return { db, path };
}
const master = () => randomBytes(32).toString('base64');
const secret = (label: string) => `TESTSECRET${label}-${randomBytes(16).toString('hex')}`;

describe('sealing and opening', () => {
  it('round-trips, with a new nonce for every value (the same value twice seals differently)', () => {
    const { db } = freshDb();
    const s = new SecretStore(db, { masterKey: master() });
    const v = secret('A');
    s.write('lkp_a', 'lk_api_key', v, { source: 'dashboard', hint: v.slice(-4) });
    expect(s.read('lkp_a', 'lk_api_key')).toEqual({ ok: true, value: v });
    const first = db.prepare("SELECT nonce, ciphertext FROM secrets WHERE scope = 'lkp_a'").get() as {
      nonce: Buffer;
      ciphertext: Buffer;
    };
    s.write('lkp_a', 'lk_api_key', v, { source: 'dashboard', hint: v.slice(-4) });
    const second = db.prepare("SELECT nonce, ciphertext FROM secrets WHERE scope = 'lkp_a'").get() as {
      nonce: Buffer;
      ciphertext: Buffer;
    };
    expect(second.nonce.equals(first.nonce)).toBe(false);
    expect(second.ciphertext.equals(first.ciphertext)).toBe(false);
    expect(s.meta('lkp_a', 'lk_api_key')).toMatchObject({ hint: v.slice(-4), sealedWith: 'current' });
    expect(JSON.stringify(s.list())).not.toContain(v);
  });

  it('associated data: a ciphertext copied to another project, or another purpose, does not open', () => {
    const { db } = freshDb();
    const s = new SecretStore(db, { masterKey: master() });
    const a = secret('A');
    s.write('lkp_a', 'lk_api_key', a, { source: 'dashboard' });
    s.write('lkp_b', 'lk_api_key', secret('B'), { source: 'dashboard' });
    // An attacker with write access to the database moves A's sealed key into B's row...
    db.prepare(
      `UPDATE secrets SET nonce = (SELECT nonce FROM secrets WHERE scope = 'lkp_a'),
         ciphertext = (SELECT ciphertext FROM secrets WHERE scope = 'lkp_a'),
         tag = (SELECT tag FROM secrets WHERE scope = 'lkp_a') WHERE scope = 'lkp_b'`,
    ).run();
    const moved = s.read('lkp_b', 'lk_api_key');
    expect(moved).toMatchObject({ ok: false, reason: 'damaged' });
    expect(JSON.stringify(moved)).not.toContain(a);
    // ...or into the owner's password row.
    db.prepare(
      `INSERT INTO secrets (scope, purpose, key_id, nonce, ciphertext, tag, hint, source, created_at, updated_at)
       SELECT '*', 'owner_password_hash', key_id, nonce, ciphertext, tag, NULL, source, created_at, updated_at
       FROM secrets WHERE scope = 'lkp_a'`,
    ).run();
    expect(s.read('*', 'owner_password_hash')).toMatchObject({ ok: false, reason: 'damaged' });
    // A flipped bit anywhere is caught too.
    db.prepare(
      "UPDATE secrets SET ciphertext = (substr(ciphertext, 1, 3) || X'00' || substr(ciphertext, 5)) WHERE scope = 'lkp_a'",
    ).run();
    expect(s.read('lkp_a', 'lk_api_key')).toMatchObject({ ok: false, reason: 'damaged' });
    expect(s.state().unreadable).toHaveLength(3);
  });

  it('a missing master key: nothing can be written; what is stored is reported, never thrown', () => {
    const { db } = freshDb();
    const key = master();
    new SecretStore(db, { masterKey: key }).write('lkp_a', 'lk_api_key', secret('A'), {
      source: 'dashboard',
    });
    const none = new SecretStore(db, {});
    expect(none.available).toBe(false);
    expect(none.read('lkp_a', 'lk_api_key')).toMatchObject({ ok: false, reason: 'no_master_key' });
    expect(() => none.write('lkp_b', 'lk_api_key', 'x', { source: 'dashboard' })).toThrow(SecretStoreError);
    const st = none.state();
    expect(st.problem).toMatch(
      /SECRETS_MASTER_KEY is not set .* 1 stored secret\(s\) cannot be read until then/,
    );
    // A short key counts as missing (and never stops anything).
    expect(new SecretStore(db, { masterKey: 'short' }).state().problem).toMatch(/shorter than 32/);
  });

  it('a wrong master key: those rows are named as sealed with another key; the rest of the store still works', () => {
    const { db } = freshDb();
    new SecretStore(db, { masterKey: master() }).write('lkp_a', 'lk_api_key', secret('A'), {
      source: 'dashboard',
    });
    const wrong = new SecretStore(db, { masterKey: master() });
    expect(wrong.read('lkp_a', 'lk_api_key')).toMatchObject({ ok: false, reason: 'wrong_master_key' });
    expect(wrong.state().problem).toMatch(/sealed with another master key/);
    const b = secret('B');
    wrong.write('lkp_b', 'lk_api_key', b, { source: 'dashboard' });
    expect(wrong.read('lkp_b', 'lk_api_key')).toEqual({ ok: true, value: b });
  });
});

describe('rotating the master key', () => {
  it('the previous key still opens old rows; the command backs up, then re-seals everything; a second run is harmless', async () => {
    const { db, path } = freshDb();
    const oldKey = master();
    const newKey = master();
    const old = new SecretStore(db, { masterKey: oldKey });
    const values = { a: secret('A'), owner: secret('OWNER') };
    old.write('lkp_a', 'lk_api_key', values.a, { source: 'env_import' });
    old.write('*', 'owner_password_hash', values.owner, { source: 'dashboard' });
    db.close();

    // After `env-sync.sh --rotate-master-key`: the new key, and the old one as PREVIOUS.
    const env = { SECRETS_MASTER_KEY: newKey, SECRETS_MASTER_KEY_PREVIOUS: oldKey };
    const during = openDatabase(path);
    const both = new SecretStore(during, { masterKey: newKey, previousMasterKey: oldKey });
    expect(both.read('lkp_a', 'lk_api_key')).toEqual({ ok: true, value: values.a });
    expect(both.state().underPrevious).toBe(2);
    during.close();

    const out: string[] = [];
    expect(await runSecretsCli(['rotate-master-key'], { env, dbPath: path, out: (s) => out.push(s) })).toBe(
      0,
    );
    expect(out.join('\n')).toMatch(/Backup taken first: .*pre-rotation-.*\.db/);
    expect(out.join('\n')).toMatch(/Re-encrypted 2 secret\(s\)/);
    for (const v of [...Object.values(values), oldKey, newKey]) expect(out.join('\n')).not.toContain(v);
    const backups = readdirSync(join(path, '..', 'backups'));
    expect(backups).toHaveLength(1);

    const after = openDatabase(path);
    const onlyNew = new SecretStore(after, { masterKey: newKey });
    expect(onlyNew.read('lkp_a', 'lk_api_key')).toEqual({ ok: true, value: values.a });
    expect(onlyNew.read('*', 'owner_password_hash')).toEqual({ ok: true, value: values.owner });
    expect(onlyNew.state().problem).toBeNull();
    // The old key no longer opens anything in the live database...
    expect(new SecretStore(after, { masterKey: oldKey }).read('lkp_a', 'lk_api_key')).toMatchObject({
      reason: 'wrong_master_key',
    });
    after.close();
    // ...but the backup is the old state, sealed with the old key.
    const bak = openDatabase(join(path, '..', 'backups', backups[0]!));
    expect(new SecretStore(bak, { masterKey: oldKey }).read('lkp_a', 'lk_api_key')).toEqual({
      ok: true,
      value: values.a,
    });
    bak.close();

    const again: string[] = [];
    expect(await runSecretsCli(['rotate-master-key'], { env, dbPath: path, out: (s) => again.push(s) })).toBe(
      0,
    );
    expect(again.join('\n')).toMatch(
      /Re-encrypted 0 secret\(s\) with the new master key \(2 already used it\)/,
    );
  });

  it('refuses, changing nothing, when a row opens with neither key, or while the bridge runs', async () => {
    const { db, path } = freshDb();
    const a = master();
    new SecretStore(db, { masterKey: master() }).write('lkp_x', 'lk_api_key', secret('X'), {
      source: 'dashboard',
    });
    const before = db.prepare('SELECT * FROM secrets').all();
    expect(() => new SecretStore(db, { masterKey: a, previousMasterKey: master() }).rotate()).toThrow(
      /opens with neither SECRETS_MASTER_KEY nor SECRETS_MASTER_KEY_PREVIOUS/,
    );
    expect(db.prepare('SELECT * FROM secrets').all()).toEqual(before);
    expect(() => new SecretStore(db, { masterKey: a }).rotate()).toThrow(
      /SECRETS_MASTER_KEY_PREVIOUS is not set/,
    );
    db.prepare(
      "INSERT INTO bridge_instance (slot, instance_id, pid, hostname, started_at, heartbeat_at) VALUES (1, 'i', 1, 'h', ?, ?)",
    ).run(Date.now(), Date.now());
    db.close();
    const out: string[] = [];
    const code = await runSecretsCli(['rotate-master-key'], {
      env: { SECRETS_MASTER_KEY: a, SECRETS_MASTER_KEY_PREVIOUS: master() },
      dbPath: path,
      out: (s) => out.push(s),
    });
    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(/The bridge is running on this database. Stop it first/);
    expect(existsSync(join(path, '..', 'backups'))).toBe(false);
  });

  it('`status` lists what is stored by name, hint and key, never a value', async () => {
    const { db, path } = freshDb();
    const key = master();
    const v = secret('A');
    db.prepare(
      "INSERT INTO projects (id, name, is_default, created_at, updated_at) VALUES ('lkp_a', 'alpha', 1, 0, 0)",
    ).run();
    new SecretStore(db, { masterKey: key }).write('lkp_a', 'lk_api_key', v, {
      source: 'dashboard',
      hint: v.slice(-4),
    });
    db.close();
    const out: string[] = [];
    expect(
      await runSecretsCli(['status'], {
        env: { SECRETS_MASTER_KEY: key },
        dbPath: path,
        out: (s) => out.push(s),
      }),
    ).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(
      /project alpha: lk_api_key \(ends .{4}\), set on the dashboard, sealed with the current master key/,
    );
    expect(text).not.toContain(v);
    expect(text).not.toContain(key);
  });
});

describe('at rest', () => {
  it('no secret appears in the database files as plain text (the file, its WAL and shared memory)', () => {
    const { db, path } = freshDb();
    const s = new SecretStore(db, { masterKey: master() });
    const values = [
      secret('KEY1'),
      secret('KEY2'),
      `$argon2id$v=19$m=65536,t=3,p=4$${secret('SALT')}`,
      'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    ];
    s.write('lkp_1', 'lk_api_key', values[0]!, { source: 'dashboard', hint: values[0]!.slice(-4) });
    s.write('lkp_2', 'lk_api_key', values[1]!, { source: 'env_import', hint: values[1]!.slice(-4) });
    s.write('*', 'owner_password_hash', values[2]!, { source: 'dashboard' });
    s.write('*', 'owner_totp_secret', values[3]!, { source: 'dashboard' });
    s.recordImport('LK_PROJECT_TWO_API_KEY', 'lkp_2', 'lk_api_key', values[1]!);
    s.write('lkp_1', 'lk_api_key', secret('KEY3'), { source: 'dashboard' }); // a replaced value leaves no trace either
    const files = [path, `${path}-wal`, `${path}-shm`].filter((f) => existsSync(f));
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      const bytes = readFileSync(f);
      for (const v of values) {
        expect(bytes.includes(Buffer.from(v, 'utf8')), `${v.slice(0, 12)}… in ${f}`).toBe(false);
      }
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
    const bytes = readFileSync(path);
    for (const v of values) expect(bytes.includes(Buffer.from(v, 'utf8'))).toBe(false);
  });
});

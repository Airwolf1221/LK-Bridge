/**
 * v2 E1b (ADR 0043): the off-site runner with the fake rclone (test/offsite/fake-rclone.mjs) and a mock Google. Nothing
 * reaches Google or Drive. The temporary config (0600, removed after success and after a crash), the order (objects,
 * then manifests, then the database copies), `--backup-dir` and the purge after the retention, a refresh token rclone
 * renewed being kept, the status recorded, rclone missing or too old refused, the schedule and the requests.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeRequest } from '../../src/offsite/requests.js';
import { OFFSITE_SCOPE } from '../../src/secrets/store.js';
import { FOLDER, makeWorld, PASSWORD, SALT, type World } from './world.js';

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});
afterEach(async () => {
  await w.close();
});

const tmpLeft = () => readdirSync(w.tmpRoot);
const dataCalls = () => w.calls().filter((c) => ['copy', 'sync', 'copyto'].includes(c.cmd));

describe('a copy', () => {
  it('writes a 0600 config with a drive.file remote and a crypt remote, copies in order, records the run, removes the config', async () => {
    const runner = w.runner();
    const id = await runner.copy('request');
    const run = w.store.run(id)!;
    expect(run.message).toMatch(/Copied/);
    expect(run.state).toBe('succeeded');
    expect(run.exitCode).toBe(0);
    expect(run.files).toBeGreaterThanOrEqual(6); // 3 objects, 1 manifest, STORE.json, 2 database copies
    expect(run.bytes).toBeGreaterThan(0);
    expect(run.rcloneVersion).toBe('1.60.1');
    expect(run.endedAt).not.toBeNull();
    // The order: new objects, then manifests, then the removed objects, the marker, then the database copies.
    const steps = dataCalls().map((c) => `${c.cmd} ${c.argv[2]}`);
    expect(steps).toEqual([
      'copy lkcrypt:store/objects',
      'sync lkcrypt:store/manifests',
      'sync lkcrypt:store/objects',
      'copyto lkcrypt:store/STORE.json',
      'sync lkcrypt:database',
    ]);
    // Every call saw the config, private, with the drive.file remote and the crypt remote (names encrypted too).
    for (const c of w.calls().filter((x) => x.config)) {
      expect(c.configExists).toBe(true);
      expect(c.configMode).toBe('600');
    }
    const c = dataCalls()[0]!;
    expect(c.drive).toMatchObject({ type: 'drive', scope: 'drive.file' });
    expect(c.drive!.client_id).toMatch(/apps\.googleusercontent\.com$/);
    expect(c.crypt).toMatchObject({
      type: 'crypt',
      remote: `lkdrive:${FOLDER}`,
      filename_encryption: 'standard',
      directory_name_encryption: 'true',
    });
    // The keys reach rclone obscured (by rclone itself, through standard input), never in plain and never as arguments.
    expect(c.crypt!.password).toMatch(/^OBSC_/);
    expect(c.crypt!.password).not.toContain(PASSWORD);
    for (const call of w.calls()) {
      expect(call.argv.join(' ')).not.toContain(PASSWORD);
      expect(call.argv.join(' ')).not.toContain(SALT);
    }
    // The config is gone, with its directory.
    expect(existsSync(c.config!)).toBe(false);
    expect(tmpLeft()).toEqual([]);
    // On "Drive": the store and the database copies.
    for (const sha of w.objects)
      expect(existsSync(join(w.remote, 'store/objects', sha.slice(0, 2), `${sha}.gz`))).toBe(true);
    expect(readdirSync(join(w.remote, 'store/manifests/proj_test'))).toHaveLength(1);
    expect(existsSync(join(w.remote, 'store/STORE.json'))).toBe(true);
    expect(readdirSync(join(w.remote, 'database')).sort()).toEqual([
      'nightly-20261112T041500Z.db.gz',
      'nightly-20261113T041500Z.db.gz',
    ]);
    expect(w.store.folder(1)!.lastGoodCopyAt).not.toBeNull();
  });

  it('E4 (backlog 3): takes a fresh database copy first, and carries it to Drive beside the nightly ones', async () => {
    const order: string[] = [];
    const runner = w.runner({
      takeDatabaseCopy: () => {
        order.push(`database-copy (${w.calls().length} rclone calls before it)`);
        // What deploy/backup.sh offsite writes.
        writeFileSync(
          join(w.backupDir, 'offsite-20261115T060000Z.db.gz'),
          gzipSync(Buffer.from('a database')),
          {
            mode: 0o600,
          },
        );
        return Promise.resolve('Backup written: offsite-20261115T060000Z.db.gz');
      },
    });
    const id = await runner.copy('request');
    const run = w.store.run(id)!;
    expect(run.state).toBe('succeeded');
    expect(order).toEqual(['database-copy (0 rclone calls before it)']);
    expect((run.detail as { steps: { name: string }[] }).steps[0]).toMatchObject({
      name: 'database-copy',
      code: 0,
    });
    expect(readdirSync(join(w.remote, 'database')).sort()).toEqual([
      'nightly-20261112T041500Z.db.gz',
      'nightly-20261113T041500Z.db.gz',
      'offsite-20261115T060000Z.db.gz',
    ]);
  });

  it('E4: a database copy that cannot be taken does not stop the copy of the store, and the run says so', async () => {
    const runner = w.runner({
      takeDatabaseCopy: () => Promise.reject(new Error('sqlite3 is not installed')),
    });
    const id = await runner.copy('request');
    const run = w.store.run(id)!;
    expect(run.state).toBe('succeeded');
    expect(run.message).toMatch(/fresh database copy could not be taken \(sqlite3 is not installed\)/);
    expect(existsSync(join(w.remote, 'store/STORE.json'))).toBe(true);
  });

  it('copies only manifests older than the run (--min-age), and moves removed pieces into deleted/<date> (--backup-dir)', async () => {
    await w.runner().copy('request');
    const manifestStep = dataCalls().find((c) => c.argv[2] === 'lkcrypt:store/manifests')!;
    expect(manifestStep.argv).toContain('--min-age');
    expect(manifestStep.argv).toContain('--backup-dir');
    // E1a's clean-up removes a manifest and its object locally; a new manifest is written during... before the next run.
    rmSync(join(w.snapshotDir, 'manifests/proj_test/20261112T003000Z-full-a1b2c3.json.gz'));
    const gone = w.objects[0]!;
    rmSync(join(w.snapshotDir, 'objects', gone.slice(0, 2), `${gone}.gz`));
    w.addManifest('20261113T003000Z-full-d4e5f6', w.objects.slice(1));
    // A manifest written just now (after the run starts, as far as --min-age is concerned) waits for the next run.
    w.addManifest('20261113T010000Z-change-0a0b0c', w.objects.slice(1), 0);
    w.clearCalls();
    const id = await w.runner().copy('schedule');
    expect(w.store.run(id)!.state).toBe('succeeded');
    const day = new Date().toISOString().slice(0, 10);
    expect(
      existsSync(
        join(w.remote, 'deleted', day, 'store/manifests/proj_test/20261112T003000Z-full-a1b2c3.json.gz'),
      ),
    ).toBe(true);
    expect(existsSync(join(w.remote, 'deleted', day, 'store/objects', gone.slice(0, 2), `${gone}.gz`))).toBe(
      true,
    );
    expect(existsSync(join(w.remote, 'store/objects', gone.slice(0, 2), `${gone}.gz`))).toBe(false);
    const remoteManifests = readdirSync(join(w.remote, 'store/manifests/proj_test'));
    expect(remoteManifests).toEqual(['20261113T003000Z-full-d4e5f6.json.gz']);
    for (const c of dataCalls().filter((x) => x.cmd === 'sync')) {
      const i = c.argv.indexOf('--backup-dir');
      expect(c.argv[i + 1]).toMatch(new RegExp(`^lkcrypt:deleted/${day}/`));
    }
  });

  it('purges deleted/<date> folders older than the retention, and keeps newer ones', async () => {
    await w.runner().copy('request');
    w.clearCalls();
    mkdirSync(join(w.remote, 'deleted/2020-01-01/store'), { recursive: true });
    writeFileSync(join(w.remote, 'deleted/2020-01-01/store/x'), 'old');
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    mkdirSync(join(w.remote, 'deleted', recent), { recursive: true });
    writeFileSync(join(w.remote, 'deleted', recent, 'y'), 'recent');
    const id = await w.runner().copy('request');
    const run = w.store.run(id)!;
    expect(run.state).toBe('succeeded');
    expect(existsSync(join(w.remote, 'deleted/2020-01-01'))).toBe(false);
    expect(existsSync(join(w.remote, 'deleted', recent))).toBe(true);
    expect((run.detail as { purged: string[] }).purged).toEqual(['2020-01-01']);
    const purge = w.calls().find((c) => c.cmd === 'purge')!;
    expect(purge.argv).toContain('--drive-use-trash=false');
  });

  it('keeps a refresh token rclone renewed during the run', async () => {
    w.env.FAKE_RCLONE_NEW_REFRESH = '1//renewed-by-rclone-0123456789';
    const id = await w.runner().copy('request');
    expect(w.store.run(id)!.state).toBe('succeeded');
    const t = w.secrets.read(OFFSITE_SCOPE, 'drive_refresh_token');
    expect(t.ok && t.value).toBe('1//renewed-by-rclone-0123456789');
  });

  it('keeps a refresh token Google rotated at the runner’s own refresh', async () => {
    const before = w.secrets.read(OFFSITE_SCOPE, 'drive_refresh_token');
    w.google.rotateOnRefresh = true;
    await w.runner().copy('request');
    const after = w.secrets.read(OFFSITE_SCOPE, 'drive_refresh_token');
    expect(before.ok && after.ok && after.value !== before.value).toBe(true);
  });

  it('a crash of rclone fails the run, stops before the manifests, and still removes the config', async () => {
    w.env.FAKE_RCLONE_CRASH_ON = 'store/manifests';
    const id = await w.runner().copy('request');
    const run = w.store.run(id)!;
    expect(run.state).toBe('failed');
    expect(run.message).toMatch(/manifests failed/);
    expect(existsSync(join(w.remote, 'store/manifests'))).toBe(false);
    expect(dataCalls().map((c) => c.argv[2])).toEqual(['lkcrypt:store/objects', 'lkcrypt:store/manifests']);
    expect(tmpLeft()).toEqual([]);
    expect(existsSync(w.calls()[0]!.config ?? '/nonexistent')).toBe(false);
  });

  it('a failed objects step copies no manifest (a manifest on Drive always has its objects)', async () => {
    w.env.FAKE_RCLONE_FAIL_ON = 'lkcrypt:store/objects --config';
    const id = await w.runner().copy('request');
    expect(w.store.run(id)!.state).toBe('failed');
    expect(w.store.run(id)!.exitCode).toBe(1);
    expect(dataCalls().map((c) => c.argv[2])).toEqual(['lkcrypt:store/objects']);
    expect(tmpLeft()).toEqual([]);
  });

  it('an error inside the run after the config is written still removes it', async () => {
    let seen = '';
    const id = await w
      .runner({
        onConfig: (p) => {
          seen = p;
          expect(statSync(p).mode & 0o777).toBe(0o600);
          expect(statSync(join(p, '..')).mode & 0o777).toBe(0o700);
          throw new Error('boom after the config');
        },
      })
      .copy('request');
    expect(w.store.run(id)!.state).toBe('failed');
    expect(seen).not.toBe('');
    expect(existsSync(seen)).toBe(false);
    expect(tmpLeft()).toEqual([]);
  });

  it('refuses when rclone is missing, or older than 1.60, with a clear message', async () => {
    const missing = await w.runner({ rcloneBin: join(w.dir, 'no-such-rclone') }).copy('request');
    expect(w.store.run(missing)!.state).toBe('refused');
    expect(w.store.run(missing)!.message).toMatch(/rclone is not installed/);
    w.env.FAKE_RCLONE_VERSION = '1.59.2';
    const old = await w.runner().copy('request');
    expect(w.store.run(old)!.state).toBe('refused');
    expect(w.store.run(old)!.message).toMatch(
      /rclone 1\.59\.2 is too old: the off-site copy needs 1\.60\.0 or newer/,
    );
    expect(dataCalls()).toEqual([]);
    expect(tmpLeft()).toEqual([]);
  });

  it('invalid_grant at the refresh refuses the run and turns the connection red', async () => {
    w.google.expireAll();
    const id = await w.runner().copy('schedule');
    expect(w.store.run(id)!.state).toBe('refused');
    expect(w.store.run(id)!.message).toMatch(/invalid_grant/);
    expect(w.store.state().connection).toBe('broken');
    expect(dataCalls()).toEqual([]);
  });

  it('refuses to mirror an empty store, and a folder holding a copy this database did not make (until adopted)', async () => {
    mkdirSync(join(w.remote, 'store'), { recursive: true });
    writeFileSync(join(w.remote, 'store', 'someone-else'), 'x');
    const id = await w.runner().copy('request');
    expect(w.store.run(id)!.state).toBe('refused');
    expect(w.store.run(id)!.message).toMatch(/already holds a copy this database did not make/);
    w.store.markAdopted(1);
    expect(w.store.run(await w.runner().copy('request'))!.state).toBe('succeeded');
    rmSync(join(w.snapshotDir, 'manifests'), { recursive: true });
    mkdirSync(join(w.snapshotDir, 'manifests'));
    const empty = await w.runner().copy('request');
    expect(w.store.run(empty)!.message).toMatch(/holds no manifests/);
  });

  it('gives rclone a minimal environment: never SECRETS_MASTER_KEY', async () => {
    process.env.SECRETS_MASTER_KEY = 'TESTMASTER-should-not-reach-rclone-000000';
    try {
      await w.runner().copy('request');
    } finally {
      delete process.env.SECRETS_MASTER_KEY;
    }
    for (const c of w.calls()) expect(c.envNames).toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR']);
  });

  it('passes the bandwidth limit and the transfer count from the settings', async () => {
    w.store.saveSettingsJson(JSON.stringify({ bandwidthLimit: '2M', transfers: 2 }));
    await w.runner().copy('request');
    const c = dataCalls()[0]!;
    expect(c.argv.join(' ')).toMatch(/--transfers 2/);
    expect(c.argv.join(' ')).toMatch(/--bwlimit 2M/);
    expect(c.argv).toContain('--fast-list');
  });
});

describe('the timer and the requests', () => {
  it('does nothing (and records nothing) when the copy is not set up', async () => {
    await w.close();
    w = await makeWorld({ configured: false });
    await writeRequest(w.requestDir, { kind: 'copy', trigger: 'request' });
    const r = await w.runner().tick();
    expect(r.did).toEqual([]);
    expect(w.store.runs()).toEqual([]);
    expect(readdirSync(w.requestDir)).toEqual([]); // consumed
  });

  it('copies when the daily time has passed, once, and again on a request', async () => {
    const r1 = await w.runner().tick();
    expect(r1.did).toContain('copy'); // no copy since today's (or yesterday's) 04:45
    const r2 = await w.runner().tick();
    expect(r2.did).not.toContain('copy');
    await writeRequest(w.requestDir, { kind: 'copy', trigger: 'after_full' });
    const r3 = await w.runner().tick();
    expect(r3.did).toContain('copy');
    expect(w.store.runs({ kind: 'copy' })[0]!.trigger).toBe('after_full');
    expect(readdirSync(w.requestDir)).toEqual([]);
  });

  it('verifies on request, and monthly once a copy exists', async () => {
    await w.runner().tick(); // copy, then the monthly verify is due (none yet this month)
    expect(w.store.runs({ kind: 'verify' })).toHaveLength(1);
    await w.runner().tick();
    expect(w.store.runs({ kind: 'verify' })).toHaveLength(1);
    await writeRequest(w.requestDir, { kind: 'verify', trigger: 'request' });
    await w.runner().tick();
    expect(w.store.runs({ kind: 'verify' })).toHaveLength(2);
  });

  it('marks a run left "running" by a dead process as interrupted', async () => {
    const id = w.store.startRun({ kind: 'copy', trigger: 'schedule', pid: 2 ** 22 + 12345 });
    await w.runner().tick();
    expect(w.store.run(id)!.state).toBe('interrupted');
  });

  it('deletes an old folder on request, to Drive’s bin, never the current one', async () => {
    await w.runner().copy('request');
    w.store.newGenerationIfCopied('LK-Bridge backups/lk.example.test', 'the encryption keys changed');
    await writeRequest(w.requestDir, { kind: 'delete_folder', trigger: 'request', generation: 1 });
    await w.runner().tick();
    expect(existsSync(w.remote)).toBe(false);
    expect(w.store.folder(1)!.deletedAt).not.toBeNull();
    const purge = w.calls().find((c) => c.cmd === 'purge')!;
    expect(purge.argv[1]).toBe(`lkdrive:${FOLDER}`);
    expect(purge.argv).not.toContain('--drive-use-trash=false');
    const refused = await w.runner().deleteFolder(2);
    expect(w.store.run(refused)!.state).toBe('refused');
  });
});

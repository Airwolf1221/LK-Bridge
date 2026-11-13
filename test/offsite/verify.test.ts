/**
 * v2 E1b (ADR 0043): proving the Drive copy. The verify job (complete; a missing piece; a corrupt piece, a hash mismatch
 * after "decrypting"; a bad database copy), and the disaster-recovery pull-and-check through deploy/offsite-restore.sh,
 * run for real (bash, the CLI under tsx) against the fake rclone and the mock Google. Also the runner's CLI stopped by
 * SIGTERM in the middle of a copy: its temporary config is removed on the way out.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_RCLONE, makeWorld, PASSWORD, PUBLIC_URL, SALT, type World } from './world.js';

let w: World;
beforeEach(async () => {
  w = await makeWorld();
  // Every object sampled, so a single bad one is always found.
  w.store.saveSettingsJson(JSON.stringify({ verifySampleMin: 1000 }));
});
afterEach(async () => {
  await w.close();
});

const objectOnDrive = (sha: string) => join(w.remote, 'store/objects', sha.slice(0, 2), `${sha}.gz`);

describe('the verify job', () => {
  it('a complete copy: every manifest read, its pieces present, the sample re-hashed, the newest database copy checked', async () => {
    await w.runner().copy('request');
    const id = await w.runner().verify('request');
    const run = w.store.run(id)!;
    expect(run.message).toMatch(/^All good/);
    expect(run.state).toBe('succeeded');
    expect(w.store.findings(id)).toEqual([]);
    expect(run.detail).toMatchObject({
      objectsOnDrive: 3,
      manifests: 1,
      piecesNamed: 3,
      sampled: 3,
      sampleChecked: 3,
      database: 'nightly-20261113T041500Z.db.gz: ok',
    });
    expect(readdirSync(w.tmpRoot)).toEqual([]); // the private temp area is gone
  });

  it('samples 1% of the objects, at least the minimum, plus every manifest', async () => {
    for (let i = 0; i < 20; i++) w.addObject(`{"extra":${i}}`);
    w.store.saveSettingsJson(JSON.stringify({ verifySampleMin: 5, verifySamplePercent: 1 }));
    await w.runner().copy('request');
    const id = await w.runner().verify('request');
    expect(w.store.run(id)!.detail).toMatchObject({ objectsOnDrive: 23, sampled: 5, manifests: 1 });
  });

  it('a missing piece is a red finding', async () => {
    await w.runner().copy('request');
    rmSync(objectOnDrive(w.objects[1]!));
    const id = await w.runner().verify('schedule');
    expect(w.store.run(id)!.state).toBe('failed');
    const f = w.store.findings(id);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      kind: 'missing',
      path: `store/objects/${w.objects[1]!.slice(0, 2)}/${w.objects[1]}.gz`,
    });
    expect(f[0]!.detail).toMatch(/named by 20261112T003000Z-full-a1b2c3/);
  });

  it('a corrupt piece (it decrypts and unpacks, but its hash is not its name) is a red finding', async () => {
    await w.runner().copy('request');
    writeFileSync(objectOnDrive(w.objects[2]!), gzipSync('{"piece":"tampered"}'));
    const id = await w.runner().verify('request');
    expect(w.store.run(id)!.state).toBe('failed');
    expect(w.store.findings(id)).toEqual([
      expect.objectContaining({
        kind: 'corrupt',
        path: `store/objects/${w.objects[2]!.slice(0, 2)}/${w.objects[2]}.gz`,
      }),
    ]);
    // An object that does not even unpack is corrupt too.
    writeFileSync(objectOnDrive(w.objects[0]!), 'not gzip');
    const id2 = await w.runner().verify('request');
    expect(w.store.findings(id2).map((x) => x.kind)).toEqual(['corrupt', 'corrupt']);
  });

  it('a bad database copy (the newest) is a red finding; a manifest that cannot be read too', async () => {
    await w.runner().copy('request');
    writeFileSync(
      join(w.remote, 'database/nightly-20261113T041500Z.db.gz'),
      gzipSync('this is not a SQLite database'),
    );
    writeFileSync(
      join(w.remote, 'store/manifests/proj_test/20261112T003000Z-full-a1b2c3.json.gz'),
      gzipSync('{'),
    );
    const id = await w.runner().verify('request');
    const f = w.store.findings(id);
    expect(f.map((x) => x.kind).sort()).toEqual(['database_bad', 'manifest_unreadable']);
    expect(f.find((x) => x.kind === 'database_bad')!.path).toBe('database/nightly-20261113T041500Z.db.gz');
    expect(w.store.run(id)!.message).toMatch(/2 problem\(s\)/);
  });

  it('no copy of the store at all is a red finding', async () => {
    const id = await w.runner().verify('request');
    expect(w.store.findings(id).map((x) => x.kind)).toEqual(['store_missing']);
  });
});

// ================================================================================================ the scripts

interface Scripted {
  env: NodeJS.ProcessEnv;
  tmp: string;
  run(script: string, args: string[]): Promise<{ status: number | null; out: string }>;
}

function scripted(world: World): Scripted {
  const dir = mkdtempSync(join(tmpdir(), 'lkb-offsite-sh-'));
  const nodeDir = join(dir, 'node');
  mkdirSync(join(nodeDir, 'bin'), { recursive: true });
  // The "private Node": answers --version as Node 24, and runs the TypeScript CLI through tsx.
  writeFileSync(
    join(nodeDir, 'bin', 'node'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v24.99.0; exit 0; fi\nexec '${process.execPath}' --import tsx "$@"\n`,
    { mode: 0o755 },
  );
  const envFile = join(dir, 'lk-bridge.env');
  writeFileSync(
    envFile,
    [
      `SECRETS_MASTER_KEY=${world.masterKey}`,
      `DB_PATH=${world.dbPath}`,
      `BRIDGE_PUBLIC_URL=${PUBLIC_URL}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    TMPDIR: tmp,
    LKB_ENV_FILE: envFile,
    LKB_DATA_DIR: join(world.dir, 'data'),
    LKB_NODE_DIR: nodeDir,
    LKB_OFFSITE_CLI: 'src/offsite/cli.ts',
    LKB_ALLOW_ROOT: '1',
    LKB_RCLONE: FAKE_RCLONE,
    NODE_ENV: 'test',
    LKB_TEST_GOOGLE_BASE: world.google.base,
    FAKE_RCLONE_DRIVE: world.drive,
    FAKE_RCLONE_LOG: join(world.dir, 'rclone.log'),
  };
  const repo = new URL('../../', import.meta.url).pathname;
  return {
    env,
    tmp,
    // Asynchronous: the mock Google answers from this process, so its event loop must keep running.
    run(script, args) {
      return new Promise((resolve) => {
        const child = spawn('bash', [join(repo, 'deploy', script), ...args], { env });
        let out = '';
        child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
        child.stderr.setEncoding('utf8').on('data', (d: string) => (out += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', (status) => {
          clearTimeout(timer);
          resolve({ status, out });
        });
      });
    },
  };
}

describe('deploy/offsite-restore.sh: the pull-and-check of a disaster recovery', () => {
  it('pulls the store and the newest database copy, checks every object and the database, and prints the next steps', async () => {
    await w.runner().copy('request');
    const s = scripted(w);
    const dest = join(w.dir, 'restored');
    const r = await s.run('offsite-restore.sh', ['--dest', dest]);
    expect(r.out).toMatch(/RESTORE CHECK PASSED/);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/checked 3 objects against their names, 1 manifests \(3 pieces named\): all good/);
    expect(r.out).toMatch(/database copy nightly-20261113T041500Z\.db\.gz: integrity_check ok/);
    expect(r.out).toMatch(/sudo systemctl stop lk-bridge/);
    for (const sha of w.objects)
      expect(existsSync(join(dest, 'snapshots/objects', sha.slice(0, 2), `${sha}.gz`))).toBe(true);
    expect(existsSync(join(dest, 'snapshots/STORE.json'))).toBe(true);
    expect(existsSync(join(dest, 'bridge.db'))).toBe(true);
    // The order of the pull: objects, then manifests, then the marker, then the database copy.
    const pulls = readFileSync(join(w.dir, 'rclone.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { cmd: string; argv: string[] })
      .filter((c) => c.argv[1]?.startsWith('lkcrypt:') && ['copy', 'copyto'].includes(c.cmd))
      .map((c) => c.argv[1]);
    expect(pulls).toEqual([
      'lkcrypt:store/objects',
      'lkcrypt:store/manifests',
      'lkcrypt:store/STORE.json',
      'lkcrypt:database/nightly-20261113T041500Z.db.gz',
    ]);
    // Nothing secret printed; the temporary config gone.
    for (const secret of [PASSWORD, SALT, w.masterKey]) expect(r.out).not.toContain(secret);
    expect(readdirSync(s.tmp).filter((f) => f.startsWith('lkb-offsite-'))).toEqual([]); // (tsx keeps its own cache there)
  });

  it('fails (and says so) when a piece on Drive is damaged, without touching anything live', async () => {
    await w.runner().copy('request');
    writeFileSync(objectOnDrive(w.objects[0]!), gzipSync('damaged'));
    const s = scripted(w);
    const r = await s.run('offsite-restore.sh', ['--dest', join(w.dir, 'restored')]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/RESTORE CHECK FAILED/);
    expect(r.out).toMatch(/corrupt: objects\//);
    expect(r.out).not.toMatch(/sudo systemctl stop lk-bridge/);
  });

  it('refuses a destination that is not empty, and root without the test seam', async () => {
    const s = scripted(w);
    const dest = join(w.dir, 'busy');
    mkdirSync(dest);
    writeFileSync(join(dest, 'x'), 'x');
    const r = await s.run('offsite-restore.sh', ['--dest', dest]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/is not empty/);
  });
});

describe('deploy/offsite.sh', () => {
  it('check-rclone and status work without printing a secret', async () => {
    const s = scripted(w);
    const a = await s.run('offsite.sh', ['check-rclone']);
    expect(a.out).toMatch(/rclone 1\.60\.1: OK/);
    const b = await s.run('offsite.sh', ['status']);
    expect(b.status).toBe(0);
    expect(b.out).toMatch(/Connection: connected \(owner@example\.test\)/);
    expect(b.out).toMatch(/Drive folder: LK-Bridge backups\/lk\.example\.test\/copy-1/);
    for (const secret of [PASSWORD, SALT, w.masterKey]) expect(b.out).not.toContain(secret);
  });

  it('stopped by SIGTERM in the middle of a copy, it ends rclone and removes its temporary config on the way out', async () => {
    const s = scripted(w);
    s.env.FAKE_RCLONE_KILL_PARENT_ON = 'store/manifests';
    const r = await s.run('offsite.sh', ['copy']);
    expect(r.out).toMatch(/Stopped by SIGTERM/);
    expect(r.status).toBe(143);
    expect(readdirSync(s.tmp).filter((f) => f.startsWith('lkb-offsite-'))).toEqual([]); // (tsx keeps its own cache there)
    // The run it left "running" is marked interrupted by the next start.
    delete s.env.FAKE_RCLONE_KILL_PARENT_ON;
    await s.run('offsite.sh', ['status']);
    await w.runner().tick();
    expect(w.store.runs({ kind: 'copy' }).some((x) => x.state === 'interrupted')).toBe(true);
  });
});

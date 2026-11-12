/**
 * The image directory (ADR 0041, the owner's sandbox run of 12 November 2026): the runtime derives the default
 * directory from the database it was actually given, never from the config's working-directory-relative default
 * (`./data/bridge.db`), and creates nothing at construction: `upload-tmp/` appears with the first binary upload and
 * `kept-bytes/` with the first file kept, so a runtime that handles neither touches no folder at all.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { databaseFile, openDatabase } from '../../src/db/open.js';
import { imageDataDir } from '../../src/images/service.js';
import { DEFAULT_IMAGE_SETTINGS } from '../../src/config/index.js';
import { startStack, type Stack } from '../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from './world.js';

let stack: Stack | undefined;
let w: ImagesWorld | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await stack?.close();
  await w?.close();
  stack = undefined;
  w = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('where the image directory is', () => {
  it('is next to the database the runtime was GIVEN, whatever the config’s DB_PATH says', async () => {
    // `startStack` is the real boot path with default tool settings (`images.dataDir: null`) and a config whose DB_PATH
    // is its default, `./data/bridge.db`, relative to the working directory: the owner's case.
    stack = await startStack();
    const images = stack.runtime.images;
    expect(stack.runtime.config.server.dbPath).toBe('./data/bridge.db');
    expect(images.dir).toBe(join(dirname(stack.dbPath), 'images'));
    expect(images.slots.dir).toBe(join(images.dir, 'upload-tmp'));
    expect(images.bytes.dir).toBe(join(images.dir, 'kept-bytes'));
    // and nowhere under the working directory
    expect(images.dir.startsWith(process.cwd())).toBe(false);
  });

  it('follows a database at another path, and an explicit IMAGE_DATA_DIR still wins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lkb-dbdir-'));
    dirs.push(dir);
    const dbPath = join(dir, 'nested', 'x.db');
    stack = await startStack({ dbPath });
    expect(stack.runtime.images.dir).toBe(join(dir, 'nested', 'images'));
    expect(databaseFile(stack.db)).toBe(dbPath);
    // the pure function: an explicit directory first; an in-memory database gets a temporary directory, never the cwd
    expect(imageDataDir({ ...DEFAULT_IMAGE_SETTINGS, dataDir: join(dir, 'elsewhere') }, dbPath)).toBe(
      join(dir, 'elsewhere'),
    );
    const mem = imageDataDir(DEFAULT_IMAGE_SETTINGS, ':memory:');
    expect(mem.startsWith(tmpdir())).toBe(true);
    const memDb = openDatabase(':memory:');
    expect(databaseFile(memDb)).toBeNull();
    memDb.close();
  });
});

describe('nothing is created until it is needed', () => {
  it('construction and start-up create no image folder at all', async () => {
    stack = await startStack();
    const images = stack.runtime.images;
    expect(existsSync(images.dir)).toBe(false);
    expect(existsSync(images.slots.dir)).toBe(false);
    expect(existsSync(images.bytes.dir)).toBe(false);
    // a sweep with no directory is a quiet no-op, as is the start-up clean
    await images.sweep();
    expect(images.slots.cleanAtStart()).toBe(0);
    expect(existsSync(images.dir)).toBe(false);
  });

  it('upload-tmp is created, private (0700), by the first binary upload', async () => {
    w = await imagesWorld();
    const tmp = join(w.dataDir, 'upload-tmp');
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(join(w.dataDir, 'kept-bytes'))).toBe(false);
    const file = fixture('orientation-6.jpg');
    const sha = createHash('sha256').update(file).digest('hex');
    const c = await w.stack.connect();
    const p = await w.stack.call(c, 'prepare_image_upload', {
      project: 'test',
      sha256: sha,
      byte_length: file.length,
      content_type: 'image/jpeg',
      name: 'x.jpg',
    });
    expect(p.isError, JSON.stringify(p.body)).toBe(false);
    // preparing alone makes no folder either
    expect(existsSync(tmp)).toBe(false);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        new URL(`/uploads/${String(p.body.upload_id)}`, w!.stack.base),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(file.length),
            authorization: `Upload ${String(p.body.capability)}`,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(file);
    });
    expect(status).toBe(201);
    expect(statSync(tmp).mode & 0o777).toBe(0o700);
  });

  it('kept-bytes is created, private (0700), by the first file kept', async () => {
    w = await imagesWorld();
    const kept = w.stack.runtime.images.bytes;
    expect(existsSync(kept.dir)).toBe(false);
    expect(await kept.get('0'.repeat(64))).toBeNull(); // reading a missing one is not an error
    expect(existsSync(kept.dir)).toBe(false);
    const sha = await kept.put(Buffer.from('some image bytes'));
    expect(existsSync(kept.dir)).toBe(true);
    expect(statSync(kept.dir).mode & 0o777).toBe(0o700);
    expect((await kept.get(sha))?.toString()).toBe('some image bytes');
  });
});

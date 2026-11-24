/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- parsed JSON tool results; the test world's `call` */
/**
 * v3 F7c (ADR 0075, Z2): safe unpacking, against the mock world (nothing live): a mixed zip gives the right status for
 * every row; ratio bombs (one entry, and the whole archive); the entry and size caps; traversal names never written
 * anywhere; a ZIP64 archive; an unreadable zip; a slot prepared for a zip takes only a zip.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imagesWorld, type ImagesWorld } from '../images/world.js';
import { listArchive } from '../../src/images/archive-zip.js';
import { row, uploadZip } from './helpers.js';
import { tinyImage, zip } from './zip.js';

let w: ImagesWorld;
let client: Awaited<ReturnType<ImagesWorld['stack']['connect']>>;
const call = (name: string, args: Record<string, unknown>) => w.stack.call(client, name, args);

beforeAll(async () => {
  w = await imagesWorld();
  client = await w.stack.connect();
});
afterAll(async () => {
  await w?.close();
});

describe('Z2: one row per entry, with its status', () => {
  it('a mixed zip: images, a text file, __MACOSX, a nested zip, an encrypted entry and a duplicate', async () => {
    const a = await tinyImage('png');
    const b = await tinyImage('jpeg');
    const nested = zip([{ name: 'inner.png', data: await tinyImage('png') }]);
    const bytes = zip([
      { name: 'Outfit/' },
      { name: 'a.png', data: a, method: 'deflate' },
      { name: 'Outfit/b.jpg', data: b },
      { name: 'notes.txt', data: Buffer.from('not an image at all, whatever the name says') },
      { name: 'looks-like.png', data: Buffer.from('plain text with a .png name') },
      { name: '__MACOSX/._a.png', data: Buffer.from('resource fork') },
      { name: '.DS_Store', data: Buffer.from('finder') },
      { name: 'inner.zip', data: nested },
      { name: 'secret.png', data: a, encrypted: true },
      { name: 'Outfit/a copy.png', data: a },
    ]);
    const r = await uploadZip(w, call, bytes);
    expect(r.isError, r.text).toBe(false);
    expect(r.body.archive_id).toMatch(/^arc_/);
    expect(r.body.entries).toBe(7);
    expect(r.body.skipped).toBe(2);
    expect(row(r.body, 'a.png')).toMatchObject({
      status: 'listed',
      format: 'png',
      width: 8,
      height: 8,
      folder: null,
    });
    expect(row(r.body, 'b.jpg')).toMatchObject({
      status: 'listed',
      format: 'jpeg',
      folder: 'Outfit',
      suggestedOutfit: 'Outfit',
    });
    expect(row(r.body, 'notes.txt')).toMatchObject({ status: 'refused' });
    expect(row(r.body, 'notes.txt').reason).toMatch(/^NOT_AN_IMAGE/);
    expect(row(r.body, 'looks-like.png').reason).toMatch(/^NOT_AN_IMAGE/);
    expect(row(r.body, 'inner.zip').reason).toMatch(/^NESTED_ARCHIVE/);
    expect(row(r.body, 'secret.png').reason).toMatch(/^ENCRYPTED/);
    expect(row(r.body, 'a copy.png')).toMatchObject({ status: 'duplicate', duplicateOf: 'a.png' });
    expect(r.body.rows.map((x: { path: string }) => x.path)).not.toContain('__MACOSX/._a.png');
  });

  it('a ratio bomb: an entry over 100:1 is refused; a whole archive over 100:1 is refused whole', async () => {
    const img = await tinyImage('png');
    const zeros = Buffer.alloc(300_000);
    const one = await uploadZip(
      w,
      call,
      zip([
        { name: 'fine.png', data: img },
        { name: 'bomb.png', data: zeros, method: 'deflate' },
        // padding, stored, so the whole archive stays under 100:1
        { name: 'pad.png', data: Buffer.concat([await tinyImage('png'), Buffer.alloc(0)]) },
        ...Array.from({ length: 40 }, (_, i) => ({ name: `big${i}.bin`, data: Buffer.alloc(200, i) })),
      ]),
    );
    expect(one.isError, one.text).toBe(false);
    expect(row(one.body, 'bomb.png').reason).toMatch(/^ARCHIVE_BOMB/);
    expect(row(one.body, 'fine.png').status).toBe('listed');
    const whole = await uploadZip(
      w,
      call,
      zip([{ name: 'zeros.png', data: Buffer.alloc(5_000_000), method: 'deflate' }]),
    );
    expect(whole.isError).toBe(true);
    expect(whole.body.error.code).toBe('ARCHIVE_BOMB');
    expect(whole.body.error.message).toMatch(/Nothing was staged/);
  });

  it('the entry and size caps refuse the archive whole, before anything is decompressed', async () => {
    const svc = w.stack.runtime.images;
    const images = svc.settings.images as { archiveMaxEntries: number; archiveMaxUncompressedBytes: number };
    const before = { ...images };
    try {
      images.archiveMaxEntries = 3;
      const many = await uploadZip(
        w,
        call,
        zip(
          await Promise.all(
            [1, 2, 3, 4].map(async (i) => ({ name: `${i}.png`, data: await tinyImage('png') })),
          ),
        ),
      );
      expect(many.body.error.code).toBe('ARCHIVE_TOO_MANY_ENTRIES');
      images.archiveMaxEntries = before.archiveMaxEntries;
      images.archiveMaxUncompressedBytes = 1_048_576;
      const big = await uploadZip(w, call, zip([{ name: 'x.png', data: Buffer.alloc(1_100_000, 7) }]));
      expect(big.body.error.code).toBe('ARCHIVE_TOO_LARGE');
    } finally {
      images.archiveMaxEntries = before.archiveMaxEntries;
      images.archiveMaxUncompressedBytes = before.archiveMaxUncompressedBytes;
    }
  });

  it('traversal and absolute names are refused, and nothing is ever written under a name from the zip', async () => {
    const img = await tinyImage('png');
    const r = await uploadZip(
      w,
      call,
      zip([
        { name: '../x.png', data: img },
        { name: 'a/../../y.png', data: await tinyImage('png') },
        { name: '/etc/z.png', data: await tinyImage('png') },
        { name: 'ok.png', data: await tinyImage('png') },
      ]),
      { stageAll: true },
    );
    expect(r.isError, r.text).toBe(false);
    for (const p of ['../x.png', 'a/../../y.png', '/etc/z.png'])
      expect(row(r.body, p).reason).toMatch(/^UNSAFE_PATH/);
    const svc = w.stack.runtime.images;
    await svc.archives.work();
    expect(
      row(svc.archives.archiveView(svc.archives.store.archive(r.body.archive_id)!) as never, 'ok.png').status,
    ).toBe('staged');
    // Nothing named from the zip exists anywhere: not beside the image directory, not inside it.
    expect(existsSync(join(svc.dir, '..', 'x.png'))).toBe(false);
    expect(existsSync(join(svc.dir, 'x.png'))).toBe(false);
    const names = (d: string): string[] =>
      existsSync(d)
        ? readdirSync(d, { withFileTypes: true }).flatMap((e) =>
            e.isDirectory() ? names(join(d, e.name)) : [e.name],
          )
        : [];
    expect(names(svc.dir).filter((n) => /x\.png|y\.png|z\.png|ok\.png/.test(n))).toEqual([]);
  });

  it('a ZIP64 archive is read', async () => {
    const r = await uploadZip(
      w,
      call,
      zip(
        [
          { name: 'z64/one.png', data: await tinyImage('png') },
          { name: 'z64/two.webp', data: await tinyImage('webp'), method: 'deflate' },
        ],
        { zip64: true },
      ),
    );
    expect(r.isError, r.text).toBe(false);
    expect(row(r.body, 'one.png')).toMatchObject({ status: 'listed', format: 'png', folder: 'z64' });
    expect(row(r.body, 'two.webp')).toMatchObject({ status: 'listed', format: 'webp' });
  });

  it('an unreadable zip is one clear error, and nothing is kept', async () => {
    const r = await uploadZip(
      w,
      call,
      Buffer.from('PK\u0003\u0004 this is no zip at all, only its first bytes'),
    );
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('ARCHIVE_UNREADABLE');
    const svc = w.stack.runtime.images;
    expect(existsSync(svc.archives.tmpDir) ? readdirSync(svc.archives.tmpDir) : []).toEqual([]);
  });

  it('an entry whose declared size lies is refused on its own (the rest are listed)', async () => {
    const img = await tinyImage('png');
    const r = await uploadZip(
      w,
      call,
      zip([
        { name: 'liar.png', data: img, declaredSize: img.length + 5 },
        { name: 'honest.png', data: await tinyImage('png') },
      ]),
    );
    expect(r.isError, r.text).toBe(false);
    expect(row(r.body, 'liar.png').reason).toMatch(/^ENTRY_UNREADABLE/);
    expect(row(r.body, 'honest.png').status).toBe('listed');
  });

  it('listArchive streams one entry at a time from disk (a direct check of the reader)', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'lkb-zip-'));
    const file = join(dir, 'a.zip');
    const bytes = zip([{ name: 'a.png', data: await tinyImage('png') }]);
    writeFileSync(file, bytes);
    const l = await listArchive(file, bytes.length, {
      maxEntries: 10,
      maxUncompressedBytes: 10_000_000,
      maxEntryBytes: 10_000_000,
      maxPixels: 1_000_000,
      maxFrames: 10,
    });
    expect(l.entries).toHaveLength(1);
    expect(l.entries[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

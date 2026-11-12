// Regenerates the committed image fixtures under test/fixtures/images (v2 D3). Run: npx tsx scripts/make-image-fixtures.ts
// The fixtures are committed; this script documents exactly how each was made.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';

const dir = new URL('../test/fixtures/images/', import.meta.url);
const out = (name: string, buf: Uint8Array) => writeFileSync(new URL(name, dir), buf);

// 1. A 40x24 PNG with an alpha gradient: the left half opaque red, the right half half-transparent blue.
{
  const w = 40,
    h = 24,
    px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x < w / 2) px.set([220, 30, 30, 255], i);
      else px.set([30, 30, 220, 128], i);
    }
  out(
    'alpha.png',
    await sharp(px, { raw: { width: w, height: h, channels: 4 } })
      .png()
      .toBuffer(),
  );
}

// 2. A JPEG stored 30x20 with EXIF orientation 6 (displayed rotated 90° clockwise: 20x30). The top-left stored pixel
// block is green, the rest white, so the applied orientation can be checked by where the green ends up.
{
  const w = 30,
    h = 20,
    px = Buffer.alloc(w * h * 3, 255);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px.set([0, 200, 0], (y * w + x) * 3);
  out(
    'orientation-6.jpg',
    await sharp(px, { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 95 })
      .withMetadata({ orientation: 6 })
      .toBuffer(),
  );
}

// 3. An animated GIF, 16x12, 3 frames (red, green, blue), 100 ms each, looping forever.
{
  const w = 16,
    h = 12,
    colours: number[][] = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ];
  const frames = await Promise.all(
    colours.map((c) => {
      const px = Buffer.alloc(w * h * 3);
      for (let i = 0; i < w * h; i++) px.set(c, i * 3);
      return sharp(px, { raw: { width: w, height: h, channels: 3 } })
        .png()
        .toBuffer();
    }),
  );
  out(
    'animated.gif',
    await sharp(frames, { join: { animated: true } })
      .gif({ delay: [100, 100, 100], loop: 0 })
      .toBuffer(),
  );
}

// 4. An already-WebP image, 10x10 (stored byte for byte).
{
  const px = Buffer.alloc(10 * 10 * 3, 90);
  out(
    'already.webp',
    await sharp(px, { raw: { width: 10, height: 10, channels: 3 } })
      .webp({ quality: 80 })
      .toBuffer(),
  );
}

// 5. A truncated JPEG: the first 60% of a 64x64 JPEG of noise.
{
  const px = Buffer.alloc(64 * 64 * 3);
  for (let i = 0; i < px.length; i++) px[i] = (i * 2654435761) % 251;
  const full = await sharp(px, { raw: { width: 64, height: 64, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer();
  out('truncated.jpg', full.subarray(0, Math.floor(full.length * 0.6)));
}

// 6. A decompression bomb: a valid-looking PNG of a few dozen bytes whose header declares 60000 x 60000 pixels.
{
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(60000, 0);
  ihdr.writeUInt32BE(60000, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  out(
    'bomb.png',
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.alloc(64))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

// 7. A liar: PNG bytes named `.jpg` (tests also declare it image/jpeg). The magic bytes decide: it is a PNG.
{
  const px = Buffer.alloc(12 * 8 * 3, 200);
  out(
    'png-named.jpg',
    await sharp(px, { raw: { width: 12, height: 8, channels: 3 } })
      .png()
      .toBuffer(),
  );
}

// 8. Not an image at all, named `.png`.
out('not-an-image.png', Buffer.from('This is plain text pretending to be a PNG.\n'));

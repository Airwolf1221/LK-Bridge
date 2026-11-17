/**
 * CR2 images, attacks B2 to B9 (getting past the size caps): a slow drip that never ends, a lying Content-Length (small
 * and large), a chunked body with no length, a gzip-encoded body (a decompression bomb if anything inflated it), and
 * decoder bombs (a JPEG and a lossless WebP whose headers declare huge canvases; a GIF with too many frames; a GIF whose
 * one frame is far larger than its screen). Against local https servers and the converter only.
 *
 * The safe behaviour: refused within the time limit, never more than UPLOAD_MAX_BYTES read, nothing inflated, nothing
 * decoded past the pixel and frame limits.
 */
import { gzipSync } from 'node:zlib';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseOutboundPortAllowlist } from '../../../src/auth/ports.js';
import { convertImage, ImageError } from '../../../src/images/convert.js';
import { fetchImage, UploadHttpError, type GuardOptions } from '../../../src/mcp/tools/upload-http.js';
import { certificate, fixture } from '../../images/world.js';

const PNG = fixture('alpha.png');
const MAX = 64 * 1024;
let port = 0;
let server: Server;
const sent = { bytes: 0 };

beforeAll(async () => {
  const { key, cert } = certificate();
  server = createServer({ key, cert }, (req, res) => {
    const u = req.url ?? '';
    if (u === '/drip') {
      // One byte every 50 ms, forever (a PNG signature first, so a type check alone cannot stop it).
      res.writeHead(200, { 'content-type': 'image/png' });
      let i = 0;
      const t = setInterval(() => {
        if (res.destroyed) return clearInterval(t);
        res.write(PNG.subarray(i % PNG.length, (i % PNG.length) + 1));
        sent.bytes++;
        i++;
      }, 50);
      res.on('close', () => clearInterval(t));
      return;
    }
    if (u === '/lie-small') {
      // Declares less than it sends: the rest must never be read as part of the image.
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': '200' });
      res.end(Buffer.concat([PNG, Buffer.alloc(4 * MAX, 1)]));
      return;
    }
    if (u === '/lie-large') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(10 * MAX) });
      res.end(PNG);
      return;
    }
    if (u === '/chunked') {
      res.writeHead(200, { 'content-type': 'image/png' }); // no length: chunked
      res.write(PNG);
      const filler = Buffer.alloc(16 * 1024, 2);
      let n = 0;
      const pump = () => {
        while (n < 40 && !res.destroyed) {
          n++;
          sent.bytes += filler.length;
          if (!res.write(filler)) return void res.once('drain', pump);
        }
        if (!res.destroyed) res.end();
      };
      pump();
      return;
    }
    if (u === '/gzip') {
      // 50 MB of zeros, gzipped to about 50 KB, declared as gzip: a bomb for anything that inflates it.
      const bomb = gzipSync(Buffer.alloc(50 * 1024 * 1024));
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-encoding': 'gzip',
        'content-length': bomb.length,
      });
      res.end(bomb);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.2', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const guard = (): GuardOptions => ({
  resolve: () => Promise.resolve([{ address: '127.0.0.2', family: 4 as const }]),
  ca: certificate().cert,
  allowAddress: (a) => a === '127.0.0.2',
  allowedPorts: parseOutboundPortAllowlist(`assets.test:${port}`),
});
const get = (path: string, timeoutMs = 3000) =>
  fetchImage(`https://assets.test:${port}${path}`, { ...guard(), maxBytes: MAX, timeoutMs });
const reason = async (p: Promise<unknown>) => {
  try {
    const r = (await p) as { bytes: Uint8Array };
    return `fetched ${r.bytes.length}`;
  } catch (e) {
    return e instanceof UploadHttpError ? e.reason : `other: ${(e as Error).message}`;
  }
};

describe('B2–B6: the download caps', () => {
  it('B2: a slow drip that never ends stops at the deadline', async () => {
    const t0 = Date.now();
    expect(await reason(get('/drip', 1500))).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it('B3: a Content-Length smaller than the body: only the declared bytes are taken (and they are not an image)', async () => {
    const r = await reason(get('/lie-small'));
    // Either the truncated bytes come back (a decoder then refuses them) or the response is refused; never the rest.
    expect(r === 'fetched 200' || r === 'network' || r === 'bad_content_type', r).toBe(true);
  });

  it('B4: a Content-Length over the cap is refused before the body is read', async () => {
    expect(await reason(get('/lie-large'))).toBe('too_large');
  });

  it('B5: a chunked body with no length is cut at the cap', async () => {
    sent.bytes = 0;
    expect(await reason(get('/chunked'))).toBe('too_large');
  });

  it('B6: a gzip-encoded body is never inflated (its bytes are not an image)', async () => {
    const before = process.memoryUsage().rss;
    const r = await reason(
      fetchImage(`https://assets.test:${port}/gzip`, {
        ...guard(),
        maxBytes: 10 * 1024 * 1024,
        timeoutMs: 5000,
      }),
    );
    expect(r).toBe('bad_content_type');
    expect(process.memoryUsage().rss - before).toBeLessThan(40 * 1024 * 1024);
  });
});

// ------------------------------------------------------------------------------------------------ decoder bombs

const LIMITS = { maxBytes: 10 * 1024 * 1024, maxPixels: 100_000_000, maxFrames: 300, timeoutMs: 10_000 };
const codeOf = async (bytes: Buffer) => {
  try {
    const r = await convertImage(bytes, LIMITS);
    return `converted ${r.output.width}x${r.output.height}x${r.output.frames}`;
  } catch (e) {
    return e instanceof ImageError ? e.code : `other: ${(e as Error).message}`;
  }
};

/** A GIF: a 1 × 1 screen (or `screen`), `frames` frames of `w` × `h` with one pixel's worth of LZW data each. */
function gif(frames: number, w = 1, h = 1, screen = 1): Buffer {
  const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const parts: number[] = [
    ...Buffer.from('GIF89a'),
    ...le16(screen),
    ...le16(screen),
    0x80, // global colour table, 2 colours
    0,
    0,
    0,
    0,
    0,
    255,
    255,
    255,
    // NETSCAPE2.0 loop
    0x21,
    0xff,
    0x0b,
    ...Buffer.from('NETSCAPE2.0'),
    0x03,
    0x01,
    0x00,
    0x00,
    0x00,
  ];
  for (let i = 0; i < frames; i++) {
    parts.push(0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00);
    parts.push(0x2c, ...le16(0), ...le16(0), ...le16(w), ...le16(h), 0x00);
    parts.push(0x02, 0x02, 0x44, 0x01, 0x00);
  }
  parts.push(0x3b);
  return Buffer.from(parts);
}

describe('B7–B9: decoder bombs', () => {
  it('B7: a JPEG whose header declares 65000 × 65000 is refused from its header', async () => {
    const small = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } })
      .jpeg()
      .toBuffer();
    const at = small.indexOf(Buffer.from([0xff, 0xc0]));
    expect(at).toBeGreaterThan(0);
    const bomb = Buffer.from(small);
    bomb.writeUInt16BE(65000, at + 5); // height
    bomb.writeUInt16BE(65000, at + 7); // width
    const t0 = Date.now();
    expect(await codeOf(bomb)).toBe('IMAGE_TOO_MANY_PIXELS');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('B8: a lossless WebP (stored byte for byte) whose header declares 16384 × 16384 is refused from its header', async () => {
    const small = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#00000000' } })
      .webp({ lossless: true })
      .toBuffer();
    const at = small.indexOf(Buffer.from('VP8L'));
    expect(at).toBeGreaterThan(0);
    const bomb = Buffer.from(small);
    // VP8L: signature 0x2f, then 14 bits width-1 and 14 bits height-1 (little-endian bit order).
    const sig = at + 8;
    expect(bomb[sig]).toBe(0x2f);
    const bits = bomb.readUInt32LE(sig + 1);
    const rest = bits & ~((1 << 28) - 1);
    bomb.writeUInt32LE((rest | 16383 | (16383 << 14)) >>> 0, sig + 1);
    expect(await codeOf(bomb)).toMatch(/^IMAGE_TOO_MANY_PIXELS$|^IMAGE_CORRUPT$|^IMAGE_TRUNCATED$/);
  });

  it('B9a: a GIF with 400 frames is refused (IMAGE_MAX_FRAMES)', async () => {
    expect(await codeOf(gif(400))).toBe('IMAGE_TOO_MANY_FRAMES');
  });

  it('B9b: a GIF whose one frame is 20000 × 20000 on a 1 × 1 screen is refused or stays tiny, quickly', async () => {
    const t0 = Date.now();
    const rssBefore = process.memoryUsage().rss;
    const r = await codeOf(gif(1, 20000, 20000, 1));
    const ms = Date.now() - t0;
    const grew = process.memoryUsage().rss - rssBefore;
    expect(
      r === 'IMAGE_TOO_MANY_PIXELS' ||
        r === 'IMAGE_CORRUPT' ||
        r === 'IMAGE_TRUNCATED' ||
        /^converted 1x1x1$/.test(r),
      `${r} in ${ms} ms, rss +${Math.round(grew / 1048576)} MiB`,
    ).toBe(true);
    expect(ms).toBeLessThan(10_000);
  });
});

/**
 * The D3 converter (ADR 0041) on real fixture images (test/fixtures/images, made by scripts/make-image-fixtures.mjs).
 */
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  ConversionQueue,
  ImageError,
  WEBP_QUALITY,
  convertImage,
  detectImageType,
  displayNameOf,
  sha256Hex,
  type ConvertLimits,
} from '../../src/images/convert.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/images/${name}`, import.meta.url));
const LIMITS: ConvertLimits = {
  maxBytes: 10 * 1024 * 1024,
  maxPixels: 100_000_000,
  maxFrames: 300,
  timeoutMs: 30_000,
};

async function refusal(p: Promise<unknown>): Promise<ImageError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ImageError);
    return e as ImageError;
  }
  throw new Error('expected a refusal');
}

describe('convertImage', () => {
  it('PNG with alpha: WebP at quality 90, same dimensions, alpha kept, no metadata', async () => {
    const src = fixture('alpha.png');
    const r = await convertImage(src, LIMITS);
    expect(r.mode).toBe('converted');
    expect(r.quality).toBe(WEBP_QUALITY);
    expect(r.source).toMatchObject({
      format: 'png',
      width: 40,
      height: 24,
      frames: 1,
      hasAlpha: true,
      bytes: src.length,
    });
    expect(r.source.sha256).toBe(sha256Hex(src));
    expect(r.output).toMatchObject({
      format: 'webp',
      contentType: 'image/webp',
      width: 40,
      height: 24,
      frames: 1,
      hasAlpha: true,
    });
    expect(r.output.sha256).toBe(sha256Hex(r.output.data));
    expect(detectImageType(r.output.data).format).toBe('webp');
    const m = await sharp(r.output.data).metadata();
    expect(m.exif).toBeUndefined();
    expect(m.icc).toBeUndefined();
    // The transparent half stays transparent (about 128), the opaque half opaque.
    const { data, info } = await sharp(r.output.data).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3]!;
    expect(alphaAt(2, 2)).toBe(255);
    expect(Math.abs(alphaAt(35, 20) - 128)).toBeLessThanOrEqual(4);
  });

  it('JPEG with EXIF orientation 6: rotated as displayed, then the metadata dropped', async () => {
    const r = await convertImage(fixture('orientation-6.jpg'), LIMITS);
    expect(r.source).toMatchObject({ format: 'jpeg', orientation: 6, width: 20, height: 30 });
    expect(r.output).toMatchObject({ width: 20, height: 30 });
    const m = await sharp(r.output.data).metadata();
    expect(m.orientation).toBeUndefined();
    expect(m.exif).toBeUndefined();
    // The stored top-left green block is at the top RIGHT once rotated 90° clockwise.
    const { data, info } = await sharp(r.output.data).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => [
      ...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3),
    ];
    const [r1, g1, b1] = px(info.width - 2, 1);
    expect(g1!).toBeGreaterThan(150);
    expect(r1!).toBeLessThan(80);
    expect(b1!).toBeLessThan(80);
    expect(px(1, 1)[0]!).toBeGreaterThan(200); // white
  });

  it('animated GIF: an animated WebP with every frame, its delays and loop', async () => {
    const r = await convertImage(fixture('animated.gif'), LIMITS);
    expect(r.source).toMatchObject({ format: 'gif', width: 16, height: 12, frames: 3 });
    expect(r.output).toMatchObject({ width: 16, height: 12, frames: 3 });
    const m = await sharp(r.output.data, { animated: true }).metadata();
    expect(m.format).toBe('webp');
    expect(m.pages).toBe(3);
    expect(m.delay).toEqual([100, 100, 100]);
    expect(m.loop).toBe(0);
  });

  it('WebP input is stored byte for byte', async () => {
    const src = fixture('already.webp');
    const r = await convertImage(src, LIMITS);
    expect(r.mode).toBe('webp_passthrough');
    expect(r.quality).toBeNull();
    expect(Buffer.compare(r.output.data, src)).toBe(0);
    expect(r.output.sha256).toBe(r.source.sha256);
    expect(r.output).toMatchObject({ width: 10, height: 10, frames: 1 });
  });

  it('a truncated JPEG is refused with the decoder’s words', async () => {
    const e = await refusal(convertImage(fixture('truncated.jpg'), LIMITS));
    expect(e.code).toBe('IMAGE_TRUNCATED');
    expect(e.message).toMatch(/JPEG file is truncated: .*premature end/i);
  });

  it('a truncated WebP is refused too (never passed through)', async () => {
    const webp = fixture('alpha.png');
    const full = (await convertImage(webp, LIMITS)).output.data;
    const e = await refusal(convertImage(full.subarray(0, Math.floor(full.length / 2)), LIMITS));
    expect(['IMAGE_TRUNCATED', 'IMAGE_CORRUPT']).toContain(e.code);
  });

  it('a decompression bomb (a tiny file declaring 60000 × 60000) is refused from its header', async () => {
    const src = fixture('bomb.png');
    expect(src.length).toBeLessThan(100);
    const e = await refusal(convertImage(src, LIMITS));
    expect(e.code).toBe('IMAGE_TOO_MANY_PIXELS');
    expect(e.message).toContain('60000 × 60000');
    expect(e.message).toContain('decompression bomb');
    expect(e.details).toMatchObject({ width: 60000, height: 60000, maxPixels: 100_000_000 });
  });

  it('the pixel limit counts every frame; the frame limit is its own', async () => {
    const gif = fixture('animated.gif'); // 16 × 12 × 3 = 576 pixels
    expect((await refusal(convertImage(gif, { ...LIMITS, maxPixels: 575 }))).code).toBe(
      'IMAGE_TOO_MANY_PIXELS',
    );
    expect((await convertImage(gif, { ...LIMITS, maxPixels: 576 })).output.frames).toBe(3);
    const e = await refusal(convertImage(gif, { ...LIMITS, maxFrames: 2 }));
    expect(e.code).toBe('IMAGE_TOO_MANY_FRAMES');
    expect(e.message).toContain('3 frames');
  });

  it('the byte cap is checked before anything is decoded', async () => {
    const e = await refusal(convertImage(fixture('alpha.png'), { ...LIMITS, maxBytes: 100 }));
    expect(e.code).toBe('IMAGE_TOO_LARGE');
  });

  it('the type comes from the magic bytes: a PNG named .jpg is a PNG; text named .png is refused', async () => {
    const r = await convertImage(fixture('png-named.jpg'), LIMITS);
    expect(r.source.format).toBe('png');
    expect(r.source.contentType).toBe('image/png');
    const e = await refusal(convertImage(fixture('not-an-image.png'), LIMITS));
    expect(e.code).toBe('IMAGE_TYPE_UNSUPPORTED');
    expect((await refusal(convertImage(Buffer.alloc(0), LIMITS))).code).toBe('IMAGE_EMPTY');
  });

  it('a corrupt body after a valid magic number is refused', async () => {
    const junk = Buffer.concat([fixture('alpha.png').subarray(0, 8), Buffer.from('garbage garbage garbage')]);
    const e = await refusal(convertImage(junk, LIMITS));
    expect(['IMAGE_CORRUPT', 'IMAGE_TRUNCATED']).toContain(e.code);
  });
});

describe('ConversionQueue', () => {
  it('runs one at a time and refuses past its queue', async () => {
    const q = new ConversionQueue(() => LIMITS, 1, 1);
    const png = fixture('alpha.png');
    const a = q.convert(png);
    const b = q.convert(png);
    expect(q.load).toEqual({ running: 1, waiting: 1 });
    const e = await refusal(q.convert(png));
    expect(e.code).toBe('IMAGE_CONVERTER_BUSY');
    await Promise.all([a, b]);
    expect(q.load).toEqual({ running: 0, waiting: 0 });
  });
});

describe('displayNameOf', () => {
  it('drops an image extension, nothing else', () => {
    expect(displayNameOf(' Mehrana al-Khalid.PNG ')).toBe('Mehrana al-Khalid');
    expect(displayNameOf('portrait.v2.jpeg')).toBe('portrait.v2');
    expect(displayNameOf('Asagiri Miyabi')).toBe('Asagiri Miyabi');
    expect(displayNameOf('.png')).toBe('.png');
  });
});

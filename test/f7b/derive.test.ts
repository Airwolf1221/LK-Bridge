/**
 * v3 F7b (ADR 0071, D4): the inline derivative. Resize maths (portrait, landscape, small images never enlarged), an
 * image with alpha stays WebP, a source without alpha takes JPEG only when the WebP is larger, the 1 MB step-down
 * (quality to 60, then the dimensions), and the EXIF orientation applied with the metadata dropped.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  deriveInline,
  fitWithin,
  MAX_BYTES,
  MAX_EDGE,
  MIN_QUALITY,
  QUALITY,
} from '../../src/art/view/derive.js';
import { fixture } from '../images/world.js';
import { noise } from './world.js';

const LIMITS = { maxPixels: 100_000_000, timeoutMs: 60_000 };

describe('resize maths', () => {
  it('a landscape image’s long edge becomes 1,568 px, the height in proportion', () => {
    expect(fitWithin(4000, 3000, MAX_EDGE)).toEqual({ width: 1568, height: 1176 });
  });
  it('a portrait image’s long edge (its height) becomes 1,568 px', () => {
    expect(fitWithin(2000, 5000, MAX_EDGE)).toEqual({ width: 627, height: 1568 });
  });
  it('a small image is never enlarged', () => {
    expect(fitWithin(800, 600, MAX_EDGE)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1568, 10, MAX_EDGE)).toEqual({ width: 1568, height: 10 });
  });
  it('a real portrait and landscape come out at the long edge, a small one at its own size', async () => {
    const portrait = await sharp({
      create: { width: 1000, height: 3000, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    const p = await deriveInline(portrait, LIMITS);
    expect([p.width, p.height]).toEqual([523, 1568]);
    const landscape = await sharp({
      create: { width: 3200, height: 1600, channels: 3, background: '#996633' },
    })
      .png()
      .toBuffer();
    const l = await deriveInline(landscape, LIMITS);
    expect([l.width, l.height]).toEqual([1568, 784]);
    const small = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#000' } })
      .png()
      .toBuffer();
    const s = await deriveInline(small, LIMITS);
    expect([s.width, s.height]).toEqual([300, 200]);
    expect(s.quality).toBe(QUALITY);
  });
});

describe('format', () => {
  it('an image with alpha stays WebP', async () => {
    const d = await deriveInline(fixture('alpha.png'), LIMITS);
    expect(d.source.hasAlpha).toBe(true);
    expect(d.format).toBe('webp');
    expect(d.mimeType).toBe('image/webp');
    expect((await sharp(d.bytes).metadata()).format).toBe('webp');
  });
  it('a source without alpha takes whichever of WebP and JPEG is smaller at quality 82', async () => {
    const src = await noise(640, 480, 7);
    const d = await deriveInline(src, LIMITS);
    expect(d.source.hasAlpha).toBe(false);
    const webp = await sharp(src).rotate().webp({ quality: QUALITY }).toBuffer();
    const jpeg = await sharp(src).rotate().jpeg({ quality: QUALITY }).toBuffer();
    expect(d.format).toBe(jpeg.length < webp.length ? 'jpeg' : 'webp');
    expect((await sharp(d.bytes).metadata()).format).toBe(d.format);
  });
  it('a flat source without alpha keeps WebP when it is the smaller', async () => {
    const flat = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#ff0000' } })
      .png()
      .toBuffer();
    const d = await deriveInline(flat, LIMITS);
    const webp = await sharp(flat).webp({ quality: QUALITY }).toBuffer();
    const jpeg = await sharp(flat).jpeg({ quality: QUALITY }).toBuffer();
    expect(d.format).toBe(jpeg.length < webp.length ? 'jpeg' : 'webp');
  });
});

describe('the 1 MB target', () => {
  it('a large noisy image steps its quality down until it is under 1 MB', async () => {
    const big = await noise(2400, 2400, 3);
    const d = await deriveInline(big, LIMITS);
    expect(d.bytes.length).toBeLessThan(MAX_BYTES);
    expect(d.overTarget).toBe(false);
    // At quality 82 noise at 1,568 px is over 1 MB, so the quality stepped down.
    expect(d.quality).toBeLessThan(QUALITY);
    expect(d.quality).toBeGreaterThanOrEqual(MIN_QUALITY);
    expect(Math.max(d.width, d.height)).toBe(MAX_EDGE);
  }, 60_000);
  it('when quality 60 is not enough, the dimensions shrink until it fits', async () => {
    const big = await noise(2000, 2000, 5);
    const at60 = await sharp(big).resize(MAX_EDGE, MAX_EDGE).webp({ quality: MIN_QUALITY }).toBuffer();
    const target = Math.floor(at60.length * 0.6);
    const d = await deriveInline(big, { ...LIMITS, maxBytes: target });
    expect(d.bytes.length).toBeLessThan(target);
    expect(d.quality).toBe(MIN_QUALITY);
    expect(Math.max(d.width, d.height)).toBeLessThan(MAX_EDGE);
    expect(d.width).toBe(d.height);
  }, 60_000);
  it('a lower target is met the same way (quality first: the size is kept while quality alone suffices)', async () => {
    const src = await noise(600, 600, 11);
    const at82 = await deriveInline(src, LIMITS);
    const d = await deriveInline(src, { ...LIMITS, maxBytes: Math.floor(at82.bytes.length * 0.8) });
    expect(d.bytes.length).toBeLessThan(Math.floor(at82.bytes.length * 0.8));
    expect(d.quality).toBeLessThan(QUALITY);
  });
});

describe('EXIF orientation', () => {
  it('is applied (orientation 6: the stored landscape shows as a portrait) and the metadata is dropped', async () => {
    const src = fixture('orientation-6.jpg');
    const m = await sharp(src).metadata();
    expect(m.orientation).toBe(6);
    const d = await deriveInline(src, LIMITS);
    // Stored width × height is m.width × m.height; displayed, the two swap.
    expect([d.source.width, d.source.height]).toEqual([m.height, m.width]);
    expect([d.width, d.height]).toEqual([m.height, m.width]);
    const out = await sharp(d.bytes).metadata();
    expect(out.orientation).toBeUndefined();
    expect(out.exif).toBeUndefined();
    expect(out.icc).toBeUndefined();
  });
});

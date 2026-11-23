/**
 * v3 F7b (ADR 0071, D4): the image an agent is shown inline. From an asset's original bytes (downloaded through
 * `downloadAsset`), with `sharp`:
 *
 * - the EXIF orientation applied first, then every piece of metadata dropped (sharp keeps none unless asked);
 * - the long edge at most {@link MAX_EDGE} px (the size Claude reads images at), never enlarged;
 * - WebP at quality {@link QUALITY}; JPEG at the same quality instead when the source has no alpha and the WebP comes
 *   out larger;
 * - under {@link MAX_BYTES} each: the quality steps down to {@link MIN_QUALITY}, then the dimensions shrink, until it fits;
 * - the first frame of an animation only (a reference image, not a film).
 *
 * Pure: bytes in, bytes out; nothing here touches the network, LegendKeeper or the disk.
 */
import sharp, { type Metadata } from 'sharp';

export const MAX_EDGE = 1568;
export const QUALITY = 82;
export const MIN_QUALITY = 60;
/** The quality steps tried, best first. */
export const QUALITY_STEPS: readonly number[] = [82, 75, 68, 60];
export const MAX_BYTES = 1_000_000;
/** Each dimension step keeps this share of the long edge. */
export const SHRINK = 0.85;
/** Below this long edge the derivative stops shrinking (and is delivered over the target, said so). */
export const MIN_EDGE = 256;

/** What makes a derivative different: part of the cache key, so a change here never serves an old one. */
export const DERIVE_PARAMS = {
  v: 1,
  maxEdge: MAX_EDGE,
  quality: QUALITY_STEPS,
  maxBytes: MAX_BYTES,
} as const;

export interface DeriveLimits {
  /** Most pixels the original may have (IMAGE_MAX_PIXELS). */
  readonly maxPixels: number;
  /** Time limit of one resize (IMAGE_CONVERT_TIMEOUT_MS). */
  readonly timeoutMs: number;
  /** Test seam: the byte target (default {@link MAX_BYTES}). */
  readonly maxBytes?: number;
}

export interface Derivative {
  readonly bytes: Buffer;
  readonly format: 'webp' | 'jpeg';
  readonly mimeType: 'image/webp' | 'image/jpeg';
  readonly width: number;
  readonly height: number;
  readonly quality: number;
  /** The original, as displayed (after its orientation). */
  readonly source: {
    readonly format: string | null;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
    readonly hasAlpha: boolean;
  };
  /** Still over the byte target at the smallest size tried. */
  readonly overTarget: boolean;
}

/** The size a long edge of `edge` gives an image of `w` × `h`, never larger than it is. */
export function fitWithin(w: number, h: number, edge: number): { width: number; height: number } {
  const long = Math.max(w, h);
  if (long <= edge) return { width: w, height: h };
  const k = edge / long;
  return {
    width: Math.max(1, Math.round(w * k)),
    height: Math.max(1, Math.round(h * k)),
  };
}

/** EXIF orientations 5 to 8 swap width and height when applied. */
const swaps = (o: number | undefined): boolean => o !== undefined && o >= 5 && o <= 8;

export class DeriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeriveError';
  }
}

export async function deriveInline(original: Buffer, limits: DeriveLimits): Promise<Derivative> {
  const target = limits.maxBytes ?? MAX_BYTES;
  const opts = { limitInputPixels: limits.maxPixels, failOn: 'error' as const };
  let meta: Metadata;
  try {
    meta = await sharp(original, opts).metadata();
  } catch (e) {
    throw new DeriveError(`the image could not be read (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!meta.width || !meta.height) throw new DeriveError('the image has no dimensions');
  // `height` of an animation is all its frames stacked: one frame's is `pageHeight`.
  const frameH = meta.pageHeight && meta.pages && meta.pages > 1 ? meta.pageHeight : meta.height;
  const shown = swaps(meta.orientation)
    ? { width: frameH, height: meta.width }
    : { width: meta.width, height: frameH };
  const hasAlpha = meta.hasAlpha === true;
  const source = {
    format: meta.format ?? null,
    width: shown.width,
    height: shown.height,
    bytes: original.length,
    hasAlpha,
  };

  const encode = async (edge: number, quality: number, format: 'webp' | 'jpeg') => {
    const size = fitWithin(shown.width, shown.height, edge);
    let p = sharp(original, { ...opts, animated: false })
      .timeout({ seconds: Math.max(1, Math.ceil(limits.timeoutMs / 1000)) })
      .rotate()
      .resize(size.width, size.height, { fit: 'fill', withoutEnlargement: true });
    p = format === 'webp' ? p.webp({ quality }) : p.flatten({ background: '#ffffff' }).jpeg({ quality });
    try {
      const { data, info } = await p.toBuffer({ resolveWithObject: true });
      return { bytes: data, width: info.width, height: info.height };
    } catch (e) {
      throw new DeriveError(`the image could not be resized (${e instanceof Error ? e.message : String(e)})`);
    }
  };

  /** The smaller of WebP and (without alpha) JPEG at one size and quality. */
  const best = async (edge: number, quality: number) => {
    const webp = await encode(edge, quality, 'webp');
    if (hasAlpha) return { ...webp, format: 'webp' as const, quality };
    const jpeg = await encode(edge, quality, 'jpeg');
    return jpeg.bytes.length < webp.bytes.length
      ? { ...jpeg, format: 'jpeg' as const, quality }
      : { ...webp, format: 'webp' as const, quality };
  };

  let edge = Math.min(MAX_EDGE, Math.max(shown.width, shown.height));
  let out = await best(edge, QUALITY_STEPS[0]!);
  for (const q of QUALITY_STEPS.slice(1)) {
    if (out.bytes.length < target) break;
    out = await best(edge, q);
  }
  while (out.bytes.length >= target && edge > MIN_EDGE) {
    edge = Math.max(MIN_EDGE, Math.floor(edge * SHRINK));
    out = await best(edge, MIN_QUALITY);
  }
  return {
    bytes: out.bytes,
    format: out.format,
    mimeType: out.format === 'webp' ? 'image/webp' : 'image/jpeg',
    width: out.width,
    height: out.height,
    quality: out.quality,
    source,
    overTarget: out.bytes.length >= target,
  };
}

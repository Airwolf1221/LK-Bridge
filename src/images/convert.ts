/**
 * The image converter of the D3 pipeline (PLAN-v2 4.10 and section 9, ADR 0041): `sharp` (libvips), as the old bridge.
 *
 * The rules:
 * - the type is decided by the first bytes (magic bytes) only, never by a declared type or a file name; PNG, JPEG, GIF
 *   and WebP are accepted, anything else is refused;
 * - WebP input is stored byte for byte (never re-encoded); it is still decoded once to refuse a bomb or a corrupt file;
 * - anything else becomes WebP at quality 90, keeping the pixel dimensions (no resize), with the EXIF orientation
 *   applied first and every piece of metadata dropped (EXIF, XMP, ICC: sharp keeps none unless asked), transparency
 *   kept, and every frame of an animation kept (with its delays and loop count);
 * - limits before any pixel is decoded: bytes (`UPLOAD_MAX_BYTES`), pixels (`IMAGE_MAX_PIXELS`, all frames together,
 *   also given to sharp as `limitInputPixels`) and frames (`IMAGE_MAX_FRAMES`), read from the header;
 * - a time limit per conversion (sharp's own `timeout`), and at most `IMAGE_CONVERT_CONCURRENCY` conversions at once
 *   (default one) with a short queue, so one large image cannot starve the bridge's memory;
 * - a truncated or corrupt file is refused with libvips's own words (`failOn: 'error'`).
 *
 * Nothing here talks to LegendKeeper or the network.
 */
import { createHash } from 'node:crypto';
import sharp, { type Metadata, type SharpOptions } from 'sharp';
import { sniffImageType, type ImageType } from '../mcp/tools/upload-http.js';

export type SourceFormat = 'png' | 'jpeg' | 'gif' | 'webp';

export const WEBP_QUALITY = 90;

export interface ConvertLimits {
  /** Largest input, in bytes (UPLOAD_MAX_BYTES). */
  readonly maxBytes: number;
  /** Most pixels, all frames together (IMAGE_MAX_PIXELS). */
  readonly maxPixels: number;
  /** Most frames of an animation (IMAGE_MAX_FRAMES). */
  readonly maxFrames: number;
  /** Time limit of one conversion (IMAGE_CONVERT_TIMEOUT_MS). */
  readonly timeoutMs: number;
}

export type ImageErrorCode =
  | 'IMAGE_EMPTY'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_TYPE_UNSUPPORTED'
  | 'IMAGE_TYPE_MISMATCH'
  | 'IMAGE_TOO_MANY_PIXELS'
  | 'IMAGE_TOO_MANY_FRAMES'
  | 'IMAGE_TRUNCATED'
  | 'IMAGE_CORRUPT'
  | 'IMAGE_CONVERT_TIMEOUT'
  | 'IMAGE_CONVERTER_BUSY';

/** A refusal with a stable code and a precise message (never containing the bytes). */
export class ImageError extends Error {
  constructor(
    readonly code: ImageErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ImageError';
  }
}

export interface ImageFacts {
  readonly format: SourceFormat;
  readonly contentType: ImageType;
  readonly bytes: number;
  readonly sha256: string;
  /** Pixel width and height of one frame, as displayed (after the EXIF orientation). */
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly hasAlpha: boolean;
}

export interface ConvertedImage {
  /** `converted`: re-encoded as WebP; `webp_passthrough`: the original WebP, byte for byte. */
  readonly mode: 'converted' | 'webp_passthrough';
  readonly source: ImageFacts & {
    /** The EXIF orientation of the original (1 to 8), or null when it had none. */
    readonly orientation: number | null;
  };
  readonly output: ImageFacts & { readonly data: Buffer };
  /** The WebP quality used, or null for a passthrough. */
  readonly quality: number | null;
  /** Wall-clock time of the conversion, in milliseconds (waiting in the queue excluded). */
  readonly ms: number;
}

const FORMAT_OF: Record<ImageType, SourceFormat> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The type named by the magic bytes, or a refusal. A declared type is never consulted here. */
export function detectImageType(bytes: Uint8Array): { contentType: ImageType; format: SourceFormat } {
  if (bytes.length === 0) throw new ImageError('IMAGE_EMPTY', 'The image is empty (0 bytes).');
  const t = sniffImageType(bytes);
  if (!t) {
    throw new ImageError(
      'IMAGE_TYPE_UNSUPPORTED',
      'The data is not a PNG, JPEG, GIF or WebP image (checked by its first bytes; names and declared types are not trusted).',
    );
  }
  return { contentType: t, format: FORMAT_OF[t] };
}

/** Normalises a declared content type (`image/jpg` is `image/jpeg`), or null when it is not an image type we know. */
export function normaliseContentType(t: string | null | undefined): ImageType | null {
  const v = (t ?? '').split(';')[0]!.trim().toLowerCase();
  const n = v === 'image/jpg' ? 'image/jpeg' : v;
  return n === 'image/png' || n === 'image/jpeg' || n === 'image/gif' || n === 'image/webp' ? n : null;
}

function vipsMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function classify(e: unknown, format: SourceFormat): ImageError {
  if (e instanceof ImageError) return e;
  const m = vipsMessage(e);
  if (/timeout/i.test(m)) {
    return new ImageError(
      'IMAGE_CONVERT_TIMEOUT',
      `The conversion took longer than its time limit and was stopped.`,
    );
  }
  if (/premature end|truncat|unexpected end|not enough data|short read|read error|incomplete/i.test(m)) {
    return new ImageError('IMAGE_TRUNCATED', `The ${format.toUpperCase()} file is truncated: ${m}.`, {
      decoder: m,
    });
  }
  if (/pixel limit/i.test(m)) {
    return new ImageError('IMAGE_TOO_MANY_PIXELS', `The image has more pixels than allowed: ${m}.`);
  }
  return new ImageError('IMAGE_CORRUPT', `The ${format.toUpperCase()} file is corrupt or unreadable: ${m}.`, {
    decoder: m,
  });
}

interface Header {
  width: number;
  pageHeight: number;
  frames: number;
  hasAlpha: boolean;
  orientation: number | null;
  loop: number | undefined;
  delay: number[] | undefined;
}

/** Reads the header only (no pixels), then applies the byte, pixel and frame limits. */
async function header(bytes: Buffer, format: SourceFormat, limits: ConvertLimits): Promise<Header> {
  let m: Metadata;
  try {
    // The header only: no pixel is decoded, so the pixel limit is checked by us below, with a precise message.
    m = await sharp(bytes, { animated: true, limitInputPixels: false, failOn: 'none' }).metadata();
  } catch (e) {
    throw classify(e, format);
  }
  const detected = String(m.format) === 'jpg' ? 'jpeg' : m.format;
  if (detected !== format) {
    throw new ImageError(
      'IMAGE_CORRUPT',
      `The file starts like a ${format.toUpperCase()} image but the decoder reads it as ${String(detected ?? 'nothing')}.`,
    );
  }
  const width = m.width ?? 0;
  const frames = Math.max(1, m.pages ?? 1);
  const pageHeight = m.pageHeight ?? (frames > 1 ? Math.floor((m.height ?? 0) / frames) : (m.height ?? 0));
  if (width <= 0 || pageHeight <= 0) {
    throw new ImageError(
      'IMAGE_CORRUPT',
      `The ${format.toUpperCase()} header declares no usable dimensions.`,
    );
  }
  if (frames > limits.maxFrames) {
    throw new ImageError(
      'IMAGE_TOO_MANY_FRAMES',
      `The animation has ${frames} frames; at most ${limits.maxFrames} are accepted (IMAGE_MAX_FRAMES).`,
      { frames, maxFrames: limits.maxFrames },
    );
  }
  const pixels = width * pageHeight * frames;
  if (pixels > limits.maxPixels) {
    throw new ImageError(
      'IMAGE_TOO_MANY_PIXELS',
      `The image declares ${width} × ${pageHeight} pixels${frames > 1 ? ` × ${frames} frames` : ''} ` +
        `(${pixels.toLocaleString('en-GB')} pixels); at most ${limits.maxPixels.toLocaleString('en-GB')} are accepted ` +
        `(IMAGE_MAX_PIXELS). A file this small declaring that much is a decompression bomb; nothing was decoded.`,
      { width, height: pageHeight, frames, pixels, maxPixels: limits.maxPixels },
    );
  }
  return {
    width,
    pageHeight,
    frames,
    hasAlpha: m.hasAlpha === true,
    orientation: typeof m.orientation === 'number' ? m.orientation : null,
    loop: m.loop,
    delay: Array.isArray(m.delay) ? m.delay : undefined,
  };
}

const timeoutSeconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/** Converts one image (see the module comment). Runs immediately: use `ConversionQueue` to serialise. */
export async function convertImage(input: Uint8Array, limits: ConvertLimits): Promise<ConvertedImage> {
  const started = Date.now();
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length > limits.maxBytes) {
    throw new ImageError(
      'IMAGE_TOO_LARGE',
      `The image is ${bytes.length} bytes; at most ${limits.maxBytes} are accepted (UPLOAD_MAX_BYTES).`,
      { bytes: bytes.length, maxBytes: limits.maxBytes },
    );
  }
  const { contentType, format } = detectImageType(bytes);
  const h = await header(bytes, format, limits);
  const opts: SharpOptions = {
    animated: h.frames > 1,
    limitInputPixels: limits.maxPixels,
    failOn: 'error',
    sequentialRead: true,
  };
  // One full decode that discards the pixels (statistics stream through libvips): truncation and corruption are
  // caught here with the decoder's own words, for a passthrough too.
  try {
    await sharp(bytes, opts)
      .timeout({ seconds: timeoutSeconds(limits.timeoutMs) })
      .stats();
  } catch (e) {
    throw classify(e, format);
  }
  const sourceSha = sha256Hex(bytes);
  // EXIF orientations 5 to 8 swap width and height when applied.
  const swaps = h.orientation !== null && h.orientation >= 5 && h.orientation <= 8 && h.frames === 1;
  const source = {
    format,
    contentType,
    bytes: bytes.length,
    sha256: sourceSha,
    width: swaps ? h.pageHeight : h.width,
    height: swaps ? h.width : h.pageHeight,
    frames: h.frames,
    hasAlpha: h.hasAlpha,
    orientation: h.orientation,
  };
  if (format === 'webp') {
    return {
      mode: 'webp_passthrough',
      source,
      output: { ...source, data: bytes },
      quality: null,
      ms: Date.now() - started,
    };
  }
  let data: Buffer;
  try {
    let p = sharp(bytes, opts).timeout({ seconds: timeoutSeconds(limits.timeoutMs) });
    if (h.frames === 1) p = p.autoOrient();
    data = await p
      .webp({
        quality: WEBP_QUALITY,
        alphaQuality: 100,
        effort: 4,
        ...(h.frames > 1 && h.loop !== undefined ? { loop: h.loop } : {}),
        ...(h.frames > 1 && h.delay && h.delay.length === h.frames ? { delay: h.delay } : {}),
      })
      .toBuffer();
  } catch (e) {
    throw classify(e, format);
  }
  let out: Header;
  try {
    out = await header(data, 'webp', { ...limits, maxBytes: Number.MAX_SAFE_INTEGER });
  } catch (e) {
    throw new ImageError('IMAGE_CORRUPT', `The converted WebP could not be read back: ${vipsMessage(e)}.`);
  }
  if (out.width !== source.width || out.pageHeight !== source.height || out.frames !== source.frames) {
    throw new ImageError(
      'IMAGE_CORRUPT',
      `The conversion changed the image (${source.width}×${source.height}×${source.frames} became ` +
        `${out.width}×${out.pageHeight}×${out.frames}); nothing was uploaded.`,
    );
  }
  return {
    mode: 'converted',
    source,
    output: {
      format: 'webp',
      contentType: 'image/webp',
      bytes: data.length,
      sha256: sha256Hex(data),
      width: out.width,
      height: out.pageHeight,
      frames: out.frames,
      hasAlpha: out.hasAlpha,
      data,
    },
    quality: WEBP_QUALITY,
    ms: Date.now() - started,
  };
}

/**
 * Runs conversions at most `concurrency` at a time (IMAGE_CONVERT_CONCURRENCY, default 1), with at most `maxQueued`
 * waiting; past that a request is refused (`IMAGE_CONVERTER_BUSY`) rather than held in memory.
 */
export class ConversionQueue {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly limits: () => ConvertLimits,
    private readonly concurrency = 1,
    private readonly maxQueued = 8,
  ) {
    // The libvips operation cache holds decoded images between calls; the bridge converts each image once.
    sharp.cache(false);
  }

  /** How many conversions run and wait now. */
  get load(): { readonly running: number; readonly waiting: number } {
    return { running: this.running, waiting: this.waiting.length };
  }

  async convert(bytes: Uint8Array): Promise<ConvertedImage> {
    if (this.running >= this.concurrency) {
      if (this.waiting.length >= this.maxQueued) {
        throw new ImageError(
          'IMAGE_CONVERTER_BUSY',
          `${this.running} conversion(s) are running and ${this.waiting.length} are waiting; try again in a minute.`,
        );
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await convertImage(bytes, this.limits());
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

/** The display name: surrounding spaces removed and a final image extension dropped (`Mehrana.PNG` → `Mehrana`). */
export function displayNameOf(name: string): string {
  const n = name.trim();
  const stripped = n.replace(/\.(?:png|jpe?g|gif|webp|jfif|pjpeg|pjp|apng)$/i, '').trim();
  return stripped === '' ? n : stripped;
}

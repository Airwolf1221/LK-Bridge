/**
 * Resolves the image for `lk_upload_image`: base64 (optionally a `data:` URI), or a public https URL when
 * `UPLOAD_ALLOW_URL_SOURCE` allows. Either way the result is verified: size cap, and the first bytes must be a PNG,
 * JPEG, GIF or WebP image that agrees with any content type the caller named.
 */
import { createHash } from 'node:crypto';
import type { ToolsSettings } from '../../config/tools.js';
import {
  fetchImage,
  sniffImageType,
  UploadHttpError,
  type GuardOptions,
  type ImageType,
} from './upload-http.js';

export type SourceFailureCode =
  | 'UPLOAD_SOURCE_INVALID'
  | 'UPLOAD_TOO_LARGE'
  | 'UPLOAD_NOT_AN_IMAGE'
  | 'UPLOAD_URL_SOURCE_DISABLED'
  | 'UPLOAD_URL_REFUSED'
  | 'UPLOAD_URL_FAILED'
  /** v3 F2: a ChatGPT file link that no longer works (401, 403, 404 or 410): ask ChatGPT for a fresh one. */
  | 'FILE_URL_EXPIRED';

/** A refusal with a stable code; the message never contains the URL. */
export class UploadSourceError extends Error {
  constructor(
    readonly code: SourceFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'UploadSourceError';
  }
}

export interface ResolvedImage {
  readonly dataBase64: string;
  readonly contentType: ImageType;
  readonly contentLength: number;
  readonly sha256: string;
}

export interface ImageSourceInput {
  readonly base64?: string | undefined;
  readonly url?: string | undefined;
  /**
   * v3 F2 (ADR 0049 decision 12): a ChatGPT file's temporary `download_url` (a capability: never logged, stored,
   * journalled or returned). Downloaded through the same guarded transport as `url`, whatever UPLOAD_ALLOW_URL_SOURCE
   * says, with any declared content type (the magic bytes decide).
   */
  readonly fileUrl?: string | undefined;
  readonly contentType?: string | undefined;
}

/** v3 F2: the hint of FILE_URL_EXPIRED. */
export const FILE_URL_EXPIRED_HINT =
  'Call upload_image again with the same attachment so ChatGPT issues a fresh link; if that fails, ask the user to attach the image again.';

const DATA_URI = /^data:([a-z]+\/[a-z0-9.+-]+)?(?:;[a-z0-9=.+-]+)*;base64,/i;

export async function resolveImage(
  input: ImageSourceInput,
  settings: ToolsSettings['upload'],
  guard: GuardOptions = {},
  signal?: AbortSignal,
): Promise<ResolvedImage> {
  const given = [input.base64, input.url, input.fileUrl].filter((x) => x !== undefined).length;
  if (given !== 1) {
    throw new UploadSourceError('UPLOAD_SOURCE_INVALID', 'Give exactly one of base64, url or file');
  }
  let bytes: Uint8Array;
  let sniffed: ImageType | null;
  if (input.base64 !== undefined) {
    let text = input.base64.trim();
    const m = DATA_URI.exec(text);
    if (m) text = text.slice(m[0].length);
    text = text.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text) || text.length === 0) {
      throw new UploadSourceError('UPLOAD_SOURCE_INVALID', 'base64 is empty or not valid base64');
    }
    // Check the size before decoding anything.
    if (Math.floor((text.length * 3) / 4) > settings.maxBytes + 3) {
      throw new UploadSourceError(
        'UPLOAD_TOO_LARGE',
        `The image is larger than UPLOAD_MAX_BYTES (${settings.maxBytes} bytes)`,
      );
    }
    bytes = Buffer.from(text, 'base64');
    if (bytes.length > settings.maxBytes) {
      throw new UploadSourceError(
        'UPLOAD_TOO_LARGE',
        `The image is larger than UPLOAD_MAX_BYTES (${settings.maxBytes} bytes)`,
      );
    }
    sniffed = sniffImageType(bytes);
    if (!sniffed) {
      throw new UploadSourceError('UPLOAD_NOT_AN_IMAGE', 'The data is not a PNG, JPEG, GIF or WebP image');
    }
  } else if (input.fileUrl !== undefined) {
    try {
      const got = await fetchImage(input.fileUrl, {
        ...guard,
        maxBytes: settings.maxBytes,
        timeoutMs: settings.fetchTimeoutMs,
        signal,
        maxRedirects: 3,
        anyContentType: true,
      });
      bytes = got.bytes;
      sniffed = got.contentType;
    } catch (e) {
      if (e instanceof UploadHttpError) {
        if (e.reason === 'bad_status' && [401, 403, 404, 410].includes(e.status ?? 0))
          throw new UploadSourceError(
            'FILE_URL_EXPIRED',
            `The file's link no longer works (HTTP ${String(e.status)}): ChatGPT's file links are temporary. ${FILE_URL_EXPIRED_HINT}`,
          );
        if (e.reason === 'too_large')
          throw new UploadSourceError(
            'UPLOAD_TOO_LARGE',
            `The image is larger than UPLOAD_MAX_BYTES (${settings.maxBytes} bytes)`,
          );
        if (e.reason === 'bad_content_type') throw new UploadSourceError('UPLOAD_NOT_AN_IMAGE', e.message);
        if (['blocked_address', 'blocked_port', 'invalid_url', 'redirect'].includes(e.reason))
          throw new UploadSourceError('UPLOAD_URL_REFUSED', `The file's link was refused: ${e.message}`);
        throw new UploadSourceError('UPLOAD_URL_FAILED', `The file could not be downloaded: ${e.message}`);
      }
      throw e;
    }
  } else {
    if (!settings.allowUrlSource) {
      throw new UploadSourceError(
        'UPLOAD_URL_SOURCE_DISABLED',
        'Fetching images from URLs is switched off on this bridge (UPLOAD_ALLOW_URL_SOURCE=false); send base64 instead',
      );
    }
    try {
      const got = await fetchImage(input.url!, {
        ...guard,
        maxBytes: settings.maxBytes,
        timeoutMs: settings.fetchTimeoutMs,
        signal,
      });
      bytes = got.bytes;
      sniffed = got.contentType;
    } catch (e) {
      if (e instanceof UploadHttpError) {
        if (e.reason === 'too_large') {
          throw new UploadSourceError(
            'UPLOAD_TOO_LARGE',
            `The image is larger than UPLOAD_MAX_BYTES (${settings.maxBytes} bytes)`,
          );
        }
        if (e.reason === 'bad_content_type') throw new UploadSourceError('UPLOAD_NOT_AN_IMAGE', e.message);
        if (
          e.reason === 'blocked_address' ||
          e.reason === 'blocked_port' ||
          e.reason === 'invalid_url' ||
          e.reason === 'redirect'
        ) {
          throw new UploadSourceError('UPLOAD_URL_REFUSED', `The image URL was refused: ${e.message}`);
        }
        throw new UploadSourceError('UPLOAD_URL_FAILED', `The image could not be fetched: ${e.message}`);
      }
      throw e;
    }
  }
  if (input.contentType !== undefined) {
    const named =
      input.contentType.toLowerCase() === 'image/jpg' ? 'image/jpeg' : input.contentType.toLowerCase();
    if (named !== sniffed) {
      throw new UploadSourceError(
        'UPLOAD_NOT_AN_IMAGE',
        `contentType ${input.contentType} does not match the image data (it is ${sniffed})`,
      );
    }
  }
  return {
    dataBase64: Buffer.from(bytes).toString('base64'),
    contentType: sniffed,
    contentLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

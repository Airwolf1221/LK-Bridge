/**
 * The custom `upload_image.put` step: PUT the image to the signed `uploadUrl` that `createImageUpload` returned
 * (PLAN §4 rule 5). Not an LK API call and on another host, so it draws on the reactive-only upload tier, not on any
 * LK tier; it still runs inside `governor.execute`, which provides pacing, retries with backoff on 5xx and
 * connection errors, and the 429 / `UPLOAD_RATE_EXCEEDED` reactive backoff.
 *
 * Safe to run again after a crash (the same bytes go to the same key). The signed URL is read from the stored
 * result of step 1, handed straight to the transport and never written to a log, message or error.
 */
import { createHash } from 'node:crypto';
import { UPLOAD_PUT_STEP, type CustomStepHandler } from '../../jobs/index.js';
import { BridgeLkError } from '../../lk/index.js';
import { assertPublicTarget, UploadHttpError, type GuardOptions } from './upload-http.js';

interface PutBody {
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly contentHash?: string;
  readonly dataBase64?: string;
  readonly purged?: boolean;
}

interface CreatedUpload {
  readonly uploadUrl?: unknown;
  readonly method?: unknown;
  readonly headers?: unknown;
  readonly expiresAt?: unknown;
}

const fail = (code: string, message: string, classification: 'user_fixable' | 'bridge' = 'user_fixable') =>
  new BridgeLkError({ message, code, retryable: false, classification, opId: UPLOAD_PUT_STEP });

export function createUploadPutHandler(
  opts: { readonly guard?: GuardOptions; readonly now?: () => number } = {},
): CustomStepHandler {
  const now = opts.now ?? Date.now;
  return async (ctx) => {
    const body = (ctx.params.body ?? {}) as PutBody;
    if (body.purged || typeof body.dataBase64 !== 'string') {
      throw fail(
        'UPLOAD_BYTES_DISCARDED',
        'The image bytes were discarded after an earlier successful upload. Upload the image again.',
      );
    }
    const created = (ctx.resultOf(1) ?? {}) as CreatedUpload;
    const url = created.uploadUrl;
    if (typeof url !== 'string' || url.length === 0) {
      throw fail('UPLOAD_NO_URL', 'createImageUpload returned no upload URL', 'bridge');
    }
    if (created.method !== undefined && created.method !== 'PUT') {
      throw fail('UPLOAD_BAD_METHOD', 'createImageUpload asked for a method other than PUT', 'bridge');
    }
    if (typeof created.expiresAt === 'string') {
      const at = Date.parse(created.expiresAt);
      if (Number.isFinite(at) && at <= now()) {
        throw fail(
          'UPLOAD_URL_EXPIRED',
          'The signed upload URL has expired before the file was sent. Upload the image again.',
        );
      }
    }
    const bytes = Buffer.from(body.dataBase64, 'base64');
    if (bytes.length !== body.contentLength) {
      throw fail('UPLOAD_LENGTH_MISMATCH', 'The stored image does not match its declared length', 'bridge');
    }
    if (body.contentHash && createHash('sha256').update(bytes).digest('hex') !== body.contentHash) {
      throw fail('UPLOAD_HASH_MISMATCH', 'The stored image does not match its declared hash', 'bridge');
    }
    try {
      await assertPublicTarget(url, opts.guard);
    } catch (e) {
      if (e instanceof UploadHttpError) {
        throw fail('UPLOAD_TARGET_REFUSED', `Upload target refused: ${e.message}`, 'bridge');
      }
      throw e;
    }

    // The headers LK returned, exactly as given; content-type is added only if LK did not list it.
    const headers = new Headers();
    if (created.headers && typeof created.headers === 'object') {
      for (const [k, v] of Object.entries(created.headers as Record<string, unknown>)) {
        if (typeof v === 'string') headers.set(k, v);
      }
    }
    if (!headers.has('content-type') && body.contentType) headers.set('content-type', body.contentType);

    await ctx.lk.governor.execute<Response>({
      opId: UPLOAD_PUT_STEP,
      kind: 'upload',
      costs: { tiers: ['upload'] },
      priority: ctx.priority,
      jobId: ctx.jobId,
      run: () => ctx.lk.fetch(url, { method: 'PUT', headers, body: new Uint8Array(bytes) }),
    });

    // The bytes are no longer needed: keep the database small, and keep the image out of job exports.
    ctx.replaceParams({
      body: { contentType: body.contentType, contentLength: body.contentLength, purged: true },
    });
    return { uploaded: true, bytes: bytes.length, contentType: body.contentType };
  };
}

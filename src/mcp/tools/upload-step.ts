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
import { UPLOAD_PUT_STEP, UPLOAD_VERIFY_STEP, type CustomStepHandler } from '../../jobs/index.js';
import { AssetDownloadError, downloadAsset } from '../../images/download.js';
import { BridgeLkError } from '../../lk/index.js';
import { getOperation } from '../../lk/registry.js';
import { callOp } from '../../jobs/lk-call.js';
import { assertPublicTarget, UploadHttpError, type GuardOptions } from './upload-http.js';

interface PutBody {
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly contentHash?: string;
  readonly dataBase64?: string;
  readonly purged?: boolean;
  /** v3 F2 (ADR 0049 decision 10): the bytes are the WebP the bridge keeps on its server for a staged image. */
  readonly stagedSha256?: string;
}

interface CreatedUpload {
  readonly uploadUrl?: unknown;
  readonly method?: unknown;
  readonly headers?: unknown;
  readonly expiresAt?: unknown;
}

const fail = (code: string, message: string, classification: 'user_fixable' | 'bridge' = 'user_fixable') =>
  new BridgeLkError({ message, code, retryable: false, classification, opId: UPLOAD_PUT_STEP });

/** Default per-attempt deadline of the PUT (UPLOAD_PUT_TIMEOUT_MS). */
export const DEFAULT_UPLOAD_PUT_TIMEOUT_MS = 120_000;

export function createUploadPutHandler(
  opts: {
    readonly guard?: GuardOptions;
    readonly now?: () => number;
    /** UPLOAD_PUT_TIMEOUT_MS: the PUT's own per-attempt deadline, not the governor's LK request timeout. */
    readonly putTimeoutMs?: number;
    /** v3 F2: a staged image's bytes on the bridge's server, by the WebP's SHA-256 (null when gone). */
    readonly stagedBytes?: (sha256: string) => Promise<Buffer | null>;
  } = {},
): CustomStepHandler {
  const now = opts.now ?? Date.now;
  return async (ctx) => {
    const body = (ctx.params.body ?? {}) as PutBody;
    // v3 F2: a staged image's placement sends the bytes the bridge kept on its server (read now, checked below).
    let staged: Buffer | null = null;
    if (typeof body.stagedSha256 === 'string') {
      staged = (await opts.stagedBytes?.(body.stagedSha256)) ?? null;
      if (!staged)
        throw fail(
          'STAGED_BYTES_GONE',
          'The staged image’s bytes are no longer on the bridge’s server (discarded or expired). Stage the image again.',
        );
    } else if (body.purged || typeof body.dataBase64 !== 'string') {
      throw fail(
        'UPLOAD_BYTES_DISCARDED',
        'The image bytes were discarded after an earlier successful upload. Upload the image again.',
      );
    }
    // v2 D3: folders may be created first; the upload is always the step just before this one.
    let created = (ctx.resultOf(ctx.stepNo - 1) ?? {}) as CreatedUpload;
    /** v3 F7c (ADR 0075, Z5): the upload made again because its signed URL expired while the job waited. */
    let renewedKey: string | null = null;
    if (typeof created.expiresAt === 'string' && body.contentLength !== undefined) {
      const at = Date.parse(created.expiresAt);
      if (Number.isFinite(at) && at <= now()) {
        // The job waited past the URL's life (a long Retry-After, a restart): the upload is made again, through the
        // governor, with its own idempotency key, so the image is still sent once and the asset made once.
        const op = getOperation('createImageUpload');
        if (!op) throw fail('UPLOAD_URL_EXPIRED', 'The signed upload URL has expired.', 'bridge');
        const again = (await callOp(
          ctx.lk,
          op,
          {
            body: {
              contentType: body.contentType,
              contentLength: body.contentLength,
              ...(body.contentHash ? { contentHash: body.contentHash } : {}),
            },
          },
          {
            priority: ctx.priority,
            jobId: ctx.jobId,
            idempotencyKey: `lkb.${ctx.jobId}.${ctx.stepNo}.renew.${at}`.slice(0, 255),
            requestIdPrefix: `lkb.${ctx.jobId}.${ctx.stepNo}.renew`,
          },
        )) as CreatedUpload & { uploadKey?: unknown };
        if (typeof again.uploadKey !== 'string' || again.uploadKey.length === 0)
          throw fail('UPLOAD_NO_URL', 'createImageUpload (made again) returned no upload key', 'bridge');
        created = again;
        renewedKey = again.uploadKey;
      }
    }
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
    const bytes = staged ?? Buffer.from(body.dataBase64!, 'base64');
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
      timeoutMs: opts.putTimeoutMs ?? DEFAULT_UPLOAD_PUT_TIMEOUT_MS,
      run: (signal) => ctx.lk.fetch(url, { method: 'PUT', headers, body: new Uint8Array(bytes), signal }),
    });

    // The bytes are no longer needed: keep the database small, and keep the image out of job exports. (A staged image's
    // step holds only its hash, and keeps it: the bytes stay on the server until the placement has succeeded.)
    if (!staged)
      ctx.replaceParams({
        body: { contentType: body.contentType, contentLength: body.contentLength, purged: true },
      });
    // v3 F7c (Z5): createImageAsset binds the renewed upload's key (the engine prefers it to the expired one's).
    return {
      uploaded: true,
      bytes: bytes.length,
      contentType: body.contentType,
      ...(renewedKey ? { uploadKey: renewedKey, renewed: true } : {}),
    };
  };
}

// ================================================================================================ v2 D3: verification

interface VerifyBody {
  readonly assetStep?: number;
  readonly contentHash?: string;
  readonly contentLength?: number;
}

/** What the verify step records (the job's `stored`; the tool's `storedBytesVerified`). */
export interface StoredVerification {
  readonly storedBytesVerified: boolean;
  readonly assetId: string | null;
  readonly expectedSha256: string | null;
  readonly storedSha256?: string;
  readonly storedBytes?: number;
  /** v2 E5.2: the URL the stored file was served from, when the asset's URL redirected (the asset's URL is unchanged). */
  readonly servedFrom?: string;
  /** Why it is not verified, in words. */
  readonly reason?: string;
}

/**
 * v2 D3 (ADR 0041): the `upload_image.verify` step. Downloads the asset createImageAsset made (anonymously, from the
 * asset host) and compares its SHA-256 with the bytes the bridge uploaded. It never fails the job: a mismatch or a
 * failed download is reported as unverified (the asset id is still returned), and nothing is retried.
 */
export function createUploadVerifyHandler(opts: {
  readonly assetHosts: readonly string[];
  readonly timeoutMs?: number;
}): CustomStepHandler {
  return async (ctx) => {
    const body = (ctx.params.body ?? {}) as VerifyBody;
    const expected = typeof body.contentHash === 'string' ? body.contentHash : null;
    const asset = (typeof body.assetStep === 'number' ? ctx.resultOf(body.assetStep) : null) as {
      id?: unknown;
      url?: unknown;
    } | null;
    const assetId = typeof asset?.id === 'string' ? asset.id : null;
    const out = (o: Omit<StoredVerification, 'assetId' | 'expectedSha256'>): StoredVerification => ({
      assetId,
      expectedSha256: expected,
      ...o,
    });
    if (!expected)
      return out({ storedBytesVerified: false, reason: 'no hash of the uploaded bytes was kept' });
    try {
      const got = await downloadAsset(ctx.lk, asset?.url, {
        hosts: opts.assetHosts,
        priority: ctx.priority,
        opId: UPLOAD_VERIFY_STEP,
        jobId: ctx.jobId,
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      });
      const same = got.sha256 === expected;
      return out({
        storedBytesVerified: same,
        storedSha256: got.sha256,
        storedBytes: got.bytes.length,
        ...(got.finalUrl ? { servedFrom: got.finalUrl } : {}),
        ...(same
          ? {}
          : {
              reason: `the stored file (${got.bytes.length} bytes, SHA-256 ${got.sha256.slice(0, 12)}…) differs from the bytes uploaded (${body.contentLength ?? '?'} bytes, ${expected.slice(0, 12)}…)`,
            }),
      });
    } catch (e) {
      if (e instanceof AssetDownloadError) return out({ storedBytesVerified: false, reason: e.message });
      throw e;
    }
  };
}

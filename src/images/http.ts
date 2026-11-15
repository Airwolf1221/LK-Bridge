/**
 * The single-use binary endpoint (v2 D3, ADR 0041): `POST /uploads/<upload_id>`, on the bridge's own address.
 *
 * - The capability travels in `Authorization: Upload <token>`, never in the URL (a token in the query string is
 *   ignored: nothing reads it), and is never logged (the server's logger redacts `authorization` and logs paths only).
 * - No cookies are read or set, no CORS headers are sent (a browser page elsewhere cannot read an answer), no redirects.
 * - Refused: a missing, malformed, expired, used, unknown or mismatched capability (ONE generic refusal that never says
 *   which); a connection whose scope has dropped to `read` or that was removed; a declared Content-Length over the
 *   prepared length (before reading anything); a body longer than the prepared length (reading stops at length + 1);
 *   a different SHA-256 or a different magic-byte type; a body too slow (idle and total time limits).
 * - Rate limits: per client address (every request, refused ones too) and per principal (accepted uploads).
 * - It answers only "received", with the hash. The upload into LegendKeeper happens when `upload_image` is called with
 *   the `upload_id`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ReceiveError } from './slots.js';
import type { ImageService } from './service.js';

export interface UploadsPluginOptions {
  readonly images: ImageService;
  /** The principal's live scope (the policy gate), or undefined when it is unknown, revoked or expired. */
  readonly scopeOf: (principalId: string) => string | undefined;
  readonly audit?: (actor: string, action: string, target: string, after?: unknown) => void;
}

const STATUS: Record<ReceiveError['refusal'], number> = {
  capability: 403,
  too_large: 413,
  too_small: 422,
  hash_mismatch: 422,
  type_mismatch: 422,
  timeout: 408,
  aborted: 400,
  storage: 507,
};

function send(reply: FastifyReply, status: number, body: Record<string, unknown>, close = false) {
  reply
    .code(status)
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff')
    .header('content-type', 'application/json; charset=utf-8');
  if (close) reply.header('connection', 'close');
  return reply.send(JSON.stringify(body));
}

export function uploadsPlugin(app: FastifyInstance, o: UploadsPluginOptions): Promise<void> {
  // The body is streamed by the handler itself, so Fastify must not buffer or parse it (any content type).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, _payload, done) => done(null, undefined));

  app.post('/uploads/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const svc = o.images;
    const s = svc.settings.images;
    const ip = req.ip;
    const wait = svc.rate.ip.retryAfterMs(ip);
    if (wait > 0) {
      reply.header('retry-after', String(Math.ceil(wait / 1000)));
      return send(
        reply,
        429,
        { error: 'rate_limited', message: 'Too many uploads from this address; try again later.' },
        true,
      );
    }
    svc.rate.ip.hit(ip);

    let slot;
    try {
      slot = svc.slots.claim(req.params.id, req.headers.authorization);
    } catch (e) {
      if (e instanceof ReceiveError) {
        return send(reply, 403, { error: 'upload_refused', message: e.message }, true);
      }
      throw e;
    }
    const generic = () => {
      svc.store.transitionSlot(slot.id, 'receiving', 'expired');
      return send(
        reply,
        403,
        {
          error: 'upload_refused',
          message: 'The upload was refused: no valid upload capability for this upload id.',
        },
        true,
      );
    };
    // The connection that prepared it must still be allowed to write (or propose).
    const scope = o.scopeOf(slot.principalId);
    if (slot.principalId !== 'system' && scope !== 'write' && scope !== 'propose') return generic();
    const pwait = svc.rate.upload.retryAfterMs(slot.principalId);
    if (pwait > 0) {
      svc.store.transitionSlot(slot.id, 'receiving', 'prepared');
      reply.header('retry-after', String(Math.ceil(pwait / 1000)));
      return send(
        reply,
        429,
        { error: 'rate_limited', message: 'Too many uploads by this connection; try again later.' },
        true,
      );
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > slot.byteLength) {
      svc.store.transitionSlot(slot.id, 'receiving', 'expired');
      o.audit?.(slot.principalId, 'image.upload_refused', slot.id, {
        reason: 'too_large',
        declared: Number(declared),
      });
      return send(
        reply,
        413,
        {
          error: 'too_large',
          message: `The body is declared longer than the ${slot.byteLength} bytes prepared; nothing was read.`,
        },
        true,
      );
    }
    try {
      const got = await svc.slots.receive(slot, req.raw, {
        bodyTimeoutMs: s.bodyTimeoutMs,
        idleTimeoutMs: s.idleTimeoutMs,
      });
      svc.rate.upload.hit(slot.principalId);
      o.audit?.(slot.principalId, 'image.upload_received', slot.id, { sha256: got.sha256, bytes: got.bytes });
      return send(reply, 201, {
        status: 'received',
        upload_id: slot.id,
        sha256: got.sha256,
        bytes: got.bytes,
      });
    } catch (e) {
      if (e instanceof ReceiveError) {
        o.audit?.(slot.principalId, 'image.upload_refused', slot.id, { reason: e.refusal });
        return send(reply, STATUS[e.refusal], { error: e.refusal, message: e.message }, true);
      }
      throw e;
    }
  });
  return Promise.resolve();
}

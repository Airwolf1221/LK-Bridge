/**
 * The single-use binary endpoint's slots (v2 D3, ADR 0041, PLAN-v2 4.10): `prepare_image_upload` makes one, the agent's
 * script sends the file to `POST /uploads/<upload_id>` with the capability in a header, and `upload_image` with the
 * `upload_id` consumes the file.
 *
 * - The capability is 256 random bits (base64url), handed out once and stored only as its SHA-256. It is bound to the
 *   upload id, the project, the principal, the file's SHA-256, its length and its type; it is good for ONE request,
 *   for 5 minutes. Any problem with it gets the same refusal (the endpoint never says which check failed).
 * - The body is streamed to a private temporary file (the bridge's `upload-tmp/` directory, mode 0700, files 0600, named
 *   by a random id, never by anything the caller sent) while it is hashed. It stops reading at length + 1 bytes.
 * - A received file waits at most 15 minutes for `upload_image`; then it and its slot expire. The directory is emptied
 *   at start-up and swept every minute.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream, readdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { detectImageType, ImageError, normaliseContentType } from './convert.js';
import type { ImageStore, UploadSlotRow } from './store.js';

export const CAPABILITY_TTL_MS = 5 * 60_000;
export const UNUSED_UPLOAD_TTL_MS = 15 * 60_000;
/** The header the capability travels in: `Authorization: Upload <token>`. */
export const CAPABILITY_SCHEME = 'Upload';

const ID = /^upl_[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const hashToken = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

export type ReceiveRefusal =
  /** The one generic refusal: missing, malformed, expired, used, unknown, or bound to something else. */
  | 'capability'
  | 'too_large'
  | 'too_small'
  | 'hash_mismatch'
  | 'type_mismatch'
  | 'timeout'
  | 'aborted'
  /** The bridge could not write the temporary file (disk full, quota, I/O): the slot is spent, nothing is kept. */
  | 'storage';

export class ReceiveError extends Error {
  constructor(
    readonly refusal: ReceiveRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'ReceiveError';
  }
}

export interface PreparedSlot {
  readonly uploadId: string;
  readonly token: string;
  readonly expiresAt: number;
  readonly tokenExpiresAt: number;
}

export class UploadSlots {
  /**
   * `dir` is created on the first binary upload, not here (ADR 0041): a runtime that never handles an upload touches no
   * folder at all, so one started where nothing may be written (the sandbox scripts, a read-only app folder) cannot
   * fail on it.
   */
  constructor(
    private readonly store: ImageStore,
    readonly dir: string,
  ) {}

  /** The files in the directory, or none when it has not been created yet. */
  private files(): string[] {
    try {
      return readdirSync(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  /** At start-up: every file in the directory is left over from a previous run (or junk): removed. */
  cleanAtStart(): number {
    this.store.resetReceiving();
    let n = 0;
    const live = this.store.liveFileNames();
    for (const f of this.files()) {
      if (live.has(f)) continue;
      rmSync(join(this.dir, f), { force: true, recursive: true });
      n++;
    }
    return n;
  }

  /** The regular sweep: expired slots lose their files; finished rows older than a day are pruned. */
  async sweep(): Promise<number> {
    const now = this.store.now();
    let n = 0;
    for (const s of this.store.expiredSlots(now)) {
      this.store.expireSlot(s.id);
      if (s.fileName) await rm(join(this.dir, s.fileName), { force: true });
      n++;
    }
    this.store.pruneSlots(now - 24 * 3_600_000);
    // Files no live slot names (a crash between writing and recording): removed too.
    const live = this.store.liveFileNames();
    for (const f of this.files()) {
      if (live.has(f) || f.endsWith('.part')) continue;
      rmSync(join(this.dir, f), { force: true });
    }
    return n;
  }

  prepare(p: {
    projectId: string;
    principalId: string;
    sha256: string;
    byteLength: number;
    contentType: string;
    name: string;
  }): PreparedSlot {
    const uploadId = `upl_${randomBytes(16).toString('base64url')}`;
    const token = randomBytes(32).toString('base64url');
    const now = this.store.now();
    const slot = {
      id: uploadId,
      projectId: p.projectId,
      principalId: p.principalId,
      tokenHash: hashToken(token),
      sha256: p.sha256.toLowerCase(),
      byteLength: p.byteLength,
      contentType: p.contentType,
      name: p.name,
      tokenExpiresAt: now + CAPABILITY_TTL_MS,
      expiresAt: now + UNUSED_UPLOAD_TTL_MS,
    };
    this.store.insertSlot(slot);
    return { uploadId, token, expiresAt: slot.expiresAt, tokenExpiresAt: slot.tokenExpiresAt };
  }

  /**
   * Checks the capability for a POST and claims the slot (prepared → receiving) so it can be used once only. Returns the
   * slot, or throws the generic refusal.
   */
  claim(uploadId: string, authorization: string | undefined): UploadSlotRow {
    const generic = () =>
      new ReceiveError(
        'capability',
        'The upload was refused: no valid upload capability for this upload id.',
      );
    if (!ID.test(uploadId)) throw generic();
    const m = /^Upload ([A-Za-z0-9_-]+)$/.exec((authorization ?? '').trim());
    if (!m || !TOKEN.test(m[1]!)) throw generic();
    const slot = this.store.slot(uploadId);
    const now = this.store.now();
    if (!slot || slot.state !== 'prepared' || slot.tokenExpiresAt <= now) throw generic();
    const a = Buffer.from(hashToken(m[1]!), 'hex');
    const b = Buffer.from(slot.tokenHash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw generic();
    if (!this.store.transitionSlot(uploadId, 'prepared', 'receiving')) throw generic();
    return slot;
  }

  /**
   * Streams the body into a private temporary file while hashing it; checks the length (stopping at length + 1), the
   * SHA-256 and the magic-byte type against what the slot was prepared with. On any refusal the file is removed and the
   * slot is spent (a new `prepare_image_upload` is needed).
   */
  async receive(
    slot: UploadSlotRow,
    body: Readable,
    o: { readonly bodyTimeoutMs: number; readonly idleTimeoutMs: number },
  ): Promise<{ sha256: string; bytes: number }> {
    const fileName = `${randomBytes(16).toString('hex')}.bin`;
    const part = join(this.dir, `${fileName}.part`);
    const storage = () =>
      new ReceiveError(
        'storage',
        'The bridge could not store the upload; nothing was kept. Prepare a new one later.',
      );
    // The first upload creates the directory (private: 0700); later ones find it.
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
    } catch {
      this.store.transitionSlot(slot.id, 'receiving', 'expired'); // the slot is spent, as for any other refusal
      throw storage();
    }
    const out = createWriteStream(part, { mode: 0o600, flags: 'wx' });
    // An I/O error on the file (ENOSPC, EDQUOT, EIO, EMFILE) must never be an unhandled 'error' event.
    let outError: Error | null = null;
    let onOutError: (() => void) | null = null;
    out.on('error', (e) => {
      outError = e;
      onOutError?.();
    });
    const hash = createHash('sha256');
    const head: Buffer[] = [];
    let headLen = 0;
    let size = 0;
    const fail = async (e: ReceiveError): Promise<never> => {
      out.destroy();
      await rm(part, { force: true });
      this.store.transitionSlot(slot.id, 'receiving', 'expired');
      throw e;
    };
    try {
      await new Promise<void>((resolve, reject) => {
        let done = false;
        let idle: NodeJS.Timeout | undefined;
        const finish = (err?: ReceiveError) => {
          if (done) return;
          done = true;
          clearTimeout(total);
          clearTimeout(idle);
          body.removeListener('data', onData);
          body.removeListener('end', onEnd);
          body.removeListener('error', onError);
          body.removeListener('aborted', onAborted);
          body.removeListener('close', onClose);
          if (err) {
            body.resume();
            reject(err);
          } else resolve();
        };
        const armIdle = () => {
          clearTimeout(idle);
          idle = setTimeout(
            () =>
              finish(
                new ReceiveError('timeout', `No data for ${o.idleTimeoutMs} ms; the upload was dropped.`),
              ),
            o.idleTimeoutMs,
          );
        };
        const total = setTimeout(
          () =>
            finish(
              new ReceiveError(
                'timeout',
                `The body was not complete within ${o.bodyTimeoutMs} ms; it was dropped.`,
              ),
            ),
          o.bodyTimeoutMs,
        );
        armIdle();
        const onData = (chunk: Buffer) => {
          size += chunk.length;
          if (size > slot.byteLength) {
            finish(
              new ReceiveError(
                'too_large',
                `The body is longer than the ${slot.byteLength} bytes declared; reading stopped there.`,
              ),
            );
            return;
          }
          hash.update(chunk);
          if (headLen < 16) {
            head.push(chunk);
            headLen += chunk.length;
          }
          armIdle();
          if (!out.write(chunk)) {
            body.pause();
            out.once('drain', () => body.resume());
          }
        };
        onOutError = () => finish(storage());
        const onEnd = () => finish();
        const onError = () => finish(new ReceiveError('aborted', 'The upload connection failed.'));
        const onAborted = () => finish(new ReceiveError('aborted', 'The client aborted the upload.'));
        const onClose = () => {
          if (!done && !body.readableEnded)
            finish(new ReceiveError('aborted', 'The client closed the connection.'));
        };
        body.on('data', onData);
        body.on('end', onEnd);
        body.on('error', onError);
        body.on('aborted', onAborted);
        body.on('close', onClose);
      });
    } catch (e) {
      return fail(e instanceof ReceiveError ? e : new ReceiveError('aborted', 'The upload failed.'));
    }
    onOutError = null;
    try {
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve())),
      );
      if (outError !== null) throw new Error('the temporary file could not be written');
    } catch {
      return fail(storage());
    }
    if (size !== slot.byteLength) {
      return fail(
        new ReceiveError('too_small', `The body is ${size} bytes; ${slot.byteLength} were declared.`),
      );
    }
    const sha = hash.digest('hex');
    if (sha !== slot.sha256) {
      return fail(new ReceiveError('hash_mismatch', 'The body’s SHA-256 is not the one declared.'));
    }
    let detected: string;
    try {
      detected = detectImageType(Buffer.concat(head)).contentType;
    } catch (e) {
      return fail(
        new ReceiveError('type_mismatch', e instanceof ImageError ? e.message : 'The body is not an image.'),
      );
    }
    if (detected !== normaliseContentType(slot.contentType)) {
      return fail(
        new ReceiveError(
          'type_mismatch',
          `The body is ${detected} by its first bytes; ${slot.contentType} was declared.`,
        ),
      );
    }
    try {
      await rename(part, join(this.dir, fileName));
    } catch {
      return fail(storage());
    }
    if (
      !this.store.transitionSlot(slot.id, 'receiving', 'received', {
        fileName,
        receivedAt: this.store.now(),
      })
    ) {
      await rm(join(this.dir, fileName), { force: true });
      throw new ReceiveError(
        'capability',
        'The upload was refused: no valid upload capability for this upload id.',
      );
    }
    return { sha256: sha, bytes: size };
  }

  /** The slot of an upload id, if this principal may use it in this project. */
  slotFor(uploadId: string, projectId: string, principalId: string): UploadSlotRow | null {
    if (!ID.test(uploadId)) return null;
    const s = this.store.slot(uploadId);
    if (!s || s.projectId !== projectId || s.principalId !== principalId) return null;
    return s;
  }

  /** Reads a received file (checking its hash again). Does not consume it. */
  async read(slot: UploadSlotRow): Promise<Buffer | null> {
    if (slot.state !== 'received' || !slot.fileName || slot.expiresAt <= this.store.now()) return null;
    try {
      const b = await readFile(join(this.dir, slot.fileName));
      return createHash('sha256').update(b).digest('hex') === slot.sha256 ? b : null;
    } catch {
      return null;
    }
  }

  /** v2 E4 (RV1-2): the upload ids an `upload_image` call is using now (in process; released when the call ends). */
  private readonly inUse = new Set<string>();

  /** Takes an upload id for one call; false when another call holds it. Synchronous, so two calls cannot both take it. */
  hold(uploadId: string): boolean {
    if (this.inUse.has(uploadId)) return false;
    this.inUse.add(uploadId);
    return true;
  }

  release(uploadId: string): void {
    this.inUse.delete(uploadId);
  }

  /** Marks a received file used (once) and removes it. False when another call got there first. */
  async consume(slot: UploadSlotRow): Promise<boolean> {
    const ok = this.store.transitionSlot(slot.id, 'received', 'consumed', { consumedAt: this.store.now() });
    if (ok && slot.fileName) await rm(join(this.dir, slot.fileName), { force: true });
    return ok;
  }
}

/**
 * v3 F7c (ADR 0075; the owner-approved design LK-Bridge-F7c-art-archives-design.md, Z1 to Z10): image archives.
 *
 * Everything here is server-local: nothing reaches LegendKeeper until a placement job runs.
 *
 * - **Intake** (`ingest`): an uploaded zip (ChatGPT's `file`, or a prepared binary upload) is hashed and kept under a
 *   bridge-chosen name (images/archives/<id>.zip). The same zip again (same SHA-256 in the project) is the same archive:
 *   same id, same entries, nothing staged twice. A new one is LISTED at once (src/images/archive-zip.ts: path, folder,
 *   format, size, SHA-256 from the headers and a hash pass); nothing is converted and nothing counts against the
 *   staging limits until an entry is used (an art call names it) or `stageAll` asks for them all (Z9.1).
 * - **Staging** (the worker): an entry asked for is queued, converted through the image service's ConversionQueue (no
 *   second pool: at most IMAGE_CONVERT_CONCURRENCY at once) and staged on the server as any single upload is. Three
 *   limits are kept apart (Z9.5): the staging capacity (IMAGE_STAGED_MAX_BYTES, and the disk's headroom), the CPU (the
 *   queue), and LegendKeeper's budgets (the governor, untouched here). An entry past the runaway brake
 *   (IMAGE_UPLOAD_RATE_PER_PRINCIPAL) or the capacity is HELD, never refused: the worker stages held entries in archive
 *   order as the hour moves on or space frees, and its records are in the database, so a restart resumes it.
 * - **Failures** (Z9.3): an entry whose conversion fails is `failed` with its reason; every other entry keeps its state.
 *   A transient failure (a timeout, a busy converter, an I/O error) is retried once automatically; after that,
 *   `retry` (bridge_archive_status) retries just those entries. Nothing already staged is redone.
 * - **Art** (Z4): an art call names `{ archive: { id, entry } }`. A staged entry is its staged image. Any other entry
 *   not refused is asked for and given a reserved staged id: the call plans from its header, its proposal names that id,
 *   and the approved job waits (`waiting_staging`) until it is staged; an entry refused or discarded meanwhile withdraws
 *   that image only (`StepOptions.bindStaged`).
 * - **Lifetime** (Z6): the server copy goes when every entry is staged, refused or a duplicate; when the archive is
 *   discarded; or after the staging expiry from its last activity, never while a proposal or job waits for one of its
 *   entries (Z5: pinned).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../db/open.js';
import {
  TERMINAL_JOB_STATUSES,
  type JobEngine,
  type StagedBinding,
  type WaitForShape,
} from '../jobs/index.js';
import { ArchiveError, baseNameOf, listArchive, readArchiveEntry, type ListedEntry } from './archive-zip.js';
import {
  ArchiveStore,
  type ArchiveRow,
  type EntryLink,
  type EntryRow,
  type EntryStatus,
} from './archive-store.js';
import { displayNameOf, ImageError } from './convert.js';
import { ImageServiceError, newStagedId, type ImageService } from './service.js';

const DAY = 86_400_000;
const newArchiveId = () => `arc_${randomBytes(12).toString('base64url')}`;

/** Entries that need nothing more from the server copy. */
const SETTLED: ReadonlySet<EntryStatus> = new Set(['staged', 'refused', 'duplicate', 'discarded']);
/** Entries an art call can still have staged. */
const STAGEABLE: ReadonlySet<EntryStatus> = new Set(['listed', 'queued', 'converting', 'held', 'failed']);
/** Conversion failures retried once automatically. */
const TRANSIENT = new Set(['IMAGE_CONVERT_TIMEOUT', 'IMAGE_CONVERTER_BUSY', 'IO_ERROR']);

export interface ArchiveServiceOptions {
  readonly db: Db;
  readonly now: () => number;
  readonly engine?: Pick<JobEngine, 'poke' | 'setWaitForCheck' | 'setStagedResolver' | 'queries'>;
  readonly proposals?: {
    get(id: string): { readonly state: string; readonly jobId: string | null } | undefined;
  };
  readonly log?: { warn(obj: Record<string, unknown>, msg: string): void };
}

/** The ways an archive arrives. */
export type ArchiveSource = 'chatgpt_file' | 'upload_id' | 'dashboard';

/** What an art call gets for `{ archive: { id, entry } }`. */
export type ArtEntry =
  | { readonly kind: 'staged'; readonly stagedId: string; readonly entry: EntryRow }
  | {
      readonly kind: 'pending';
      /** The staged id reserved for it (its proposal and job name it from the start). */
      readonly stagedId: string;
      readonly entry: EntryRow;
    }
  | { readonly kind: 'unavailable'; readonly code: string; readonly message: string };

/** The folder name for display: separators normalised (`Consort-Maid` → `Consort Maid`); null at the top level. */
export function suggestedOutfitOf(folder: string | null): string | null {
  if (folder === null) return null;
  const last = folder.split('/').filter(Boolean).pop() ?? '';
  const n = last
    .replace(/[_\-.+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return n === '' ? null : n;
}

export class ArchiveService {
  readonly store: ArchiveStore;
  /** Where server copies are kept (bridge-chosen names only). */
  readonly dir: string;
  /** Where an incoming archive is written before it is known (a download, a moved binary upload). */
  readonly tmpDir: string;
  private current: Promise<number> | null = null;
  private stopped = false;
  /** Archives whose entries were staged in this pass (their server copy may go now). */
  private readonly touched = new Set<string>();
  private again = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly detach: (() => void)[] = [];
  /** Bytes admitted for conversion and not yet staged (so two conversions cannot both take the last room). */
  private inflightBytes = 0;

  constructor(
    private readonly images: ImageService,
    private readonly o: ArchiveServiceOptions,
  ) {
    this.store = new ArchiveStore(o.db, o.now);
    this.dir = join(images.dir, 'archives');
    this.tmpDir = join(images.dir, 'archive-tmp');
  }

  // ============================================================================================ lifecycle

  start(timers: boolean): void {
    this.stopped = false;
    const reset = this.store.resetConverting();
    if (reset > 0) this.o.log?.warn({ reset }, 'archive conversions cut short by a stop are queued again');
    if (this.o.engine) {
      this.detach.push(this.o.engine.setWaitForCheck((w) => this.waitMessage(w), 'archive_staging'));
      this.detach.push(this.o.engine.setStagedResolver((p, id) => this.binding(p, id)));
    }
    // A staged image placed or discarded frees space: held entries may go now.
    this.detach.push(
      this.images.store.onChange((after, before) => {
        if (before?.staged && !after.staged) this.kick();
      }),
    );
    if (timers) {
      this.timer = setInterval(() => this.kick(), 60_000);
      this.timer.unref();
    }
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const d of this.detach.splice(0)) d();
  }

  private get settings() {
    return this.images.settings;
  }

  // ============================================================================================ intake

  /** A fresh temporary path for an incoming archive (the caller writes it; `ingest` takes it over). */
  async tempPath(): Promise<string> {
    await mkdir(this.tmpDir, { recursive: true, mode: 0o700 });
    return join(this.tmpDir, `${randomBytes(16).toString('hex')}.zip`);
  }

  private async hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
    const h = createHash('sha256');
    let bytes = 0;
    await new Promise<void>((resolve, reject) => {
      const s = createReadStream(path);
      s.on('data', (c: Buffer | string) => {
        const b = typeof c === 'string' ? Buffer.from(c) : c;
        bytes += b.length;
        h.update(b);
      });
      s.on('error', reject);
      s.on('end', () => resolve());
    });
    return { sha256: h.digest('hex'), bytes };
  }

  /**
   * Takes an uploaded archive at `tmpPath` (moved, or removed when it is a repeat): lists it (a new one), or returns the
   * archive it already is. Throws `ArchiveError` for an unreadable zip or one past the caps (nothing is kept).
   */
  async ingest(p: {
    readonly projectId: string;
    readonly principalId: string;
    readonly source: ArchiveSource;
    readonly fileName: string | null;
    readonly tmpPath: string;
    readonly workstream?: string | null;
  }): Promise<{ archive: ArchiveRow; entries: EntryRow[]; repeat: boolean }> {
    let kept = false;
    try {
      const { sha256, bytes } = await this.hashFile(p.tmpPath);
      const limits = this.settings.images;
      if (bytes > limits.archiveMaxUncompressedBytes)
        throw new ArchiveError(
          'ARCHIVE_TOO_LARGE',
          `The archive is ${bytes} bytes, more than IMAGE_ARCHIVE_MAX_UNCOMPRESSED_BYTES (${limits.archiveMaxUncompressedBytes}). Nothing was staged: split it.`,
        );
      const known = this.store.bySha(p.projectId, sha256);
      if (known) {
        // Z9.2: the same zip again is the same archive. A server copy that is gone but still needed comes back.
        const entries = this.store.entries(known.id);
        const needsCopy = entries.some((e) => !SETTLED.has(e.status) || known.state === 'discarded');
        if (known.state === 'discarded' || known.state === 'expired') {
          for (const e of entries)
            if (e.status === 'discarded')
              this.store.updateEntry(e.archiveId, e.seq, {
                status: 'listed',
                reasonCode: null,
                reason: null,
                heldBy: null,
                expectedAt: null,
                attempts: 0,
              });
          this.store.updateArchive(known.id, { state: 'open', discardedBy: null, removedAt: null });
        }
        if (!known.serverFile && (needsCopy || known.state !== 'open')) {
          const name = `${known.id}.zip`;
          await mkdir(this.dir, { recursive: true, mode: 0o700 });
          await rename(p.tmpPath, join(this.dir, name));
          kept = true;
          this.store.updateArchive(known.id, { serverFile: name, removedAt: null });
        }
        this.store.touch(known.id);
        await this.finishIfSettled(known.id);
        return {
          archive: this.store.archive(known.id)!,
          entries: this.store.entries(known.id),
          repeat: true,
        };
      }
      const listing = await listArchive(p.tmpPath, bytes, {
        maxEntries: limits.archiveMaxEntries,
        maxUncompressedBytes: limits.archiveMaxUncompressedBytes,
        maxEntryBytes: this.settings.upload.maxBytes,
        maxPixels: limits.maxPixels,
        maxFrames: limits.maxFrames,
      });
      const id = newArchiveId();
      const name = `${id}.zip`;
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await rename(p.tmpPath, join(this.dir, name));
      kept = true;
      this.store.insertArchive({
        id,
        projectId: p.projectId,
        sha256,
        bytes,
        fileName: p.fileName,
        principalId: p.principalId,
        source: p.source,
        workstream: p.workstream ?? null,
        state: 'open',
        serverFile: name,
        entryCount: listing.entries.length,
        skipped: listing.skipped,
        uncompressedBytes: listing.uncompressedBytes,
      });
      this.store.insertEntries(this.rowsOf(id, p.projectId, listing.entries));
      await this.finishIfSettled(id);
      return { archive: this.store.archive(id)!, entries: this.store.entries(id), repeat: false };
    } finally {
      if (!kept) await rm(p.tmpPath, { force: true }).catch(() => undefined);
    }
  }

  /** The rows of a new listing: refusals, duplicates within it, and entries whose bytes are already staged (reused). */
  private rowsOf(
    archiveId: string,
    projectId: string,
    listed: readonly ListedEntry[],
  ): Parameters<ArchiveStore['insertEntries']>[0] {
    const firstBySha = new Map<string, number>();
    return listed.map((e) => {
      const base = {
        archiveId,
        seq: e.seq,
        projectId,
        path: e.path,
        folder: e.folder,
        sha256: e.sha256,
        bytes: e.bytes,
        compressedBytes: e.compressedBytes,
        format: e.format,
        width: e.width,
        height: e.height,
        frames: e.frames,
        heldBy: null,
        expectedAt: null,
        duplicateOf: null,
        stagedId: null,
      };
      if (e.refused)
        return { ...base, status: 'refused' as const, reasonCode: e.refused.code, reason: e.refused.message };
      const first = firstBySha.get(e.sha256!);
      if (first !== undefined)
        return {
          ...base,
          status: 'duplicate' as const,
          duplicateOf: first,
          reasonCode: null,
          reason: null,
        };
      firstBySha.set(e.sha256!, e.seq);
      // Z9.2: an entry whose bytes are already staged reuses that staged image.
      const dup = this.images.findDuplicate(projectId, e.sha256!);
      if (dup && dup.staged && dup.serverSha256 && dup.state === 'uploaded')
        return { ...base, status: 'staged' as const, stagedId: dup.id, reasonCode: null, reason: null };
      return { ...base, status: 'listed' as const, reasonCode: null, reason: null };
    });
  }

  // ============================================================================================ asking for entries

  /**
   * Asks for entries to be staged (`stageAll`, or an art call): listed ones are queued; a failed one is queued again
   * only through `retry`. Returns the entries asked for as they now are.
   */
  request(archiveId: string, seqs: readonly number[] | 'all'): EntryRow[] {
    const all = this.store.entries(archiveId);
    const want = seqs === 'all' ? all : all.filter((e) => seqs.includes(e.seq));
    const now = this.o.now();
    for (const e of want)
      if (e.status === 'listed')
        this.store.updateEntry(e.archiveId, e.seq, { status: 'queued', wantedAt: now, attempts: 0 });
    this.store.touch(archiveId);
    this.kick();
    return this.store.entries(archiveId).filter((e) => want.some((w) => w.seq === e.seq));
  }

  /** Z9.3: retries failed entries (by path or base name). Each answer says what happened to it. */
  retry(
    archiveId: string,
    names: readonly string[],
  ): { entry: string; outcome: 'queued' | 'not_failed' | 'not_found' | 'ambiguous'; status?: string }[] {
    const out: {
      entry: string;
      outcome: 'queued' | 'not_failed' | 'not_found' | 'ambiguous';
      status?: string;
    }[] = [];
    const now = this.o.now();
    for (const n of names) {
      const found = this.find(archiveId, n);
      if (found.kind !== 'one') {
        out.push({ entry: n, outcome: found.kind === 'none' ? 'not_found' : 'ambiguous' });
        continue;
      }
      const e = found.entry;
      if (e.status !== 'failed') {
        out.push({ entry: n, outcome: 'not_failed', status: e.status });
        continue;
      }
      this.store.updateEntry(e.archiveId, e.seq, {
        status: 'queued',
        wantedAt: now,
        attempts: 0,
        reasonCode: null,
        reason: null,
      });
      out.push({ entry: n, outcome: 'queued' });
    }
    this.store.touch(archiveId);
    this.kick();
    return out;
  }

  /** An entry by its path, else by its base name when only one entry has it. */
  find(
    archiveId: string,
    name: string,
  ): { kind: 'one'; entry: EntryRow } | { kind: 'none' } | { kind: 'ambiguous'; paths: string[] } {
    const all = this.store.entries(archiveId);
    const exact = all.find((e) => e.path === name);
    if (exact) return { kind: 'one', entry: exact };
    const byBase = all.filter((e) => baseNameOf(e.path) === name);
    if (byBase.length === 1) return { kind: 'one', entry: byBase[0]! };
    if (byBase.length > 1) return { kind: 'ambiguous', paths: byBase.map((e) => e.path) };
    return { kind: 'none' };
  }

  /**
   * Z4: what an art call gets for `{ archive: { id, entry } }`. A not-yet-staged entry is asked for and given its
   * reserved staged id (the same one every time it is named).
   */
  forArt(projectId: string, ref: { readonly id: string; readonly entry: string }): ArtEntry {
    const a = this.store.archive(ref.id);
    if (!a || a.projectId !== projectId)
      return {
        kind: 'unavailable',
        code: 'ARCHIVE_NOT_FOUND',
        message: `No archive ${ref.id} in this project (upload it with upload_image_archive).`,
      };
    const found = this.find(a.id, ref.entry);
    if (found.kind === 'none')
      return {
        kind: 'unavailable',
        code: 'ARCHIVE_ENTRY_NOT_FOUND',
        message: `Archive ${a.id} has no entry “${ref.entry}” (give its path or base name, as bridge_archive_status lists it).`,
      };
    if (found.kind === 'ambiguous')
      return {
        kind: 'unavailable',
        code: 'ARCHIVE_ENTRY_AMBIGUOUS',
        message: `“${ref.entry}” names ${found.paths.length} entries of archive ${a.id}: give the path (${found.paths.join(', ')}).`,
      };
    let e = found.entry;
    if (e.status === 'duplicate' && e.duplicateOf !== null) e = this.store.entry(a.id, e.duplicateOf) ?? e;
    if (e.status === 'staged' && e.stagedId) {
      const row = this.images.staged(projectId, e.stagedId);
      if (row?.staged && row.state === 'uploaded') return { kind: 'staged', stagedId: row.id, entry: e };
      return {
        kind: 'unavailable',
        code: 'ARCHIVE_ENTRY_NOT_STAGED_NOW',
        message: `${e.path}'s staged image ${e.stagedId} is ${row ? (row.staged ? row.state : 'placed or discarded') : 'gone'}: it is not staged any more.`,
      };
    }
    if (e.status === 'refused')
      return {
        kind: 'unavailable',
        code: 'ARCHIVE_ENTRY_REFUSED',
        message: `${e.path} was refused (${e.reasonCode}: ${e.reason}).`,
      };
    if (e.status === 'discarded')
      return {
        kind: 'unavailable',
        code: 'ARCHIVE_ENTRY_DISCARDED',
        message: `${e.path} was discarded with its archive${e.reason ? ` (${e.reason})` : ''}.`,
      };
    if (!STAGEABLE.has(e.status))
      return { kind: 'unavailable', code: 'ARCHIVE_ENTRY_UNAVAILABLE', message: `${e.path} is ${e.status}.` };
    if (!a.serverFile)
      return {
        kind: 'unavailable',
        code: 'ARCHIVE_GONE',
        message: `Archive ${a.id}'s server copy is gone; upload the same zip again (it keeps its id).`,
      };
    if (e.status === 'failed')
      return {
        kind: 'unavailable',
        code: 'ARCHIVE_ENTRY_FAILED',
        message: `${e.path} failed to convert (${e.reasonCode}: ${e.reason}). Retry it with bridge_archive_status { "archive_id": "${a.id}", "retry": ["${e.path}"] }, then call again.`,
      };
    const stagedId = e.stagedId ?? newStagedId();
    const now = this.o.now();
    this.store.updateEntry(a.id, e.seq, {
      stagedId,
      ...(e.status === 'listed' ? { status: 'queued' as const, wantedAt: now, attempts: 0 } : {}),
    });
    this.store.touch(a.id);
    this.kick();
    return { kind: 'pending', stagedId, entry: this.store.entry(a.id, e.seq)! };
  }

  /**
   * Z4: a placement (an art package's proposal or job) waits for the staged image of a reserved id: recorded on its
   * entry (which is pinned while it waits), and put on the image's record once it is staged.
   */
  link(projectId: string, stagedId: string, link: EntryLink): boolean {
    const row = this.images.store.upload(projectId, stagedId);
    if (row) return false; // staged already: the caller's own update covers it
    const e = this.store.byStagedId(projectId, stagedId);
    if (!e) return false;
    const links = [
      ...e.links.filter((l) => l.proposalId !== link.proposalId || l.jobId !== link.jobId),
      link,
    ];
    this.store.updateEntry(e.archiveId, e.seq, { links });
    return true;
  }

  // ============================================================================================ the worker

  /** Runs the worker soon (an entry was asked for, or space or the hour may have freed). */
  kick(): void {
    if (this.stopped) return;
    void this.work().catch((err: unknown) => this.o.log?.warn({ err }, 'the archive worker failed'));
  }

  /** Stages what can be staged now. Returns how many entries were staged. One run at a time. */
  async work(): Promise<number> {
    if (this.stopped) return 0;
    // A pass under way runs once more when it ends (something changed meanwhile); this call waits for it.
    if (this.current) {
      this.again = true;
      return this.current;
    }
    const run = async () => {
      let n = 0;
      try {
        do {
          this.again = false;
          n += await this.workOnce();
        } while (this.again);
      } finally {
        this.current = null;
      }
      return n;
    };
    this.current = run();
    return this.current;
  }

  private async workOnce(): Promise<number> {
    const waiting = this.store.waiting();
    if (waiting.length === 0) return 0;
    // Admission, synchronously and in order: the brake per principal, then the capacity (an entry that does not fit
    // holds back the rest of its archive, so entries are staged in archive order).
    const admitted: EntryRow[] = [];
    const heldRate = new Map<string, number>();
    const fullArchives = new Set<string>();
    const room = this.images.stagingRoom();
    let free = room.free - this.inflightBytes;
    for (const e of waiting) {
      const a = this.store.archive(e.archiveId);
      if (!a?.serverFile) {
        this.store.updateEntry(e.archiveId, e.seq, {
          status: 'failed',
          heldBy: null,
          expectedAt: null,
          reasonCode: 'ARCHIVE_GONE',
          reason: 'the archive’s server copy is gone; upload the same zip again',
        });
        continue;
      }
      const principal = a.principalId;
      const k = heldRate.get(principal);
      if (k !== undefined || this.images.brakeWaitMs(principal) > 0) {
        const nth = k ?? 0;
        heldRate.set(principal, nth + 1);
        this.hold(e, 'rate', this.images.rate.stage.availableAt(principal, nth));
        continue;
      }
      if (fullArchives.has(e.archiveId) || e.bytes > free) {
        fullArchives.add(e.archiveId);
        this.hold(e, 'storage', null);
        continue;
      }
      free -= e.bytes;
      this.inflightBytes += e.bytes;
      if (principal !== 'owner' && principal !== 'system') this.images.rate.stage.hit(principal);
      admitted.push(e);
    }
    // Conversions, at most IMAGE_CONVERT_CONCURRENCY at once (through the image service's own queue).
    const limit = Math.max(1, this.settings.images.convertConcurrency);
    let staged = 0;
    let next = 0;
    const lane = async () => {
      while (next < admitted.length && !this.stopped) {
        const e = admitted[next++]!;
        try {
          if (await this.stageEntry(e)) staged++;
        } finally {
          this.inflightBytes = Math.max(0, this.inflightBytes - e.bytes);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, admitted.length) }, lane));
    for (const id of [...this.touched]) {
      this.touched.delete(id);
      await this.finishIfSettled(id);
    }
    if (staged > 0) this.o.engine?.poke();
    return staged;
  }

  private hold(e: EntryRow, by: 'rate' | 'storage', at: number | null): void {
    if (e.status === 'held' && e.heldBy === by && e.expectedAt === at) return;
    this.store.updateEntry(e.archiveId, e.seq, { status: 'held', heldBy: by, expectedAt: at });
  }

  /** Converts and stages one admitted entry. True when it is staged. */
  private async stageEntry(e0: EntryRow): Promise<boolean> {
    const e = this.store.entry(e0.archiveId, e0.seq);
    const a = this.store.archive(e0.archiveId);
    if (!e || !a?.serverFile || (e.status !== 'queued' && e.status !== 'held')) return false;
    // Bytes already staged in this project are reused (Z9.2), unless the entry's id was reserved by an art call.
    if (!e.stagedId) {
      const dup = e.sha256 ? this.images.findDuplicate(a.projectId, e.sha256) : null;
      if (dup && dup.staged && dup.serverSha256 && dup.state === 'uploaded') {
        this.settleStaged(a, e, dup.id);
        return true;
      }
    }
    this.store.updateEntry(e.archiveId, e.seq, { status: 'converting', heldBy: null, expectedAt: null });
    try {
      const bytes = await readArchiveEntry(
        join(this.dir, a.serverFile),
        { seq: e.seq, path: e.path, sha256: e.sha256! },
        this.settings.upload.maxBytes,
      );
      const img = await this.images.convert(bytes);
      const id = e.stagedId ?? newStagedId();
      const row = await this.images.stageOnServer({
        projectId: a.projectId,
        image: img,
        name: displayNameOf(baseNameOf(e.path)),
        intended: { archive: { id: a.id, entry: e.path } },
        source: 'archive',
        origin: {
          kind: 'system',
          tool: 'images.archive',
          principal: { principalId: a.principalId, profile: 'archive', label: 'image archive' },
        },
        id,
        allowanceTaken: true,
      });
      this.settleStaged(a, e, row.id);
      return true;
    } catch (err) {
      this.failEntry(e, err);
      return false;
    }
  }

  /** An entry staged (or reusing a staged image): its waiting placements are put on the image's record. */
  private settleStaged(a: ArchiveRow, e: EntryRow, stagedId: string): void {
    this.store.updateEntry(e.archiveId, e.seq, {
      status: 'staged',
      stagedId,
      heldBy: null,
      expectedAt: null,
      reasonCode: null,
      reason: null,
    });
    const live = e.links.filter((l) => this.linkOpen(a.projectId, l));
    for (const l of live) {
      const row = this.images.store.upload(a.projectId, stagedId);
      if (!row) break;
      const jobId = l.jobId ?? (l.proposalId ? (this.o.proposals?.get(l.proposalId)?.jobId ?? null) : null);
      this.images.store.updateUpload(a.projectId, stagedId, {
        ...(jobId ? { placementJobId: jobId } : { placementProposalId: l.proposalId! }),
        intended: { ...(row.intended ?? {}), ...(l.placing ? { placing: l.placing } : {}) },
        error: null,
      });
    }
    if (live.length !== e.links.length || live.length > 0)
      this.store.updateEntry(e.archiveId, e.seq, { links: [] });
    this.store.touch(a.id);
    this.touched.add(a.id);
  }

  private failEntry(e: EntryRow, err: unknown): void {
    // The limits first: a staging that would pass them now waits (held), never fails.
    if (err instanceof ImageServiceError) {
      if (err.code === 'RATE_LIMITED') {
        const s = Number((err.details as { retryAfterSeconds?: unknown }).retryAfterSeconds ?? 60);
        this.store.updateEntry(e.archiveId, e.seq, {
          status: 'held',
          heldBy: 'rate',
          expectedAt: this.o.now() + s * 1000,
        });
        return;
      }
      if (err.code === 'STAGING_FULL' || err.code === 'STAGING_DISK_LOW') {
        this.store.updateEntry(e.archiveId, e.seq, { status: 'held', heldBy: 'storage', expectedAt: null });
        return;
      }
    }
    const code =
      err instanceof ImageError || err instanceof ImageServiceError || err instanceof ArchiveError
        ? err.code
        : 'IO_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    const attempts = e.attempts + 1;
    // Z9.3: a transient failure is retried once automatically; any other, or a second, leaves it failed.
    if (TRANSIENT.has(code) && attempts < 2) {
      this.store.updateEntry(e.archiveId, e.seq, {
        status: 'queued',
        attempts,
        reasonCode: code,
        reason: `retrying once after: ${message}`,
      });
      this.again = true;
      return;
    }
    this.store.updateEntry(e.archiveId, e.seq, {
      status: 'failed',
      attempts,
      heldBy: null,
      expectedAt: null,
      reasonCode: code,
      reason: message.slice(0, 500),
    });
    this.o.engine?.poke();
  }

  // ============================================================================================ jobs waiting for entries

  /** Whether a placement waiting for an entry is still open (its proposal pending or approved, its job not ended). */
  private linkOpen(projectId: string, l: EntryLink): boolean {
    if (l.jobId) {
      const j = this.jobView(projectId, l.jobId);
      return j === undefined || !TERMINAL_JOB_STATUSES.has(j.status);
    }
    if (l.proposalId) {
      const p = this.o.proposals?.get(l.proposalId);
      if (!p) return true;
      if (p.jobId) {
        const j = this.jobView(projectId, p.jobId);
        return j === undefined || !TERMINAL_JOB_STATUSES.has(j.status);
      }
      return p.state === 'pending' || p.state === 'approved';
    }
    return false;
  }

  private jobView(projectId: string, jobId: string) {
    try {
      return this.o.engine?.queries.getJob(projectId, jobId);
    } catch {
      return undefined;
    }
  }

  /** What a staged id is now (the engine's `bindStaged`). */
  binding(projectId: string, stagedId: string): StagedBinding {
    const row = this.images.store.upload(projectId, stagedId);
    if (row && row.state === 'uploaded')
      return {
        kind: 'staged',
        contentLength: row.webp.bytes,
        contentHash: row.webp.sha256,
        stagedSha256: row.serverSha256 ?? row.webp.sha256,
      };
    if (row && (row.state === 'discarded' || row.state === 'failed'))
      return { kind: 'withdrawn', reason: `its staged image ${stagedId} was ${row.state}` };
    const e = this.store.byStagedId(projectId, stagedId);
    if (!e) return { kind: 'withdrawn', reason: `no archive entry or staged image ${stagedId}` };
    if (e.status === 'refused')
      return {
        kind: 'withdrawn',
        reason: `archive entry ${e.path} was refused (${e.reasonCode}: ${e.reason})`,
      };
    if (e.status === 'discarded')
      return { kind: 'withdrawn', reason: `archive entry ${e.path} was discarded` };
    if (e.status === 'failed')
      return {
        kind: 'pending',
        reason: `archive entry ${e.path} failed to convert (${e.reasonCode}: ${e.reason}); retry it with bridge_archive_status, or discard the archive to place the rest`,
      };
    return { kind: 'pending', reason: `archive entry ${e.path} is ${this.statusWords(e)}` };
  }

  /** The engine's `waitFor` check for `archive_staging`: null when every entry is staged or withdrawn. */
  waitMessage(w: WaitForShape): string | null {
    if (w.kind !== 'archive_staging') return null;
    const waits: string[] = [];
    for (const id of w.stagedIds) {
      const b = this.binding(w.projectId, id);
      if (b.kind === 'pending') waits.push(b.reason);
    }
    if (waits.length === 0) return null;
    return `waiting_staging: ${waits.length} archive entr${waits.length === 1 ? 'y is' : 'ies are'} not staged yet (${waits.slice(0, 3).join('; ')}${waits.length > 3 ? '; …' : ''}). Held entries finish on their own; see bridge_archive_status.`;
  }

  private statusWords(e: EntryRow): string {
    switch (e.status) {
      case 'held':
        return e.heldBy === 'rate'
          ? `waiting for the hour's brake (IMAGE_UPLOAD_RATE_PER_PRINCIPAL)${e.expectedAt ? `, expected ${new Date(e.expectedAt).toISOString()}` : ''}`
          : 'waiting for staging space (IMAGE_STAGED_MAX_BYTES)';
      case 'queued':
        return 'queued for conversion';
      case 'converting':
        return 'converting';
      case 'listed':
        return 'listed (not asked for)';
      default:
        return e.status;
    }
  }

  // ============================================================================================ lifetime

  /** Whether any entry of the archive is waited for by an open proposal or job (Z5: pinned). */
  referenced(archiveId: string): boolean {
    return this.store.entries(archiveId).some((e) => e.links.some((l) => this.linkOpen(e.projectId, l)));
  }

  /** Z6: the server copy goes once every entry is staged, refused or a duplicate (or discarded). */
  private async finishIfSettled(archiveId: string): Promise<void> {
    const a = this.store.archive(archiveId);
    if (!a || a.state !== 'open') return;
    const entries = this.store.entries(archiveId);
    if (!entries.every((e) => SETTLED.has(e.status))) return;
    await this.removeCopy(a);
    this.store.updateArchive(a.id, { state: 'done' });
  }

  private async removeCopy(a: ArchiveRow): Promise<void> {
    if (!a.serverFile) return;
    try {
      await rm(join(this.dir, a.serverFile), { force: true });
      this.store.updateArchive(a.id, { serverFile: null, removedAt: this.o.now() });
    } catch (err) {
      this.o.log?.warn(
        { err, archiveId: a.id },
        'an archive’s server copy could not be removed; tried again later',
      );
    }
  }

  /**
   * Z6: discards an archive: its entries not staged, refused or duplicates are discarded (an art job waiting for one
   * leaves that image out), and its server copy goes. Staged images stay staged (the Staging page places or discards
   * them).
   */
  async discard(archiveId: string, by: string): Promise<{ discarded: number } | null> {
    const a = this.store.archive(archiveId);
    if (!a) return null;
    let n = 0;
    for (const e of this.store.entries(archiveId))
      if (!SETTLED.has(e.status)) {
        this.store.updateEntry(e.archiveId, e.seq, {
          status: 'discarded',
          heldBy: null,
          expectedAt: null,
          reasonCode: 'ARCHIVE_DISCARDED',
          reason: `the archive was discarded by ${by}`,
        });
        n++;
      }
    await this.removeCopy(a);
    this.store.updateArchive(a.id, { state: 'discarded', discardedBy: by });
    this.o.engine?.poke();
    return { discarded: n };
  }

  /**
   * The minute sweep: copies of settled archives removed (a failed removal is tried again), and an archive unused past
   * the staging expiry (its project's) loses its server copy, never while a proposal or job waits for one of its
   * entries. Temporary files of uploads that never finished are removed.
   */
  async sweep(): Promise<void> {
    const now = this.o.now();
    for (const a of this.store.withServerCopy()) {
      if (a.state !== 'open') {
        await this.removeCopy(a);
        continue;
      }
      await this.finishIfSettled(a.id);
      const fresh = this.store.archive(a.id);
      if (!fresh?.serverFile || fresh.state !== 'open') continue;
      const maxMs = this.images.stagingMaxDays(a.projectId) * DAY;
      if (now - a.lastActivityAt < maxMs || this.referenced(a.id)) continue;
      for (const e of this.store.entries(a.id))
        if (!SETTLED.has(e.status))
          this.store.updateEntry(e.archiveId, e.seq, {
            status: 'discarded',
            heldBy: null,
            expectedAt: null,
            reasonCode: 'ARCHIVE_EXPIRED',
            reason: `unused for ${this.images.stagingMaxDays(a.projectId)} days`,
          });
      await this.removeCopy(fresh);
      this.store.updateArchive(a.id, { state: 'expired' });
    }
    // Incoming files older than an hour were left by a call that never finished.
    try {
      for (const f of await readdir(this.tmpDir)) {
        const p = join(this.tmpDir, f);
        const st = await stat(p).catch(() => null);
        if (st && now - st.mtimeMs > 3_600_000) await rm(p, { force: true });
      }
    } catch {
      // no temporary directory yet
    }
    this.kick();
  }

  // ============================================================================================ views

  /** Queue positions of the entries waiting for a conversion, by `archiveId:seq` (1 = next). */
  private queuePositions(): Map<string, number> {
    const m = new Map<string, number>();
    let n = 0;
    for (const e of this.store.waiting()) if (e.status === 'queued') m.set(`${e.archiveId}:${e.seq}`, ++n);
    return m;
  }

  /** One row as the tools and the dashboard show it. */
  rowView(e: EntryRow, positions?: Map<string, number>): Record<string, unknown> {
    const pos = positions?.get(`${e.archiveId}:${e.seq}`);
    return {
      entry: baseNameOf(e.path),
      path: e.path,
      folder: e.folder,
      suggestedOutfit: suggestedOutfitOf(e.folder),
      size: e.bytes,
      ...(e.format ? { format: e.format } : {}),
      ...(e.width !== null && e.height !== null ? { width: e.width, height: e.height } : {}),
      ...(e.frames !== null && e.frames > 1 ? { frames: e.frames } : {}),
      ...(e.sha256 ? { sha256: e.sha256 } : {}),
      status: e.status,
      ...(e.stagedId && (e.status === 'staged' || e.status === 'duplicate') ? { staged_id: e.stagedId } : {}),
      ...(e.status === 'held'
        ? {
            heldBy: e.heldBy,
            ...(e.expectedAt !== null ? { expectedAt: new Date(e.expectedAt).toISOString() } : {}),
          }
        : {}),
      ...(pos !== undefined ? { queuePosition: pos } : {}),
      ...((e.status === 'refused' || e.status === 'failed' || e.status === 'discarded') && e.reason
        ? { reason: `${e.reasonCode}: ${e.reason}` }
        : {}),
      ...(e.status === 'queued' && e.reason ? { note: e.reason } : {}),
      ...(e.duplicateOf !== null
        ? { duplicateOf: this.store.entry(e.archiveId, e.duplicateOf)?.path ?? null }
        : {}),
    };
  }

  /** The three limits, kept separate (Z9.5), as they stand now. */
  limitsView(principalId?: string): Record<string, unknown> {
    const room = this.images.stagingRoom();
    const load = this.images.queue.load;
    return {
      holding: {
        stagedBytes: room.used,
        capBytes: room.cap,
        freeBytes: room.free,
        setting: 'IMAGE_STAGED_MAX_BYTES',
        archiveCaps: {
          entries: this.settings.images.archiveMaxEntries,
          uncompressedBytes: this.settings.images.archiveMaxUncompressedBytes,
        },
      },
      processing: {
        converting: load.running,
        waitingInQueue: load.waiting,
        concurrency: this.settings.images.convertConcurrency,
        setting: 'IMAGE_CONVERT_CONCURRENCY',
      },
      brake: {
        perHour: this.settings.images.ratePerPrincipalPerHour,
        setting: 'IMAGE_UPLOAD_RATE_PER_PRINCIPAL',
        ...(principalId
          ? {
              waitSeconds: Math.ceil(this.images.brakeWaitMs(principalId) / 1000),
            }
          : {}),
      },
      legendKeeper: 'the governor’s budgets and tiers (unchanged): see bridge_budget',
    };
  }

  /** An archive with its rows and a count by status. */
  archiveView(a: ArchiveRow): Record<string, unknown> {
    const entries = this.store.entries(a.id);
    const positions = this.queuePositions();
    const counts: Record<string, number> = {};
    for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
    return {
      archive_id: a.id,
      ...(a.fileName ? { fileName: a.fileName } : {}),
      state: a.state,
      bytes: a.bytes,
      sha256: a.sha256,
      entries: entries.length,
      ...(a.skipped > 0 ? { skipped: a.skipped } : {}),
      counts,
      serverCopy: a.serverFile !== null,
      createdAt: new Date(a.createdAt).toISOString(),
      lastActivityAt: new Date(a.lastActivityAt).toISOString(),
      ...(a.workstream ? { workstream: a.workstream } : {}),
      rows: entries.map((e) => this.rowView(e, positions)),
    };
  }
}

/**
 * v3 F7c (ADR 0075, Z2): reading an image archive (a zip) safely, with yauzl.
 *
 * - The zip is read from the bridge's own copy on disk, through yauzl's random access over a file descriptor: the
 *   central directory first, then one entry at a time. Nothing loads the zip whole, and an entry is held in memory only
 *   while it is hashed and looked at (each entry is within the single-image limit, UPLOAD_MAX_BYTES).
 * - Whole-archive refusals (one clear error): a zip that cannot be read (`ARCHIVE_UNREADABLE`), more entries than
 *   IMAGE_ARCHIVE_MAX_ENTRIES (`ARCHIVE_TOO_MANY_ENTRIES`), more than IMAGE_ARCHIVE_MAX_UNCOMPRESSED_BYTES unpacked
 *   (`ARCHIVE_TOO_LARGE`), or a whole-archive ratio over 100:1 (`ARCHIVE_BOMB`). All are judged from the central
 *   directory, before any entry is decompressed.
 * - Per-entry refusals (the others carry on): a path that is absolute, climbs (`..`) or holds a backslash
 *   (`UNSAFE_PATH`), an encrypted entry (`ENCRYPTED`), a compression method other than stored or deflate
 *   (`UNSUPPORTED_COMPRESSION`), a ratio over 100:1 (`ARCHIVE_BOMB`), a nested archive (`NESTED_ARCHIVE`), anything
 *   that is not a PNG, JPEG, GIF or WebP by its first bytes, whatever its extension (`NOT_AN_IMAGE`), an image past the
 *   single-image limits (`IMAGE_TOO_LARGE`), or bytes that do not decompress to their declared size and CRC
 *   (`ENTRY_UNREADABLE`).
 * - Skipped (not rows): folders, `__MACOSX/`, and hidden files (any part of the path starting with a dot).
 * - Names: yauzl's own name check fails the whole zip on one bad name, so strings are decoded here
 *   (`decodeStrings: false`) and each entry's name is checked on its own. A name taken from a zip is information only:
 *   the bridge never writes a file under it (entries are staged under bridge-chosen names).
 */
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { Readable } from 'node:stream';
import sharp, { type Metadata } from 'sharp';
import yauzl from 'yauzl';
import { sniffImageType } from '../mcp/tools/upload-http.js';

/** Per-entry and whole-archive compression ratio past which an archive or entry is refused (Z2). */
export const MAX_RATIO = 100;

export type ArchiveErrorCode =
  | 'ARCHIVE_UNREADABLE'
  | 'ARCHIVE_TOO_MANY_ENTRIES'
  | 'ARCHIVE_TOO_LARGE'
  | 'ARCHIVE_BOMB'
  | 'ARCHIVE_ENTRY_CHANGED';

export class ArchiveError extends Error {
  constructor(
    readonly code: ArchiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export type EntryRefusal =
  | 'UNSAFE_PATH'
  | 'ENCRYPTED'
  | 'UNSUPPORTED_COMPRESSION'
  | 'ARCHIVE_BOMB'
  | 'NESTED_ARCHIVE'
  | 'NOT_AN_IMAGE'
  | 'IMAGE_TOO_LARGE'
  | 'ENTRY_UNREADABLE';

export interface ArchiveLimits {
  readonly maxEntries: number;
  readonly maxUncompressedBytes: number;
  /** The single-image limits (UPLOAD_MAX_BYTES, IMAGE_MAX_PIXELS, IMAGE_MAX_FRAMES). */
  readonly maxEntryBytes: number;
  readonly maxPixels: number;
  readonly maxFrames: number;
}

/** One file entry as listed (a row). */
export interface ListedEntry {
  /** Its index in the central directory: stable for the same zip. */
  readonly seq: number;
  readonly path: string;
  readonly folder: string | null;
  readonly bytes: number;
  readonly compressedBytes: number;
  readonly sha256: string | null;
  readonly format: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly frames: number | null;
  readonly refused: { readonly code: EntryRefusal; readonly message: string } | null;
}

export interface ArchiveListing {
  readonly entries: readonly ListedEntry[];
  /** Folders, `__MACOSX/` and hidden files: not rows. */
  readonly skipped: number;
  readonly uncompressedBytes: number;
}

interface RawEntry {
  readonly seq: number;
  readonly entry: yauzl.Entry;
  readonly name: string;
  readonly nameProblem: string | null;
}

const open = (file: string): Promise<yauzl.ZipFile> =>
  new Promise((resolve, reject) =>
    yauzl.open(
      file,
      // yauzl's size checks fail the whole zip for one entry: each entry's sizes and CRC-32 are checked here instead.
      { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: false },
      (err, zip) => (err ? reject(err) : resolve(zip)),
    ),
  );

/** The entry's name, decoded as yauzl would (UTF-8 flag, Info-ZIP Unicode path field, else CP437), and its problem. */
function nameOf(e: yauzl.Entry): { name: string; problem: string | null } {
  const raw = e.fileName as unknown as Buffer;
  const name = yauzl.getFileNameLowLevel(e.generalPurposeBitFlag, raw, e.extraFields, false);
  // yauzl's own check (backslash, absolute, `..`), and a NUL byte, which no file name holds.
  const problem = yauzl.validateFileName(name) ?? (name.includes('\u0000') ? 'a NUL in the name' : null);
  return { name, problem };
}

/** Reads the central directory: every record, in order, without decompressing anything. */
async function centralDirectory(zip: yauzl.ZipFile, stopAt?: number): Promise<RawEntry[]> {
  const out: RawEntry[] = [];
  await new Promise<void>((resolve, reject) => {
    let seq = 0;
    const done = () => {
      zip.removeAllListeners('entry');
      zip.removeAllListeners('end');
      zip.removeAllListeners('error');
      resolve();
    };
    zip.on('entry', (entry: yauzl.Entry) => {
      const { name, problem } = nameOf(entry);
      out.push({ seq, entry, name, nameProblem: problem });
      seq++;
      if (stopAt !== undefined && seq > stopAt) done();
      else zip.readEntry();
    });
    zip.on('end', done);
    zip.on('error', (e: Error) => {
      zip.removeAllListeners('entry');
      zip.removeAllListeners('end');
      reject(e);
    });
    zip.readEntry();
  });
  return out;
}

const isDirectory = (name: string) => name.endsWith('/');
/** `__MACOSX/` and hidden files (any part of the path starting with a dot): skipped, not rows. */
export const isSkippedPath = (name: string): boolean => {
  const parts = name.split('/').filter((p) => p !== '');
  return parts[0] === '__MACOSX' || parts.some((p) => p.startsWith('.'));
};

/** The folder of a path inside the zip (raw), or null at the top level. */
export function folderOf(path: string): string | null {
  const i = path.lastIndexOf('/');
  return i <= 0 ? null : path.slice(0, i);
}

/** The base name (what a row shows). */
export const baseNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The first bytes of another archive or compressed stream (a nested archive is refused, never opened). */
function isArchive(b: Uint8Array): boolean {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (b.length >= 4 && at(0, 0x50, 0x4b) && [0x03, 0x05, 0x07].includes(b[2]!)) return true; // zip
  if (at(0, 0x52, 0x61, 0x72, 0x21)) return true; // rar
  if (at(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return true; // 7z
  if (at(0, 0x1f, 0x8b)) return true; // gzip
  if (at(0, 0x42, 0x5a, 0x68)) return true; // bzip2
  if (at(0, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return true; // xz
  if (at(0, 0x28, 0xb5, 0x2f, 0xfd)) return true; // zstd
  if (b.length >= 262 && Buffer.from(b.subarray(257, 262)).toString('latin1') === 'ustar') return true; // tar
  return false;
}

const openStream = (zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> =>
  new Promise((resolve, reject) =>
    zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream))),
  );

/**
 * An entry's bytes, decompressed, capped at `max` and at its declared size (more is a refusal, never read on); then its
 * size and CRC-32 must be the declared ones.
 */
async function readBytes(zip: yauzl.ZipFile, entry: yauzl.Entry, max: number): Promise<Buffer> {
  const stream = await openStream(zip, entry);
  max = Math.min(max, entry.uncompressedSize);
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        stream.destroy();
        reject(new Error(`more than ${max} bytes`));
        return;
      }
      chunks.push(c);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  if (bytes.length !== entry.uncompressedSize)
    throw new Error(`${bytes.length} bytes where ${entry.uncompressedSize} were declared`);
  if (crc32(bytes) >>> 0 !== entry.crc32 >>> 0) throw new Error('its CRC-32 is not the declared one');
  return bytes;
}

/** Why a record is not a row: a folder or a skipped path (null: it is a row). */
function notARow(r: RawEntry): 'dir' | 'skipped' | null {
  if (isDirectory(r.name)) return 'dir';
  if (r.nameProblem === null && isSkippedPath(r.name)) return 'skipped';
  return null;
}

/** The per-entry refusal judged from the central directory alone, or null. */
function headerRefusal(r: RawEntry, limits: ArchiveLimits): ListedEntry['refused'] {
  const e = r.entry;
  if (r.nameProblem !== null)
    return { code: 'UNSAFE_PATH', message: `an unsafe path (${r.nameProblem}): never written anywhere` };
  if (e.isEncrypted()) return { code: 'ENCRYPTED', message: 'an encrypted entry cannot be read' };
  if (e.compressionMethod === 0 && e.compressedSize !== e.uncompressedSize)
    return {
      code: 'ENTRY_UNREADABLE',
      message: `a stored entry whose sizes disagree (${e.compressedSize} stored, ${e.uncompressedSize} declared)`,
    };
  if (e.compressionMethod !== 0 && e.compressionMethod !== 8)
    return {
      code: 'UNSUPPORTED_COMPRESSION',
      message: `compression method ${e.compressionMethod} (only stored and deflate are read)`,
    };
  if (e.uncompressedSize > 0 && (e.compressedSize === 0 || e.uncompressedSize / e.compressedSize > MAX_RATIO))
    return {
      code: 'ARCHIVE_BOMB',
      message: `it unpacks to more than ${MAX_RATIO} times its compressed size (${e.compressedSize} → ${e.uncompressedSize} bytes)`,
    };
  if (e.uncompressedSize > limits.maxEntryBytes)
    return {
      code: 'IMAGE_TOO_LARGE',
      message: `${e.uncompressedSize} bytes, more than the single-image limit (UPLOAD_MAX_BYTES, ${limits.maxEntryBytes})`,
    };
  return null;
}

/** What the image's header says (format, size, frames), or the refusal. */
async function headerOf(
  bytes: Buffer,
  limits: ArchiveLimits,
): Promise<
  | { ok: true; format: string; width: number; height: number; frames: number }
  | { ok: false; code: EntryRefusal; message: string }
> {
  if (bytes.length === 0) return { ok: false, code: 'NOT_AN_IMAGE', message: 'an empty file' };
  if (isArchive(bytes))
    return { ok: false, code: 'NESTED_ARCHIVE', message: 'an archive inside the archive is never opened' };
  const type = sniffImageType(bytes);
  if (!type)
    return {
      ok: false,
      code: 'NOT_AN_IMAGE',
      message: 'not a PNG, JPEG, GIF or WebP image by its first bytes (its extension is ignored)',
    };
  let m: Metadata;
  try {
    m = await sharp(bytes, { limitInputPixels: false, animated: true }).metadata();
  } catch (e) {
    return {
      ok: false,
      code: 'NOT_AN_IMAGE',
      message: `its header could not be read (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  const width = m.width ?? 0;
  const pages = m.pages ?? 1;
  const height = m.pageHeight ?? m.height ?? 0;
  if (width <= 0 || height <= 0)
    return { ok: false, code: 'NOT_AN_IMAGE', message: 'its header gives no size' };
  if (width * height * pages > limits.maxPixels)
    return {
      ok: false,
      code: 'IMAGE_TOO_LARGE',
      message: `${width}×${height}${pages > 1 ? ` × ${pages} frames` : ''} is more than IMAGE_MAX_PIXELS (${limits.maxPixels})`,
    };
  if (pages > limits.maxFrames)
    return {
      ok: false,
      code: 'IMAGE_TOO_LARGE',
      message: `${pages} frames, more than IMAGE_MAX_FRAMES (${limits.maxFrames})`,
    };
  return { ok: true, format: type.slice('image/'.length), width, height, frames: pages };
}

/**
 * Lists an archive (Z9.1: list first, convert when used): every file entry with its path, folder, sizes, SHA-256,
 * format and size from its header, or its refusal. The caps are judged before anything is decompressed.
 */
export async function listArchive(
  file: string,
  fileBytes: number,
  limits: ArchiveLimits,
): Promise<ArchiveListing> {
  let zip: yauzl.ZipFile;
  try {
    zip = await open(file);
  } catch (e) {
    throw new ArchiveError(
      'ARCHIVE_UNREADABLE',
      `The archive could not be read as a zip (${e instanceof Error ? e.message : String(e)}). Nothing was staged.`,
    );
  }
  try {
    if (zip.entryCount > limits.maxEntries)
      throw new ArchiveError(
        'ARCHIVE_TOO_MANY_ENTRIES',
        `The archive holds ${zip.entryCount} entries, more than IMAGE_ARCHIVE_MAX_ENTRIES (${limits.maxEntries}). Nothing was staged: split it.`,
      );
    let raw: RawEntry[];
    try {
      raw = await centralDirectory(zip);
    } catch (e) {
      throw new ArchiveError(
        'ARCHIVE_UNREADABLE',
        `The archive's directory could not be read (${e instanceof Error ? e.message : String(e)}). Nothing was staged.`,
      );
    }
    const total = raw.reduce((n, r) => n + r.entry.uncompressedSize, 0);
    if (total > limits.maxUncompressedBytes)
      throw new ArchiveError(
        'ARCHIVE_TOO_LARGE',
        `The archive unpacks to ${total} bytes, more than IMAGE_ARCHIVE_MAX_UNCOMPRESSED_BYTES (${limits.maxUncompressedBytes}). Nothing was staged: split it.`,
      );
    if (fileBytes > 0 && total / fileBytes > MAX_RATIO)
      throw new ArchiveError(
        'ARCHIVE_BOMB',
        `The archive unpacks to more than ${MAX_RATIO} times its size (${fileBytes} → ${total} bytes). Nothing was staged.`,
      );
    const entries: ListedEntry[] = [];
    let skipped = 0;
    for (const r of raw) {
      const why = notARow(r);
      if (why) {
        if (why === 'skipped') skipped++;
        continue;
      }
      const e = r.entry;
      const base = {
        seq: r.seq,
        path: r.name,
        folder: r.nameProblem === null ? folderOf(r.name) : null,
        bytes: e.uncompressedSize,
        compressedBytes: e.compressedSize,
      };
      const none = { sha256: null, format: null, width: null, height: null, frames: null };
      const refused = headerRefusal(r, limits);
      if (refused) {
        entries.push({ ...base, ...none, refused });
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await readBytes(zip, e, limits.maxEntryBytes);
      } catch (err) {
        entries.push({
          ...base,
          ...none,
          refused: {
            code: 'ENTRY_UNREADABLE',
            message: `its bytes could not be read (${err instanceof Error ? err.message : String(err)})`,
          },
        });
        continue;
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const h = await headerOf(bytes, limits);
      entries.push(
        h.ok
          ? {
              ...base,
              sha256,
              format: h.format,
              width: h.width,
              height: h.height,
              frames: h.frames,
              refused: null,
            }
          : { ...base, ...none, sha256, refused: { code: h.code, message: h.message } },
      );
    }
    return { entries, skipped, uncompressedBytes: total };
  } finally {
    zip.close();
  }
}

/**
 * One entry's bytes, read again from the bridge's copy for its conversion: the record at `seq` must still be the
 * listed path, and its bytes the listed SHA-256 (`ARCHIVE_ENTRY_CHANGED` otherwise).
 */
export async function readArchiveEntry(
  file: string,
  want: { readonly seq: number; readonly path: string; readonly sha256: string },
  maxBytes: number,
): Promise<Buffer> {
  const zip = await open(file);
  try {
    const raw = await centralDirectory(zip, want.seq);
    const r = raw[want.seq];
    if (!r || r.name !== want.path)
      throw new ArchiveError('ARCHIVE_ENTRY_CHANGED', `Entry ${want.path} is not where it was listed.`);
    const bytes = await readBytes(zip, r.entry, maxBytes);
    if (createHash('sha256').update(bytes).digest('hex') !== want.sha256)
      throw new ArchiveError(
        'ARCHIVE_ENTRY_CHANGED',
        `Entry ${want.path} no longer has the bytes it was listed with.`,
      );
    return bytes;
  } finally {
    zip.close();
  }
}

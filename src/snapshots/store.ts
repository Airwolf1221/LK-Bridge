/**
 * The snapshot store on disk (v2 E1a, ADR 0042): THE contract E1b's off-server copy builds on.
 *
 *     <SNAPSHOT_DIR>/                                  0700, owned by the service user (lkbridge)
 *       STORE.json                                     0600  {"format":"lk-bridge-snapshot-store","version":1,…}
 *       objects/<first two hex>/<sha256>.gz            0600  gzip of the content; the name is the SHA-256 of the
 *                                                            UNCOMPRESSED content (a piece's canonical JSON, or an
 *                                                            image's bytes)
 *       manifests/<project id>/<snapshot id>.json.gz   0600  gzip of one snapshot's manifest (canonical JSON)
 *       tmp/                                           0700  files being written; never copied, emptied at start-up
 *
 * - Every file under `objects/` and `manifests/` is written once (to `tmp/`, then renamed into place) and never changed
 *   afterwards: files are only added, and removed by the retention and the garbage collector. An incremental copy (rclone)
 *   therefore only ever uploads new files, and a file it has is complete.
 * - A manifest is written only when its snapshot is complete (a full snapshot's pages and the asset library, or a change
 *   snapshot's pieces), so a copy that has a manifest has everything it names, provided the objects were copied first.
 *   **E1b copies `objects/` before `manifests/`.**
 * - Nothing else is needed to restore: a manifest names every object by hash, objects are self-verifying (gunzip,
 *   SHA-256, compare with the name), and the format is plain gzip and JSON. The database's index of the manifests is a
 *   convenience, rebuilt from the manifest files when a row is missing.
 * - The kept-bytes store of D3 (ADR 0041 decision 10) IS this store: the bytes kept before an asset delete are objects
 *   here too (one store, not two), referred to by `asset_kept_refs` instead of a manifest.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip, constants as zc } from 'node:zlib';
import { stableJson } from '../jobs/sidebar-state.js';
import type { Manifest } from './manifest.js';

const gz = promisify(gzip);
const gunz = promisify(gunzip);

const SHA = /^[0-9a-f]{64}$/;
export const STORE_FORMAT = 'lk-bridge-snapshot-store';
export const STORE_VERSION = 1;

export interface PutResult {
  readonly sha256: string;
  /** Uncompressed bytes. */
  readonly size: number;
  /** Bytes the object takes on disk (compressed); 0 when it was already there. */
  readonly stored: number;
  /** True when this call wrote the object (false: it was already stored, so it took no extra space). */
  readonly created: boolean;
}

export type ObjectCheck = 'ok' | 'missing' | 'corrupt';

/** A shared/exclusive lock: writers share it, the garbage collector takes it alone. In-process (one bridge per store). */
class RwLock {
  private readers = 0;
  private writer = false;
  private waiting: (() => void)[] = [];

  private wake(): void {
    const w = this.waiting.splice(0);
    for (const f of w) f();
  }

  async shared<T>(fn: () => Promise<T>): Promise<T> {
    while (this.writer) await new Promise<void>((r) => this.waiting.push(r));
    this.readers++;
    try {
      return await fn();
    } finally {
      this.readers--;
      this.wake();
    }
  }

  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.writer || this.readers > 0) await new Promise<void>((r) => this.waiting.push(r));
    this.writer = true;
    try {
      return await fn();
    } finally {
      this.writer = false;
      this.wake();
    }
  }
}

/** A project id as a directory name (LegendKeeper ids are already safe; anything else is hex-encoded). */
export function projectDirName(projectId: string): string {
  return /^[A-Za-z0-9._-]{1,128}$/.test(projectId) && !/^\.+$/.test(projectId)
    ? projectId
    : `x-${Buffer.from(projectId, 'utf8').toString('hex').slice(0, 200)}`;
}

const SNAPSHOT_ID = /^\d{8}T\d{6}Z-(full|change|daily)-[0-9a-f]{6,16}$/;

export function isSnapshotId(id: string): boolean {
  return SNAPSHOT_ID.test(id);
}

/**
 * How long `recent` remembers a put object: twice the collector's default grace (an hour), which it is the evidence for.
 * A collection asking for a longer grace falls back on the object file's own time, as it did for objects put before a
 * restart.
 */
export const RECENT_KEEP_MS = 2 * 3_600_000;

export class SnapshotStore {
  readonly lock = new RwLock();
  private ensured = false;
  /**
   * Objects put (written, or found already there) in this process, with when: the garbage collector leaves them alone
   * for an hour, so an object a writer has just referred to is never removed between its write and the row or manifest
   * that refers to it. In memory on purpose: touching the file's time would make an incremental copy upload it again.
   */
  private readonly recent = new Map<string, number>();
  /**
   * CR-2026-11-R3 (R3-65): `recent` is kept to `RECENT_KEEP_MS` as objects are put (at most once a minute), not only when
   * the collector asks: it held an entry for every object put since the last collection (a day of full and change
   * snapshots: every piece, unchanged ones included).
   */
  private recentPrunedAt = 0;

  /** `dir` is created by the first write (not here): a runtime that never snapshots touches no folder. */
  constructor(readonly dir: string) {}

  objectPath(sha256: string): string {
    if (!SHA.test(sha256)) throw new Error('not a SHA-256');
    return join(this.dir, 'objects', sha256.slice(0, 2), `${sha256}.gz`);
  }

  manifestRelPath(projectId: string, snapshotId: string): string {
    if (!isSnapshotId(snapshotId)) throw new Error(`not a snapshot id: ${snapshotId}`);
    return `manifests/${projectDirName(projectId)}/${snapshotId}.json.gz`;
  }

  /** The store's directories and STORE.json, private (0700 / 0600). */
  async ensure(): Promise<void> {
    if (this.ensured) return;
    for (const d of ['', 'objects', 'manifests', 'tmp']) {
      await mkdir(join(this.dir, d), { recursive: true, mode: 0o700 });
      await chmod(join(this.dir, d), 0o700);
    }
    const marker = join(this.dir, 'STORE.json');
    try {
      await stat(marker);
    } catch {
      await writeFile(
        marker,
        `${stableJson({
          format: STORE_FORMAT,
          version: STORE_VERSION,
          layout: {
            objects:
              'objects/<first two hex>/<sha256>.gz: gzip of the content; the name is the SHA-256 of the uncompressed content',
            manifests:
              'manifests/<project id>/<snapshot id>.json.gz: gzip of one complete snapshot manifest (JSON)',
            tmp: 'tmp/: files being written; never copy',
          },
          createdAt: new Date().toISOString(),
        })}\n`,
        { mode: 0o600 },
      );
      await chmod(marker, 0o600);
    }
    this.ensured = true;
  }

  /** True when a directory exists at all (the dashboard says "nothing stored yet" otherwise). */
  async exists(): Promise<boolean> {
    try {
      return (await stat(this.dir)).isDirectory();
    } catch {
      return false;
    }
  }

  /** Empties `tmp/` (start-up): files there were being written when the process stopped. */
  async cleanTmp(): Promise<number> {
    let n = 0;
    try {
      for (const f of await readdir(join(this.dir, 'tmp'))) {
        await rm(join(this.dir, 'tmp', f), { force: true, recursive: true });
        n++;
      }
    } catch {
      /* no tmp yet */
    }
    return n;
  }

  private async writeAtomic(path: string, data: Buffer): Promise<void> {
    await this.ensure();
    const tmp = join(this.dir, 'tmp', `${randomBytes(8).toString('hex')}.tmp`);
    await writeFile(tmp, data, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    await rename(tmp, path);
  }

  async has(sha256: string): Promise<boolean> {
    try {
      await stat(this.objectPath(sha256));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stores bytes under their own SHA-256 (nothing is written when the object is already there: unchanged pieces and
   * images take no extra space). `repair`: an existing object is checked first and written again when it is damaged.
   */
  async putBytes(
    bytes: Uint8Array,
    o: {
      readonly compress?: 'text' | 'binary';
      readonly repair?: boolean | ((sha256: string) => boolean);
    } = {},
  ): Promise<PutResult> {
    const sha = createHash('sha256').update(bytes).digest('hex');
    const path = this.objectPath(sha);
    this.noteRecent(sha, Date.now());
    if (await this.has(sha)) {
      const repair = typeof o.repair === 'function' ? o.repair(sha) : o.repair === true;
      if (!repair || (await this.check(sha)) === 'ok')
        return { sha256: sha, size: bytes.length, stored: 0, created: false };
    }
    const level = o.compress === 'binary' ? zc.Z_BEST_SPEED : 6;
    const data = await gz(bytes, { level });
    await this.writeAtomic(path, data);
    return { sha256: sha, size: bytes.length, stored: data.length, created: true };
  }

  /** The bytes of an object, or null when it is missing or damaged (it is gunzipped and its hash checked). */
  async get(sha256: string): Promise<Buffer | null> {
    let data: Buffer;
    try {
      data = await readFile(this.objectPath(sha256));
    } catch {
      return null;
    }
    try {
      const bytes = await gunz(data);
      return createHash('sha256').update(bytes).digest('hex') === sha256 ? bytes : null;
    } catch {
      return null;
    }
  }

  /** A piece (JSON), or null when it is missing or damaged. */
  async getJson<T>(sha256: string): Promise<T | null> {
    const b = await this.get(sha256);
    if (!b) return null;
    try {
      return JSON.parse(b.toString('utf8')) as T;
    } catch {
      return null;
    }
  }

  async check(sha256: string): Promise<ObjectCheck> {
    try {
      await stat(this.objectPath(sha256));
    } catch {
      return 'missing';
    }
    return (await this.get(sha256)) ? 'ok' : 'corrupt';
  }

  async remove(sha256: string): Promise<void> {
    await rm(this.objectPath(sha256), { force: true });
  }

  private noteRecent(sha256: string, now: number): void {
    this.recent.delete(sha256); // re-inserted last: the map stays in the order of the puts
    this.recent.set(sha256, now);
    if (now - this.recentPrunedAt < 60_000) return;
    this.recentPrunedAt = now;
    for (const [k, at] of this.recent) {
      if (now - at <= RECENT_KEEP_MS) break; // in put order: the rest are newer
      this.recent.delete(k);
    }
  }

  /** Whether this process put the object within the last `withinMs` (see `recent`); old entries are forgotten. */
  recentlyPut(sha256: string, withinMs: number, now = Date.now()): boolean {
    for (const [k, at] of this.recent) if (now - at > withinMs) this.recent.delete(k);
    const at = this.recent.get(sha256);
    return at !== undefined && now - at <= withinMs;
  }

  /** Every object file: its hash, size on disk and when it was written. */
  async objects(): Promise<{ sha256: string; stored: number; mtimeMs: number }[]> {
    const out: { sha256: string; stored: number; mtimeMs: number }[] = [];
    let subs: string[];
    try {
      subs = await readdir(join(this.dir, 'objects'));
    } catch {
      return out;
    }
    for (const sub of subs.sort()) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue;
      let files: string[];
      try {
        files = await readdir(join(this.dir, 'objects', sub));
      } catch {
        continue;
      }
      for (const f of files) {
        const m = /^([0-9a-f]{64})\.gz$/.exec(f);
        if (!m) continue;
        try {
          const s = await stat(join(this.dir, 'objects', sub, f));
          out.push({ sha256: m[1]!, stored: s.size, mtimeMs: s.mtimeMs });
        } catch {
          /* removed meanwhile */
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ manifests

  async writeManifest(manifest: Manifest): Promise<string> {
    const rel = this.manifestRelPath(manifest.project.id, manifest.id);
    const data = await gz(Buffer.from(`${stableJson(manifest)}\n`, 'utf8'), { level: 9 });
    await this.writeAtomic(join(this.dir, rel), data);
    return rel;
  }

  async readManifest(rel: string): Promise<Manifest | null> {
    if (!/^manifests\/[A-Za-z0-9._-]+\/[0-9A-Za-z-]+\.json\.gz$/.test(rel)) return null;
    try {
      const raw = await gunz(await readFile(join(this.dir, rel)));
      const m = JSON.parse(raw.toString('utf8')) as Manifest;
      return m && m.format === 'lk-bridge-snapshot' ? m : null;
    } catch {
      return null;
    }
  }

  async removeManifest(rel: string): Promise<void> {
    if (!rel.startsWith('manifests/')) return;
    await rm(join(this.dir, rel), { force: true });
    try {
      await rmdir(join(this.dir, rel, '..'));
    } catch {
      /* not empty */
    }
  }

  /** Every manifest file, as paths relative to the store. */
  async manifests(): Promise<{ rel: string; stored: number }[]> {
    const out: { rel: string; stored: number }[] = [];
    let projects: string[];
    try {
      projects = await readdir(join(this.dir, 'manifests'));
    } catch {
      return out;
    }
    for (const p of projects.sort()) {
      let files: string[];
      try {
        files = await readdir(join(this.dir, 'manifests', p));
      } catch {
        continue;
      }
      for (const f of files.sort()) {
        if (!f.endsWith('.json.gz')) continue;
        try {
          const s = await stat(join(this.dir, 'manifests', p, f));
          out.push({ rel: `manifests/${p}/${f}`, stored: s.size });
        } catch {
          /* removed meanwhile */
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ disk

  /** What the store takes on disk. */
  async usage(): Promise<{ objects: number; objectBytes: number; manifests: number; manifestBytes: number }> {
    const objs = await this.objects();
    const mans = await this.manifests();
    return {
      objects: objs.length,
      objectBytes: objs.reduce((n, o) => n + o.stored, 0),
      manifests: mans.length,
      manifestBytes: mans.reduce((n, m) => n + m.stored, 0),
    };
  }

  /** Free and total bytes of the file system the store is on (its nearest existing parent before it exists). */
  async disk(): Promise<{ free: number; total: number } | null> {
    let at = this.dir;
    for (let i = 0; i < 64; i++) {
      try {
        const s = await statfs(at);
        return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
      } catch {
        const up = join(at, '..');
        if (up === at) return null;
        at = up;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------ D3's kept bytes

  /**
   * Moves the files of D3's old `kept-bytes/` directory (`<image dir>/kept-bytes/<aa>/<sha256>`, raw bytes) into this
   * store: each is hash-checked, stored as an object, then removed; a damaged one is left where it is and reported.
   * The directory is removed when empty. Runs at start-up; a no-op when there is nothing there.
   */
  async adoptKeptBytes(oldDir: string): Promise<{ adopted: number; damaged: string[] }> {
    const damaged: string[] = [];
    let adopted = 0;
    let subs: string[];
    try {
      subs = await readdir(oldDir);
    } catch {
      return { adopted, damaged };
    }
    for (const sub of subs) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue;
      let files: string[];
      try {
        files = await readdir(join(oldDir, sub));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!SHA.test(f)) continue;
        const path = join(oldDir, sub, f);
        const bytes = await readFile(path);
        if (createHash('sha256').update(bytes).digest('hex') !== f) {
          damaged.push(f);
          continue;
        }
        await this.lock.shared(() => this.putBytes(bytes, { compress: 'binary' }));
        await rm(path, { force: true });
        adopted++;
      }
      try {
        await rmdir(join(oldDir, sub));
      } catch {
        /* not empty */
      }
    }
    try {
      await rmdir(oldDir);
    } catch {
      /* not empty */
    }
    return { adopted, damaged };
  }
}

/**
 * D3's `ByteStore` interface (src/images/kept.ts) over this store: the bytes kept before an asset delete are objects of
 * the snapshot store. `remove` is a no-op: kept bytes past their retention lose their reference row, and the garbage
 * collector removes the object once nothing (no kept reference, no snapshot) refers to it any more.
 */
export class KeptBytes {
  constructor(private readonly store: SnapshotStore) {}

  /** The store's directory (where the files are; kept for D3's callers and tests). */
  get dir(): string {
    return this.store.dir;
  }

  has(sha256: string): Promise<boolean> {
    return this.store.has(sha256);
  }

  async put(bytes: Uint8Array): Promise<string> {
    return (
      await this.store.lock.shared(() => this.store.putBytes(bytes, { compress: 'binary', repair: true }))
    ).sha256;
  }

  get(sha256: string): Promise<Buffer | null> {
    return this.store.get(sha256);
  }

  async remove(_sha256: string): Promise<void> {
    /* the garbage collector decides (see the class comment) */
  }
}

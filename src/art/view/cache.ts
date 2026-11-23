/**
 * v3 F7b (ADR 0071, D6): the derivatives `arkona_get_art` delivers inline, kept on the bridge's disk so a second look
 * costs nothing. Content-addressed: a derivative's key is the SHA-256 of its asset id, its file URL and the size
 * parameters (`DERIVE_PARAMS`), so a changed URL or a new rule is a new key and is fetched again.
 *
 * - Where: ART_CACHE_DIR, else `art-cache/` next to the database. Made on the first write.
 * - What: one `<key>.bin` (the derivative's bytes) and one `<key>.json` (what it is) per entry. Never the original.
 * - Bounded: ART_CACHE_MAX_MB (default 500). When a write takes the total over it, the least recently used entries
 *   (by the files' modification time, touched on every hit) are deleted until it fits.
 * - Memory: nothing is held between calls but the running total (one number). A hit reads the file; eviction reads the
 *   directory's listing. A full or unwritable disk never fails a call: the derivative is still delivered, uncached.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DERIVE_PARAMS } from './derive.js';

export interface CachedMeta {
  readonly assetId: string;
  readonly url: string;
  readonly format: 'webp' | 'jpeg';
  readonly mimeType: 'image/webp' | 'image/jpeg';
  readonly width: number;
  readonly height: number;
  readonly quality: number;
  readonly bytes: number;
  readonly source: {
    readonly format: string | null;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
    readonly hasAlpha: boolean;
  };
  readonly overTarget: boolean;
  readonly storedAt: number;
}

export interface CacheHit {
  readonly meta: CachedMeta;
  readonly bytes: Buffer;
}

/**
 * The directory: ART_CACHE_DIR, else `art-cache/` next to the database; for an in-memory database a private temporary
 * one per runtime (so two runtimes in one process never share entries).
 */
export function artCacheDir(configured: string | null, dbPath: string): string {
  if (configured) return resolve(configured);
  if (dbPath === ':memory:' || dbPath === '')
    return join(tmpdir(), `lkb-art-cache-${process.pid}-${randomBytes(4).toString('hex')}`);
  return join(dirname(resolve(dbPath)), 'art-cache');
}

/** The key of one derivative: asset id + URL + the size parameters. */
export function cacheKey(assetId: string, url: string): string {
  return createHash('sha256')
    .update(JSON.stringify([assetId, url, DERIVE_PARAMS]))
    .digest('hex');
}

const KEY = /^[0-9a-f]{64}$/;

export class ArtCache {
  /** The bytes on disk, once measured (null: not yet). */
  private total: number | null = null;
  private evicting: Promise<void> | null = null;

  constructor(
    readonly dir: string,
    readonly maxBytes: number,
    private readonly now: () => number = Date.now,
  ) {}

  private paths(key: string) {
    return { bin: join(this.dir, `${key}.bin`), json: join(this.dir, `${key}.json`) };
  }

  /** The derivative, or null. A hit marks the entry as used now. */
  async get(assetId: string, url: string): Promise<CacheHit | null> {
    const key = cacheKey(assetId, url);
    const p = this.paths(key);
    try {
      const meta = JSON.parse(await readFile(p.json, 'utf8')) as CachedMeta;
      if (meta.assetId !== assetId || meta.url !== url) return null;
      const bytes = await readFile(p.bin);
      if (bytes.length !== meta.bytes) return null;
      const t = new Date(this.now());
      await Promise.all([utimes(p.bin, t, t), utimes(p.json, t, t)]).catch(() => undefined);
      return { meta, bytes };
    } catch {
      return null;
    }
  }

  /** Stores a derivative (best effort), then evicts the least recently used entries past the cap. */
  async put(meta: Omit<CachedMeta, 'storedAt' | 'bytes'>, bytes: Buffer): Promise<boolean> {
    if (bytes.length > this.maxBytes) return false;
    const key = cacheKey(meta.assetId, meta.url);
    const p = this.paths(key);
    const full: CachedMeta = { ...meta, bytes: bytes.length, storedAt: this.now() };
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await this.measure();
      const before = await this.sizeOf(key);
      const tmp = `.${key}.${randomBytes(6).toString('hex')}`;
      await writeFile(join(this.dir, `${tmp}.bin`), bytes, { mode: 0o600 });
      await writeFile(join(this.dir, `${tmp}.json`), JSON.stringify(full), { mode: 0o600 });
      await rename(join(this.dir, `${tmp}.bin`), p.bin);
      await rename(join(this.dir, `${tmp}.json`), p.json);
      const t = new Date(this.now());
      await Promise.all([utimes(p.bin, t, t), utimes(p.json, t, t)]);
      this.total = (this.total ?? 0) - before + bytes.length;
    } catch {
      return false;
    }
    if ((this.total ?? 0) > this.maxBytes) await this.evict();
    return true;
  }

  /** The bytes the cache holds (measured from the directory). */
  async size(): Promise<number> {
    this.total = null;
    await this.measure();
    return this.total ?? 0;
  }

  private async sizeOf(key: string): Promise<number> {
    try {
      return (await stat(this.paths(key).bin)).size;
    } catch {
      return 0;
    }
  }

  private async entries(): Promise<{ key: string; bytes: number; usedAt: number }[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: { key: string; bytes: number; usedAt: number }[] = [];
    for (const n of names) {
      if (!n.endsWith('.bin')) continue;
      const key = n.slice(0, -4);
      if (!KEY.test(key)) continue;
      try {
        const s = await stat(join(this.dir, n));
        out.push({ key, bytes: s.size, usedAt: s.mtimeMs });
      } catch {
        // gone meanwhile
      }
    }
    return out;
  }

  private async measure(): Promise<void> {
    if (this.total !== null) return;
    this.total = (await this.entries()).reduce((a, e) => a + e.bytes, 0);
  }

  /** Least recently used first, until the total is within the cap. One eviction at a time. */
  private evict(): Promise<void> {
    if (this.evicting) return this.evicting;
    this.evicting = (async () => {
      try {
        const list = (await this.entries()).sort((a, b) => a.usedAt - b.usedAt || (a.key < b.key ? -1 : 1));
        let total = list.reduce((a, e) => a + e.bytes, 0);
        for (const e of list) {
          if (total <= this.maxBytes) break;
          const p = this.paths(e.key);
          await rm(p.bin, { force: true });
          await rm(p.json, { force: true });
          total -= e.bytes;
        }
        this.total = total;
      } finally {
        this.evicting = null;
      }
    })();
    return this.evicting;
  }
}

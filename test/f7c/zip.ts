/**
 * v3 F7c (ADR 0075): a small zip writer for the archive tests, so every fixture is built in the test (nothing binary is
 * committed): stored or deflated entries, folders, a ZIP64 layout, an encrypted flag, and sizes that lie.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import sharp from 'sharp';

export interface ZipEntry {
  readonly name: string;
  /** Absent: a folder record (its name ends with `/`). */
  readonly data?: Buffer;
  readonly method?: 'store' | 'deflate';
  /** Sets the encryption flag (the data is left as given: it is never read). */
  readonly encrypted?: boolean;
  /** Declares this uncompressed size instead of the real one (a lie the reader must catch). */
  readonly declaredSize?: number;
}

export function zip(entries: readonly ZipEntry[], o: { readonly zip64?: boolean } = {}): Buffer {
  const z64 = o.zip64 === true;
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = e.data ?? Buffer.alloc(0);
    const method = e.data && e.method === 'deflate' ? 8 : 0;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const size = e.declaredSize ?? raw.length;
    const crc = crc32(raw) >>> 0;
    const flags = (e.encrypted ? 0x1 : 0) | 0x800;
    const version = z64 ? 45 : 20;
    const extraLocal = z64 ? zip64Extra([size, body.length]) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(version, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(z64 ? 0xffffffff : body.length, 18);
    local.writeUInt32LE(z64 ? 0xffffffff : size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extraLocal.length, 28);
    parts.push(local, name, extraLocal, body);
    const extraCentral = z64 ? zip64Extra([size, body.length, offset]) : Buffer.alloc(0);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x031e, 4);
    c.writeUInt16LE(version, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(z64 ? 0xffffffff : body.length, 20);
    c.writeUInt32LE(z64 ? 0xffffffff : size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(extraCentral.length, 30);
    c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34);
    c.writeUInt16LE(0, 36);
    c.writeUInt32LE(e.data ? 0o100644 * 65536 : 0o40755 * 65536 + 0x10, 38);
    c.writeUInt32LE(z64 ? 0xffffffff : offset, 42);
    central.push(c, name, extraCentral);
    offset += local.length + name.length + extraLocal.length + body.length;
  }
  const cd = Buffer.concat(central);
  const tail: Buffer[] = [];
  if (z64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeUInt32LE(0, 16);
    rec.writeUInt32LE(0, 20);
    rec.writeBigUInt64LE(BigInt(entries.length), 24);
    rec.writeBigUInt64LE(BigInt(entries.length), 32);
    rec.writeBigUInt64LE(BigInt(cd.length), 40);
    rec.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(rec, loc);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(z64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(z64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(z64 ? 0xffffffff : cd.length, 12);
  end.writeUInt32LE(z64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...parts, cd, ...tail, end]);
}

function zip64Extra(values: readonly number[]): Buffer {
  const b = Buffer.alloc(4 + 8 * values.length);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
  return b;
}

let seq = 0;
/** A tiny image, different every time (so none is a duplicate of another unless the test means it). */
export async function tinyImage(format: 'png' | 'webp' | 'jpeg' = 'webp', size = 8): Promise<Buffer> {
  const n = seq++;
  const img = sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: n % 256, g: Math.floor(n / 256) % 256, b: (n * 37) % 256 },
    },
  });
  return format === 'png'
    ? img.png().toBuffer()
    : format === 'jpeg'
      ? img.jpeg({ quality: 90 }).toBuffer()
      : img.webp({ lossless: true }).toBuffer();
}

/**
 * The owner's example (Z10): `Ishikawa_Rei.zip`'s layout, with tiny generated WebP images: 13 loose images at the top
 * level, and one folder per multi-piece outfit: Consort-Maid/ (11), Imperial Regalia/ (10), Lingerie/ (3, one named
 * without a number) and Wedding Dress/ (9). The folders are records of their own, as zip tools write them.
 */
export const REI_LAYOUT: Readonly<Record<string, readonly string[]>> = {
  '': [
    'Rei - Portrait',
    'Rei - Nightgown',
    'Rei - Swimwear',
    'Rei - Consort Dress',
    'Rei - Onsen',
    'Rei - Full Body',
    'Rei - Expression Sheet',
    'Rei - Back View',
    'Rei - Hair Down',
    'Rei - Kimono',
    'Rei - Travel Cloak',
    'Rei - Sleepwear',
    'Rei - Casual',
  ],
  'Consort-Maid': Array.from({ length: 11 }, (_, i) => `Rei - Consort-Maid ${i + 1}`),
  'Imperial Regalia': Array.from({ length: 10 }, (_, i) => `Rei - Imperial Regalia ${i + 1}`),
  Lingerie: ['Rei - Lingerie 1', 'Rei - Lingerie 2', 'Rei - Lingerie'],
  'Wedding Dress': Array.from({ length: 9 }, (_, i) => `Rei - Wedding Dress ${i + 1}`),
};

export async function reiZip(): Promise<Buffer> {
  const entries: ZipEntry[] = [];
  for (const [folder, names] of Object.entries(REI_LAYOUT)) {
    if (folder) entries.push({ name: `${folder}/` });
    for (const n of names)
      entries.push({ name: `${folder ? `${folder}/` : ''}${n}.webp`, data: await tinyImage('webp') });
  }
  return zip(entries);
}

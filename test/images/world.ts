/**
 * The D3 test world (ADR 0041): C2b's resources world (repository tree, asset tree and a reviewed taxonomy), plus a
 * local https server that plays both the signed-URL storage host (`storage.test`, PUT) and LegendKeeper's asset host
 * (`assets.test`, GET), and mock answers for createImageUpload and createImageAsset that tie the two together: the asset
 * a createImageAsset makes serves exactly the bytes PUT under its upload key (unless a test tampers with them).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOutboundPortAllowlist } from '../../src/auth/ports.js';
import {
  DEFAULT_IMAGE_SETTINGS,
  DEFAULT_TOOLS_SETTINGS,
  type ImageSettings,
} from '../../src/config/index.js';
import type { GuardOptions } from '../../src/mcp/tools/upload-http.js';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { resourcesWorld, type ResourcesWorld } from '../resources/world.js';
import { PROJECT } from '../tools/helpers.js';

export const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../fixtures/images/${name}`, import.meta.url));

export interface ImagesWorld extends ResourcesWorld {
  readonly port: number;
  readonly dataDir: string;
  /** The address guard the stack uses (the test hosts on loopback). */
  readonly guard: GuardOptions;
  /** Bytes PUT to the storage host, by upload key. */
  readonly puts: Map<string, Buffer>;
  /** Bytes the asset host serves, by asset id (a test may change them). */
  readonly served: Map<string, Buffer>;
  /** Asset ids whose download answers this status instead. */
  readonly failDownload: Map<string, number>;
  readonly gets: string[];
  /** Images served at `https://assets.test:<port>/img/<name>` (for url sources), with their content type. */
  readonly web: Map<string, { type: string; body: Buffer }>;
  /** v3 F2: ChatGPT-style files at `https://assets.test:<port>/f/<name>`: a status, a redirect or a streamed body. */
  readonly files: Map<string, { status: number; location?: string; type?: string; body?: Buffer }>;
  /** v3 F2: what the file route saw (host and path) and how many body bytes it wrote. */
  readonly fileStats: { requests: string[]; bytesSent: number };
  /** When set, the next asset created serves these bytes instead of what was uploaded (a corrupted store). */
  corruptNext: Buffer | null;
  /** The mock's createImageUpload / createImageAsset calls. */
  readonly lkUploads: unknown[];
  close(): Promise<void>;
}

let certCache: { key: Buffer; cert: string } | null = null;

/** A throwaway certificate for `storage.test` and `assets.test` (also the assumptions dry run's upload host, LIM1). */
export function certificate(): { key: Buffer; cert: string } {
  if (certCache) return certCache;
  const dir = mkdtempSync(join(tmpdir(), 'lkb-img-cert-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=storage.test',
      '-addext',
      'subjectAltName=DNS:storage.test,DNS:assets.test',
    ],
    { stdio: 'ignore' },
  );
  certCache = { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
  rmSync(dir, { recursive: true, force: true });
  return certCache;
}

export async function imagesWorld(
  o: Parameters<typeof resourcesWorld>[0] & { readonly images?: Partial<ImageSettings> } = {},
): Promise<ImagesWorld> {
  const { key, cert } = certificate();
  const puts = new Map<string, Buffer>();
  const served = new Map<string, Buffer>();
  const failDownload = new Map<string, number>();
  const gets: string[] = [];
  const lkUploads: unknown[] = [];
  const web = new Map<string, { type: string; body: Buffer }>();
  const dims = new Map<string, { width: number; height: number }>();
  // v3 F2 (ChatGPT files): `/f/<name>` answers what the test set: a status, a redirect, a body (streamed in chunks).
  const files = new Map<string, { status: number; location?: string; type?: string; body?: Buffer }>();
  const fileStats = { requests: [] as string[], bytesSent: 0 };
  const server: Server = createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0]!;
      if (req.method === 'PUT' && url.startsWith('/put/')) {
        const key = url.slice(5);
        const bytes = Buffer.concat(chunks);
        puts.set(key, bytes);
        // LegendKeeper reads the stored file's pixel dimensions (one frame's height for an animation).
        void sharp(bytes, { animated: true })
          .metadata()
          .then((m) => dims.set(key, { width: m.width ?? 0, height: m.pageHeight ?? m.height ?? 0 }))
          .catch(() => undefined)
          .finally(() => res.writeHead(200).end());
        return;
      }
      if (req.method === 'GET' && url.startsWith('/f/')) {
        fileStats.requests.push(`${req.headers.host ?? ''}${req.url ?? ''}`);
        const f = files.get(url.slice(3));
        if (!f) return void res.writeHead(404).end();
        if (f.location) return void res.writeHead(f.status, { location: f.location }).end();
        const body = f.body ?? Buffer.alloc(0);
        res.writeHead(f.status, { 'content-type': f.type ?? 'application/octet-stream' });
        let at = 0;
        const pump = () => {
          while (at < body.length && !res.destroyed) {
            const chunk = body.subarray(at, at + 16_384);
            at += chunk.length;
            fileStats.bytesSent += chunk.length;
            if (!res.write(chunk)) return void res.once('drain', pump);
          }
          if (!res.destroyed) res.end();
        };
        pump();
        return;
      }
      if (req.method === 'GET' && url.startsWith('/img/')) {
        const img = web.get(url.slice(5));
        if (!img) return void res.writeHead(404).end();
        res.writeHead(200, { 'content-type': img.type, 'content-length': img.body.length });
        return void res.end(img.body);
      }
      if (req.method === 'GET' && url.startsWith('/a/')) {
        gets.push(url);
        const id = url.slice(3).replace(/\.webp$/, '');
        const fail = failDownload.get(id);
        if (fail) return void res.writeHead(fail).end();
        const b = served.get(id);
        if (!b) return void res.writeHead(404).end();
        res.writeHead(200, { 'content-type': 'image/webp', 'content-length': b.length });
        return void res.end(b);
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const guard: GuardOptions = {
    resolve: (host) =>
      Promise.resolve(host.endsWith('.test') ? [{ address: '127.0.0.1', family: 4 as const }] : []),
    ca: cert,
    allowAddress: (a) => a === '127.0.0.1',
    allowedPorts: parseOutboundPortAllowlist(`storage.test:${port},assets.test:${port}`),
  };
  const dataDir = mkdtempSync(join(tmpdir(), 'lkb-images-'));
  const w = (await resourcesWorld({
    ...o,
    uploadGuard: guard,
    tools: {
      ...DEFAULT_TOOLS_SETTINGS,
      ...o.tools,
      images: {
        ...DEFAULT_IMAGE_SETTINGS,
        assetHosts: ['assets.test'],
        dataDir,
        // v3 F2: a test container's disk may be small; the low-disk refusal has its own test.
        stagingMinFreeBytes: 0,
        ...o.images,
      },
    },
  })) as ImagesWorld;
  let n = 0;
  const keyOfUpload = new Map<string, string>();
  w.overrides.set(/\/assets\/uploads$/, (req: MockRequest): MockResponse | undefined => {
    if (req.method !== 'POST') return undefined;
    lkUploads.push({ op: 'createImageUpload', body: req.body });
    const k = `k${++n}`;
    return {
      status: 201,
      body: {
        uploadKey: k,
        uploadUrl: `https://storage.test:${port}/put/${k}`,
        method: 'PUT',
        headers: { 'content-type': (req.body as { contentType: string }).contentType },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    };
  });
  w.overrides.set(/\/assets\/images$/, (req: MockRequest): MockResponse | undefined => {
    if (req.method !== 'POST') return undefined;
    lkUploads.push({ op: 'createImageAsset', body: req.body });
    const r = w.assets.respond(req);
    if (!r || r.status !== 201) return r;
    const id = (r.body as { id: string }).id;
    const a = w.assets.assets.get(id)!;
    a.url = `https://assets.test:${port}/a/${id}.webp`;
    const uploadKey = (req.body as { uploadKey: string }).uploadKey;
    keyOfUpload.set(id, uploadKey);
    const d = dims.get(uploadKey);
    if (d) Object.assign(a, d);
    const bytes = world.corruptNext ?? puts.get(uploadKey);
    world.corruptNext = null;
    if (bytes) served.set(id, bytes);
    return { status: 201, body: { ...(r.body as object), url: a.url, ...(d ?? {}) } };
  });
  void PROJECT;
  const closeWorld = (w as unknown as { close: () => Promise<void> }).close.bind(w);
  const world: ImagesWorld = Object.assign(w, {
    port,
    dataDir,
    guard,
    puts,
    served,
    failDownload,
    gets,
    web,
    files,
    fileStats,
    corruptNext: null as Buffer | null,
    lkUploads,
    async close() {
      await closeWorld();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      rmSync(dataDir, { recursive: true, force: true });
    },
  });
  return world;
}

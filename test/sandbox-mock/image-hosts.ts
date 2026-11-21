/**
 * CR-2026-11-R4 (the owner's request S): LegendKeeper's image hosts for a mock world that has none (the map world), so
 * a sandbox check's uploads run through the real image pipeline on the mock instead of a stand-in, as the image and
 * snapshot worlds already let them: a local https server on loopback that plays the signed-URL storage host
 * (`storage.test`, PUT) and the asset host (`assets.test`, GET), and the mock's `createImageUpload` and
 * `createImageAsset` tied to it as LegendKeeper ties them (the asset serves exactly the bytes PUT under its upload key,
 * with the stored file's pixel size; the images world's model, ADR 0041). Nothing here leaves loopback.
 */
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { parseOutboundPortAllowlist } from '../../src/auth/ports.js';
import type { GuardOptions } from '../../src/mcp/tools/upload-http.js';
import type { AssetModel } from '../assets/model.js';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { certificate } from '../images/world.js';

export interface ImageHosts {
  /** The address guard for the hosts (loopback only, their port, the test certificate). */
  readonly guard: GuardOptions;
  readonly assetHosts: readonly string[];
  /** Bytes the asset host serves, by asset id. */
  readonly served: Map<string, Buffer>;
  close(): Promise<void>;
}

/** Adds the hosts to a world, before its own asset routes (`overrides` is consulted first, in order). */
export async function addImageHosts(w: {
  readonly assets: AssetModel;
  readonly overrides: Map<RegExp, (req: MockRequest) => MockResponse | undefined>;
}): Promise<ImageHosts> {
  const { key, cert } = certificate();
  const puts = new Map<string, Buffer>();
  const served = new Map<string, Buffer>();
  const dims = new Map<string, { width: number; height: number }>();
  const server: Server = createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0]!;
      if (req.method === 'PUT' && url.startsWith('/put/')) {
        const k = url.slice(5);
        const bytes = Buffer.concat(chunks);
        puts.set(k, bytes);
        // LegendKeeper reads the stored file's pixel dimensions (one frame's height for an animation).
        void sharp(bytes, { animated: true })
          .metadata()
          .then((m) => dims.set(k, { width: m.width ?? 0, height: m.pageHeight ?? m.height ?? 0 }))
          .catch(() => undefined)
          .finally(() => res.writeHead(200).end());
        return;
      }
      if (req.method === 'GET' && url.startsWith('/a/')) {
        const b = served.get(url.slice(3).replace(/\.webp$/, ''));
        if (!b) return void res.writeHead(404).end();
        res.writeHead(200, { 'content-type': 'image/webp', 'content-length': b.length });
        return void res.end(b);
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  let n = 0;
  const routes = new Map<RegExp, (req: MockRequest) => MockResponse | undefined>([
    [
      /\/assets\/uploads$/,
      (req) => {
        if (req.method !== 'POST') return undefined;
        const k = `hk${++n}`;
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
      },
    ],
    [
      /\/assets\/images$/,
      (req) => {
        if (req.method !== 'POST') return undefined;
        const r = w.assets.respond(req);
        if (!r || r.status !== 201) return r;
        const id = (r.body as { id: string }).id;
        const a = w.assets.assets.get(id)!;
        a.url = `https://assets.test:${port}/a/${id}.webp`;
        const uploadKey = (req.body as { uploadKey: string }).uploadKey;
        const d = dims.get(uploadKey);
        if (d) Object.assign(a, d);
        const bytes = puts.get(uploadKey);
        if (bytes) served.set(id, bytes);
        return { status: 201, body: { ...(r.body as object), url: a.url, ...(d ?? {}) } };
      },
    ],
  ]);
  const rest = [...w.overrides.entries()];
  w.overrides.clear();
  for (const [k, v] of routes) w.overrides.set(k, v);
  for (const [k, v] of rest) if (!routes.has(k)) w.overrides.set(k, v);
  return {
    guard: {
      resolve: (host) =>
        Promise.resolve(host.endsWith('.test') ? [{ address: '127.0.0.1', family: 4 as const }] : []),
      ca: cert,
      allowAddress: (a) => a === '127.0.0.1',
      allowedPorts: parseOutboundPortAllowlist(`storage.test:${port},assets.test:${port}`),
    },
    assetHosts: ['assets.test'],
    served,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

/**
 * Serves the built dashboard (`ui/dist`) at `/ui`, with a single-page-app fallback, behind the owner's session:
 * a request without one is sent to the existing sign-in page (`/oauth/login?return_to=…`) and comes back afterwards.
 * Every response carries the strict security headers of the dashboard (no inline script, no framing, no referrer).
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { safeReturnTo } from '../auth/routes/login.js';
import { DEFAULT_LK_ASSET_HOST } from '../lk/constants.js';
import { OAUTH_PATHS } from '../auth/routes/metadata.js';
import type { AuthServices } from '../auth/services.js';

/**
 * The Content-Security-Policy of the dashboard: same-origin everything, scripts only from files, no framing. v2 D3 (ADR
 * 0041): images may also come from LegendKeeper's asset host (the Staging page's thumbnails are the assets' own URLs;
 * nothing else is loaded from it, and a thumbnail sends no cookie of the bridge's and, with `no-referrer`, no referrer).
 */
export const UI_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  `img-src 'self' data: https://${DEFAULT_LK_ASSET_HOST}`,
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

export function uiSecurityHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header('content-security-policy', UI_CSP)
    .header('x-frame-options', 'DENY')
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .header('cross-origin-opener-policy', 'same-origin')
    .header('cross-origin-resource-policy', 'same-origin')
    .header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Maps the part of the URL after `/ui` to a file under `root`, or undefined when it would leave `root`. */
export function resolveUiPath(root: string, rest: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const full = normalize(join(root, decoded));
  return full === root || full.startsWith(root + sep) ? full : undefined;
}

async function fileIfExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function registerUi(app: FastifyInstance, s: AuthServices, uiDir: string): void {
  const { owner } = s;
  const root = normalize(uiDir);

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    uiSecurityHeaders(reply);
    if (!owner.getSession(req.cookies[owner.sessionCookie])) {
      const target = safeReturnTo(req.url) ?? '/ui';
      return reply
        .header('cache-control', 'no-store')
        .redirect(`${OAUTH_PATHS.login}?return_to=${encodeURIComponent(target)}`, 303);
    }
    const path = req.url.split('?')[0] ?? '/ui';
    const rest = path.replace(/^\/ui\/?/, '');
    const file = resolveUiPath(root, rest);
    if (file === undefined) return reply.code(404).type('text/plain; charset=utf-8').send('Not found');

    if (rest !== '' && (await fileIfExists(file))) {
      const hashed = rest.startsWith('assets/');
      return reply
        .header('cache-control', hashed ? 'private, max-age=31536000, immutable' : 'private, no-cache')
        .type(TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
        .send(await readFile(file));
    }
    // A path with a file extension that does not exist is a missing asset, not an app route.
    if (extname(rest) !== '') return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
    // Single-page-app fallback: every other path is a route inside the app.
    const index = join(root, 'index.html');
    if (!(await fileIfExists(index))) {
      return reply
        .code(503)
        .header('cache-control', 'no-store')
        .type('text/plain; charset=utf-8')
        .send('The dashboard has not been built. Run "npm run build" and restart the bridge.');
    }
    return reply
      .header('cache-control', 'no-store')
      .type(TYPES['.html']!)
      .send(await readFile(index));
  };

  app.get('/ui', handler);
  app.get('/ui/*', handler);
}

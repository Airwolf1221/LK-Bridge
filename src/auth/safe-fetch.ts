import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPublicAddress } from './ip.js';
import { type OutboundPortAllowlist, outboundPortAllowed, portRefusalMessage } from './ports.js';

/**
 * SSRF-hardened HTTPS GET for small JSON documents (Client ID Metadata Documents).
 *
 * - HTTPS only, port 443 only unless `host:port` is in OUTBOUND_EXTRA_PORTS_ALLOWLIST (`ports.ts`); redirects are
 *   refused, not followed.
 * - Every address the hostname resolves to must be globally routable, and the socket connects to
 *   an address that was checked (the check runs inside the connection's DNS lookup, so a second
 *   resolution cannot swap in a private address).
 * - One deadline covers DNS, connect, TLS and body; the body is capped in bytes.
 * - No cookies, no credentials, no compression, no connection reuse.
 *
 * Uses `node:https` rather than global `fetch`: `fetch` cannot pin the checked address, and the
 * repository bans `fetch` outside the LK governor (ADR 0003).
 */

export type SafeFetchFailure =
  | 'invalid_url'
  | 'blocked_address'
  | 'blocked_port'
  | 'dns'
  | 'timeout'
  | 'network'
  | 'redirect'
  | 'bad_status'
  | 'bad_content_type'
  | 'too_large'
  | 'invalid_json';

export class SafeFetchError extends Error {
  constructor(
    readonly reason: SafeFetchFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface SafeFetchOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** `host:port` pairs allowed besides port 443 (OUTBOUND_EXTRA_PORTS_ALLOWLIST). Default: none. */
  readonly allowedPorts?: OutboundPortAllowlist;
  /** The `User-Agent` sent. Default: the client metadata fetcher's. */
  readonly userAgent?: string;
  /** The `Accept` header sent. Default: `application/json`. */
  readonly accept?: string;
  /** Test seam: replaces DNS resolution. */
  readonly resolve?: (hostname: string) => Promise<readonly LookupAddress[]>;
  /** Test seam: additional trusted CA certificates (PEM). */
  readonly ca?: string;
  /** Test seam: accept addresses the public-address policy would refuse. Never set in production. */
  readonly allowAddress?: (address: string) => boolean;
}

export interface SafeFetchResult {
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export type JsonFetcher = (url: string) => Promise<SafeFetchResult>;

function defaultResolve(hostname: string): Promise<readonly LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

export function createSafeJsonFetcher(options: SafeFetchOptions): JsonFetcher {
  const resolve = options.resolve ?? defaultResolve;
  const allowed = (address: string) => isPublicAddress(address) || options.allowAddress?.(address) === true;

  const guardedLookup: LookupFunction = (hostname, lookupOptions, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(new SafeFetchError('dns', 'Host has no addresses'), '', 4);
          return;
        }
        if (!addresses.every((a) => allowed(a.address))) {
          callback(new SafeFetchError('blocked_address', 'Host resolves to a non-public address'), '', 4);
          return;
        }
        if (lookupOptions.all) {
          (callback as unknown as (e: null, a: readonly LookupAddress[]) => void)(null, addresses);
        } else {
          const first = addresses[0] as LookupAddress;
          callback(null, first.address, first.family);
        }
      },
      (err: unknown) => {
        callback(new SafeFetchError('dns', `DNS lookup failed: ${(err as Error).message}`), '', 4);
      },
    );
  };

  return (rawUrl: string) =>
    new Promise<SafeFetchResult>((resolvePromise, reject) => {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        reject(new SafeFetchError('invalid_url', 'Not a URL'));
        return;
      }
      if (url.protocol !== 'https:' || url.username || url.password) {
        reject(new SafeFetchError('invalid_url', 'Only credential-free https URLs are fetched'));
        return;
      }
      // Before any DNS lookup or connection: the port, then a literal address.
      if (!outboundPortAllowed(url, options.allowedPorts)) {
        reject(new SafeFetchError('blocked_port', portRefusalMessage(url)));
        return;
      }
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      if (isIP(hostname) !== 0 && !allowed(hostname)) {
        reject(new SafeFetchError('blocked_address', 'URL names a non-public address'));
        return;
      }

      let settled = false;
      const fail = (err: SafeFetchError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        reject(err);
      };

      const req = request(url, {
        method: 'GET',
        headers: {
          accept: options.accept ?? 'application/json',
          'accept-encoding': 'identity',
          'user-agent': options.userAgent ?? 'LK-Bridge (OAuth client metadata fetcher)',
        },
        lookup: guardedLookup,
        agent: false,
        maxHeaderSize: 16 * 1024,
        ...(options.ca ? { ca: options.ca } : {}),
      });
      const timer = setTimeout(
        () => fail(new SafeFetchError('timeout', `No complete response within ${options.timeoutMs} ms`)),
        options.timeoutMs,
      );

      req.on('error', (err) => {
        fail(
          err instanceof SafeFetchError
            ? err
            : new SafeFetchError('network', `Request failed: ${err.message}`),
        );
      });

      req.on('response', (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          fail(new SafeFetchError('redirect', `Redirects are not followed (HTTP ${status})`));
          return;
        }
        if (status !== 200) {
          fail(new SafeFetchError('bad_status', `Expected HTTP 200, got ${status}`));
          return;
        }
        const contentType = (res.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        if (contentType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(contentType)) {
          // The received type is logged (an HTML challenge page shows up as text/html), cut short and limited to
          // the characters a media type may contain.
          const got = contentType.replace(/[^a-z0-9.+/-]/g, '').slice(0, 80) || '(none)';
          fail(new SafeFetchError('bad_content_type', `Expected a JSON content type, got ${got}`));
          return;
        }
        const encoding = res.headers['content-encoding'];
        if (encoding && encoding.toLowerCase() !== 'identity') {
          fail(new SafeFetchError('bad_content_type', 'Compressed responses are not accepted'));
          return;
        }
        const declared = Number(res.headers['content-length'] ?? '0');
        if (declared > options.maxBytes) {
          fail(new SafeFetchError('too_large', `Document exceeds ${options.maxBytes} bytes`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            fail(new SafeFetchError('too_large', `Document exceeds ${options.maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (err) => fail(new SafeFetchError('network', `Response failed: ${err.message}`)));
        res.on('end', () => {
          if (settled) return;
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            fail(new SafeFetchError('invalid_json', 'Document is not valid JSON'));
            return;
          }
          settled = true;
          clearTimeout(timer);
          const pick = (name: string) => {
            const v = res.headers[name];
            return Array.isArray(v) ? v.join(', ') : v;
          };
          resolvePromise({
            body,
            headers: {
              'cache-control': pick('cache-control'),
              expires: pick('expires'),
              date: pick('date'),
              age: pick('age'),
            },
          });
        });
      });
      req.end();
    });
}

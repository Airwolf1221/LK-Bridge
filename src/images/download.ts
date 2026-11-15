/**
 * Downloading a stored asset file (v2 D3, ADR 0041). PLAN-v2 section 2 (verified): asset images download from
 * `assets.legendkeeper.com` without authentication. The request still goes through the project's governor (pacing,
 * retries on 5xx and connection errors) and the guarded transport (https only, public addresses, the port allowlist,
 * the DNS answer pinned), which sends a GET only to a host in LK_ASSET_HOSTS. No API key is ever sent with it.
 *
 * Used by the upload's verification (`upload_image.verify`) and by the bytes kept before an asset delete.
 */
import { createHash } from 'node:crypto';
import type { LkClient } from '../lk/client.js';
import type { PriorityClass } from '../lk/governor/index.js';

export class AssetDownloadError extends Error {
  constructor(
    readonly reason: 'no_url' | 'not_asset_host' | 'redirect' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'AssetDownloadError';
  }
}

export interface DownloadedAsset {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly contentType: string | null;
  /**
   * v2 E5.2: the URL the bytes came from when it is not the one asked for (the download followed a redirect, from
   * `assets` to `assets2`). Only for a run's detail: the reference recorded stays the URL asked for.
   */
  readonly finalUrl?: string;
}

/** True when `url` is an https URL on one of the asset hosts. */
export function isAssetUrl(url: unknown, hosts: readonly string[]): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && hosts.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** v2 E5.2: the most redirects one download follows. */
export const MAX_ASSET_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * What one hop answered: the file (a Response, which the governor judges as before: a 5xx is retried, a 404 refused),
 * or a redirect to follow.
 */
type Hop =
  Response | { readonly kind: 'redirect'; readonly status: number; readonly location: string | null };

/**
 * Downloads one asset file. Throws `AssetDownloadError` (its message never contains a key).
 *
 * v2 E5.2: LegendKeeper serves some files from `assets2` (a GET on `assets` answers 302 to the same path there). A
 * redirect is followed here, and only here (the general transport still refuses every redirect: the API, OAuth and
 * uploads): at most {@link MAX_ASSET_REDIRECTS} hops, on 301, 302, 303, 307 or 308 with a `Location` (a relative one
 * resolved against the URL that answered). Every hop is checked like the first: `isAssetUrl` (https, no credentials,
 * a host in LK_ASSET_HOSTS) here, then the transport's guards (public addresses, the port allowlist, the pinned DNS)
 * on its own request; and each hop goes through the governor. A loop, a fourth hop, or a host off the list is refused
 * with the reason. No API key or other credential is sent on any hop. A redirect's (empty) body is never the asset.
 */
export async function downloadAsset(
  lk: LkClient,
  url: unknown,
  o: {
    readonly hosts: readonly string[];
    readonly priority: PriorityClass;
    readonly opId: string;
    readonly jobId?: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  },
): Promise<DownloadedAsset> {
  if (typeof url !== 'string' || url === '')
    throw new AssetDownloadError('no_url', 'The asset has no file URL.');
  if (!isAssetUrl(url, o.hosts)) {
    throw new AssetDownloadError(
      'not_asset_host',
      `The asset's file URL is not on an asset host the bridge downloads from (LK_ASSET_HOSTS: ${o.hosts.join(', ')}).`,
    );
  }
  const seen = new Set<string>([url]);
  let current = url;
  for (let hops = 0; ; hops++) {
    let hop: Hop;
    try {
      hop = await lk.governor.execute<Hop>({
        opId: o.opId,
        kind: 'read',
        // Not a LegendKeeper API request: the file host's downloads draw on no API tier.
        costs: { tiers: [] },
        priority: o.priority,
        ...(o.jobId ? { jobId: o.jobId } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
        timeoutMs: o.timeoutMs ?? 120_000,
        run: async (signal) => {
          // Only `accept`: never an Authorization header, a cookie or any other credential.
          const res = await lk.fetch(current, { method: 'GET', signal });
          if (REDIRECTS.has(res.status)) {
            await res.body?.cancel();
            return { kind: 'redirect', status: res.status, location: res.headers.get('location') };
          }
          return res;
        },
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      throw new AssetDownloadError('failed', `The asset file could not be downloaded: ${m}`);
    }
    if (!(hop instanceof Response)) {
      const next = nextHop(current, hop, hops, seen, o.hosts);
      seen.add(next);
      current = next;
      continue;
    }
    const res = hop;
    if (!res.ok) {
      throw new AssetDownloadError('failed', `The asset file could not be downloaded: HTTP ${res.status}.`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    return {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentType: res.headers.get('content-type'),
      ...(current !== url ? { finalUrl: current } : {}),
    };
  }
}

/** The URL a redirect leads to, checked; or the refusal (`redirect`, naming the reason and any host). */
function nextHop(
  from: string,
  hop: { readonly status: number; readonly location: string | null },
  hops: number,
  seen: ReadonlySet<string>,
  hosts: readonly string[],
): string {
  const refuse = (why: string) =>
    new AssetDownloadError('redirect', `The asset file could not be downloaded: ${why}`);
  if (!hop.location) throw refuse(`the file host answered HTTP ${hop.status} with no Location.`);
  if (hops >= MAX_ASSET_REDIRECTS)
    throw refuse(`more than ${MAX_ASSET_REDIRECTS} redirects (HTTP ${hop.status} again).`);
  let next: URL;
  try {
    next = new URL(hop.location, from);
  } catch {
    throw refuse(`HTTP ${hop.status} redirected to something that is not a URL.`);
  }
  const host = next.hostname.toLowerCase();
  if (next.protocol !== 'https:')
    throw refuse(
      `HTTP ${hop.status} redirected to a ${next.protocol.replace(/:$/, '')} URL on ${host}; only https is followed.`,
    );
  if (next.username || next.password)
    throw refuse(`HTTP ${hop.status} redirected to a URL with credentials on ${host}.`);
  if (!isAssetUrl(next.href, hosts))
    throw refuse(
      `HTTP ${hop.status} redirected to ${host}, which is not an asset host the bridge downloads from (LK_ASSET_HOSTS: ${hosts.join(', ')}).`,
    );
  if (seen.has(next.href)) throw refuse(`the redirects loop (back to ${host}).`);
  return next.href;
}

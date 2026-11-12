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
    readonly reason: 'no_url' | 'not_asset_host' | 'failed',
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

/** Downloads one asset file. Throws `AssetDownloadError` (its message never contains a key). */
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
  let res: Response;
  try {
    res = await lk.governor.execute<Response>({
      opId: o.opId,
      kind: 'read',
      // Not a LegendKeeper API request: the file host's downloads draw on no API tier.
      costs: { tiers: [] },
      priority: o.priority,
      ...(o.jobId ? { jobId: o.jobId } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      timeoutMs: o.timeoutMs ?? 120_000,
      run: (signal) => lk.fetch(url, { method: 'GET', signal }),
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    throw new AssetDownloadError('failed', `The asset file could not be downloaded: ${m}`);
  }
  if (!(res instanceof Response)) {
    throw new AssetDownloadError('failed', 'The asset file could not be downloaded: no response body.');
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentType: res.headers.get('content-type'),
  };
}

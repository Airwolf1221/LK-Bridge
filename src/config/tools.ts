/**
 * Settings of the MCP tool layer (src/mcp/tools). Parsed from its own environment variables, like
 * `loadAuthConfig`, so the main config schema is untouched. `MCP_EXPOSE_PER_OP_TOOLS` stays in the main config
 * (`config.mcp.exposePerOpTools`).
 *
 * Values are only read inside functions, because `./index.ts` re-exports this module (import cycle, as in lk.ts).
 */
import * as z from 'zod';
import { ConfigError } from './index.js';
import { DEFAULT_LK_ASSET_HOSTS } from '../lk/constants.js';
import { type OutboundPortAllowlist, parseOutboundPortAllowlist } from '../auth/ports.js';
import { bool, intFrom, numberFrom } from './schema-helpers.js';

/** The tool layer's schema (`loadToolsConfig`). Exported for the settings registry (v3 F8, ADR 0073). */
export const TOOLS_ENV_SCHEMA = z.object({
  /** Largest image the bridge will upload (decoded bytes), from base64 or a URL. */
  UPLOAD_MAX_BYTES: intFrom(10 * 1024 * 1024, 1024, 100 * 1024 * 1024),
  /** `lk_upload_image` may fetch a public https URL. Set false to accept base64 only. */
  UPLOAD_ALLOW_URL_SOURCE: bool(true),
  /** Deadline for fetching an image from a URL (DNS, connect, TLS and body). */
  UPLOAD_FETCH_TIMEOUT_MS: intFrom(15_000, 1_000, 120_000),
  /**
   * Per-attempt deadline of the signed-URL PUT (the image upload itself). Its own setting: a large image on a slow
   * link needs longer than the governor's 30-second LegendKeeper request timeout. 5 s to 10 minutes.
   */
  UPLOAD_PUT_TIMEOUT_MS: intFrom(120_000, 5_000, 600_000),
  /** A tool result longer than this many characters is stored as a job artefact and returned as a handle. */
  MCP_RESULT_MAX_CHARS: intFrom(40_000, 4_000, 400_000),
  /** `host:port` pairs the image fetch and the upload PUT may use besides 443 (v1.0.1). Parsed below. */
  OUTBOUND_EXTRA_PORTS_ALLOWLIST: z.string().optional(),
  // ---- v2 D3 (ADR 0041): the image pipeline
  /** Most pixels an image may have, all frames together (sharp's `limitInputPixels`). About 100 megapixels. */
  IMAGE_MAX_PIXELS: intFrom(100_000_000, 1_000, 1_000_000_000),
  /** Most frames an animation may have. */
  IMAGE_MAX_FRAMES: intFrom(300, 1, 10_000),
  /** Time limit of one conversion. */
  IMAGE_CONVERT_TIMEOUT_MS: intFrom(60_000, 1_000, 600_000),
  /** Conversions that may run at once (each holds a decoded image in memory). */
  IMAGE_CONVERT_CONCURRENCY: intFrom(1, 1, 4),
  /**
   * The bridge's private image directory: the binary endpoint's temporary files (`upload-tmp/`) and the bytes kept
   * before an asset is deleted (`kept-bytes/`). Default: `images/` next to the database (DB_PATH's directory).
   */
  IMAGE_DATA_DIR: z.string().min(1).optional(),
  /**
   * v3 F7c (ADR 0075, Z3): a runaway brake only, per connection (principal) per hour: images staged on the server,
   * accepted binary uploads and `prepare_image_upload` calls (each counted on its own). The real limit is
   * IMAGE_STAGED_MAX_BYTES.
   */
  IMAGE_UPLOAD_RATE_PER_PRINCIPAL: intFrom(1000, 1, 100_000),
  /**
   * v3 F7c (Z3): requests to the binary endpoint per client address per hour that fail authentication or are refused
   * before it; an authenticated request is not counted.
   */
  IMAGE_UPLOAD_RATE_PER_IP: intFrom(60, 1, 100_000),
  // ---- v3 F7c (ADR 0075, Z2, Z3): image archives
  /** Most entries an image archive may hold (its central directory's count, folders and skipped files included). */
  IMAGE_ARCHIVE_MAX_ENTRIES: intFrom(300, 1, 10_000),
  /** Most bytes an image archive may unpack to, every entry together (also the largest archive file accepted). */
  IMAGE_ARCHIVE_MAX_UNCOMPRESSED_BYTES: intFrom(2 * 1024 ** 3, 1024 * 1024, 20 * 1024 ** 3),
  /** The total size of the images staged on the bridge's server: a staging past it is held (an archive) or refused. */
  IMAGE_STAGED_MAX_BYTES: intFrom(5 * 1024 ** 3, 1024 * 1024, 1024 ** 4),
  /** Deadline for receiving a whole upload body, and the longest silence within it (slow-loris). */
  IMAGE_UPLOAD_BODY_TIMEOUT_MS: intFrom(120_000, 5_000, 1_800_000),
  IMAGE_UPLOAD_IDLE_TIMEOUT_MS: intFrom(15_000, 1_000, 300_000),
  /** Staged images older than this are reported on the dashboard (never removed automatically). */
  IMAGE_STAGING_REPORT_DAYS: intFrom(30, 1, 3650),
  // v3 F2 (ADR 0049 decision 10): an unplaced image staged on the server is removed after this many days, a week after
  // the dashboard first warned (per project on the Projects page: imageStagingMaxDays); and the image store keeps this
  // much free disk (a new staging upload is refused below it).
  IMAGE_STAGING_MAX_DAYS: intFrom(90, 1, 3650),
  IMAGE_STAGING_MIN_FREE_GB: numberFrom(5, 0, 100_000),
  /** How long the bytes kept before an asset delete are kept. */
  ASSET_BYTES_RETENTION_DAYS: intFrom(90, 1, 3650),
  /**
   * The hosts LegendKeeper serves asset files from; the bridge downloads (GET, no credentials) only from these, and a
   * download's redirect is followed only to one of them. Default (v2 E5.2): assets and assets2.legendkeeper.com.
   */
  LK_ASSET_HOSTS: z.string().default(DEFAULT_LK_ASSET_HOSTS.join(',')),
  // ---- v3 F7b (ADR 0071, D6): the derivatives arkona_get_art delivers inline
  /** The art cache's directory. Default: `art-cache/` next to the database (DB_PATH's directory). */
  ART_CACHE_DIR: z.string().min(1).optional(),
  /** The most the art cache holds, in MB; the least recently used entries go first. */
  ART_CACHE_MAX_MB: intFrom(500, 1, 1_000_000),
  // ---- v2 E1a (ADR 0042): the snapshot store
  /** The snapshot store's directory (objects, manifests). Default: `snapshots/` next to the database. */
  SNAPSHOT_DIR: z.string().min(1).optional(),
  /** A full snapshot is refused rather than leave less than this much free space (GiB, as `df -h` shows it). */
  SNAPSHOT_MIN_FREE_GB: numberFrom(10, 0, 100_000),
  /** Days every full snapshot is kept (they are nightly). */
  SNAPSHOT_KEEP_FULL_DAYS: intFrom(30, 1, 3650),
  /** After those days, weeks one full snapshot a week is kept (the latest of each ISO week). */
  SNAPSHOT_KEEP_WEEKLY: intFrom(8, 0, 520),
  /** Days change snapshots are kept. */
  SNAPSHOT_KEEP_DAYS: intFrom(30, 1, 3650),
  /**
   * How long LegendKeeper is taken to keep a deleted page restorable (its soft delete): a restore of a page deleted more
   * recently than this undeletes it; an older one is recreated from the snapshot. LegendKeeper does not publish it.
   */
  SNAPSHOT_SOFT_DELETE_DAYS: intFrom(30, 1, 3650),
});

export interface ToolsSettings {
  readonly upload: {
    readonly maxBytes: number;
    readonly allowUrlSource: boolean;
    readonly fetchTimeoutMs: number;
    /** UPLOAD_PUT_TIMEOUT_MS: per-attempt deadline of the signed-URL PUT. */
    readonly putTimeoutMs: number;
  };
  /**
   * OUTBOUND_EXTRA_PORTS_ALLOWLIST: `host:port` pairs the image source fetch and the signed-URL PUT may use besides
   * port 443 (src/auth/ports.ts). Empty by default: 443 only.
   */
  readonly outboundExtraPorts: OutboundPortAllowlist;
  /** Results above this many characters become artefact handles (PLAN §7: about 40,000). */
  readonly resultMaxChars: number;
  /** v2 D3 (ADR 0041): the image pipeline. */
  readonly images: ImageSettings;
  /** v2 E1a (ADR 0042): the snapshot store. Optional for callers built before E1a (the defaults apply). */
  readonly snapshots?: SnapshotStoreSettings;
  /** v3 F7b (ADR 0071, D6): the art cache (ART_CACHE_DIR, ART_CACHE_MAX_MB). Optional: the defaults apply. */
  readonly artCache?: ArtCacheSettings;
}

/** v3 F7b (ADR 0071, D6): the art cache's settings. */
export interface ArtCacheSettings {
  /** ART_CACHE_DIR, or null for `art-cache/` next to the database. */
  readonly dir: string | null;
  /** ART_CACHE_MAX_MB in bytes. */
  readonly maxBytes: number;
}

export const DEFAULT_ART_CACHE_SETTINGS: ArtCacheSettings = { dir: null, maxBytes: 500 * 1024 * 1024 };

/** v2 E1a (ADR 0042): the snapshot store's settings (env). */
export interface SnapshotStoreSettings {
  /** SNAPSHOT_DIR, or null for `snapshots/` next to the database. */
  readonly dataDir: string | null;
  /** SNAPSHOT_MIN_FREE_GB in bytes (GiB). */
  readonly minFreeBytes: number;
  /** SNAPSHOT_KEEP_FULL_DAYS: every full snapshot is kept this many days. */
  readonly keepFullDays: number;
  /** SNAPSHOT_KEEP_WEEKLY: then one per ISO week (the latest of that week) for this many weeks. */
  readonly keepWeekly: number;
  /** SNAPSHOT_KEEP_DAYS: change snapshots are kept this many days. */
  readonly keepDays: number;
  readonly softDeleteDays: number;
}

export const GIB = 1024 ** 3;

export const DEFAULT_SNAPSHOT_SETTINGS: SnapshotStoreSettings = {
  dataDir: null,
  minFreeBytes: 10 * GIB,
  keepFullDays: 30,
  keepWeekly: 8,
  keepDays: 30,
  softDeleteDays: 30,
};

export interface ImageSettings {
  readonly maxPixels: number;
  readonly maxFrames: number;
  readonly convertTimeoutMs: number;
  readonly convertConcurrency: number;
  /** IMAGE_DATA_DIR, or null for `images/` next to the database. */
  readonly dataDir: string | null;
  readonly ratePerPrincipalPerHour: number;
  readonly ratePerIpPerHour: number;
  readonly bodyTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly stagingReportDays: number;
  /** v3 F2: IMAGE_STAGING_MAX_DAYS (the project setting imageStagingMaxDays overrides it). */
  readonly stagingMaxDays: number;
  /** v3 F2: IMAGE_STAGING_MIN_FREE_GB in bytes: the free disk a new staging upload needs. */
  readonly stagingMinFreeBytes: number;
  readonly keptBytesRetentionDays: number;
  /** v3 F7c (ADR 0075): IMAGE_ARCHIVE_MAX_ENTRIES. */
  readonly archiveMaxEntries: number;
  /** v3 F7c: IMAGE_ARCHIVE_MAX_UNCOMPRESSED_BYTES (also the largest archive file). */
  readonly archiveMaxUncompressedBytes: number;
  /** v3 F7c: IMAGE_STAGED_MAX_BYTES, the staging capacity. */
  readonly stagedMaxBytes: number;
  /** Lowercase host names asset files are downloaded from. */
  readonly assetHosts: readonly string[];
}

export const DEFAULT_IMAGE_SETTINGS: ImageSettings = {
  maxPixels: 100_000_000,
  maxFrames: 300,
  convertTimeoutMs: 60_000,
  convertConcurrency: 1,
  dataDir: null,
  ratePerPrincipalPerHour: 1000,
  ratePerIpPerHour: 60,
  bodyTimeoutMs: 120_000,
  idleTimeoutMs: 15_000,
  stagingReportDays: 30,
  stagingMaxDays: 90,
  stagingMinFreeBytes: 5 * 1_073_741_824,
  keptBytesRetentionDays: 90,
  archiveMaxEntries: 300,
  archiveMaxUncompressedBytes: 2 * 1024 ** 3,
  stagedMaxBytes: 5 * 1024 ** 3,
  assetHosts: [...DEFAULT_LK_ASSET_HOSTS],
};

export const DEFAULT_TOOLS_SETTINGS: ToolsSettings = {
  upload: { maxBytes: 10 * 1024 * 1024, allowUrlSource: true, fetchTimeoutMs: 15_000, putTimeoutMs: 120_000 },
  resultMaxChars: 40_000,
  outboundExtraPorts: new Set<string>(),
  images: DEFAULT_IMAGE_SETTINGS,
  snapshots: DEFAULT_SNAPSHOT_SETTINGS,
  artCache: DEFAULT_ART_CACHE_SETTINGS,
};

/** Parses and validates the tool-layer environment variables. Never echoes values, only names. */
export function loadToolsConfig(env: NodeJS.ProcessEnv = process.env): ToolsSettings {
  const parsed = TOOLS_ENV_SCHEMA.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const e = parsed.data;
  let outboundExtraPorts: OutboundPortAllowlist;
  try {
    outboundExtraPorts = parseOutboundPortAllowlist(e.OUTBOUND_EXTRA_PORTS_ALLOWLIST);
  } catch (err) {
    throw new ConfigError([(err as Error).message]);
  }
  return {
    upload: {
      maxBytes: e.UPLOAD_MAX_BYTES,
      allowUrlSource: e.UPLOAD_ALLOW_URL_SOURCE,
      fetchTimeoutMs: e.UPLOAD_FETCH_TIMEOUT_MS,
      putTimeoutMs: e.UPLOAD_PUT_TIMEOUT_MS,
    },
    resultMaxChars: e.MCP_RESULT_MAX_CHARS,
    outboundExtraPorts,
    images: {
      maxPixels: e.IMAGE_MAX_PIXELS,
      maxFrames: e.IMAGE_MAX_FRAMES,
      convertTimeoutMs: e.IMAGE_CONVERT_TIMEOUT_MS,
      convertConcurrency: e.IMAGE_CONVERT_CONCURRENCY,
      dataDir: e.IMAGE_DATA_DIR ?? null,
      ratePerPrincipalPerHour: e.IMAGE_UPLOAD_RATE_PER_PRINCIPAL,
      ratePerIpPerHour: e.IMAGE_UPLOAD_RATE_PER_IP,
      bodyTimeoutMs: e.IMAGE_UPLOAD_BODY_TIMEOUT_MS,
      idleTimeoutMs: e.IMAGE_UPLOAD_IDLE_TIMEOUT_MS,
      stagingReportDays: e.IMAGE_STAGING_REPORT_DAYS,
      stagingMaxDays: e.IMAGE_STAGING_MAX_DAYS,
      stagingMinFreeBytes: Math.round(e.IMAGE_STAGING_MIN_FREE_GB * GIB),
      keptBytesRetentionDays: e.ASSET_BYTES_RETENTION_DAYS,
      archiveMaxEntries: e.IMAGE_ARCHIVE_MAX_ENTRIES,
      archiveMaxUncompressedBytes: e.IMAGE_ARCHIVE_MAX_UNCOMPRESSED_BYTES,
      stagedMaxBytes: e.IMAGE_STAGED_MAX_BYTES,
      assetHosts: parseHosts(e.LK_ASSET_HOSTS),
    },
    snapshots: {
      dataDir: e.SNAPSHOT_DIR ?? null,
      minFreeBytes: Math.round(e.SNAPSHOT_MIN_FREE_GB * GIB),
      keepFullDays: e.SNAPSHOT_KEEP_FULL_DAYS,
      keepWeekly: e.SNAPSHOT_KEEP_WEEKLY,
      keepDays: e.SNAPSHOT_KEEP_DAYS,
      softDeleteDays: e.SNAPSHOT_SOFT_DELETE_DAYS,
    },
    artCache: { dir: e.ART_CACHE_DIR ?? null, maxBytes: e.ART_CACHE_MAX_MB * 1024 * 1024 },
  };
}

/** LK_ASSET_HOSTS: comma-separated exact host names (no scheme, port, path or wildcard). */
function parseHosts(raw: string): string[] {
  const hosts = raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '');
  for (const h of hosts) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) {
      throw new ConfigError([
        `LK_ASSET_HOSTS: "${h}" is not a host name (no scheme, port, path or wildcard)`,
      ]);
    }
  }
  if (hosts.length === 0) throw new ConfigError(['LK_ASSET_HOSTS: at least one host is needed']);
  return hosts;
}

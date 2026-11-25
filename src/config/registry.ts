/**
 * The settings registry (v3 F8, ADR 0073): one entry per configuration key the bridge reads, so every setting is
 * reachable from the dashboard's Settings page and stays that way (test/unit/config-registry.test.ts fails a build that
 * adds a variable without an entry, or an entry without a variable).
 *
 * Each entry's type, default and range are read from the zod schema that parses the variable (`MAIN_ENV_SCHEMA`,
 * `TOOLS_ENV_SCHEMA`, ...), so the bounds have one source. What the registry adds is what a schema cannot say: the
 * group and wording on the page, the display unit, when a change applies, and whether the value is secret or may only
 * be changed on the server.
 *
 * - `applies: 'now'`: read on each use (`./live.ts`), so a dashboard change applies at once.
 * - `applies: 'next_start'`: built into a component when the bridge starts; the page shows the stored value as pending
 *   until the next restart.
 * - `applies: 'bootstrap'`: could stop the bridge starting, or is constrained by systemd, the filesystem or the
 *   reverse proxy, or is read before the database opens: shown read-only ("Change on the server: the env file, via
 *   env-sync"), never stored by the dashboard. Every one says why in `bootstrapReason` (and in ADR 0073).
 * - `secret: true`: keys, tokens, signing keys, password and TOTP material. The page shows the name and whether it is
 *   set, never the value; no route returns one.
 *
 * Every new setting goes here (CLAUDE.md).
 */
import type * as z from 'zod';
import { ADMIN_ENV_SCHEMA } from './admin.js';
import { AUTH_ENV_SCHEMA } from './auth.js';
import { DYNAMIC_ENV_KEYS, MAIN_ENV_SCHEMA, PROJECT_KEY_VARIABLE_PATTERN } from './index.js';
import { MAINTENANCE_ENV_SCHEMA } from './maintenance.js';
import { POLICY_ENV_SCHEMA } from './policy.js';
import { TOOLS_ENV_SCHEMA } from './tools.js';
import { UNITS, type UnitSpec } from './units.js';
import { PROJECT_SETTING_KEYS, projectSettingsSchema } from '../projects/settings.js';

// ------------------------------------------------------------------------------------------------------ types

export const SETTING_GROUPS = [
  { id: 'general', label: 'General' },
  { id: 'images', label: 'Images and uploads' },
  { id: 'art', label: 'Art' },
  { id: 'jobs', label: 'Jobs and engine' },
  { id: 'governor', label: 'Governor and budgets' },
  { id: 'proposals', label: 'Proposals and policy' },
  { id: 'automation', label: 'Audits and automation' },
  { id: 'snapshots', label: 'Snapshots, backups and the journal' },
  { id: 'mcp', label: 'MCP and tools' },
  { id: 'dashboard', label: 'Dashboard and auth' },
  { id: 'projects', label: 'Per-project settings' },
  { id: 'server', label: 'Server (bootstrap)' },
  { id: 'secrets', label: 'Secrets' },
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number]['id'];

/** The schema a key is parsed by (`dynamic`: read by `projectsFrom`; `dashboard`: stored only; `project`: per project). */
export type SchemaName =
  'main' | 'tools' | 'auth' | 'admin' | 'maintenance' | 'policy' | 'dynamic' | 'dashboard' | 'project';

export const SCHEMAS = {
  main: MAIN_ENV_SCHEMA,
  tools: TOOLS_ENV_SCHEMA,
  auth: AUTH_ENV_SCHEMA,
  admin: ADMIN_ENV_SCHEMA,
  maintenance: MAINTENANCE_ENV_SCHEMA,
  policy: POLICY_ENV_SCHEMA,
} as const;
export type EnvSchemaName = keyof typeof SCHEMAS;

export type SettingType = 'integer' | 'number' | 'boolean' | 'enum' | 'string' | 'url' | 'list' | 'json';
export type Applies = 'now' | 'next_start' | 'bootstrap';
export type EditedOn = 'settings' | 'projects' | 'server';

/**
 * The settings that existed before v3 F8, kept with their own stored keys and behaviour (ADR 0073 decision 4). The
 * Settings page edits them through the actions they always had.
 */
export type LegacyId =
  | 'readOnly'
  | 'writersMax'
  | 'reserveFloors'
  | 'exposePerOpTools'
  | 'allowMemberAdmin'
  | 'journal'
  | 'tierLimits'
  | 'contactEmail';

export interface ManagedAt {
  readonly label: string;
  /** A dashboard path (`/ui/...`) or a document in the repository. */
  readonly href: string;
}

export interface SettingEntry {
  readonly key: string;
  /** `env`: an environment variable; `dashboard`: stored by the dashboard only; `project`: one value per project. */
  readonly scope: 'env' | 'dashboard' | 'project';
  readonly schema: SchemaName;
  /** The schemas that read it (a variable can be read by two loaders, such as BRIDGE_PUBLIC_URL). */
  readonly schemas: readonly EnvSchemaName[];
  readonly group: SettingGroup;
  readonly label: string;
  readonly description: string;
  readonly type: SettingType;
  readonly unit: UnitSpec | null;
  /** In the base unit; null when the variable has no default (unset means "none" or "derived"). */
  readonly default: number | boolean | string | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly enum: readonly string[] | null;
  /** A number that must be whole. */
  readonly integer: boolean;
  readonly applies: Applies;
  readonly secret: boolean;
  readonly editedOn: EditedOn;
  readonly bootstrapReason: string | null;
  readonly managedAt: ManagedAt | null;
  readonly legacy: LegacyId | null;
  /** The `runtime_settings` key a dashboard value lives under. */
  readonly storedAs: string | null;
  /** The per-project setting that overrides this bridge-wide value (S6). */
  readonly projectSetting: string | null;
  /** For a key that stands for many variables (`LK_PROJECT_<NAME>_API_KEY`). */
  readonly pattern: RegExp | null;
}

/** The `runtime_settings` prefix of dashboard values for registry keys (ADR 0073 decision 2). */
export const CFG_PREFIX = 'dash.cfg.';

const LEGACY_STORED: Record<LegacyId, string> = {
  readOnly: 'jobs.read_only_override',
  writersMax: 'jobs.writers_max',
  reserveFloors: 'dash.reserve_floors',
  exposePerOpTools: 'dash.expose_per_op_tools',
  allowMemberAdmin: 'dash.allow_member_admin',
  journal: 'dash.journal_retention',
  tierLimits: 'dash.tier_limits',
  contactEmail: 'dash.contact_email',
};

// ------------------------------------------------------------------------------------------- introspection

interface Described {
  readonly type: SettingType;
  readonly default: number | boolean | string | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly enum: readonly string[] | null;
  readonly integer: boolean;
}

type AnyDef = { type: string; [k: string]: unknown };
const defOf = (s: unknown): AnyDef => (s as { def: AnyDef }).def;

/** Reads a field's type, default and range from its zod schema (the helpers in ./schema-helpers.ts). */
export function describeField(field: z.ZodType): Described {
  let s: unknown = field;
  let dflt: unknown = undefined;
  for (let i = 0; i < 10; i++) {
    const d = defOf(s);
    if (d.type === 'default') {
      dflt = typeof d.defaultValue === 'function' ? (d.defaultValue as () => unknown)() : d.defaultValue;
      s = d.innerType;
    } else if (d.type === 'optional' || d.type === 'nullable') {
      s = d.innerType;
    } else break;
  }
  const d = defOf(s);
  const plain = (v: unknown) =>
    typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? v : null;
  if (d.type === 'number') {
    const n = s as { minValue: number | null; maxValue: number | null; isInt: boolean };
    const bound = (v: number | null) =>
      v === null || !Number.isFinite(v) || Math.abs(v) >= Number.MAX_SAFE_INTEGER ? null : v;
    return {
      type: n.isInt ? 'integer' : 'number',
      default: plain(dflt),
      min: bound(n.minValue),
      max: bound(n.maxValue),
      enum: null,
      integer: n.isInt,
    };
  }
  if (d.type === 'pipe' && defOf(d.out).type === 'boolean') {
    return { type: 'boolean', default: plain(dflt), min: null, max: null, enum: null, integer: false };
  }
  if (d.type === 'enum') {
    return {
      type: 'enum',
      default: plain(dflt),
      min: null,
      max: null,
      enum: (s as { options: string[] }).options,
      integer: false,
    };
  }
  if (d.type === 'string' && d.format === 'url') {
    return { type: 'url', default: plain(dflt), min: null, max: null, enum: null, integer: false };
  }
  return { type: 'string', default: plain(dflt), min: null, max: null, enum: null, integer: false };
}

/** The zod field that parses `key` in `schema`, or undefined. */
export function schemaField(schema: EnvSchemaName, key: string): z.ZodType | undefined {
  return (SCHEMAS[schema].shape as Record<string, z.ZodType>)[key];
}

// --------------------------------------------------------------------------------------------------- specs

interface Spec {
  readonly key: string;
  readonly schema: SchemaName;
  readonly group: SettingGroup;
  readonly label: string;
  readonly description: string;
  readonly unit?: UnitSpec;
  readonly applies: Applies;
  readonly type?: SettingType;
  /** For a variable whose default lives in a transform the schema cannot show (checked against the schema by test). */
  readonly default?: number | boolean | string;
  readonly secret?: true;
  readonly editedOn?: EditedOn;
  readonly bootstrapReason?: string;
  readonly managedAt?: ManagedAt;
  readonly legacy?: LegacyId;
  readonly projectSetting?: string;
}

const ENV_SYNC: ManagedAt = { label: 'the env file, via env-sync', href: 'docs/runbook-deploy.md' };
const PROJECTS_PAGE: ManagedAt = { label: 'the Projects page', href: '/ui/projects' };
const ACCOUNT_PAGE: ManagedAt = { label: 'the Account page', href: '/ui/account' };

const B = (reason: string) => ({
  applies: 'bootstrap' as const,
  editedOn: 'server' as const,
  bootstrapReason: reason,
});
const DIR_REASON =
  'A directory: systemd lets the service write only under /var/lib/lk-bridge (ProtectSystem=strict, ReadWritePaths), and a path it cannot write stops the feature, or the start.';
const ALLOWLIST_REASON =
  'An allow-list of where the bridge may connect: kept with the server, so a dashboard session alone can never widen it.';

const SPECS: readonly Spec[] = [
  // ---------------------------------------------------------------- General
  {
    key: 'LOG_LEVEL',
    schema: 'main',
    group: 'general',
    label: 'Log level',
    description:
      'How much the bridge writes to its log (journald). `info` for normal use; `debug` while chasing a problem.',
    applies: 'next_start',
  },
  {
    key: 'CONTACT_EMAIL',
    schema: 'dashboard',
    group: 'general',
    label: 'Contact email',
    description:
      'Shown on the public privacy page (/privacy) as a contact line. There is no default: left empty, the page has no contact line.',
    applies: 'now',
    type: 'string',
    legacy: 'contactEmail',
  },

  // ---------------------------------------------------------------- Images and uploads
  {
    key: 'UPLOAD_MAX_BYTES',
    schema: 'tools',
    group: 'images',
    label: 'Largest image upload',
    description:
      'The largest image the bridge accepts (decoded bytes), from base64, a URL or the binary endpoint. Built into the request size limits of /mcp and the Staging upload when the bridge starts.',
    unit: UNITS.bytesAsMb,
    applies: 'next_start',
  },
  {
    key: 'UPLOAD_ALLOW_URL_SOURCE',
    schema: 'tools',
    group: 'images',
    label: 'Allow image URLs',
    description:
      'Whether the upload tools may fetch a public https image URL. Off: base64 and the binary endpoint only. The tool descriptions say which, so it applies at the next start.',
    applies: 'next_start',
  },
  {
    key: 'UPLOAD_FETCH_TIMEOUT_MS',
    schema: 'tools',
    group: 'images',
    label: 'Image URL fetch deadline',
    description:
      'How long fetching an image from a URL may take (DNS, connection, TLS and the body together).',
    unit: UNITS.msAsSeconds,
    applies: 'now',
  },
  {
    key: 'UPLOAD_PUT_TIMEOUT_MS',
    schema: 'tools',
    group: 'images',
    label: 'Signed upload deadline',
    description:
      'The deadline of each attempt of the signed-URL PUT (the image upload to LegendKeeper’s storage). A large image on a slow link needs longer than the 30-second LegendKeeper request timeout.',
    unit: UNITS.msAsSeconds,
    applies: 'now',
  },
  {
    key: 'IMAGE_MAX_PIXELS',
    schema: 'tools',
    group: 'images',
    label: 'Most pixels in an image',
    description:
      'The most pixels an image may have, every frame of an animation together; a file declaring more is refused before anything is decoded.',
    unit: UNITS.pixels,
    applies: 'now',
  },
  {
    key: 'IMAGE_MAX_FRAMES',
    schema: 'tools',
    group: 'images',
    label: 'Most frames in an animation',
    description: 'The most frames an animated image may have.',
    unit: UNITS.frames,
    applies: 'now',
  },
  {
    key: 'IMAGE_CONVERT_TIMEOUT_MS',
    schema: 'tools',
    group: 'images',
    label: 'Image conversion time limit',
    description: 'How long one image conversion may take before it is stopped.',
    unit: UNITS.msAsSeconds,
    applies: 'now',
  },
  {
    key: 'IMAGE_CONVERT_CONCURRENCY',
    schema: 'tools',
    group: 'images',
    label: 'Conversions at once',
    description:
      'Image conversions that may run at the same time. Each holds a decoded image in memory (about 0.5 GB at the pixel limit), so raise it only with memory to spare.',
    unit: UNITS.count,
    applies: 'next_start',
  },
  {
    key: 'IMAGE_UPLOAD_RATE_PER_PRINCIPAL',
    schema: 'tools',
    group: 'images',
    label: 'Uploads per connection per hour (runaway brake)',
    description:
      'A runaway brake only: images staged by one connection per hour, and likewise accepted binary uploads and prepare_image_upload calls. An archive entry past it waits (held) and is staged when the hour moves on; a single upload past it is refused. The real limit is the staging capacity.',
    unit: UNITS.count,
    applies: 'next_start',
  },
  {
    key: 'IMAGE_UPLOAD_RATE_PER_IP',
    schema: 'tools',
    group: 'images',
    label: 'Refused upload requests per address per hour',
    description:
      'Requests to the binary upload endpoint per client address per hour that fail authentication or are refused before it. Authenticated requests are not counted.',
    unit: UNITS.count,
    applies: 'next_start',
  },
  {
    key: 'IMAGE_UPLOAD_BODY_TIMEOUT_MS',
    schema: 'tools',
    group: 'images',
    label: 'Upload body deadline',
    description: 'How long the binary endpoint waits for a whole upload body.',
    unit: UNITS.msAsSeconds,
    applies: 'now',
  },
  {
    key: 'IMAGE_UPLOAD_IDLE_TIMEOUT_MS',
    schema: 'tools',
    group: 'images',
    label: 'Upload silence limit',
    description: 'The longest silence allowed within an upload body (a guard against slow-loris uploads).',
    unit: UNITS.msAsSeconds,
    applies: 'now',
  },
  {
    key: 'IMAGE_STAGING_REPORT_DAYS',
    schema: 'tools',
    group: 'images',
    label: 'Staged images reported as old after',
    description:
      'Staged images older than this are reported on the dashboard (never removed for that alone).',
    unit: UNITS.days,
    applies: 'now',
  },
  {
    key: 'IMAGE_STAGING_MAX_DAYS',
    schema: 'tools',
    group: 'images',
    label: 'Unplaced staged images kept for',
    description:
      'An unplaced image staged on the server is removed after this many days, a week after the dashboard first warned. Each project can set its own on the Projects page (imageStagingMaxDays).',
    unit: UNITS.days,
    applies: 'now',
    projectSetting: 'imageStagingMaxDays',
  },
  {
    key: 'IMAGE_STAGING_MIN_FREE_GB',
    schema: 'tools',
    group: 'images',
    label: 'Free disk kept by the image store',
    description: 'A new staging upload is refused when less than this much disk would be left free.',
    unit: UNITS.gigabytes,
    applies: 'now',
  },
  {
    key: 'IMAGE_STAGED_MAX_BYTES',
    schema: 'tools',
    group: 'images',
    label: 'Staging capacity',
    description:
      'The total size of the images staged on the bridge’s server. An archive entry that would pass it waits (held) until space frees; a single upload that would pass it is refused.',
    unit: UNITS.bytesAsMb,
    applies: 'now',
  },
  {
    key: 'IMAGE_ARCHIVE_MAX_ENTRIES',
    schema: 'tools',
    group: 'images',
    label: 'Entries per image archive',
    description:
      'The most entries an image archive (a zip) may hold, folders and skipped files included. A larger archive is refused whole.',
    unit: UNITS.count,
    applies: 'now',
  },
  {
    key: 'IMAGE_ARCHIVE_MAX_UNCOMPRESSED_BYTES',
    schema: 'tools',
    group: 'images',
    label: 'Image archive size',
    description:
      'The most an image archive may unpack to, every entry together; also the largest archive file accepted. A larger archive is refused whole.',
    unit: UNITS.bytesAsMb,
    applies: 'now',
  },
  {
    key: 'ASSET_BYTES_RETENTION_DAYS',
    schema: 'tools',
    group: 'images',
    label: 'Bytes kept after an asset delete',
    description:
      'How long the bytes kept before an asset is deleted are kept (so the image can be restored).',
    unit: UNITS.days,
    applies: 'now',
  },

  // ---------------------------------------------------------------- Art
  {
    key: 'ART_CACHE_MAX_MB',
    schema: 'tools',
    group: 'art',
    label: 'Art cache size',
    description:
      'The most the art cache (the resized images arkona_get_art delivers) holds; the least recently used go first.',
    unit: UNITS.megabytes,
    applies: 'next_start',
  },
  {
    key: 'ART_CALL_MAX_IMAGES',
    schema: 'tools',
    group: 'art',
    label: 'Images per art call',
    description:
      'The most images one arkona_add_character_art call with groups may carry, every group together (a character’s whole art set). A larger call is refused before anything is planned.',
    unit: UNITS.count,
    applies: 'now',
  },
  {
    key: 'ART_CALL_MAX_GROUPS',
    schema: 'tools',
    group: 'art',
    label: 'Groups per art call',
    description:
      'The most groups (the design pieces and each outfit) one arkona_add_character_art call may carry. A larger call is refused before anything is planned.',
    unit: UNITS.count,
    applies: 'now',
  },

  // ---------------------------------------------------------------- Jobs and engine
  {
    key: 'LK_READ_ONLY',
    schema: 'main',
    group: 'jobs',
    label: 'Read-only mode',
    description:
      'While on, every write is refused and queued writes are held. Switching it on is one click (a brake); switching it off asks for your password again. Each project can also be made read-only on the Projects page.',
    applies: 'now',
    legacy: 'readOnly',
  },
  {
    key: 'WRITERS_MAX',
    schema: 'main',
    group: 'jobs',
    label: 'Concurrent writers',
    description:
      'Writer slots: how many write steps may run at once. More than two or three adds contention, not throughput (the write tier is 120 a minute). Also on the Writers page.',
    unit: UNITS.count,
    applies: 'now',
    legacy: 'writersMax',
  },
  {
    key: 'REQUIRE_PROJECT_FOR_WRITES',
    schema: 'main',
    group: 'jobs',
    label: 'Writes must name their project',
    description:
      'A write tool called with no `project` is refused while more than one project is configured. Keep it on.',
    applies: 'next_start',
  },
  {
    key: 'LK_ALLOW_MEMBER_ADMIN',
    schema: 'main',
    group: 'jobs',
    label: 'Member administration',
    description:
      'Allows inviting and removing project members and revoking invites. Off, those operations are refused for every agent.',
    applies: 'next_start',
    legacy: 'allowMemberAdmin',
  },

  // ---------------------------------------------------------------- Governor and budgets
  {
    key: 'LK_TIER_LIMITS',
    schema: 'main',
    group: 'governor',
    label: 'Tier limit overrides',
    description:
      'Overrides of LegendKeeper’s published rate limits, as JSON (for example {"write-min":120}), if LegendKeeper changes one. The server’s own reports always win at run time.',
    applies: 'next_start',
    type: 'json',
    legacy: 'tierLimits',
  },
  {
    key: 'RESERVE_FLOOR_INTERACTIVE',
    schema: 'main',
    group: 'governor',
    label: 'Reserve floor: agents',
    description:
      'The share of each tier an agent’s direct call must leave untouched. The floors must rise: agents ≤ jobs ≤ maintenance ≤ bulk. Also on the Budgets page.',
    unit: UNITS.percent,
    applies: 'now',
    legacy: 'reserveFloors',
  },
  {
    key: 'RESERVE_FLOOR_JOB',
    schema: 'main',
    group: 'governor',
    label: 'Reserve floor: jobs',
    description:
      'The share of each tier a job step must leave untouched, so agents stay responsive while a big job runs.',
    unit: UNITS.percent,
    applies: 'now',
    legacy: 'reserveFloors',
  },
  {
    key: 'RESERVE_FLOOR_MAINTENANCE',
    schema: 'main',
    group: 'governor',
    label: 'Reserve floor: maintenance',
    description:
      'The share of each tier routine maintenance (P3) must leave untouched: change snapshots, refreshes after a bridge write, automation, block-id upkeep. The whole-repository passes have their own floor (bulk), so this one no longer needs raising to keep the night’s full snapshot in check.',
    unit: UNITS.percent,
    applies: 'now',
    legacy: 'reserveFloors',
  },
  {
    key: 'RESERVE_FLOOR_BULK',
    schema: 'main',
    group: 'governor',
    label: 'Reserve floor: bulk passes',
    description:
      'The share of each tier the whole-repository passes (P4) must leave untouched: the nightly full snapshot, the full repository tree and asset tree checks, the link sweep. At 70% they use at most 30% of each tier, give way to routine maintenance and to agents, and still finish. Must be at least the maintenance floor. Left unset, it is 70%, or the maintenance floor if that is higher. Also on the Budgets page.',
    unit: UNITS.percent,
    applies: 'now',
    legacy: 'reserveFloors',
  },
  {
    key: 'WRITE_SPACING_MS',
    schema: 'main',
    group: 'governor',
    label: 'Gap between writes',
    description: 'The least time between two write requests (LegendKeeper’s own guidance is 500 ms).',
    unit: UNITS.msAsSeconds,
    applies: 'next_start',
  },
  {
    key: 'WRITE_SPACING_STRETCHED_MS',
    schema: 'main',
    group: 'governor',
    label: 'Gap between writes when busy',
    description: 'The gap used once the projected hourly write count would cross the hourly write limit.',
    unit: UNITS.msAsSeconds,
    applies: 'next_start',
  },

  // ---------------------------------------------------------------- Proposals and policy
  {
    key: 'POLICY_PROPOSAL_EXPIRY_DAYS',
    schema: 'policy',
    group: 'proposals',
    label: 'Proposals expire after',
    description: 'A pending proposal nobody decided expires after this many days.',
    unit: UNITS.days,
    applies: 'next_start',
  },
  {
    key: 'POLICY_EXPIRY_SWEEP_SECONDS',
    schema: 'policy',
    group: 'proposals',
    label: 'Proposal expiry check',
    description: 'How often pending proposals are checked for expiry.',
    unit: UNITS.secondsAsMinutes,
    applies: 'next_start',
  },
  {
    key: 'POLICY_PROPOSAL_RETENTION_DAYS',
    schema: 'policy',
    group: 'proposals',
    label: 'Finished proposals kept for',
    description:
      'Finished proposals (executed, rejected, expired or failed) older than this are deleted by proposal-prune.',
    unit: UNITS.days,
    applies: 'next_start',
  },

  // ---------------------------------------------------------------- Audits and automation
  {
    key: 'MAINTENANCE_ENABLED',
    schema: 'maintenance',
    group: 'automation',
    label: 'Scheduled maintenance',
    description: 'Off: no maintenance job, audit or automation runs by itself (Run now still works).',
    applies: 'next_start',
  },
  {
    key: 'MAINTENANCE_DEFER_SECONDS',
    schema: 'maintenance',
    group: 'automation',
    label: 'Maintenance gives way for',
    description:
      'A maintenance job that calls LegendKeeper looks again this soon when agents’ or jobs’ work is queued.',
    unit: UNITS.seconds,
    applies: 'next_start',
  },
  {
    key: 'MAINTENANCE_HISTORY_RUNS',
    schema: 'maintenance',
    group: 'automation',
    label: 'Run records kept per job',
    description: 'How many run records each maintenance job keeps (the last run is always kept).',
    unit: UNITS.count,
    applies: 'next_start',
  },

  // ---------------------------------------------------------------- Snapshots, backups and the journal
  {
    key: 'SNAPSHOT_MIN_FREE_GB',
    schema: 'tools',
    group: 'snapshots',
    label: 'Free disk a snapshot leaves',
    description: 'A full snapshot is refused rather than leave less than this much free disk.',
    unit: UNITS.gigabytes,
    applies: 'now',
  },
  {
    key: 'SNAPSHOT_KEEP_FULL_DAYS',
    schema: 'tools',
    group: 'snapshots',
    label: 'Every full snapshot kept for',
    description: 'Days every full (nightly) snapshot is kept.',
    unit: UNITS.days,
    applies: 'now',
  },
  {
    key: 'SNAPSHOT_KEEP_WEEKLY',
    schema: 'tools',
    group: 'snapshots',
    label: 'Weekly snapshots kept for',
    description:
      'After those days, one full snapshot a week (the latest of each ISO week) is kept for this many weeks.',
    unit: UNITS.weeks,
    applies: 'now',
  },
  {
    key: 'SNAPSHOT_KEEP_DAYS',
    schema: 'tools',
    group: 'snapshots',
    label: 'Change snapshots kept for',
    description: 'Days change snapshots (taken after jobs) are kept.',
    unit: UNITS.days,
    applies: 'now',
  },
  {
    key: 'SNAPSHOT_SOFT_DELETE_DAYS',
    schema: 'tools',
    group: 'snapshots',
    label: 'LegendKeeper keeps deleted pages for',
    description:
      'How long LegendKeeper is taken to keep a deleted page restorable: a restore of a page deleted more recently undeletes it; an older one is recreated from the snapshot. LegendKeeper does not publish it.',
    unit: UNITS.days,
    applies: 'now',
  },
  {
    key: 'JOURNAL_RETENTION_DAYS',
    schema: 'main',
    group: 'snapshots',
    label: 'Journal kept for',
    description:
      'How long the write journal (the undo information) is kept, or until its size cap, whichever comes first.',
    unit: UNITS.days,
    applies: 'next_start',
    legacy: 'journal',
  },
  {
    key: 'JOURNAL_MAX_BYTES',
    schema: 'main',
    group: 'snapshots',
    label: 'Journal size cap',
    description: 'The most the write journal may hold. Shorter retention deletes older undo information.',
    unit: UNITS.bytesAsGb,
    applies: 'next_start',
    legacy: 'journal',
  },

  // ---------------------------------------------------------------- MCP and tools
  {
    key: 'MCP_EXPOSE_PER_OP_TOOLS',
    schema: 'main',
    group: 'mcp',
    label: 'Per-operation tools',
    description:
      'Also expose one MCP tool per LegendKeeper operation (89 more). Off keeps the tool list short for claude.ai.',
    applies: 'next_start',
    legacy: 'exposePerOpTools',
  },
  {
    key: 'MCP_RESULT_MAX_CHARS',
    schema: 'tools',
    group: 'mcp',
    label: 'Largest inline tool result',
    description:
      'A tool result longer than this is stored as a job artefact and returned as a handle to page through.',
    unit: UNITS.characters,
    applies: 'now',
  },

  {
    key: 'REFTYPE_BULK_MAX',
    schema: 'tools',
    group: 'automation',
    label: 'Reference Types: most rows one “Accept all” decides',
    description:
      'The Reference Types page’s “Accept all confident suggestions” decides at most this many rows in one request and one transaction; the page asks again for the rest.',
    unit: UNITS.count,
    applies: 'now',
  },
  {
    key: 'CHRONOLOGY_CHECK_DELAY_MS',
    schema: 'tools',
    group: 'automation',
    label: 'Chronology check after an edit',
    description:
      'How long after the last change to a chronology document (the Main table, an age table or an age timeline) the project’s chronology check runs. A burst of edits gives one check; the automation’s chronology codes then act on its findings.',
    unit: UNITS.msAsMinutes,
    applies: 'now',
  },
  {
    key: 'SLOW_REQUEST_WARN_MS',
    schema: 'tools',
    group: 'general',
    label: 'Slow request warning',
    description:
      'A dashboard request or MCP tool call still running after this long is logged as a warning (method, URL and tool name; never the body), so a hang names itself.',
    unit: UNITS.msAsSeconds,
    applies: 'now',
  },
  {
    key: 'SLOW_REQUEST_REPEAT_MS',
    schema: 'tools',
    group: 'general',
    label: 'Slow request warning: repeat every',
    description: 'While a slow request keeps running, its warning is logged again this often.',
    unit: UNITS.msAsSeconds,
    applies: 'now',
  },
  {
    key: 'EVENT_LOOP_LAG_WARN_MS',
    schema: 'tools',
    group: 'general',
    label: 'Event-loop lag warning',
    description:
      'When the bridge’s event loop is blocked for longer than this, a warning is logged with the task or request running, the heap and the RSS.',
    unit: UNITS.msAsSeconds,
    applies: 'now',
  },
  {
    key: 'MEMORY_WARN_FRACTION',
    schema: 'tools',
    group: 'general',
    label: 'Memory pressure warning',
    description:
      'RSS above this share of the service’s soft memory cap (MemoryHigh, read from /sys/fs/cgroup/memory.high) is logged as a warning naming the running tasks. A report only: nothing is stopped.',
    unit: UNITS.percent,
    applies: 'now',
  },

  // ---------------------------------------------------------------- Dashboard and auth
  {
    key: 'AUTH_ACCESS_TOKEN_TTL_SECONDS',
    schema: 'auth',
    group: 'dashboard',
    label: 'Access token lifetime',
    description: 'How long an access token issued to a connector lasts before it is refreshed.',
    unit: UNITS.secondsAsMinutes,
    applies: 'next_start',
  },
  {
    key: 'AUTH_REFRESH_TOKEN_TTL_SECONDS',
    schema: 'auth',
    group: 'dashboard',
    label: 'Refresh token lifetime',
    description: 'How long a refresh token lasts; renewed on every refresh.',
    unit: UNITS.secondsAsDays,
    applies: 'next_start',
  },
  {
    key: 'AUTH_REFRESH_FAMILY_MAX_SECONDS',
    schema: 'auth',
    group: 'dashboard',
    label: 'Sign-in lasts at most',
    description:
      'The longest a connector’s sign-in lasts, however often it refreshes; then it signs in again. At least the refresh token lifetime.',
    unit: UNITS.secondsAsDays,
    applies: 'next_start',
  },
  {
    key: 'AUTH_CODE_TTL_SECONDS',
    schema: 'auth',
    group: 'dashboard',
    label: 'Authorisation code lifetime',
    description: 'How long an OAuth authorisation code may be exchanged for a token.',
    unit: UNITS.seconds,
    applies: 'next_start',
  },
  {
    key: 'AUTH_SESSION_TTL_SECONDS',
    schema: 'auth',
    group: 'dashboard',
    label: 'Dashboard session lifetime',
    description: 'The dashboard session lasts this long from its last use (a sliding session).',
    unit: UNITS.secondsAsDays,
    applies: 'next_start',
  },
  {
    key: 'AUTH_REFRESH_GRACE_SECONDS',
    schema: 'auth',
    group: 'dashboard',
    label: 'Refresh grace window',
    description:
      'How long a just-rotated refresh token may be presented again for the same successor. 0 switches it off.',
    unit: UNITS.seconds,
    applies: 'next_start',
  },
  {
    key: 'AUTH_CIMD_TIMEOUT_MS',
    schema: 'auth',
    group: 'dashboard',
    label: 'Client document fetch deadline',
    description: 'How long fetching a client’s identity document (CIMD) may take.',
    unit: UNITS.msAsSeconds,
    applies: 'next_start',
  },
  {
    key: 'AUTH_CIMD_MAX_BYTES',
    schema: 'auth',
    group: 'dashboard',
    label: 'Largest client document',
    description: 'The largest client identity document (CIMD) the bridge reads.',
    unit: UNITS.bytesAsKb,
    applies: 'next_start',
  },
  {
    key: 'ADMIN_STREAM_HEARTBEAT_SECONDS',
    schema: 'admin',
    group: 'dashboard',
    label: 'Live stream heartbeat',
    description:
      'A comment line is sent on every live stream this often, so proxies keep the connection open.',
    unit: UNITS.seconds,
    applies: 'next_start',
  },
  {
    key: 'ADMIN_STREAM_REPLAY_EVENTS',
    schema: 'admin',
    group: 'dashboard',
    label: 'Live events kept for reconnection',
    description:
      'Recent live events kept so a reconnecting dashboard catches up; older than this, it reloads.',
    unit: UNITS.count,
    applies: 'next_start',
  },
  {
    key: 'ADMIN_BUDGET_PUSH_SECONDS',
    schema: 'admin',
    group: 'dashboard',
    label: 'Budget updates every',
    description: 'How often a budget snapshot is pushed to open dashboards.',
    unit: UNITS.seconds,
    applies: 'next_start',
  },

  // ---------------------------------------------------------------- Server (bootstrap)
  {
    key: 'NODE_ENV',
    schema: 'main',
    group: 'server',
    label: 'Run mode',
    description: 'production on the server.',
    ...B(
      'The deployment mode the env file sets for the service; tests and production take different paths on it.',
    ),
  },
  {
    key: 'HOST',
    schema: 'main',
    group: 'server',
    label: 'Listen address',
    description: 'The address the bridge listens on: the loopback address, so Caddy is the only way in.',
    ...B(
      'Caddy reaches the bridge at this address; a wrong one cuts the dashboard off, so it could not be put back from there.',
    ),
  },
  {
    key: 'PORT',
    schema: 'main',
    group: 'server',
    label: 'Listen port',
    description: 'The port the bridge listens on (Caddy forwards to it).',
    unit: UNITS.count,
    ...B(
      'The reverse proxy (deploy/Caddyfile.lk-bridge) forwards to this port; a different one, or one in use, stops the bridge being reached or starting.',
    ),
  },
  {
    key: 'BRIDGE_PUBLIC_URL',
    schema: 'main',
    group: 'server',
    label: 'Public address',
    description: 'The public address clients use: the OAuth issuer and the audience of every token.',
    ...B(
      'The OAuth issuer and every token’s audience, and the address Caddy serves: changing it signs every client out and needs the proxy and DNS changed with it.',
    ),
  },
  {
    key: 'DB_PATH',
    schema: 'main',
    group: 'server',
    label: 'Database file',
    description: 'The SQLite database, inside /var/lib/lk-bridge.',
    ...B(
      'Read before the database opens (dashboard values live in it), and systemd lets the service write only under /var/lib/lk-bridge.',
    ),
  },
  {
    key: 'LK_BASE_URL',
    schema: 'main',
    group: 'server',
    label: 'LegendKeeper address',
    description: 'Where LegendKeeper’s API is (only changed to point at a mock in tests).',
    ...B(
      'Every project’s API key is sent here: an outbound target, kept with the server so a dashboard session can never redirect the keys.',
    ),
  },
  {
    key: 'IMAGE_DATA_DIR',
    schema: 'tools',
    group: 'server',
    label: 'Image directory',
    description: 'The bridge’s private image directory. Unset: images/ next to the database.',
    ...B(DIR_REASON),
  },
  {
    key: 'ART_CACHE_DIR',
    schema: 'tools',
    group: 'server',
    label: 'Art cache directory',
    description: 'Where arkona_get_art keeps its resized images. Unset: art-cache/ next to the database.',
    ...B(DIR_REASON),
  },
  {
    key: 'SNAPSHOT_DIR',
    schema: 'tools',
    group: 'server',
    label: 'Snapshot directory',
    description: 'The snapshot store (objects and manifests). Unset: snapshots/ next to the database.',
    ...B(DIR_REASON),
  },
  {
    key: 'LK_ASSET_HOSTS',
    schema: 'tools',
    group: 'server',
    label: 'Asset download hosts',
    description:
      'The hosts LegendKeeper serves asset files from; the bridge downloads only from these, and follows a redirect only to one of them.',
    type: 'list',
    ...B(ALLOWLIST_REASON),
  },
  {
    key: 'OUTBOUND_EXTRA_PORTS_ALLOWLIST',
    schema: 'tools',
    group: 'server',
    label: 'Extra outbound ports',
    description:
      'host:port pairs the image fetch, the upload PUT and the client document fetch may use besides 443.',
    type: 'list',
    ...B(ALLOWLIST_REASON),
  },
  {
    key: 'TRUST_PROXY',
    schema: 'auth',
    group: 'server',
    label: 'Trusted proxies',
    description: 'Whose X-Forwarded-For to believe: loopback while Caddy runs on this server.',
    type: 'list',
    ...B(
      'Depends on how the reverse proxy is set up on the server; a wrong value lets any client forge its address (rate limits, logs) or blames every request on the proxy.',
    ),
  },
  {
    key: 'AUTH_MCP_ALLOWED_ORIGINS',
    schema: 'auth',
    group: 'server',
    label: 'Browser origins allowed at /mcp',
    description: 'Browser origins that may call /mcp, besides the public address and loopback.',
    type: 'list',
    default: 'https://claude.ai,https://claude.com,https://chatgpt.com',
    ...B(
      'An allow-list of which websites may call the MCP endpoint from a browser: kept with the server, like the other allow-lists.',
    ),
  },
  {
    key: 'OAUTH_EXTRA_REDIRECT_URIS',
    schema: 'auth',
    group: 'server',
    label: 'Extra OAuth redirect addresses',
    description: 'Exact extra redirect URIs, comma-separated (for example a new ChatGPT callback).',
    type: 'list',
    ...B(
      'An allow-list of where sign-in codes may be sent: kept with the server, so a dashboard session alone can never add a destination.',
    ),
  },
  {
    key: 'OWNER_USERNAME',
    schema: 'auth',
    group: 'server',
    label: 'Owner username',
    description: 'The name you sign in to the dashboard with.',
    ...B(
      'The sign-in name, read by the sign-in service at start: a mistake would lock you out of the very page that could correct it.',
    ),
  },
  {
    key: 'LK_PROJECTS',
    schema: 'dynamic',
    group: 'server',
    label: 'Projects in the env file',
    description:
      'Project names whose keys are in the env file (LK_PROJECT_<NAME>_API_KEY). Projects are normally added on the Projects page.',
    type: 'list',
    managedAt: PROJECTS_PAGE,
    ...B(
      'Says which keys to read from the env file at start, before the dashboard exists; projects themselves are managed on the Projects page.',
    ),
  },
  {
    key: 'LK_DEFAULT_PROJECT',
    schema: 'dynamic',
    group: 'server',
    label: 'Default project override',
    description:
      'Overrides the default project stored on the Projects page ("Make default") while it is set.',
    managedAt: PROJECTS_PAGE,
    ...B(
      'An env-file override of what the Projects page stores; the Projects page is where the default is chosen.',
    ),
  },
  {
    key: 'LK_PROJECT_ID',
    schema: 'dynamic',
    group: 'server',
    label: 'Project id (single-project form)',
    description: 'The deprecated single-project form: the one project’s LegendKeeper id.',
    managedAt: PROJECTS_PAGE,
    ...B('Read by the database migrations before anything else, to assign old rows to their project.'),
  },
  {
    key: 'LK_PROJECT_NAME',
    schema: 'dynamic',
    group: 'server',
    label: 'Project name (single-project form)',
    description: 'The deprecated single-project form: the one project’s name (default test).',
    managedAt: PROJECTS_PAGE,
    ...B('Read by the database migrations before anything else, to assign old rows to their project.'),
  },

  // ---------------------------------------------------------------- Secrets
  {
    key: 'SESSION_SECRET',
    schema: 'main',
    group: 'secrets',
    label: 'Session secret',
    description: 'Signs dashboard sessions and CSRF tokens.',
    secret: true,
    managedAt: ENV_SYNC,
    ...B('Secret material, kept in the env file only.'),
  },
  {
    key: 'JWT_SIGNING_KEY',
    schema: 'main',
    group: 'secrets',
    label: 'Token signing key',
    description: 'Signs the access tokens connectors use.',
    secret: true,
    managedAt: ENV_SYNC,
    ...B('Secret material, kept in the env file only.'),
  },
  {
    key: 'OWNER_PASSWORD_HASH',
    schema: 'main',
    group: 'secrets',
    label: 'Owner password',
    description:
      'The owner’s password hash. Imported into the encrypted store at the first start; changed on the Account page.',
    secret: true,
    managedAt: ACCOUNT_PAGE,
    ...B('Secret material: changed on the Account page.'),
  },
  {
    key: 'OWNER_TOTP_SECRET',
    schema: 'auth',
    group: 'secrets',
    label: 'Authenticator secret',
    description:
      'The owner’s authenticator (TOTP) secret and recovery codes; enrolled and removed on the Account page.',
    secret: true,
    managedAt: ACCOUNT_PAGE,
    ...B('Secret material: managed on the Account page.'),
  },
  {
    key: 'SECRETS_MASTER_KEY',
    schema: 'main',
    group: 'secrets',
    label: 'Secret store master key',
    description:
      'Encrypts the secret store (project keys, owner credentials). env-sync generates it; never change it by hand.',
    secret: true,
    managedAt: ENV_SYNC,
    ...B('Secret material, generated and rotated by env-sync.'),
  },
  {
    key: 'SECRETS_MASTER_KEY_PREVIOUS',
    schema: 'main',
    group: 'secrets',
    label: 'Previous master key',
    description: 'Set only during a rotation (env-sync.sh --rotate-master-key).',
    secret: true,
    managedAt: ENV_SYNC,
    ...B('Secret material, set by env-sync during a rotation.'),
  },
  {
    key: 'LK_API_KEY',
    schema: 'dynamic',
    group: 'secrets',
    label: 'API key (single-project form)',
    description: 'The deprecated single-project form’s LegendKeeper API key.',
    secret: true,
    managedAt: PROJECTS_PAGE,
    ...B('Secret material: keys are managed on the Projects page.'),
  },
  {
    key: 'LK_PROJECT_<NAME>_API_KEY',
    schema: 'dynamic',
    group: 'secrets',
    label: 'Project API keys',
    description:
      'One per project listed in LK_PROJECTS. Imported into the encrypted store once; the stored key wins after that.',
    secret: true,
    managedAt: PROJECTS_PAGE,
    ...B('Secret material: keys are managed on the Projects page.'),
  },
];

// ---------------------------------------------------------------------------------------------- resolution

function schemasReading(key: string): EnvSchemaName[] {
  return (Object.keys(SCHEMAS) as EnvSchemaName[]).filter((n) => schemaField(n, key) !== undefined);
}

function resolve(spec: Spec): SettingEntry {
  const field = spec.schema in SCHEMAS ? schemaField(spec.schema as EnvSchemaName, spec.key) : undefined;
  if (spec.schema in SCHEMAS && !field) {
    throw new Error(`settings registry: ${spec.key} is not in the ${spec.schema} schema`);
  }
  const d: Described = field
    ? describeField(field)
    : { type: spec.type ?? 'string', default: null, min: null, max: null, enum: null, integer: false };
  const scope = spec.schema === 'dashboard' ? 'dashboard' : 'env';
  return {
    key: spec.key,
    scope,
    schema: spec.schema,
    schemas: scope === 'env' ? schemasReading(spec.key) : [],
    group: spec.group,
    label: spec.label,
    description: spec.description,
    type: spec.type ?? d.type,
    unit: spec.unit ?? null,
    default: spec.default ?? d.default,
    min: d.min,
    max: d.max,
    enum: d.enum,
    integer: d.integer,
    applies: spec.applies,
    secret: spec.secret === true,
    editedOn: spec.editedOn ?? 'settings',
    bootstrapReason: spec.bootstrapReason ?? null,
    managedAt: spec.managedAt ?? (spec.applies === 'bootstrap' ? ENV_SYNC : null),
    legacy: spec.legacy ?? null,
    storedAs: spec.legacy
      ? LEGACY_STORED[spec.legacy]
      : spec.applies === 'bootstrap'
        ? null
        : `${CFG_PREFIX}${spec.key}`,
    projectSetting: spec.projectSetting ?? null,
    pattern: spec.key === 'LK_PROJECT_<NAME>_API_KEY' ? PROJECT_KEY_VARIABLE_PATTERN : null,
  };
}

/** S6: the per-project settings, edited on the Projects page (one value per project). */
function projectEntries(): SettingEntry[] {
  const shape = projectSettingsSchema.shape as Record<string, z.ZodType>;
  return PROJECT_SETTING_KEYS.map((p) => {
    const field = shape[p.key];
    const d = field ? describeField(field) : null;
    const def = p.default ?? null;
    return {
      key: p.key,
      scope: 'project' as const,
      schema: 'project' as const,
      schemas: [],
      group: 'projects' as const,
      label: p.label,
      description: p.help ?? `${p.label} (${p.kind}).`,
      type:
        p.kind === 'on/off'
          ? 'boolean'
          : p.kind === 'days'
            ? 'integer'
            : p.kind === 'rules'
              ? 'json'
              : 'string',
      unit: p.kind === 'days' ? UNITS.days : null,
      default: def,
      min: d?.min ?? null,
      max: d?.max ?? null,
      enum: null,
      integer: p.kind === 'days',
      applies: 'now' as const,
      secret: false,
      editedOn: 'projects' as const,
      bootstrapReason: null,
      managedAt: PROJECTS_PAGE,
      legacy: null,
      storedAs: null,
      projectSetting: p.key,
      pattern: null,
    } satisfies SettingEntry;
  });
}

/** Every setting, in page order (by group, then as listed). */
export const CONFIG_REGISTRY: readonly SettingEntry[] = (() => {
  const all = [...SPECS.map(resolve), ...projectEntries()];
  const order = new Map<string, number>(SETTING_GROUPS.map((g, i) => [g.id, i]));
  return all
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (order.get(a.e.group) ?? 0) - (order.get(b.e.group) ?? 0) || a.i - b.i)
    .map((x) => x.e);
})();

const BY_KEY = new Map(CONFIG_REGISTRY.map((e) => [e.key, e]));

/** The entry for `key` (a project key variable matches `LK_PROJECT_<NAME>_API_KEY`). */
export function registryEntry(key: string): SettingEntry | undefined {
  return (
    BY_KEY.get(key) ??
    (PROJECT_KEY_VARIABLE_PATTERN.test(key) ? BY_KEY.get('LK_PROJECT_<NAME>_API_KEY') : undefined)
  );
}

/** The environment variables the registry knows (fixed names; the project key pattern is matched separately). */
export const REGISTRY_ENV_KEYS: readonly string[] = CONFIG_REGISTRY.filter((e) => e.scope === 'env').map(
  (e) => e.key,
);

/** Settings the dashboard may edit itself: on the Settings page, not bootstrap, not secret. */
export function editableHere(e: SettingEntry): boolean {
  return e.editedOn === 'settings' && e.applies !== 'bootstrap' && !e.secret;
}

/** Every secret variable's name that could hold a value in `env` (the pattern ones expanded). */
export function secretVariables(env: Readonly<Record<string, string | undefined>>): string[] {
  const fixed = CONFIG_REGISTRY.filter((e) => e.secret && e.pattern === null).map((e) => e.key);
  const dynamic = Object.keys(env).filter((k) => PROJECT_KEY_VARIABLE_PATTERN.test(k));
  return [...new Set([...fixed, ...dynamic])];
}

export { DYNAMIC_ENV_KEYS };

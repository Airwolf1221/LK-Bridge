import * as z from 'zod';
import { DEFAULT_LK_BASE_URL } from '../lk/constants.js';
import { TIER_IDS, type TierId } from '../lk/registry-types.js';

/** Published LK limits (PLAN §1.2). `null` = no published number, handled reactively only. */
export const DEFAULT_TIER_LIMITS: Readonly<Record<TierId, number | null>> = {
  'write-min': 120,
  'write-hour': 3000,
  'key-min': 300,
  'key-hour': 6000,
  'key-day': 60000,
  'project-hour': 12000,
  'items-min': 600,
  'items-hour': 6000,
  upload: null,
};

/** Window length per tier, in seconds. Upload has no known window. */
export const TIER_WINDOW_SECONDS: Readonly<Record<TierId, number | null>> = {
  'write-min': 60,
  'write-hour': 3600,
  'key-min': 60,
  'key-hour': 3600,
  'key-day': 86400,
  'project-hour': 3600,
  'items-min': 60,
  'items-hour': 3600,
  upload: null,
};

const bool = (def: boolean) => z.stringbool().default(def);
const intFrom = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);
const fraction = (def: number) => z.coerce.number().min(0).max(1).default(def);

const tierOverrides = z
  .string()
  .optional()
  .transform((raw, ctx): Partial<Record<TierId, number | null>> => {
    if (!raw) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'LK_TIER_LIMITS must be valid JSON' });
      return z.NEVER;
    }
    const result = z
      .partialRecord(z.enum(TIER_IDS), z.number().int().positive().nullable())
      .safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({ code: 'custom', message: `LK_TIER_LIMITS: ${result.error.message}` });
      return z.NEVER;
    }
    return result.data;
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Server
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: intFrom(8787, 1, 65535),
  BRIDGE_PUBLIC_URL: z.url(),
  DB_PATH: z.string().min(1).default('./data/bridge.db'),

  // LegendKeeper
  LK_API_KEY: z.string().min(1),
  LK_PROJECT_ID: z.string().min(1),
  LK_BASE_URL: z.url().default(DEFAULT_LK_BASE_URL),
  LK_READ_ONLY: bool(true), // fail closed; set false deliberately at go-live (PLAN §9.7)
  LK_ALLOW_MEMBER_ADMIN: bool(false),
  LK_TIER_LIMITS: tierOverrides,

  // Governor (PLAN §5.2)
  RESERVE_FLOOR_INTERACTIVE: fraction(0.1),
  RESERVE_FLOOR_JOB: fraction(0.25),
  RESERVE_FLOOR_MAINTENANCE: fraction(0.5),
  WRITE_SPACING_MS: intFrom(500, 0, 60000),
  WRITE_SPACING_STRETCHED_MS: intFrom(1200, 0, 60000),

  // Writers and jobs (PLAN §6)
  WRITERS_MAX: intFrom(2, 1, 8),

  // Journal retention (PLAN §6.4)
  JOURNAL_RETENTION_DAYS: intFrom(30, 1, 3650),
  JOURNAL_MAX_BYTES: intFrom(2 * 1024 ** 3, 1024 ** 2, Number.MAX_SAFE_INTEGER),

  // MCP
  MCP_EXPOSE_PER_OP_TOOLS: bool(false),

  // Auth (secrets; chunk 4 consumes them). Owner hash is set by `npm run setup:owner`.
  SESSION_SECRET: z.string().min(32),
  JWT_SIGNING_KEY: z.string().min(32),
  OWNER_PASSWORD_HASH: z.string().min(1).optional(),
});

export interface Config {
  readonly env: 'development' | 'test' | 'production';
  readonly logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  readonly server: {
    readonly host: string;
    readonly port: number;
    readonly publicUrl: string;
    readonly dbPath: string;
  };
  readonly lk: {
    readonly apiKey: string;
    readonly projectId: string;
    readonly baseUrl: string;
    readonly readOnly: boolean;
    readonly allowMemberAdmin: boolean;
    readonly tierLimits: Readonly<Record<TierId, number | null>>;
  };
  readonly governor: {
    readonly reserveFloors: {
      readonly interactive: number;
      readonly job: number;
      readonly maintenance: number;
    };
    readonly writeSpacingMs: number;
    readonly writeSpacingStretchedMs: number;
  };
  readonly writers: { readonly max: number };
  readonly journal: { readonly retentionDays: number; readonly maxBytes: number };
  readonly mcp: { readonly exposePerOpTools: boolean };
  readonly auth: {
    readonly sessionSecret: string;
    readonly jwtSigningKey: string;
    readonly ownerPasswordHash?: string;
  };
}

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n - ${issues.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

/** Parses and validates environment variables. Never logs or echoes values, only names. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const e = parsed.data;
  const { interactive, job, maintenance } = {
    interactive: e.RESERVE_FLOOR_INTERACTIVE,
    job: e.RESERVE_FLOOR_JOB,
    maintenance: e.RESERVE_FLOOR_MAINTENANCE,
  };
  if (!(interactive <= job && job <= maintenance)) {
    throw new ConfigError(['RESERVE_FLOOR_*: expected interactive <= job <= maintenance']);
  }
  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    server: { host: e.HOST, port: e.PORT, publicUrl: e.BRIDGE_PUBLIC_URL, dbPath: e.DB_PATH },
    lk: {
      apiKey: e.LK_API_KEY,
      projectId: e.LK_PROJECT_ID,
      baseUrl: e.LK_BASE_URL,
      readOnly: e.LK_READ_ONLY,
      allowMemberAdmin: e.LK_ALLOW_MEMBER_ADMIN,
      tierLimits: { ...DEFAULT_TIER_LIMITS, ...e.LK_TIER_LIMITS },
    },
    governor: {
      reserveFloors: { interactive, job, maintenance },
      writeSpacingMs: e.WRITE_SPACING_MS,
      writeSpacingStretchedMs: e.WRITE_SPACING_STRETCHED_MS,
    },
    writers: { max: e.WRITERS_MAX },
    journal: { retentionDays: e.JOURNAL_RETENTION_DAYS, maxBytes: e.JOURNAL_MAX_BYTES },
    mcp: { exposePerOpTools: e.MCP_EXPOSE_PER_OP_TOOLS },
    auth: {
      sessionSecret: e.SESSION_SECRET,
      jwtSigningKey: e.JWT_SIGNING_KEY,
      ...(e.OWNER_PASSWORD_HASH ? { ownerPasswordHash: e.OWNER_PASSWORD_HASH } : {}),
    },
  };
}

export * from './lk.js';
export * from './jobs.js';
export { AuthConfigError, loadAuthConfig, type AuthConfig } from './auth.js';
export { defaultPolicySettings, loadPolicyConfig, PolicyConfigError, type PolicySettings } from './policy.js';
export * from './tools.js';
export * from './admin.js';

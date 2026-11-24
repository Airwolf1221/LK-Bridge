/**
 * The runtime settings functions (chunk 5, docs/dashboard.md). The owner changes these in the dashboard; each value is
 * stored in the `runtime_settings` table under a `dash.` key and applied as follows:
 *
 * | Setting                   | Applied                                                                          |
 * | ------------------------- | -------------------------------------------------------------------------------- |
 * | read-only mode            | at once (the engine's own override, `engine.controls.setReadOnly`)               |
 * | reserve floors            | at once (`governor.setReserveFloors`), and at every start                        |
 * | per-operation tool exposure, member administration, journal retention, tier limits | at the next start |
 *
 * The second group is built into components at construction (the tool list, the policy gate, the governor's windows),
 * so a stored value is applied by `applyStoredSettings` when the runtime is built, and the dashboard shows the pending
 * difference until then. A stored value that no longer validates is ignored (the environment value is used).
 */
import * as z from 'zod';
import { bulkOrderMessage, effectiveBulkFloor } from '../config/floors.js';
import type { Config } from '../config/index.js';
import type { Db } from '../db/open.js';
import { TIER_IDS, type TierId } from '../lk/registry-types.js';

export const SETTING_KEYS = {
  reserveFloors: 'dash.reserve_floors',
  exposePerOpTools: 'dash.expose_per_op_tools',
  allowMemberAdmin: 'dash.allow_member_admin',
  journal: 'dash.journal_retention',
  tierLimits: 'dash.tier_limits',
  contactEmail: 'dash.contact_email',
} as const;

/** The contact address on the public /privacy page (no default; unset means the page leaves the line out). */
export const contactEmailSchema = z.string().trim().max(254).email();

/** The stored contact email, or null when unset (or no longer valid). Read on each request, so a change applies at once. */
export function readContactEmail(db: Db): string | null {
  return readValid(db, SETTING_KEYS.contactEmail, contactEmailSchema);
}

/**
 * The dashboard's reserve floors. v3 F9 (ADR 0074): `bulk` (P4) is optional: left out (as every value saved before F9
 * is), the bulk floor is the environment's, or the default raised to the maintenance floor (`effectiveBulkFloor`). A
 * bulk value below the maintenance floor is refused, the message naming both.
 */
export const reserveFloorsShape = z.object({
  interactive: z.number().min(0).max(1),
  job: z.number().min(0).max(1),
  maintenance: z.number().min(0).max(1),
  bulk: z.number().min(0).max(1).optional(),
});
export const reserveFloorsSchema = reserveFloorsShape.superRefine((f, ctx) => {
  if (!(f.interactive <= f.job && f.job <= f.maintenance))
    ctx.addIssue({
      code: 'custom',
      message: 'Reserve floors must satisfy interactive <= job <= maintenance <= bulk',
    });
  else if (f.bulk !== undefined && f.bulk < f.maintenance)
    ctx.addIssue({ code: 'custom', path: ['bulk'], message: bulkOrderMessage(f.maintenance, f.bulk) });
});
export type ReserveFloors = z.infer<typeof reserveFloorsSchema>;
/** v3 F9: the four floors the governors run with (the bulk floor resolved). */
export interface FloorsInForce {
  readonly interactive: number;
  readonly job: number;
  readonly maintenance: number;
  readonly bulk: number;
}

export const journalSchema = z.object({
  retentionDays: z.number().int().min(1).max(3650),
  maxBytes: z
    .number()
    .int()
    .min(1024 ** 2),
});
export type JournalRetention = z.infer<typeof journalSchema>;

/** Tiers with a counter; `upload` has no published numbers and is reactive only, so it has no limit to set. */
export const LIMITED_TIERS: readonly TierId[] = TIER_IDS.filter((t) => t !== 'upload');
export const tierLimitsSchema = z.partialRecord(
  z.enum(LIMITED_TIERS as [TierId, ...TierId[]]),
  z.number().int().positive(),
);
export type TierLimitOverrides = z.infer<typeof tierLimitsSchema>;

export interface StoredSettings {
  readonly reserveFloors: ReserveFloors | null;
  readonly exposePerOpTools: boolean | null;
  readonly allowMemberAdmin: boolean | null;
  readonly journal: JournalRetention | null;
  readonly tierLimits: TierLimitOverrides | null;
  readonly contactEmail: string | null;
}

function readRaw(db: Db, key: string): unknown {
  try {
    const r = db.prepare('SELECT value FROM runtime_settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return r ? (JSON.parse(r.value) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

function readValid<T>(db: Db, key: string, schema: z.ZodType<T>): T | null {
  const raw = readRaw(db, key);
  if (raw === undefined) return null;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The dashboard's stored values (null = not set, the environment decides). Invalid stored values read as null. */
export function readStoredSettings(db: Db): StoredSettings {
  return {
    reserveFloors: readValid(db, SETTING_KEYS.reserveFloors, reserveFloorsSchema),
    exposePerOpTools: readValid(db, SETTING_KEYS.exposePerOpTools, z.boolean()),
    allowMemberAdmin: readValid(db, SETTING_KEYS.allowMemberAdmin, z.boolean()),
    journal: readValid(db, SETTING_KEYS.journal, journalSchema),
    tierLimits: readValid(db, SETTING_KEYS.tierLimits, tierLimitsSchema),
    contactEmail: readContactEmail(db),
  };
}

/** The configuration with the dashboard's stored values applied. Called once when the runtime is built. */
export function applyStoredSettings(config: Config, db: Db): Config {
  const s = readStoredSettings(db);
  return {
    ...config,
    lk: {
      ...config.lk,
      ...(s.allowMemberAdmin !== null ? { allowMemberAdmin: s.allowMemberAdmin } : {}),
      ...(s.tierLimits ? { tierLimits: { ...config.lk.tierLimits, ...s.tierLimits } } : {}),
    },
    governor: {
      ...config.governor,
      ...(s.reserveFloors ? { reserveFloors: withBulk(s.reserveFloors, config.governor.bulkFloorSet) } : {}),
    },
    journal: s.journal ?? config.journal,
    mcp: { ...config.mcp, ...(s.exposePerOpTools !== null ? { exposePerOpTools: s.exposePerOpTools } : {}) },
  };
}

/**
 * v3 F9 (ADR 0074): the four floors in force from a stored value. Its own bulk value, else the environment's, else the
 * default; never below the maintenance floor (an environment bulk floor under a maintenance floor the owner raised in
 * the dashboard is lifted to it: a start never fails on the order).
 */
export function withBulk(f: ReserveFloors, envBulk: number | null): FloorsInForce {
  const bulk = Math.max(f.maintenance, effectiveBulkFloor(f.maintenance, f.bulk ?? envBulk));
  return { interactive: f.interactive, job: f.job, maintenance: f.maintenance, bulk };
}

/** Writes (or, with `null`, deletes) one stored value. Returns the previous raw value. */
export function writeStoredSetting(db: Db, key: string, value: unknown, by: string, nowMs: number): unknown {
  const before = readRaw(db, key);
  if (value === null || value === undefined) {
    db.prepare('DELETE FROM runtime_settings WHERE key = ?').run(key);
  } else {
    db.prepare(
      `INSERT INTO runtime_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    ).run(key, JSON.stringify(value), nowMs, by);
  }
  return before;
}

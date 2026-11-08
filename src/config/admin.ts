/**
 * Dashboard and admin API settings (chunk 5, docs/dashboard.md). All optional, parsed on their own like the policy
 * and auth settings so `loadConfig()` keeps its required variables unchanged.
 */
import * as z from 'zod';

export interface AdminSettings {
  /** A comment line is sent on every stream this often, so proxies keep the connection open. Default 15 s. */
  readonly streamHeartbeatMs: number;
  /** Recent stream events kept for reconnection (`Last-Event-ID`). Older than this: the client is told to resync. */
  readonly streamReplayEvents: number;
  /** How often a budget snapshot is pushed to connected dashboards. Default 2 s. */
  readonly budgetPushMs: number;
}

export class AdminConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid dashboard configuration:\n - ${issues.join('\n - ')}`);
    this.name = 'AdminConfigError';
  }
}

export function defaultAdminSettings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  const s: AdminSettings = {
    streamHeartbeatMs: overrides.streamHeartbeatMs ?? 15_000,
    streamReplayEvents: overrides.streamReplayEvents ?? 500,
    budgetPushMs: overrides.budgetPushMs ?? 2_000,
  };
  const issues: string[] = [];
  if (!(s.streamHeartbeatMs >= 10)) issues.push('streamHeartbeatMs must be at least 10');
  if (!(s.streamReplayEvents >= 0)) issues.push('streamReplayEvents must not be negative');
  if (!(s.budgetPushMs >= 10)) issues.push('budgetPushMs must be at least 10');
  if (issues.length > 0) throw new AdminConfigError(issues);
  return s;
}

const schema = z.object({
  ADMIN_STREAM_HEARTBEAT_SECONDS: z.coerce.number().int().min(1).max(120).default(15),
  ADMIN_STREAM_REPLAY_EVENTS: z.coerce.number().int().min(0).max(10_000).default(500),
  ADMIN_BUDGET_PUSH_SECONDS: z.coerce.number().int().min(1).max(60).default(2),
});

/** Reads ADMIN_* from the environment (names in .env.example). Never echoes values. */
export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminSettings {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new AdminConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  return defaultAdminSettings({
    streamHeartbeatMs: e.ADMIN_STREAM_HEARTBEAT_SECONDS * 1000,
    streamReplayEvents: e.ADMIN_STREAM_REPLAY_EVENTS,
    budgetPushMs: e.ADMIN_BUDGET_PUSH_SECONDS * 1000,
  });
}

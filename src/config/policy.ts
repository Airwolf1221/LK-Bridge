/**
 * Policy settings (chunk 2b, docs/policy.md): proposal expiry, the expiry sweep and the policy cache. All optional.
 * Parsed on their own, like the auth settings, so `loadConfig()` keeps its required variables unchanged.
 */
import * as z from 'zod';
import { intFrom } from './schema-helpers.js';

export interface PolicySettings {
  /** A pending proposal expires after this long. Default 14 days. */
  readonly proposalExpiryMs: number;
  /** How often pending proposals are checked for expiry. Default 5 minutes. */
  readonly expirySweepMs: number;
  /** How long a principal's scope may be cached. At most 1 s; any change through the bridge clears it at once. */
  readonly cacheMs: number;
  /**
   * Finished proposals (executed, rejected, expired, failed) older than this are deleted, with their stored
   * pre-state, by the `proposal-prune` maintenance job (v1.0.1). Default 90 days.
   */
  readonly proposalRetentionMs: number;
}

export function defaultPolicySettings(overrides: Partial<PolicySettings> = {}): PolicySettings {
  const s: PolicySettings = {
    proposalExpiryMs: overrides.proposalExpiryMs ?? 14 * 86_400_000,
    expirySweepMs: overrides.expirySweepMs ?? 5 * 60_000,
    cacheMs: overrides.cacheMs ?? 1000,
    proposalRetentionMs: overrides.proposalRetentionMs ?? 90 * 86_400_000,
  };
  if (!(s.cacheMs >= 0 && s.cacheMs <= 1000)) throw new PolicyConfigError(['cacheMs must be 0-1000']);
  if (!(s.proposalExpiryMs > 0)) throw new PolicyConfigError(['proposalExpiryMs must be positive']);
  if (!(s.expirySweepMs >= 1000)) throw new PolicyConfigError(['expirySweepMs must be at least 1000']);
  if (!(s.proposalRetentionMs >= 86_400_000))
    throw new PolicyConfigError(['proposalRetentionMs must be at least one day']);
  return s;
}

export class PolicyConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid policy configuration:\n - ${issues.join('\n - ')}`);
    this.name = 'PolicyConfigError';
  }
}

/** Exported for the settings registry (v3 F8, ADR 0073). */
export const POLICY_ENV_SCHEMA = z.object({
  POLICY_PROPOSAL_EXPIRY_DAYS: intFrom(14, 1, 365),
  POLICY_EXPIRY_SWEEP_SECONDS: intFrom(300, 10, 86_400),
  POLICY_PROPOSAL_RETENTION_DAYS: intFrom(90, 1, 3650),
});

/** Reads POLICY_* from the environment (names in .env.example). Never echoes values. */
export function loadPolicyConfig(env: NodeJS.ProcessEnv = process.env): PolicySettings {
  const parsed = POLICY_ENV_SCHEMA.safeParse(env);
  if (!parsed.success) {
    throw new PolicyConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return defaultPolicySettings({
    proposalExpiryMs: parsed.data.POLICY_PROPOSAL_EXPIRY_DAYS * 86_400_000,
    expirySweepMs: parsed.data.POLICY_EXPIRY_SWEEP_SECONDS * 1000,
    proposalRetentionMs: parsed.data.POLICY_PROPOSAL_RETENTION_DAYS * 86_400_000,
  });
}

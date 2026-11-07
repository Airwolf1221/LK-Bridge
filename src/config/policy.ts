/**
 * Policy settings (chunk 2b, docs/policy.md): proposal expiry, the expiry sweep and the policy cache. All optional.
 * Parsed on their own, like the auth settings, so `loadConfig()` keeps its required variables unchanged.
 */
import * as z from 'zod';

export interface PolicySettings {
  /** A pending proposal expires after this long. Default 14 days. */
  readonly proposalExpiryMs: number;
  /** How often pending proposals are checked for expiry. Default 5 minutes. */
  readonly expirySweepMs: number;
  /** How long a principal's scope may be cached. At most 1 s; any change through the bridge clears it at once. */
  readonly cacheMs: number;
}

export function defaultPolicySettings(overrides: Partial<PolicySettings> = {}): PolicySettings {
  const s: PolicySettings = {
    proposalExpiryMs: overrides.proposalExpiryMs ?? 14 * 86_400_000,
    expirySweepMs: overrides.expirySweepMs ?? 5 * 60_000,
    cacheMs: overrides.cacheMs ?? 1000,
  };
  if (!(s.cacheMs >= 0 && s.cacheMs <= 1000)) throw new PolicyConfigError(['cacheMs must be 0-1000']);
  if (!(s.proposalExpiryMs > 0)) throw new PolicyConfigError(['proposalExpiryMs must be positive']);
  if (!(s.expirySweepMs >= 1000)) throw new PolicyConfigError(['expirySweepMs must be at least 1000']);
  return s;
}

export class PolicyConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid policy configuration:\n - ${issues.join('\n - ')}`);
    this.name = 'PolicyConfigError';
  }
}

const schema = z.object({
  POLICY_PROPOSAL_EXPIRY_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  POLICY_EXPIRY_SWEEP_SECONDS: z.coerce.number().int().min(10).max(86_400).default(300),
});

/** Reads POLICY_* from the environment (names in .env.example). Never echoes values. */
export function loadPolicyConfig(env: NodeJS.ProcessEnv = process.env): PolicySettings {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new PolicyConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return defaultPolicySettings({
    proposalExpiryMs: parsed.data.POLICY_PROPOSAL_EXPIRY_DAYS * 86_400_000,
    expirySweepMs: parsed.data.POLICY_EXPIRY_SWEEP_SECONDS * 1000,
  });
}

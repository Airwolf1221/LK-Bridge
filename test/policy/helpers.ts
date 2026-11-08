/**
 * Harness for the policy tests: chunk 2's job harness (FakeClock, mock LK with the stateful model, SQLite in a temp
 * file) with the real policy layer plugged in as the engine's gate and proposal sink, and helpers to create
 * principals (PATs on a profile) the way the bridge does.
 */
import type { AuthEventLogger } from '../../src/auth/events.js';
import { PatService } from '../../src/auth/pats.js';
import { AuthStore } from '../../src/auth/store.js';
import { defaultPolicySettings, type PolicySettings } from '../../src/config/policy.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/open.js';
import type { JobOrigin, Principal } from '../../src/jobs/index.js';
import type { JobsSettings } from '../../src/config/jobs.js';
import { createPolicy, type Policy, type ProfileKind, type Scope } from '../../src/policy/index.js';
import { harness, type EngineHandle, type Harness } from '../jobs/helpers.js';

export const noEvents: AuthEventLogger = () => {};

/** Creates a PAT on profile `label` (created at `scope` if absent) and returns its principal. */
export function makePat(
  db: Db,
  policy: Policy,
  label: string,
  scope: Scope,
  now: () => number,
  kind: ProfileKind = 'other',
): { principal: Principal; patId: string; token: string; profileId: string } {
  const existing = policy.store.getProfileByLabel(label);
  const profile = existing ?? policy.commands.createProfile('owner', { label, kind, scope });
  const pats = new PatService({
    store: new AuthStore(db),
    event: noEvents,
    now: () => Math.floor(now() / 1000),
  });
  const created = pats.create({ name: `${label} token`, profileId: profile.id });
  const resolved = policy.store.lookupPrincipal(created.pat.id)!;
  return {
    principal: resolved.principal,
    patId: created.pat.id,
    token: created.token,
    profileId: profile.id,
  };
}

export function mcpOriginFor(principal: Principal): JobOrigin {
  return { kind: 'mcp', client: 'test-client', tool: 'lk_api_write', principal };
}

export interface PolicyRig {
  readonly h: Harness;
  e: EngineHandle;
  policy: Policy;
  db: Db;
  /** Simulates a process restart: a new engine and a new policy layer on the same database file. */
  restart(o?: { crash?: boolean }): void;
  close(): Promise<void>;
}

export async function policyRig(
  o: {
    settings?: Partial<JobsSettings>;
    policy?: Partial<PolicySettings>;
    allowMemberAdmin?: boolean;
    /** Chunk 6: the maintenance scheduler runs the proposal expiry sweep, so the service starts no timer. */
    externalExpirySweep?: boolean;
  } = {},
): Promise<PolicyRig> {
  const h = await harness();
  const dbs: Db[] = [];
  const build = () => {
    const db = openDatabase(h.dbPath);
    runMigrations(db);
    dbs.push(db);
    const policy = createPolicy({
      db,
      clock: h.clock,
      allowMemberAdmin: o.allowMemberAdmin ?? false,
      settings: defaultPolicySettings(o.policy),
      ...(o.externalExpirySweep ? { externalExpirySweep: true } : {}),
    });
    const e = h.newEngine({
      policyGate: policy.gate,
      proposalSink: policy.proposals,
      settings: { allowMemberAdmin: o.allowMemberAdmin ?? false, ...o.settings },
    });
    policy.attach(e.engine);
    return { db, policy, e };
  };
  const first = build();
  const rig: PolicyRig = {
    h,
    e: first.e,
    policy: first.policy,
    db: first.db,
    restart(r = {}) {
      rig.policy.proposals.detach();
      if (r.crash) rig.e.crash();
      const next = build();
      rig.e = next.e;
      rig.policy = next.policy;
      rig.db = next.db;
    },
    async close() {
      rig.policy.proposals.detach();
      await h.close();
      for (const db of dbs) {
        try {
          db.close();
        } catch {
          // already closed
        }
      }
    },
  };
  return rig;
}

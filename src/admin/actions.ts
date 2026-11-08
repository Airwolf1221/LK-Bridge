/**
 * Every state-changing admin action, in one place. A route never touches the database or the engine itself: it
 * validates its input and calls one of these, and each one goes through the owner command layer (`policy.commands`),
 * an engine control, or the runtime settings functions, and leaves an `audit_log` row (which also emits a `policy`
 * event on the engine's stream). The commands audit themselves; engine controls and settings are audited here.
 */
import type { PatView } from '../auth/pats.js';
import { WRITERS_LIMIT, WRITERS_MIN } from '../config/jobs.js';
import type { ControlsView, JobView } from '../jobs/index.js';
import type { Profile, Scope } from '../policy/index.js';
import { AdminHttpError } from './http.js';
import {
  SETTING_KEYS,
  journalSchema,
  readStoredSettings,
  reserveFloorsSchema,
  tierLimitsSchema,
  writeStoredSetting,
  type JournalRetention,
  type ReserveFloors,
  type TierLimitOverrides,
} from './runtime-settings.js';
import type { AdminDeps } from './types.js';

const OWNER = 'owner' as const;
const SCOPE_RANK: Readonly<Record<Scope, number>> = { read: 0, propose: 1, write: 2 };

export type AdminActions = ReturnType<typeof createAdminActions>;

export function createAdminActions(d: AdminDeps) {
  const { engine, lk, policy } = d.runtime;
  const store = policy.store;
  const cmd = policy.commands;
  const audit = (action: string, target: string | null, before?: unknown, after?: unknown) =>
    store.audit(OWNER, action, target, before, after);
  const brief = (j: JobView) => ({
    status: j.status,
    pauseRequested: j.pauseRequested,
    cancelRequested: j.cancelRequested,
  });
  const job = (id: string) => engine.queries.getJob(id);

  const controlsAudit = (action: string, before: ControlsView, after: ControlsView) =>
    audit(action, null, before, after);

  return {
    // ---------------------------------------------------------------------------------------------- jobs
    cancelJob(id: string): JobView {
      const before = job(id);
      const after = engine.controls.cancel(id);
      audit('job.cancel', id, before ? brief(before) : undefined, brief(after));
      return after;
    },
    pauseJob(id: string): JobView {
      const before = job(id);
      const after = engine.controls.pauseJob(id);
      audit('job.pause', id, before ? brief(before) : undefined, brief(after));
      return after;
    },
    resumeJob(id: string): JobView {
      const before = job(id);
      const after = engine.controls.resumeJob(id);
      audit('job.resume', id, before ? brief(before) : undefined, brief(after));
      return after;
    },
    /** `force` re-runs a step that may already have applied as new work (a person checked LegendKeeper). */
    retryStep(id: string, stepNo: number, force: boolean): JobView {
      const before = job(id)?.steps.find((s) => s.stepNo === stepNo);
      const after = engine.controls.retryStep(id, stepNo, { force });
      audit(
        'job.retry_step',
        `${id}#${stepNo}`,
        before ? { status: before.status, maybeSent: before.maybeSent } : undefined,
        { force, status: after.status },
      );
      return after;
    },

    // --------------------------------------------------------------------------------------------- errors
    resolveErrorGroup(fingerprint: string): number {
      const changed = engine.queries.resolveErrorGroup(fingerprint);
      audit('error.resolve', fingerprint, undefined, { occurrencesResolved: changed });
      return changed;
    },

    // -------------------------------------------------------------------------------------------- writers
    setWritersMax(n: number): ControlsView {
      if (!Number.isInteger(n) || n < WRITERS_MIN || n > WRITERS_LIMIT) {
        throw new AdminHttpError(
          400,
          'INVALID_INPUT',
          `WRITERS_MAX must be a whole number from ${WRITERS_MIN} to ${WRITERS_LIMIT}`,
        );
      }
      const before = engine.queries.controls();
      const after = engine.controls.setWritersMax(n, OWNER);
      controlsAudit('writers.set_max', before, after);
      return after;
    },
    pauseWrites(): ControlsView {
      const before = engine.queries.controls();
      const after = engine.controls.pauseWrites(OWNER);
      controlsAudit('writes.pause', before, after);
      return after;
    },
    resumeWrites(): ControlsView {
      const before = engine.queries.controls();
      const after = engine.controls.resumeWrites(OWNER);
      controlsAudit('writes.resume', before, after);
      return after;
    },
    /** Starts draining and returns at once; the engine's `controls` event follows as the last job finishes. */
    drain(): ControlsView {
      const before = engine.queries.controls();
      void engine.controls.drain().catch(() => undefined);
      const after = engine.queries.controls();
      controlsAudit('writes.drain', before, after);
      return after;
    },
    undrain(): ControlsView {
      const before = engine.queries.controls();
      const after = engine.controls.undrain();
      controlsAudit('writes.undrain', before, after);
      return after;
    },

    // ----------------------------------------------------------------------------------------- settings
    setReadOnly(value: boolean | null): ControlsView {
      const before = engine.queries.controls();
      const after = engine.controls.setReadOnly(value, OWNER);
      controlsAudit('settings.read_only', before, after);
      return after;
    },
    setReserveFloors(value: ReserveFloors | null): ReserveFloors {
      const next =
        value === null ? d.runtime.envConfig.governor.reserveFloors : reserveFloorsSchema.parse(value);
      const before = lk.governor.settings.reserveFloors;
      try {
        lk.governor.setReserveFloors({ P1: next.interactive, P2: next.job, P3: next.maintenance });
      } catch (e) {
        throw new AdminHttpError(
          400,
          'INVALID_INPUT',
          e instanceof Error ? e.message : 'Invalid reserve floors',
        );
      }
      writeStoredSetting(store.db, SETTING_KEYS.reserveFloors, value, OWNER, store.now());
      audit('budget.set_reserve_floors', null, before, lk.governor.settings.reserveFloors);
      return next;
    },
    setExposePerOpTools(value: boolean | null): void {
      const before = writeStoredSetting(store.db, SETTING_KEYS.exposePerOpTools, value, OWNER, store.now());
      audit(
        'settings.expose_per_op_tools',
        null,
        { stored: before ?? null },
        { stored: value, appliesAt: 'restart' },
      );
    },
    setAllowMemberAdmin(value: boolean | null): void {
      const before = writeStoredSetting(store.db, SETTING_KEYS.allowMemberAdmin, value, OWNER, store.now());
      audit(
        'settings.member_admin',
        null,
        { stored: before ?? null },
        { stored: value, appliesAt: 'restart' },
      );
    },
    setJournalRetention(value: JournalRetention | null): void {
      const v = value === null ? null : journalSchema.parse(value);
      const before = writeStoredSetting(store.db, SETTING_KEYS.journal, v, OWNER, store.now());
      audit(
        'settings.journal_retention',
        null,
        { stored: before ?? null },
        { stored: v, appliesAt: 'restart' },
      );
    },
    setTierLimits(value: TierLimitOverrides | null): void {
      const v = value === null ? null : tierLimitsSchema.parse(value);
      const stored = v && Object.keys(v).length > 0 ? v : null;
      const before = writeStoredSetting(store.db, SETTING_KEYS.tierLimits, stored, OWNER, store.now());
      audit('settings.tier_limits', null, { stored: before ?? null }, { stored, appliesAt: 'restart' });
    },
    storedSettings: () => readStoredSettings(store.db),

    // ------------------------------------------------------------------------------------ clients & access
    createProfile: (input: Parameters<typeof cmd.createProfile>[1]): Profile =>
      cmd.createProfile(OWNER, input),
    setScope(profileId: string, scope: Scope, confirmRaise: boolean): Profile {
      const current = cmd.listProfiles(OWNER).find((p) => p.id === profileId);
      if (current && SCOPE_RANK[scope] > SCOPE_RANK[current.scope] && !confirmRaise) {
        throw new AdminHttpError(
          409,
          'CONFIRMATION_REQUIRED',
          `Raising "${current.label}" from ${current.scope} to ${scope} changes what every connection on it can do. Confirm to continue.`,
        );
      }
      return cmd.setScope(OWNER, profileId, scope);
    },
    setDefaultScope(scope: Scope, confirmRaise: boolean): Scope {
      const current = cmd.getDefaultScope(OWNER);
      if (SCOPE_RANK[scope] > SCOPE_RANK[current] && !confirmRaise) {
        throw new AdminHttpError(
          409,
          'CONFIRMATION_REQUIRED',
          `New connections would start at ${scope} instead of ${current}. Confirm to continue.`,
        );
      }
      return cmd.setDefaultScope(OWNER, scope);
    },
    setConnectionProfile: (connectionId: string, profileId: string) =>
      cmd.setConnectionProfile(OWNER, connectionId, profileId),
    revokeConnection: (connectionId: string) => cmd.revoke(OWNER, connectionId),
    /** The token is in the result once and nowhere else: the audit row and events carry no secret. */
    createPat(input: { name: string; profileId: string; expiresInDays?: number }): {
      token: string;
      pat: PatView;
    } {
      if (!cmd.listProfiles(OWNER).some((p) => p.id === input.profileId)) {
        throw new AdminHttpError(404, 'PROFILE_NOT_FOUND', `No profile ${input.profileId}`);
      }
      let created;
      try {
        created = d.services.pats.create({
          name: input.name,
          profileId: input.profileId,
          ...(input.expiresInDays !== undefined ? { expiresInDays: input.expiresInDays } : {}),
        });
      } catch (e) {
        throw new AdminHttpError(
          400,
          'INVALID_INPUT',
          e instanceof Error ? e.message : 'Invalid token request',
        );
      }
      store.bump();
      audit('pat.create', created.pat.id, undefined, {
        name: created.pat.name,
        profileId: created.pat.profileId,
        expiresAt: created.pat.expiresAt,
        hint: created.pat.hint,
      });
      return created;
    },

    // ---------------------------------------------------------------------------------------- proposals
    approve: (id: string) => cmd.approve(OWNER, id),
    reject: (id: string, reason?: string) => cmd.reject(OWNER, id, reason),
    bulkApprove: (ids: readonly string[]) => cmd.bulkApprove(OWNER, ids),
    bulkReject: (ids: readonly string[], reason?: string) => cmd.bulkReject(OWNER, ids, reason),
  };
}

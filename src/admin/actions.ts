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
  const { engine, projects, policy } = d.runtime;
  const store = policy.store;
  const cmd = policy.commands;
  const audit = (action: string, target: string | null, before?: unknown, after?: unknown) =>
    store.audit(OWNER, action, target, before, after);
  const brief = (j: JobView) => ({
    status: j.status,
    pauseRequested: j.pauseRequested,
    cancelRequested: j.cancelRequested,
  });
  const job = (projectId: string, id: string) => engine.queries.getJob(projectId, id);
  /** A proposal of `projectId`, or 404: the dashboard acts on the project it shows, never on another by id. */
  const proposalIn = (projectId: string, id: string) => {
    const p = policy.proposals.get(id);
    if (!p || p.projectId !== projectId) {
      throw new AdminHttpError(404, 'PROPOSAL_NOT_FOUND', `No proposal ${id} in this project`);
    }
    return p;
  };

  const controlsAudit = (action: string, before: ControlsView, after: ControlsView) =>
    audit(action, null, before, after);

  return {
    // ---------------------------------------------------------------------------------------------- jobs
    // Every job and error action names its project (v2 A1); a job of another project is "not found".
    cancelJob(projectId: string, id: string): JobView {
      const before = job(projectId, id);
      const after = engine.controls.cancel(projectId, id);
      audit('job.cancel', id, before ? brief(before) : undefined, { project: projectId, ...brief(after) });
      return after;
    },
    pauseJob(projectId: string, id: string): JobView {
      const before = job(projectId, id);
      const after = engine.controls.pauseJob(projectId, id);
      audit('job.pause', id, before ? brief(before) : undefined, { project: projectId, ...brief(after) });
      return after;
    },
    resumeJob(projectId: string, id: string): JobView {
      const before = job(projectId, id);
      const after = engine.controls.resumeJob(projectId, id);
      audit('job.resume', id, before ? brief(before) : undefined, { project: projectId, ...brief(after) });
      return after;
    },
    /** `force` re-runs a step that may already have applied as new work (a person checked LegendKeeper). */
    retryStep(projectId: string, id: string, stepNo: number, force: boolean): JobView {
      const before = job(projectId, id)?.steps.find((s) => s.stepNo === stepNo);
      const after = engine.controls.retryStep(projectId, id, stepNo, { force });
      audit(
        'job.retry_step',
        `${id}#${stepNo}`,
        before ? { status: before.status, maybeSent: before.maybeSent } : undefined,
        { project: projectId, force, status: after.status },
      );
      return after;
    },

    // --------------------------------------------------------------------------------------------- errors
    resolveErrorGroup(projectId: string, fingerprint: string): number {
      const changed = engine.queries.resolveErrorGroup(projectId, fingerprint);
      audit('error.resolve', fingerprint, undefined, { project: projectId, occurrencesResolved: changed });
      return changed;
    },

    // ------------------------------------------------------------------------------------------- projects
    /** v2 A1: a project's own read-only flag (true overrides the bridge-wide flag for that project). Audited. */
    setProjectReadOnly(projectId: string, value: boolean) {
      const before = projects.find(projectId);
      if (!before?.id) throw new AdminHttpError(404, 'UNKNOWN_PROJECT', `No project ${projectId}`);
      const after = projects.setReadOnly(before.id, value);
      audit(
        'project.set_read_only',
        before.name,
        { readOnly: before.readOnly },
        { readOnly: after?.readOnly ?? value },
      );
      return after;
    },
    /** v2 A1: checks a configured project's key again now (after the owner fixed the env file and restarted, or LK). */
    async verifyProject(name: string) {
      const before = projects.byConfiguredName(name);
      if (!before) throw new AdminHttpError(404, 'UNKNOWN_PROJECT', `No configured project ${name}`);
      const after = await projects.verify(before.name);
      audit('project.verify', before.name, { status: before.status }, { status: after?.status ?? null });
      return after;
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
    /** Reserve floors are bridge-wide: every project's governor gets the same (v2 A1). */
    setReserveFloors(value: ReserveFloors | null): ReserveFloors {
      const next =
        value === null ? d.runtime.envConfig.governor.reserveFloors : reserveFloorsSchema.parse(value);
      const governors = projects.clients().map((c) => c.client.governor);
      const before = governors[0]?.settings.reserveFloors ?? null;
      try {
        // Validated once (the same floors for all), then applied to each.
        reserveFloorsSchema.parse(next);
        for (const g of governors)
          g.setReserveFloors({ P1: next.interactive, P2: next.job, P3: next.maintenance });
      } catch (e) {
        throw new AdminHttpError(
          400,
          'INVALID_INPUT',
          e instanceof Error ? e.message : 'Invalid reserve floors',
        );
      }
      writeStoredSetting(store.db, SETTING_KEYS.reserveFloors, value, OWNER, store.now());
      audit('budget.set_reserve_floors', null, before, governors[0]?.settings.reserveFloors ?? next);
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
    // The dashboard approves or rejects within the project it shows; approval executes against the proposal's project.
    approve: (projectId: string, id: string) => {
      proposalIn(projectId, id);
      return cmd.approve(OWNER, id);
    },
    reject: (projectId: string, id: string, reason?: string) => {
      proposalIn(projectId, id);
      return cmd.reject(OWNER, id, reason);
    },
    bulkApprove: (projectId: string, ids: readonly string[]) => {
      for (const id of ids) if (policy.proposals.get(id)) proposalIn(projectId, id);
      return cmd.bulkApprove(OWNER, ids);
    },
    bulkReject: (projectId: string, ids: readonly string[], reason?: string) => {
      for (const id of ids) if (policy.proposals.get(id)) proposalIn(projectId, id);
      return cmd.bulkReject(OWNER, ids, reason);
    },
    getProposal: (projectId: string, id: string) => {
      proposalIn(projectId, id);
      return cmd.getProposal(OWNER, id);
    },
  };
}

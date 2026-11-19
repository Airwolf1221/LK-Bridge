/**
 * Every state-changing admin action, in one place. A route never touches the database or the engine itself: it
 * validates its input and calls one of these, and each one goes through the owner command layer (`policy.commands`),
 * an engine control, or the runtime settings functions, and leaves an `audit_log` row (which also emits a `policy`
 * event on the engine's stream). The commands audit themselves; engine controls and settings are audited here.
 */
import { REAUTH_WINDOW_SECONDS } from '../auth/owner.js';
import { randomToken, safeEqual } from '../auth/crypto.js';
import { MIN_PASSWORD_LENGTH } from '../auth/cli/setup-owner.js';
import { hashPassword } from '../auth/password.js';
import type { PatView } from '../auth/pats.js';
import { verifyTotp } from '../auth/totp.js';
import { plausibleApiKey } from '../config/check.js';
import { ProjectChangeError, type KeyProbe } from '../projects/registry.js';
import { keyHint } from '../secrets/crypto.js';
import { WRITERS_LIMIT, WRITERS_MIN } from '../config/jobs.js';
import { SYSTEM_PRINCIPAL, type ControlsView, type JobView } from '../jobs/index.js';
import type { Profile, Scope } from '../policy/index.js';
import { SettingValueError, parseSettingValue } from '../projects/index.js';
import {
  canonConfigFrom,
  canonicalRulesSchema,
  DEFAULT_CANONICAL_RULES,
  type CanonicalRule,
} from '../facts/index.js';
import { AdminHttpError } from './http.js';
import {
  SETTING_KEYS,
  contactEmailSchema,
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

const archivedError = (name: string) =>
  new AdminHttpError(
    409,
    'PROJECT_ARCHIVED',
    `Project "${name}" was removed: its history is kept read-only. Add it again (with a key of the same LegendKeeper project) to change it.`,
  );

/** OPS2: job states that keep a project from being removed. */
const UNFINISHED_JOBS = ['queued', 'running', 'waiting_budget', 'waiting_lock', 'paused'] as const;
/** OPS2: proposal states that keep a project from being removed (waiting for the owner, or being carried out). */
const OPEN_PROPOSALS = ['pending', 'approved', 'executing'] as const;
/** OPS2: a checked key waits this long for the owner's confirmation (in memory only, bound to the session). */
const KEY_CHECK_TTL_MS = 5 * 60_000;

/** A checked key waiting for confirmation. The key itself never leaves the server again. */
interface PendingKeyCheck {
  readonly id: string;
  readonly sessionHash: string;
  readonly kind: 'add' | 'replace';
  readonly name: string;
  readonly apiKey: string;
  readonly probe: KeyProbe;
  readonly expiresAt: number;
}

/** What a key check shows the owner before anything is stored: never the key, only its last four characters. */
export interface KeyCheckView {
  readonly checkId: string;
  readonly kind: 'add' | 'replace';
  readonly name: string;
  readonly lkProjectId: string;
  readonly lkProjectName: string | null;
  readonly role: KeyProbe['role'];
  readonly keyHint: string;
  readonly expiresAt: number;
}

export function createAdminActions(d: AdminDeps) {
  const { engine, projects, policy, tree, assets } = d.runtime;
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

  // ------------------------------------------------------------------------------- OPS2: keys and the owner
  const { owner, credentials } = d.services;
  const nowMs = d.now ?? Date.now;
  const pendingChecks = new Map<string, PendingKeyCheck>();
  const sweepChecks = () => {
    const now = nowMs();
    for (const [k, v] of pendingChecks) if (v.expiresAt <= now) pendingChecks.delete(k);
  };
  /** The key as typed: surrounding whitespace removed; anything else wrong is refused without echoing it. */
  const cleanKey = (raw: string): string => {
    const key = raw.trim();
    if (!plausibleApiKey(key)) {
      throw new AdminHttpError(
        400,
        'INVALID_KEY_FORMAT',
        'That does not look like a LegendKeeper API key (one token of letters, digits and - . _ ~ + /, 16 to 512 characters). Paste it again, without spaces or quotes.',
      );
    }
    return key;
  };
  const projectPending = (projectId: string) => ({
    jobs: engine.queries.listJobs(projectId, { status: [...UNFINISHED_JOBS], limit: 500 }).length,
    proposals: OPEN_PROPOSALS.reduce(
      (n, state) =>
        n + policy.commands.listProposals(OWNER, { project: projectId, state, limit: 500 }).length,
      0,
    ),
  });
  const checkKey = async (
    sessionHash: string,
    kind: 'add' | 'replace',
    name: string,
    rawKey: string,
  ): Promise<KeyCheckView> => {
    const apiKey = cleanKey(rawKey);
    let probe: KeyProbe;
    try {
      probe = await projects.probeKey(apiKey);
    } catch (e) {
      audit('project.key_check', name, undefined, {
        kind,
        keyHint: keyHint(apiKey),
        outcome: e instanceof ProjectChangeError ? e.code : 'ERROR',
      });
      throw e;
    }
    if (kind === 'replace') {
      const p = projects.find(name);
      if (p?.id && p.id !== probe.id) {
        audit('project.key_check', name, undefined, {
          kind,
          keyHint: keyHint(apiKey),
          lkProjectId: probe.id,
          outcome: 'KEY_WRONG_PROJECT',
        });
        throw new ProjectChangeError(
          'KEY_WRONG_PROJECT',
          `This key belongs to LegendKeeper project ${probe.id}${probe.displayName ? ` ("${probe.displayName}")` : ''}, not to "${name}" (LegendKeeper project ${p.id}). Nothing was changed.`,
        );
      }
    }
    sweepChecks();
    if (pendingChecks.size >= 20) pendingChecks.delete(pendingChecks.keys().next().value!);
    const check: PendingKeyCheck = {
      id: randomToken(18),
      sessionHash,
      kind,
      name,
      apiKey,
      probe,
      expiresAt: nowMs() + KEY_CHECK_TTL_MS,
    };
    pendingChecks.set(check.id, check);
    audit('project.key_check', name, undefined, {
      kind,
      keyHint: keyHint(apiKey),
      lkProjectId: probe.id,
      role: probe.role,
      outcome: 'ok',
    });
    return {
      checkId: check.id,
      kind,
      name,
      lkProjectId: probe.id,
      lkProjectName: probe.displayName,
      role: probe.role,
      keyHint: keyHint(apiKey),
      expiresAt: check.expiresAt,
    };
  };

  return {
    // ---------------------------------------------------------------------------------------------- jobs
    // Every job and error action names its project (v2 A1); a job of another project is "not found".
    cancelJob(projectId: string, id: string): JobView {
      const before = job(projectId, id);
      const after = engine.controls.cancel(projectId, id, 'owner');
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
      if (before.status === 'archived') throw archivedError(before.name);
      const after = projects.setReadOnly(before.id, value);
      audit(
        'project.set_read_only',
        before.name,
        { readOnly: before.readOnly },
        { readOnly: after?.readOnly ?? value },
      );
      return after;
    },
    /**
     * v3 F2 (ADR 0049 decision 3): stores the default project ("Make default"; the route asks for a fresh
     * re-authentication). Audited `project.make_default`. No restart: the registry answers from the stored default at
     * once, unless LK_DEFAULT_PROJECT overrides it (the page then says so).
     */
    makeDefaultProject(name: string) {
      const before = projects.find(name);
      if (!before || before.status === 'archived')
        throw new AdminHttpError(
          404,
          'UNKNOWN_PROJECT',
          `No project ${name.slice(0, 64)} to make the default`,
        );
      const was = projects.storedDefault;
      const after = projects.makeDefault(before.name);
      if (!after)
        throw new AdminHttpError(
          409,
          'PROJECT_NOT_SERVED',
          `Project "${before.name}" is not served now, so it cannot be the default.`,
        );
      audit('project.make_default', before.name, { storedDefault: was }, { storedDefault: before.name });
      return {
        project: after,
        default: projects.defaultProject().name,
        storedDefault: projects.storedDefault,
        envOverride: projects.envOverride,
      };
    },
    /** v2 A1: checks a configured project's key again now (after the owner fixed the env file and restarted, or LK). */
    async verifyProject(name: string) {
      const before = projects.byConfiguredName(name);
      if (!before) throw new AdminHttpError(404, 'UNKNOWN_PROJECT', `No configured project ${name}`);
      const after = await projects.verify(before.name);
      audit('project.verify', before.name, { status: before.status }, { status: after?.status ?? null });
      return after;
    },

    /**
     * v2 A2: one project setting (the AI REPOSITORY root, the names the tree reads, the sweep switch, …). `null` clears
     * it. Validated like `npm run projects -- set`; audited as `project.set_setting` with the old and new value.
     */
    setProjectSetting(ref: string, key: string, value: unknown) {
      const before = projects.find(ref);
      if (!before?.id) throw new AdminHttpError(404, 'UNKNOWN_PROJECT', `No project ${ref} with stored data`);
      if (before.status === 'archived') throw archivedError(before.name);
      let parsed: string | number | boolean | null;
      try {
        parsed = parseSettingValue(key, value);
      } catch (e) {
        if (e instanceof SettingValueError) throw new AdminHttpError(400, 'INVALID_SETTING', e.message);
        throw e;
      }
      const old = (before.settings as Record<string, unknown>)[key];
      const after = projects.setSetting(before.id, key, parsed);
      audit('project.set_setting', before.name, { key, value: old ?? null }, { key, value: parsed });
      tree.onSettingsChanged(before.id);
      return after;
    },

    /**
     * v2 C2a (ADR 0032): a project's protected canonical facts rules and the Status of pages agents create. `rules: null`
     * restores the defaults. Validated here; audited as `project.set_canonical_rules` with the old and new values.
     */
    setCanonRules(ref: string, input: { rules: unknown; agentDefaultStatus?: string | null }) {
      const before = projects.find(ref);
      if (!before?.id) throw new AdminHttpError(404, 'UNKNOWN_PROJECT', `No project ${ref} with stored data`);
      if (before.status === 'archived') throw archivedError(before.name);
      let rules: CanonicalRule[] | null = null;
      if (input.rules !== null) {
        const parsed = canonicalRulesSchema.safeParse(input.rules);
        if (!parsed.success) {
          throw new AdminHttpError(
            400,
            'INVALID_RULES',
            parsed.error.issues.map((i) => `${i.path.join('.') || 'rules'}: ${i.message}`).join('; '),
          );
        }
        rules = parsed.data as CanonicalRule[];
      }
      const old = canonConfigFrom(before.settings);
      projects.setSetting(before.id, 'canonicalRules', rules);
      let after = projects.find(before.name);
      if (input.agentDefaultStatus !== undefined) {
        const status = input.agentDefaultStatus === null ? null : input.agentDefaultStatus.trim();
        if (status !== null && (status.length === 0 || status.length > 256)) {
          throw new AdminHttpError(400, 'INVALID_SETTING', 'The default status must be 1 to 256 characters.');
        }
        after = projects.setSetting(before.id, 'agentDefaultStatus', status) ?? after;
      }
      const now = canonConfigFrom(after?.settings);
      audit(
        'project.set_canonical_rules',
        before.name,
        { rules: old.rules, defaults: old.defaults, agentDefaultStatus: old.agentDefaultStatus },
        { rules: now.rules, defaults: now.defaults, agentDefaultStatus: now.agentDefaultStatus },
      );
      return { project: before.name, ...now, defaultRules: DEFAULT_CANONICAL_RULES };
    },

    // ------------------------------------------------------------------------- OPS2: projects and their keys
    /** Checks a new project's key with LegendKeeper; nothing is stored until `confirmKeyCheck`. */
    checkNewProjectKey(sessionHash: string, name: string, apiKey: string): Promise<KeyCheckView> {
      const n = name.trim().toLowerCase();
      if (projects.find(n) && projects.find(n)?.status !== 'archived') {
        throw new ProjectChangeError('NAME_TAKEN', `There is already a project called "${n}".`);
      }
      return checkKey(sessionHash, 'add', n, apiKey);
    },
    /** Checks a replacement key: it must belong to the same LegendKeeper project. Nothing is stored yet. */
    checkReplacementKey(sessionHash: string, name: string, apiKey: string): Promise<KeyCheckView> {
      const p = projects.find(name);
      if (!p || p.status === 'archived') {
        throw new ProjectChangeError('NOT_FOUND', `There is no project "${name.slice(0, 64)}".`);
      }
      return checkKey(sessionHash, 'replace', p.name, apiKey);
    },
    /** Stores a checked key (adds the project, or replaces its key) after the owner confirmed what the check showed. */
    confirmKeyCheck(sessionHash: string, checkId: string) {
      sweepChecks();
      const c = pendingChecks.get(checkId);
      if (!c || !safeEqual(c.sessionHash, sessionHash)) {
        throw new AdminHttpError(
          404,
          'CHECK_NOT_FOUND',
          'That key check has expired or was already used. Paste the key and check it again.',
        );
      }
      pendingChecks.delete(checkId);
      if (c.kind === 'add') {
        const view = projects.addProject({ name: c.name, apiKey: c.apiKey, probe: c.probe });
        audit('project.add', view.name, undefined, {
          lkProjectId: c.probe.id,
          lkProjectName: c.probe.displayName,
          role: c.probe.role,
          keyHint: keyHint(c.apiKey),
        });
        return { project: view, reminder: null };
      }
      const { view, oldHint } = projects.replaceKey({ name: c.name, apiKey: c.apiKey, probe: c.probe });
      audit(
        'project.replace_key',
        view.name,
        { keyHint: oldHint },
        { keyHint: keyHint(c.apiKey), lkProjectId: c.probe.id, role: c.probe.role },
      );
      return {
        project: view,
        reminder: `Now revoke the old key${oldHint ? ` (ending ${oldHint})` : ''} in LegendKeeper: Project Settings, Developers, API Keys. The bridge no longer uses it, but it still works until it is revoked.`,
      };
    },
    /** Pauses a project for removal (no new work) or resumes it. Audited. */
    setProjectDraining(name: string, value: boolean) {
      const before = projects.find(name);
      if (!before || before.status === 'archived' || !before.configured) {
        throw new ProjectChangeError('NOT_FOUND', `There is no served project "${name.slice(0, 64)}".`);
      }
      const after = projects.setDraining(before.name, value);
      audit(
        value ? 'project.drain' : 'project.undrain',
        before.name,
        { draining: before.draining },
        {
          draining: after.draining,
          ...(after.id ? projectPending(after.id) : {}),
        },
      );
      return { project: after, pending: after.id ? projectPending(after.id) : { jobs: 0, proposals: 0 } };
    },
    /** What keeps a project from being removed now. */
    projectPending: (projectId: string) => projectPending(projectId),
    /**
     * Removes (archives) a project and deletes its stored key. Refused while it has unfinished jobs or open proposals:
     * pause and drain it first. The check and the removal happen in one synchronous step.
     */
    removeProject(name: string) {
      const before = projects.find(name);
      if (!before || before.status === 'archived') {
        throw new ProjectChangeError('NOT_FOUND', `There is no project "${name.slice(0, 64)}" to remove.`);
      }
      if (before.id) {
        const pending = projectPending(before.id);
        if (pending.jobs > 0 || pending.proposals > 0) {
          throw new AdminHttpError(
            409,
            'PROJECT_BUSY',
            `Project "${before.name}" still has ${pending.jobs} unfinished job(s) and ${pending.proposals} open proposal(s). Pause and drain it first: it then takes no new work, its jobs finish, and you decide its proposals. Then remove it.`,
            { pending, draining: before.draining },
          );
        }
      }
      const after = projects.removeProject(before.name);
      audit(
        'project.remove',
        before.name,
        { keyHint: before.keyHint, keySource: before.keySource },
        {
          lkProjectId: before.id,
          archived: true,
          keyDeleted: true,
        },
      );
      return { project: after };
    },

    // ------------------------------------------------------------------------- OPS2: the owner's account
    /**
     * Re-confirms the owner on this session (OPS2). ADR 0062: the step-up, the authenticator code (or a recovery code)
     * when it is on, else the password; it lasts 10 minutes. Audited.
     */
    async reauthenticate(sessionToken: string, input: { password?: string; totp?: string }, ip: string) {
      const r = await owner.reauthenticate({
        sessionToken,
        password: input.password,
        totp: input.totp,
        ip,
      });
      if (r.ok) {
        audit('owner.reauth', null, undefined, { ok: true });
        return { until: (r.at + REAUTH_WINDOW_SECONDS) * 1000 };
      }
      audit('owner.reauth', null, undefined, { ok: false, reason: r.reason });
      if (r.reason === 'rate_limited') {
        throw new AdminHttpError(
          429,
          'RATE_LIMITED',
          `Too many failed attempts. Try again in ${Math.ceil(r.retryAfterSeconds / 60)} minute(s).`,
          { retryAfterSeconds: r.retryAfterSeconds },
        );
      }
      if (r.reason === 'unavailable') throw new AdminHttpError(503, 'CREDENTIALS_UNAVAILABLE', r.message);
      if (r.reason === 'no_session') {
        throw new AdminHttpError(401, 'UNAUTHENTICATED', 'Sign in as the owner to use the dashboard.');
      }
      throw new AdminHttpError(401, 'REAUTH_FAILED', 'Those details were not recognised.');
    },
    /** Changes the owner's password; every other dashboard session is signed out. Audited (no value). */
    async changePassword(
      sessionToken: string,
      input: { currentPassword: string; newPassword: string },
      ip: string,
    ) {
      const pw = input.newPassword;
      if (pw.length < MIN_PASSWORD_LENGTH || pw.length > 1024) {
        throw new AdminHttpError(
          400,
          'WEAK_PASSWORD',
          `The new password must be at least ${MIN_PASSWORD_LENGTH} characters (and at most 1024).`,
        );
      }
      const current = await owner.checkPassword(input.currentPassword, ip);
      if (!current.ok) {
        audit('owner.password_change', null, undefined, { ok: false, reason: current.reason });
        if (current.reason === 'rate_limited') {
          throw new AdminHttpError(
            429,
            'RATE_LIMITED',
            `Too many failed attempts. Try again in ${Math.ceil(current.retryAfterSeconds / 60)} minute(s).`,
          );
        }
        if (current.reason === 'unavailable')
          throw new AdminHttpError(503, 'CREDENTIALS_UNAVAILABLE', current.message);
        throw new AdminHttpError(401, 'WRONG_PASSWORD', 'The current password is not right.');
      }
      if (input.newPassword === input.currentPassword) {
        throw new AdminHttpError(400, 'SAME_PASSWORD', 'The new password is the same as the current one.');
      }
      const hash = await hashPassword(pw);
      credentials.setPasswordHash(hash);
      const signedOut = owner.revokeOtherSessions(sessionToken);
      d.services.event('password.changed', { other_sessions_signed_out: signedOut });
      audit('owner.password_change', null, undefined, { ok: true, otherSessionsSignedOut: signedOut });
      return { otherSessionsSignedOut: signedOut };
    },
    /** Starts enrolling an authenticator: a new secret, shown once (QR code and text), held until confirmed. */
    beginTotp(sessionHash: string) {
      if (credentials.totp().state !== 'off') {
        throw new AdminHttpError(
          409,
          'TOTP_ALREADY_ON',
          'An authenticator is already set up. Remove it first to enrol another.',
        );
      }
      const secret = credentials.beginTotp(sessionHash);
      audit('owner.totp_enrol_start', null);
      return { secret, account: d.services.config.owner.username, issuer: 'LK-Bridge' };
    },
    /** Confirms the enrolment with a code from the app; returns the recovery codes, shown once. */
    confirmTotp(sessionHash: string, code: string) {
      const secret = credentials.pendingTotp(sessionHash);
      if (!secret) {
        throw new AdminHttpError(
          409,
          'NO_ENROLMENT',
          'There is no enrolment waiting (it lasts 10 minutes). Start again.',
        );
      }
      const now = d.services.now();
      const step = verifyTotp(secret, code.replace(/\s+/g, ''), now);
      if (step === undefined || !d.services.store.claimTotpStep(step, now)) {
        audit('owner.totp_enable', null, undefined, { ok: false });
        throw new AdminHttpError(
          400,
          'WRONG_CODE',
          'That code does not match. Check the time on your phone and try the next code.',
        );
      }
      const recoveryCodes = credentials.enableTotp(sessionHash);
      d.services.event('totp.enabled', { recovery_codes: recoveryCodes.length });
      audit('owner.totp_enable', null, undefined, { ok: true, recoveryCodes: recoveryCodes.length });
      return { recoveryCodes };
    },
    removeTotp() {
      if (credentials.totp().state === 'off') {
        throw new AdminHttpError(409, 'TOTP_OFF', 'No authenticator is set up.');
      }
      credentials.disableTotp();
      d.services.event('totp.removed', {});
      audit('owner.totp_remove', null, undefined, { ok: true });
    },
    regenerateRecoveryCodes() {
      if (credentials.totp().state !== 'on') {
        throw new AdminHttpError(
          409,
          'TOTP_OFF',
          'Recovery codes belong to an authenticator; set one up first.',
        );
      }
      const recoveryCodes = credentials.regenerateRecoveryCodes();
      d.services.event('recovery_codes.regenerated', { count: recoveryCodes.length });
      audit('owner.recovery_codes_regenerate', null, undefined, { count: recoveryCodes.length });
      return { recoveryCodes };
    },

    // ------------------------------------------------------------------------------------- repository tree
    /** v2 A2: starts a build's listing; it then waits for the owner to confirm its estimate. Audited. */
    treePrepareBuild(projectId: string) {
      const pass = tree.prepareBuild(projectId, { trigger: 'owner' });
      audit('tree.build_prepare', projects.nameOf(projectId), undefined, { pass: pass.id });
      return pass;
    },
    treeConfirmBuild(projectId: string) {
      const pass = tree.confirmBuild(projectId);
      audit('tree.build_start', projects.nameOf(projectId), undefined, {
        pass: pass.id,
        estimate: pass.estimate,
      });
      return pass;
    },
    treeCancelBuild(projectId: string) {
      const pass = tree.cancelBuild(projectId);
      audit('tree.build_cancel', projects.nameOf(projectId), undefined, { pass: pass.id });
      return pass;
    },
    /** Looks for the AI REPOSITORY root (one listing at P3); never applies it. */
    async treeSuggestRoot(projectId: string) {
      audit('tree.suggest_root', projects.nameOf(projectId));
      return tree.suggestRoot(projectId);
    },

    // ------------------------------------------------------------------------------------- asset tree
    /** v2 A4: starts an asset-tree build's root-level listing; it then waits for the owner to confirm its estimate. */
    assetsPrepareBuild(projectId: string) {
      const pass = assets.prepareBuild(projectId, { trigger: 'owner' });
      audit('assets.build_prepare', projects.nameOf(projectId), undefined, { pass: pass.id });
      return pass;
    },
    assetsConfirmBuild(projectId: string) {
      const pass = assets.confirmBuild(projectId);
      audit('assets.build_start', projects.nameOf(projectId), undefined, {
        pass: pass.id,
        estimate: pass.estimate,
      });
      return pass;
    },
    assetsCancelBuild(projectId: string) {
      const pass = assets.cancelBuild(projectId);
      audit('assets.build_cancel', projects.nameOf(projectId), undefined, { pass: pass.id });
      return pass;
    },
    /** Runs a refresh now (the same walk as the scheduled one), in the background. */
    assetsRefreshNow(projectId: string) {
      audit('assets.refresh_now', projects.nameOf(projectId));
      return assets.refresh(projectId, 'owner');
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
    /** The contact email on the public /privacy page. Applies at once; null removes the line. */
    setContactEmail(value: string | null): void {
      const v = value === null ? null : contactEmailSchema.parse(value);
      const before = writeStoredSetting(store.db, SETTING_KEYS.contactEmail, v, OWNER, store.now());
      audit(
        'settings.contact_email',
        null,
        { stored: before ?? null },
        { stored: v, appliesAt: 'immediately' },
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
    setShowLowLevelTools: (profileId: string, show: boolean): Profile =>
      cmd.setShowLowLevelTools(OWNER, profileId, show),
    /** v3 F3.4 (ADR 0055): a profile's safety rails (the route re-authenticates first). */
    setRails: (profileId: string, change: unknown): Profile => cmd.setRails(OWNER, profileId, change),
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
    // ADR 0033: removal (with tombstones, audited by the command layer), stale revocation and the two settings.
    removeConnection: (connectionId: string) => cmd.removeConnection(OWNER, connectionId),
    removeInactiveConnections: () => cmd.removeInactiveConnections(OWNER),
    revokeStaleConnections: (profileId: string) => {
      const revoked = cmd.revokeStaleConnections(OWNER, profileId);
      return { revoked: revoked.length, ids: revoked };
    },
    setAutoRemoveDays: (days: number) => cmd.setAutoRemoveDays(OWNER, days),
    setStaleAfterDays: (days: number) => cmd.setStaleAfterDays(OWNER, days),
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
    /** v3 F3d (ADR 0058): `items`, the owner's selection of a proposal made of items (audited as approve_selected). */
    approve: (projectId: string, id: string, items?: readonly string[]) => {
      proposalIn(projectId, id);
      return cmd.approve(OWNER, id, items ? { items } : {});
    },
    /** v2 C2a: "Approve and accept as canon" (audited as proposal.approve_as_canon by the proposal service). */
    approveAsCanon: (projectId: string, id: string, items?: readonly string[]) => {
      proposalIn(projectId, id);
      return cmd.approveAsCanon(OWNER, id, items ? { items } : {});
    },
    /** v3 F3d (ADR 0058): "propose these again" (audited as proposal.repropose by the proposal service). */
    reproposeOmitted: (projectId: string, id: string) => {
      proposalIn(projectId, id);
      return cmd.reproposeOmitted(OWNER, id, {
        kind: 'ui',
        client: 'owner',
        tool: 'proposal.repropose',
        detail: `repropose:${id}`,
        principal: SYSTEM_PRINCIPAL,
      });
    },
    reject: (projectId: string, id: string, reason?: string) => {
      proposalIn(projectId, id);
      return cmd.reject(OWNER, id, reason);
    },
    bulkApprove: (projectId: string, ids: readonly string[]) => {
      for (const id of ids) if (policy.proposals.get(id)) proposalIn(projectId, id);
      return cmd.bulkApprove(OWNER, ids);
    },
    /** v2 C2d-prep (11 Nov): "Accept selected as canon": one canonical approval per id, in order. */
    bulkApproveAsCanon: (projectId: string, ids: readonly string[]) => {
      for (const id of ids) if (policy.proposals.get(id)) proposalIn(projectId, id);
      return cmd.bulkApproveAsCanon(OWNER, ids);
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

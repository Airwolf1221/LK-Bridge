import { requireReauth } from '../guard.js';
import * as z from 'zod';
import { AdminHttpError } from '../http.js';
import { redactDeep } from '../redact.js';
import {
  LIMITED_TIERS,
  contactEmailSchema,
  journalSchema,
  readStoredSettings,
  tierLimitsSchema,
  type StoredSettings,
} from '../runtime-settings.js';
import { createConfigSettings, type ConfigSettings } from '../config-settings.js';
import { RestartUnavailableError } from '../restart.js';
import { idSchema, limitSchema, parseInput, projectParam, type Register } from './util.js';

const confirm = z.literal(true);
const nullableBool = z.object({ value: z.boolean().nullable(), confirm });

export const registerSettings: Register = (api, ctx) => {
  const { engine, config, envConfig } = ctx.deps.runtime;
  const { actions } = ctx;
  const { db } = ctx.deps.runtime.policy.store;

  /** Each deferred setting: what is running, what is stored, and what applies if the stored value is cleared. */
  const view = () => {
    const stored: StoredSettings = readStoredSettings(db);
    const controls = engine.queries.controls();
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const deferred = <T>(running: T, storedValue: T | null, env: T) => ({
      running,
      stored: storedValue,
      environment: env,
      pendingRestart: !same(storedValue ?? env, running),
    });
    const tierRunning = Object.fromEntries(LIMITED_TIERS.map((t) => [t, config.lk.tierLimits[t] ?? null]));
    const tierEnv = Object.fromEntries(LIMITED_TIERS.map((t) => [t, envConfig.lk.tierLimits[t] ?? null]));
    const tierWanted = Object.fromEntries(
      LIMITED_TIERS.map((t) => [t, stored.tierLimits?.[t] ?? envConfig.lk.tierLimits[t] ?? null]),
    );
    return {
      readOnly: {
        effective: controls.readOnly,
        override: controls.readOnlyOverride,
        environment: envConfig.lk.readOnly,
        appliesAt: 'immediately',
      },
      exposePerOpTools: {
        ...deferred(config.mcp.exposePerOpTools, stored.exposePerOpTools, envConfig.mcp.exposePerOpTools),
        appliesAt: 'restart',
      },
      memberAdmin: {
        ...deferred(config.lk.allowMemberAdmin, stored.allowMemberAdmin, envConfig.lk.allowMemberAdmin),
        appliesAt: 'restart',
      },
      journalRetention: {
        ...deferred(config.journal, stored.journal, envConfig.journal),
        appliesAt: 'restart',
      },
      tierLimits: {
        running: tierRunning,
        stored: stored.tierLimits,
        environment: tierEnv,
        pendingRestart: !same(tierWanted, tierRunning),
        tiers: LIMITED_TIERS,
        appliesAt: 'restart',
      },
      contactEmail: { stored: stored.contactEmail, appliesAt: 'immediately' },
      reserveFloors: { appliesAt: 'immediately' },
      writersMax: controls.writersMax,
    };
  };

  api.get('/settings', () => ({ settings: view() }));

  // ------------------------------------------------------------------ v3 F8 (ADR 0073): every setting, by group

  const cfg = ctx.deps.runtime.configSettings;
  const { credentials } = ctx.deps.services;
  const model: ConfigSettings | null = cfg
    ? createConfigSettings({
        runtime: ctx.deps.runtime,
        cfg,
        actions,
        db,
        now: ctx.now,
        ownerStored: () => {
          const pw = credentials.password();
          return { password: pw.ok && pw.source === 'store', totp: credentials.totp().state === 'on' };
        },
      })
    : null;
  const need = (): ConfigSettings => {
    if (!model)
      throw new AdminHttpError(503, 'SETTINGS_UNAVAILABLE', 'This runtime has no settings registry.');
    return model;
  };
  const keyParam = z.object({
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  });
  const setBody = z.union([
    z.object({ value: z.union([z.number(), z.boolean(), z.string().max(4096)]), confirm }),
    z.object({ amount: z.number(), unit: z.string().max(16), confirm }),
  ]);

  /** Every registry entry with its value and source; secrets as "set" or "not set" only. */
  api.get('/settings/config', () => need().list());
  api.put('/settings/config/:key', (req) => {
    const { key } = parseInput(keyParam, req.params);
    const b = parseInput(setBody, req.body);
    requireReauth(ctx.deps.services, req); // ADR 0062: a setting
    return {
      entry: need().set(key, 'amount' in b ? { amount: b.amount, unit: b.unit } : { value: b.value }),
    };
  });
  api.post('/settings/config/:key/reset', (req) => {
    const { key } = parseInput(keyParam, req.params);
    parseInput(z.object({ confirm }), req.body);
    requireReauth(ctx.deps.services, req); // ADR 0062: a setting
    return { entry: need().reset(key) };
  });
  /** S7: drains, flushes and exits 75; systemd starts the bridge again. Under systemd only. */
  api.post('/bridge/restart', (req, reply) => {
    parseInput(z.object({ confirm }), req.body);
    requireReauth(ctx.deps.services, req); // ADR 0062: as sensitive as any setting
    if (!cfg) throw new AdminHttpError(503, 'RESTART_UNAVAILABLE', 'This runtime cannot restart.');
    try {
      cfg.restart.request('owner');
    } catch (e) {
      if (e instanceof RestartUnavailableError)
        throw new AdminHttpError(409, 'RESTART_UNAVAILABLE', e.message);
      throw e;
    }
    return reply.code(202).send({ restarting: true, restart: cfg.restart.status() });
  });

  api.put('/settings/read-only', (req) => {
    const b = parseInput(nullableBool, req.body);
    // ADR 0062 (the owner's rule): switching read-only on is one click (a brake); switching it off asks for the step-up.
    if (engine.queries.controls().readOnly && !(b.value ?? envConfig.lk.readOnly))
      requireReauth(ctx.deps.services, req);
    actions.setReadOnly(b.value);
    return { settings: view() };
  });
  api.put('/settings/expose-per-op-tools', (req) => {
    requireReauth(ctx.deps.services, req); // ADR 0062: a setting
    actions.setExposePerOpTools(parseInput(nullableBool, req.body).value);
    return { settings: view() };
  });
  api.put('/settings/member-admin', (req) => {
    requireReauth(ctx.deps.services, req); // ADR 0062: a setting
    actions.setAllowMemberAdmin(parseInput(nullableBool, req.body).value);
    return { settings: view() };
  });
  api.put('/settings/contact-email', (req) => {
    requireReauth(ctx.deps.services, req); // ADR 0062: a setting
    const b = parseInput(z.object({ value: contactEmailSchema.nullable(), confirm }), req.body);
    actions.setContactEmail(b.value);
    return { settings: view() };
  });
  api.put('/settings/journal-retention', (req) => {
    requireReauth(ctx.deps.services, req); // ADR 0062: a setting
    const b = parseInput(z.object({ value: journalSchema.nullable(), confirm }), req.body);
    actions.setJournalRetention(b.value);
    return { settings: view() };
  });
  api.put('/settings/tier-limits', (req) => {
    requireReauth(ctx.deps.services, req); // ADR 0062: a setting
    const b = parseInput(z.object({ value: tierLimitsSchema.nullable(), confirm }), req.body);
    actions.setTierLimits(b.value);
    return { settings: view() };
  });

  // ---------------------------------------------------------------------------------------------- journal

  const journalQuery = z.object({
    jobId: idSchema.optional(),
    resourceId: idSchema.optional(),
    documentId: idSchema.optional(),
    targetId: idSchema.optional(),
    opId: idSchema.optional(),
    principalId: idSchema.optional(),
    profile: idSchema.optional(),
    outcome: z.enum(['applied', 'pending', 'not_applied', 'unknown', 'superseded']).optional(),
    withPreImage: z.enum(['true', 'false']).optional(),
    before: z.coerce.number().int().min(1).optional(),
    sinceMinutes: z.coerce
      .number()
      .min(1)
      .max(60 * 24 * 365)
      .optional(),
    limit: limitSchema(50, 200),
    project: projectParam,
  });

  /** Listing: metadata only (cheap), of one project. A pre-image is fetched for one entry at a time. */
  api.get('/journal', (req) => {
    const q = parseInput(journalQuery, req.query);
    const project = ctx.project(q.project);
    const entries = engine.queries.journalLookup(project.id, {
      ...(q.jobId ? { jobId: q.jobId } : {}),
      ...(q.resourceId ? { resourceId: q.resourceId } : {}),
      ...(q.documentId ? { documentId: q.documentId } : {}),
      ...(q.targetId ? { targetId: q.targetId } : {}),
      ...(q.opId ? { opId: q.opId } : {}),
      ...(q.principalId ? { principalId: q.principalId } : {}),
      ...(q.profile ? { profile: q.profile } : {}),
      ...(q.outcome ? { outcome: q.outcome } : {}),
      ...(q.withPreImage === 'true' ? { withPreImage: true } : {}),
      ...(q.before !== undefined ? { before: q.before } : {}),
      ...(q.sinceMinutes ? { since: ctx.now() - q.sinceMinutes * 60_000 } : {}),
      limit: q.limit,
      includePreImage: false,
    });
    const hasMore = entries.length === q.limit;
    return {
      project,
      entries: redactDeep(entries),
      principals: ctx.principals(entries.map((e) => e.principalId)),
      hasMore,
      // Paging (chunk 8): pass as `before` for the next, older page.
      nextBefore: hasMore ? (entries.at(-1)?.id ?? null) : null,
    };
  });

  api.get('/journal/:id', (req) => {
    const { id } = parseInput(z.object({ id: z.coerce.number().int().min(1) }), req.params);
    const project = ctx.project(parseInput(z.object({ project: projectParam }), req.query).project);
    const [entry] = engine.queries.journalLookup(project.id, { id, limit: 1, includePreImage: true });
    if (!entry) throw new AdminHttpError(404, 'JOURNAL_ENTRY_NOT_FOUND', `No journal entry ${id}`);
    // View only. A pre-image is the owner's own LegendKeeper content, so it is shown whole (secrets still removed).
    // v3 F5a (ADR 0067, H10): how an unknown outcome was (or is being) settled.
    const reconciliation = ctx.deps.runtime.outcomes?.get(entry.id) ?? null;
    return {
      entry: redactDeep(entry, { maxString: 500_000, maxItems: 20_000, maxKeys: 2000, maxDepth: 64 }),
      principals: ctx.principals([entry.principalId]),
      reconciliation,
    };
  });
};

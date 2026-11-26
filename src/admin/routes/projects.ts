/**
 * The Projects page (v2 A1): every project this bridge knows, its flags, its LegendKeeper id, whether its key is
 * configured and valid, and its settings. Keys are never shown: only the name of the variable that holds one, or
 * (OPS2) the last four characters of the key in use.
 *
 * OPS2: projects are added, re-keyed, paused and drained, and removed here, at runtime. A key goes in once, through a
 * write-only field: the bridge checks it with LegendKeeper and shows what it found (project, id, the key's role); only
 * after the owner confirms is it stored, encrypted. Adding, replacing and removing need a fresh re-authentication.
 */
import * as z from 'zod';
import { canonConfigFrom, DEFAULT_CANONICAL_RULES } from '../../facts/index.js';
import { PROJECT_SETTING_KEYS } from '../../projects/index.js';
import { requireReauth } from '../guard.js';
import { AdminHttpError } from '../http.js';
import { parseInput, type Register } from './util.js';

const nameParam = z.object({ name: z.string().min(1).max(64) });

export const registerProjects: Register = (api, ctx) => {
  const { projects, config } = ctx.deps.runtime;

  api.get('/projects', () => {
    projects.refresh(); // settings changed with `npm run projects -- set` while the bridge runs
    const def = projects.defaultProject();
    const override = projects.envOverride;
    return {
      default: def.name,
      // v3 F2 (ADR 0049 decision 3): the dashboard's stored choice, and the env file's override when it disagrees.
      storedDefault: projects.storedDefault,
      envOverride: override,
      ...(override
        ? {
            overrideNote: `The env file’s LK_DEFAULT_PROJECT=${override} overrides this; remove that line to use the dashboard’s choice.`,
          }
        : {}),
      requireProjectForWrites: config.lk.requireProjectForWrites,
      singleProjectForm: config.lk.singleProjectForm,
      settingKeys: PROJECT_SETTING_KEYS,
      projects: projects.list().map((p) => ({
        name: p.name,
        id: p.id,
        displayName: p.displayName,
        isDefault: p.isDefault,
        isSandbox: p.isSandbox,
        readOnly: p.readOnly,
        configured: p.configured,
        registered: p.registered,
        status: p.status,
        reason: p.reason,
        keyVariable: p.keyVariable,
        keyPresent: p.configured,
        keyValid: p.keyValid,
        verifiedAt: p.verifiedAt,
        checkedAt: p.checkedAt,
        settings: p.settings,
        settingsProblem: p.settingsProblem,
        keySource: p.keySource,
        keyHint: p.keyHint,
        keyConflict: p.keyConflict,
        draining: p.draining,
        archived: p.status === 'archived',
        archivedAt: p.archivedAt,
        pending:
          p.id !== null && p.status !== 'archived'
            ? ctx.actions.projectPending(p.id)
            : { jobs: 0, proposals: 0 },
      })),
      canManageKeys: projects.canManageKeys,
      notes: projects.notes,
    };
  });

  // ------------------------------------------------------------------------------------------ OPS2: keys

  /** Step 1 of adding a project: check the key with LegendKeeper. Nothing is stored. */
  api.post('/projects/check', async (req) => {
    const token = requireReauth(ctx.deps.services, req);
    const b = parseInput(
      z.object({ name: z.string().min(1).max(64), apiKey: z.string().min(1).max(1024) }),
      req.body,
    );
    return ctx.actions.checkNewProjectKey(ctx.deps.services.sessionHash(token), b.name, b.apiKey);
  });

  /** Step 1 of replacing a key: check it, and that it belongs to the same LegendKeeper project. Nothing is stored. */
  api.post('/projects/:name/key/check', async (req) => {
    const token = requireReauth(ctx.deps.services, req);
    const { name } = parseInput(nameParam, req.params);
    const b = parseInput(z.object({ apiKey: z.string().min(1).max(1024) }), req.body);
    return ctx.actions.checkReplacementKey(ctx.deps.services.sessionHash(token), name, b.apiKey);
  });

  /** Step 2: the owner confirmed what the check showed. The key is stored, encrypted, and served at once. */
  api.post('/projects/confirm', (req) => {
    const token = requireReauth(ctx.deps.services, req);
    const b = parseInput(
      z.object({ checkId: z.string().min(1).max(64), confirm: z.literal(true) }),
      req.body,
    );
    return ctx.actions.confirmKeyCheck(ctx.deps.services.sessionHash(token), b.checkId);
  });

  /** Pause and drain before removal (`value: false` resumes). */
  api.put('/projects/:name/draining', (req) => {
    const { name } = parseInput(nameParam, req.params);
    const b = parseInput(z.object({ value: z.boolean() }), req.body);
    return ctx.actions.setProjectDraining(name, b.value);
  });

  /** Removes (archives) a project and deletes its stored key. Refused while work is pending. */
  api.post('/projects/:name/remove', (req) => {
    requireReauth(ctx.deps.services, req);
    const { name } = parseInput(nameParam, req.params);
    parseInput(z.object({ confirm: z.literal(true) }), req.body);
    return ctx.actions.removeProject(name);
  });

  /** v3 F2 (ADR 0049 decision 3): "Make default": stores the default project. Audited (ADR 0081: no fresh code). */
  api.post('/projects/:name/default', (req) => {
    const { name } = parseInput(nameParam, req.params);
    parseInput(z.object({ confirm: z.literal(true) }), req.body);
    return ctx.actions.makeDefaultProject(name);
  });

  api.put('/projects/:name/read-only', (req) => {
    const { name } = parseInput(nameParam, req.params);
    const b = parseInput(z.object({ value: z.boolean(), confirm: z.literal(true) }), req.body);
    const p = projects.find(name);
    if (!p?.id) throw new AdminHttpError(404, 'UNKNOWN_PROJECT', `No project ${name} with stored data`);
    const after = ctx.actions.setProjectReadOnly(p.id, b.value);
    return { project: after };
  });

  /** v2 A2: one setting of a project (`value: null` clears it). Audited as `project.set_setting`. */
  api.put('/projects/:name/settings', (req) => {
    const { name } = parseInput(nameParam, req.params);
    const b = parseInput(
      z.object({
        key: z.string().min(1).max(64),
        value: z.union([z.string().max(256), z.boolean(), z.null()]),
      }),
      req.body,
    );
    return { project: ctx.actions.setProjectSetting(name, b.key, b.value) };
  });

  /** v2 C2a: the project's protected canonical facts rules and the Status of pages agents create. */
  api.get('/projects/:name/canon', (req) => {
    const { name } = parseInput(nameParam, req.params);
    const p = projects.find(name);
    if (!p?.id) throw new AdminHttpError(404, 'UNKNOWN_PROJECT', `No project ${name} with stored data`);
    return {
      project: p.name,
      ...canonConfigFrom(p.settings),
      defaultRules: DEFAULT_CANONICAL_RULES,
    };
  });

  /**
   * v2 C2a: replaces the rules (`rules: null` restores the defaults); `confirm: true` required. Audited. C2d (ADR 0036
   * decision 4, the owner's) asked a step-up of any change; ADR 0081: no fresh code (a code at sign-in is enough).
   */
  api.put('/projects/:name/canon', (req) => {
    const { name } = parseInput(nameParam, req.params);
    const b = parseInput(
      z.object({
        rules: z.union([z.array(z.unknown()).max(50), z.null()]),
        agentDefaultStatus: z.union([z.string().max(256), z.null()]).optional(),
        confirm: z.literal(true),
      }),
      req.body,
    );
    return ctx.actions.setCanonRules(name, {
      rules: b.rules,
      ...(b.agentDefaultStatus !== undefined ? { agentDefaultStatus: b.agentDefaultStatus } : {}),
    });
  });

  api.post('/projects/:name/verify', async (req) => {
    const { name } = parseInput(nameParam, req.params);
    return { project: await ctx.actions.verifyProject(name) };
  });
};

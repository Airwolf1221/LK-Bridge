/**
 * The Projects page (v2 A1): every project this bridge knows, its flags, its LegendKeeper id, whether its key is
 * configured and valid, and its settings (read-only in this release). The per-project read-only flag is the one thing
 * editable here (audited, with a confirmation). Keys are never shown: only the name of the variable that holds one.
 */
import * as z from 'zod';
import { PROJECT_SETTING_KEYS } from '../../projects/index.js';
import { AdminHttpError } from '../http.js';
import { parseInput, type Register } from './util.js';

const nameParam = z.object({ name: z.string().min(1).max(64) });

export const registerProjects: Register = (api, ctx) => {
  const { projects, config } = ctx.deps.runtime;

  api.get('/projects', () => {
    const def = projects.defaultProject();
    return {
      default: def.name,
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
      })),
    };
  });

  api.put('/projects/:name/read-only', (req) => {
    const { name } = parseInput(nameParam, req.params);
    const b = parseInput(z.object({ value: z.boolean(), confirm: z.literal(true) }), req.body);
    const p = projects.find(name);
    if (!p?.id) throw new AdminHttpError(404, 'UNKNOWN_PROJECT', `No project ${name} with stored data`);
    const after = ctx.actions.setProjectReadOnly(p.id, b.value);
    return { project: after };
  });

  api.post('/projects/:name/verify', async (req) => {
    const { name } = parseInput(nameParam, req.params);
    return { project: await ctx.actions.verifyProject(name) };
  });
};

/**
 * The Automation page's API (v3 F5b, ADR 0068; docs/dashboard.md › Automation): automatic actions for audits, switched
 * on one finding code at a time by the owner.
 *
 * - `GET /automation`: every eligible code (its plain name, an example, its transformation, its setting, its last run,
 *   what it did or skipped, its journal of changes), the bridge-wide pause, the caps, the latest runs, and the codes
 *   that are never automatic. Reads only the bridge's own data.
 * - `GET /automation/governance`: whether Repository Automation lets automation run (one read of each governance source).
 * - `POST /automation/codes/:code` `{ mode, confirm }`: the owner changes a code's setting (ALWAYS the step-up, as the
 *   design asks); the governance paragraph is written or amended first. Audited `automation.set_mode`.
 * - `POST /automation/codes/:code/resume`: a paused code resumed (the step-up: it releases a brake).
 * - `POST /automation/pause`: "Pause all automation", one click, no step-up (a brake). `POST /automation/resume`: the
 *   step-up.
 * - `POST /automation/run`: "Run automation now" in the project (the step-up). `wait: true` answers when it has finished.
 * - `GET /automation/runs/:id`: a run and its items.
 * - `GET /automation/overnight`: what automation did in the last 24 hours (the Overview's tile).
 */
import * as z from 'zod';
import { AutomationError, type AutomationService } from '../../automation/service.js';
import { CATALOGUE, ELIGIBLE, NEVER_TRAITS } from '../../automation/registry.js';
import { requireReauth } from '../guard.js';
import { AdminHttpError } from '../http.js';
import { parseInput, projectParam, type Register, projectFor } from './util.js';

const STATUS: Readonly<Record<string, number>> = {
  NOT_OWNER: 403,
  NOT_ELIGIBLE: 400,
  NOT_PAUSED: 409,
  AUTOMATION_UNAVAILABLE: 409,
  SOURCE_ELSEWHERE: 409,
  GOVERNANCE_DRIFT: 409,
  GOVERNANCE_EDITED: 409,
  GOVERNANCE_UNREADABLE: 409,
  GOVERNANCE_SECTION_MISSING: 409,
  GOVERNANCE_SWEEP_MISSING: 409,
  GOVERNANCE_NOT_EDITABLE: 409,
  GOVERNANCE_NOT_WRITTEN: 409,
  GOVERNANCE_WRITE_FAILED: 409,
};

const codeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const DAY = 24 * 3_600_000;

export const registerAutomation: Register = (api, ctx) => {
  const automation = (): AutomationService => {
    const a = ctx.deps.runtime.automation;
    if (!a)
      throw new AdminHttpError(503, 'AUTOMATION_UNAVAILABLE', 'Automation is not running on this bridge.');
    return a;
  };
  const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof AutomationError)
        throw new AdminHttpError(STATUS[e.code] ?? 400, e.code, e.message, { details: e.details });
      throw e;
    }
  };

  api.get('/automation', (req) => {
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = ctx.project(q.project);
    const a = automation();
    return {
      project: p,
      global: a.store.global(),
      caps: a.caps(),
      codes: a.codes(p.id),
      runs: a.store.runs(p.id, { limit: 10 }),
      never: CATALOGUE.filter((e) => e.automatable !== 'mechanical').map((e) => ({
        code: e.code,
        name: e.name,
        why: e.traits.filter((t) => NEVER_TRAITS.includes(t)),
        transformation: e.transformation,
      })),
      eligible: ELIGIBLE.length,
    };
  });

  api.get('/automation/governance', async (req) => {
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = ctx.project(q.project);
    return wrap(() => automation().governanceState(p.id));
  });

  api.post('/automation/codes/:code', async (req) => {
    const params = parseInput(z.object({ code: codeSchema }), req.params);
    const b = parseInput(
      z
        .object({
          project: projectParam,
          mode: z.enum(['off', 'propose', 'apply']),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    // ADR 0068 (the design: "changing a setting is an owner action with the step-up"): every change asks.
    requireReauth(ctx.deps.services, req);
    const p = projectFor(ctx, req, b.project);
    return wrap(() => automation().setMode('owner', p.id, params.code, b.mode));
  });

  api.post('/automation/codes/:code/resume', async (req) => {
    const params = parseInput(z.object({ code: codeSchema }), req.params);
    const b = parseInput(z.object({ project: projectParam, confirm: z.literal(true) }).strict(), req.body);
    requireReauth(ctx.deps.services, req);
    const p = projectFor(ctx, req, b.project);
    return wrap(() => {
      automation().resume('owner', p.id, params.code);
      return { resumed: true };
    });
  });

  // "Pause all automation": a brake, one click (ADR 0062's rule). Resuming releases it: the step-up.
  api.post('/automation/pause', async (req) => {
    parseInput(z.object({ confirm: z.literal(true) }).strict(), req.body);
    return wrap(() => {
      automation().setGlobalPause('owner', true);
      return automation().store.global();
    });
  });

  api.post('/automation/resume', async (req) => {
    parseInput(z.object({ confirm: z.literal(true) }).strict(), req.body);
    requireReauth(ctx.deps.services, req);
    return wrap(() => {
      automation().setGlobalPause('owner', false);
      return automation().store.global();
    });
  });

  api.post('/automation/run', async (req) => {
    const b = parseInput(
      z.object({ project: projectParam, confirm: z.literal(true), wait: z.boolean().optional() }).strict(),
      req.body,
    );
    requireReauth(ctx.deps.services, req);
    const p = projectFor(ctx, req, b.project);
    const a = automation();
    ctx.deps.runtime.policy.store.audit('owner', 'automation.run_now', p.id, null, { project: p.id });
    const running = a.run(p.id, 'manual');
    if (b.wait === true) {
      const run = await running;
      return { started: true, run, items: a.store.items(run.id) };
    }
    running.catch(() => undefined);
    return { started: true };
  });

  api.get('/automation/runs/:id', (req) => {
    const params = parseInput(z.object({ id: z.string().regex(/^aut_[0-9a-f]{16}$/) }), req.params);
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = ctx.project(q.project);
    const a = automation();
    const run = a.store.run(params.id);
    if (!run || run.projectId !== p.id)
      throw new AdminHttpError(404, 'NOT_FOUND', `No automation run ${params.id}.`);
    return { run, items: a.store.items(run.id) };
  });

  api.get('/automation/overnight', (req) => {
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = ctx.project(q.project);
    return automation().overnight(p.id, ctx.now() - DAY);
  });
};

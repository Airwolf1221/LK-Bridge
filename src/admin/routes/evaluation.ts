/**
 * The Evaluation helper's API (v2 E3, ADR 0045; docs/dashboard.md, Tool calls › Evaluation). Owner only: it sits behind the
 * admin guard like every other route, so state-changing requests need the owner's session, the dashboard's Origin and the
 * CSRF token, and a bearer token (OAuth or personal access) does nothing here. No agent tool reads or names it.
 *
 * - `GET /evaluation/scenarios`: the scripted scenarios (docs/reviews/scenarios.json) and the preamble.
 * - `GET /evaluation/connections` (`assistant`): the connections the classifier can tell apart, for the connection selector.
 * - `GET /evaluation/runs`, `POST /evaluation/runs` (`{ assistant, set, principalIds? }`), `GET /evaluation/runs/:id`,
 *   `POST /evaluation/runs/:id/delete` (`{ confirm: true }`, audited), `POST /evaluation/runs/:id/finish`.
 * - `POST /evaluation/runs/:id/scenarios/:scenario/start` (`{ principalIds? }`), `…/done`, `…/reset`, and
 *   `PUT …/grade` (`{ grade: right|partly|wrong|null, note? }`): the owner's confirmation, never set automatically.
 * - `GET /evaluation/runs/:id/table`: the results as Markdown, in the format of the owner's table.
 * - `GET /evaluation/compare` (`a` the earlier run, `b` the later).
 */
import * as z from 'zod';
import { ASSISTANTS, SCENARIO_SETS } from '../../evaluation/scenarios.js';
import { EvaluationError, OWNER_GRADES, type Evaluation, type RunView } from '../../evaluation/service.js';
import { AdminHttpError } from '../http.js';
import { confirmBody, idSchema, parseInput, type Register } from './util.js';

const STATUS: Readonly<Record<string, number>> = {
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  UNKNOWN_CONNECTION: 400,
  RECORDING_OFF: 409,
  NO_CONNECTION: 409,
  RUN_FINISHED: 409,
  ALREADY_RECORDING: 409,
  WRONG_STATE: 409,
};

const principalIds = z.array(idSchema).max(20).optional();
const runParams = z.object({ id: idSchema });
const scenarioParams = z.object({ id: idSchema, scenario: z.coerce.number().int().min(1).max(999) });

export const registerEvaluation: Register = (api, ctx) => {
  const evaluation = (): Evaluation => {
    const e = ctx.deps.runtime.evaluation;
    if (!e) throw new AdminHttpError(503, 'EVALUATION_UNAVAILABLE', 'The evaluation helper is not running.');
    return e;
  };
  const wrap = <T>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      if (e instanceof EvaluationError) throw new AdminHttpError(STATUS[e.code] ?? 400, e.code, e.message);
      if (e instanceof Error && /scenarios\.json/.test(e.message))
        throw new AdminHttpError(503, 'SCENARIOS_UNAVAILABLE', e.message);
      throw e;
    }
  };
  /** A run with the names of the connections it mentions (named as the journal names them). */
  const runBody = (run: RunView) => ({
    run,
    principals: ctx.principals([...(run.principalIds ?? []), ...run.results.flatMap((r) => r.principalIds)]),
  });

  api.get('/evaluation/scenarios', () => wrap(() => evaluation().scenarios()));

  api.get('/evaluation/connections', (req) => {
    const q = parseInput(z.object({ assistant: z.enum(ASSISTANTS).optional() }), req.query);
    const e = evaluation();
    return wrap(() => {
      const connections = e.connections();
      return {
        connections,
        recognised: q.assistant
          ? connections.filter((c) => c.active && c.assistant === q.assistant).map((c) => c.id)
          : [],
      };
    });
  });

  api.get('/evaluation/runs', () => wrap(() => evaluation().listRuns()));

  api.post('/evaluation/runs', (req) => {
    const b = parseInput(
      z.object({ assistant: z.enum(ASSISTANTS), set: z.enum(SCENARIO_SETS), principalIds }),
      req.body,
    );
    return wrap(() =>
      runBody(
        evaluation().createRun({
          assistant: b.assistant,
          set: b.set,
          ...(b.principalIds ? { principalIds: b.principalIds } : {}),
        }),
      ),
    );
  });

  api.get('/evaluation/runs/:id', (req) => {
    const p = parseInput(runParams, req.params);
    return wrap(() => runBody(evaluation().getRun(p.id)));
  });

  api.post('/evaluation/runs/:id/finish', (req) => {
    const p = parseInput(runParams, req.params);
    return wrap(() => runBody(evaluation().finishRun(p.id)));
  });

  api.post('/evaluation/runs/:id/delete', (req) => {
    const p = parseInput(runParams, req.params);
    parseInput(confirmBody, req.body);
    wrap(() => evaluation().deleteRun(p.id));
    return { deleted: p.id };
  });

  api.post('/evaluation/runs/:id/scenarios/:scenario/start', (req) => {
    const p = parseInput(scenarioParams, req.params);
    const b = parseInput(z.object({ principalIds }), req.body);
    return wrap(() => runBody(evaluation().startScenario(p.id, p.scenario, b.principalIds)));
  });

  api.post('/evaluation/runs/:id/scenarios/:scenario/done', (req) => {
    const p = parseInput(scenarioParams, req.params);
    return wrap(() => runBody(evaluation().doneScenario(p.id, p.scenario)));
  });

  api.post('/evaluation/runs/:id/scenarios/:scenario/reset', (req) => {
    const p = parseInput(scenarioParams, req.params);
    return wrap(() => runBody(evaluation().resetScenario(p.id, p.scenario)));
  });

  api.put('/evaluation/runs/:id/scenarios/:scenario/grade', (req) => {
    const p = parseInput(scenarioParams, req.params);
    const b = parseInput(
      z.object({ grade: z.enum(OWNER_GRADES).nullable(), note: z.string().max(2000).optional() }),
      req.body,
    );
    return wrap(() =>
      runBody(
        evaluation().grade(p.id, p.scenario, {
          grade: b.grade,
          ...(b.note !== undefined ? { note: b.note } : {}),
        }),
      ),
    );
  });

  api.get('/evaluation/runs/:id/table', (req) => {
    const p = parseInput(runParams, req.params);
    return wrap(() => ({ markdown: evaluation().table(p.id) }));
  });

  api.get('/evaluation/compare', (req) => {
    const q = parseInput(z.object({ a: idSchema, b: idSchema }), req.query);
    return wrap(() => ({ comparison: evaluation().compare(q.a, q.b) }));
  });
};

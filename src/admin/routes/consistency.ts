/**
 * v3 F4b (ADR 0064, design D6): the dashboard's "Pick the right value" on a consistency finding (the Audits page).
 *
 * - `GET /api/admin/audits/findings/:id/consistency`: the finding's values side by side (the identity page's, then
 *   each restatement's, with page, lifecycle, section, excerpt and precision), the agents' suggestions and the owner's
 *   earlier picks. Reads the bridge's own data only.
 * - `POST /api/admin/audits/findings/:id/consistency-pick` `{ side? (with shown?) | value?, confirm: true }`: the owner
 *   picks one side's value or types one; the bridge builds ONE proposal editing every page that disagrees
 *   (src/consistency/fix.ts). A step-up action (ADR 0062, as a pack-level decision): the authenticator code within ten
 *   minutes. Audited `consistency.pick`. Agents can never pick: they suggest (`arkona_consistency_suggest`).
 *   CR-2026-11-R4 (PK-51): a side is one of the values the dashboard showed (the audit's stored values,
 *   `SIDE_NOT_FOUND` otherwise), `shown` is its value as shown (the dashboard sends it; the stored value when absent),
 *   and the pick is refused with `SIDE_CHANGED` when the side reads otherwise now: the bridge proposes only a value the
 *   owner saw.
 */
import * as z from 'zod';
import { AuditError, type Audits } from '../../audits/index.js';
import { ConsistencyError } from '../../consistency/service.js';
import { PickError } from '../../consistency/fix.js';
import { requireReauth } from '../guard.js';
import { AdminHttpError } from '../http.js';
import { parseInput, projectParam, type Register, projectFor } from './util.js';

const STATUS: Readonly<Record<string, number>> = {
  NOT_FOUND: 404,
  FINDING_GONE: 409,
  SIDE_NOT_FOUND: 400,
  SIDE_CHANGED: 409,
  INVALID_PARAMS: 400,
  VALUE_UNREADABLE: 400,
  NOTHING_TO_PROPOSE: 409,
  NOT_PROPOSED: 502,
  NO_CALENDAR: 409,
  NO_SNAPSHOT: 409,
  CONSISTENCY_NOT_CONFIGURED: 409,
  PACK_NOT_ATTACHED: 409,
  PICK_UNAVAILABLE: 503,
};

const idParam = z.object({ id: z.coerce.number().int().min(1) });

export const registerConsistency: Register = (api, ctx) => {
  const audits = (): Audits => {
    const a = ctx.deps.runtime.audits;
    if (!a) throw new AdminHttpError(503, 'AUDITS_UNAVAILABLE', 'The audits are not running.');
    return a;
  };
  const service = () => {
    const c = ctx.deps.runtime.consistency;
    if (!c) throw new AdminHttpError(503, 'CONSISTENCY_UNAVAILABLE', 'The consistency check is not running.');
    return c;
  };
  const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ConsistencyError || e instanceof PickError || e instanceof AuditError)
        throw new AdminHttpError(STATUS[e.code] ?? 409, e.code, e.message, { details: e.details });
      throw e;
    }
  };
  /** The audit finding, which must be a consistency finding. */
  const finding = (projectId: string, id: number) => {
    const f = audits().store.get(projectId, id);
    if (!f) throw new AdminHttpError(404, 'NOT_FOUND', `No finding ${id}.`);
    if (f.category !== 'consistency' || typeof f.evidence.consistencyId !== 'string')
      throw new AdminHttpError(
        409,
        'NOT_A_CONSISTENCY_FINDING',
        'Only a consistency finding has values to pick from.',
      );
    return f;
  };

  api.get('/audits/findings/:id/consistency', (req) => {
    const { id } = parseInput(idParam, req.params);
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = ctx.project(q.project);
    const f = finding(p.id, id);
    const cid = f.evidence.consistencyId as string;
    return {
      finding: { id: f.id, code: f.code, state: f.state, message: f.message, consistencyId: cid },
      subject: f.evidence.subject ?? null,
      what: f.evidence.what ?? null,
      continuity: f.evidence.continuity ?? null,
      values: [f.evidence.reference, ...((f.evidence.restatements as unknown[] | undefined) ?? [])],
      suggestions: service().suggestions(p.id, cid),
      picks: service().picks(p.id, cid),
      rule: 'The check never decides which value is right: pick one (or type the right one), and the bridge proposes edits to every page that disagrees. Nothing is written until you approve the proposal.',
    };
  });

  api.post('/audits/findings/:id/consistency-pick', async (req) => {
    const { id } = parseInput(idParam, req.params);
    const b = parseInput(
      z
        .object({
          confirm: z.literal(true),
          side: z.string().min(1).max(500).optional(),
          /** CR-2026-11-R4: the side's value as the dashboard showed it. */
          shown: z.string().max(2000).optional(),
          value: z.string().trim().min(1).max(300).optional(),
          project: projectParam,
        })
        .refine((x) => (x.side === undefined) !== (x.value === undefined), {
          message: 'Give either side (a value of the finding) or value (one you type), not both.',
        })
        .refine((x) => x.shown === undefined || x.side !== undefined, {
          message: 'shown goes with side: the value of the side as it was shown.',
        }),
      req.body,
    );
    // ADR 0062: a pack-level decision (the owner's pick of canon), so the step-up is required.
    requireReauth(ctx.deps.services, req);
    const p = projectFor(ctx, req, b.project);
    const f = finding(p.id, id);
    if (f.state !== 'open')
      throw new AdminHttpError(409, 'FINDING_GONE', 'This finding is no longer present.');
    // CR-2026-11-R4 (PK-51): the side as the dashboard showed it (the audit's stored values): a side of another finding,
    // or anything else, is not one of these; the value shown goes to the service, which refuses a side that reads
    // otherwise now.
    let shown: string | undefined;
    if (b.side !== undefined) {
      const stored = [f.evidence.reference, ...((f.evidence.restatements as unknown[] | undefined) ?? [])];
      const seen = stored.find(
        (v): v is { key: string; value?: unknown } =>
          typeof v === 'object' && v !== null && (v as { key?: unknown }).key === b.side,
      );
      if (!seen) throw new AdminHttpError(400, 'SIDE_NOT_FOUND', 'That value is not one of this finding’s.');
      const value = typeof seen.value === 'string' ? seen.value : '';
      const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
      if (b.shown !== undefined && tidy(b.shown) !== tidy(value))
        throw new AdminHttpError(
          409,
          'SIDE_CHANGED',
          `The finding has changed since the page showed it (“${b.shown}” was shown; it holds “${value}” now). Nothing was proposed: reload the finding and pick again.`,
        );
      shown = value;
    }
    return wrap(() =>
      service().pick({
        projectId: p.id,
        identityPageId: f.pageId!,
        continuity: typeof f.evidence.continuity === 'string' ? f.evidence.continuity : 'Main CANON',
        findingId: f.evidence.consistencyId as string,
        ...(b.side !== undefined ? { side: b.side } : {}),
        ...(shown !== undefined ? { shown } : {}),
        ...(b.value !== undefined ? { value: b.value } : {}),
        actor: 'owner',
        auditFindingId: f.id,
      }),
    );
  });
};

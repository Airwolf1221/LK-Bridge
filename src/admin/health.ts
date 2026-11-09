/**
 * "Is LegendKeeper reachable, is the key's role right, is the plan paid?" for the Overview page. Two cached reads at
 * the dashboard's own priority (P0), at most once a minute however many dashboards are open.
 */
import type { JobEngine } from '../jobs/index.js';

export interface Health {
  readonly checkedAt: number;
  readonly reachable: boolean | null;
  readonly projectName: string | null;
  readonly keyRole: 'ADMIN' | 'MEMBER' | 'unknown';
  /** `ok`, `unpaid` (402 PAID_PLAN_REQUIRED) or `unknown`. */
  readonly plan: 'ok' | 'unpaid' | 'unknown';
  readonly note: string | null;
}

const TTL_MS = 60_000;

/** One cached check per project (v2 A1: each project has its own key, so its own answer). */
export function createHealthCheck(engine: JobEngine, now: () => number) {
  const cache = new Map<string, Health>();
  const inFlight = new Map<string, Promise<Health>>();
  const origin = { kind: 'ui', tool: 'overview' } as const;

  const probe = async (project: string): Promise<Health> => {
    let reachable: boolean | null = null;
    let projectName: string | null = null;
    let keyRole: Health['keyRole'] = 'unknown';
    let plan: Health['plan'] = 'unknown';
    let note: string | null = null;
    try {
      const p = await engine.run('getProject', {}, { origin, priority: 'P0', project });
      reachable = true;
      plan = 'ok';
      if (p.status === 'succeeded')
        projectName = ((p.result as { name?: unknown })?.name as string | undefined) ?? null;
      try {
        const m = await engine.run('listMembers', {}, { origin, priority: 'P0', project });
        if (m.status === 'succeeded') {
          // LegendKeeper shows member emails to ADMIN keys only: the cheapest honest probe of the key's role.
          const members = ((m.result as { data?: { email?: unknown }[] })?.data ?? []) as {
            email?: unknown;
          }[];
          if (members.some((x) => typeof x.email === 'string')) keyRole = 'ADMIN';
          else if (members.length > 0) keyRole = 'MEMBER';
        }
      } catch (e) {
        const code = (e as { code?: string }).code;
        note = `The key’s role could not be checked${code ? ` (${code})` : ''}.`;
      }
    } catch (e) {
      const lk = (e as { lk?: { code?: string; status?: number } }).lk;
      const code = (e as { code?: string }).code;
      if (code === 'PROJECT_UNAVAILABLE' || code === 'UNKNOWN_PROJECT') {
        note = (e as Error).message;
      } else if (lk?.code === 'PAID_PLAN_REQUIRED' || lk?.status === 402) {
        reachable = true;
        plan = 'unpaid';
        note = 'LegendKeeper says the project owner needs a paid plan.';
      } else if (lk?.status === 401 || lk?.status === 403) {
        reachable = true;
        note = 'LegendKeeper refused the key.';
      } else if (code === 'BUDGET_EXHAUSTED' || lk?.code === 'BUDGET_WAIT') {
        note = 'The health check is waiting for request budget.';
      } else if (typeof lk?.status === 'number') {
        // Any HTTP answer means LegendKeeper is there.
        reachable = true;
        note = `LegendKeeper answered the health check with an error (${lk.status}).`;
      } else {
        reachable = false;
        note = 'LegendKeeper could not be reached.';
      }
    }
    const h: Health = { checkedAt: now(), reachable, projectName, keyRole, plan, note };
    cache.set(project, h);
    return h;
  };

  return async (project: string, refresh = false): Promise<Health> => {
    const cached = cache.get(project);
    if (!refresh && cached && now() - cached.checkedAt < TTL_MS) return cached;
    let p = inFlight.get(project);
    if (!p) {
      p = probe(project).finally(() => inFlight.delete(project));
      inFlight.set(project, p);
    }
    return p;
  };
}

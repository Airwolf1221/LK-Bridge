/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON replies */
/**
 * The 25 November 2026 freeze, step 5 (ADR 0061 amendment 2): a guard for the next one. Every admin GET the dashboard
 * can call, timed at Arkona's scale (`world.ts`: 1,500 pages, a full snapshot with its audit, 300 change snapshots),
 * with the event loop's longest delay during each. Each answers within 500 ms and never holds the loop for 500 ms.
 *
 * The routes come from the source (every `api.get('…')` of src/admin), so a new one is timed without anyone adding it
 * here; one whose path needs an id is called with an id of this world, or listed as per-item (its work is one item's).
 * `ADMIN_GETS_SAMPLES=<file>` writes the measurements (the report's table).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measure, snapScaleWorld, type Sample, type SnapScaleWorld } from './world.js';

let s: SnapScaleWorld;
const PAGES = Number(process.env.SCALE_PAGES ?? 1500);
const ROUTE_MS = 500;

beforeAll(async () => {
  s = await snapScaleWorld({ pages: PAGES, changes: Number(process.env.SCALE_CHANGES ?? 300) });
}, 900_000);
afterAll(async () => s?.close());

/** Every admin GET path, from the source. */
function adminGets(): string[] {
  const out = new Set<string>();
  for (const dir of ['src/admin/routes', 'src/admin'])
    for (const f of readdirSync(dir))
      if (f.endsWith('.ts'))
        for (const m of readFileSync(join(dir, f), 'utf8').matchAll(
          /api\.get(?:<[^>]*>)?\(\s*['"`]([^'"`]+)/g,
        ))
          out.add(m[1]!);
  return [...out].sort();
}

describe('every admin GET at Arkona’s scale', () => {
  it('answers within 500 ms and never holds the loop for 500 ms', async () => {
    const http = s.http;
    const page = s.pageIds[7]!;
    const finding = (await http.get('/audits/findings?limit=1')).json.findings?.[0]?.id ?? null;
    const job = (await http.get('/jobs?limit=1')).json.jobs?.[0]?.id ?? null;
    const snap = s.fullId;
    const fill: Record<string, string | null> = {
      '/maintenance/:id': '/maintenance/snapshot-full',
      '/packs/:id/governance': '/packs/arkona/governance',
      '/projects/:name/canon': '/projects/test/canon',
      '/projects/:name/chronology': '/projects/test/chronology',
      '/projects/:name/lifecycle': '/projects/test/lifecycle',
      '/snapshots/pages/:pageId': `/snapshots/pages/${page}?limit=50`,
      '/audits/findings/:id': finding ? `/audits/findings/${finding}` : null,
      '/audits/findings/:id/consistency': finding ? `/audits/findings/${finding}/consistency` : null,
      '/jobs/:id': job ? `/jobs/${job}` : null,
      '/tree/children': `/tree/children?id=sclroot1`,
      '/snapshots/diff': `/snapshots/diff?page=${page}&from=${snap}&piece=sidebar`,
      '/snapshots/pages': '/snapshots/pages?limit=50',
      '${SWEEP}/card': '/maintenance/assign-block-ids-sweep/card',
    };
    const samples: (Sample & { path: string; route: string })[] = [];
    const perItem: string[] = [];
    for (const route of adminGets()) {
      if (route === '/stream') continue; // the live stream: it never ends by design
      const path = route in fill ? fill[route] : route.includes(':') || route.includes('$') ? null : route;
      if (!path) {
        perItem.push(route);
        continue;
      }
      const x = await measure(route, () => http.get(path));
      samples.push({ ...x, path, route });
    }
    if (process.env.ADMIN_GETS_SAMPLES)
      writeFileSync(
        process.env.ADMIN_GETS_SAMPLES,
        JSON.stringify(
          {
            samples: samples
              .map(({ route, path, status, ms, lagMaxMs, heapMb }) => ({
                route,
                path,
                status,
                ms,
                lagMaxMs,
                heapMb,
              }))
              .sort((a, b) => b.ms - a.ms),
            perItem,
          },
          null,
          1,
        ),
      );
    expect(samples.length).toBeGreaterThan(60);
    for (const x of samples) {
      expect(x.ms, `${x.path} took ${x.ms} ms`).toBeLessThan(ROUTE_MS);
      expect(x.lagMaxMs, `${x.path} held the loop ${x.lagMaxMs} ms`).toBeLessThan(ROUTE_MS);
    }
  }, 900_000);
});

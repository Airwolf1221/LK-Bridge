/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * CR-2026-11, finding CR-07: a write whose answer was lost (LegendKeeper failed after the request left, and the read
 * that should have told whether it applied failed too) is `uncertain`: it may have been written. The tools' answers
 * reported it as not written ("Nothing was written", "Not written: …"), so an agent could repeat a change that had in
 * fact been made, or tell the owner nothing changed when it had.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { factsWorld, P, type FactsWorld } from './world.js';

let w: FactsWorld;
beforeAll(async () => {
  w = await factsWorld();
});
afterAll(async () => w.close());

/** Puts an override in front of the sidebar model (overrides are asked in insertion order). */
function first(re: RegExp, fn: (req: MockRequest) => MockResponse | undefined): void {
  const rest = [...w.overrides.entries()];
  w.overrides.clear();
  w.overrides.set(re, fn);
  for (const [k, v] of rest) w.overrides.set(k, v);
}

it('set_facts: a row write whose outcome is unknown is reported as such, never as "nothing was written"', async () => {
  const c = await w.stack.connect();
  let failing = false;
  // The row write reaches LegendKeeper and applies, but every answer is lost; so is every read that would tell.
  first(/\/resources\/mehran01\/properties\/kvmehr01\/rows/, (req) => {
    if (req.method === 'PATCH') {
      w.sidebars.respond(req, (id) => (w.repo.live(id) ? w.repo.resourceView(w.repo.live(id)!) : undefined));
      failing = true;
      return { status: 503, body: { message: 'unavailable', code: 'UNAVAILABLE', requestId: 'cr07' } };
    }
    if (failing)
      return { status: 503, body: { message: 'unavailable', code: 'UNAVAILABLE', requestId: 'cr07r' } };
    return undefined;
  });
  const r = await w.stack.call(c, 'set_facts', {
    project: 'test',
    page: 'Mehrana al-Khalid',
    facts: { Scope: 'Qishen scholar of the Hollow Court' },
  });
  expect(r.isError).toBe(true);
  // It was in fact written.
  expect(w.sidebars.rows(P.mehrana).find((x) => x.key === 'Scope')?.text).toBe(
    'Qishen scholar of the Hollow Court',
  );
  expect(r.text).not.toMatch(/Nothing was written/);
  expect(r.body.error.code).toBe('OUTCOME_UNKNOWN');
  expect(r.body.error.uncertain).toEqual(['Scope: changed']);
}, 60_000);

it('update_resource: a write whose outcome is unknown is listed as uncertain, never under "not written"', async () => {
  const c = await w.stack.connect();
  let failing = false;
  first(/\/resources\/kumi0001\/?$/, (req) => {
    if (req.method === 'PATCH') {
      w.repo.respond(req); // it reaches LegendKeeper and applies
      failing = true;
      return { status: 503, body: { message: 'unavailable', code: 'UNAVAILABLE', requestId: 'cr07u' } };
    }
    if (failing)
      return { status: 503, body: { message: 'unavailable', code: 'UNAVAILABLE', requestId: 'cr07g' } };
    return undefined;
  });
  const r = await w.stack.call(c, 'update_resource', {
    project: 'test',
    page: 'Kumi the Elder',
    tags: { add: ['cr07-added'] },
  });
  expect(r.isError, r.text).toBe(true);
  expect(w.repo.res.get('kumi0001')!.tags).toContain('cr07-added');
  expect(r.body.error.code).toBe('OUTCOME_UNKNOWN');
  expect(r.body.error.uncertain).toHaveLength(1);
  expect(r.body.error.notWritten ?? []).toEqual([]);
  expect(r.text).not.toMatch(/Nothing was written/);
}, 60_000);

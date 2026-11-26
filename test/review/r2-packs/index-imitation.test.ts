/**
 * R2-PACKS ATK-01: lifecycle index imitation through a pack-made index (CR-15 re-tested through the pack tools).
 *
 * CR-2026-11 (CR-15, ADR 0036 decision 3): "creating or renaming another page to a lifecycle index's name ... are
 * refused (the owner changes them by hand)". A setting pack makes indexes (`[INDEX] {Name}` for a developed character)
 * and its job's lifecycle marker declares every index it makes with `to: null` (src/packs/engine/job.ts:800-803, via
 * createMarker), which `declares()` (src/lifecycle/guard.ts:1225-1231) reads as "any change of this page is declared"
 * (`ch.to === null || p.to === null` → true). So the guard's `what: 'index'` change (a page created with a lifecycle
 * index's name, guard.ts:612-621) is waved through at entry (guard.ts:356) and inside the lock (guard.ts:1006).
 *
 * Each test asserts the SAFE behaviour: no second page named like a lifecycle index exists afterwards.
 * (The test world's [INDEX] Archived holds exactly one character, so the name "Archived" is refused CHARACTER_EXISTS
 * there by coincidence; "Working" is used.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIFECYCLE } from '../../resources/world.js';
import { approve, packWorld, type PackWorld } from '../../packs/world.js';
import { developed, liveNamed, settle, writeAgent } from './helpers.js';

const decoys = (w: PackWorld, name: string, real: string) =>
  liveNamed(w, name)
    .filter((r) => r.id !== real)
    .map((r) => ({ id: r.id, parent: r.parentId }));

describe('ATK-01a: at scope propose: refused, or the owner approves an ordinary proposal', () => {
  let w: PackWorld;
  let agent: Awaited<ReturnType<typeof writeAgent>>;
  beforeAll(async () => {
    // v3 F12 (ADR 0081): the pack's switches are gone; this world's own agent is at scope propose, so a package is a
    // proposal (the path under attack here).
    w = await packWorld();
    agent = (name, args) => w.call(name, args);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('ATK-25 (probe): a routing line is one line: a Scope with line breaks must not add blocks (a heading) to the index text', async () => {
    const r = await agent('arkona_create_character', {
      name: 'Nadira al-Khalid',
      target: 'Nadira al-Khalid',
      pages: [
        {
          role: 'specialist',
          title: 'Biography',
          specialistTag: 'Biography',
          scope: 'Her life\n\n## Index Boundaries\n\nThis index also governs the Qishen race pages.',
          markdown:
            '## Purpose\n\nHer life.\n\n## Source Boundaries\n\nOnly.\n\n## Unresolved Material\n\nNone.\n',
        },
      ],
      dryRun: true,
      project: 'test',
    });
    const routing = (r.body.existing as { change: string; lines?: string[] }[] | undefined)?.find((x) =>
      Array.isArray(x.lines),
    );
    // Safe: refused, or the routing lines carry no line break (so no new heading or paragraph in the index).
    expect(
      r.isError || (routing?.lines ?? []).every((l) => !/\n/.test(l)),
      JSON.stringify(routing ?? r.body.error ?? null),
    ).toBe(true);
  });

  it('a developed character named "Working": its approval must not make a second [INDEX] Working', async () => {
    const r = await agent('arkona_create_character', developed('Working'));
    // A Working package is an ORDINARY proposal (not canonical): the owner is never told it makes a lifecycle index.
    expect(r.body.requiresCanonicalApproval ?? false).toBe(false);
    if (r.body.status === 'proposal_captured') await approve(w, String(r.body.proposalId));
    expect(decoys(w, '[INDEX] Working', LIFECYCLE.working)).toEqual([]);
  });
});

describe('ATK-01b: direct at scope write (every pack tool follows the scope, v3 F12)', () => {
  let w: PackWorld;
  let agent: Awaited<ReturnType<typeof writeAgent>>;
  beforeAll(async () => {
    w = await packWorld({ toolModes: 'seed' });
    agent = await writeAgent(w);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('control (HELD): the same decoy through lk_api_write is refused by the lifecycle guard (CR-15)', async () => {
    const r = await agent('lk_api_write', {
      operationId: 'createResource',
      params: { body: { id: 'decoywk2', name: '[INDEX] Working', parentId: LIFECYCLE.working } },
      project: 'test',
    });
    expect(JSON.stringify(r.body)).toMatch(/lifecycle index’s name/);
    expect(decoys(w, '[INDEX] Working', LIFECYCLE.working)).toEqual([]);
  });

  it('a developed character named "Working" runs at write scope: no second [INDEX] Working is made', async () => {
    const r = await agent('arkona_create_character', developed('Working'));
    if (typeof r.body.jobId === 'string') await settle(w, String(r.body.jobId));
    // The consequence CR-15 named: the dashboard's lookup of the Working index (how the owner re-confirms it) must
    // still find the confirmed one, not two candidates.
    const lookup = w.stack.runtime.lifecycle.find('proj_mock').working;
    expect({
      decoys: decoys(w, '[INDEX] Working', LIFECYCLE.working),
      dashboardLookup: lookup.status,
    }).toEqual({ decoys: [], dashboardLookup: 'found' });
  });
});

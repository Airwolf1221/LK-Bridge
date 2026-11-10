/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * Failure and resume (v2 C2c, ADR 0035, the shared rules): a fault injected at each write of a lifecycle change leaves
 * the record incomplete, the result saying which steps ran, and no misleading page (never [BSRC] while reading
 * Archived or sitting in the archive, never reading Authoritative in the archive as [BARC]); calling the same tool again
 * resumes: it re-plans from the page as it is now and the record, does only what is left (re-checking everything), and
 * completes the same record. Nothing is replayed.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoDate } from '../../src/lifecycle/index.js';
import { PROJECT } from '../tools/helpers.js';
import { facts, SidebarModel } from '../resources/world.js';
import { accept, LIFECYCLE, lifecycleWorld, textOf, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const today = isoDate(Date.now());
const LIMITS = {
  'key-min': 5000,
  'write-min': 2000,
  'key-hour': 60000,
  'write-hour': 30000,
  'project-hour': 60000,
};

const PAGES = ['rsma0001', 'rsmb0001', 'rsmc0001', 'rsmd0001', 'rsme0001', 'rsmf0001'];

beforeAll(async () => {
  w = await lifecycleWorld({
    env: { LK_TIER_LIMITS: JSON.stringify(LIMITS) },
    limits: LIMITS as never,
    seed: (world) => {
      PAGES.forEach((id, i) =>
        world.repo.seed({
          id,
          name: `[BSRC] Resume Page ${'ABCDEF'[i]}`,
          parentId: 'locs0001',
          referenceType: 'General Source',
          tags: ['CANON'],
        }),
      );
    },
  });
  for (const id of PAGES) {
    w.sidebars.page(id, [
      SidebarModel.kv(`kv${id.slice(0, 6)}`, 'PROPERTIES', [
        ['Reference Type', 'General Source'],
        ['Status', 'Authoritative'],
        ['Continuity Type', 'CANON'],
        ['Scope', `Scope of ${id}`],
        ['Temporal Scope', 'Fourth Age'],
        ['Last Major Revision', '2026-10-01'],
      ]),
    ]);
    w.repo.blocks.set(w.main(id), {
      version: 2,
      blocks: [{ id: `${id}b1`, kind: 'paragraph', content: [{ text: 'Body.' }] }],
    });
  }
  client = await w.stack.connect();
});
afterAll(async () => w.close());

/** Fails the first request matching, once, as LegendKeeper's 500 (never retried). */
function failOnce(method: string, path: RegExp): void {
  let done = false;
  // First in line: the world's own models answer the same paths.
  const before = [...w.overrides];
  w.overrides.clear();
  w.overrides.set(path, (req) => {
    if (done || req.method !== method) return undefined;
    done = true;
    return { status: 500, body: { code: 'INTERNAL', message: 'injected fault', requestId: 'fault-1' } };
  });
  for (const [k, v] of before) w.overrides.set(k, v);
}

/** Why a page would mislead, or null: its prefix, its place and its Status must not contradict each other. */
function misleading(id: string): string | null {
  const r = w.repo.live(id)!;
  const status =
    facts(w, id)
      .find((f) => f.startsWith('Status='))
      ?.slice(7) ?? '';
  const inArchive = r.parentId === LIFECYCLE.archived;
  if (r.name.startsWith('[BSRC] ') && status === 'Archived') return 'reads Archived as [BSRC]';
  if (r.name.startsWith('[BSRC] ') && inArchive) return 'sits in the archive as [BSRC]';
  if (r.name.startsWith('[BARC] ') && inArchive && status === 'Authoritative')
    return 'reads Authoritative in the archive';
  const note = textOf(w.blocks(w.main(id))[0]).startsWith('Archived - ');
  if (note && r.name.startsWith('[BSRC] ')) return 'carries the archive note as [BSRC]';
  return null;
}

// Each fault, and how many writes are left for the resume: the rename and tags, 5 facts, the note, the move.
const FAULTS: [string, string, (id: string) => RegExp, number][] = [
  ['the rename and tags', 'PATCH', (id) => new RegExp(`/resources/${id}$`), 8],
  ['the first fact', 'PATCH', (id) => new RegExp(`/resources/${id}/properties/[^/]+/rows/[^/]+$`), 7],
  ['the note', 'POST', (id) => new RegExp(`/resources/${id}/docs/[^/]+/blocks$`), 2],
  ['the move', 'POST', (id) => new RegExp(`/resources/${id}/move$`), 1],
];

describe('archive_page: a fault at each write, then a resume', () => {
  FAULTS.forEach(([what, method, path, left], i) => {
    it(`a fault at ${what}: incomplete, not misleading; the second call finishes only what is left`, async () => {
      const id = PAGES[i]!;
      failOnce(method, path(id));
      const first = await accept(w, await call('archive_page', { page: id }));
      expect(first.body.status, first.text).not.toBe('written');
      w.overrides.delete(path(id));
      const rec = w.stack.runtime.lifecycle.store.latest(PROJECT, id, ['archive'])!;
      expect(rec).toMatchObject({ state: 'incomplete', action: 'archive' });
      expect(misleading(id)).toBeNull();
      // The job says which steps ran (the failed one and those after it did not).
      const job = w.stack.runtime.engine.queries.getJob(PROJECT, rec.jobId!)!;
      expect(job.status).toBe('failed');
      const writesBefore = w.seen.filter((l) => !l.startsWith('GET')).length;
      // The second call resumes the same record, re-planning from the page as it is now.
      const again = await call('archive_page', { page: id });
      expect(again.body, again.text).toMatchObject({
        status: 'proposal_captured',
        requiresCanonicalApproval: true,
        resumes: { recordId: rec.id },
      });
      const done = await accept(w, again);
      expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
      const after = w.stack.runtime.lifecycle.store.record(PROJECT, rec.id)!;
      expect(after.state).toBe('complete');
      expect(after.jobs).toHaveLength(2);
      // Exactly as an archiving in one go; the note once.
      const p = w.repo.live(id)!;
      expect(p).toMatchObject({ name: `[BARC] Resume Page ${'ABCDEF'[i]}`, parentId: LIFECYCLE.archived });
      expect(p.tags).toEqual(['Archived']);
      expect(facts(w, id)).toEqual([
        'Reference Type=General Source',
        'Status=Archived',
        'Continuity Type=NON-CURRENT',
        `Scope=Archived record of the retired Scope of ${id}`,
        `Temporal Scope=Former Main CANON. Retired on ${today}.`,
        `Last Major Revision=${today}`,
      ]);
      const blocks = w.blocks(w.main(id));
      expect(blocks.filter((b) => textOf(b).startsWith('Archived - '))).toHaveLength(1);
      expect(blocks.at(-1)!.id).toBe(`${id}b1`);
      // Nothing written twice: the resume sent exactly the writes that were left.
      const resumeWrites = w.seen.filter((l) => !l.startsWith('GET')).length - writesBefore;
      expect(resumeWrites).toBe(left);
    });
  });
});

describe('promote_page: a fault at its last write (the rename), then a resume', () => {
  it('the page sits in its destination as [BWRK] until the resume renames it', async () => {
    const id = PAGES[5]!;
    const mtw = await accept(w, await call('move_to_working', { page: id }));
    expect(mtw.body, mtw.text).toMatchObject({ status: 'written', verified: true });
    failOnce('PATCH', new RegExp(`/resources/${id}$`));
    const first = await accept(w, await call('promote_page', { page: id, destination: 'locs0001' }));
    expect(first.body.status).not.toBe('written');
    w.overrides.delete(new RegExp(`/resources/${id}$`));
    // Moved, facts written, still [BWRK]: never [BSRC] before its facts say Authoritative.
    expect(w.repo.live(id)).toMatchObject({ name: '[BWRK] Resume Page F', parentId: 'locs0001' });
    expect(facts(w, id)).toContain('Status=Authoritative');
    // Another lifecycle tool waits for this one to finish.
    const other = await call('archive_page', { page: id });
    expect(other.body.error).toMatchObject({ code: 'LIFECYCLE_INCOMPLETE', action: 'promote_page' });
    const done = await accept(w, await call('promote_page', { page: id }));
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    expect(w.repo.live(id)).toMatchObject({ name: '[BSRC] Resume Page F', parentId: 'locs0001' });
    expect(w.repo.live(id)!.tags).toEqual(['CANON']);
  });
});

/**
 * CR-2026-11 round 2 (write scope): pages made in bulk from a template.
 *
 * The bulk rail (ADR 0055 decision C) was removed with the other safety rails (ADR 0081): its tests went with it. What
 * stays is the lifecycle guard's refusal (CR-10) of a copy with children in a request that also creates pages: never a
 * direct job.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildModels, discoverWorld, ROOT, type DiscoverWorld } from '../../discover/world.js';
import { PROJECT } from '../../tools/helpers.js';
import { modelSaveAsTemplate, mutationsSince, writeAgent, type Agent } from './helpers.js';

let w: DiscoverWorld;
let a: Agent;
const KIDS = 15;
const SAVEBOX = 'savebox1';
const kid = (p: string, i: number) => `${p}${i.toString(36).padStart(8 - p.length, '0')}`;

beforeAll(async () => {
  w = await discoverWorld({
    bulk: 20,
    build: false,
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  // A plain page in the repository with 15 pages under it (saved as a template with its children).
  w.repo.seed({ id: SAVEBOX, name: '[INDEX] Save box', parentId: ROOT });
  for (let i = 0; i < KIDS; i++)
    w.repo.seed({ id: kid('sbk', i), name: `Saved child ${i}`, parentId: SAVEBOX });
  buildModels(w.stack, w.repo, w.assets);
  modelSaveAsTemplate(w);
  a = await writeAgent(w, 'r2-bulk-agent');
}, 60_000);
afterAll(async () => w?.close());

const call = (tool: string, args: Record<string, unknown>) => w.stack.call(a.client, tool, args);

describe('pages made in bulk from a template', () => {
  it('B4: a batch of [saveResourceAsTemplate, createResourceFromTemplate] with children (32 pages) is refused, not run directly', async () => {
    const m = w.repo.mutations.length;
    const r = await call('lk_api_batch', {
      calls: [
        {
          operationId: 'saveResourceAsTemplate',
          params: { path: { resourceId: SAVEBOX }, body: { id: 'tplsave2', includeChildren: true } },
        },
        {
          operationId: 'createResourceFromTemplate',
          params: {
            body: { templateId: 'tplsave2', includeChildren: true, name: 'Twice copied', parentId: ROOT },
          },
        },
      ],
    });
    if (typeof r.body.jobId === 'string') await w.stack.runtime.engine.wait(PROJECT, r.body.jobId, 20_000);
    const made = mutationsSince(w, m);
    // Safe: the lifecycle guard refuses a copy with children in a request that also creates pages (CR-10); never a
    // direct job.
    expect(made.length, r.text).toBe(0);
    expect(r.body.error?.code, r.text).toBe('POLICY_DENIED');
  });
});

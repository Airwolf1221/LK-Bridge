/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- parsed JSON replies in tests */
/**
 * CR-2026-11 round 4 (sessions), as ADR 0081 now has it (the owner, 26 November 2026: "A code at sign-in is enough"): a
 * project's settings need no fresh authenticator code (ADR 0062 decision 5 had asked for one). A project's confirmed
 * chronology (which documents are the Main table, each
 * age's table and timeline, how dates and KCY values are written) is stored as the project setting `chronology`
 * (`src/chronology/index.ts` `update` → `setSetting(projectId, 'chronology', …)`), written by its own route,
 * `PUT /api/admin/projects/:name/chronology`, which the chronology tools then write by. A session signed in but not
 * stepped up changes it, and the generic project settings route, alike; each change is audited.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chronologyWorld, type ChronologyWorld } from '../../chronology/world.js';
import { PROJECT, PUBLIC_URL } from '../../tools/helpers.js';
import { ownerSession, type Owner } from './helpers.js';

let w: ChronologyWorld;
let owner: Owner;
let name: string;
beforeAll(async () => {
  w = await chronologyWorld();
  owner = ownerSession(w.stack, PUBLIC_URL); // signed in, never stepped up
  name = w.stack.runtime.projects.defaultProject().name;
}, 60_000);
afterAll(async () => w?.close());

const stored = () =>
  JSON.stringify(
    (w.stack.runtime.projects.find(PROJECT)?.settings as Record<string, unknown> | undefined)?.chronology ??
      null,
  );

describe("a project's chronology settings", () => {
  it('SE-15: the project settings route takes the same session’s change without a step-up', async () => {
    const r = await owner.call('PUT', `/api/admin/projects/${name}/settings`, {
      key: 'chronologyResourceId',
      value: 'r4chron01',
    });
    expect({ status: r.status, code: r.json?.error?.code ?? null }, r.text).toEqual({
      status: 200,
      code: null,
    });
  });

  it('SE-16: changing the confirmed chronology (how its tables write dates) needs no step-up, and is audited', async () => {
    const found = await w.stack.runtime.chronology.lookup(PROJECT);
    expect(found.proposed, JSON.stringify(found.problems)).toBeTruthy();
    const settings = structuredClone(found.proposed!) as Record<string, any>;
    const style = (settings.style ??= {
      date: { rangeSeparator: '–', yearGrouping: '' },
      kcy: { grouping: '', minus: '-', rangeSeparator: '–', sameYearRange: 'single' },
    });
    style.date.rangeSeparator = ' to ';
    const before = stored();
    const audits = w.stack.runtime.policy.commands.listAudit('owner', {
      action: 'project.set_chronology',
    }).length;
    const r = await owner.call('PUT', `/api/admin/projects/${name}/chronology`, { confirm: true, settings });
    const after = stored();
    const separator = (JSON.parse(after) as { style?: { date?: { rangeSeparator?: string } } } | null)?.style
      ?.date?.rangeSeparator;
    expect({
      status: r.status,
      code: r.json?.error?.code ?? null,
      changed: after !== before,
      separatorNow: separator ?? null,
      audited:
        w.stack.runtime.policy.commands.listAudit('owner', { action: 'project.set_chronology' }).length -
        audits,
    }).toEqual({ status: 200, code: null, changed: true, separatorNow: ' to ', audited: 1 });
  });
});

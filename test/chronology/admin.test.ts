/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies */
/**
 * The chronology's admin routes (v2 D1, ADR 0038; docs/dashboard.md) on an unconfirmed project: the settings view says
 * why the tools refuse, the confirmation needs `confirm: true` and valid settings, a reset is audited, the check refuses
 * until the chronology is confirmed, and the records list is empty. (The lookup and the confirmation of a found
 * chronology are covered end to end by the chronology world.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '../../src/lk/index.js';
import { LkModel } from '../jobs/lk-model.js';
import { startAdminStack, type AdminStack } from '../admin/helpers.js';

let stack: AdminStack;
beforeAll(async () => {
  stack = await startAdminStack({ respond: new LkModel(() => systemClock.now()).respond });
});
afterAll(() => stack.close());

describe('the chronology admin routes', () => {
  it('shows an unconfirmed chronology and why the tools refuse', async () => {
    const name = stack.runtime.projects.defaultProject().name;
    const r = await stack.get(`/api/admin/projects/${name}/chronology`);
    expect(r.status).toBe(200);
    expect(r.json.ready).toMatchObject({ ok: false, code: 'CHRONOLOGY_NOT_CONFIGURED' });
    expect(r.json.find.resource.status).toBe('missing');
  });

  it('needs confirm and valid settings; a reset is audited', async () => {
    const name = stack.runtime.projects.defaultProject().name;
    expect((await stack.put(`/api/admin/projects/${name}/chronology`, { reset: true })).status).toBe(400);
    const bad = await stack.put(`/api/admin/projects/${name}/chronology`, {
      confirm: true,
      settings: { ages: 'x' },
    });
    expect(bad.status).toBe(400);
    const ok = await stack.put(`/api/admin/projects/${name}/chronology`, { confirm: true, reset: true });
    expect(ok.status).toBe(200);
    expect(stack.audit('project.set_chronology')).toHaveLength(1);
  });

  it('refuses the check until the chronology is confirmed, and lists no changes', async () => {
    const c = await stack.post('/api/admin/chronology/check', { confirm: true });
    expect(c.status).toBe(409);
    expect(c.json.error.code).toBe('CHRONOLOGY_NOT_CONFIGURED');
    const last = await stack.get('/api/admin/chronology/check');
    expect(last.json).toMatchObject({ last: null, running: false });
    const recs = await stack.get('/api/admin/chronology/records');
    expect(recs.json).toMatchObject({ total: 0, incomplete: 0, records: [] });
  });
});

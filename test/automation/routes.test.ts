/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- parsed JSON replies */
/**
 * v3 F5b (ADR 0068, H5): the Automation page's API and ADR 0062's rule. "Pause all automation" is one click (a brake);
 * resuming it, resuming a paused code and "Run automation now" ask for the step-up; the Overview carries what automation
 * did overnight; bridge_info tells agents which codes are automated, and nothing more.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { automationWorld, PROJECT, type AutomationWorld } from './world.js';
import { ownerHttp, type OwnerHttp } from './helpers.js';

vi.setConfig({ testTimeout: 180_000 });

let w: AutomationWorld;
let owner: OwnerHttp;
beforeAll(async () => {
  w = await automationWorld();
  await w.snapshot();
  owner = ownerHttp(w);
});
afterAll(async () => w?.close());

describe('the brake', () => {
  it('"Pause all automation" is one click (no step-up); resuming asks for it', async () => {
    owner.expire();
    const p = await owner.post('/automation/pause', { confirm: true });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.paused).toBe(true);
    const refused = await owner.post('/automation/resume', { confirm: true });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('REAUTH_REQUIRED');
    owner.stepUp();
    const r = await owner.post('/automation/resume', { confirm: true });
    expect(r.status).toBe(200);
    expect(r.json.paused).toBe(false);
    const audit = w.stack.db
      .prepare(`SELECT action FROM audit_log WHERE action LIKE 'automation.%_all' ORDER BY id`)
      .all() as { action: string }[];
    expect(audit.map((x) => x.action)).toEqual(['automation.pause_all', 'automation.resume_all']);
  });
});

describe('Run automation now, the runs and the overnight tile', () => {
  it('asks for the step-up; runs; its run and items are listed; the Overview counts them per code', async () => {
    owner.stepUp();
    expect(
      (await owner.post('/automation/codes/blank_paragraphs', { mode: 'apply', confirm: true })).status,
    ).toBe(200);
    owner.expire();
    const refused = await owner.post('/automation/run', { confirm: true, wait: true });
    expect(refused.status).toBe(403);
    owner.stepUp();
    const r = await owner.post('/automation/run', { confirm: true, wait: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.run.state).toBe('succeeded');
    expect(r.json.items).toEqual([expect.objectContaining({ code: 'blank_paragraphs', outcome: 'applied' })]);
    const one = await owner.get(`/automation/runs/${r.json.run.id}`);
    expect(one.status).toBe(200);
    expect(one.json.items).toHaveLength(1);
    const page = await owner.get('/automation');
    expect(page.json.runs[0].id).toBe(r.json.run.id);
    const code = page.json.codes.find((c: any) => c.code === 'blank_paragraphs');
    expect(code.recent[0]).toMatchObject({ outcome: 'applied', jobId: expect.any(String) });
    expect(code.lastRun.runId).toBe(r.json.run.id);
    expect(page.json.never.length).toBeGreaterThan(10);
    const tile = await owner.get('/automation/overnight');
    expect(tile.json.codes).toEqual([
      expect.objectContaining({
        code: 'blank_paragraphs',
        name: 'Decorative blank paragraphs',
        counts: expect.objectContaining({ applied: 1 }),
        jobs: [code.recent[0].jobId],
      }),
    ]);
    const overview = await owner.get('/overview');
    expect(overview.json.automation.codes[0]).toMatchObject({ code: 'blank_paragraphs' });
  });

  it('a paused code is resumed with the step-up', async () => {
    w.stack.runtime.automation.store.pause(PROJECT, 'blank_paragraphs', 'test');
    owner.expire();
    expect((await owner.post('/automation/codes/blank_paragraphs/resume', { confirm: true })).status).toBe(
      403,
    );
    owner.stepUp();
    expect((await owner.post('/automation/codes/blank_paragraphs/resume', { confirm: true })).status).toBe(
      200,
    );
    expect(w.stack.runtime.automation.store.setting(PROJECT, 'blank_paragraphs')!.pausedAt).toBeNull();
  });
});

describe('agents', () => {
  it('bridge_info names the automated codes so an agent does not duplicate the work, and cannot change them', async () => {
    const info = await w.call('bridge_info', { project: 'test' });
    expect(info.body.automation).toMatchObject({
      pausedAll: false,
      codes: [
        {
          code: 'blank_paragraphs',
          name: 'Decorative blank paragraphs',
          setting: 'apply automatically',
          paused: false,
        },
      ],
    });
    expect(info.body.automation.note).toMatch(/do not propose or apply the same fixes\. Only the owner/);
    // A read-scope agent has no route to the dashboard's API.
    const res = await fetch(`${w.stack.base}/api/admin/automation/pause?project=test`, {
      method: 'POST',
      headers: { authorization: `Bearer ${w.stack.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect([401, 403]).toContain(res.status);
    expect(w.stack.runtime.automation.store.global().paused).toBe(false);
  });
});

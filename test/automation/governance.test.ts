/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- parsed JSON replies and the mock's state */
/**
 * v3 F5b (ADR 0068, H5): the settings and the governance record, against the REAL stack on the mock LegendKeeper.
 *
 * - Only the owner changes a setting (ADR 0081: no fresh code); agents are refused (and have no tool for it); every change is
 *   journalled with the owner principal, its date and the governance write it caused.
 * - Switching a code on writes its paragraph into Repository Automation's "Approved Narrow Automations", after the
 *   sweep's paragraph, in the sweep's form; switching it off amends that paragraph (never deleted).
 * - The pack does not fail closed on these writes (its approval is carried over them).
 * - The write is journalled, on the Review page and Revertible; reverting it switches the code off.
 * - A manual edit to a bridge-managed paragraph is detected.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { automationWorld, PROJECT, SWEEP_PARAGRAPH, type AutomationWorld } from './world.js';
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

const a = () => w.stack.runtime.automation;
const texts = () =>
  w
    .governanceBlocks()
    .map((b) => ((b.content as { text?: string }[] | undefined) ?? []).map((r) => r.text ?? '').join(''));
const managed = (code: string) => texts().filter((t) => t.startsWith(`Bridge automation ${code}:`));
const today = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/London',
}).format(new Date());

describe('the settings: the owner’s alone, journalled (ADR 0081: no fresh code)', () => {
  it('a session not stepped up is not asked for a step-up (its other checks still apply)', async () => {
    owner.expire();
    const r = await owner.post('/automation/codes/no_such_code', { mode: 'apply', confirm: true });
    expect([r.status, r.json.error.code]).toEqual([400, 'NOT_ELIGIBLE']);
    expect(a().store.mode(PROJECT, 'blank_paragraphs')).toBe('off');
    expect(managed('blank_paragraphs')).toEqual([]);
  });

  it('switching off (already off) is not asked either', async () => {
    owner.expire();
    const r = await owner.post('/automation/codes/blank_paragraphs', { mode: 'off', confirm: true });
    expect(r.json?.error?.code).not.toBe('REAUTH_REQUIRED');
    expect(managed('blank_paragraphs')).toEqual([]);
  });

  it('agents are refused: the service refuses any actor but the owner, and no MCP tool changes a setting', async () => {
    await expect(a().setMode('agent', PROJECT, 'blank_paragraphs', 'apply')).rejects.toMatchObject({
      code: 'NOT_OWNER',
    });
    expect(() => a().setGlobalPause('agent', true)).toThrow(/Only the owner/);
    const tools = w.stack.runtime.tools.map((t) => t.name);
    expect(tools.filter((n) => /automat/i.test(n))).toEqual([]);
    // bridge_info tells an agent what is automated, nothing more.
    const info = await w.call('bridge_info', { project: 'test' });
    expect(info.body.automation).toMatchObject({ codes: [] });
  });

  it('a code that is not eligible cannot be switched on', async () => {
    owner.stepUp();
    for (const code of ['retag_hold', 'consistency_birth', 'no_such_code']) {
      const r = await owner.post(`/automation/codes/${code}`, { mode: 'apply', confirm: true });
      expect(r.status, code).toBe(400);
      expect(r.json.error.code).toBe('NOT_ELIGIBLE');
    }
  });

  it('with the step-up: the paragraph is written first, then the setting, journalled with the owner and the job', async () => {
    owner.stepUp();
    const r = await owner.post('/automation/codes/blank_paragraphs', { mode: 'propose', confirm: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ mode: 'propose', changed: true, governance: 'written' });
    expect(a().store.mode(PROJECT, 'blank_paragraphs')).toBe('propose');
    const [c] = a().store.changes(PROJECT, 'blank_paragraphs');
    expect(c).toMatchObject({
      from: 'off',
      to: 'propose',
      principal: 'owner',
      governanceJobId: r.json.governanceJobId,
      governanceState: 'written',
    });
    expect(Math.abs(c!.at - Date.now())).toBeLessThan(60_000);
    const audit = w.stack.db
      .prepare(
        `SELECT actor, target FROM audit_log WHERE action = 'automation.set_mode' ORDER BY id DESC LIMIT 1`,
      )
      .get() as { actor: string; target: string };
    expect(audit).toEqual({ actor: 'owner', target: `${PROJECT}:blank_paragraphs` });
    const view = await owner.get('/automation');
    expect(view.status).toBe(200);
    expect(view.json.codes.find((x: any) => x.code === 'blank_paragraphs')).toMatchObject({
      mode: 'propose',
      name: 'Decorative blank paragraphs',
    });
  });
});

describe('the governance record (Repository Automation’s "Approved Narrow Automations")', () => {
  it('switching on writes ONE paragraph after the sweep’s paragraph, in the sweep’s form', () => {
    const t = texts();
    const sweepAt = t.indexOf(SWEEP_PARAGRAPH);
    const [p] = managed('blank_paragraphs');
    expect(t.indexOf(p!)).toBe(sweepAt + 1);
    expect(p).toMatch(
      new RegExp(
        `^Bridge automation blank_paragraphs: Decorative blank paragraphs \\(owner approval through the bridge dashboard, ${today}\\)\\. Setting: Propose automatically`,
      ),
    );
    for (const part of [
      'Scope: pages inside the project’s AI REPOSITORY, excluding the Legacy Canon Archive and the Design References',
      'Transformation: deleteBlock of each top-level paragraph with no visible text',
      'Verification: every page is read back after the write',
      'identical apart from the one transformation',
      'Concurrency: one writer per page',
      'If-Match on every versioned write',
      'Stop conditions: the first failed verification, an unexpected error or a write whose outcome is unknown',
      'three findings skipped in a row for the same reason pause it',
      'when the budget runs out the run ends cleanly',
      'the canon guard, the lifecycle guard and the safety rails are never bypassed',
      'Repository Automation has drifted',
      `History: Propose automatically from ${today}`,
    ])
      expect(p, part).toContain(part);
    expect(p).toMatch(
      /Enabling it is the activation, and this approval establishes no wider repair whitelist\.$/,
    );
  });

  it('the pack does not drift: its approval is carried over the bridge’s own write, and governance is current', async () => {
    const g = await w.stack.runtime.packs.governance('arkona');
    expect(g.state, g.message).toBe('current');
    expect((await a().governanceState(PROJECT)).ok).toBe(true);
    // The retag (which fails closed on drift) still computes.
    expect(() => w.stack.runtime.retag.policyFor(PROJECT)).not.toThrow();
  });

  it('a second code goes after the first; changing the setting amends the paragraph in place', async () => {
    owner.stepUp();
    expect(
      (await owner.post('/automation/codes/em_dash_text', { mode: 'apply', confirm: true })).status,
    ).toBe(200);
    const t = texts();
    expect(t.indexOf(managed('em_dash_text')[0]!)).toBe(t.indexOf(managed('blank_paragraphs')[0]!) + 1);
    const id0 = a().store.paragraph(PROJECT, 'blank_paragraphs')!.blockId;
    expect(
      (await owner.post('/automation/codes/blank_paragraphs', { mode: 'apply', confirm: true })).status,
    ).toBe(200);
    expect(a().store.paragraph(PROJECT, 'blank_paragraphs')!.blockId).toBe(id0);
    expect(managed('blank_paragraphs')).toHaveLength(1);
    expect(managed('blank_paragraphs')[0]).toContain('Setting: Apply automatically');
    expect(managed('blank_paragraphs')[0]).toContain(
      `History: Propose automatically from ${today}; Apply automatically from ${today}`,
    );
    expect((await w.stack.runtime.packs.governance('arkona')).state).toBe('current');
  });

  it('switching off amends the paragraph (never deleted): it says it was disabled, and when', async () => {
    owner.stepUp();
    const r = await owner.post('/automation/codes/em_dash_text', { mode: 'off', confirm: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.governance).toBe('written');
    const [p] = managed('em_dash_text');
    expect(p).toContain(`Setting: Off since ${today} (switched off by the owner): not running`);
    expect(p).toContain(
      `History: Apply automatically from ${today}; Off from ${today} (switched off by the owner)`,
    );
    expect(a().store.mode(PROJECT, 'em_dash_text')).toBe('off');
    expect(a().store.changes(PROJECT, 'em_dash_text')[0]).toMatchObject({
      to: 'off',
      governanceState: 'written',
    });
    expect((await w.stack.runtime.packs.governance('arkona')).state).toBe('current');
  });

  it('the write is journalled, listed on the Review page, and an "off" record is not Revertible', async () => {
    const job = a().store.changes(PROJECT, 'em_dash_text')[0]!.governanceJobId!;
    const journal = w.stack.runtime.engine.queries.journalLookup(PROJECT, { jobId: job, limit: 10 });
    expect(journal.length).toBeGreaterThan(0);
    expect(w.stack.runtime.review.store.get(PROJECT, job)).not.toBeNull();
    const refused = await w.stack.runtime.reverts.revert('owner', PROJECT, job);
    expect(refused).toMatchObject({ status: 'refused', code: 'GOVERNANCE_OFF_RECORD' });
  });

  it('reverting the paragraph switches the code off, and the pack’s approval follows the revert', async () => {
    owner.stepUp();
    expect(
      (await owner.post('/automation/codes/heading_links', { mode: 'apply', confirm: true })).status,
    ).toBe(200);
    const job = a().store.changes(PROJECT, 'heading_links')[0]!.governanceJobId!;
    expect(managed('heading_links')).toHaveLength(1);
    const r = await w.stack.runtime.reverts.revert('owner', PROJECT, job);
    expect(r.status, JSON.stringify(r)).toBe('submitted');
    const revertJob = (r as { revertJobId: string }).revertJobId;
    await w.stack.runtime.engine.wait(PROJECT, revertJob, 20_000);
    await vi.waitFor(() => expect(a().store.mode(PROJECT, 'heading_links')).toBe('off'), { timeout: 10_000 });
    expect(managed('heading_links')).toEqual([]);
    expect(a().store.changes(PROJECT, 'heading_links')[0]).toMatchObject({
      to: 'off',
      principal: 'owner',
      governanceJobId: revertJob,
    });
    await vi.waitFor(
      async () => expect((await w.stack.runtime.packs.governance('arkona')).state).toBe('current'),
      {
        timeout: 10_000,
      },
    );
    expect((await a().governanceState(PROJECT)).ok).toBe(true);
  });

  it('a manual edit to a bridge-managed paragraph is detected: drift first, then the edited paragraph itself', async () => {
    const id = a().store.paragraph(PROJECT, 'blank_paragraphs')!.blockId;
    w.editAutomationPage((blocks) => {
      const b = blocks.find((x) => x.id === id)!;
      b.content = [{ text: `${(b.content as { text: string }[])[0]!.text} Also bold claims.` }];
    });
    const drift = await a().governanceState(PROJECT);
    expect(drift).toMatchObject({ ok: false, code: 'GOVERNANCE_DRIFT' });
    // The owner approves the pack again: the governance is current, but the paragraph is not what the bridge wrote.
    await w.stack.runtime.packs.commands.approve('owner', 'arkona');
    const edited = await a().governanceState(PROJECT);
    expect(edited).toMatchObject({ ok: false, code: 'GOVERNANCE_EDITED' });
    expect(edited.problems).toEqual([expect.objectContaining({ code: 'blank_paragraphs', state: 'edited' })]);
    // Nothing runs meanwhile.
    const run = await a().run(PROJECT, 'manual');
    expect(run).toMatchObject({ state: 'skipped', stopReason: 'GOVERNANCE_EDITED' });
    // Switching it on again is refused until the paragraph is set right; switching it off rewrites it.
    owner.stepUp();
    expect(
      (await owner.post('/automation/codes/em_dash_text', { mode: 'apply', confirm: true })).json.error.code,
    ).toBe('GOVERNANCE_EDITED');
    expect(
      (await owner.post('/automation/codes/blank_paragraphs', { mode: 'off', confirm: true })).status,
    ).toBe(200);
    // The rewrite was based on the version the owner approved, so the approval is carried over it: all is as approved.
    expect(managed('blank_paragraphs')[0]).not.toContain('Also bold claims.');
    expect((await a().governanceState(PROJECT)).ok).toBe(true);
  });

  it('Repository Automation edited outside the bridge’s paragraphs is drift: nothing runs until the pack is approved again', async () => {
    owner.stepUp();
    expect(
      (await owner.post('/automation/codes/blank_paragraphs', { mode: 'apply', confirm: true })).status,
    ).toBe(200);
    w.editAutomationPage((blocks) => {
      blocks.push({ id: 'raOwner1', kind: 'paragraph', content: [{ text: 'The owner adds a sentence.' }] });
    });
    const writes = w.requests().writes;
    const run = await a().run(PROJECT, 'manual');
    expect(run).toMatchObject({ state: 'skipped', stopReason: 'GOVERNANCE_DRIFT' });
    expect(w.requests().writes).toBe(writes);
    await w.stack.runtime.packs.commands.approve('owner', 'arkona');
    expect((await a().governanceState(PROJECT)).ok).toBe(true);
  });
});

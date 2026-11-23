/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- the mock's state */
/**
 * v3 F5b (ADR 0068 decision 3.4): the pack's approval carried over the bridge's own governance write, ONLY for the
 * sources whose content is exactly what the owner approved, plus the planned paragraph itself.
 *
 * - Only the Repository Automation source is carried; every other source keeps its approved version and digests.
 * - An edit made in the app to another tab of the same page (the Tagging Standard) while the bridge writes is still
 *   drift, and blocks automation.
 * - An edit to Repository Automation itself between the bridge's write and its read-back carries nothing: drift.
 * - `carryApproval` itself: refused when the content before the write differs from the approved content (even at the
 *   approved version), when any other pinned section changed in the write, or when another source kept on the same
 *   document was approved at another version (all or nothing).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pinnedSections } from '../../src/packs/sections.js';
import { automationWorld, AUTOMATION_SECTIONS, PROJECT, type AutomationWorld } from './world.js';

vi.setConfig({ testTimeout: 180_000 });

let w: AutomationWorld;
beforeAll(async () => {
  w = await automationWorld();
  await w.snapshot();
});
afterAll(async () => w?.close());

const a = () => w.stack.runtime.automation;
const packs = () => w.stack.runtime.packs;
const approvedSources = () =>
  new Map(
    packs()
      .get('arkona')!
      .approved!.sources.map((s) => [s.key, JSON.stringify(s)]),
  );
const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });
/** Runs `fn` once, the next time a request matches (the request itself goes on unchanged). */
const once = (method: string, path: RegExp, fn: () => void) => {
  let done = false;
  const key = new RegExp(path.source);
  w.overrides.set(key, (req) => {
    if (!done && req.method === method) {
      done = true;
      fn();
    }
    return undefined;
  });
  return () => w.overrides.delete(key);
};
const govPath = () => new RegExp(`/docs/${w.governanceDoc}/blocks`);

describe('only Repository Automation is carried, and only when nothing else changed', () => {
  it('a clean write: Repository Automation carried to its new version; every other source exactly as approved', async () => {
    const before = approvedSources();
    const r = await a().setMode('owner', PROJECT, 'blank_paragraphs', 'propose');
    expect(r).toMatchObject({ governance: 'written', approvalCarried: true });
    const after = approvedSources();
    for (const [key, s] of before)
      if (key === 'repository-automation') expect(after.get(key), key).not.toBe(s);
      else expect(after.get(key), key).toBe(s);
    expect((await packs().governance('arkona')).state).toBe('current');
    const audit = w.stack.db
      .prepare(`SELECT after FROM audit_log WHERE action = 'pack.carry_approval' ORDER BY id DESC LIMIT 1`)
      .get() as { after: string };
    expect(JSON.parse(audit.after)).toMatchObject({
      sources: ['repository-automation'],
      section: 'Approved Narrow Automations',
    });
  });

  it('the Tagging Standard (another tab of the same page) edited while the bridge writes: drift, automation blocked', async () => {
    const before = approvedSources();
    const tagging = w.governanceDocs.tagging;
    const off = once('POST', govPath(), () => {
      const b = w.repo.blocks.get(tagging)!;
      b.version++;
      b.blocks = [...b.blocks, para('tgedit01', 'An edit made in the app meanwhile.')];
    });
    try {
      const r = await a().setMode('owner', PROJECT, 'em_dash_text', 'propose');
      // The bridge's own paragraph is written, and Repository Automation alone is carried over it.
      expect(r).toMatchObject({ governance: 'written', approvalCarried: true });
    } finally {
      off();
    }
    const after = approvedSources();
    expect(after.get('tagging-standard')).toBe(before.get('tagging-standard'));
    const g = await packs().governance('arkona');
    expect(g.state).toBe('changed');
    expect(g.message).toMatch(/Controlled Native Tagging Standard/);
    expect(g.message).not.toMatch(/Repository Automation/);
    const writes = w.requests().writes;
    const run = await a().run(PROJECT, 'manual');
    expect(run).toMatchObject({ state: 'skipped', stopReason: 'GOVERNANCE_DRIFT' });
    expect(w.requests().writes).toBe(writes);
    // Switching another code on is refused while it drifts.
    await expect(a().setMode('owner', PROJECT, 'heading_links', 'apply')).rejects.toMatchObject({
      code: 'GOVERNANCE_DRIFT',
    });
    await packs().commands.approve('owner', 'arkona');
    expect((await a().governanceState(PROJECT)).ok).toBe(true);
  });

  it('Repository Automation edited between the bridge’s write and its read-back: nothing is carried, drift', async () => {
    const before = approvedSources();
    // The bridge's write (a POST), then its job's read-back (a GET), then the carry's read: the edit lands before it.
    let posted = false;
    let gets = 0;
    const key = new RegExp(govPath().source);
    w.overrides.set(key, (req) => {
      if (req.method === 'POST') posted = true;
      else if (posted && req.method === 'GET' && ++gets === 2) {
        const b = w.repo.blocks.get(w.governanceDoc)!;
        b.version++;
        b.blocks = [...b.blocks, para('raedit01', 'Another sentence added in the app.')];
      }
      return undefined;
    });
    try {
      const r = await a().setMode('owner', PROJECT, 'heading_links', 'propose');
      expect(r).toMatchObject({ governance: 'written', approvalCarried: false });
    } finally {
      w.overrides.delete(key);
    }
    expect(approvedSources().get('repository-automation')).toBe(before.get('repository-automation'));
    const g = await packs().governance('arkona');
    expect(g.state).toBe('changed');
    expect(g.message).toMatch(/Repository Automation/);
    expect(await a().run(PROJECT, 'manual')).toMatchObject({
      state: 'skipped',
      stopReason: 'GOVERNANCE_DRIFT',
    });
    await packs().commands.approve('owner', 'arkona');
    expect((await a().governanceState(PROJECT)).ok).toBe(true);
  });
});

describe('carryApproval itself: identical content only, all or nothing', () => {
  const doc = () => structuredClone(w.governanceBlocks());
  const approvedVersion = () =>
    packs()
      .get('arkona')!
      .approved!.sources.find((s) => s.key === 'repository-automation')!.version;
  const withParagraph = (blocks: any[]) => {
    const at = blocks.findIndex((b) => b.id === 'raSweep');
    return [
      ...blocks.slice(0, at + 1),
      para('newpara1', 'Bridge automation test_only: a planned paragraph.'),
      ...blocks.slice(at + 1),
    ];
  };
  const carry = (before: unknown[], after: unknown[], version = approvedVersion()) =>
    packs().carryApproval('arkona', 'repository-automation', {
      before: { version, blocks: before },
      section: 'Approved Narrow Automations',
      after: { version: `${version}-next`, blocks: after },
      actor: 'system',
      reason: 'test',
    });

  it('refuses content that differs from the approved content, even at the approved version', () => {
    const was = approvedSources();
    const before = doc();
    const p = before.find((b) => b.id === 'raP1')!;
    p.content = [{ text: 'A Default Boundary the owner never approved.' }];
    expect(carry(before, withParagraph(before))).toBe(false);
    expect(approvedSources()).toEqual(was);
  });

  it('refuses a write that changed any pinned section but the one the bridge writes into', () => {
    const was = approvedSources();
    const before = doc();
    const after = withParagraph(before);
    after.find((b) => b.id === 'raP2')!.content = [{ text: 'Source Boundaries, changed as well.' }];
    expect(carry(before, after)).toBe(false);
    expect(approvedSources()).toEqual(was);
  });

  it('refuses when the approval recorded another version than the one written over', () => {
    const was = approvedSources();
    const before = doc();
    expect(carry(before, withParagraph(before), 'not-the-approved-version')).toBe(false);
    expect(approvedSources()).toEqual(was);
  });

  it('refuses when another source kept on the same document does not hold (all or nothing)', () => {
    const p = packs();
    const pack = p.get('arkona')!;
    const saved = pack.governance;
    // The Tagging Standard moved onto Repository Automation's document (a sandbox's shape), its approval left as it was.
    p.store.setGovernance(
      'arkona',
      saved.map((g) =>
        g.key === 'tagging-standard' ? { ...g, documentId: w.governanceDoc, resourceId: g.resourceId } : g,
      ),
    );
    try {
      const was = approvedSources();
      const before = doc();
      expect(carry(before, withParagraph(before))).toBe(false);
      expect(approvedSources()).toEqual(was);
    } finally {
      p.store.setGovernance('arkona', saved);
    }
  });

  it('carries the approved content plus the planned paragraph, with the digests worked out again', () => {
    const before = doc();
    const after = withParagraph(before);
    expect(carry(before, after)).toBe(true);
    const s = packs()
      .get('arkona')!
      .approved!.sources.find((x) => x.key === 'repository-automation')!;
    expect(s.version).toMatch(/-next$/);
    expect(s.sections).toEqual(
      pinnedSections(after, AUTOMATION_SECTIONS).map((x) => ({ heading: x.heading, digest: x.digest })),
    );
  });
});

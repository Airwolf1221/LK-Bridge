/**
 * CR-2026-11 round 3 (renames): D2, "history is never touched" (ADR 0058 decision 1.4): Archived pages, the Legacy Canon
 * Archive and the Design References never become items and are never edited. The plan decides from the snapshot when it
 * is made; the job runs days later. Against the mock LegendKeeper of the rename world only. Every test asserts the SAFE
 * behaviour; a failing test is a finding.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { O, P, PROJECT, renameWorld, type RenameWorld } from '../../packs/rename-world.js';
import { NEW, OLD, approveAs, proposeNadira, textOf } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const SENTENCE = `${OLD} catalogued the emirate’s charters in her youth.`;

describe('RN history: a page archived while the proposal waits', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-18 a restatement on a page the owner archived meanwhile is never edited (D2)', async () => {
    const id = await proposeNadira(w);
    // While the rename waits, the owner archives Qasr's page (archive_page, accepted as canon).
    const a = await w.call('archive_page', { page: O.qasr });
    expect(a.body.status, a.text.slice(0, 300)).toBe('proposal_captured');
    const archived = await approveAs(w, String(a.body.proposalId));
    expect(archived.job?.status, JSON.stringify(archived.job?.lastError)).toBe('succeeded');
    expect(w.repo.live(O.qasr)!.name).toMatch(/^\[BARC\] /);
    const done = await approveAs(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    // Safe: the Archived page keeps its record (the item skipped, or the job stopped), as D2 says.
    expect(textOf(w, O.qasr, 'qs4')).toBe(SENTENCE);
  });
});

describe('RN history: a page moved into the Legacy Canon Archive while the proposal waits', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-19 a restatement on a page filed under the Legacy Canon Archive meanwhile is never edited (D2)', async () => {
    const id = await proposeNadira(w);
    w.repo.outside.move(O.qasr, P.legacy);
    const done = await approveAs(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(textOf(w, O.qasr, 'qs4')).toBe(SENTENCE);
    void NEW;
    void PROJECT;
  });
});

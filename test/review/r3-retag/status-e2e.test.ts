/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- tool JSON */
/**
 * R3-RETAG (pass 3): the engine-level status-tag findings (engine-status.test.ts RT-01..RT-11) end to end, through
 * `arkona_retag_audit`, `arkona_retag_apply`, the owner's approval and the job, against the mock LegendKeeper.
 *
 * - RT-20: a deterministic correction that removes a case-variant duplicate of CANON: what the apply does with
 *   it (the C2d guard judges exact spellings) and what happens to the other pages of the batch;
 * - RT-21: the same with the project's `statusTags` canon rule switched off (the dashboard allows it): is the
 *   status-tag spelling removed by the retag itself?
 * - RT-22: an Excluded Routine Tag naming a lifecycle tag, and a fullwidth `Ａｒｃｈｉｖｅｄ` on a page (rule off);
 * - RT-23: a race token that is a status-tag look-alike (`Ｗｏｒｋｉｎｇ`) added to a Character Core (rule off).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CANONICAL_RULES } from '../../../src/facts/index.js';
import {
  approve,
  audit,
  batchOf,
  byId,
  CANON_ROWS,
  PROJECT,
  propose,
  r3World,
  tagsOf,
  type R3World,
} from './helpers.js';

vi.setConfig({ testTimeout: 180_000 });

const P = {
  dup: 'r3dup001',
  plain: 'r3pln001',
  dup2: 'r3dup002',
  routine: 'r3rtn001',
  core: 'r3core01',
} as const;

let w: R3World;
beforeAll(async () => {
  w = await r3World([
    { id: P.dup, name: '[BSRC] Aaa Dup - Polity Reference', tags: ['Polity', 'CANON', 'canon'] },
    { id: P.plain, name: '[BSRC] Zzz Plain - Polity Reference', tags: ['Polity', 'CANON'] },
    { id: P.dup2, name: '[BSRC] Bbb Dup - Polity Reference', tags: ['Polity', 'CANON', 'Canon'] },
    {
      id: P.routine,
      name: '[BSRC] Ccc Routine - Polity Reference',
      tags: ['CANON', 'Polity', 'Ａｒｃｈｉｖｅｄ'],
    },
    {
      id: P.core,
      name: '[BSRC] Ddd Ghost - Character Core',
      tags: ['CANON', 'Character', 'Hollow'],
      referenceType: 'Character Core',
      rows: [...CANON_ROWS, ['Race / Species', 'Ghostkin'], ['Naming Culture', 'Hollow']],
    },
  ]);
  await w.snapshot();
});
afterAll(async () => w?.close());

const statusRuleOff = () =>
  w.stack.runtime.projects.setSetting(
    PROJECT,
    'canonicalRules',
    DEFAULT_CANONICAL_RULES.map((x) => (x.id === 'status-tags' ? { ...x, enabled: false } : x)),
  );
const statusRuleOn = () => w.stack.runtime.projects.setSetting(PROJECT, 'canonicalRules', null);

describe('status-tag spellings through the whole apply', () => {
  it('RT-20: a "correction" removing a case-variant CANON duplicate can be proposed with its batch', async () => {
    const body = await audit(w, { under: w.desk });
    const pages = byId(body);
    // CR-2026-11-R3 (R3-06, fixed): a spelling of a status tag is never removed as a "duplicate": the page is a status
    // hold (the lifecycle tools' or the owner's), not a correction the status-tag guard then refuses with its batch.
    expect(pages.get(P.dup)).toMatchObject({ disposition: 'hold' });
    expect(JSON.stringify(pages.get(P.dup))).toContain('never adds or removes one');
    expect(pages.get(P.plain)).toMatchObject({ disposition: 'correction' });
    const r = await w.call('arkona_retag_apply', {
      project: 'test',
      runId: body.runId,
      pages: [P.plain],
    });
    const seen = {
      status: r.body.status ?? null,
      error: r.body.error?.code ?? null,
      message: (r.body.error?.message as string | undefined)?.slice(0, 160) ?? null,
    };
    // SAFE: the engine never offers, as a deterministic correction, an array the status-tag guard refuses; so the
    // batch (the plain page with it) is proposed, and nobody is told to use move_to_working or archive_page.
    expect(seen, JSON.stringify(seen)).toMatchObject({ status: 'proposal_captured', error: null });
    if (seen.status === 'proposal_captured') {
      const done = await approve(w, r.body.proposalId);
      expect(done.job?.status).toBe('succeeded');
      expect(batchOf(w, r.body.proposalId)!.state).toBe('done');
    }
    expect(tagsOf(w, P.dup)).toEqual(['Polity', 'CANON', 'canon']);
  });

  it('RT-21: with the statusTags rule off, the retag itself still never removes a status-tag spelling', async () => {
    statusRuleOff();
    try {
      const body = await audit(w, { page: P.dup2 });
      // CR-2026-11-R3 (R3-06, fixed): with the guard off too, the engine itself holds the page (on the reviewed code it
      // was a correction dropping "Canon", written once the owner approved it).
      expect(body.pages[0]).toMatchObject({ disposition: 'hold' });
      // SAFE: "Status and lifecycle tags are never added or removed" (ADR 0060 decision 1.6): Canon stays.
      expect(tagsOf(w, P.dup2)).toContain('Canon');
    } finally {
      statusRuleOn();
    }
  });

  it('RT-22: an Excluded Routine Tag naming Archived never removes a fullwidth Ａｒｃｈｉｖｅｄ (rule off)', async () => {
    w.approveRetag({ routine: ['Imported', 'Archived'] });
    statusRuleOff();
    try {
      const body = await audit(w, { page: P.routine });
      const v = body.pages[0];
      if (v.disposition === 'correction') {
        const p = await propose(w, body.runId, [P.routine]);
        await approve(w, p.proposalId);
      }
      // SAFE: the lifecycle-tag look-alike is still on the page (the retag never removes a status or lifecycle tag).
      expect(tagsOf(w, P.routine), JSON.stringify(v)).toContain('Ａｒｃｈｉｖｅｄ');
    } finally {
      statusRuleOn();
    }
  });

  it('RT-23: a race token that looks like Working is never added to a Character Core (rule off)', async () => {
    w.approveRetag({ race: { Ghostkin: 'Ｗｏｒｋｉｎｇ' }, culture: { Hollow: 'Hollow' } });
    statusRuleOff();
    try {
      const body = await audit(w, { page: P.core });
      const v = body.pages[0];
      if (v.disposition === 'correction') {
        const p = await propose(w, body.runId, [P.core]);
        await approve(w, p.proposalId);
      }
      // SAFE: no status or lifecycle tag (by the guard's own fold) is added by a retag.
      expect(tagsOf(w, P.core), JSON.stringify(v)).toEqual(['CANON', 'Character', 'Hollow']);
    } finally {
      statusRuleOn();
    }
  });
});

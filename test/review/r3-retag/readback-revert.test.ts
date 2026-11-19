/* eslint-disable @typescript-eslint/no-unsafe-argument -- tool JSON */
/**
 * R3-RETAG (pass 3): the apply's read-back and Revert.
 *
 * - The read-back (src/packs/retag/checks.ts `fingerprint`, `verifyCheck`) claims "documents ... unchanged"
 *   from getResource's per-document `updatedAt` (ADR 0060 decision 3.3.4 and departure 3). The spec makes
 *   `Document.updatedAt` OPTIONAL and does not say a content edit moves it; the mock omits it, as the spec
 *   allows. RT-80 edits a document body during the job with the mock as it is; RT-81 (MODELLED from
 *   spec/legendkeeper-openapi.json's Document schema) gives every listed document an `updatedAt` that a content
 *   edit moves, to see whether the check then works.
 * - Revert (ADR 0060 decision 3.6, ADR 0055 amended): "restores each page's exact prior array ..., only where the page
 *   is as the job left it".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockRequest, MockResponse } from '../../contract/mock-lk.js';
import {
  approve,
  audit,
  batchOf,
  LEGACY_INDEX,
  PROJECT,
  propose,
  r3World,
  tagsOf,
  type R3World,
} from './helpers.js';

vi.setConfig({ testTimeout: 180_000 });

const P = {
  doc: 'r3doc001',
  docModel: 'r3doc002',
  revExact: 'r3rev001',
  revRenamed: 'r3rev002',
  revMoved: 'r3rev003',
  revTags: 'r3rev004',
} as const;

let w: R3World;
let runId: string;
beforeAll(async () => {
  const names: Record<string, string> = {
    [P.doc]: 'Aaa Doc',
    [P.docModel]: 'Abb Doc Modelled',
    [P.revExact]: 'Rev Exact',
    [P.revRenamed]: 'Rev Renamed',
    [P.revMoved]: 'Rev Moved',
    [P.revTags]: 'Rev Tags',
  };
  w = await r3World(
    Object.entries(names).map(([id, n]) => ({
      id,
      name: `[BSRC] ${n} - Polity Reference`,
      tags: ['Polity', 'CANON'],
    })),
  );
  await w.snapshot();
  runId = (await audit(w, { under: w.desk })).runId as string;
});
afterAll(async () => w?.close());

/** Edits a page's Main document body as the app would (its version moves on). */
function editBody(id: string): string {
  const docId = w.mainOf(id);
  const b = w.repo.blocks.get(docId) ?? { version: 1, blocks: [] };
  w.repo.blocks.set(docId, {
    version: b.version + 1,
    blocks: [
      ...b.blocks,
      { id: `x${b.version}${docId}`.slice(0, 10), kind: 'paragraph', content: [{ text: 'Edited' }] },
    ],
  });
  return docId;
}

describe('the read-back: "documents unchanged"', () => {
  it('RT-80: a document body edited during the job is not reported as "read back exactly"', async () => {
    const p = await propose(w, runId, [P.doc]);
    let edited = false;
    w.overrides.set(new RegExp(`/resources/${P.doc}$`), (req) => {
      if (!edited && req.method === 'PATCH') {
        edited = true;
        editBody(P.doc); // just before the tags write lands: between the fresh read and the read-back
      }
      return undefined;
    });
    await approve(w, p.proposalId);
    const d = batchOf(w, p.proposalId)!.dispositions![P.doc]!;
    expect(edited).toBe(true);
    // SAFE: a body edit made during the job is either noticed or the read-back does not claim documents were compared.
    expect(d, JSON.stringify(d)).not.toMatchObject({
      verified: true,
      reason: 'written and read back exactly',
    });
  });

  it('RT-81 (modelled): with a per-document updatedAt that a content edit moves, the edit is noticed', async () => {
    const stamps = new Map<string, string>();
    const p = await propose(w, runId, [P.docModel]);
    w.overrides.set(new RegExp(`/resources/${P.docModel}$`), (req: MockRequest): MockResponse | undefined => {
      if (req.method === 'PATCH' && !stamps.has('edited')) {
        stamps.set('edited', 'yes');
        stamps.set(editBody(P.docModel), '2026-11-19T12:00:01.000Z');
        return undefined;
      }
      if (req.method !== 'GET') return undefined;
      const res = w.repo.live(P.docModel);
      if (!res) return undefined;
      const view = w.repo.resourceView(res) as { documents: { id: string }[] } & Record<string, unknown>;
      return {
        status: 200,
        body: {
          ...view,
          documents: view.documents.map((d) => ({
            ...d,
            updatedAt: stamps.get(d.id) ?? '2026-11-01T00:00:00.000Z',
          })),
        },
      };
    });
    await approve(w, p.proposalId);
    const d = batchOf(w, p.proposalId)!.dispositions![P.docModel]!;
    expect(d).toMatchObject({ outcome: 'applied', verified: false });
    // CR-2026-11-R3 fix C renamed the comparison "documents' metadata (…) unchanged" (and added the bodies by version).
    expect(d.differences?.join(' ')).toMatch(/documents' metadata .* unchanged|body unchanged/);
  });
});

describe('Revert of a retag batch', () => {
  let jobId: string;
  beforeAll(async () => {
    const p = await propose(w, runId, [P.revExact, P.revRenamed, P.revMoved, P.revTags]);
    const done = await approve(w, p.proposalId);
    expect(done.job?.status).toBe('succeeded');
    jobId = done.jobId!;
    for (const id of [P.revExact, P.revRenamed, P.revMoved, P.revTags])
      expect(tagsOf(w, id)).toEqual(['CANON', 'Polity']);
  });

  it('RT-82: the exact prior array comes back; a page whose tags changed since is never touched', async () => {
    w.repo.outside.setTags(P.revTags, ['CANON', 'Polity', 'Harbour']);
    w.repo.outside.rename(P.revRenamed, '[BSRC] Rev Renamed Since - Polity Reference');
    w.repo.outside.move(P.revMoved, LEGACY_INDEX);
    const rt = w.stack.runtime;
    const first = await rt.reverts.revert('owner', PROJECT, jobId);
    expect(first).toMatchObject({ status: 'refused', code: 'PARTIAL_REVERT_NEEDS_CONFIRMATION' });
    const r = await rt.reverts.revert('owner', PROJECT, jobId, { confirmPartial: true });
    expect(r.status, JSON.stringify(r)).toBe('submitted');
    const revertJob =
      (r as { revertJobId?: string; jobId?: string }).revertJobId ?? (r as { jobId?: string }).jobId;
    await rt.engine.wait(PROJECT, revertJob!, 25_000);
    // The exact prior array, where the page is as the job left it.
    expect(tagsOf(w, P.revExact)).toEqual(['Polity', 'CANON']);
    // Tags changed since: untouched.
    expect(tagsOf(w, P.revTags)).toEqual(['CANON', 'Polity', 'Harbour']);
  });

  // CR-2026-11-R3 (R3-57): OPEN (docs/reviews/CR-2026-11-R3.md section 7), kept as an expected failure: owner decision 5 (ADR 0061): whether "as the job left it" covers a page's name and place, not only its tags.
  it.fails('RT-83: a page renamed or moved since (tags as the job left them) is not touched', () => {
    // SAFE per the claim ("never touches a page changed since"; ADR 0060: "only where the page is as the job left it").
    const seen = { renamed: tagsOf(w, P.revRenamed), moved: tagsOf(w, P.revMoved) };
    expect(seen, JSON.stringify(seen)).toEqual({ renamed: ['CANON', 'Polity'], moved: ['CANON', 'Polity'] });
  });
});

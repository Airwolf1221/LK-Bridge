/**
 * The costs docs/tools.md and the tool descriptions state for v3 F3b's tools (ADR 0052; reads and writes per typical
 * package, every request the call causes included: the planning reads with the pack's governance, the capture, then the
 * job on approval with its checks, Last Major Revision, the verify step and the tree's re-reads), measured against the
 * mock LegendKeeper so the documented numbers stay true.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture } from '../images/world.js';
import { approve } from './world.js';
import { compactPolity, ownerText, ownersWorld, type OwnersWorld } from './owners-world.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await ownersWorld();
});
afterAll(async () => {
  await w?.close();
});

const count = (lines: string[]): [number, number] => [
  lines.filter((l) => l.startsWith('GET')).length,
  lines.filter((l) => !l.startsWith('GET')).length,
];

it('reads and writes per typical package', async () => {
  const got: Record<string, [number, number]> = {};
  const measure = async (label: string, tool: string, args: Record<string, unknown>) => {
    const a = w.seen.length;
    const r = await w.call(tool, args);
    expect(r.isError, `${label}: ${r.text}`).toBe(false);
    got[`${label}: plan`] = count(w.seen.slice(a));
    if (args.dryRun === true || r.body.status !== 'proposal_captured') return;
    const b = w.seen.length;
    const done = await approve(w, String(r.body.proposalId));
    expect(done.job?.status, `${label}: ${JSON.stringify(done.job?.lastError)}`).toBe('succeeded');
    got[`${label}: job`] = count(w.seen.slice(b));
  };
  await measure('compact owner, dry run', 'arkona_create_owner', compactPolity({ dryRun: true }));
  await measure('compact owner, Working', 'arkona_create_owner', compactPolity({ name: 'Cost Kingdom' }));
  await measure('compact owner, Authoritative', 'arkona_create_owner', {
    ...compactPolity({ name: 'Cost Realm', status: 'authoritative' }),
  });
  await measure('promoteNation: index, Reference moved, owner', 'arkona_create_owner', {
    type: 'Institution',
    name: 'Cost Court',
    descriptor: 'Institution Reference',
    nation: 'Sultanate of Tarim',
    home: 'Sultanate of Tarim',
    promoteNation: true,
    status: 'authoritative',
    referenceType: 'Institution Reference',
    scope: 'A court',
    temporalScope: '4A',
    markdown: ownerText('A court.'),
    project: 'test',
  });
  await measure('relationship of two canon characters', 'arkona_create_relationship', {
    a: 'Nadira al-Khalid',
    b: 'Mehrana II al-Khalid',
    scope: 'Cousins',
    markdown: ownerText('Their bond.'),
    project: 'test',
  });
  const staged = await w.call('upload_image', {
    data_base64: fixture('alpha.png').toString('base64'),
    name: 'cost',
    stage: true,
    project: 'test',
  });
  await measure('art: a new Art page with 1 image', 'arkona_add_character_art', {
    character: 'Nadira al-Khalid',
    images: [
      {
        staged_id: String(staged.body.staged_id),
        label: 'Primary Reference - Portrait',
        interpretation: 'Her face.',
      },
    ],
    project: 'test',
  });
  const staged2 = await w.call('upload_image', {
    data_base64: fixture('orientation-6.jpg').toString('base64'),
    name: 'cost2',
    stage: true,
    project: 'test',
  });
  await measure('art: 1 image on an existing Art page', 'arkona_add_character_art', {
    character: 'Nadira al-Khalid',
    images: [
      {
        staged_id: String(staged2.body.staged_id),
        label: 'Detail Reference - Ring',
        interpretation: 'Her ring.',
      },
    ],
    project: 'test',
  });
  await measure('brief', 'arkona_character_brief', { character: 'Nadira al-Khalid', project: 'test' });
  await measure('brief, live', 'arkona_character_brief', {
    character: 'Nadira al-Khalid',
    live: true,
    project: 'test',
  });
  // LegendKeeper changes one sidebar row per request, so a page's facts are most of its writes (an owner page has nine
  // rows to fill and Last Major Revision). The job re-reads the governance (the drift check in the lock), lists the
  // places for the in-job re-checks, then per page: the copy, its rows, its tags, its text and Last Major Revision, and
  // the verify.
  expect(got).toEqual({
    'compact owner, dry run: plan': [4, 0],
    'compact owner, Working: plan': [4, 0],
    'compact owner, Working: job': [20, 13],
    'compact owner, Authoritative: plan': [4, 0],
    'compact owner, Authoritative: job': [18, 13],
    'promoteNation: index, Reference moved, owner: plan': [7, 0],
    'promoteNation: index, Reference moved, owner: job': [31, 16],
    'relationship of two canon characters: plan': [14, 0],
    'relationship of two canon characters: job': [40, 15],
    'art: a new Art page with 1 image: plan': [7, 0],
    'art: a new Art page with 1 image: job': [27, 16],
    'art: 1 image on an existing Art page: plan': [4, 0],
    'art: 1 image on an existing Art page: job': [11, 3],
    'brief: plan': [0, 0],
    'brief, live: plan': [1, 0],
  });
});

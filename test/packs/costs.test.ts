/**
 * The costs docs/tools.md states for v3 F3a's `arkona_create_character` (reads and writes per typical package, every
 * request the call causes included: the planning reads with the pack's governance, the capture, then the job on approval
 * with its checks, Last Major Revision, the verify step and the tree's re-reads), measured against the mock LegendKeeper
 * so the documented numbers stay true.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture } from '../images/world.js';
import { approve, compactPackage, packWorld, type PackWorld } from './world.js';

let w: PackWorld;
beforeAll(async () => {
  w = await packWorld();
});
afterAll(async () => {
  await w?.close();
});

const body = (md: string) =>
  `## Purpose\n\n${md}\n\n## Source Boundaries\n\nThis page only.\n\n## Unresolved Material\n\nNone yet.\n`;
const count = (lines: string[]): [number, number] => [
  lines.filter((l) => l.startsWith('GET')).length,
  lines.filter((l) => !l.startsWith('GET')).length,
];

it('reads and writes per typical package', async () => {
  const got: Record<string, [number, number]> = {};
  const measure = async (label: string, args: Record<string, unknown>) => {
    const a = w.seen.length;
    const r = await w.call('arkona_create_character', args);
    expect(r.isError, `${label}: ${r.text}`).toBe(false);
    got[`${label}: plan`] = count(w.seen.slice(a));
    if (args.dryRun === true) return;
    expect(r.body.status, label).toBe('proposal_captured');
    const b = w.seen.length;
    const done = await approve(w, String(r.body.proposalId));
    expect(done.job?.status, `${label}: ${JSON.stringify(done.job?.lastError)}`).toBe('succeeded');
    got[`${label}: job`] = count(w.seen.slice(b));
  };
  await measure('compact, dry run', compactPackage({ name: 'Cost Dry', dryRun: true }));
  await measure('compact, Working', compactPackage({ name: 'Cost Compact' }));
  await measure('developed, Working: Core, Biography, Relationship', {
    name: 'Cost Developed',
    depth: 'developed',
    identity: {
      givenName: 'Developed',
      surname: 'Cost',
      race: 'Foxian',
      namingCulture: 'Fujimatsuan',
      lifeState: 'Alive at 5A 931',
      temporalScope: '5A 900 - 5A 931',
    },
    pages: [
      { role: 'core', scope: 'Identity', markdown: body('The identity of Cost Developed.') },
      {
        role: 'specialist',
        title: 'Biography',
        specialistTag: 'Biography',
        scope: 'Life',
        markdown: '## Purpose\n\nThe life.\n\n## Early Life\n\nRaised at the shrine.\n',
      },
      { role: 'relationship', with: 'Asagiri Miyabi', scope: 'Their bond', markdown: body('The bond.') },
    ],
    project: 'test',
  });
  const staged = await w.call('upload_image', {
    data_base64: fixture('alpha.png').toString('base64'),
    name: 'cost',
    stage: true,
    project: 'test',
  });
  await measure('add an Art page with 1 image (target, Working)', {
    name: 'Cost Developed',
    target: 'Cost Developed',
    pages: [
      {
        role: 'art',
        scope: 'References',
        markdown: '## Purpose\n\nThe approved references.\n',
        images: [
          {
            staged_id: String(staged.body.staged_id),
            label: 'Primary Reference - Character Portrait',
            interpretation: 'Her face.',
          },
        ],
      },
    ],
    project: 'test',
  });
  // LegendKeeper changes one sidebar row per request, so a page's facts are most of its writes (a Compact Reference
  // has 17 rows). The job re-reads the governance (the drift check in the lock), lists the places for the in-job
  // CHARACTER_EXISTS, then per page: the copy, its rows, its text, its tags and Last Major Revision, and the verify.
  // v3 F12 (ADR 0081): each row update after the first reads its rows for the pre-image Revert needs.
  expect(got).toEqual({
    'compact, dry run: plan': [4, 0],
    'compact, Working: plan': [4, 0],
    'compact, Working: job': [35, 19],
    'developed, Working: Core, Biography, Relationship: plan': [8, 0],
    'developed, Working: Core, Biography, Relationship: job': [88, 46],
    'add an Art page with 1 image (target, Working): plan': [7, 0],
    // CR-2026-11-R2 (R2-14): +1, the character's existing index read inside the lock (where the Working page lands).
    'add an Art page with 1 image (target, Working): job': [37, 16],
  });
});

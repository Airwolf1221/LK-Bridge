/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture } from '../images/world.js';
import { approve } from './world.js';
import { ownerText, ownersWorld, type OwnersWorld } from './owners-world.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await ownersWorld();
});
afterAll(async () => {
  await w?.close();
});
const show = (label: string, x: unknown) => console.log(label, JSON.stringify(x, null, 1).slice(0, 3500));

it('promoteNation', async () => {
  const pkg = {
    type: 'Institution', name: 'Court of Pearls', descriptor: 'Institution Reference', nation: 'Sultanate of Tarim',
    home: 'Sultanate of Tarim', promoteNation: true, status: 'authoritative', referenceType: 'Institution Reference',
    scope: 'The pearl court', temporalScope: '4A 100 - 4A 300', markdown: ownerText('The court.'), project: 'test',
  };
  const dry = await w.call('arkona_create_owner', { ...pkg, dryRun: true });
  show('dry', { tree: dry.body.tree, existing: dry.body.existing, err: dry.body.error, pages: dry.body.pages?.map((p: any) => [p.name, p.indexText]) });
  const p = await w.call('arkona_create_owner', pkg);
  show('prop', p.body);
  const done = await approve(w, String(p.body.proposalId));
  show('job', { err: done.job?.lastError, res: done.job?.result });
  expect(done.job?.status).toBe('succeeded');
});

it('race with navigation', async () => {
  const dry = await w.call('arkona_create_owner', {
    type: 'Species', kind: 'race', name: 'Qilin', home: 'Beastkin - Racial Group Reference', status: 'authoritative',
    scope: 'A horned beastkin people', temporalScope: '1A - 5A', markdown: ownerText('The Qilin.'),
    createCharacterNavigation: true, dryRun: true, project: 'test',
  });
  show('race', { err: dry.body.error, tree: dry.body.tree, tags: dry.body.pages?.map((p: any) => [p.name, p.tags, p.facts]), warnings: dry.body.warnings });
});

it('relationship', async () => {
  const r = await w.call('arkona_create_relationship', { a: 'Nadira al-Khalid', b: 'Mehrana II al-Khalid', scope: 'Cousins', markdown: ownerText('Their bond.'), dryRun: true, project: 'test' });
  show('rel', { err: r.body.error, tree: r.body.tree, existing: r.body.existing, pages: r.body.pages?.map((p: any) => [p.name, p.tags, p.relatedSources]) });
  const p = await w.call('arkona_create_relationship', { a: 'Nadira al-Khalid', b: 'Mehrana II al-Khalid', scope: 'Cousins', markdown: ownerText('Their bond.'), project: 'test' });
  const done = await approve(w, String(p.body.proposalId));
  show('reljob', { err: done.job?.lastError, v: (done.job?.result as any)?.verified });
  const again = await w.call('arkona_create_relationship', { a: 'Mehrana II al-Khalid', b: 'Nadira al-Khalid', scope: 'x', markdown: ownerText('x'), dryRun: true, project: 'test' });
  show('again', again.body.error);
});

it('art', async () => {
  const staged = await w.call('upload_image', { data_base64: fixture('alpha.png').toString('base64'), name: 'n', stage: true, project: 'test' });
  const r = await w.call('arkona_add_character_art', { character: 'Nadira al-Khalid', images: [{ staged_id: staged.body.staged_id, label: 'Primary Reference - Character Portrait', interpretation: 'Her face.' }], dryRun: true, project: 'test' });
  show('art', { err: r.body.error, tree: r.body.tree, assets: r.body.assets, pages: r.body.pages?.map((p: any) => [p.name, p.tags]) });
  const p = await w.call('arkona_add_character_art', { character: 'Nadira al-Khalid', images: [{ staged_id: staged.body.staged_id, label: 'Primary Reference - Character Portrait', interpretation: 'Her face.' }], project: 'test' });
  const done = await approve(w, String(p.body.proposalId));
  show('artjob', { err: done.job?.lastError, v: (done.job?.result as any)?.verified });
  const staged2 = await w.call('upload_image', { data_base64: fixture('orientation-6.jpg').toString('base64'), name: 'n2', stage: true, project: 'test' });
  show('staged2', staged2.body.staged_id ?? staged2.body);
  const r2 = await w.call('arkona_add_character_art', { character: 'Nadira al-Khalid', images: [{ staged_id: staged2.body.staged_id, label: 'Outfit Reference - Court Dress', interpretation: 'Her court dress.', subfolder: 'Outfits / Court Dress' }], project: 'test' });
  show('art2', { err: r2.body.error, st: r2.body.status });
  const done2 = await approve(w, String(r2.body.proposalId));
  show('art2job', { err: done2.job?.lastError, v: (done2.job?.result as any)?.verified, res: (done2.job?.result as any) });
  const brief = await w.call('arkona_character_brief', { character: 'Nadira al-Khalid', project: 'test' });
  show('brief', brief.body);
});

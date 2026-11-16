import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { approve, compactPackage, packWorld, type PackWorld } from './world.js';

let w: PackWorld;
beforeAll(async () => {
  w = await packWorld();
});
afterAll(async () => {
  await w?.close();
});

describe('smoke', () => {
  it('a compact package previews and proposes', async () => {
    const p = await w.call('arkona_create_character', compactPackage({ status: 'authoritative' }));
    expect(p.body.status).toBe('proposal_captured');
    const done = await approve(w, String(p.body.proposalId));
    const res = done.job?.result as { verified?: boolean; verification?: { targets?: { label: string; status: string; differences?: unknown }[] } };
    console.log(done.job?.status, res?.verified, JSON.stringify(res?.verification?.targets?.filter((t) => t.status !== 'verified'), null, 1));
    console.log(JSON.stringify((res?.verification?.targets ?? []).map((t) => `${t.status} ${t.label}`), null, 1));
    const steps = w.stack.runtime.engine.stepResults(PROJECT, done.jobId!) ?? [];
    console.log(steps.map((s) => `${s.stepNo} ${s.status}`).join(', '));
    const page = [...w.repo.res.values()].find((r) => r.name.includes('Asagiri Ren'))!;
    console.log(page.name, page.parentId, page.tags, w.sidebars.rows(page.id).map((r) => `${r.key}=${r.text}`));
    const doc = w.repo.liveDocs(page).find((d) => d.name === 'Main')!;
    console.log(JSON.stringify(w.repo.blocks.get(doc.id)?.blocks?.map((b) => (b as { kind: string }).kind)));
    expect(done.state).toBe('executed');
    expect(res.verified).toBe(true);
  });
});

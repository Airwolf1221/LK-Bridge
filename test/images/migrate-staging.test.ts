/**
 * v3 F2 (ADR 0049 decision 10): `npm run images -- migrate-staging --project <name>` moves the old LegendKeeper staging
 * folder to server staging. An image staged the D3 way (hidden in `LK-Bridge staging`) is copied to the server, its
 * record keeps its staged id, and ONE proposal deletes the hidden asset and then the empty folder. Nothing is deleted
 * without the proposal; running it again is safe.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runImagesCommand } from '../../src/images/cli.js';
import { PROJECT } from '../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from './world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

async function stageTheOldWay(world: ImagesWorld, name: string) {
  const svc = world.stack.runtime.images;
  const plan = svc.planStaging(PROJECT);
  if (!plan.ok) throw new Error(plan.error.message);
  const started = await svc.startUpload({
    projectId: PROJECT,
    image: await svc.convert(fixture('alpha.png')),
    name,
    plan: plan.plan,
    staged: true,
    stageIn: 'legendkeeper',
    source: 'data_base64',
    origin: { kind: 'test' },
  });
  await world.stack.runtime.engine.wait(PROJECT, started.row!.jobId!, 20_000);
  return svc.settle(svc.store.upload(PROJECT, started.row!.id)!);
}

const approve = async (world: ImagesWorld, id: string) => {
  const pol = world.stack.runtime.policy;
  await pol.commands.approve('owner', id);
  for (
    let i = 0;
    i < 300 && !['executed', 'failed', 'conflicted'].includes(pol.proposals.get(id)!.state);
    i++
  )
    await new Promise((r) => setTimeout(r, 20));
  return pol.proposals.get(id)!.state;
};

describe('migrate-staging', () => {
  it('copies to the server, proposes the deletes (never deletes itself), is idempotent, and the folder goes on approval', async () => {
    w = await imagesWorld();
    const svc = w.stack.runtime.images;
    const old = await stageTheOldWay(w, 'Old staged');
    expect(old).toMatchObject({ staged: true, state: 'uploaded' });
    const assetId = old.assetId!;
    const folder = w.assets.at('LK-Bridge staging');

    const first = await svc.migrateStaging(PROJECT, 'owner');
    expect(first).toMatchObject({ folder, copied: [old.id], leftAlone: [] });
    expect(first.proposalId).toMatch(/^prop_/);
    // Nothing deleted yet: only proposed.
    expect(w.assets.assets.has(assetId)).toBe(true);
    expect(w.assets.assets.has(folder)).toBe(true);
    const row = svc.store.upload(PROJECT, old.id)!;
    expect(row).toMatchObject({
      staged: true,
      assetId: null,
      legacyAssetId: assetId,
      serverSha256: old.webp.sha256,
    });
    expect(await svc.stagedImage(PROJECT, old.id)).not.toBeNull();
    expect(w.stack.runtime.policy.proposals.get(first.proposalId!)!.summary).toMatch(/then the empty folder/);

    // Again: nothing copied twice, nothing proposed twice.
    const again = await svc.migrateStaging(PROJECT, 'owner');
    expect(again).toMatchObject({ copied: [], alreadyOnServer: [old.id], proposalId: null });
    expect(again.pendingProposalId).toBe(first.proposalId);

    expect(await approve(w, first.proposalId!)).toBe('executed');
    expect(w.assets.assets.has(assetId)).toBe(false);
    expect(w.assets.assets.has(folder)).toBe(false);
    const third = await svc.migrateStaging(PROJECT, 'owner');
    expect(third).toMatchObject({ folder: null, proposalId: null });
    expect(third.message).toMatch(/nothing to migrate/);

    // The migrated image places from the server like any other.
    const c = await w.stack.connect();
    const placed = await w.stack.call(c, 'upload_image', {
      project: 'test',
      staged_id: old.id,
      destination: { folder: 'Characters / Humans' },
    });
    expect(placed.body).toMatchObject({ status: 'placed', placementVerified: true });
  });

  it('the command writes a request; the running bridge runs it and the command prints what it did', async () => {
    w = await imagesWorld();
    await stageTheOldWay(w, 'Via the CLI');
    const lines: string[] = [];
    const svc = w.stack.runtime.images;
    const tick = setInterval(() => void svc.runMigrationRequests(), 50);
    try {
      const code = await runImagesCommand(
        ['migrate-staging', '--project', 'test'],
        w.stack.dbPath,
        (s) => lines.push(s),
        {
          waitMs: 20_000,
          pollMs: 50,
        },
      );
      expect(code, lines.join('\n')).toBe(0);
    } finally {
      clearInterval(tick);
    }
    expect(lines.join('\n')).toMatch(/Copied to the server: 1/);
    expect(lines.join('\n')).toMatch(/Proposal: prop_/);
  });
});

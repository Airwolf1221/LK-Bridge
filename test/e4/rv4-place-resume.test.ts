/**
 * RV4: placing a staged image (src/images/service.ts `place`, ADR 0041) is ONE job: the missing folders, then
 * `updateAsset` (move, unhide, rename), then a read back. Here the `updateAsset` fails (500, not applied) after the
 * destination folder was created. What is the agent told, and does placing it again finish without a second folder?
 */
import { afterEach, expect, it, vi } from 'vitest';
import { fixture, imagesWorld, type ImagesWorld } from '../images/world.js';

vi.setConfig({ testTimeout: 90_000 });

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});
async function call(world: ImagesWorld, args: Record<string, unknown>) {
  const c = await world.stack.connect();
  return world.stack.call(c, 'upload_image', { project: 'test', ...args });
}

async function stopAfterFolder() {
  w = await imagesWorld();
  const r = await call(w, {
    data_base64: fixture('alpha.png').toString('base64'),
    name: 'Draft',
    stage: true,
    destination: { for_character: { name: 'Asagiri Miyabi', race: 'Foxian' } },
  });
  expect(r.body.status, r.text).toBe('staged');
  const stagedId = String(r.body.staged_id);
  const assetId = (r.body.asset as { id: string }).id;
  w.stack.mock.inject((c) => c.method === 'PATCH' && c.path.includes(`/assets/${assetId}`), {
    kind: 'status',
    status: 500,
    code: 'INTERNAL',
  });
  const first = await call(w, { staged_id: stagedId });
  return { first, stagedId };
}
const named = () =>
  [...w!.assets.assets.values()].filter(
    (a) => (a as { type?: string }).type === 'FOLDER' && (a as { name?: string }).name === 'Asagiri Miyabi',
  );

it('placing again after a stop reuses the folder the stopped job created (passes: sound)', async () => {
  const { first, stagedId } = await stopAfterFolder();
  expect(first.isError, first.text).toBe(true);
  expect(named()).toHaveLength(1);
  const again = await call(w!, { staged_id: stagedId });
  expect(again.body.status, again.text).toBe('placed');
  expect(named()).toHaveLength(1);
});

it('the PLACE_FAILED answer says the folder WAS created (a write was made), not only that the image is still staged', async () => {
  const { first } = await stopAfterFolder();
  expect(named()).toHaveLength(1);
  const e = first.body.error as Record<string, unknown>;
  expect(e.code).toBe('PLACE_FAILED');
  // Safe: the answer lists what was written (as WRITTEN_IN_PART does), e.g. `written: ["create folder …"]`.
  expect(e.written ?? null, first.text).toEqual([
    'create folder Characters / Beastkin / Foxians / Asagiri Miyabi',
  ]);
});

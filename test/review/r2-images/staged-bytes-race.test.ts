/**
 * CR2 images, attack B1 (disk and clean-up of server staging): the staged files are content-addressed and SHARED between
 * records (`ByteStore`, src/images/kept.ts; `serverShaInUse`, src/images/store.ts). A record's file is removed when "no
 * other record needs it" (`dropStaged`, `dropCopy`, `settleServerPlacement` in src/images/service.ts), but staging the
 * same bytes again (`stageOnServer`) decides the file is already there (`ByteStore.put` → `has`) BEFORE its record is
 * inserted. A drop that runs in between (the owner's Discard, the expiry sweep, a placement of the same image in another
 * project, a failed revert's copy) sees no other user and removes the file; the new record then points at nothing.
 *
 * The gate below only fixes the order in which two real event-loop callbacks run (the new staging's `stat` has answered
 * "present"; the owner's discard request is handled before that answer's callback): no code is changed. The safe
 * behaviour: a staged record's bytes are on the server for as long as the record says they are.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEM_PRINCIPAL } from '../../../src/jobs/index.js';
import { PROJECT } from '../../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from '../../images/world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

async function call(world: ImagesWorld, args: Record<string, unknown>) {
  const c = await world.stack.connect();
  return world.stack.call(c, 'upload_image', { project: 'test', ...args });
}

/** Holds the NEXT `stagedBytes.has` answer until `open()` (the answer itself is the real one). */
function gateNextHas(svc: { stagedBytes: { has(sha: string): Promise<boolean> } }) {
  const real = svc.stagedBytes.has.bind(svc.stagedBytes);
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  let reached!: () => void;
  const reachedP = new Promise<void>((r) => (reached = r));
  let armed = true;
  svc.stagedBytes.has = async (sha: string) => {
    const answer = await real(sha);
    if (armed) {
      armed = false;
      reached();
      await opened;
    }
    return answer;
  };
  return { reached: reachedP, open };
}

describe('B1: a staged file shared by two records', () => {
  it('the owner discards an image while the same image is staged again: the new record keeps its bytes', async () => {
    w = await imagesWorld();
    const svc = w.stack.runtime.images;
    const png = fixture('alpha.png').toString('base64');
    const first = await call(w, { data_base64: png, name: 'Kept once', stage: true });
    expect(first.body.status, first.text).toBe('staged');
    const a = svc.store.upload(PROJECT, String(first.body.staged_id))!;

    // The same image staged again on purpose (deduplicate: false, with its own operation_id).
    const gate = gateNextHas(svc);
    const second = call(w, {
      data_base64: png,
      name: 'Kept twice',
      stage: true,
      deduplicate: false,
      operation_id: 'again-1',
    });
    await gate.reached; // its `stat` said the file is there; its record is not inserted yet
    // The owner's Discard of the first copy (the dashboard route calls exactly this).
    const d = await svc.discard({
      projectId: PROJECT,
      row: a,
      origin: { kind: 'ui', tool: 'staging.discard', principal: SYSTEM_PRINCIPAL },
      by: 'owner',
    });
    expect(d).toEqual({ status: 'discarded' });
    gate.open();
    const b = await second;
    expect(b.body.status, b.text).toBe('staged');
    const bId = String(b.body.staged_id);
    expect(svc.store.upload(PROJECT, bId)).toMatchObject({ staged: true, serverSha256: a.serverSha256 });
    // Safe: the record that says its bytes are on the server has them (thumbnail, and placing it later).
    expect(await svc.stagedImage(PROJECT, bId), 'the staged bytes of the new record').not.toBeNull();
    const placed = await call(w, { staged_id: bId, destination: { folder: 'Characters / Humans' } });
    expect(placed.body.status, placed.text).toBe('placed');
  });

  it('the expiry sweep removes an old copy while the same image is staged again: the new record keeps its bytes', async () => {
    w = await imagesWorld();
    const svc = w.stack.runtime.images;
    const webp = fixture('already.webp').toString('base64');
    const first = await call(w, { data_base64: webp, name: 'Old copy', stage: true });
    const oldId = String(first.body.staged_id);
    // Past its project's maximum age and warned more than a week ago: the next sweep removes it.
    w.stack.db
      .prepare('UPDATE image_uploads SET created_at = ?, expiry_warned_at = ? WHERE id = ?')
      .run(Date.now() - 100 * 86_400_000, Date.now() - 8 * 86_400_000, oldId);
    const gate = gateNextHas(svc);
    const second = call(w, {
      data_base64: webp,
      name: 'New copy',
      stage: true,
      deduplicate: false,
      operation_id: 'again-2',
    });
    await gate.reached;
    expect(await svc.expireStaged([PROJECT])).toEqual({ warned: 0, removed: 1 });
    gate.open();
    const b = await second;
    expect(b.body.status, b.text).toBe('staged');
    expect(await svc.stagedImage(PROJECT, String(b.body.staged_id)), 'the new record’s bytes').not.toBeNull();
  });
});

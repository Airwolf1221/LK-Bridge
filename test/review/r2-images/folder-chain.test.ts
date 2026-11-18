/**
 * CR2 images, attacks E2 to E4 (find-or-create folders under concurrency, and an image placed into the wrong folder).
 *
 * - E2: FOUR placements into one missing two-level chain, by every route that plans folders (a direct `upload_image`
 *   job, a server-staged placement, an approved proposal, the dashboard's Place), all released at once. Safe: one chain,
 *   every image in its last folder.
 * - E3: folder names that LOOK the same and are not the same bytes (NFC and NFD "é", a zero-width space): the planner
 *   and the job's find (src/jobs/step-exec.ts `findFolder`: `x.name === body.name`) compare bytes, so two agents
 *   writing one name make two folders that show identically. Safe: one folder (or a refusal naming the look-alike).
 * - E4: `for_character` reused "a folder named after the character wherever it is" (ADR 0041): an agent at scope write
 *   made a decoy folder of that name under a folder of its choosing first; every later image of the character went
 *   there. Safe: an image for a character goes under Characters (or the placement is refused as ambiguous). ADR 0057
 *   decision 8 makes it so: the exact path only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_CSRF_PURPOSE } from '../../../src/admin/guard.js';
import { PROJECT, PUBLIC_URL } from '../../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from '../../images/world.js';
import sharp from 'sharp';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const call = async (world: ImagesWorld, args: Record<string, unknown>, token?: string) =>
  world.stack.call(await world.stack.connect(token), 'upload_image', { project: 'test', ...args });
const png = async (i: number) =>
  (
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 30 * i, g: 90, b: 7 * i } } })
      .png()
      .toBuffer()
  ).toString('base64');
const foldersNamed = (world: ImagesWorld, test: (n: string) => boolean) =>
  [...world.assets.assets.values()].filter((a) => a.type === 'FOLDER' && test(String(a.name)));

function ownerPost(world: ImagesWorld) {
  const s = world.stack.services;
  const session = s.owner.createSession('127.0.0.1', 'vitest');
  const csrf = s.owner.csrfToken(session, ADMIN_CSRF_PURPOSE);
  return async (path: string, body: unknown) => {
    const res = await fetch(`${world.stack.base}/api/admin${path}`, {
      method: 'POST',
      headers: {
        cookie: `${s.owner.sessionCookie}=${session}`,
        origin: PUBLIC_URL,
        'x-csrf-token': csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
}

describe('E2: four routes, one missing chain, all at once', () => {
  it('one chain; all four images in its last folder', { timeout: 60_000 }, async () => {
    w = await imagesWorld();
    const dest = { folder: 'Characters / Beastkin / Qishen / Quad / Inner' };
    const engine = w.stack.runtime.engine;
    // Staged images for the staged routes (staging itself writes nothing to LegendKeeper).
    const s1 = String(
      (await call(w, { data_base64: await png(1), name: 'Staged one', stage: true })).body.staged_id,
    );
    const s2 = String(
      (await call(w, { data_base64: await png(2), name: 'Staged two', stage: true })).body.staged_id,
    );
    const s3 = String(
      (await call(w, { data_base64: await png(3), name: 'Staged three', stage: true })).body.staged_id,
    );
    const { token } = w.stack.newToken('proposer', 'propose');
    const proposal = await call(w, { staged_id: s3, destination: dest }, token);
    expect(proposal.body.status, proposal.text).toBe('proposal_captured');
    engine.controls.pauseWrites('test');
    const svc = w.stack.runtime.images;
    const directP = call(w, { data_base64: await png(4), name: 'Direct', destination: dest, waitSeconds: 0 });
    const stagedP = call(w, { staged_id: s1, destination: dest, waitSeconds: 0 });
    // The dashboard route waits for its job: not awaited until writes resume.
    const dashboardP = ownerPost(w)(`/staging/${s2}/place?project=test`, { destination: dest });
    const [direct, staged] = await Promise.all([directP, stagedP]);
    for (let i = 0; i < 200 && !svc.store.upload(PROJECT, s2)?.placementJobId; i++)
      await new Promise((r) => setTimeout(r, 10));
    // Approval is refused while writes are paused: approved the moment they resume, so its job starts with the rest.
    engine.controls.resumeWrites('test');
    await w.stack.runtime.policy.commands.approve('owner', String(proposal.body.proposalId));
    const dashboard = await dashboardP;
    const pol = w.stack.runtime.policy.proposals;
    const ends = new Set(['succeeded', 'failed', 'cancelled']);
    for (let i = 0; i < 400; i++) {
      const done = ['executed', 'failed', 'conflicted'].includes(
        pol.get(String(proposal.body.proposalId))!.state,
      );
      const jobs = [direct.body.jobId, staged.body.jobId].filter((j): j is string => typeof j === 'string');
      if (done && jobs.every((j) => ends.has(engine.queries.getJob(PROJECT, j)!.status))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(dashboard.status, JSON.stringify(dashboard.json)).toBe(200);
    const quad = foldersNamed(w, (n) => n === 'Quad');
    const inner = foldersNamed(w, (n) => n === 'Inner');
    expect(quad, 'Quad').toHaveLength(1);
    expect(inner, 'Inner').toHaveLength(1);
    const images = [...w.assets.assets.values()].filter(
      (a) => a.type === 'IMAGE' && a.folderId === inner[0]!.id,
    );
    expect(images.map((a) => a.name).sort()).toEqual(['Direct', 'Staged one', 'Staged three', 'Staged two']);
  });
});

describe('E3: names that look the same', () => {
  it.each([
    ['NFC and NFD', 'Café', 'Café'],
    ['a zero-width space', 'Wardrobe', 'Ward​robe'],
    ['a no-break space', 'Dress Uniform', 'Dress Uniform'],
  ])('%s: one folder, not two that show the same', async (_what, a, b) => {
    w = await imagesWorld();
    const first = await call(w, {
      data_base64: await png(1),
      name: 'First',
      destination: { folder: `Characters / ${a}` },
    });
    expect(first.body.status, first.text).toBe('uploaded');
    const second = await call(w, {
      data_base64: await png(2),
      name: 'Second',
      destination: { folder: `Characters / ${b}` },
    });
    const looksAlike = foldersNamed(
      w,
      (n) =>
        n
          .normalize('NFKC')
          .replace(/\u200b/g, '')
          .replace(/\u00a0/g, ' ') === a,
    );
    const refused = (second.body.error as { code?: string } | undefined)?.code;
    expect(
      { folders: looksAlike.length, second: refused ?? String(second.body.status) },
      `${JSON.stringify(looksAlike.map((f) => f.name))}`,
    ).toSatisfy((x: { folders: number; second: string }) => x.folders === 1);
  });
});

describe('E4: a decoy folder named after a character', () => {
  // ADR 0057 decision 8 (R2-46): the art folder is resolved only from the character's exact path under Characters.
  it('an image for_character goes under Characters, not into a folder another agent named after the character', async () => {
    w = await imagesWorld();
    const c = await w.stack.connect();
    // Another agent, at scope write, makes a folder named after a character (whose real folder does not exist yet).
    const junk = await w.stack.call(c, 'lk_api_write', {
      project: 'test',
      operationId: 'createAssetFolder',
      params: { body: { name: 'Junk' } },
    });
    const junkId = String((junk.body.result as { id?: string } | undefined)?.id ?? junk.body.id ?? '');
    const decoy = await w.stack.call(c, 'lk_api_write', {
      project: 'test',
      operationId: 'createAssetFolder',
      params: { body: { name: 'Asagiri Miyabi', ...(junkId ? { folderId: junkId } : {}) } },
    });
    expect(decoy.isError, decoy.text).toBe(false);
    await w.stack.runtime.assets.refresh?.(PROJECT, 'test').catch(() => undefined);
    const r = await call(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Miyabi portrait',
      destination: { for_character: { name: 'Asagiri Miyabi', race: 'Foxian' } },
      dryRun: true,
    });
    const path = (r.body.destination as { path?: string[] } | undefined)?.path ?? [];
    expect(path[0], JSON.stringify(r.body.destination ?? r.body.error)).toBe('Characters');
  });
});

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v2 E1a (ADR 0042), opt-in: snapshots, restores and the rehearsal on a REAL sandbox project (see test/sandbox/README.md,
 * "Snapshots (v2 E1a)"): `deploy/sandbox-test.sh --project test -- snapshots`. It WRITES, then cleans up everything it
 * made. Each check prints PASS, FAIL or INCONCLUSIVE with its cost (requests to LegendKeeper).
 *
 * The sandbox runtime is the bridge's own (createSoakRuntime): a temporary database and a snapshot store inside its own
 * temporary directory. Its AI REPOSITORY is set, in that temporary database only, to the throwaway root this script
 * creates, so the full snapshot, the restores and the rehearsal see exactly that subtree and nothing else of the test
 * world (the asset library excepted: a full snapshot takes all of it, downloads from the asset host, no API budget).
 *
 * 1. Setup: `lk-bridge snapshots <time>` at the top level, with a link target and a page holding a page document
 *    (heading, a mention, the image, a meter block: a keep region), a map (the image as its MapImage, a folder, a pin,
 *    a region), a timeline (a lane, an event; the first calendar of the project), a board (one shape), and a sidebar
 *    (key-value rows, a collection linking the target). One generated PNG.
 * 2. S: a full snapshot (the subtree and the asset library); its reads per page.
 * 3. R: each piece is edited, then restored from the snapshot (a proposal, approved here as the owner would) and read
 *    back: the stored piece must hash exactly as the snapshot's.
 * 4. D1: a page deleted, then undeleted within LegendKeeper's soft delete (restoreResource, then its content).
 *    D2: a page made, deleted, and recreated from the snapshot alone: whether LegendKeeper took its ORIGINAL id
 *    (noted either way; refused, it is recreated with a new id).
 * 5. U.a–U.e: whether `updatedAt` moves on the resource (listResources: what the daily pass reads) or only on the
 *    document (listDocuments: the pass's `snapshotDailyPassDocuments` option) when a block, a sidebar row, a map
 *    feature, a timeline event or the board content changes. PASS: the resource's moved (the cheap pass sees it).
 *    INCONCLUSIVE: only the document's moved (the pass needs the documents option). FAIL: neither moved (only the
 *    weekly full snapshot sees this kind of edit). This decides whether the daily pass can be switched on.
 * 6. H: a sampled rehearsal of the subtree's snapshot into its own throwaway root, compared, then deleted.
 * 7. Clean-up: the root (cascade), the image; a 404 or "already deleted" counts as cleaned once a read says so.
 *
 * Every write goes through test/sandbox/wait.ts (`runSettled` for a single operation, `waitForJob` for a job: a write
 * parked for budget or queued is waited for, never sent again). The restore proposals' jobs and the rehearsal's own
 * jobs are waited for the same way (the rehearsal waits for each of its jobs itself and never resends one).
 */
import sharp from 'sharp';
import type { Db } from '../../src/db/open.js';
import { ProjectStore } from '../../src/projects/index.js';
import type { Runtime } from '../../src/runtime.js';
import { pieceHash, sidebarPiece } from '../../src/snapshots/canonical.js';
import { documentPieceOf } from '../../src/snapshots/capture.js';
import { renderDocument } from '../../src/snapshots/diff.js';
import type { Manifest } from '../../src/snapshots/manifest.js';
import type { RestoreInput } from '../../src/snapshots/restore.js';
import type { Finding, Verdict } from './smoke.js';
import type { HttpCounters } from './soak.js';
import { runSettled, waitForJob, type WaitOptions } from './wait.js';

type Obj = Record<string, any>;

export interface SnapshotsTarget {
  readonly runtime: Runtime;
  /** The runtime's own (temporary) database: the rehearsal's stand-in source project is registered there only. */
  readonly db: Db;
  readonly projectId: string;
  readonly counters: HttpCounters;
}

export interface SnapshotsOptions {
  readonly wait?: WaitOptions;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The pause between the read before an edit and the edit, so a timestamp can move (default 1.5 s). */
  readonly updatedAtGapMs?: number;
}

export interface SnapshotsReport {
  readonly findings: Finding[];
  /** What each phase cost, for the summary. */
  readonly costs: Record<string, { reads: number; writes: number }>;
}

class Fails extends Error {}
class Unclear extends Error {}

/** A small PNG (the image of the page and of the map). */
async function png(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 30, g: 90, b: 160 } } })
    .png()
    .toBuffer();
}

export async function runSnapshotsSandbox(
  t: SnapshotsTarget,
  o: SnapshotsOptions = {},
): Promise<SnapshotsReport> {
  const rt = t.runtime;
  const pid = t.projectId;
  const svc = rt.snapshots;
  const findings: Finding[] = [];
  const costs: SnapshotsReport['costs'] = {};
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const wait: WaitOptions = { ...(o.sleep ? { sleep: o.sleep } : {}), ...o.wait };
  const origin = { kind: 'test' as const, client: 'sandbox-snapshots', tool: 'sandbox-snapshots' };
  const record = (id: string, title: string, verdict: Verdict, detail: string) =>
    findings.push({ id, title, verdict, detail });
  const mark = () => ({ r: t.counters.reads, w: t.counters.writes });
  const spent = (b: { r: number; w: number }) => ({
    reads: t.counters.reads - b.r,
    writes: t.counters.writes - b.w,
  });
  const costText = (b: { r: number; w: number }) => {
    const s = spent(b);
    return `cost: ${s.reads} reads, ${s.writes} writes`;
  };
  const check = async (id: string, title: string, fn: () => Promise<string>) => {
    const before = mark();
    try {
      record(id, title, 'pass', `${await fn()}; ${costText(before)}`);
    } catch (e) {
      const verdict: Verdict = e instanceof Fails ? 'fail' : 'inconclusive';
      const why =
        e instanceof Fails || e instanceof Unclear
          ? e.message
          : `could not complete: ${(e as Error).message}`;
      record(id, title, verdict, `${why}; ${costText(before)}`);
    }
    costs[id] = spent(before);
  };
  /** One governed call at P1, settled (wait.ts). Every single write of this script goes through here. */
  const run = async (op: string, params: Obj = {}, extra: Obj = {}): Promise<any> =>
    runSettled(
      { engine: rt.engine, projectId: pid },
      op,
      params,
      { origin, priority: 'P1', project: pid, ...extra },
      wait,
    );
  const attempt = async (op: string, params: Obj = {}) => {
    try {
      return { ok: true as const, body: await run(op, params) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  };
  /** Approves a restore proposal as the owner does on the Proposals page, and waits for its job (wait.ts). */
  const approve = async (proposalId: string, what: string) => {
    await rt.policy.commands.approve('owner', proposalId);
    let jobId: string | null = null;
    for (let i = 0; i < 100 && !jobId; i++) {
      jobId = rt.policy.proposals.get(proposalId)?.jobId ?? null;
      if (!jobId) await sleep(100);
    }
    if (!jobId) throw new Error(`${what}: the approved proposal started no job`);
    await waitForJob(rt.engine, pid, jobId, what, wait);
    for (let i = 0; i < 100 && rt.policy.proposals.get(proposalId)?.state !== 'executed'; i++)
      await sleep(100);
    const state = rt.policy.proposals.get(proposalId)?.state;
    if (state !== 'executed') throw new Fails(`${what}: the proposal ended ${state ?? 'unknown'}`);
  };
  const propose = async (input: Omit<RestoreInput, 'projectId'>, what: string) => {
    const r = await rt.restores.propose({ projectId: pid, ...input }, origin, 'sandbox-snapshots');
    if (r.status !== 'proposal_captured')
      throw new Fails(`${what}: nothing to restore (the page already matched)`);
    return r;
  };
  const read = svc.reader(pid, 'P1');
  /** A piece of the page as LegendKeeper holds it now, hashed as a snapshot hashes it. */
  const liveDoc = async (pageId: string, docId: string) => {
    const res = (await read('getResource', { path: { resourceId: pageId } })) as Obj;
    const doc = (res.documents as Obj[]).find((d) => d.id === docId);
    if (!doc) throw new Fails(`document ${docId} is not on the page`);
    const piece = await documentPieceOf(read, pageId, doc);
    return { piece, sha: pieceHash(piece).sha256 };
  };
  const liveSidebar = async (pageId: string) => {
    const res = (await read('getResource', { path: { resourceId: pageId } })) as Obj;
    return pieceHash(sidebarPiece(res.properties ?? [])).sha256;
  };

  // ---- guard: the key must belong to exactly this project --------------------------------------------------------
  const projects = (await run('listProjects')) as { data?: { id: string }[] };
  const ids = (projects.data ?? []).map((x) => x.id);
  if (ids.length !== 1 || ids[0] !== pid)
    throw new Error(`Refusing to run: the key's projects are [${ids.join(', ')}], not exactly ${pid}.`);

  const stamp = new Date().toISOString();
  const base = `lk-bridge snapshots ${stamp}`;
  const made: { pages: string[]; assets: string[] } = { pages: [], assets: [] };
  const set = { page: false, sidebar: false, map: false, time: false, board: false, image: false };
  const docs: {
    page?: string | undefined;
    map?: string | undefined;
    time?: string | undefined;
    board?: string | undefined;
  } = {};
  const ids2: { pin?: string; region?: string; event?: string; lane?: string; kv?: string; row?: string } =
    {};
  let rootId = '';
  let pageId = '';
  let linkId = '';
  let image: { id: string; url: string } | null = null;
  let manifest: Manifest | null = null;

  try {
    // ================================================================================================ 1. setup
    await check('setup', 'a throwaway subtree with every document type, an image and a sidebar', async () => {
      const root = await run('createResource', { body: { name: base } });
      rootId = root.id as string;
      made.pages.push(rootId);
      // The AI REPOSITORY of the sandbox runtime's own (temporary) database: the throwaway root, and its tree.
      rt.projects.setSetting(pid, 'aiRepositoryRootId', rootId);
      const link = await run('createResource', { body: { name: `${base} link target`, parentId: rootId } });
      linkId = link.id as string;
      const page = await run('createResource', { body: { name: `${base} page`, parentId: rootId } });
      pageId = page.id as string;
      const notes: string[] = [];

      // The image (an ordinary upload job, waited for).
      const bytes = await png();
      const up = await rt.engine.submit({
        project: pid,
        kind: 'upload_image',
        contentType: 'image/png',
        contentLength: bytes.length,
        dataBase64: bytes.toString('base64'),
        name: `${base} image`,
        origin,
        priority: 'P1',
      });
      if ('jobId' in up) {
        const job = await waitForJob(rt.engine, pid, up.jobId, 'the image upload', wait);
        const asset = (job.result as Obj).asset as Obj;
        image = { id: String(asset.id), url: String(asset.url) };
        made.assets.push(image.id);
        set.image = true;
      } else notes.push('the image upload was not queued');

      // The documents.
      const doc = async (type: string, name: string, extra: Obj = {}) => {
        const r = await attempt('createDocument', {
          path: { resourceId: pageId },
          body: { name, type, ...extra },
        });
        if (!r.ok) notes.push(`${type} document: ${r.error}`);
        return r.ok ? String(r.body.id) : undefined;
      };
      docs.page = await doc('page', 'Main text');
      docs.map = await doc('map', 'Map');
      const cals = await attempt('listCalendars', {});
      const calendarId = cals.ok ? (cals.body?.data?.[0]?.id as string | undefined) : undefined;
      docs.time = calendarId ? await doc('time', 'Chronicle', { calendarId }) : undefined;
      if (!calendarId) notes.push('no calendar in the project: no timeline');
      docs.board = await doc('board', 'Plot');

      if (docs.page) {
        const blocks = [
          { kind: 'heading', level: 1, content: [{ text: 'Snapshot test' }] },
          {
            kind: 'paragraph',
            content: [{ text: 'Links to ' }, { mention: { resourceId: linkId } }, { text: '.' }],
          },
          ...(image ? [{ kind: 'image', url: image.url, alt: 'The test image' }] : []),
          { kind: 'meter', mode: 'bar', items: [{ name: 'Courage', icon: 'heart', current: 3, max: 10 }] },
          { kind: 'paragraph', content: [{ text: 'First notes.' }] },
        ];
        const r = await attempt('replaceDocumentBlocks', {
          path: { resourceId: pageId, documentId: docs.page },
          body: { blocks },
        });
        if (r.ok) set.page = true;
        else notes.push(`page blocks: ${r.error}`);
      }
      const kv = await attempt('createProperty', {
        path: { resourceId: pageId },
        body: {
          kind: 'keyValue',
          title: 'Facts',
          rows: [
            { key: 'Region', text: 'North' },
            { key: 'Colour', text: 'Blue' },
          ],
        },
      });
      const coll = await attempt('createProperty', {
        path: { resourceId: pageId },
        body: { kind: 'resourceCollection', title: 'Links', items: [{ resourceId: linkId }] },
      });
      if (kv.ok && coll.ok) {
        set.sidebar = true;
        ids2.kv = String(kv.body.id);
        ids2.row = String((kv.body.rows as Obj[])?.[0]?.id ?? '');
      } else notes.push(`sidebar: ${kv.ok ? '' : kv.error} ${coll.ok ? '' : coll.error}`.trim());
      if (docs.map && image) {
        const path = { resourceId: pageId, documentId: docs.map };
        const r1 = await attempt('updateDocument', { path, body: { mapImage: { assetId: image.id } } });
        const f = await attempt('createFeature', {
          path,
          body: { type: 'folder', name: 'Towns', rank: 'a0' },
        });
        const pin = await attempt('createFeature', {
          path,
          body: {
            type: 'pin',
            name: 'Ashgate',
            pos: [-10, 20],
            rank: 'a1',
            ...(f.ok ? { parentId: f.body.id } : {}),
          },
        });
        const region = await attempt('createFeature', {
          path,
          body: {
            type: 'region',
            name: 'The Sea',
            polygon: [
              [-1, 1],
              [-2, 2],
              [-3, 1],
            ],
            color: '#336699',
            rank: 'a2',
          },
        });
        if (r1.ok && f.ok && pin.ok && region.ok) {
          set.map = true;
          ids2.pin = String(pin.body.id);
          ids2.region = String(region.body.id);
        } else
          notes.push(
            `map: ${[r1, f, pin, region]
              .filter((x) => !x.ok)
              .map((x) => (x as { error: string }).error)
              .join('; ')}`,
          );
      }
      if (docs.time) {
        const path = { resourceId: pageId, documentId: docs.time };
        const lane = await attempt('createLane', { path, body: { name: 'Events', rank: 'a0', size: 'sm' } });
        const ev = lane.ok
          ? await attempt('createEvent', {
              path,
              body: {
                laneId: lane.body.id,
                type: 'event',
                name: 'Founding',
                start: 1000,
                end: 1000,
                detail: 1,
              },
            })
          : lane;
        if (lane.ok && ev.ok) {
          set.time = true;
          ids2.lane = String(lane.body.id);
          ids2.event = String(ev.body.id);
        } else notes.push(`timeline: ${(ev as { error?: string }).error ?? ''}`);
      }
      if (docs.board) {
        const r = await attempt('createBoardShapes', {
          path: { resourceId: pageId, documentId: docs.board },
          body: { shapes: [{ type: 'geo', x: 0, y: 0, props: { geo: 'rectangle', w: 120, h: 80 } }] },
        });
        if (r.ok) set.board = true;
        else notes.push(`board: ${r.error}`);
      }

      // The tree of the throwaway root (a few reads), so restores and the snapshot see the subtree.
      rt.tree.prepareBuild(pid, { trigger: 'sandbox-snapshots', autoConfirm: true });
      for (let i = 0; i < 600 && rt.tree.store.activePass(pid); i++) await sleep(500);
      const status = rt.tree.meta(pid).status;
      const missing = Object.entries(set)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      if (missing.length === Object.keys(set).length)
        throw new Fails(`nothing could be set up: ${notes.join('; ')}`);
      return `root ${rootId}, page ${pageId}; set up: ${Object.entries(set)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(
          ', ',
        )}${missing.length ? `; NOT set up: ${missing.join(', ')} (${notes.join('; ')})` : ''}; tree ${status}`;
    });
    if (!pageId) return { findings, costs };

    // ================================================================================================ 2. the snapshot
    await check('S', 'a full snapshot of the subtree and the asset library', async () => {
      const r = await svc.full(pid, 'sandbox-snapshots');
      if (!r.snapshotId) throw new Fails(r.summary);
      manifest = await svc.manifest(r.snapshotId);
      if (!manifest) throw new Fails('its manifest could not be read');
      const entry = manifest.pages.find((p) => p.id === pageId);
      if (!entry) throw new Fails('the page is not in the manifest');
      if (manifest.counts.missing > 0)
        throw new Fails(`${manifest.counts.missing} pieces are missing: partial`);
      const img = image;
      if (img && !manifest.library?.images.some((i) => i.url === img.url && i.sha256))
        throw new Fails('the uploaded image is not in the library with its bytes');
      return `${manifest.id}: ${manifest.pages.length} pages, ${manifest.counts.reads} reads (${(
        manifest.counts.reads / Math.max(1, manifest.pages.length)
      ).toFixed(
        2,
      )} a page, the library included), ${manifest.counts.downloads} downloads, ${manifest.library?.images.length ?? 0} images in the library`;
    });
    const snap = manifest as Manifest | null;
    if (!snap) return { findings, costs };
    const entry = snap.pages.find((p) => p.id === pageId)!;
    const docSha = (id: string | undefined) => entry.documents?.find((d) => d.id === id)?.sha256;

    // ================================================================================================ 3. edit, restore
    const restoreDoc = async (key: 'page' | 'map' | 'time' | 'board', edit: () => Promise<void>) => {
      const id = docs[key]!;
      await edit();
      const changed = await liveDoc(pageId, id);
      if (changed.sha === docSha(id)) throw new Unclear('the edit did not change the stored document');
      const r = await propose(
        { pageId, snapshotId: snap.id, scope: 'document', documentId: id },
        `restore ${key}`,
      );
      await approve(r.proposalId, `the ${key} restore`);
      const back = await liveDoc(pageId, id);
      if (back.sha !== docSha(id))
        throw new Fails(
          `read back, the ${key} document differs from the snapshot: ${renderDocument(back.piece as never).slice(0, 300)}`,
        );
      return `proposal ${r.proposalId} approved; the document reads back exactly as in the snapshot${
        r.plan.lost.length
          ? ` (${r.plan.lost.length} listed as lost: ${r.plan.lost.map((l) => l.what).join(', ')})`
          : ''
      }`;
    };
    if (set.page)
      await check(
        'R.page',
        'a page document edited, then restored (blocks, the keep region, the image)',
        () =>
          restoreDoc('page', async () => {
            const cur = await run('getDocumentBlocks', {
              path: { resourceId: pageId, documentId: docs.page },
            });
            const blocks = (cur.blocks as Obj[]).map((b) =>
              b.kind === 'paragraph' && JSON.stringify(b.content).includes('First notes.')
                ? { ...b, content: [{ text: 'Notes rewritten.' }] }
                : b,
            );
            await run('replaceDocumentBlocks', {
              path: { resourceId: pageId, documentId: docs.page },
              body: { blocks: blocks.filter((b) => b.kind !== 'meter') },
            });
          }),
      );
    if (set.map)
      await check('R.map', 'a map edited (a pin renamed, a region deleted), then restored', () =>
        restoreDoc('map', async () => {
          const path = { resourceId: pageId, documentId: docs.map };
          await run('updateFeature', {
            path: { ...path, featureId: ids2.pin },
            body: { name: 'Ashgate (moved)' },
          });
          await run('deleteFeature', { path: { ...path, featureId: ids2.region } });
        }),
      );
    if (set.time)
      await check('R.time', 'a timeline edited (an event renamed), then restored', () =>
        restoreDoc('time', async () => {
          await run('updateEvent', {
            path: { resourceId: pageId, documentId: docs.time, eventId: ids2.event },
            body: { name: 'Founding (edited)' },
          });
        }),
      );
    if (set.board)
      await check('R.board', 'a board edited (a shape added), then restored', () =>
        restoreDoc('board', async () => {
          await run('createBoardShapes', {
            path: { resourceId: pageId, documentId: docs.board },
            body: { shapes: [{ type: 'geo', x: 200, y: 0, props: { geo: 'ellipse', w: 60, h: 60 } }] },
          });
        }),
      );
    if (set.sidebar)
      await check('R.sidebar', 'a sidebar row edited, then the sidebar restored', async () => {
        await run('updatePropertyRow', {
          path: { resourceId: pageId, propertyId: ids2.kv, rowId: ids2.row },
          body: { text: 'South' },
        });
        if ((await liveSidebar(pageId)) === entry.sidebar?.sha256)
          throw new Unclear('the edit changed nothing');
        const r = await propose({ pageId, snapshotId: snap.id, scope: 'sidebar' }, 'restore the sidebar');
        await approve(r.proposalId, 'the sidebar restore');
        if ((await liveSidebar(pageId)) !== entry.sidebar?.sha256)
          throw new Fails('read back, the sidebar differs from the snapshot');
        return `proposal ${r.proposalId} approved; the sidebar reads back exactly as in the snapshot`;
      });

    // ================================================================================================ 4. deleted pages
    await check(
      'D1',
      'a page deleted, then undeleted within the soft delete, and its content back',
      async () => {
        await run('deleteResource', { path: { resourceId: linkId } });
        await svc.settled();
        const r = await propose(
          { pageId: linkId, snapshotId: snap.id, scope: 'deleted', mode: 'undelete' },
          'undelete',
        );
        await approve(r.proposalId, 'the undelete');
        // The second proposal (its content back to the snapshot) follows the first once it has run.
        let follow: string | null = null;
        let note = '';
        for (let i = 0; i < 300; i++) {
          const rec = rt.restores.byProposal(r.proposalId);
          follow = rec?.followUpProposalId ?? null;
          note = rec?.followUp ?? '';
          if (follow || /already|not proposed/.test(note)) break;
          await sleep(200);
        }
        if (follow) await approve(follow, 'the content restore');
        const res = (await read('getResource', { path: { resourceId: linkId } })) as Obj | undefined;
        if (!res || res.deletedAt != null) throw new Fails('the page is still deleted');
        return `undeleted (proposal ${r.proposalId})${follow ? `, content proposal ${follow} approved` : `; content: ${note || 'none needed'}`}`;
      },
    );
    await check(
      'D2',
      'a page recreated from the snapshot alone (its original id, if LegendKeeper takes it)',
      async () => {
        const c = await run('createResource', { body: { name: `${base} recreated`, parentId: rootId } });
        const cid = String(c.id);
        const textDoc = (await run('createDocument', {
          path: { resourceId: cid },
          body: { name: 'Text', type: 'page' },
        })) as Obj;
        await run('replaceDocumentBlocks', {
          path: { resourceId: cid, documentId: textDoc.id },
          body: {
            blocks: [
              { kind: 'heading', level: 2, content: [{ text: 'Recreated' }] },
              { kind: 'paragraph', content: [{ text: 'From the snapshot alone.' }] },
            ],
          },
        });
        // The change snapshots of the writes above hold the page: the restore is planned from them alone.
        await svc.settled();
        const before = svc.index.pageHistory(pid, cid, { limit: 20 }).find((x) => x.piece !== 'deleted');
        if (!before) throw new Unclear('no snapshot holds the new page');
        const textBefore = await (async () => {
          const res = (await read('getResource', { path: { resourceId: cid } })) as Obj;
          const d = (res.documents as Obj[]).find((x) => x.name === 'Text')!;
          return renderDocument((await documentPieceOf(read, cid, d)) as never);
        })();
        await run('deleteResource', { path: { resourceId: cid } });
        await svc.settled();
        const attemptRecreate = async (ids: 'original' | 'new') => {
          const r = await propose(
            { pageId: cid, snapshotId: before.snapshotId, scope: 'deleted', mode: 'recreate', ids },
            `recreate (${ids} ids)`,
          );
          try {
            await approve(r.proposalId, `the recreate (${ids} ids)`);
            return { ok: true as const, newId: r.plan.idMap?.[cid] ?? cid };
          } catch (e) {
            return { ok: false as const, why: (e as Error).message };
          }
        };
        let got = await attemptRecreate('original');
        let idNote = `LegendKeeper TOOK the original id ${cid}`;
        if (!got.ok) {
          idNote = `LegendKeeper refused the original id (${got.why.slice(0, 200)}); recreated with a new id`;
          got = await attemptRecreate('new');
          if (!got.ok) throw new Fails(`not recreated with a new id either: ${got.why}`);
        }
        const res = (await read('getResource', { path: { resourceId: got.newId } })) as Obj | undefined;
        if (!res) throw new Fails(`the recreated page ${got.newId} cannot be read`);
        const d = (res.documents as Obj[]).find((x) => x.name === 'Text');
        const textAfter = d ? renderDocument((await documentPieceOf(read, got.newId, d)) as never) : '';
        if (textAfter !== textBefore) throw new Fails(`its text differs:\n${textBefore}\n---\n${textAfter}`);
        return `${idNote}; its text reads back as in the snapshot`;
      },
    );

    // ================================================================================================ 5. updatedAt
    const stamps = async (docId?: string) => {
      const list = await run('listResources', { query: { parentId: rootId, limit: 100 } });
      const r = (list.data as Obj[]).find((x) => x.id === pageId);
      let d: string | null = null;
      if (docId) {
        const ds = await run('listDocuments', { path: { resourceId: pageId } });
        d = ((ds.data as Obj[]).find((x) => x.id === docId)?.updatedAt as string | undefined) ?? null;
      }
      return { resource: (r?.updatedAt as string | undefined) ?? null, document: d };
    };
    const updatedAtCheck = async (
      id: string,
      what: string,
      docId: string | undefined,
      edit: () => Promise<void>,
    ) => {
      const before = mark();
      try {
        const a = await stamps(docId);
        await sleep(o.updatedAtGapMs ?? 1500);
        await edit();
        const b = await stamps(docId);
        const res = a.resource !== null && b.resource !== null && a.resource !== b.resource;
        const doc =
          docId !== undefined && a.document !== null && b.document !== null && a.document !== b.document;
        const detail = `resource updatedAt ${a.resource} → ${b.resource}${docId ? `; document updatedAt ${a.document} → ${b.document}` : ''}`;
        if (a.resource === null)
          record(id, what, 'inconclusive', `listResources gave no updatedAt; ${detail}; ${costText(before)}`);
        else if (res)
          record(
            id,
            what,
            'pass',
            `the resource's updatedAt moved: the daily pass sees this edit; ${detail}; ${costText(before)}`,
          );
        else if (doc)
          record(
            id,
            what,
            'inconclusive',
            `only the document's updatedAt moved: the daily pass sees it only with snapshotDailyPassDocuments on (one request a page); ${detail}; ${costText(before)}`,
          );
        else
          record(
            id,
            what,
            'fail',
            `neither moved: only the weekly full snapshot sees this kind of edit; ${detail}; ${costText(before)}`,
          );
      } catch (e) {
        record(id, what, 'inconclusive', `could not complete: ${(e as Error).message}; ${costText(before)}`);
      }
      costs[id] = spent(before);
    };
    const skip = (id: string, what: string, why: string) => record(id, what, 'skipped', why);
    if (set.page)
      await updatedAtCheck('U.a', 'updatedAt after a block changes', docs.page, async () => {
        const cur = await run('getDocumentBlocks', { path: { resourceId: pageId, documentId: docs.page } });
        const blocks = [
          ...(cur.blocks as Obj[]),
          { kind: 'paragraph', content: [{ text: 'A later line.' }] },
        ];
        await run('replaceDocumentBlocks', {
          path: { resourceId: pageId, documentId: docs.page },
          body: { blocks },
        });
      });
    else skip('U.a', 'updatedAt after a block changes', 'no page document was set up');
    if (set.sidebar)
      await updatedAtCheck('U.b', 'updatedAt after a sidebar row changes', undefined, async () => {
        await run('updatePropertyRow', {
          path: { resourceId: pageId, propertyId: ids2.kv, rowId: ids2.row },
          body: { text: 'East' },
        });
      });
    else skip('U.b', 'updatedAt after a sidebar row changes', 'no sidebar was set up');
    if (set.map)
      await updatedAtCheck('U.c', 'updatedAt after a map feature changes', docs.map, async () => {
        await run('updateFeature', {
          path: { resourceId: pageId, documentId: docs.map, featureId: ids2.pin },
          body: { name: 'Ashgate (again)' },
        });
      });
    else skip('U.c', 'updatedAt after a map feature changes', 'no map was set up');
    if (set.time)
      await updatedAtCheck('U.d', 'updatedAt after a timeline event changes', docs.time, async () => {
        await run('updateEvent', {
          path: { resourceId: pageId, documentId: docs.time, eventId: ids2.event },
          body: { name: 'Founding (again)' },
        });
      });
    else skip('U.d', 'updatedAt after a timeline event changes', 'no timeline was set up');
    if (set.board)
      await updatedAtCheck('U.e', 'updatedAt after the board content changes', docs.board, async () => {
        await run('createBoardShapes', {
          path: { resourceId: pageId, documentId: docs.board },
          body: { shapes: [{ type: 'geo', x: 400, y: 0, props: { geo: 'rectangle', w: 40, h: 40 } }] },
        });
      });
    else skip('U.e', 'updatedAt after the board content changes', 'no board was set up');

    // ================================================================================================ 6. rehearsal
    await check('H', 'a sampled rehearsal of the subtree into its own throwaway root', async () => {
      // The rehearsal never goes into the project a snapshot came from: the snapshot is copied, in the temporary
      // database only, as a snapshot of a stand-in project, and this project is marked a sandbox there.
      const SOURCE = 'sandbox_rehearsal_source';
      const now = Date.now();
      t.db
        .prepare(
          `INSERT INTO projects (id, name, display_name, is_default, is_sandbox, read_only, settings, created_at, updated_at, verified_at)
           VALUES (?, 'rehearsal_source', 'Rehearsal source', 0, 0, 1, '{}', ?, ?, ?)`,
        )
        .run(SOURCE, now, now, now);
      new ProjectStore(t.db).setSandbox(pid, true);
      rt.projects.refresh();
      const copy: Manifest = {
        ...snap,
        id: snap.id.replace(/-full-/, '-full-0'),
        project: { id: SOURCE, name: 'rehearsal_source' },
      };
      await svc.writeSnapshot(copy);
      const target = rt.projects.list().find((p) => p.id === pid)!.name;
      const row = await rt.rehearsals.start({
        targetProject: target,
        snapshotId: copy.id,
        mode: 'sampled',
        keep: false,
        by: 'sandbox-snapshots',
        max: 50,
      });
      const done = await rt.rehearsals.settled(row.id);
      if (!done || done.state !== 'succeeded')
        throw new Fails(`it ended ${done?.state ?? '?'}: ${done?.error ?? ''}`);
      if (done.rootState !== 'deleted')
        throw new Fails(`its root ${done.rootId} was not deleted (${done.rootState}): delete it by hand`);
      const res = done.result as Obj;
      const diffs = (res.differences ?? []) as Obj[];
      const summary = `${res.exact} of ${res.pagesCompared} pages exact; ${res.cost?.writes} writes, ${res.cost?.reads} compare reads, ${Math.round((res.ms ?? 0) / 1000)} s; root ${done.rootName} deleted`;
      if (diffs.length > 0)
        throw new Fails(
          `${summary}; differences: ${diffs
            .map((d) => `${d.page} ${d.piece}: ${d.reason}`)
            .join('; ')
            .slice(0, 1200)}`,
        );
      return summary;
    });
  } finally {
    // ================================================================================================ 7. clean-up
    const before = mark();
    const left: string[] = [];
    const goneAlready = (m: string) => /404|not found|already deleted|NOT_FOUND|gone/i.test(m);
    if (rootId) {
      try {
        await run(
          'deleteResource',
          { path: { resourceId: rootId }, query: { cascade: true } },
          { confirm: 'cascade' },
        );
      } catch (e) {
        const m = (e as Error).message;
        const res = (await attempt('getResource', { path: { resourceId: rootId } })) as Obj;
        if (!(goneAlready(m) || (res.ok && res.body?.deletedAt != null) || !res.ok))
          left.push(`page ${rootId} (${m})`);
      }
    }
    for (const id of made.assets) {
      try {
        await run('deleteAsset', { path: { assetId: id } });
      } catch (e) {
        const m = (e as Error).message;
        if (!goneAlready(m)) left.push(`image ${id} (${m})`);
      }
    }
    record(
      'cleanup',
      'everything the run made is deleted',
      left.length === 0 ? 'pass' : 'fail',
      left.length === 0
        ? `root ${rootId || '(none)'} with its subtree, ${made.assets.length} image(s); ${costText(before)}`
        : `left: ${left.join('; ')}. Delete them by hand.`,
    );
    costs.cleanup = spent(before);
  }
  return { findings, costs };
}

export function formatSnapshotsReport(r: SnapshotsReport, total: { reads: number; writes: number }): string {
  const mark = {
    pass: 'PASS',
    fail: 'FAIL',
    inconclusive: 'INCONCLUSIVE',
    skipped: 'SKIPPED',
    noted: 'NOTED',
  } as const;
  const count = (v: Verdict) => r.findings.filter((f) => f.verdict === v).length;
  return [
    '',
    'LK-Bridge sandbox: snapshots, restores and the rehearsal (docs/adr/0042-snapshots-restore-rehearsal.md)',
    '========================================================================================================',
    ...r.findings.map((f) => `[${mark[f.verdict]}] (${f.id}) ${f.title}\n        ${f.detail}`),
    '',
    `${count('pass')} PASS, ${count('fail')} FAIL, ${count('inconclusive')} INCONCLUSIVE, ${count('skipped')} SKIPPED`,
    `Total: ${total.reads} reads, ${total.writes} writes to LegendKeeper.`,
    'The daily pass (snapshotDailyPass) can be switched on when U.a–U.e all PASS; with INCONCLUSIVE ones, only with',
    'snapshotDailyPassDocuments too; a FAIL means that kind of app edit waits for the weekly full snapshot.',
    '',
  ].join('\n');
}

/**
 * Restoring a deleted image (v2 E1a, ADR 0042; moved onto v3 F2's server staging by v3 F3c, ADR 0051 decision 3).
 * LegendKeeper cannot undelete an asset, so a restored image becomes a NEW asset with a NEW URL. Its bytes come from the
 * snapshot store (a snapshot's library, or the bytes kept before the delete: one store) and stay on the bridge's server
 * (staged there, as any unapproved image is: ADR 0049 decision 10). Nothing is sent to LegendKeeper until the owner
 * approves, and nothing ever goes to the old `LK-Bridge staging` folder.
 *
 * The proposal describes the image, its folder and its name. Approval runs ONE job: the folder found or created by its
 * path (ADR 0049 decision 9: a folder deleted since the snapshot is made again), the upload straight into it under its
 * name, the stored file checked, and then, when the caller asked (`updateReferences`: the owner's tick on the
 * dashboard), each page document that showed the old URL rewritten to the new one (its image blocks, one whole-document
 * write with the If-Match read when the restore was proposed; the new URL is bound in the job) and each map image set to
 * the new asset. If such a page changed in the meantime, its write is refused (412) and the job stops there, after the
 * upload: the asset stays where it was put, the job records an `image_relink_failed` follow-up (and the restore's record
 * says so), and nothing is retried. Any other place (a banner, an event's or a lane's image, a board asset) is listed for
 * the owner to change by hand.
 */
import { asStoredImage } from '../images/convert.js';
import { randomBytes } from 'node:crypto';
import type { AssetService } from '../assets/index.js';
import type { AssetPlan } from '../assets/plan.js';
import { ImageServiceError, type ImageService } from '../images/service.js';
import type { ImageUploadRow } from '../images/store.js';
import type { TreeService } from '../tree/index.js';
import { SYSTEM_PRINCIPAL, type JobEngine, type JobOrigin, type StepSpec } from '../jobs/index.js';
import { replaceUrls, stripVersions, type LibraryPiece } from './canonical.js';
import type { Reader } from './capture.js';
import { RestoreError, type PlanNote } from './restore.js';
import type { SnapshotService } from './service.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export interface ImageRestoreDeps {
  readonly svc: SnapshotService;
  readonly engine: JobEngine;
  readonly images: ImageService;
  readonly read: Reader;
  /** The asset tree: an asset's live record (null: not in the library). */
  readonly asset: (
    projectId: string,
    assetId: string,
  ) => { id: string; url: string | null; folderId: string | null } | null;
  readonly folderLive: (projectId: string, folderId: string) => boolean;
  readonly pageName: (projectId: string, pageId: string) => string | null;
}

/** The deps from the running bridge's services (the snapshot tools and the dashboard build them the same way). */
export function imageRestoreDeps(o: {
  readonly svc: SnapshotService;
  readonly engine: JobEngine;
  readonly images: ImageService;
  readonly assets: Pick<AssetService, 'queries'>;
  readonly tree: Pick<TreeService, 'queries'>;
  readonly projectId: string;
}): ImageRestoreDeps {
  return {
    svc: o.svc,
    engine: o.engine,
    images: o.images,
    read: o.svc.reader(o.projectId, 'P1', { wait: false }),
    asset: (pid, id) => {
      const a = o.assets.queries.asset(pid, id).data;
      return a ? { id: a.id, url: a.url, folderId: a.folderId } : null;
    },
    folderLive: (pid, id) => o.assets.queries.folder(pid, id).data !== null,
    pageName: (pid, id) => o.tree.queries.node(pid, id).data?.rawName ?? null,
  };
}

export interface ImageRestoreInput {
  readonly projectId: string;
  readonly snapshotId: string;
  readonly assetId: string;
  readonly updateReferences: boolean;
  /**
   * v3 F12 (ADR 0081, D3): what the journal knew of the asset when it was deleted (Revert of an agent's delete): its name,
   * folder and URL, used where no snapshot's library holds it (the kept bytes alone then).
   */
  readonly known?: {
    readonly name?: string | null;
    readonly folderId?: string | null;
    readonly url?: string | null;
  };
}

export interface ImageReference {
  readonly pageId: string;
  readonly page: string;
  /** What will be updated in the proposal (when asked), or listed for a hand change. */
  readonly documents: {
    readonly id: string;
    readonly name: string;
    readonly what: 'image blocks' | 'map image';
  }[];
  readonly byHand: string[];
}

export type ImageRestoreResult = {
  /**
   * v3 F12 (ADR 0081): `submitted` (with `jobId`) when it runs at once: the owner confirmed it on the dashboard, or an
   * agent at scope `write` asked for it; `proposal_captured` at scope `propose`.
   */
  readonly status: 'proposal_captured' | 'submitted';
  readonly proposalId?: string;
  readonly jobId?: string;
  readonly canonical?: { readonly reason: string };
  readonly old: Obj;
  /**
   * v3 F3c: the image the proposal uploads when approved (on the bridge's server until then): its name, the folder it
   * goes to (`path`, from the library's root; `creates`: the folders made on the way) and its staged id. The new
   * asset's id and URL exist only once it is approved (the job's result and the restore's record give them).
   */
  readonly image: {
    readonly stagedId: string;
    readonly name: string;
    readonly path: readonly string[];
    readonly creates: readonly string[];
  };
  readonly references: ImageReference[];
  readonly updated: boolean;
  readonly notes: PlanNote[];
  readonly summary: string;
};

/** Where the image was and what it held, from the snapshot (its library) or the kept bytes. */
async function findOld(d: ImageRestoreDeps, input: ImageRestoreInput) {
  const svc = d.svc;
  const snap = svc.index.snapshot(input.snapshotId);
  if (!snap || snap.projectId !== input.projectId)
    throw new RestoreError('SNAPSHOT_NOT_FOUND', `No snapshot ${input.snapshotId} of this project.`);
  // The library as it stood at the snapshot: the snapshot's own library, else the latest one before it.
  const lib = svc.index
    .pageHistory(input.projectId, '*', { piece: 'library', limit: 1000 })
    .find((r) => r.takenAt <= snap.takenAt && r.sha256);
  const asset = svc.index
    .pageHistory(input.projectId, '*', { piece: 'asset', limit: 100_000 })
    .find((r) => r.ref === input.assetId && r.takenAt <= snap.takenAt && r.sha256);
  let name: string | null = null;
  let folderId: string | null = null;
  let folderPath: string[] | null = null;
  let piece: LibraryPiece | null = null;
  if (lib?.sha256) {
    piece = await svc.store.getJson<LibraryPiece>(lib.sha256);
    const a = piece?.assets.find((x) => x.id === input.assetId);
    if (a) {
      name = a.name;
      folderId = a.folderId;
    }
  }
  let sha = asset?.sha256 ?? null;
  const url = asset?.name ?? input.known?.url ?? null;
  if (!sha) {
    const kept = d.images.store.keptRefs(input.projectId, input.assetId)[0];
    if (kept) {
      sha = kept.sha256;
      name ??= kept.name ?? input.known?.name ?? null;
      folderId ??= kept.folderId ?? input.known?.folderId ?? null;
    }
  }
  // v3 F12 (ADR 0081, D3): what the journal recorded just before the delete (Revert's), the surest record of where it was.
  if (input.known) {
    name = input.known.name ?? name;
    folderId = input.known.folderId ?? folderId;
  }
  if (!sha)
    throw new RestoreError(
      'IMAGE_NOT_IN_SNAPSHOT',
      `Neither the snapshot's library nor the kept bytes hold the image ${input.assetId}. list_snapshots on the library, or choose a later snapshot.`,
    );
  const bytes = await svc.store.get(sha);
  if (!bytes)
    throw new RestoreError(
      'SNAPSHOT_PIECE_DAMAGED',
      `The stored image ${sha.slice(0, 12)}… is missing or damaged in the snapshot store.`,
    );
  // v3 F3c: the folder's path as the snapshot's library knew it (names from the root), so a folder deleted since can be
  // found or made again by its path when the restore is approved.
  if (folderId !== null && piece) {
    const byId = new Map(piece.folders.map((f) => [f.id, f]));
    const names: string[] = [];
    let at: string | null = folderId;
    for (let i = 0; at !== null && i < 64; i++) {
      const f = byId.get(at);
      if (!f || f.name === null) {
        names.length = 0;
        break;
      }
      names.unshift(f.name);
      at = f.folderId;
    }
    if (names.length > 0 && at === null) folderPath = names;
  }
  return { sha, bytes, url, name: name ?? input.assetId, folderId, folderPath };
}

/**
 * v3 F3c (ADR 0051 decision 3): where the image goes back: its folder while it is still there; else that folder's path
 * from the snapshot, found or created when the restore is approved; the library's root when it was there (or when its
 * folder is gone and its path is not known, which the notes say).
 */
async function destinationFor(
  d: ImageRestoreDeps,
  projectId: string,
  old: { readonly folderId: string | null; readonly folderPath: readonly string[] | null },
  notes: PlanNote[],
): Promise<Pick<AssetPlan, 'wouldCreate' | 'destination'>> {
  const root = { wouldCreate: [], destination: { path: [], folderId: null, exists: true } };
  const planned = (folder: string | readonly string[]) => {
    const r = d.images.plan(projectId, { folder });
    if (!r.ok) throw new RestoreError(r.error.code, r.error.message, r.error.details ?? {});
    return r.plan;
  };
  if (old.folderId !== null && d.folderLive(projectId, old.folderId)) return planned(old.folderId);
  // v3 F12 (ADR 0081, D3): a folder the asset tree does not hold (not built yet, or made since it was last read) is
  // read live once: when it is there, the image goes into it as it is.
  if (old.folderId !== null) {
    const live = (await d.read('getAsset', { path: { assetId: old.folderId } }).catch(() => undefined)) as
      Obj | undefined;
    if (isObj(live) && String(live.type).toUpperCase() === 'FOLDER' && typeof live.deletedAt !== 'string') {
      const name = str(live.name);
      return {
        wouldCreate: [],
        destination: { path: name ? [name] : [old.folderId], folderId: old.folderId, exists: true },
      };
    }
  }
  if (old.folderId !== null && old.folderPath && old.folderPath.length > 0) {
    const plan = planned(old.folderPath);
    if (plan.wouldCreate.length > 0)
      notes.push({
        what: 'its folder',
        why: `the folder ${old.folderPath.join(' / ')} is gone; it is made again (or found, if it is there by then) when the restore is approved`,
      });
    return plan;
  }
  if (old.folderId !== null)
    notes.push({
      what: 'its folder',
      why: `the folder ${old.folderId} is gone and the snapshot does not hold its path; the image goes to the library’s root`,
    });
  return root;
}

/** The pages the snapshots show referring to the old URL, and what of them the proposal can update. */
async function references(
  d: ImageRestoreDeps,
  projectId: string,
  url: string | null,
): Promise<ImageReference[]> {
  if (!url) return [];
  const rows = d.svc.o.db
    .prepare(
      `SELECT DISTINCT page_id FROM snapshot_pieces WHERE project_id = ? AND piece = 'image' AND ref = ?`,
    )
    .all(projectId, url) as { page_id: string }[];
  const out: ImageReference[] = [];
  for (const { page_id: pageId } of rows) {
    const res = (await d.read('getResource', { path: { resourceId: pageId } })) as Obj | undefined;
    if (!res) continue;
    const documents: ImageReference['documents'][number][] = [];
    const byHand: string[] = [];
    if (JSON.stringify({ imageUrl: res.imageUrl, banner: res.banner }).includes(url))
      byHand.push('the page’s image or banner');
    for (const doc of (Array.isArray(res.documents) ? (res.documents as Obj[]) : []).filter(
      (x) => x.deletedAt == null,
    )) {
      const path = { resourceId: pageId, documentId: String(doc.id) };
      if (doc.type === 'page') {
        const b = await d.read('getDocumentBlocks', { path });
        if (JSON.stringify(b ?? null).includes(url))
          documents.push({ id: String(doc.id), name: str(doc.name) ?? String(doc.id), what: 'image blocks' });
      } else if (doc.type === 'map') {
        const m = (await d.read('getDocument', { path })) as Obj | undefined;
        if (isObj(m?.mapImage) && m.mapImage.url === url)
          documents.push({ id: String(doc.id), name: str(doc.name) ?? String(doc.id), what: 'map image' });
      } else if (doc.type === 'time' || doc.type === 'board') {
        byHand.push(
          `${str(doc.name) ?? String(doc.id)} (a ${doc.type === 'time' ? 'timeline' : 'board'}: change its image by hand)`,
        );
      }
    }
    if (documents.length > 0 || byHand.length > 0)
      out.push({ pageId, page: str(res.name) ?? d.pageName(projectId, pageId) ?? pageId, documents, byHand });
  }
  return out;
}

export async function restoreImage(
  d: ImageRestoreDeps,
  input: ImageRestoreInput,
  origin: JobOrigin,
  o: { readonly dryRun?: boolean } = {},
): Promise<
  | ImageRestoreResult
  | {
      status: 'dry_run';
      old: Obj;
      references: ImageReference[];
      image: { name: string; path: readonly string[]; creates: readonly string[] };
      notes: PlanNote[];
    }
> {
  if (d.asset(input.projectId, input.assetId))
    throw new RestoreError(
      'IMAGE_NOT_DELETED',
      `The image ${input.assetId} is still in the library; nothing to restore.`,
    );
  const old = await findOld(d, input);
  const refs = await references(d, input.projectId, old.url);
  const oldView = {
    assetId: input.assetId,
    name: old.name,
    url: old.url,
    folderId: old.folderId,
    sha256: old.sha,
    bytes: old.bytes.length,
  };

  const notes: PlanNote[] = [];
  const dest = await destinationFor(d, input.projectId, old, notes);
  const path = dest.destination.path;
  const creates = dest.wouldCreate.map((c) => c.path.join(' / '));
  if (o.dryRun)
    return {
      status: 'dry_run',
      old: oldView,
      references: refs,
      image: { name: old.name, path, creates },
      notes,
    };

  // ---- the bytes wait on the bridge's server (or the copy a previous call staged there: the same original)
  // v2 E4 (RV3-4): the snapshot store's bytes, exactly (never re-encoded: a PNG or JPEG would come back as lossy WebP).
  const image = await asStoredImage(old.bytes);
  // CR-2026-11-R2 (R2-39): only a record an earlier restore of THIS asset staged, holding exactly the snapshot's bytes, is
  // reused. Never another staged image of the same original (an agent's holds its converted WebP, and is its own).
  const own = (r: ImageUploadRow) =>
    r.source === 'restore' &&
    r.staged &&
    r.state === 'uploaded' &&
    r.assetId === null &&
    r.serverSha256 === old.sha &&
    r.webp.sha256 === old.sha &&
    (r.intended as { restoreOf?: unknown } | null)?.restoreOf === input.assetId;
  let row: ImageUploadRow | undefined = d.images.store
    .byOriginal(input.projectId, old.sha)
    .map((r) => d.images.settle(r))
    .find(own);
  if (!row) {
    try {
      row = await d.images.stageOnServer({
        projectId: input.projectId,
        image,
        name: old.name,
        intended: { restoreOf: input.assetId, folderId: old.folderId },
        source: 'restore',
        origin,
        priority: 'P1',
      });
    } catch (e) {
      if (e instanceof ImageServiceError) throw new RestoreError(e.code, e.message, e.details);
      throw e;
    }
  }
  // CR-2026-11-R2 (R2-38): one restore (or placement) of the staged image at a time, decided on its record as it is now.
  if (!d.images.holdStaged(input.projectId, row.id))
    throw new RestoreError(
      'RESTORE_PENDING',
      'This image is being restored by another request at this moment; follow that request’s answer.',
      { stagedId: row.id },
    );
  try {
    return await proposeRestore(d, input, origin, {
      row: d.images.store.upload(input.projectId, row.id) ?? row,
      image,
      old,
      oldView,
      refs,
      dest,
      notes,
      path,
      creates,
    });
  } finally {
    d.images.releaseStaged(input.projectId, row.id);
  }
}

/** The restore's proposal for its staged record (taken by the caller): the upload, then the references when asked. */
async function proposeRestore(
  d: ImageRestoreDeps,
  input: ImageRestoreInput,
  origin: JobOrigin,
  o: {
    readonly row: ImageUploadRow;
    readonly image: Awaited<ReturnType<typeof asStoredImage>>;
    readonly old: Awaited<ReturnType<typeof findOld>>;
    readonly oldView: Obj;
    readonly refs: ImageReference[];
    readonly dest: Pick<AssetPlan, 'wouldCreate' | 'destination'>;
    readonly notes: PlanNote[];
    readonly path: readonly string[];
    readonly creates: readonly string[];
  },
): Promise<ImageRestoreResult> {
  const { row, image, old, oldView, refs, dest, notes, path, creates } = o;
  if (row.placementProposalId || row.placementJobId)
    throw new RestoreError(
      'RESTORE_PENDING',
      `This image is already waiting to be placed (${row.placementProposalId ? `proposal ${row.placementProposalId}` : `job ${row.placementJobId}`}); approve or reject that first.`,
      { stagedId: row.id },
    );

  // ---- the proposal: the upload into its folder under its name, then (when asked) the pages that showed it
  const placed = d.images.serverPlacementSteps({
    row,
    destination: dest,
    name: old.name,
    tool: 'restore_snapshot',
    contentType: image.output.contentType,
    journal: { scope: 'image', restoreOf: input.assetId },
  });
  const steps: StepSpec[] = [...placed.steps];
  const urlPlaceholder = `https://lk-bridge.invalid/restored/${input.assetId}`;
  const idPlaceholder = `lk-bridge-restored-${input.assetId}`;
  let updated = false;
  if (input.updateReferences && old.url) {
    const map = new Map([[old.url, urlPlaceholder]]);
    for (const ref of refs) {
      for (const doc of ref.documents) {
        const docPath = { resourceId: ref.pageId, documentId: doc.id };
        // Bound in the job (its URL exists only once uploaded); judged by its own If-Match when it runs, so a page that
        // changed since does not stop the upload, only its own relink (a follow-up), and the job after it.
        const relink = {
          judgedInLock: true,
          followUp: 'image_relink_failed' as const,
          journalOperation: {
            tool: 'restore_snapshot',
            scope: 'image',
            restoreOf: input.assetId,
            page: { id: ref.pageId, name: ref.page },
            write: doc.what === 'image blocks' ? 'image URL' : 'map image',
          },
        };
        if (doc.what === 'image blocks') {
          const b = (await d.read('getDocumentBlocks', { path: docPath })) as Obj | undefined;
          if (!b) continue;
          const blocks = replaceUrls(stripVersions(b.blocks ?? []) as unknown[], map);
          steps.push({
            op: 'replaceDocumentBlocks',
            params: { path: docPath, ifMatch: str(b.version) ?? '', body: { blocks } },
            verifyAfterWrite: true,
            bindAssetUrls: [{ step: placed.assetStep, placeholder: urlPlaceholder }],
            ...relink,
          });
        } else {
          steps.push({
            op: 'updateDocument',
            params: { path: docPath, body: { mapImage: { assetId: idPlaceholder } } },
            bindAssetUrls: [{ step: placed.assetStep, placeholder: idPlaceholder, field: 'id' }],
            ...relink,
          });
        }
        updated = true;
      }
      if (ref.byHand.length > 0)
        notes.push({
          what: `${ref.page}: ${ref.byHand.join('; ')}`,
          why: 'only page documents and map images are updated; change the rest by hand to the new URL',
        });
    }
  } else if (refs.length > 0) {
    notes.push({
      what: `${refs.length} page(s) refer to the old URL`,
      why: 'not updated (not asked); they show a broken image until changed to the new URL',
    });
  }
  const where = path.length > 0 ? path.join(' / ') : 'the library’s root';
  const summary = `restore_snapshot: image “${placed.name}” back as a new asset in ${where}${creates.length ? ` (making ${creates.join(', ')})` : ''}, uploaded from the bridge’s server when it runs${updated ? `, and ${refs.reduce((n, r) => n + r.documents.length, 0)} reference(s) updated to its new URL` : ''}`;
  const imageView = { stagedId: row.id, name: placed.name, path, creates };
  const r = await d.engine.submit({
    kind: 'batch_ops',
    project: input.projectId,
    steps,
    onError: 'stop',
    priority: 'P1',
    origin,
    title: summary.slice(0, 300),
    internal: true,
    // v3 F12 (ADR 0081): a proposal only at scope `propose` (the gate) or for the bridge's own unconfirmed request.
    ...((origin.principal === undefined || origin.principal.principalId === SYSTEM_PRINCIPAL.principalId) &&
    origin.ownerConfirmed !== true
      ? { forceProposal: true }
      : {}),
    stagedPlacement: true,
    proposal: {
      summary: summary.slice(0, 500),
      operation: {
        tool: 'restore_snapshot',
        scope: 'image',
        old: oldView,
        image: imageView,
        references: refs,
        updateReferences: input.updateReferences,
        notes,
      },
      operations: [
        {
          tool: 'restore_snapshot',
          page: { id: '*', name: 'asset library' },
          pageParts: [
            `image “${placed.name}” uploaded to ${where}`,
            ...creates.map((c) => `folder ${c} made`),
            ...(updated ? ['references'] : []),
          ],
          summaryLabel: summary.slice(0, 500),
        },
        ...refs
          .filter((x) => updated && x.documents.length > 0)
          .map((x) => ({
            tool: 'restore_snapshot',
            page: { id: x.pageId, name: x.page },
            pageParts: x.documents.map((doc) => `${doc.name}: ${doc.what}`),
          })),
      ],
    },
  });
  const proposalId = 'proposalId' in r && typeof r.proposalId === 'string' ? r.proposalId : null;
  const jobId = !proposalId && 'jobId' in r && typeof r.jobId === 'string' ? r.jobId : null;
  if (!proposalId && !jobId)
    throw new RestoreError('NOT_PROPOSED', 'The restore was neither run nor proposed; nothing was done.');
  // The staged image follows its placement (ADR 0049 decision 10): placed, and its server copy removed, once the job has
  // made its asset, even when a relink after it failed.
  d.images.store.updateUpload(input.projectId, row.id, {
    ...(jobId ? { placementJobId: jobId } : { placementProposalId: proposalId! }),
    intended: {
      ...(row.intended ?? {}),
      placing: { name: placed.name, path, folderId: dest.destination.folderId, assetStep: placed.assetStep },
    },
    error: null,
  });
  const now = d.svc.o.now();
  d.svc.o.db
    .prepare(
      `INSERT INTO snapshot_restores (id, project_id, page_id, page_name, snapshot_id, scope, mode, document_id, proposal_id,
         job_id, state, follow_up, requested_by, summary, plan, created_at, updated_at)
       VALUES (?, ?, '*', ?, ?, 'image', NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      `rst_${randomBytes(8).toString('hex')}`,
      input.projectId,
      old.name,
      input.snapshotId,
      input.assetId,
      proposalId,
      jobId,
      jobId ? 'running' : 'proposed',
      origin.principal?.principalId ?? 'owner',
      summary,
      JSON.stringify({ stagedId: row.id, assetStep: placed.assetStep, references: refs.length, updated }),
      now,
      now,
    );
  const canonical = (r as { canonical?: { reason: string } }).canonical;
  return {
    status: jobId ? 'submitted' : 'proposal_captured',
    ...(proposalId ? { proposalId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(canonical ? { canonical } : {}),
    old: oldView,
    image: imageView,
    references: refs,
    updated,
    notes,
    summary,
  };
}

/**
 * Restoring a deleted image (v2 E1a, ADR 0042). LegendKeeper cannot undelete an asset, so a restored image becomes a NEW
 * asset with a NEW URL. Its bytes come from the snapshot store (a snapshot's library, or the bytes kept before the
 * delete: one store). A proposal cannot hold image bytes (ADR 0041 decision 7), so the image is STAGED first (uploaded,
 * verified and hidden in the staging folder, as an upload at scope `propose` is), and the proposal places it back in
 * its folder, unhidden, under its name. The pages the snapshots show referring to the old URL are listed, and, when the
 * caller asks (`updateReferences`: the owner's tick on the dashboard), the same proposal updates them: a page document's
 * image blocks (one whole-document write each, with If-Match) and a map's image. Any other place (a banner, an event's or
 * a lane's image, a board asset) is listed for the owner to change by hand.
 */
import { asStoredImage } from '../images/convert.js';
import { randomBytes } from 'node:crypto';
import type { AssetService } from '../assets/index.js';
import type { ImageService } from '../images/service.js';
import type { TreeService } from '../tree/index.js';
import { verifyStep } from '../jobs/internal-steps.js';
import type { JobEngine, JobOrigin, StepSpec } from '../jobs/index.js';
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

export type ImageRestoreResult =
  | {
      readonly status: 'staging';
      readonly stagedId: string;
      readonly jobId: string | null;
      readonly old: Obj;
      readonly references: ImageReference[];
    }
  | {
      readonly status: 'proposal_captured';
      readonly proposalId: string;
      readonly canonical?: { readonly reason: string };
      readonly old: Obj;
      readonly newAsset: { readonly id: string; readonly url: string | null };
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
  if (lib?.sha256) {
    const piece = await svc.store.getJson<LibraryPiece>(lib.sha256);
    const a = piece?.assets.find((x) => x.id === input.assetId);
    if (a) {
      name = a.name;
      folderId = a.folderId;
    }
  }
  let sha = asset?.sha256 ?? null;
  const url = asset?.name ?? null;
  if (!sha) {
    const kept = d.images.store.keptRefs(input.projectId, input.assetId)[0];
    if (kept) {
      sha = kept.sha256;
      name ??= kept.name;
      folderId ??= kept.folderId;
    }
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
  return { sha, bytes, url, name: name ?? input.assetId, folderId };
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
  o: { readonly waitMs?: number; readonly dryRun?: boolean } = {},
): Promise<ImageRestoreResult | { status: 'dry_run'; old: Obj; references: ImageReference[] }> {
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
  if (o.dryRun) return { status: 'dry_run', old: oldView, references: refs };

  // ---- stage it (or reuse the one a previous call staged: the same original)
  let row = d.images.findDuplicate(input.projectId, old.sha);
  if (!row || !row.staged) {
    const plan = d.images.planStaging(input.projectId);
    if (!plan.ok) throw new RestoreError(plan.error.code, plan.error.message);
    // v2 E4 (RV3-4): the snapshot store's bytes, exactly (never re-encoded: a PNG or JPEG would come back as lossy WebP).
    const image = await asStoredImage(old.bytes);
    const started = await d.images.startUpload({
      projectId: input.projectId,
      image,
      name: old.name,
      plan: plan.plan,
      staged: true,
      intended: { restoreOf: input.assetId, folderId: old.folderId },
      source: 'restore',
      origin,
      priority: 'P1',
    });
    if (!started.row)
      throw new RestoreError('NOT_STAGED', 'The image could not be staged; nothing was proposed.');
    row = started.row;
  }
  if (row.state === 'uploading' && row.jobId) {
    await d.engine.wait(input.projectId, row.jobId, o.waitMs ?? 25_000);
    row = d.images.settle(row);
  }
  if (row.state !== 'uploaded' || !row.assetId)
    return { status: 'staging', stagedId: row.id, jobId: row.jobId, old: oldView, references: refs };
  const newAsset = d.asset(input.projectId, row.assetId);
  const newUrl = newAsset?.url ?? null;

  // ---- the proposal: place it back (unhidden, its name, its folder when it is still there), and the references
  const notes: PlanNote[] = [];
  const folderOk = old.folderId !== null && d.folderLive(input.projectId, old.folderId);
  if (old.folderId && !folderOk)
    notes.push({
      what: 'its folder',
      why: `the folder ${old.folderId} is gone; the image goes to the library’s root`,
    });
  const steps: StepSpec[] = [
    {
      op: 'updateAsset',
      params: {
        path: { assetId: row.assetId },
        body: { isHidden: false, name: old.name, folderId: folderOk ? old.folderId : null },
      },
      journalOperation: { tool: 'restore_snapshot', scope: 'image', restoreOf: input.assetId },
    },
  ];
  let updated = false;
  if (input.updateReferences && old.url && newUrl) {
    const map = new Map([[old.url, newUrl]]);
    for (const ref of refs) {
      for (const doc of ref.documents) {
        const path = { resourceId: ref.pageId, documentId: doc.id };
        if (doc.what === 'image blocks') {
          const b = (await d.read('getDocumentBlocks', { path })) as Obj | undefined;
          if (!b) continue;
          const blocks = replaceUrls(stripVersions(b.blocks ?? []) as unknown[], map);
          steps.push({
            op: 'replaceDocumentBlocks',
            params: { path, ifMatch: str(b.version) ?? '', body: { blocks } },
            verifyAfterWrite: true,
            journalOperation: {
              tool: 'restore_snapshot',
              scope: 'image',
              page: { id: ref.pageId, name: ref.page },
              write: 'image URL',
            },
          });
        } else {
          steps.push({
            op: 'updateDocument',
            params: { path, body: { mapImage: { assetId: row.assetId } } },
            journalOperation: {
              tool: 'restore_snapshot',
              scope: 'image',
              page: { id: ref.pageId, name: ref.page },
              write: 'map image',
            },
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
  steps.push(
    verifyStep([
      {
        kind: 'asset',
        label: `image “${old.name}”`,
        assetId: row.assetId,
        fields: { isHidden: false, name: old.name, ...(folderOk ? { folderId: old.folderId } : {}) },
      },
    ]),
  );
  const summary = `restore_snapshot: image “${old.name}” back as a new asset${updated ? `, and ${refs.reduce((n, r) => n + r.documents.length, 0)} reference(s) updated to its new URL` : ''}`;
  const r = await d.engine.submit({
    kind: 'batch_ops',
    project: input.projectId,
    steps,
    onError: 'stop',
    priority: 'P1',
    origin,
    title: summary.slice(0, 300),
    internal: true,
    forceProposal: true,
    proposal: {
      summary,
      operation: {
        tool: 'restore_snapshot',
        scope: 'image',
        old: oldView,
        newAsset: { id: row.assetId, url: newUrl },
        references: refs,
        updateReferences: input.updateReferences,
        notes,
      },
      operations: [
        {
          tool: 'restore_snapshot',
          page: { id: '*', name: 'asset library' },
          pageParts: ['image', ...(updated ? ['references'] : [])],
          summaryLabel: summary,
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
  if (!('proposalId' in r) || typeof r.proposalId !== 'string')
    throw new RestoreError('NOT_PROPOSED', 'The restore was not captured as a proposal; nothing was done.');
  const now = d.svc.o.now();
  d.svc.o.db
    .prepare(
      `INSERT INTO snapshot_restores (id, project_id, page_id, page_name, snapshot_id, scope, mode, document_id, proposal_id, state,
         follow_up, requested_by, summary, plan, created_at, updated_at)
       VALUES (?, ?, '*', ?, ?, 'image', NULL, ?, ?, 'proposed', NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      `rst_${randomBytes(8).toString('hex')}`,
      input.projectId,
      old.name,
      input.snapshotId,
      input.assetId,
      r.proposalId,
      origin.principal?.principalId ?? 'owner',
      summary,
      JSON.stringify({ newAsset: row.assetId, references: refs.length, updated }),
      now,
      now,
    );
  const canonical = (r as { canonical?: { reason: string } }).canonical;
  return {
    status: 'proposal_captured',
    proposalId: r.proposalId,
    ...(canonical ? { canonical } : {}),
    old: oldView,
    newAsset: { id: row.assetId, url: newUrl },
    references: refs,
    updated,
    notes,
    summary,
  };
}

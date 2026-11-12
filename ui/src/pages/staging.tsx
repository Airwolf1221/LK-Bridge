import { useEffect, useState, type DragEvent, type FormEvent } from 'react';
import {
  Badge,
  CopyButton,
  Empty,
  ErrorNote,
  Loading,
  PageHeader,
  useAction,
  useConfirm,
} from '../components';
import { fmtAgo, fmtBytes, fmtTime } from '../format';
import { useNow } from '../hooks';
import { useProject, useProjectApi, useProjectReloadOn, useScopedApi } from '../project';
import { useReauth } from '../reauth';
import type {
  StagedImageView,
  StagingActionResponse,
  StagingPreviewResponse,
  StagingResponse,
  StagingUploadResponse,
} from '../types';

/**
 * Staging (v2 D3, ADR 0041): images uploaded and verified but not yet placed. They sit hidden in the project's staging
 * folder. The owner uploads images they have in hand here (choose files or drag them in; the same pipeline and limits
 * as upload_image), gets each one's staged id to give an agent ("place staged image X for Asagiri Miyabi"), or places
 * it here directly. Discarding deletes the asset after the bridge has kept its bytes. Nothing is removed automatically:
 * staged images older than the report age are only reported.
 */

type Kind = 'character' | 'folder' | 'page';

/**
 * The destination the form describes. `sub` is the subfolder path as the owner wrote it (`Wardrobe / Qipao`): it goes to
 * the bridge as it is (the `subfolders` of the destination), which splits it on `/`, trims each part and refuses an empty
 * part, `.` and `..`. Only a character or a page takes one; a folder path already says where.
 */
function destinationOf(kind: Kind, a: string, b: string, sub = ''): Record<string, unknown> | null {
  if (!a.trim()) return null;
  const subfolders = sub.trim() ? { subfolders: sub.trim() } : {};
  if (kind === 'character')
    return { for_character: { name: a.trim(), ...(b.trim() ? { race: b.trim() } : {}) }, ...subfolders };
  if (kind === 'page')
    return { for_page: a.trim(), ...(b.trim() ? { folder: b.trim() } : {}), ...subfolders };
  return { folder: a.trim() };
}

/**
 * Where it will land, worked out by the bridge as a dry run (nothing is written): the full path, each new folder marked,
 * and how many would be created, or the reason it would be refused. Follows what the owner types (after a short pause).
 */
function PathPreview({ destination }: { destination: Record<string, unknown> | null }) {
  const projectApi = useProjectApi();
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'ok'; p: StagingPreviewResponse } | { kind: 'bad'; message: string }
  >({ kind: 'idle' });
  const key = JSON.stringify(destination);
  useEffect(() => {
    const destination = JSON.parse(key) as Record<string, unknown> | null; // `key` is the destination's value
    if (!destination) {
      setState({ kind: 'idle' });
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      projectApi
        .post<StagingPreviewResponse>('/staging/preview', { destination })
        .then((p) => live && setState({ kind: 'ok', p }))
        .catch((e: unknown) => live && setState({ kind: 'bad', message: (e as Error).message }));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, projectApi]);
  if (state.kind === 'idle') return null;
  if (state.kind === 'bad')
    return (
      <p role="alert" className="bad">
        {state.message}
      </p>
    );
  const { p } = state;
  return (
    <p aria-label="Where it will land" data-testid="path-preview">
      <span className="muted">It will land in: </span>
      <span className="path-preview">
        {p.segments.map((s, i) => (
          <span key={i}>
            {i > 0 ? ' / ' : ''}
            {s.new ? (
              <em className="new-folder" title="a new folder">
                {s.name}
              </em>
            ) : (
              s.name
            )}
          </span>
        ))}
      </span>
      {p.newFolders > 0 && (
        <span className="muted">{` (${p.newFolders} new folder${p.newFolders === 1 ? '' : 's'})`}</span>
      )}
    </p>
  );
}

function PlaceForm({ image, onDone }: { image: StagedImageView; onDone: () => void }) {
  const projectApi = useProjectApi();
  const { run, busy } = useAction();
  const [kind, setKind] = useState<Kind>('character');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [subfolder, setSubfolder] = useState('');
  const [name, setName] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const destination = destinationOf(kind, a, b, subfolder);
    void run(
      () =>
        projectApi.post<StagingActionResponse>(`/staging/${image.stagedId}/place`, {
          ...(destination ? { destination } : {}),
          ...(name.trim() ? { name: name.trim() } : {}),
        }),
      'Placed.',
    ).then((r) => r && onDone());
  };
  const id = `place-${image.stagedId}`;
  return (
    <form className="stack" onSubmit={submit} aria-label={`Place ${image.name}`}>
      {image.intended && (
        <p className="muted">Intended: {image.intended}. Leave the fields empty to place it there.</p>
      )}
      <label htmlFor={`${id}-kind`}>Destination</label>
      <select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
        <option value="character">A character (name and race)</option>
        <option value="folder">A folder (path or id)</option>
        <option value="page">A page (character pages give their folder)</option>
      </select>
      <label htmlFor={`${id}-a`}>
        {kind === 'character'
          ? 'Character name'
          : kind === 'page'
            ? 'Page name or id'
            : 'Folder path, e.g. Characters / Humans'}
      </label>
      <input id={`${id}-a`} value={a} onChange={(e) => setA(e.target.value)} />
      {kind !== 'folder' && (
        <>
          <label htmlFor={`${id}-b`}>
            {kind === 'character' ? 'Race (optional)' : 'Folder (for a page that is not a character page)'}
          </label>
          <input id={`${id}-b`} value={b} onChange={(e) => setB(e.target.value)} />
        </>
      )}
      {kind !== 'folder' && (
        <>
          <label htmlFor={`${id}-sub`}>Subfolder (optional)</label>
          <input
            id={`${id}-sub`}
            value={subfolder}
            placeholder="Wardrobe, or Wardrobe / Qipao"
            aria-describedby={`${id}-sub-help`}
            disabled={!a.trim()}
            onChange={(e) => setSubfolder(e.target.value)}
          />
          <p id={`${id}-sub-help`} className="muted">
            Written like the folder chain: Wardrobe, or Wardrobe / Qipao (Qipao inside Wardrobe). Folders that
            exist are used; missing ones are created. Give the {kind === 'character' ? 'character' : 'page'}{' '}
            first.
          </p>
        </>
      )}
      <PathPreview destination={destinationOf(kind, a, b, subfolder)} />
      <label htmlFor={`${id}-name`}>New name (optional)</label>
      <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
      <div className="actions">
        <button type="submit" className="primary" disabled={busy || (!a.trim() && !image.intended)}>
          Place
        </button>
      </div>
    </form>
  );
}

function Uploader({ maxBytes, onDone }: { maxBytes: number; onDone: () => void }) {
  const projectApi = useProjectApi();
  const { run, busy } = useAction();
  const [done, setDone] = useState<{ file: string; result?: StagingUploadResponse; error?: string }[]>([]);
  const [over, setOver] = useState(false);
  const send = async (files: File[]) => {
    for (const f of files) {
      if (f.size > maxBytes) {
        setDone((d) => [...d, { file: f.name, error: `larger than ${fmtBytes(maxBytes)}` }]);
        continue;
      }
      const r = await run(() =>
        projectApi.upload<StagingUploadResponse>(`/staging/upload?name=${encodeURIComponent(f.name)}`, f),
      );
      setDone((d) => [
        ...d,
        r ? { file: f.name, result: r } : { file: f.name, error: 'refused (see the message)' },
      ]);
    }
    onDone();
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void send([...e.dataTransfer.files]);
  };
  return (
    <section className="card" aria-labelledby="staging-upload-h">
      <h2 id="staging-upload-h">Upload</h2>
      <div
        className={`dropzone${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <label htmlFor="staging-files">
          Choose images, or drag them here. PNG, JPEG, GIF or WebP, up to {fmtBytes(maxBytes)} each. Each is
          converted to WebP, uploaded, checked and staged.
        </label>
        <input
          id="staging-files"
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp"
          disabled={busy}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            void send(files);
          }}
        />
      </div>
      {done.length > 0 && (
        <ul aria-label="Uploaded">
          {done.map((d, i) => (
            <li key={i}>
              {d.file}:{' '}
              {d.result ? (
                <>
                  {d.result.deduplicated ? 'already uploaded' : 'staged'} as{' '}
                  <code>{d.result.image.stagedId}</code>{' '}
                  <CopyButton text={d.result.image.stagedId} what="staged id" />
                </>
              ) : (
                <span className="bad">{d.error}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AllowDelete({ onDone }: { onDone: () => void }) {
  const projectApi = useProjectApi();
  const withReauth = useReauth();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const [assetId, setAssetId] = useState('');
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void confirm({
          title: 'Allow a delete without its bytes',
          message: `The next delete of asset ${assetId} (within an hour) goes ahead although its file could not be downloaded and kept. It cannot be restored afterwards.`,
          confirmLabel: 'Allow once',
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          void run(
            () =>
              withReauth(() =>
                projectApi.post('/staging/allow-delete', { assetId: assetId.trim(), confirm: true }),
              ),
            'Allowed once, for an hour.',
          ).then(onDone);
        });
      }}
    >
      <label htmlFor="allow-delete-id">Asset id</label>
      <input id="allow-delete-id" value={assetId} onChange={(e) => setAssetId(e.target.value)} />
      <div className="actions">
        <button type="submit" disabled={busy || !assetId.trim()}>
          Allow one delete
        </button>
      </div>
    </form>
  );
}

export function StagingPage() {
  const { selected } = useProject();
  const now = useNow();
  const projectApi = useProjectApi();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const [placing, setPlacing] = useState<string | null>(null);
  const r = useScopedApi<StagingResponse>('/staging');
  // v2 D3.1: the list follows the bridge's own `staging` event (an agent's stage, an approved placement, a job ending or
  // failing, the owner's other tabs), not only this tab's own actions. The event names the project; others are ignored.
  useProjectReloadOn(['staging'], r.reload);
  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  const d = r.data;
  const discard = (img: StagedImageView) =>
    void confirm({
      title: `Discard “${img.name}”?`,
      message:
        'The asset is deleted from LegendKeeper. Its bytes are kept by the bridge first, so it can be restored.',
      confirmLabel: 'Discard',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      void run(
        () => projectApi.post(`/staging/${img.stagedId}/discard`, { confirm: true }),
        'Discarded.',
      ).then(r.reload);
    });
  return (
    <>
      <PageHeader title="Staging" project={selected}>
        <button type="button" className="small" onClick={r.reload}>
          Refresh
        </button>
      </PageHeader>
      <p className="muted">
        Images uploaded and checked but not yet placed, hidden in the “{d.folder}” folder. Give an agent a
        staged id (“place staged image … for Asagiri Miyabi”), or place it here. Nothing is removed
        automatically.
      </p>
      {d.old > 0 && (
        <p role="status">
          <Badge tone="warn">
            {d.old} staged image{d.old === 1 ? '' : 's'} older than {d.reportDays} days
          </Badge>
        </p>
      )}
      <Uploader maxBytes={d.limits.maxBytes} onDone={r.reload} />
      <section className="card table-wrap" aria-labelledby="staging-list-h">
        <h2 id="staging-list-h">Staged images ({d.staged.length})</h2>
        {d.staged.length === 0 ? (
          <Empty>Nothing is staged.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Image</th>
                <th>Name and staged id</th>
                <th>Size</th>
                <th>Checked</th>
                <th>Who</th>
                <th>When</th>
                <th>Intended</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {d.staged.map((img) => (
                <tr key={img.stagedId}>
                  <td>
                    {img.url ? (
                      <img className="thumb" src={img.url} alt={img.name} width={64} loading="lazy" />
                    ) : (
                      <span className="muted">{img.state === 'uploading' ? 'uploading…' : '—'}</span>
                    )}
                  </td>
                  <td>
                    {img.name}
                    <br />
                    <code>{img.stagedId}</code> <CopyButton text={img.stagedId} what="staged id" />
                    {img.error && <div className="bad">{img.error}</div>}
                  </td>
                  <td>
                    {img.width} × {img.height}
                    {img.frames > 1 ? `, ${img.frames} frames` : ''}
                    <br />
                    {fmtBytes(img.bytes)} WebP ({img.originalFormat.toUpperCase()}{' '}
                    {fmtBytes(img.originalBytes)})
                  </td>
                  <td>
                    {img.storedVerified === true ? (
                      <Badge tone="ok">verified</Badge>
                    ) : img.storedVerified === false ? (
                      <Badge tone="warn">{img.verifyReason ?? 'unverified'}</Badge>
                    ) : (
                      <Badge>not yet</Badge>
                    )}
                  </td>
                  <td>{img.principalId === 'system' ? 'Owner (dashboard)' : img.principalId}</td>
                  <td title={fmtTime(img.createdAt, now)}>
                    {fmtAgo(img.createdAt, now)} {img.old && <Badge tone="warn">old</Badge>}
                  </td>
                  <td>{img.intended ?? <span className="muted">none</span>}</td>
                  <td>
                    {img.placing ? (
                      <span className="muted">
                        {img.placing.proposalId
                          ? `proposal ${img.placing.proposalId}`
                          : `placing (job ${img.placing.jobId})`}
                      </span>
                    ) : img.discarding ? (
                      <span className="muted">discarding</span>
                    ) : img.state === 'uploaded' ? (
                      <>
                        <button
                          type="button"
                          className="small"
                          onClick={() => setPlacing(placing === img.stagedId ? null : img.stagedId)}
                        >
                          Place
                        </button>{' '}
                        <button
                          type="button"
                          className="small danger"
                          disabled={busy}
                          onClick={() => discard(img)}
                        >
                          Discard
                        </button>
                        {placing === img.stagedId && (
                          <PlaceForm
                            image={img}
                            onDone={() => {
                              setPlacing(null);
                              r.reload();
                            }}
                          />
                        )}
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card" aria-labelledby="staging-kept-h">
        <h2 id="staging-kept-h">Bytes kept before deletes</h2>
        <p className="muted">
          Every asset delete, by any route, first keeps the file ({d.kept.files} file
          {d.kept.files === 1 ? '' : 's'}, {fmtBytes(d.kept.bytes)}, kept {d.kept.retentionDays} days). If a
          file cannot be downloaded the delete is refused; you can allow one such delete here.
        </p>
        <AllowDelete onDone={r.reload} />
      </section>
    </>
  );
}

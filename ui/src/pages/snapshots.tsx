import { useEffect, useState, type FormEvent } from 'react';
import { api, background, qs } from '../api';
import {
  Badge,
  Button,
  Empty,
  ErrorNote,
  Loading,
  PageHeader,
  StatusBadge,
  useAction,
  useConfirm,
} from '../components';
import { fmtAgo, fmtBytes, fmtDuration, fmtInt, fmtTime } from '../format';
import { useNow } from '../hooks';
import { useProject, useProjectApi, useProjectReloadOn, useScopedApi } from '../project';
import { Link, useRoute } from '../router';
import type {
  ImageRestoreResponse,
  PlanEstimateView,
  PlanFiguresView,
  PlanNoteView,
  RehearsalPlanResponse,
  RehearsalView,
  RestorePlanView,
  RestoreRecordView,
  RestoreResponse,
  SnapshotDiffResponse,
  SnapshotHistoryEntry,
  SnapshotPageResponse,
  SnapshotPagesResponse,
  SnapshotRowView,
  SnapshotsResponse,
} from '../types';
import { MarkdownDiffView } from './proposals';

/**
 * Snapshots (v2 E1a, ADR 0042; docs/dashboard.md › Snapshots): the bridge's own copies of each page, taken every night
 * in full (which catches edits made in the app) and after every bridge write. The store's size, how much
 * deduplication saves and the disk's free space against the minimum; the runs; any missing or damaged piece; each page's
 * history with its diffs and "Restore…" (v3 F12, ADR 0081: previewed, confirmed in a dialog, then one job at once); a deleted image
 * back as a new asset; the restore rehearsal into the test world; and the nightly database copies.
 */

const KIND_LABEL: Record<string, string> = {
  full: 'full',
  change: 'after a bridge write',
};

const ratio = (r: number | null | undefined) => (r === null || r === undefined ? '—' : `${r.toFixed(1)}×`);

function Notes({ title, notes, tone }: { title: string; notes: PlanNoteView[]; tone?: 'warn' }) {
  if (notes.length === 0) return null;
  return (
    <div className={tone === 'warn' ? 'note note-warn' : 'note'}>
      <strong>{title}</strong>
      <ul>
        {notes.map((n, i) => (
          <li key={i}>
            {n.what}
            {n.where ? <span className="muted"> ({n.where})</span> : null}: {n.why}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A unified diff as text: “-” lines are now (removed by the restore), “+” lines the snapshot. */
function TextDiff({ text, label }: { text: string; label: string }) {
  return (
    <div className="diff" role="group" aria-label={label}>
      {text.split('\n').map((l, i) => (
        <div
          key={i}
          className={`diff-line ${l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-del' : ''}`}
        >
          <span className="mono">{l}</span>
        </div>
      ))}
    </div>
  );
}

const per = (ms: number) => (ms <= 60_000 ? 'minute' : ms <= 3_600_000 ? 'hour' : 'day');
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * v2 E5.5 (backlog 16): which figures a plan's time rests on, in words: the time per write (the measured median of the
 * project's recent write steps, or the configured spacing), the write tier's effective limit and the class's share,
 * and any learned operation limit with the steps it paces.
 */
export function figuresText(f: PlanFiguresView | null | undefined): string | null {
  if (!f) return null;
  const parts: string[] = [];
  const pw = f.perWrite;
  if (pw)
    parts.push(
      pw.from === 'measured'
        ? `a write takes about ${secs(pw.ms)}, the median of the last ${fmtInt(pw.samples)} write steps`
        : pw.measuredMs !== null
          ? `a write takes at least the ${fmtInt(pw.spacingMs)} ms spacing (the last ${fmtInt(pw.samples)} write steps took a median ${secs(pw.measuredMs)})`
          : `a write takes at least the ${fmtInt(pw.spacingMs)} ms spacing (no write steps measured yet)`,
    );
  const wm = f.limits.find((l) => l.tier === 'write-min');
  if (wm && wm.limit !== null)
    parts.push(`writes at ${fmtInt(wm.limit)} a minute (this run’s share ${fmtInt(wm.share)})`);
  for (const g of f.groups)
    parts.push(
      `the ${g.group} group’s learned limit of ${fmtInt(g.limit)} a ${per(g.windowMs)} paces its ${fmtInt(g.steps)} step${g.steps === 1 ? '' : 's'} (about ${fmtDuration(g.ms)})`,
    );
  return parts.length ? `Figures used: ${parts.join('; ')}.` : null;
}

function EstimateLine({ e }: { e: PlanEstimateView }) {
  return (
    <p className="muted small-text" aria-label="Restore estimate">
      When it runs: {fmtInt(e.writes)} write{e.writes === 1 ? '' : 's'} and {fmtInt(e.reads)} read
      {e.reads === 1 ? '' : 's'}
      {e.wallClockMs !== null ? `, about ${fmtDuration(e.wallClockMs)}` : ''}
      {e.fitsToday === false ? ' (more than today’s budget has left)' : ''}. {figuresText(e.figures)}
    </p>
  );
}

function PlanView({ plan }: { plan: RestorePlanView }) {
  return (
    <div className="stack" aria-label="Restore plan">
      <p>
        {plan.summary}{' '}
        <span className="muted">
          ({plan.writes} write{plan.writes === 1 ? '' : 's'}; planning read {plan.reads})
        </span>
      </p>
      {plan.estimate && <EstimateLine e={plan.estimate} />}
      {plan.pieces.map((p) => (
        <details key={p.label} open>
          <summary>{p.label}</summary>
          <TextDiff text={p.diff} label={`Changes to ${p.label}`} />
        </details>
      ))}
      <Notes title="Cannot be restored exactly" notes={plan.lost} tone="warn" />
      <Notes title="Kept as they are now" notes={plan.kept} />
      <Notes title="Left alone" notes={plan.notRestored} />
      {plan.warnings.length > 0 && (
        <div className="note note-warn">
          {plan.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}
      {plan.idMap && Object.keys(plan.idMap).length > 0 && (
        <details>
          <summary>New ids ({Object.keys(plan.idMap).length})</summary>
          <ul className="plain mono small-text">
            {Object.entries(plan.idMap).map(([a, b]) => (
              <li key={a}>
                {a} → {b}
              </li>
            ))}
          </ul>
        </details>
      )}
      {plan.followUp && (
        <p className="muted">
          Once it has run, a second stage brings the page’s content back to the snapshot.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ propose a restore

function RestoreForm({
  page,
  snapshot,
  documents,
  onDone,
}: {
  page: SnapshotPageResponse['page'];
  snapshot: SnapshotHistoryEntry;
  documents: SnapshotPageResponse['documents'];
  onDone: () => void;
}) {
  const projectApi = useProjectApi();
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [scope, setScope] = useState<'page' | 'sidebar' | 'document' | 'deleted'>(
    page.live ? 'page' : 'deleted',
  );
  const [doc, setDoc] = useState(documents[0]?.id ?? '');
  const [mode, setMode] = useState<'auto' | 'undelete' | 'recreate'>('auto');
  const [ids, setIds] = useState<'original' | 'new'>('original');
  const [result, setResult] = useState<RestoreResponse | null>(null);
  const body = (dryRun: boolean) => ({
    page: page.id,
    snapshot: snapshot.snapshot,
    scope,
    ...(scope === 'document' ? { document: doc } : {}),
    ...(scope === 'deleted' ? { mode, ids } : {}),
    ...(dryRun ? { dryRun: true } : { confirm: true }),
  });
  const preview = (e: FormEvent) => {
    e.preventDefault();
    void run(() => projectApi.post<RestoreResponse>('/snapshots/restore', body(true))).then(
      (r) => r && setResult(r),
    );
  };
  // v3 F12 (ADR 0081): one confirmed action: the dialog says what it restores, then it runs at once as one job.
  const propose = async () => {
    const yes = await confirm({
      title: `Restore ${page.name}?`,
      message: (
        <>
          <p>{result?.plan.summary ?? 'The restore previewed below.'}</p>
          <p className="small-text">
            It runs at once as one job, checked again against the page as it is now; follow it on the Jobs
            page.
          </p>
        </>
      ),
      confirmLabel: 'Restore',
    });
    if (!yes) return;
    void run(
      () => projectApi.post<RestoreResponse>('/snapshots/restore', body(false)),
      'Restoring: follow the job on the Jobs page.',
    ).then((r) => {
      if (!r) return;
      setResult(r);
      onDone();
    });
  };
  const id = `restore-${snapshot.snapshot}`;
  return (
    <form className="stack card" onSubmit={preview} aria-label={`Restore to ${snapshot.snapshot}`}>
      <h4>
        Restore {page.name} to {fmtTime(Date.parse(snapshot.takenAt))}
      </h4>
      <label htmlFor={`${id}-scope`}>What to restore</label>
      <select
        id={`${id}-scope`}
        value={scope}
        onChange={(e) => {
          setScope(e.target.value as typeof scope);
          setResult(null);
        }}
      >
        {page.live && <option value="page">The page’s documents</option>}
        {page.live && <option value="sidebar">Its sidebar</option>}
        {page.live && documents.length > 0 && <option value="document">One document</option>}
        <option value="deleted">A deleted page (with its content)</option>
      </select>
      {scope === 'document' && (
        <>
          <label htmlFor={`${id}-doc`}>Document</label>
          <select id={`${id}-doc`} value={doc} onChange={(e) => setDoc(e.target.value)}>
            {documents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name ?? d.id}
              </option>
            ))}
          </select>
        </>
      )}
      {scope === 'deleted' && (
        <>
          <label htmlFor={`${id}-mode`}>How</label>
          <select id={`${id}-mode`} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="auto">Undelete while LegendKeeper keeps it, else recreate</option>
            <option value="undelete">Undelete</option>
            <option value="recreate">Recreate under its snapshot parent</option>
          </select>
          <label htmlFor={`${id}-ids`}>Ids of a recreated page</label>
          <select id={`${id}-ids`} value={ids} onChange={(e) => setIds(e.target.value as typeof ids)}>
            <option value="original">Its original ids (when LegendKeeper accepts them)</option>
            <option value="new">New ids</option>
          </select>
        </>
      )}
      <div className="actions">
        <button type="submit" disabled={busy}>
          Preview
        </button>
        {result?.status === 'dry_run' && (
          <Button variant="primary" busy={busy} onClick={() => void propose()}>
            Restore…
          </Button>
        )}
      </div>
      {result && (
        <div role="status">
          {result.status === 'nothing_to_do' && (
            <p className="note">The page already matches the snapshot here; there is nothing to restore.</p>
          )}
          {result.status === 'submitted' && result.jobId && (
            <p className="note">
              Restoring as job <code>{result.jobId}</code>.{' '}
              <Link to={`/jobs${qs({ id: result.jobId })}`}>Follow it on the Jobs page</Link>.
            </p>
          )}
          {result.status === 'proposal_captured' && result.proposalId && (
            <p className="note">
              Proposed as <code>{result.proposalId}</code>.{' '}
              <Link to={`/proposals${qs({ id: result.proposalId })}`}>Open it on the Proposals page</Link>
              {result.canonical ? ` (it needs canonical approval: ${result.canonical.reason})` : ''}.
            </p>
          )}
          <PlanView plan={result.plan} />
        </div>
      )}
    </form>
  );
}

// ------------------------------------------------------------------------------------------ a page's history

function DiffPanel({
  page,
  piece,
  from,
}: {
  page: string;
  piece: { piece: 'resource' | 'sidebar' | 'document'; ref?: string; label: string };
  from: string;
}) {
  const r = useScopedApi<SnapshotDiffResponse>(
    `/snapshots/diff${qs({ page, from, piece: piece.piece, ref: piece.ref })}`,
  );
  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  return r.data.identical ? (
    <p className="muted">{piece.label}: the same now as at this snapshot.</p>
  ) : (
    <MarkdownDiffView
      diff={r.data.diff}
      title={`${piece.label}: this snapshot (−) against the page now (+), ${r.data.reads} read${r.data.reads === 1 ? '' : 's'}`}
    />
  );
}

function PageHistory({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  // ADR 0042 amendment 2: 50 snapshots at a time, newest first; "Older snapshots" asks for the next 50.
  const [cursors, setCursors] = useState<string[]>([]);
  const r = useScopedApi<SnapshotPageResponse>(
    `/snapshots/pages/${pageId}${qs({ limit: 50, cursor: cursors.at(-1) })}`,
  );
  const [diff, setDiff] = useState<{
    snapshot: string;
    piece: 'resource' | 'sidebar' | 'document';
    ref?: string;
    label: string;
  } | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  const d = r.data;
  return (
    <section className="card" aria-labelledby="page-history-h">
      <div className="row row-between">
        <h3 id="page-history-h">
          {d.page.name} <span className="muted mono small-text">{d.page.id}</span>{' '}
          {!d.page.live && <Badge tone="warn">deleted</Badge>}
        </h3>
        <button type="button" className="small" onClick={onClose}>
          Close
        </button>
      </div>
      {d.history.count === 0 ? (
        <Empty>No snapshot holds this page yet.</Empty>
      ) : (
        <table aria-label="Page history">
          <thead>
            <tr>
              <th>When</th>
              <th>Kind</th>
              <th>Pieces</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {d.history.snapshots.map((s) => (
              <tr key={s.snapshot} data-snapshot={s.snapshot}>
                <td>
                  {fmtTime(Date.parse(s.takenAt))}
                  <br />
                  <span className="mono small-text muted">{s.snapshot}</span>
                </td>
                <td>
                  {KIND_LABEL[s.kind] ?? s.kind}
                  {s.madeBy ? <span className="muted"> ({s.madeBy})</span> : null}
                  {s.partial && (
                    <>
                      {' '}
                      <Badge tone="warn">partial</Badge>
                    </>
                  )}
                </td>
                <td>
                  <ul className="plain">
                    {s.pieces.map((p, i) => {
                      const piece: 'resource' | 'sidebar' | 'document' | null =
                        p.piece === 'settings'
                          ? 'resource'
                          : p.piece === 'sidebar'
                            ? 'sidebar'
                            : p.documentId
                              ? 'document'
                              : null;
                      return (
                        <li key={i}>
                          {p.piece}:{' '}
                          <span className={p.change === 'unchanged' ? 'muted' : ''}>{p.change}</span>
                          {piece && d.page.live && p.change !== 'deleted' && (
                            <>
                              {' '}
                              <button
                                type="button"
                                className="small"
                                onClick={() =>
                                  setDiff({
                                    snapshot: s.snapshot,
                                    piece,
                                    ...(p.documentId ? { ref: p.documentId } : {}),
                                    label: p.piece,
                                  })
                                }
                              >
                                Diff with now
                              </button>
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </td>
                <td>
                  <button
                    type="button"
                    className="small"
                    onClick={() => setRestoring(restoring === s.snapshot ? null : s.snapshot)}
                  >
                    Restore…
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(d.history.next || cursors.length > 0) && (
        <div className="row" aria-label="History pages">
          {cursors.length > 0 && (
            <button type="button" className="small" onClick={() => setCursors((c) => c.slice(0, -1))}>
              Newer snapshots
            </button>
          )}
          {d.history.next && (
            <button
              type="button"
              className="small"
              onClick={() => setCursors((c) => [...c, d.history.next!])}
            >
              Older snapshots
            </button>
          )}
          {d.history.more ? <span className="muted">{d.history.more} older snapshots not shown.</span> : null}
        </div>
      )}
      {diff && (
        <div className="stack">
          <DiffPanel
            key={`${diff.snapshot}:${diff.piece}:${diff.ref ?? ''}`}
            page={d.page.id}
            piece={diff}
            from={diff.snapshot}
          />
          <button type="button" className="small" onClick={() => setDiff(null)}>
            Hide the diff
          </button>
        </div>
      )}
      {restoring && (
        <RestoreForm
          key={restoring}
          page={d.page}
          snapshot={d.history.snapshots.find((s) => s.snapshot === restoring)!}
          documents={d.documents}
          onDone={r.reload}
        />
      )}
      {d.restores.length > 0 && <RestoresTable rows={d.restores} title="Restores of this page" />}
    </section>
  );
}

function PageFinder() {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  // v2 E2: the Audits page links a finding to its page's history as `/snapshots?page=<id>`.
  const { query } = useRoute();
  const [open, setOpen] = useState<string | null>(query.get('page'));
  // ADR 0042 amendment 2: one page of results at a time (50 pages, newest first), filtered on the server by name and
  // branch; `cursors` are the pages of results visited ("Older" pushes the answer's `next`, "Newer" goes back).
  const [branch, setBranch] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const r = useScopedApi<SnapshotPagesResponse>(
    `/snapshots/pages${qs({ q: term, branch, limit: 50, cursor: cursors.at(-1) })}`,
  );
  const pending = r.data?.index?.pending ?? 0;
  return (
    <section className="card" aria-labelledby="snap-pages-h">
      <h2 id="snap-pages-h">Page history</h2>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(q.trim());
          setCursors([]);
        }}
      >
        <label htmlFor="snap-page-q" className="offscreen">
          Page name
        </label>
        <input
          id="snap-page-q"
          placeholder="A page’s name (a deleted page too)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label htmlFor="snap-page-branch" className="offscreen">
          Branch
        </label>
        <select
          id="snap-page-branch"
          value={branch}
          onChange={(e) => {
            setBranch(e.target.value);
            setCursors([]);
          }}
        >
          <option value="">Every branch</option>
          {(r.data?.branches ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name ?? b.id} ({fmtInt(b.pages)})
            </option>
          ))}
        </select>
        <button type="submit">Find</button>
      </form>
      {pending > 0 && (
        <p className="muted" role="status">
          Indexing older snapshots: {fmtInt(pending)} still to index. Their pages appear here as they are
          indexed.
        </p>
      )}
      {!r.data ? (
        r.error ? (
          <ErrorNote error={r.error} onRetry={r.reload} />
        ) : (
          <Loading />
        )
      ) : r.data.pages.length === 0 ? (
        <Empty>No page in the snapshots{term ? ` matches “${term}”` : ''}.</Empty>
      ) : (
        <>
          <ul className="plain" aria-label="Pages in the snapshots">
            {r.data.pages.map((p) => (
              <li key={p.pageId}>
                <button type="button" className="link" onClick={() => setOpen(p.pageId)}>
                  {p.name ?? p.pageId}
                </button>{' '}
                {p.deleted && <Badge tone="warn">deleted</Badge>}{' '}
                <span className="muted small-text">last snapshot {fmtTime(p.lastAt)}</span>
              </li>
            ))}
          </ul>
          {(r.data.next || cursors.length > 0) && (
            <div className="row" aria-label="Result pages">
              <button
                type="button"
                className="small"
                disabled={cursors.length === 0}
                onClick={() => setCursors((c) => c.slice(0, -1))}
              >
                Newer
              </button>
              <span className="muted small-text">Results page {cursors.length + 1}</span>
              <button
                type="button"
                className="small"
                disabled={!r.data.next}
                onClick={() => setCursors((c) => [...c, r.data!.next!])}
              >
                Older
              </button>
            </div>
          )}
        </>
      )}
      {open && <PageHistory key={open} pageId={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

// ------------------------------------------------------------------------------------------ a deleted image

function ImageRestore({ snapshots }: { snapshots: SnapshotRowView[] }) {
  const projectApi = useProjectApi();
  const { run, busy } = useAction();
  const [snapshot, setSnapshot] = useState(snapshots[0]?.id ?? '');
  const [asset, setAsset] = useState('');
  const [update, setUpdate] = useState(false);
  const [result, setResult] = useState<ImageRestoreResponse | null>(null);
  const confirm = useConfirm();
  const send = async (dryRun: boolean) => {
    // v3 F12 (ADR 0081): one confirmed action, then one job at once.
    if (!dryRun) {
      const yes = await confirm({
        title: 'Restore this image?',
        message: (
          <>
            <p>{result?.summary ?? 'The image previewed below comes back as a new asset.'}</p>
            <p className="small-text">It runs at once as one job; follow it on the Jobs page.</p>
          </>
        ),
        confirmLabel: 'Restore the image',
      });
      if (!yes) return;
    }
    void run(
      () =>
        projectApi.post<ImageRestoreResponse>('/snapshots/restore-image', {
          snapshot,
          asset: asset.trim(),
          updateReferences: update,
          ...(dryRun ? { dryRun: true } : { confirm: true }),
        }),
      dryRun ? undefined : 'Restoring: see below.',
    ).then((r) => r && setResult(r));
  };
  return (
    <section className="card" aria-labelledby="snap-image-h">
      <h2 id="snap-image-h">Restore a deleted image</h2>
      <p className="muted">
        LegendKeeper cannot undelete an image, so it comes back as a <strong>new</strong> asset with a new
        URL, uploaded from the bridge’s copy as one job once you confirm it. Tick the box to update the pages
        that showed the old URL in the same job.
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void send(true);
        }}
      >
        <label htmlFor="img-snap">Snapshot</label>
        <select id="img-snap" value={snapshot} onChange={(e) => setSnapshot(e.target.value)}>
          {snapshots.map((s) => (
            <option key={s.id} value={s.id}>
              {fmtTime(s.takenAt)} ({KIND_LABEL[s.kind] ?? s.kind})
            </option>
          ))}
        </select>
        <label htmlFor="img-asset">The deleted image’s asset id</label>
        <input id="img-asset" value={asset} onChange={(e) => setAsset(e.target.value)} />
        <label className="row">
          <input type="checkbox" checked={update} onChange={(e) => setUpdate(e.target.checked)} /> Also update
          the pages that referred to the old URL
        </label>
        <div className="actions">
          <button type="submit" disabled={busy || !asset.trim() || !snapshot}>
            Preview
          </button>
          {result?.status === 'dry_run' && (
            <Button variant="primary" busy={busy} onClick={() => void send(false)}>
              Restore it…
            </Button>
          )}
        </div>
      </form>
      {result && (
        <div className="stack" role="status">
          {result.status === 'submitted' && result.jobId && (
            <p className="note">
              Restoring as job <code>{result.jobId}</code>.{' '}
              <Link to={`/jobs${qs({ id: result.jobId })}`}>Follow it on the Jobs page</Link>.
            </p>
          )}
          {result.status === 'proposal_captured' && result.proposalId && (
            <p className="note">
              Proposed as <code>{result.proposalId}</code>.{' '}
              <Link to={`/proposals${qs({ id: result.proposalId })}`}>Open it on the Proposals page</Link>.
            </p>
          )}
          {result.image && (
            <p>
              Goes back to{' '}
              <strong>
                {result.image.path.length > 0 ? result.image.path.join(' / ') : 'the library’s root'}
              </strong>{' '}
              as “{result.image.name}”
              {result.image.creates.length > 0 && `, making ${result.image.creates.join(', ')}`}.
              {result.status === 'dry_run' && ' Nothing is sent to LegendKeeper until you restore it.'}
            </p>
          )}
          {result.references.length === 0 ? (
            <p className="muted">No page the snapshots hold showed the old URL.</p>
          ) : (
            <>
              <p>Pages that showed the old URL:</p>
              <ul>
                {result.references.map((ref) => (
                  <li key={ref.pageId}>
                    <strong>{ref.page}</strong>
                    {ref.documents.length > 0 &&
                      `: ${ref.documents.map((d) => `${d.name} (${d.what})`).join(', ')}`}
                    {ref.byHand.length > 0 && (
                      <span className="muted"> — change by hand: {ref.byHand.join(', ')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.notes && <Notes title="Notes" notes={result.notes} />}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------ the rehearsal

function RehearsalResult({ r, onChanged }: { r: RehearsalView; onChanged: () => void }) {
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const res = r.result;
  return (
    <div className="stack">
      {r.error && <p className="note note-bad">{r.error}</p>}
      {res && (
        <>
          <p>
            {res.exact ?? 0} of {res.pagesCompared ?? 0} pages restored exactly
            {res.images ? `; ${res.images.uploaded} of ${res.images.of} images uploaded` : ''}
            {res.ms !== undefined ? `; took ${fmtDuration(res.ms)}` : ''}
            {res.cost ? ` (${fmtInt(res.cost.writes)} writes, ${fmtInt(res.cost.reads)} reads)` : ''}.
          </p>
          {(res.differences?.length ?? 0) > 0 && (
            <div className="note note-warn">
              <strong>Differences</strong>
              <ul>
                {res.differences!.map((x, i) => (
                  <li key={i}>
                    <strong>{x.page}</strong>, {x.piece}: {x.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(res.cannotRestore?.length ?? 0) > 0 && (
            <details>
              <summary>What a restore cannot bring back ({res.cannotRestore!.length})</summary>
              <ul>
                {res.cannotRestore!.map((x, i) => (
                  <li key={i}>
                    {x.page ? <strong>{x.page}: </strong> : null}
                    {x.what ? `${x.what}: ` : ''}
                    {x.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {r.rootId && (r.rootState === 'kept' || r.rootState === 'delete_failed') && r.state !== 'running' && (
        <p>
          Its root “{r.rootName}” is {r.rootState === 'kept' ? 'kept to inspect' : 'not deleted (it failed)'}.{' '}
          <Button
            variant="danger"
            busy={busy}
            onClick={() =>
              void confirm({
                title: 'Delete the rehearsal’s root?',
                message: `“${r.rootName}” and everything under it are deleted from the sandbox project.`,
                confirmLabel: 'Delete',
                danger: true,
              }).then((ok) => {
                if (!ok) return;
                void run(
                  () => api.post(`/snapshots/rehearsals/${r.id}/delete-root`, { confirm: true }),
                  'Deleted.',
                ).then(onChanged);
              })
            }
          >
            Delete its root
          </Button>
        </p>
      )}
    </div>
  );
}

/** v2 E5.4: the newest complete full snapshot of a list (newest first, as the API gives them), if any. */
function newestComplete<T extends { kind: string; state: string; takenAt: number }>(
  snaps: readonly T[],
): T | undefined {
  return [...snaps]
    .filter((s) => s.kind === 'full' && s.state === 'complete')
    .sort((a, b) => b.takenAt - a.takenAt)[0];
}

/**
 * v2 E5.5: how far a running rehearsal has got against its plan, from its `progress` (the stage and the counts, saved
 * every few seconds) and its estimate. The projected finish is the elapsed time over the share of the planned work
 * done (writes and reads weighted by the plan's pacing); before 2% of it, the start plus the estimate.
 */
export function rehearsalProgress(r: RehearsalView, now: number) {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const writes = num(r.progress.writes);
  const reads = num(r.progress.reads);
  const plannedWrites = num(r.estimate?.writes);
  const plannedReads = num(r.estimate?.reads);
  const mw = Math.max(1, r.estimate?.pacing?.msPerWrite ?? 1);
  const mr = Math.max(1, r.estimate?.pacing?.msPerRead ?? 1);
  const total = plannedWrites * mw + plannedReads * mr;
  const done = Math.min(writes, plannedWrites) * mw + Math.min(reads, plannedReads) * mr;
  const share = total > 0 ? Math.min(1, done / total) : 0;
  const elapsedMs = Math.max(0, now - r.startedAt);
  const estimateMs = r.estimate?.wallClockMs ?? null;
  const finishAt =
    share >= 0.02 ? r.startedAt + elapsedMs / share : estimateMs !== null ? r.startedAt + estimateMs : null;
  return {
    stage: typeof r.progress.stage === 'string' ? r.progress.stage : 'starting',
    writes,
    plannedWrites,
    reads,
    plannedReads,
    elapsedMs,
    estimateMs,
    finishAt: finishAt === null ? null : Math.max(now, finishAt),
  };
}

function RehearsalProgress({ r, now }: { r: RehearsalView; now: number }) {
  const p = rehearsalProgress(r, now);
  return (
    <div className="small-text" aria-label="Rehearsal progress" data-testid="rehearsal-progress">
      Stage: {p.stage} · writes {fmtInt(p.writes)} of {fmtInt(p.plannedWrites)} · reads {fmtInt(p.reads)} of{' '}
      {fmtInt(p.plannedReads)} · {fmtDuration(p.elapsedMs)} elapsed
      {p.estimateMs !== null ? ` (estimate ${fmtDuration(p.estimateMs)})` : ''}
      {p.finishAt !== null
        ? ` · projected finish ${fmtTime(p.finishAt)} (in ${fmtDuration(p.finishAt - now)})`
        : ''}
    </div>
  );
}

function Rehearsals({ d, onChanged }: { d: SnapshotsResponse; onChanged: () => void }) {
  const now = useNow(5_000);
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const fulls = d.snapshots.filter((s) => s.kind === 'full');
  const targets = d.sandboxes.filter((s) => s.name !== d.project);
  // v2 E5.4: the newest COMPLETE full snapshot is chosen first (a partial one cannot be restored whole).
  const [snapshot, setSnapshot] = useState(newestComplete(fulls)?.id ?? fulls[0]?.id ?? '');
  const [target, setTarget] = useState(targets[0]?.name ?? '');
  const [mode, setMode] = useState<'sampled' | 'full'>('sampled');
  const [keep, setKeep] = useState(false);
  const [plan, setPlan] = useState<RehearsalPlanResponse['plan'] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setPlan(null), [snapshot, target, mode]);
  const estimate = (e: FormEvent) => {
    e.preventDefault();
    void run(() =>
      api.post<RehearsalPlanResponse>('/snapshots/rehearsals/plan', { target, snapshot, mode }),
    ).then((r) => r && setPlan(r.plan));
  };
  const start = () =>
    void confirm({
      title: 'Start the rehearsal?',
      message: `About ${fmtInt(plan!.estimate.writes)} writes and ${fmtInt(plan!.estimate.reads)} reads into ${target}, under a new top-level page that is ${keep ? 'kept afterwards' : 'deleted at the end'}. Nothing outside it is written.`,
      confirmLabel: 'Start',
    }).then((ok) => {
      if (!ok) return;
      void run(
        () => api.post('/snapshots/rehearsals', { target, snapshot, mode, keep, confirm: true }),
        'Started: it runs in the background.',
      ).then(() => {
        setPlan(null);
        onChanged();
      });
    });
  return (
    <section className="card" aria-labelledby="snap-rh-h">
      <h2 id="snap-rh-h">Restore rehearsal</h2>
      <p className="muted">
        Restores a full snapshot into a throwaway page of a sandbox project (the test world), with new ids,
        compares every page with the snapshot, then deletes it. Sampled: about 50 pages covering every kind of
        block and document, maps, boards, the chronology and images, with at most 25 events of a timeline and
        40 features of a map. Never into the project the snapshot came from.
      </p>
      {targets.length === 0 ? (
        <p className="note">
          No sandbox project to rehearse into. Mark the test world as a sandbox on the{' '}
          <Link to="/projects">Projects</Link> page.
        </p>
      ) : fulls.length === 0 ? (
        <p className="note">There is no full snapshot of {d.project} yet.</p>
      ) : (
        <form className="stack" onSubmit={estimate}>
          <label htmlFor="rh-snap">Full snapshot of {d.project}</label>
          <select id="rh-snap" value={snapshot} onChange={(e) => setSnapshot(e.target.value)}>
            {fulls.map((s) => (
              <option key={s.id} value={s.id}>
                {fmtTime(s.takenAt)} ({fmtInt(s.pages)} pages){s.state === 'partial' ? ' (partial)' : ''}
              </option>
            ))}
          </select>
          <label htmlFor="rh-target">Into</label>
          <select id="rh-target" value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => (
              <option key={t.name} value={t.name} disabled={!t.active}>
                {t.name}
                {t.active ? '' : ' (not served now)'}
              </option>
            ))}
          </select>
          <label htmlFor="rh-mode">Pages</label>
          <select id="rh-mode" value={mode} onChange={(e) => setMode(e.target.value as 'sampled' | 'full')}>
            <option value="sampled">A sample (about 50)</option>
            <option value="full">Every page</option>
          </select>
          <label className="row">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep the copy
            afterwards to inspect it
          </label>
          <div className="actions">
            <button type="submit" disabled={busy || !snapshot || !target}>
              Estimate
            </button>
            {plan && (
              <Button variant="primary" busy={busy} onClick={start}>
                Start the rehearsal
              </Button>
            )}
          </div>
          {plan && (
            <p role="status" aria-label="Rehearsal estimate">
              {fmtInt(plan.pages.length)} pages, {fmtInt(plan.images)} images: about{' '}
              {fmtInt(plan.estimate.writes)} writes and {fmtInt(plan.estimate.reads)} reads
              {plan.estimate.wallClockMs !== null
                ? `, about ${fmtDuration(plan.estimate.wallClockMs)} at background priority`
                : ''}
              {plan.estimate.fitsToday === false ? ' (more than today’s budget has left)' : ''}.
              {plan.estimate.pacing
                ? ` Paced at about ${(plan.estimate.pacing.msPerWrite / 1000).toFixed(1)} s a write and ${(plan.estimate.pacing.msPerRead / 1000).toFixed(1)} s a read.`
                : ''}
            </p>
          )}
          {plan && figuresText(plan.estimate.figures) && (
            <p className="muted small-text" aria-label="Estimate figures">
              {figuresText(plan.estimate.figures)}
            </p>
          )}
          {plan && (plan.cuts ?? []).length > 0 && (
            <div className="note" aria-label="What the sample leaves out">
              <strong>Left out of the sample</strong>
              <ul>
                {plan.cuts!.map((x, i) => (
                  <li key={i}>
                    {x.page}, {x.document}: {fmtInt(x.kept)} of {fmtInt(x.of)} {x.what}
                    {x.lanes
                      ? ` (with the ${fmtInt(x.lanes.kept)} of ${fmtInt(x.lanes.of)} lanes they use)`
                      : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </form>
      )}
      {d.rehearsals.length > 0 && (
        <table aria-label="Rehearsals">
          <thead>
            <tr>
              <th>Started</th>
              <th>Snapshot</th>
              <th>Pages</th>
              <th>State</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {d.rehearsals.map((r) => (
              <tr key={r.id} data-rehearsal={r.id}>
                <td>{fmtTime(r.startedAt)}</td>
                <td className="mono small-text">{r.snapshotId}</td>
                <td>{r.mode}</td>
                <td>
                  <StatusBadge status={r.state} />
                  {r.state === 'running' && <RehearsalProgress r={r} now={now} />}
                </td>
                <td>
                  {r.result
                    ? `${r.result.exact ?? 0} of ${r.result.pagesCompared ?? 0} exact`
                    : (r.error ?? '—')}{' '}
                  <button
                    type="button"
                    className="small"
                    onClick={() => setOpen(open === r.id ? null : r.id)}
                  >
                    {open === r.id ? 'Hide' : 'Details'}
                  </button>
                  {open === r.id && <RehearsalResult r={r} onChanged={onChanged} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------ the page

function RestoresTable({ rows, title }: { rows: RestoreRecordView[]; title: string }) {
  const projectApi = useProjectApi();
  const { run, busy } = useAction();
  const [finished, setFinished] = useState<Record<string, string>>({});
  const confirm = useConfirm();
  /**
   * v3 F2 (ADR 0049 decision 6): a recreate that stopped part-way, finished for only what is missing. v3 F12 (ADR
   * 0081): confirmed, it runs at once as one job.
   */
  const finish = async (id: string) => {
    const yes = await confirm({
      title: 'Finish this restore?',
      message: (
        <p>The restore is planned again for only what the page still lacks, and runs at once as one job.</p>
      ),
      confirmLabel: 'Finish',
    });
    if (!yes) return;
    void run(() =>
      projectApi.post<{ status: string; proposalId?: string; jobId?: string; summary?: string }>(
        `/snapshots/restores/${encodeURIComponent(id)}/finish`,
        {},
      ),
    ).then((r) => {
      if (r)
        setFinished((f) => ({
          ...f,
          [id]: r.jobId
            ? `Finishing: job ${r.jobId}`
            : r.proposalId
              ? `Proposed: ${r.proposalId}`
              : 'Nothing is missing: the page is complete.',
        }));
    });
  };
  return (
    <div className="table-wrap">
      <h3>{title}</h3>
      <table aria-label={title}>
        <thead>
          <tr>
            <th>When</th>
            <th>Page</th>
            <th>What</th>
            <th>State</th>
            <th>Proposal</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{fmtTime(r.createdAt)}</td>
              <td>{r.pageName}</td>
              <td>
                {r.scope}
                {r.mode ? ` (${r.mode})` : ''} to <span className="mono small-text">{r.snapshotId}</span>
              </td>
              <td>
                {r.state}
                {(r.couldntRestoreExactly?.length ?? 0) > 0 && (
                  <>
                    {' '}
                    <Badge tone="warn">couldn’t be restored exactly</Badge>
                    <ul className="plain small-text">
                      {r.couldntRestoreExactly!.map((c, i) => (
                        <li key={i}>
                          {c.what}: {c.why}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </td>
              <td>
                {r.jobId && <Link to={`/jobs${qs({ id: r.jobId })}`}>{r.jobId}</Link>}
                {r.proposalId && <Link to={`/proposals${qs({ id: r.proposalId })}`}>{r.proposalId}</Link>}
                {r.followUpProposalId && (
                  <>
                    {', then '}
                    <Link to={`/proposals${qs({ id: r.followUpProposalId })}`}>{r.followUpProposalId}</Link>
                  </>
                )}
                {r.scope === 'deleted' &&
                  r.mode === 'recreate' &&
                  r.state === 'failed' &&
                  !finished[r.id] && (
                    <div>
                      <Button className="small" busy={busy} onClick={() => void finish(r.id)}>
                        Finish
                      </Button>
                      <span className="muted small-text">
                        {' '}
                        writes only what the recreated page still lacks
                      </span>
                    </div>
                  )}
                {finished[r.id] && <div className="small-text">{finished[r.id]}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StoreCard({ d }: { d: SnapshotsResponse }) {
  const o = d.overview;
  const est = o.nextFullEstimate ?? null;
  const tight = est !== null && o.headroom !== null && est > o.headroom;
  return (
    <section className="card" aria-labelledby="snap-store-h">
      <h2 id="snap-store-h">The store</h2>
      <dl className="settings-list" aria-label="Snapshot store">
        <dt>Size on disk</dt>
        <dd data-testid="store-size">
          {o.store.measuredAt === null && o.store.measuring ? (
            'measuring…'
          ) : (
            <>
              {fmtBytes(o.store.bytes)} ({fmtInt(o.store.objects)} pieces, {fmtInt(o.store.manifests)}{' '}
              manifests)
            </>
          )}
        </dd>
        <dt>Deduplication</dt>
        <dd data-testid="dedup">
          {ratio(o.dedupRatio)}: the snapshots hold {fmtBytes(o.logical.referenced)} of pieces, stored once as{' '}
          {fmtBytes(o.logical.unique)}
          {o.compressionRatio ? `, compressed ${ratio(o.compressionRatio)}` : ''}
        </dd>
        <dt>Free space</dt>
        <dd data-testid="free-space">
          {o.disk ? (
            <>
              {fmtBytes(o.disk.free)} free of {fmtBytes(o.disk.total)}; the minimum kept free is{' '}
              {fmtBytes(o.minFreeBytes)}
              {o.headroom !== null && o.headroom < 0 ? (
                <>
                  {' '}
                  <Badge tone="bad">below the minimum: full snapshots are refused</Badge>
                </>
              ) : null}
            </>
          ) : (
            'unknown'
          )}
        </dd>
        <dt>Next full snapshot</dt>
        <dd data-testid="next-estimate">
          {est === null ? (
            '—'
          ) : (
            <>
              at most about {fmtBytes(est)} new
              {o.headroom !== null ? ` against ${fmtBytes(Math.max(0, o.headroom))} of headroom` : ''}{' '}
              {tight ? <Badge tone="bad">does not fit</Badge> : <Badge tone="ok">fits</Badge>}
            </>
          )}
        </dd>
        <dt>Kept</dt>
        <dd>
          every full snapshot for {o.retention.keepFullDays} days, then one a week (the latest of each ISO
          week) for {o.retention.keepWeekly} weeks; change snapshots for {o.retention.keepDays} days
        </dd>
        <dt>Directory</dt>
        <dd className="mono small-text">{o.dir}</dd>
      </dl>
      {(o.owed ?? 0) > 0 && (
        <p className="muted">{o.owed} change snapshots are waiting to be taken (they follow the writes).</p>
      )}
    </section>
  );
}

function Problems({ d }: { d: SnapshotsResponse }) {
  const { findings, notices } = d.overview;
  if (findings.length === 0 && notices.length === 0) return null;
  return (
    <section className="card" aria-labelledby="snap-problems-h">
      <h2 id="snap-problems-h">Findings</h2>
      {findings.length > 0 && (
        <div className="note note-bad" role="alert">
          <strong>
            {findings.length} stored piece{findings.length === 1 ? ' is' : 's are'} missing or damaged.
          </strong>{' '}
          The snapshots that use them are partial: a restore from them cannot bring those pieces back.
          <ul>
            {findings.map((f) => (
              <li key={f.id}>
                <span className="mono small-text">{f.sha256.slice(0, 16)}…</span> {f.problem}
                {f.detail ? `: ${f.detail}` : ''} ({f.snapshots.length} snapshot
                {f.snapshots.length === 1 ? '' : 's'}; found {fmtTime(f.foundAt)})
              </li>
            ))}
          </ul>
        </div>
      )}
      {notices.length > 0 && (
        <ul aria-label="Notices">
          {notices.map((n) => (
            <li key={n.id}>
              <Badge tone={n.level === 'error' ? 'bad' : n.level === 'warning' ? 'warn' : 'info'}>
                {n.code}
              </Badge>{' '}
              {n.message} <span className="muted small-text">{fmtTime(n.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Runs({ d, onChanged }: { d: SnapshotsResponse; onChanged: () => void }) {
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const runs = d.overview.runs ?? [];
  return (
    <section className="card" aria-labelledby="snap-runs-h">
      <h2 id="snap-runs-h">Runs and schedules</h2>
      {runs
        .filter((r) => r.kind === 'full' && r.state === 'running')
        .map((r) => (
          <p key={r.id} data-testid="full-progress">
            Full snapshot running: <strong>{fmtInt(r.done)}</strong> of {fmtInt(r.total)} pages
            {r.total > 0 ? ` (${Math.floor((r.done / r.total) * 100)}%)` : ''}, at P4 (bulk): it gives way to
            agents’ work and to routine maintenance.
            {d.overview.bulkWait ? (
              <span className="muted" data-testid="bulk-wait">
                {' '}
                Now {d.overview.bulkWait}.
              </span>
            ) : null}
          </p>
        ))}
      {d.overview.dayHold && (
        <p
          className={d.overview.dayHold.holding ? 'note note-warn' : 'muted small-text'}
          data-testid="day-hold"
          role={d.overview.dayHold.holding ? 'status' : undefined}
        >
          {d.overview.dayHold.holding
            ? `The full snapshot is held by the daily tier’s floor (since ${fmtTime(d.overview.dayHold.sinceMs)}): ${d.overview.dayHold.text}. It goes on from the page it reached when the tier frees; the day floors are on the Budgets page.`
            : `The last full snapshot was held by the daily tier’s floor from ${fmtTime(d.overview.dayHold.sinceMs)}${d.overview.dayHold.endedAtMs !== null ? ` to ${fmtTime(d.overview.dayHold.endedAtMs)}` : ''}.`}
        </p>
      )}
      <ul className="plain" aria-label="Snapshot jobs">
        {d.jobs.map((j) => (
          <li key={j.id}>
            <strong>{j.name}</strong>: {j.enabled ? j.scheduleText : 'switched off'}
            {j.enabled && j.nextRunAt ? <span className="muted"> (next {fmtTime(j.nextRunAt)})</span> : null}
            {j.lastRun ? (
              <span className="muted">
                ; last {fmtTime(j.lastRun.at)}, {j.lastRun.outcome}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="muted small-text">
        Schedules are changed on the <Link to="/maintenance">Maintenance Jobs</Link> page.
      </p>
      {runs.length === 0 ? (
        <Empty>No run yet.</Empty>
      ) : (
        <table aria-label="Runs">
          <thead>
            <tr>
              <th>Started</th>
              <th>Kind</th>
              <th>State</th>
              <th>Pages</th>
              <th>Requests</th>
              <th>New</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} data-run={r.id}>
                <td>{fmtTime(r.startedAt)}</td>
                <td>
                  {r.kind} <span className="muted">({r.trigger})</span>
                </td>
                <td>
                  <StatusBadge status={r.state} />
                  {r.error && <div className="small-text">{r.error}</div>}
                </td>
                <td>
                  {fmtInt(r.done)} of {fmtInt(r.total)}
                </td>
                <td>
                  {fmtInt(r.reads)} reads{r.downloads ? `, ${fmtInt(r.downloads)} downloads` : ''}
                </td>
                <td>
                  {fmtInt(r.newObjects)} pieces ({fmtBytes(r.newBytes)})
                  {r.finishedAt ? (
                    <div className="muted small-text">took {fmtDuration(r.finishedAt - r.startedAt)}</div>
                  ) : null}
                </td>
                <td>
                  {r.state === 'running' && (
                    <Button
                      className="small"
                      busy={busy}
                      onClick={() =>
                        void confirm({
                          title: 'Abandon this run?',
                          message:
                            'It stops for good and is not continued; nothing it took becomes a snapshot. The next full snapshot starts afresh.',
                          confirmLabel: 'Abandon',
                          danger: true,
                        }).then((ok) => {
                          if (!ok) return;
                          void run(
                            () => api.post(`/snapshots/runs/${r.id}/abandon`, { confirm: true }),
                            'Abandoned.',
                          ).then(onChanged);
                        })
                      }
                    >
                      Abandon
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function SnapshotList({ d }: { d: SnapshotsResponse }) {
  return (
    <section className="card table-wrap" aria-labelledby="snap-list-h">
      <h2 id="snap-list-h">Snapshots ({d.snapshots.length})</h2>
      {d.snapshots.length === 0 ? (
        <Empty>No snapshot yet. The first full snapshot runs at night, or take one now.</Empty>
      ) : (
        <table aria-label="Snapshots">
          <thead>
            <tr>
              <th>Taken</th>
              <th>Kind</th>
              <th>Pages</th>
              <th>New</th>
              <th>Requests</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {d.snapshots.map((s) => (
              <tr key={s.id} data-snapshot={s.id}>
                <td>
                  {fmtTime(s.takenAt)}
                  <br />
                  <span className="mono small-text muted">{s.id}</span>
                </td>
                <td>
                  {KIND_LABEL[s.kind] ?? s.kind}
                  {typeof s.trigger.tool === 'string' ? (
                    <span className="muted"> ({s.trigger.tool})</span>
                  ) : null}
                </td>
                <td>{fmtInt(s.pages)}</td>
                <td>
                  {fmtInt(s.newObjects)} pieces ({fmtBytes(s.newBytes)})
                </td>
                <td>
                  {fmtInt(s.reads)}
                  {s.downloads ? ` + ${fmtInt(s.downloads)} downloads` : ''}
                </td>
                <td>
                  {s.state === 'partial' ? (
                    <Badge tone="warn">
                      partial{s.missing ? `: ${s.missing} missing` : ''}
                      {s.damaged ? `: ${s.damaged}` : ''}
                    </Badge>
                  ) : (
                    <Badge tone="ok">complete</Badge>
                  )}
                  {s.missing > 0 && <MissingPieces s={s} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * v3 F2 (ADR 0049 decision 4): a partial snapshot's missing pieces, from its manifest: the page (a link to it in the
 * tree), the piece, its reference and why it is missing. Collapsed until asked for.
 */
function MissingPieces({ s }: { s: SnapshotRowView }) {
  if (s.missingPieces === null)
    return <div className="muted small-text">Its manifest could not be read to list them.</div>;
  const list = s.missingPieces ?? [];
  if (list.length === 0) return null;
  return (
    <details className="small-text" data-testid="missing-pieces">
      <summary>Show what is missing</summary>
      <table aria-label={`Missing pieces of ${s.id}`}>
        <thead>
          <tr>
            <th>Page</th>
            <th>Piece</th>
            <th>Reference</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {list.map((x, i) => (
            <tr key={i}>
              <td>
                {x.pageId === null ? (
                  <span className="muted">the asset library</span>
                ) : (
                  <Link to={`/tree?node=${encodeURIComponent(x.pageId)}`}>{x.pageName ?? x.pageId}</Link>
                )}
              </td>
              <td>{x.piece}</td>
              <td className="mono">{x.ref ?? ''}</td>
              <td>{x.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.missingMore ? <div className="muted">and {fmtInt(s.missingMore)} more.</div> : null}
    </details>
  );
}

function Backups({ d, now }: { d: SnapshotsResponse; now: number }) {
  const b = d.backups;
  const newest = b.files.find((f) => f.label === 'nightly');
  const stale = !newest || now - newest.at > 36 * 3_600_000;
  return (
    <section className="card table-wrap" aria-labelledby="snap-backups-h">
      <h2 id="snap-backups-h">Database copies</h2>
      <p className="muted">
        The nightly copies of the bridge’s database (deploy/backup.sh): its settings, journal, proposals and
        the snapshot index. The snapshot store itself is copied off the server in E1b.{' '}
        <span className="mono small-text">{b.dir}</span>
      </p>
      {stale && (
        <p className="note note-warn" role="alert">
          {newest
            ? `The newest nightly copy is ${fmtAgo(newest.at, now)} old.`
            : `No nightly copy found${b.error ? ` (${b.error})` : ''}.`}
        </p>
      )}
      {b.files.length > 0 && (
        <table aria-label="Database copies">
          <thead>
            <tr>
              <th>Copy</th>
              <th>Taken</th>
              <th>Age</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {b.files.slice(0, 20).map((f) => (
              <tr key={f.name}>
                <td className="mono small-text">{f.name}</td>
                <td>{fmtTime(f.at)}</td>
                <td>{fmtAgo(f.at, now)}</td>
                <td>{fmtBytes(f.size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function SnapshotsPage() {
  const { selected } = useProject();
  const projectApi = useProjectApi();
  const now = useNow(10_000);
  const { run, busy } = useAction();
  const r = useScopedApi<SnapshotsResponse>('/snapshots');
  useProjectReloadOn(['proposal', 'job'], r.reload, 1000);
  const active =
    (r.data?.overview.runs ?? []).some((x) => x.state === 'running') ||
    (r.data?.rehearsals ?? []).some((x) => x.state === 'running');
  useEffect(() => {
    // CR-2026-11-R4: the page's own refresh, not the owner's use of the session.
    const t = setInterval(background(r.reload), active ? 3000 : 60_000);
    return () => clearInterval(t);
  }, [active, r.reload]);
  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  const d = r.data;
  return (
    <>
      <PageHeader title="Snapshots" project={selected}>
        <button type="button" className="small" onClick={r.reload}>
          Refresh
        </button>
        <Button
          variant="primary"
          busy={busy}
          onClick={() =>
            void run(
              () => projectApi.post('/snapshots/full'),
              'A full snapshot is running in the background.',
            ).then(r.reload)
          }
        >
          Take a full snapshot now
        </Button>
      </PageHeader>
      <p className="muted">
        The bridge keeps its own copies of every page under the AI REPOSITORY: a full snapshot every night
        (which catches edits made in the LegendKeeper app within a day) and one after every bridge write. Each
        piece is stored once, and an image that has not changed is not downloaded again. A restore is
        previewed, then confirmed, and runs at once as one job.
      </p>
      <StoreCard d={d} />
      <Problems d={d} />
      <Runs d={d} onChanged={r.reload} />
      <PageFinder />
      {d.restores.length > 0 && (
        <section className="card">
          <RestoresTable rows={d.restores} title="Restores proposed" />
        </section>
      )}
      <ImageRestore snapshots={d.snapshots} />
      <Rehearsals d={d} onChanged={r.reload} />
      <SnapshotList d={d} />
      <Backups d={d} now={now} />
    </>
  );
}

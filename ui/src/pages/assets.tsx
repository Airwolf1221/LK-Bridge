import { useEffect, useState, type ReactNode } from 'react';
import { background } from '../api';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, useAction, useConfirm } from '../components';
import { fmtAgo, fmtBytes, fmtDuration, fmtInt, fmtTime } from '../format';
import { useNow } from '../hooks';
import { useProject, useProjectApi, useScopedApi } from '../project';
import { Link } from '../router';
import { OutfitsCard } from './outfits';
import { ArchivesCard } from './archives';
import type {
  AssetChildren,
  AssetCorrection,
  AssetOverview,
  AssetPass,
  AssetPlanResponse,
  AssetTreeStatusName,
} from '../types';

/**
 * Asset Tree (v2 A4, docs/assets.md): the bridge's own model of the selected project's asset library. Its status and
 * counts, the build (the root level is listed first and the estimate shown; nothing more is read until you confirm),
 * the last build, refresh and check, the correction log, a browsable folder tree and a read-only "Try it" panel that
 * shows where an image of a character would be placed. The model is updated after each of the bridge's own asset
 * writes, by a regular refresh (every 6 hours) and by a nightly check.
 */

const STATUS: Record<
  AssetTreeStatusName,
  { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' }
> = {
  not_built: { label: 'Not built', tone: 'warn' },
  building: { label: 'Building', tone: 'info' },
  ready: { label: 'Ready', tone: 'ok' },
  stale: { label: 'Stale', tone: 'warn' },
};

const PASS_TONE = {
  succeeded: 'ok',
  failed: 'bad',
  cancelled: 'neutral',
  interrupted: 'warn',
  preparing: 'info',
  walking: 'info',
  awaiting_confirmation: 'warn',
} as const;

const PASS_STATUS: Record<string, string> = {
  preparing: 'Listing the root level',
  awaiting_confirmation: 'Waiting for you',
  walking: 'Walking the folders',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export function AssetsPage() {
  const { selected } = useProject();
  const overview = useScopedApi<AssetOverview>('/asset-tree');
  const data = overview.data;
  const busyNow = data ? data.activePass !== null : false;
  // A running pass is followed closely; otherwise the page refreshes now and then (CR-2026-11-R4: the page's own
  // refresh, not the owner's use of the session).
  useEffect(() => {
    const t = setInterval(background(overview.reload), busyNow ? 2000 : 30_000);
    return () => clearInterval(t);
  }, [overview.reload, busyNow]);
  const now = useNow();

  if (overview.error && !data) return <ErrorNote error={overview.error} onRetry={overview.reload} />;
  if (!data) return <Loading />;
  const status = STATUS[data.tree.status];
  const built = data.tree.status !== 'not_built' || data.counts.folders > 0;

  return (
    <>
      <PageHeader title="Asset Tree" project={selected}>
        <button type="button" className="small" onClick={overview.reload}>
          Refresh
        </button>
      </PageHeader>
      <p className="muted">
        The bridge’s own copy of this project’s asset library: its folders and the images, maps and audio in
        them. LegendKeeper lists one folder at a time, so the bridge walks every folder. The copy is updated
        after each of the bridge’s own asset writes, by a regular refresh (every 6 hours) and by a nightly
        check. It is what decides where a character’s images go.
      </p>
      <ErrorNote error={overview.error} onRetry={overview.reload} />

      <section className="card" aria-labelledby="assets-status-h" data-testid="assets-status">
        <h2 id="assets-status-h">Status</h2>
        <div className="row">
          <Badge tone={status.tone}>{status.label}</Badge>
          {data.tree.reason && <span>{data.tree.reason}</span>}
        </div>
        <p className="muted small-text">
          Last confirmed{' '}
          {data.tree.confirmedAt
            ? `${fmtAgo(data.tree.confirmedAt, now)} by a ${data.tree.confirmedBy}`
            : 'never'}
          {data.tree.pendingRereads > 0 ? ` · ${data.tree.pendingRereads} re-read(s) owed` : ''}
        </p>
        {built && <Counts data={data} />}
      </section>

      <BuildCard data={data} now={now} onChanged={overview.reload} />
      <PassesCard data={data} now={now} />
      {data.stale.folders.length + data.stale.assets.length > 0 && <StaleCard data={data} />}
      {data.rereads.failed.length > 0 && <RereadsCard data={data} now={now} />}
      <CorrectionLog />
      {data.counts.folders + data.counts.assets > 0 && <FolderBrowser />}
      {built && <TryIt />}
      {built && <OutfitsCard />}
      <ArchivesCard />
    </>
  );
}

function Counts({ data }: { data: AssetOverview }) {
  const c = data.counts;
  const stats: [string, number][] = [
    ['Folders', c.folders],
    ['Assets', c.assets],
    ['Images', c.byType.IMAGE ?? 0],
    ['Deepest folder', c.maxDepth],
    ['With a SHA-256', c.withHash],
    ['Stale', c.stale],
  ];
  return (
    <div className="grid" data-testid="assets-counts">
      {stats.map(([label, n]) => (
        <div className="stat" key={label}>
          <span className="stat-value">{fmtInt(n)}</span>
          <span className="stat-label">{label}</span>
        </div>
      ))}
    </div>
  );
}

function BuildCard({ data, now, onChanged }: { data: AssetOverview; now: number; onChanged: () => void }) {
  const projectApi = useProjectApi();
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const pass = data.activePass?.kind === 'build' ? data.activePass : null;
  const built = data.tree.status !== 'not_built';
  const start = (rebuild: boolean) => {
    void confirm({
      title: rebuild ? 'Rebuild the asset tree?' : 'Start the first build?',
      message: (
        <>
          <p>
            The bridge first lists the root level of the asset library (one request) and then shows you the
            estimate. Nothing else is read until you confirm it.
          </p>
          <p className="muted small-text">All of it runs at the lowest priority (P3), behind agents’ work.</p>
        </>
      ),
      confirmLabel: 'List the root level',
    }).then((ok) => {
      if (ok) void run(() => projectApi.post('/asset-tree/build')).then(onChanged);
    });
  };
  const cancel = () => {
    void confirm({
      title: 'Cancel the build?',
      message: <p>What has been read so far is kept. You can start the build again later.</p>,
      confirmLabel: 'Cancel the build',
      danger: true,
    }).then((ok) => {
      if (ok)
        void run(
          () => projectApi.post('/asset-tree/build/cancel', { confirm: true }),
          'Build cancelled.',
        ).then(onChanged);
    });
  };
  return (
    <section className="card" aria-labelledby="assets-build-h" data-testid="assets-build">
      <h2 id="assets-build-h">Build and refresh</h2>
      {!pass && data.activePass && (
        <p className="muted">
          A {data.activePass.kind} is running ({PASS_STATUS[data.activePass.status]}).
        </p>
      )}
      {!pass && !data.activePass && (
        <div className="row">
          {!built ? (
            <Button busy={busy} onClick={() => start(false)}>
              Start the first build…
            </Button>
          ) : (
            <>
              <Button
                className="small"
                busy={busy}
                onClick={() =>
                  void run(() => projectApi.post('/asset-tree/refresh'), 'Refresh started.').then(onChanged)
                }
              >
                Refresh now
              </Button>
              <Button className="small" busy={busy} onClick={() => start(true)}>
                Rebuild…
              </Button>
            </>
          )}
          {data.lastBuild && (
            <span className="muted small-text">
              Last build {fmtAgo(data.lastBuild.finishedAt, now)}:{' '}
              {data.lastBuild.summary ?? data.lastBuild.error}
            </span>
          )}
        </div>
      )}
      {pass && <BuildProgress pass={pass} now={now} />}
      {pass?.status === 'awaiting_confirmation' && pass.estimate && (
        <div className="stack" data-testid="assets-estimate">
          <p>
            The library’s root level has <strong>{fmtInt(pass.estimate.rootFolders)}</strong> folders and{' '}
            {fmtInt(pass.estimate.rootAssets)} assets (1 request made). The walk makes{' '}
            <strong>one request per folder</strong>, plus one for every further 100 items in a folder, and
            folders are only found by listing the folder above them, so the total grows as it goes.
          </p>
          <p>
            At least <strong>{fmtInt(pass.estimate.minRequestsRemaining)}</strong> more requests
            {pass.estimate.basis === 'the previous inventory' ? (
              <>
                ; going by the previous inventory ({fmtInt(pass.estimate.previousFolders)} folders,{' '}
                {fmtInt(pass.estimate.previousAssets)} assets), about{' '}
                <strong>{fmtInt(pass.estimate.likelyRequestsRemaining)}</strong>
              </>
            ) : null}
            , at P4 (bulk): about <strong>{fmtDuration(pass.estimate.wallClockMs)}</strong> at the current
            budget
            {pass.estimate.tightestTier ? ` (limited by ${pass.estimate.tightestTier})` : ''}.{' '}
            {pass.estimate.fitsInDailyBudget
              ? 'It fits in what is left of today’s budget.'
              : 'It does NOT fit in what is left of today’s budget: it will wait for the budget to recover.'}
          </p>
          <div className="row">
            <Button
              busy={busy}
              onClick={() =>
                void run(
                  () => projectApi.post('/asset-tree/build/confirm', { confirm: true }),
                  'Build started.',
                ).then(onChanged)
              }
            >
              Start walking the folders
            </Button>
            <Button className="small" busy={busy} onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {pass && pass.status !== 'awaiting_confirmation' && (
        <Button className="small" busy={busy} onClick={cancel}>
          Cancel the build…
        </Button>
      )}
    </section>
  );
}

function BuildProgress({ pass, now }: { pass: AssetPass; now: number }) {
  return (
    <div className="stack" data-testid="assets-progress">
      <div className="row">
        <Badge tone={PASS_TONE[pass.status]}>{PASS_STATUS[pass.status] ?? pass.status}</Badge>
        <span className="muted small-text">Started {fmtAgo(pass.startedAt, now)}</span>
      </div>
      {pass.status === 'walking' && (
        <>
          <p>
            Listed {fmtInt(pass.foldersDone)} of {fmtInt(pass.foldersFound)} folders found so far
            {pass.foldersFailed > 0 ? ` (${fmtInt(pass.foldersFailed)} could not be listed)` : ''} ·{' '}
            {fmtInt(pass.listed)} items on {fmtInt(pass.pages)} pages · {fmtInt(pass.requests)} requests.
          </p>
          <progress
            max={Math.max(pass.foldersFound, 1)}
            value={pass.foldersDone + pass.foldersFailed}
            aria-label="Build progress"
          />
        </>
      )}
    </div>
  );
}

function PassRow({ label, pass, now }: { label: string; pass: AssetPass | null; now: number }) {
  if (!pass) {
    return (
      <tr>
        <th scope="row">{label}</th>
        <td colSpan={4} className="muted">
          Not run yet
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>
        <Badge tone={PASS_TONE[pass.status]}>{PASS_STATUS[pass.status] ?? pass.status}</Badge>
      </td>
      <td title={fmtTime(pass.finishedAt ?? pass.startedAt)}>
        {fmtAgo(pass.finishedAt ?? pass.startedAt, now)}
      </td>
      <td>{pass.summary ?? pass.error ?? '–'}</td>
      <td>{pass.jobId ? <Link to={`/jobs/${pass.jobId}`}>Job</Link> : <span className="muted">–</span>}</td>
    </tr>
  );
}

function PassesCard({ data, now }: { data: AssetOverview; now: number }) {
  return (
    <section className="card table-wrap" aria-labelledby="assets-passes-h" data-testid="assets-passes">
      <h2 id="assets-passes-h">Build, refresh and check</h2>
      <p className="muted small-text">
        The refresh (every 6 hours) and the check (nightly) are maintenance jobs: schedule or run them on the{' '}
        <Link to="/maintenance">Maintenance Jobs</Link> page. The regular refresh can be switched off for this
        project on the <Link to="/projects">Projects</Link> page
        {data.settings.refreshEnabled ? '' : ' (it is off now; the nightly check still runs)'}.
      </p>
      <table>
        <thead>
          <tr>
            <th>Pass</th>
            <th>Outcome</th>
            <th>When</th>
            <th>Result</th>
            <th>
              <span className="offscreen">Job</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <PassRow label="Last build" pass={data.lastBuild} now={now} />
          <PassRow label="Last refresh" pass={data.lastRefresh} now={now} />
          <PassRow label="Last check" pass={data.lastCheck} now={now} />
        </tbody>
      </table>
    </section>
  );
}

function StaleCard({ data }: { data: AssetOverview }) {
  const rows = [
    ...data.stale.folders.map((f) => ({
      id: f.id,
      kind: 'folder',
      name: f.path.names.join(' / '),
      why: f.staleReason,
    })),
    ...data.stale.assets.map((a) => ({
      id: a.id,
      kind: a.type.toLowerCase(),
      name: a.name,
      why: a.staleReason,
    })),
  ];
  return (
    <section className="card table-wrap" aria-label="Stale rows" data-testid="assets-stale">
      <h2>Not confirmed</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Id</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.kind}</td>
              <td className="mono small-text">{r.id}</td>
              <td className="small-text">{r.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function RereadsCard({ data, now }: { data: AssetOverview; now: number }) {
  return (
    <section className="card table-wrap" aria-label="Failed re-reads" data-testid="assets-rereads">
      <h2>Re-reads that failed</h2>
      <p className="muted small-text">
        After an asset write, the bridge re-reads what it changed. These could not be read; they are retried,
        and the next refresh settles them.
      </p>
      <table>
        <thead>
          <tr>
            <th>After</th>
            <th>Assets</th>
            <th>Error</th>
            <th>Next try</th>
          </tr>
        </thead>
        <tbody>
          {data.rereads.failed.map((r) => (
            <tr key={r.id}>
              <td>
                {r.op}
                {r.jobId && (
                  <>
                    {' '}
                    (<Link to={`/jobs/${r.jobId}`}>job</Link>)
                  </>
                )}
              </td>
              <td className="mono small-text">{r.assetIds.join(', ') || '(its folder)'}</td>
              <td className="small-text">{r.lastError}</td>
              <td>{r.nextAt ? fmtAgo(r.nextAt, now).replace(' ago', '') : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const show = (v: unknown): string =>
  v === null || v === undefined ? '–' : typeof v === 'string' ? v : JSON.stringify(v);

/** The correction log: what refreshes and checks corrected, and re-reads that failed. Newest first. */
function CorrectionLog() {
  const [before, setBefore] = useState<number | null>(null);
  const log = useScopedApi<{ entries: AssetCorrection[]; next: number | null }>(
    `/asset-tree/corrections?limit=50${before !== null ? `&before=${before}` : ''}`,
  );
  const now = useNow();
  const entries = log.data?.entries ?? [];
  return (
    <section className="card table-wrap" aria-labelledby="assets-log-h" data-testid="assets-log">
      <div className="row row-between">
        <h2 id="assets-log-h">Correction log</h2>
        <div className="row">
          {before !== null && (
            <button type="button" className="small" onClick={() => setBefore(null)}>
              Newest
            </button>
          )}
          {log.data?.next != null && (
            <button type="button" className="small" onClick={() => setBefore(log.data!.next)}>
              Older
            </button>
          )}
        </div>
      </div>
      <ErrorNote error={log.error} onRetry={log.reload} />
      {entries.length === 0 ? (
        <Empty>Nothing has needed correcting.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Found by</th>
              <th>Item</th>
              <th>Change</th>
              <th>Old</th>
              <th>New</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td title={fmtTime(e.at)}>{fmtAgo(e.at, now)}</td>
                <td>{e.source === 'write' ? 'after a write' : e.source}</td>
                <td>
                  {e.itemName ?? <span className="mono">{e.itemId}</span>}
                  <div className="mono small-text">
                    {e.itemKind} {e.itemId}
                  </div>
                </td>
                <td>
                  {e.change === 'updated' ? e.field : e.change.replace('_', ' ')}
                  {e.detail && <div className="muted small-text">{e.detail}</div>}
                </td>
                <td className="small-text">{e.change === 'updated' ? show(e.oldValue) : ''}</td>
                <td className="small-text">{e.change === 'updated' ? show(e.newValue) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** A simple browser: one folder at a time, from the library’s root, with its subfolders and assets. */
function FolderBrowser() {
  const [at, setAt] = useState<string | null>(null);
  const [limit, setLimit] = useState(50);
  const level = useScopedApi<AssetChildren>(
    `/asset-tree/children?limit=${limit}${at ? `&id=${encodeURIComponent(at)}` : ''}`,
  );
  const d = level.data;
  return (
    <section className="card" aria-labelledby="assets-browse-h" data-testid="assets-browser">
      <h2 id="assets-browse-h">Browse</h2>
      <ErrorNote error={level.error} onRetry={level.reload} />
      {!d ? (
        <Loading />
      ) : (
        <>
          <nav aria-label="Path" className="row small-text">
            {at === null ? (
              <strong>Library root</strong>
            ) : (
              <button type="button" className="link" onClick={() => setAt(null)}>
                Library root
              </button>
            )}
            {d.path.map((p, i) => (
              <span key={p.id}>
                {' / '}
                {i === d.path.length - 1 ? (
                  <strong>{p.name}</strong>
                ) : (
                  <button type="button" className="link" onClick={() => setAt(p.id)}>
                    {p.name}
                  </button>
                )}
              </span>
            ))}
          </nav>
          {d.folder && (
            <p className="muted small-text">
              Folder <span className="mono">{d.folder.id}</span> · read{' '}
              {fmtAgo(d.folder.lastReadAt, Date.now())} ({d.folder.lastReadBy})
              {d.folder.stale ? ` · stale: ${d.folder.staleReason}` : ''}
            </p>
          )}
          {d.folders.length === 0 && d.assets.total === 0 ? (
            <Empty>This folder is empty.</Empty>
          ) : (
            <>
              <ul className="plain" aria-label="Folders">
                {d.folders.map((f) => (
                  <li key={f.id} className="row">
                    <Badge tone="neutral">folder</Badge>
                    <button type="button" className="link" onClick={() => setAt(f.id)}>
                      {f.name}
                    </button>
                    {f.stale && <Badge tone="warn">stale</Badge>}
                    {f.isHidden && <Badge tone="neutral">hidden</Badge>}
                  </li>
                ))}
              </ul>
              {d.assets.total > 0 && (
                <>
                  <table aria-label="Assets">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Type</th>
                        <th>Size</th>
                        <th>Id</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.assets.assets.map((a) => (
                        <tr key={a.id}>
                          <td>
                            {a.name} {a.isHidden && <Badge tone="neutral">hidden</Badge>}{' '}
                            {a.stale && <Badge tone="warn">stale</Badge>}
                          </td>
                          <td>{a.type.toLowerCase()}</td>
                          <td className="small-text">
                            {a.width && a.height ? `${a.width} × ${a.height}` : '–'}
                            {a.size ? ` · ${fmtBytes(a.size)}` : ''}
                          </td>
                          <td className="mono small-text">{a.id}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {d.assets.total > d.assets.assets.length && (
                    <p className="small-text">
                      Showing {fmtInt(d.assets.assets.length)} of {fmtInt(d.assets.total)} assets.{' '}
                      <button type="button" className="link" onClick={() => setLimit((n) => n + 200)}>
                        Show more
                      </button>
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * "Try it": where would an image for this character, or this literal folder path, go? A read-only plan from the stored
 * trees: nothing is written and nothing is requested from LegendKeeper.
 */
function TryIt() {
  const projectApi = useProjectApi();
  const { run, busy } = useAction();
  const [mode, setMode] = useState<'name' | 'id' | 'path'>('name');
  const [name, setName] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [subfolders, setSubfolders] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [result, setResult] = useState<AssetPlanResponse | null>(null);

  const submit = () => {
    const body =
      mode === 'path'
        ? { folderPath: lines(folderPath) }
        : {
            ...(mode === 'name' ? { characterName: name } : { characterResourceId: resourceId.trim() }),
            ...(subfolders.trim() ? { subfolders: lines(subfolders) } : {}),
          };
    void run(() => projectApi.post<{ result: AssetPlanResponse }>('/asset-tree/plan', body)).then((r) => {
      if (r) setResult(r.result);
    });
  };

  return (
    <section className="card" aria-labelledby="assets-try-h" data-testid="assets-try">
      <h2 id="assets-try-h">Try it</h2>
      <p className="muted small-text">
        Where would an image go? This only reads the bridge’s copies: nothing is written, nothing is asked of
        LegendKeeper, and no folder is ever moved. Subfolders and folder paths are one folder name per line.
      </p>
      <div className="stack">
        <fieldset className="row">
          <legend className="offscreen">What to place</legend>
          {(
            [
              ['name', 'A character, by name'],
              ['id', 'A character, by page id'],
              ['path', 'A folder path'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="row">
              <input
                type="radio"
                name="assets-try-mode"
                checked={mode === value}
                onChange={() => setMode(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        {mode === 'name' && (
          <label>
            Character name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mehrana al-Khalid" />
          </label>
        )}
        {mode === 'id' && (
          <label>
            Character page id
            <input
              className="mono"
              value={resourceId}
              onChange={(e) => setResourceId(e.target.value)}
              placeholder="the page’s resource id"
            />
          </label>
        )}
        {mode !== 'path' && (
          <label>
            Subfolders (optional, one name per line)
            <textarea rows={2} value={subfolders} onChange={(e) => setSubfolders(e.target.value)} />
          </label>
        )}
        {mode === 'path' && (
          <label>
            Folder path (top folder first, one name per line)
            <textarea rows={3} value={folderPath} onChange={(e) => setFolderPath(e.target.value)} />
          </label>
        )}
        <div className="row">
          <Button
            busy={busy}
            disabled={
              (mode === 'name' && name.trim() === '') ||
              (mode === 'id' && resourceId.trim() === '') ||
              (mode === 'path' && lines(folderPath).length === 0)
            }
            onClick={submit}
          >
            Show the plan
          </Button>
        </div>
      </div>
      {result && <PlanResult result={result} />}
    </section>
  );
}

function PlanResult({ result }: { result: AssetPlanResponse }) {
  if (!result.ok) {
    return (
      <div className="note note-warn" role="alert" data-testid="assets-plan-error">
        <p>
          <strong>{result.error.code}</strong>: {result.error.message}
        </p>
        {result.error.details && (
          <pre className="small-text">{JSON.stringify(result.error.details, null, 2)}</pre>
        )}
      </div>
    );
  }
  const p = result.plan;
  const summary: ReactNode =
    p.mode === 'existing_character_folder'
      ? 'An existing folder named after the character is used, wherever it is.'
      : p.mode === 'character_path'
        ? p.character?.raceSource === 'unknown_race'
          ? `The race is unknown, so the folder “${p.character.race ?? ''}” is used.`
          : `From the character’s page: ${[p.character?.group, p.character?.race].filter(Boolean).join(' / ')}.`
        : 'The folder path you gave.';
  return (
    <div className="stack" data-testid="assets-plan">
      <p>
        <strong>{p.destination.path.join(' / ')}</strong>{' '}
        <Badge tone={p.destination.exists ? 'ok' : 'info'}>
          {p.destination.exists ? 'exists' : 'would be created'}
        </Badge>
      </p>
      <p className="muted small-text">{summary}</p>
      <ol className="plain" aria-label="Folders in order">
        {p.steps.map((s, i) => (
          <li key={`${i}-${s.name}`} className="row">
            <Badge tone={s.action === 'reuse' ? 'ok' : 'info'}>
              {s.action === 'reuse' ? 'reuse' : 'create'}
            </Badge>
            <span>{s.name}</span>
            {s.folderId && <span className="mono small-text">{s.folderId}</span>}
          </li>
        ))}
      </ol>
      {p.notes.length > 0 && (
        <ul className="small-text">
          {p.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

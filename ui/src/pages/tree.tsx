import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, useAction, useConfirm } from '../components';
import { fmtAgo, fmtDuration, fmtInt, fmtTime } from '../format';
import { useNow } from '../hooks';
import { useProject, useProjectApi, useScopedApi } from '../project';
import { Link } from '../router';
import type { TreeCorrection, TreeNodeView, TreeOverview, TreePass, TreeStatusName } from '../types';

/**
 * Repository Tree (v2 A2, docs/tree.md): the bridge's own model of the selected project's AI REPOSITORY. Its status,
 * counts by kind and depth, unclassified and stale pages, the running build's progress, the last build, sweep and
 * check, the correction log, and a browsable tree. Starting a build lists the project first and shows the estimate;
 * nothing is read page by page until you confirm.
 */

const STATUS: Record<TreeStatusName, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' }> = {
  not_configured: { label: 'Not configured', tone: 'neutral' },
  not_built: { label: 'Not built', tone: 'warn' },
  building: { label: 'Building', tone: 'info' },
  ready: { label: 'Ready', tone: 'ok' },
  stale: { label: 'Stale', tone: 'warn' },
};

const KIND_LABEL: Record<string, string> = {
  root: 'root',
  index: 'INDEX',
  bsrc: 'BSRC',
  unclassified: 'unclassified',
};

const PASS_TONE = {
  succeeded: 'ok',
  failed: 'bad',
  cancelled: 'neutral',
  interrupted: 'warn',
  listing: 'info',
  reading: 'info',
  awaiting_confirmation: 'warn',
} as const;

const PASS_STATUS: Record<string, string> = {
  listing: 'Listing',
  awaiting_confirmation: 'Waiting for you',
  reading: 'Reading pages',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export function TreePage() {
  const { selected } = useProject();
  const overview = useScopedApi<TreeOverview>('/tree');
  const data = overview.data;
  const busyNow = data ? data.activePass !== null || data.suggesting : false;
  // A running pass is followed closely; otherwise the page refreshes now and then.
  useEffect(() => {
    const t = setInterval(overview.reload, busyNow ? 2000 : 30_000);
    return () => clearInterval(t);
  }, [overview.reload, busyNow]);
  const now = useNow();

  if (overview.error && !data) return <ErrorNote error={overview.error} onRetry={overview.reload} />;
  if (!data) return <Loading />;
  const status = STATUS[data.tree.status];

  return (
    <>
      <PageHeader title="Repository Tree" project={selected}>
        <button type="button" className="small" onClick={overview.reload}>
          Refresh
        </button>
      </PageHeader>
      <p className="muted">
        The bridge’s own copy of this project’s AI REPOSITORY: every page under it, with its kind, place,
        tags, aliases, documents and catalogue fields. It is updated after each of the bridge’s own writes, by
        an hourly sweep and by a nightly consistency check. Pages outside the AI REPOSITORY are not kept.
      </p>
      <ErrorNote error={overview.error} onRetry={overview.reload} />

      <section className="card" aria-labelledby="tree-status-h" data-testid="tree-status">
        <h2 id="tree-status-h">Status</h2>
        <div className="row">
          <Badge tone={status.tone}>{status.label}</Badge>
          {data.tree.reason && <span>{data.tree.reason}</span>}
        </div>
        <p className="muted small-text">
          {data.tree.rootId ? (
            <>
              Root <span className="mono">{data.tree.rootId}</span> ·{' '}
            </>
          ) : null}
          Last confirmed{' '}
          {data.tree.confirmedAt
            ? `${fmtAgo(data.tree.confirmedAt, now)} by a ${data.tree.confirmedBy}`
            : 'never'}
          {data.tree.pendingRereads > 0 ? ` · ${data.tree.pendingRereads} re-read(s) owed` : ''}
        </p>
        {data.tree.status !== 'not_configured' && <Counts data={data} />}
      </section>

      {data.tree.status === 'not_configured' && <RootSetup data={data} onChanged={overview.reload} />}
      {data.tree.status !== 'not_configured' && (
        <BuildCard data={data} now={now} onChanged={overview.reload} />
      )}
      {data.tree.status !== 'not_configured' && (
        <>
          <PassesCard data={data} now={now} />
          <NodeList
            title="Unclassified pages"
            nodes={data.unclassified}
            empty="Every page under the root is an [INDEX] or a [BSRC] page."
            testId="tree-unclassified"
          />
          {data.staleNodes.length > 0 && (
            <NodeList title="Stale pages" nodes={data.staleNodes} empty="" testId="tree-stale" showReason />
          )}
          {data.rereads.failed.length > 0 && <RereadsCard data={data} now={now} />}
          <CorrectionLog />
          {data.counts.total > 0 && <TreeBrowser rootId={data.tree.rootId} />}
        </>
      )}
    </>
  );
}

function Counts({ data }: { data: TreeOverview }) {
  const c = data.counts;
  const stats: [string, number][] = [
    ['Pages', c.total],
    ['[INDEX]', c.byKind.index],
    ['[BSRC]', c.byKind.bsrc],
    ['Unclassified', c.byKind.unclassified],
    ['Deepest level', c.maxDepth],
    ['Stale', c.stale],
  ];
  return (
    <div className="grid" data-testid="tree-counts">
      {stats.map(([label, n]) => (
        <div className="stat" key={label}>
          <span className="stat-value">{fmtInt(n)}</span>
          <span className="stat-label">{label}</span>
        </div>
      ))}
    </div>
  );
}

/** No root yet: the suggestion (found by itself the first time the page is opened), and how to set the root. */
function RootSetup({ data, onChanged }: { data: TreeOverview; onChanged: () => void }) {
  const { selected } = useProject();
  const projectApi = useProjectApi();
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const s = data.suggestion;
  const use = (id: string, name: string) => {
    void confirm({
      title: `Use “${name}” as the AI REPOSITORY root?`,
      message: (
        <>
          <p>
            The repository tree of <strong>{selected}</strong> will cover everything under{' '}
            <span className="mono">{id}</span>. Nothing is read until you start the first build.
          </p>
          <p className="muted small-text">The change is audited.</p>
        </>
      ),
      confirmLabel: 'Use this root',
    }).then((ok) => {
      if (ok && selected)
        void run(
          () =>
            api.put(`/projects/${encodeURIComponent(selected)}/settings`, {
              key: 'aiRepositoryRootId',
              value: id,
            }),
          'The AI REPOSITORY root is set.',
        ).then(onChanged);
    });
  };
  return (
    <section className="card" aria-labelledby="tree-root-h" data-testid="tree-root">
      <h2 id="tree-root-h">AI REPOSITORY root</h2>
      <p>
        No root is set for this project, so the tree does nothing. The root is the resource id of the
        project’s AI REPOSITORY page; you can also set it on the <Link to="/projects">Projects</Link> page.
      </p>
      {data.suggesting && <p className="muted">Looking for a top-level page named “AI REPOSITORY”…</p>}
      {!data.suggesting && s && (
        <div className="stack">
          {s.error && <p className="note note-warn">The search could not finish: {s.error}</p>}
          {s.suggested && (
            <div className="row">
              <span>
                Found exactly one: <strong>{s.candidates[0]?.name}</strong>{' '}
                <span className="mono">{s.suggested}</span>
              </span>
              <Button busy={busy} onClick={() => use(s.suggested!, s.candidates[0]?.name ?? s.suggested!)}>
                Use this root…
              </Button>
            </div>
          )}
          {!s.suggested && s.candidates.length > 1 && (
            <>
              <p>
                {s.candidates.length} top-level pages are named “AI REPOSITORY”; choose the right one
                yourself:
              </p>
              <ul className="plain">
                {s.candidates.map((c) => (
                  <li key={c.id} className="row">
                    <span className="mono">{c.id}</span>
                    <Button className="small" busy={busy} onClick={() => use(c.id, c.name)}>
                      Use…
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {!s.error && s.candidates.length === 0 && (
            <p className="muted">
              No top-level page is named “AI REPOSITORY” (of {fmtInt(s.listed)} pages listed). Set the root on
              the Projects page.
            </p>
          )}
          <p className="muted small-text">Looked {fmtTime(s.at)}.</p>
        </div>
      )}
      <Button
        className="small"
        busy={busy || data.suggesting}
        onClick={() => void run(() => projectApi.post('/tree/suggest-root')).then(onChanged)}
      >
        Look again
      </Button>
    </section>
  );
}

function BuildCard({ data, now, onChanged }: { data: TreeOverview; now: number; onChanged: () => void }) {
  const projectApi = useProjectApi();
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const pass = data.activePass?.kind === 'build' ? data.activePass : null;
  const start = (rebuild: boolean) => {
    void confirm({
      title: rebuild ? 'Rebuild the tree?' : 'Start the first build?',
      message: (
        <>
          <p>
            The bridge first lists every resource of the project (about one request per 100 resources) and
            then shows you the estimate. Nothing is read page by page until you confirm it.
          </p>
          <p className="muted small-text">All of it runs at the lowest priority (P3), behind agents’ work.</p>
        </>
      ),
      confirmLabel: 'List the project',
    }).then((ok) => {
      if (ok) void run(() => projectApi.post('/tree/build')).then(onChanged);
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
        void run(() => projectApi.post('/tree/build/cancel', { confirm: true }), 'Build cancelled.').then(
          onChanged,
        );
    });
  };
  return (
    <section className="card" aria-labelledby="tree-build-h" data-testid="tree-build">
      <h2 id="tree-build-h">Build</h2>
      {!pass && data.activePass && (
        <p className="muted">
          A {data.activePass.kind} is running ({PASS_STATUS[data.activePass.status]}).
        </p>
      )}
      {!pass && !data.activePass && (
        <div className="row">
          {data.tree.status === 'not_built' ? (
            <Button busy={busy} onClick={() => start(false)}>
              Start the first build…
            </Button>
          ) : (
            <Button className="small" busy={busy} onClick={() => start(true)}>
              Rebuild…
            </Button>
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
        <div className="stack" data-testid="tree-estimate">
          <p>
            <strong>{fmtInt(pass.estimate.subtree)}</strong> pages are under the root (of{' '}
            {fmtInt(pass.estimate.listed)} listed with {fmtInt(pass.estimate.listingRequests)} requests).
            Reading each one costs <strong>{fmtInt(pass.estimate.reads)}</strong> requests at P3: about{' '}
            <strong>{fmtDuration(pass.estimate.wallClockMs)}</strong> at the current budget
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
                  () => projectApi.post('/tree/build/confirm', { confirm: true }),
                  'Build started.',
                ).then(onChanged)
              }
            >
              Start reading
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

function BuildProgress({ pass, now }: { pass: TreePass; now: number }) {
  const done = pass.readOk + pass.readFailed;
  return (
    <div className="stack" data-testid="tree-progress">
      <div className="row">
        <Badge tone={PASS_TONE[pass.status]}>{PASS_STATUS[pass.status] ?? pass.status}</Badge>
        <span className="muted small-text">Started {fmtAgo(pass.startedAt, now)}</span>
      </div>
      {pass.status === 'listing' && (
        <p>
          Listing the project: {fmtInt(pass.listed)} resources on {fmtInt(pass.pages)} pages so far.
        </p>
      )}
      {pass.status === 'reading' && (
        <>
          <p>
            Read {fmtInt(done)} of {fmtInt(pass.toRead)} pages
            {pass.readFailed > 0 ? ` (${fmtInt(pass.readFailed)} could not be read)` : ''} ·{' '}
            {fmtInt(pass.requests)} requests.
          </p>
          <progress max={pass.toRead ?? 1} value={done} aria-label="Build progress" />
        </>
      )}
    </div>
  );
}

function PassRow({ label, pass, now }: { label: string; pass: TreePass | null; now: number }) {
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

function PassesCard({ data, now }: { data: TreeOverview; now: number }) {
  return (
    <section className="card table-wrap" aria-labelledby="tree-passes-h" data-testid="tree-passes">
      <h2 id="tree-passes-h">Build, sweep and check</h2>
      <p className="muted small-text">
        The sweep (hourly) and the check (nightly) are maintenance jobs: schedule or run them on the{' '}
        <Link to="/maintenance">Maintenance Jobs</Link> page. The hourly sweep can be switched off for this
        project on the <Link to="/projects">Projects</Link> page
        {data.settings.sweepEnabled ? '' : ' (it is off now)'}.
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
          <PassRow label="Last sweep" pass={data.lastSweep} now={now} />
          <PassRow label="Last check" pass={data.lastCheck} now={now} />
        </tbody>
      </table>
    </section>
  );
}

function NodeList({
  title,
  nodes,
  empty,
  testId,
  showReason,
}: {
  title: string;
  nodes: TreeNodeView[];
  empty: string;
  testId: string;
  showReason?: boolean;
}) {
  return (
    <section className="card table-wrap" aria-label={title} data-testid={testId}>
      <h2>{title}</h2>
      {nodes.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Page</th>
              <th>Where</th>
              <th>Id</th>
              {showReason && <th>Why</th>}
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.id}>
                <td>{n.rawName}</td>
                <td className="small-text">{n.path.names.slice(0, -1).join(' / ')}</td>
                <td className="mono small-text">{n.id}</td>
                {showReason && <td className="small-text">{n.staleReason}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RereadsCard({ data, now }: { data: TreeOverview; now: number }) {
  return (
    <section className="card table-wrap" aria-label="Failed re-reads" data-testid="tree-rereads">
      <h2>Re-reads that failed</h2>
      <p className="muted small-text">
        After a write, the bridge re-reads what it changed. These could not be read; they are retried, and the
        next sweep settles them.
      </p>
      <table>
        <thead>
          <tr>
            <th>After</th>
            <th>Pages</th>
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
              <td className="mono small-text">{r.resourceIds.join(', ')}</td>
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

/** The correction log: what sweeps and checks corrected, and re-reads that failed. Newest first. */
function CorrectionLog() {
  const [before, setBefore] = useState<number | null>(null);
  const log = useScopedApi<{ entries: TreeCorrection[]; next: number | null }>(
    `/tree/corrections?limit=50${before !== null ? `&before=${before}` : ''}`,
  );
  const now = useNow();
  const entries = log.data?.entries ?? [];
  return (
    <section className="card table-wrap" aria-labelledby="tree-log-h" data-testid="tree-log">
      <div className="row row-between">
        <h2 id="tree-log-h">Correction log</h2>
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
              <th>Page</th>
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
                  {e.nodeName ?? <span className="mono">{e.nodeId}</span>}
                  {e.nodeName && <div className="mono small-text">{e.nodeId}</div>}
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

interface ChildrenResponse {
  node: TreeNodeView | null;
  path: { id: string; rawName: string; displayName: string; kind: string }[];
  children: TreeNodeView[];
}

/** A simple browser: one level at a time, from the root, with the selected page's details. */
function TreeBrowser({ rootId }: { rootId: string | null }) {
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => setAt(null), [rootId]);
  const level = useScopedApi<ChildrenResponse>(`/tree/children${at ? `?id=${encodeURIComponent(at)}` : ''}`);
  const now = useNow();
  const d = level.data;
  return (
    <section className="card" aria-labelledby="tree-browse-h" data-testid="tree-browser">
      <h2 id="tree-browse-h">Browse</h2>
      <ErrorNote error={level.error} onRetry={level.reload} />
      {!d ? (
        <Loading />
      ) : (
        <>
          <nav aria-label="Path" className="row small-text">
            {d.path.map((p, i) => (
              <span key={p.id}>
                {i > 0 && ' / '}
                {i === d.path.length - 1 ? (
                  <strong>{p.displayName}</strong>
                ) : (
                  <button type="button" className="link" onClick={() => setAt(p.id)}>
                    {p.displayName}
                  </button>
                )}
              </span>
            ))}
          </nav>
          {d.node && <NodeDetails node={d.node} now={now} />}
          {d.children.length === 0 ? (
            <Empty>No pages under this one.</Empty>
          ) : (
            <ul className="plain" aria-label="Pages under it">
              {d.children.map((c) => (
                <li key={c.id} className="row">
                  <Badge tone={c.kind === 'unclassified' ? 'warn' : 'neutral'}>{KIND_LABEL[c.kind]}</Badge>
                  <button type="button" className="link" onClick={() => setAt(c.id)}>
                    {c.displayName}
                  </button>
                  {c.referenceType && <span className="muted small-text">{c.referenceType}</span>}
                  {c.stale && <Badge tone="warn">stale</Badge>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function NodeDetails({ node: n, now }: { node: TreeNodeView; now: number }) {
  const rows: [string, ReactNode][] = [
    ['Id', <span className="mono">{n.id}</span>],
    ['Name', n.rawName],
    ['Kind', KIND_LABEL[n.kind]],
    ['Reference Type', n.referenceType ?? '–'],
    ['Scope', n.scope ?? '–'],
    ['Index Scope', n.indexScope ?? '–'],
    ['Canonical Display Name', n.canonicalDisplayName ?? '–'],
    ['Tags', n.tags.length ? n.tags.join(', ') : '–'],
    ['Aliases', n.aliases.length ? n.aliases.join(', ') : '–'],
    [
      'Documents',
      n.documents.length ? n.documents.map((d) => `${d.name ?? d.id} (${d.type ?? '?'})`).join(', ') : '–',
    ],
    ['Flags', [n.isHidden ? 'hidden' : null, n.isLocked ? 'locked' : null].filter(Boolean).join(', ') || '–'],
    ['Last read', `${fmtAgo(n.lastReadAt, now)} (${n.lastReadBy})`],
  ];
  return (
    <dl className="settings-list" data-testid="tree-node">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
      {n.stale && (
        <div>
          <dt>Stale</dt>
          <dd>{n.staleReason}</dd>
        </div>
      )}
    </dl>
  );
}

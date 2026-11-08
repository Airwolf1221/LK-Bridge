import { useState } from 'react';
import { api, qs } from '../api';
import {
  Badge,
  Button,
  CopyButton,
  Empty,
  ErrorNote,
  Json,
  Loading,
  PageHeader,
  useAction,
  useConfirm,
} from '../components';
import { fmtAgo, fmtInt, fmtTime } from '../format';
import { useApi, useNow, useReloadOn } from '../hooks';
import { Link, useRoute } from '../router';
import type { ErrorGroup, ErrorRecord } from '../types';

const CLASS_TONE: Record<string, 'bad' | 'warn' | 'neutral' | 'info'> = {
  user_fixable: 'warn',
  conflict: 'warn',
  auth: 'bad',
  budget: 'info',
  upstream: 'bad',
  bridge: 'bad',
  policy: 'neutral',
};

export function ErrorsPage() {
  const { query, navigate } = useRoute();
  const fp = query.get('fp');
  return fp ? (
    <ErrorDetail fingerprint={fp} back={() => navigate('/errors')} />
  ) : (
    <ErrorList open={(f) => navigate(`/errors${qs({ fp: f })}`)} />
  );
}

function ErrorList({ open }: { open: (fingerprint: string) => void }) {
  const [show, setShow] = useState<'false' | 'true' | 'all'>('false');
  const list = useApi<{ groups: ErrorGroup[] }>(`/errors${qs({ resolved: show })}`);
  useReloadOn(['error'], list.reload, 500);
  const now = useNow();
  return (
    <>
      <PageHeader title="Errors" />
      <div className="tabs" role="group" aria-label="Which errors">
        {(
          [
            ['false', 'Open'],
            ['true', 'Resolved'],
            ['all', 'All'],
          ] as const
        ).map(([v, label]) => (
          <button key={v} type="button" aria-pressed={show === v} onClick={() => setShow(v)}>
            {label}
          </button>
        ))}
      </div>
      <ErrorNote error={list.error} onRetry={list.reload} />
      {!list.data ? (
        <Loading />
      ) : list.data.groups.length === 0 ? (
        <Empty>{show === 'false' ? 'No open errors. Good.' : 'Nothing to show.'}</Empty>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Operation</th>
                <th>Code</th>
                <th>Kind</th>
                <th className="num">Count</th>
                <th>First seen</th>
                <th>Last seen</th>
                <th>Latest message</th>
              </tr>
            </thead>
            <tbody>
              {list.data.groups.map((g) => (
                <tr key={g.fingerprint}>
                  <td>
                    <a
                      href={`/ui/errors${qs({ fp: g.fingerprint })}`}
                      onClick={(e) => {
                        e.preventDefault();
                        open(g.fingerprint);
                      }}
                    >
                      <span className="mono">{g.opId}</span>
                    </a>
                    {g.path && <div className="muted small-text mono">{g.path}</div>}
                  </td>
                  <td className="mono">{g.code ?? '–'}</td>
                  <td>
                    <Badge tone={CLASS_TONE[g.classification] ?? 'neutral'}>
                      {g.classification.replace('_', ' ')}
                    </Badge>
                  </td>
                  <td className="num">{fmtInt(g.count)}</td>
                  <td>{fmtTime(g.firstSeen)}</td>
                  <td>
                    {fmtTime(g.lastSeen)}
                    <div className="muted small-text">{fmtAgo(g.lastSeen, now)}</div>
                  </td>
                  <td>
                    {g.resolved && <Badge tone="ok">resolved</Badge>} {g.lastMessage}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ErrorDetail({ fingerprint, back }: { fingerprint: string; back: () => void }) {
  const d = useApi<{ group: ErrorGroup; occurrences: ErrorRecord[] }>(`/errors/group${qs({ fingerprint })}`);
  useReloadOn(['error'], d.reload, 500);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const now = useNow();
  const g = d.data?.group;
  return (
    <>
      <PageHeader title="Error group">
        <button type="button" className="small" onClick={back}>
          ← All errors
        </button>
      </PageHeader>
      <ErrorNote error={d.error} onRetry={d.reload} />
      {!g || !d.data ? (
        !d.error && <Loading />
      ) : (
        <>
          <section className="card">
            <div className="row row-between">
              <div>
                <h2>
                  <span className="mono">{g.opId}</span> {g.code && <Badge tone="bad">{g.code}</Badge>}{' '}
                  {g.resolved && <Badge tone="ok">resolved</Badge>}
                </h2>
                <p className="muted small-text">
                  {fmtInt(g.count)} occurrence{g.count === 1 ? '' : 's'} · first {fmtTime(g.firstSeen)} · last{' '}
                  {fmtTime(g.lastSeen)} ({fmtAgo(g.lastSeen, now)})
                </p>
              </div>
              {!g.resolved && (
                <Button
                  variant="primary"
                  busy={busy}
                  onClick={() => {
                    void confirm({
                      title: 'Mark this group resolved?',
                      message: (
                        <p>
                          Every current occurrence is marked resolved. A new occurrence reopens the group.
                        </p>
                      ),
                      confirmLabel: 'Mark resolved',
                    }).then((ok) => {
                      if (ok)
                        void run(() => api.post('/errors/resolve', { fingerprint }), 'Marked resolved.').then(
                          d.reload,
                        );
                    });
                  }}
                >
                  Mark resolved
                </Button>
              )}
            </div>
          </section>

          <section className="card">
            <h2>Occurrences</h2>
            <p className="muted small-text">The newest {d.data.occurrences.length}.</p>
            {d.data.occurrences.map((e) => (
              <article key={e.id} className="card" aria-label={`Occurrence at ${fmtTime(e.at)}`}>
                <div className="row row-between">
                  <strong>{fmtTime(e.at)}</strong>
                  <span className="row">
                    {e.status !== null && <Badge>HTTP {e.status}</Badge>}
                    <Badge tone={CLASS_TONE[e.classification] ?? 'neutral'}>
                      {e.classification.replace('_', ' ')}
                    </Badge>
                    {e.retryable && <Badge tone="info">retryable</Badge>}
                    {e.resolvedAt && <Badge tone="ok">resolved</Badge>}
                  </span>
                </div>
                <p>{e.message}</p>
                <dl className="meta">
                  <div>
                    <dt>LegendKeeper request id</dt>
                    <dd>
                      {e.requestId ? (
                        <span className="row">
                          <span className="mono">{e.requestId}</span>
                          <CopyButton text={e.requestId} what="request id" />
                        </span>
                      ) : (
                        <span className="muted">none (refused before it was sent)</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Job and step</dt>
                    <dd>
                      {e.jobId ? (
                        <Link to={`/jobs/${encodeURIComponent(e.jobId)}`}>
                          Job {e.jobId.slice(0, 10)}…{e.stepNo !== null ? `, step ${e.stepNo}` : ''}
                        </Link>
                      ) : (
                        <span className="muted">no job (an inline read)</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Principal</dt>
                    <dd>
                      {e.profile} <span className="mono muted">{e.principalId}</span>
                    </dd>
                  </div>
                </dl>
                {e.issues.length > 0 && (
                  <ul>
                    {e.issues.map((i, n) => (
                      <li key={n}>
                        <span className="mono">{i.path}</span>: {i.message}
                      </li>
                    ))}
                  </ul>
                )}
                <details>
                  <summary>Full LegendKeeper error body</summary>
                  <Json value={e.detail} />
                </details>
              </article>
            ))}
          </section>
        </>
      )}
    </>
  );
}

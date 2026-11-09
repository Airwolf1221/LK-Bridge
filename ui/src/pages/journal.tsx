import { useMemo, useState } from 'react';
import { qs } from '../api';
import { Badge, CopyButton, Empty, ErrorNote, Json, Loading, PageHeader } from '../components';
import { fmtBytes, fmtTime } from '../format';
import { useApi } from '../hooks';
import { useProject, useScopedApi } from '../project';
import { Link } from '../router';
import type { ClientsResponse, JournalEntry } from '../types';

const SINCE: [string, string][] = [
  ['', 'Any time'],
  ['60', 'Last hour'],
  ['1440', 'Last 24 hours'],
  ['10080', 'Last 7 days'],
  ['43200', 'Last 30 days'],
];

/**
 * The write journal: every write the bridge has sent, newest first, and for destructive writes what they replaced.
 * View only: nothing here changes anything. Pages of 100, older pages through the `before` cursor (chunk 8).
 */
export function JournalPage() {
  const [f, setF] = useState({
    opId: '',
    resourceId: '',
    documentId: '',
    targetId: '',
    jobId: '',
    principalId: '',
    profile: '',
    outcome: '',
    withPreImage: '',
    sinceMinutes: '',
  });
  /** Paging: the cursors of the pages above the one shown (empty: the newest page). */
  const [cursors, setCursors] = useState<number[]>([]);
  const before = cursors.at(-1);
  const [text, setText] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const { selected } = useProject();
  const clients = useApi<ClientsResponse>('/clients');
  const list = useScopedApi<{ entries: JournalEntry[]; hasMore: boolean; nextBefore: number | null }>(
    `/journal${qs({ ...f, limit: 100, ...(before !== undefined ? { before } : {}) })}`,
  );
  const detail = useScopedApi<{ entry: JournalEntry }>(open === null ? null : `/journal/${open}`);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setCursors([]);
    setF({ ...f, [k]: e.target.value.trim() });
  };

  const shown = useMemo(() => {
    const t = text.trim().toLowerCase();
    if (!t) return list.data?.entries ?? [];
    return (list.data?.entries ?? []).filter((e) =>
      [
        e.opId,
        e.principalId,
        e.profile,
        e.approvedBy,
        e.targetId,
        e.resourceId,
        e.documentId,
        e.jobId,
        e.version,
        e.outcome,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(t)),
    );
  }, [list.data, text]);

  return (
    <>
      <PageHeader title="Journal" project={selected} />
      <p className="muted">
        Every write the bridge sends to LegendKeeper is listed here, with who made it and whether it applied,
        so you can see what each agent changed. Before a destructive write the bridge also keeps what it
        replaced. This page is view only: LegendKeeper has no history of its own, so this is your undo
        insurance.
      </p>
      <div className="filters">
        <div>
          <label htmlFor="j-text">Search these results</label>
          <input
            id="j-text"
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="operation, id, profile…"
          />
        </div>
        <div>
          <label htmlFor="j-op">Operation</label>
          <input id="j-op" value={f.opId} onChange={set('opId')} placeholder="replaceDocumentBlocks" />
        </div>
        <div>
          <label htmlFor="j-doc">Document id</label>
          <input id="j-doc" value={f.documentId} onChange={set('documentId')} />
        </div>
        <div>
          <label htmlFor="j-res">Resource id</label>
          <input id="j-res" value={f.resourceId} onChange={set('resourceId')} />
        </div>
        <div>
          <label htmlFor="j-prof">Profile</label>
          <select id="j-prof" value={f.profile} onChange={set('profile')}>
            <option value="">Any</option>
            <option value="system">system</option>
            {clients.data?.profiles.map((p) => (
              <option key={p.id} value={p.label}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="j-pid">Principal id</label>
          <input id="j-pid" value={f.principalId} onChange={set('principalId')} placeholder="pat_…" />
        </div>
        <div>
          <label htmlFor="j-outcome">Outcome</label>
          <select id="j-outcome" value={f.outcome} onChange={set('outcome')}>
            <option value="">Any</option>
            <option value="applied">applied</option>
            <option value="not_applied">not applied</option>
            <option value="unknown">unknown</option>
            <option value="pending">pending</option>
          </select>
        </div>
        <div>
          <label htmlFor="j-pre">Writes</label>
          <select id="j-pre" value={f.withPreImage} onChange={set('withPreImage')}>
            <option value="">All writes</option>
            <option value="true">Destructive only (with a pre-image)</option>
          </select>
        </div>
        <div>
          <label htmlFor="j-since">When</label>
          <select id="j-since" value={f.sinceMinutes} onChange={set('sinceMinutes')}>
            {SINCE.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>
      <ErrorNote error={list.error} onRetry={list.reload} />
      {!list.data ? (
        <Loading />
      ) : shown.length === 0 ? (
        <Empty>No journal entries match.</Empty>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Operation</th>
                <th>Target</th>
                <th>Principal</th>
                <th>Profile</th>
                <th>Approved by</th>
                <th>Outcome</th>
                <th className="num">Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.id} className={open === e.id ? 'selected' : ''} data-entry={e.id}>
                  <td>{fmtTime(e.at)}</td>
                  <td className="mono">{e.opId}</td>
                  <td>
                    {e.targetKind}
                    <div className="mono muted small-text">
                      {e.documentId ?? e.targetId ?? e.resourceId ?? '–'}
                    </div>
                  </td>
                  <td className="mono small-text">{e.principalId}</td>
                  <td>{e.profile}</td>
                  <td>
                    {e.approvedBy ? (
                      <Badge tone="info">{e.approvedBy}</Badge>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                  <td>
                    <Badge
                      tone={e.outcome === 'applied' ? 'ok' : e.outcome === 'pending' ? 'warn' : 'neutral'}
                    >
                      {e.outcome}
                    </Badge>
                  </td>
                  <td className="num">{fmtBytes(e.bytes)}</td>
                  <td>
                    <button
                      type="button"
                      className="small"
                      onClick={() => setOpen(open === e.id ? null : e.id)}
                    >
                      {open === e.id ? 'Hide' : 'View'}
                    </button>
                    {e.jobId && (
                      <>
                        {' '}
                        <Link to={`/jobs/${encodeURIComponent(e.jobId)}`}>job</Link>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(cursors.length > 0 || list.data?.nextBefore) && (
        <div className="actions" aria-label="Pages">
          <button
            type="button"
            className="small"
            disabled={cursors.length === 0}
            onClick={() => setCursors([])}
          >
            Newest
          </button>{' '}
          <button
            type="button"
            className="small"
            disabled={!list.data?.nextBefore}
            onClick={() => {
              const next = list.data?.nextBefore;
              if (next) setCursors([...cursors, next]);
            }}
          >
            Older
          </button>{' '}
          <span className="muted">
            {cursors.length === 0 ? 'The newest 100.' : `Page ${cursors.length + 1}, 100 per page.`}
          </span>
        </div>
      )}
      {open !== null && (
        <section className="card" aria-label="Journal entry">
          <h2>Entry {open}</h2>
          <ErrorNote error={detail.error} />
          {!detail.data ? (
            !detail.error && <Loading />
          ) : (
            <>
              <dl className="meta">
                <div>
                  <dt>Version replaced</dt>
                  <dd className="mono">{detail.data.entry.version ?? '–'}</dd>
                </div>
                <div>
                  <dt>Job</dt>
                  <dd className="mono">{detail.data.entry.jobId ?? '–'}</dd>
                </div>
                <div>
                  <dt>Risk</dt>
                  <dd>{detail.data.entry.risk}</dd>
                </div>
              </dl>
              <h3>
                Pre-image (what was there before){' '}
                <CopyButton
                  text={JSON.stringify(detail.data.entry.preImage, null, 2) ?? ''}
                  label="Copy JSON"
                />
              </h3>
              {detail.data.entry.preImage === null || detail.data.entry.preImage === undefined ? (
                <p className="muted">This entry keeps only ids, no pre-image.</p>
              ) : (
                <Json value={detail.data.entry.preImage} />
              )}
              <h3>Parameters of the write</h3>
              <Json value={detail.data.entry.params} />
            </>
          )}
        </section>
      )}
    </>
  );
}

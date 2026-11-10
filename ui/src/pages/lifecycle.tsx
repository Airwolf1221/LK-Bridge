import { Badge, Empty, ErrorNote, Loading, PageHeader } from '../components';
import { fmtAgo } from '../format';
import { useNow } from '../hooks';
import { useProject, useScopedApi } from '../project';
import { Link } from '../router';
import type { LifecycleRecordView, LifecycleRecordsResponse } from '../types';

/**
 * Archive and lifecycle (v2 C2c, ADR 0035): the lifecycle record of the selected project, read-only and never pruned.
 * One row per lifecycle change (archive_page, unarchive_page, move_to_working, promote_page): the page, the action, its
 * date, the state the page was in, whether the change finished, and its jobs (each linked to the journal). Changes
 * happen only through the four tools, each with the owner's canonical approval; nothing here changes anything. Below,
 * the link index the related-pages report uses, and how fresh it is.
 */
const ACTION: Record<LifecycleRecordView['action'], string> = {
  archive: 'Archived',
  unarchive: 'Unarchived',
  move_to_working: 'Moved to Working',
  promote: 'Promoted',
};
const STATE: Record<string, string> = {
  authoritative: 'Authoritative',
  working: 'Working',
  archived: 'Archived',
  unknown: 'Unknown',
};

export function LifecyclePage() {
  const { selected } = useProject();
  const now = useNow();
  const r = useScopedApi<LifecycleRecordsResponse>('/lifecycle/records?limit=200');
  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  const d = r.data;
  return (
    <>
      <PageHeader title="Archive and lifecycle" project={selected}>
        <button type="button" className="small" onClick={r.reload}>
          Refresh
        </button>
      </PageHeader>
      <p className="muted">
        Every lifecycle change of a page, newest first: archived, unarchived, moved to Working or promoted.
        The record is kept for good; unarchive_page and promote_page read it. An incomplete change is finished
        by calling the same tool on the page again.
      </p>
      <section className="card table-wrap" aria-labelledby="lifecycle-records-h">
        <h2 id="lifecycle-records-h">Changes ({d.total})</h2>
        {d.records.length === 0 ? (
          <Empty>No lifecycle change yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Page</th>
                <th>Action</th>
                <th>Date</th>
                <th>Previous state</th>
                <th>Now</th>
                <th>State</th>
                <th>Journal</th>
              </tr>
            </thead>
            <tbody>
              {d.records.map((x) => (
                <tr key={x.id} data-record={x.id}>
                  <td>
                    <span className="mono small-text">{x.pageId}</span> {x.previousName}
                  </td>
                  <td>{ACTION[x.action]}</td>
                  <td>{x.date}</td>
                  <td>{STATE[x.previousState] ?? x.previousState}</td>
                  <td>{x.target.name}</td>
                  <td>
                    {x.state === 'complete' ? (
                      <Badge tone="ok">complete</Badge>
                    ) : (
                      <Badge tone="warn">incomplete</Badge>
                    )}
                    {x.detail.verified === false && <Badge tone="warn">not as planned</Badge>}
                  </td>
                  <td>
                    {x.jobs.map((j) => (
                      <span key={j}>
                        <Link to={`/journal?jobId=${encodeURIComponent(j)}`}>{j}</Link>{' '}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card" aria-labelledby="lifecycle-links-h">
        <h2 id="lifecycle-links-h">Link index</h2>
        <p className="muted small-text">
          Which page links to which (link collections and mentions), for the related pages archive_page and
          move_to_working report. Kept up to date from the bridge’s own writes; refreshed by the Link index
          sweep (Maintenance Jobs).
        </p>
        <dl className="kv">
          <dt>Links held</dt>
          <dd>{d.links.total}</dd>
          <dt>Last complete sweep</dt>
          <dd>
            {d.links.lastSweep
              ? `${new Date(d.links.lastSweep.startedAt).toISOString()} (${fmtAgo(d.links.lastSweep.startedAt, now)}): ${d.links.lastSweep.pagesDone} pages, ${d.links.lastSweep.documentsRead} documents, ${d.links.lastSweep.requests} requests`
              : 'none yet: only the bridge’s own writes are indexed'}
          </dd>
          {d.links.running && (
            <>
              <dt>Sweep in progress</dt>
              <dd>
                {d.links.running.pagesDone} of {d.links.running.pagesTotal ?? '?'} pages
                {d.links.running.error
                  ? ` (stopped: ${d.links.running.error}; the next run continues it)`
                  : ''}
              </dd>
            </>
          )}
        </dl>
      </section>
    </>
  );
}

import { useState } from 'react';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, useAction } from '../components';
import { qs } from '../api';
import { useProjectApi, useScopedApi } from '../project';
import { Link } from '../router';

/**
 * Templated Names (v3 F6d, ADR 0082; design T13 as amended on 26 November 2026), in the Setup group beside Reference
 * Types, Index Classification and Nation Subindexes: every source in the AI REPOSITORY with the name the template
 * `<Subject> - <Role>` gives it (its Subject, and the role word of its Reference Type in the published vocabulary), as
 * the newest audit judged it from the snapshots. Free: nothing is read from LegendKeeper here.
 *
 * The counts per status sit at the top, so the scale is seen before the automation is switched on. Filters: status and
 * primary category. The only decision here is **Keep this name** (a ruling that holds until the page’s Subject,
 * Reference Type or name changes) and its **Undo**: the renames themselves are `name_nontemplated`’s fix, run from the
 * Automation page (Off by default; Propose for a first batch, then Apply).
 */

type Status =
  'rename' | 'held_collision' | 'held_no_subject' | 'held_type' | 'templated' | 'exempt_specialist' | 'kept';
const STATUSES: Status[] = [
  'rename',
  'held_collision',
  'held_no_subject',
  'held_type',
  'templated',
  'exempt_specialist',
  'kept',
];
const STATUS_LABEL: Record<Status, string> = {
  rename: 'to rename',
  held_collision: 'held: collision',
  held_no_subject: 'held: no Subject',
  held_type: 'held: type',
  templated: 'templated',
  exempt_specialist: 'specialist (exempt)',
  kept: 'kept',
};
const STATUS_TONE: Record<Status, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  rename: 'warn',
  held_collision: 'bad',
  held_no_subject: 'bad',
  held_type: 'bad',
  templated: 'ok',
  exempt_specialist: 'neutral',
  kept: 'neutral',
};
const KEEPABLE = new Set<Status>(['rename', 'held_collision', 'held_no_subject', 'held_type']);

interface Row {
  pageId: string;
  rawName: string;
  displayName: string;
  category: string | null;
  subject: string | null;
  referenceType: string | null;
  role: string | null;
  proposed: string | null;
  status: Status;
  reason: string;
  other?: { id: string; name: string };
  ruling: { reason: string; by: string; at: number } | null;
}
interface Response {
  report: {
    state: 'ready' | 'no_rules' | 'no_run';
    message: string | null;
    vocabulary: 'draft' | 'published' | null;
    meta: {
      runId: string;
      builtAt: number;
      snapshotId: string;
      takenAt: number;
      excluded: Record<string, number>;
    } | null;
    counts: Record<Status, number>;
    total: number;
    rows: Row[];
    categories: string[];
    check: boolean;
  };
}

/** Rows a page of the table shows (fetched a page at a time). */
export const PAGE_ROWS = 100;

export function TemplatedNamesPage() {
  const [status, setStatus] = useState<Status | ''>('');
  const [category, setCategory] = useState('');
  const [offset, setOffset] = useState(0);
  const filterKey = `${status}\u0000${category}`;
  const [seen, setSeen] = useState(filterKey);
  if (seen !== filterKey) {
    setSeen(filterKey);
    setOffset(0);
  }
  const path = `/templated-names${qs({
    status: status || undefined,
    category: category || undefined,
    offset: offset || undefined,
    limit: PAGE_ROWS,
  })}`;
  const r = useScopedApi<Response>(path);
  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  const d = r.data.report;
  return (
    <>
      <PageHeader title="Templated Names" />
      <p>
        An ordinary source is named <code>&lt;Subject&gt; - &lt;Role&gt;</code>: its Subject as written, and
        the role word of its Reference Type in the published vocabulary (
        <Link to="/reference-types">Reference Types</Link>). The prefix stays. Approved specialist types keep
        their names, and a registered character’s pages keep theirs. Nothing is renamed here: the renames are{' '}
        <code>name_nontemplated</code>’s fix, on the <Link to="/automation">Automation</Link> page (Off until
        you switch it to Propose or Apply).
      </p>
      {d.message && <p className="note">{d.message}</p>}
      {d.state === 'ready' && (
        <section aria-labelledby="tn-counts" className="card" data-counts>
          <h2 id="tn-counts">Counts</h2>
          <p className="small-text">
            {STATUSES.map((s) => `${STATUS_LABEL[s]}: ${d.counts[s] ?? 0}`).join(' · ')}
          </p>
          {d.meta && (
            <p className="small-text">
              As the audit {d.meta.runId} judged the snapshot {d.meta.snapshotId} (
              {new Date(d.meta.takenAt).toLocaleString('en-GB')}).
              {Object.keys(d.meta.excluded).length > 0 &&
                ` Left out: ${Object.entries(d.meta.excluded)
                  .map(([k, n]) => `${k} ${n}`)
                  .join(', ')}.`}
              {!d.check &&
                ' The check is switched off for this project (Projects page): no findings are made.'}
            </p>
          )}
        </section>
      )}
      {d.state === 'ready' && (
        <section aria-labelledby="tn-rows">
          <h2 id="tn-rows">Sources</h2>
          <div className="filters" role="group" aria-label="Filters">
            <label>
              Status{' '}
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as Status | '')}
                aria-label="Status"
              >
                <option value="">Any</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>{' '}
            <label>
              Primary category{' '}
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                aria-label="Primary category"
              >
                <option value="">Any</option>
                {d.categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
                <option value="(none)">(none)</option>
              </select>
            </label>
          </div>
          {d.rows.length === 0 ? (
            <Empty>No source matches.</Empty>
          ) : (
            <div className="table-wrap">
              <table aria-label="Sources">
                <thead>
                  <tr>
                    <th>Page</th>
                    <th>Proposed name</th>
                    <th>Subject</th>
                    <th>Reference Type</th>
                    <th>Status</th>
                    <th>Decide</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((row) => (
                    <NameRow key={row.pageId} row={row} onChanged={r.reload} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {d.total > PAGE_ROWS && (
            <p className="pager" role="group" aria-label="Pages">
              <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_ROWS))}>
                Previous
              </Button>{' '}
              <span className="small-text">
                Rows {offset + 1} to {Math.min(offset + PAGE_ROWS, d.total)} of {d.total}
              </span>{' '}
              <Button disabled={offset + PAGE_ROWS >= d.total} onClick={() => setOffset(offset + PAGE_ROWS)}>
                Next
              </Button>
            </p>
          )}
        </section>
      )}
    </>
  );
}

function NameRow({ row, onChanged }: { row: Row; onChanged: () => void }) {
  const api = useProjectApi();
  const { run, busy } = useAction();
  const [keeping, setKeeping] = useState(false);
  const [reason, setReason] = useState('');
  const post = (path: string, body: Record<string, unknown>, done: string) =>
    void run(() => api.post(path, { pageId: row.pageId, confirm: true, ...body }), done).then((x) => {
      if (x) {
        setKeeping(false);
        onChanged();
      }
    });
  return (
    <tr data-row={row.pageId}>
      <td>
        <Link to={`/tree?node=${encodeURIComponent(row.pageId)}`}>
          <strong>{row.rawName}</strong>
        </Link>
        <div className="small-text">{row.category ?? 'no primary category'}</div>
      </td>
      <td>{row.proposed ?? <span className="muted">none</span>}</td>
      <td>{row.subject ?? <span className="muted">none</span>}</td>
      <td>
        {row.referenceType ?? <span className="muted">none</span>}
        {row.role && <div className="small-text">role word: {row.role}</div>}
      </td>
      <td>
        <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
        <div className="small-text">{row.reason}</div>
        {row.other && (
          <div className="small-text">
            with <Link to={`/tree?node=${encodeURIComponent(row.other.id)}`}>{row.other.name}</Link>
          </div>
        )}
        {row.ruling && <div className="small-text">kept: {row.ruling.reason}</div>}
      </td>
      <td>
        {row.status === 'kept' || row.ruling ? (
          <Button
            disabled={busy}
            onClick={() => post('/templated-names/undo', {}, `${row.rawName}: undone.`)}
          >
            Undo
          </Button>
        ) : KEEPABLE.has(row.status) ? (
          keeping ? (
            <span>
              <input
                aria-label="Why keep this name"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why"
              />{' '}
              <Button
                disabled={busy || reason.trim() === ''}
                onClick={() => post('/templated-names/keep', { reason }, `${row.rawName}: kept.`)}
              >
                Keep
              </Button>{' '}
              <Button onClick={() => setKeeping(false)}>Cancel</Button>
            </span>
          ) : (
            <Button disabled={busy} onClick={() => setKeeping(true)}>
              Keep this name
            </Button>
          )
        ) : null}
      </td>
    </tr>
  );
}

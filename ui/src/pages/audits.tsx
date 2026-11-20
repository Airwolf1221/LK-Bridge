import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError, qs } from '../api';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, useAction, useConfirm } from '../components';
import { fmtAgo, fmtDuration, fmtInt, fmtTime } from '../format';
import { useNow } from '../hooks';
import { useProject, useProjectReloadOn, useScopedApi } from '../project';
import { useReauth } from '../reauth';
import { Link } from '../router';
import { rowCandidates, tieFromError, TieChoices, type TieCandidate } from './chronology-ties';
import { ConsistencyPick } from './consistency-pick';
import type {
  AuditCodeInfo,
  AuditConfigResponse,
  AuditFindingView,
  AuditFindingsResponse,
  AuditOverviewResponse,
  AuditProposeFixResponse,
  AuditRecheckResponse,
  AuditRuleView,
  AuditRunView,
  AuditSettingsView,
  AuditSeverity,
  SnapshotPagesResponse,
} from '../types';

/**
 * Audits (v2 E2, ADR 0044): findings only, read from the snapshots. Cards:
 *
 * - Latest audit: when it ran, how long it took, which snapshot it read and how old that was (a stale one is flagged),
 *   and "Run an audit now" (reads the snapshot store and the bridge's own database; never LegendKeeper).
 * - Summary: findings by category and severity; a row filters the list below.
 * - Findings: filters (category, code, severity, page path, new, acknowledged, resolved), per-page grouping, each
 *   finding's evidence, source snapshot (with a link to the page's snapshot history) and age, acknowledging with a
 *   reason, "Propose a fix" (one ordinary proposal, never applied by the audit) and "Re-check now" (the only two
 *   requests that read LegendKeeper).
 * - Runs: each with its duration and snapshot.
 * - Rules and settings: the rules editor (saving asks you to sign in again, as the canon rules do), the
 *   tag-definition source and the audit settings.
 */

const SEVERITY_TONE: Record<AuditSeverity, 'bad' | 'warn' | 'info'> = {
  error: 'bad',
  warning: 'warn',
  info: 'info',
};

const CATEGORY_LABEL: Record<string, string> = {
  rules: 'Rules',
  template: 'Templates',
  tags: 'Tags',
  references: 'References',
  unclassified: 'Unclassified pages',
  ordering: 'Ordering',
  taxonomy: 'Taxonomy',
  facts: 'Facts',
  lifecycle: 'Lifecycle',
  keep_regions: 'Keep regions',
  chronology: 'Chronology',
  assets: 'Asset library',
  governance: 'Governance',
  consistency: 'Consistency (dates and identity facts)',
  audit: 'The audit itself',
};

const fmtAge = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 6) / 10;
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};

export function AuditsPage() {
  const { selected } = useProject();
  const overview = useScopedApi<AuditOverviewResponse>('/audits');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const now = useNow(30_000);
  useProjectReloadOn(['audits'], overview.reload);
  // While an audit runs, look again every few seconds.
  const running = overview.data?.running != null;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(overview.reload, 3000);
    return () => clearInterval(t);
  }, [running, overview.reload]);
  return (
    <>
      <PageHeader title="Audits" project={selected}>
        <button type="button" className="small" onClick={overview.reload}>
          Refresh
        </button>
      </PageHeader>
      <p className="muted">
        What the audits found in the newest full snapshot (and the change snapshots since). Findings only:
        nothing here changes your world. “Propose a fix” makes an ordinary proposal for you to approve on the{' '}
        <Link to="/proposals">Proposals</Link> page.
      </p>
      {!overview.data ? (
        overview.error ? (
          <ErrorNote error={overview.error} onRetry={overview.reload} />
        ) : (
          <Loading />
        )
      ) : (
        <>
          <LatestCard project={selected} d={overview.data} now={now} reload={overview.reload} />
          <SummaryCard
            d={overview.data}
            onPick={(category) => setFilters({ ...filters, category, code: '' })}
          />
          <FindingsCard
            project={selected}
            d={overview.data}
            filters={filters}
            setFilters={setFilters}
            reloadOverview={overview.reload}
          />
          <RunsCard runs={overview.data.runs} now={now} />
          <RulesCard project={selected} />
        </>
      )}
    </>
  );
}

// ================================================================================================ latest

function LatestCard({
  project,
  d,
  now,
  reload,
}: {
  project: string | null;
  d: AuditOverviewResponse;
  now: number;
  reload: () => void;
}) {
  const { run, busy } = useAction();
  const last = d.latestRun;
  const start = () =>
    void run(() => api.post('/audits/run', { confirm: true, project }), 'Audit started.').then(
      (ok) => ok && setTimeout(reload, 400),
    );
  const snap = d.newestFullSnapshot;
  const stale = snap !== null && snap.ageMs > d.maxSnapshotAgeHours * 3_600_000;
  return (
    <section className="card" aria-labelledby="audit-latest-h">
      <h2 id="audit-latest-h">Latest audit</h2>
      {last ? (
        <dl className="kv">
          <dt>Ran</dt>
          <dd>
            {fmtTime(last.startedAt)} ({fmtAgo(last.startedAt, now)}){' '}
            <span className="muted small-text">· {last.trigger}</span>{' '}
            <Badge tone={last.state === 'succeeded' ? 'ok' : 'bad'}>{last.state}</Badge>
          </dd>
          <dt>Took</dt>
          <dd>{last.durationMs === null ? '–' : fmtDuration(last.durationMs)}</dd>
          <dt>Snapshot</dt>
          <dd>
            <code>{last.snapshotId ?? '–'}</code>
            {last.snapshotAgeMs !== null && (
              <>
                {' '}
                <span className="muted small-text">· {fmtAge(last.snapshotAgeMs)} old when audited</span>
              </>
            )}
            {last.stale && (
              <>
                {' '}
                <Badge tone="warn">stale</Badge>
              </>
            )}
            {last.changeSnapshots > 0 && (
              <div className="muted small-text">
                plus {fmtInt(last.changeSnapshots)} change snapshots after it
              </div>
            )}
          </dd>
          <dt>Pages</dt>
          <dd>{fmtInt(last.pages)}</dd>
          {last.summary && (
            <>
              <dt>Result</dt>
              <dd>{last.summary}</dd>
            </>
          )}
        </dl>
      ) : (
        <Empty>No audit has run yet. One runs after each nightly full snapshot; you can run one now.</Empty>
      )}
      {stale && snap && (
        <p className="note note-warn small-text" data-testid="stale-note">
          The newest full snapshot is {fmtAge(snap.ageMs)} old (the audit allows {d.maxSnapshotAgeHours}{' '}
          hours): the findings are as of then. Edits made in the LegendKeeper app since are not seen until the
          next full snapshot.
        </p>
      )}
      <div className="row mt">
        <Button variant="primary" busy={busy} disabled={!project || d.running !== null} onClick={start}>
          Run an audit now
        </Button>
        {d.running && <span className="muted small-text">An audit is running…</span>}
        <span className="muted small-text">Reads the snapshot store only: no request to LegendKeeper.</span>
      </div>
    </section>
  );
}

// ================================================================================================ summary

function SummaryCard({ d, onPick }: { d: AuditOverviewResponse; onPick: (category: string) => void }) {
  const rows = d.catalogue.categories.filter((c) => {
    const v = d.summary.byCategory[c];
    return v && v.error + v.warning + v.info > 0;
  });
  return (
    <section className="card table-wrap" aria-labelledby="audit-summary-h">
      <h2 id="audit-summary-h">
        Summary{' '}
        <span className="muted small-text">
          {fmtInt(d.summary.open)} open · {fmtInt(d.summary.new)} new · {fmtInt(d.summary.acknowledged)}{' '}
          acknowledged · {fmtInt(d.summary.gone)} resolved
        </span>
      </h2>
      {rows.length === 0 ? (
        <Empty>No open findings.</Empty>
      ) : (
        <table aria-label="Findings by category and severity">
          <thead>
            <tr>
              <th>Category</th>
              <th>Errors</th>
              <th>Warnings</th>
              <th>Info</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const v = d.summary.byCategory[c]!;
              return (
                <tr key={c} data-category={c}>
                  <td>
                    <button type="button" className="link" onClick={() => onPick(c)}>
                      {CATEGORY_LABEL[c] ?? c}
                    </button>
                  </td>
                  <td>{v.error || '–'}</td>
                  <td>{v.warning || '–'}</td>
                  <td>{v.info || '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ================================================================================================ findings

interface Filters {
  category: string;
  code: string;
  severity: string;
  page: string;
  onlyNew: boolean;
  acknowledged: 'hide' | 'only' | 'include';
  state: 'open' | 'gone' | 'all';
  group: boolean;
  offset: number;
}
const NO_FILTERS: Filters = {
  category: '',
  code: '',
  severity: '',
  page: '',
  onlyNew: false,
  acknowledged: 'hide',
  state: 'open',
  group: false,
  offset: 0,
};
const PAGE = 100;

function FindingsCard({
  project,
  d,
  filters,
  setFilters,
  reloadOverview,
}: {
  project: string | null;
  d: AuditOverviewResponse;
  filters: Filters;
  setFilters: (f: Filters) => void;
  reloadOverview: () => void;
}) {
  const [pageText, setPageText] = useState(filters.page);
  const path = `/audits/findings${qs({
    category: filters.category,
    code: filters.code,
    severity: filters.severity,
    page: filters.page,
    new: filters.onlyNew ? 'true' : undefined,
    acknowledged: filters.acknowledged,
    state: filters.state,
    group: filters.group ? 'page' : undefined,
    limit: PAGE,
    offset: filters.offset,
  })}`;
  const r = useScopedApi<AuditFindingsResponse>(path);
  const reload = () => {
    r.reload();
    reloadOverview();
  };
  const set = (patch: Partial<Filters>) => setFilters({ ...filters, offset: 0, ...patch });
  const codes = d.catalogue.codes.filter((c) => !filters.category || c.category === filters.category);
  const info = useMemo(() => new Map(d.catalogue.codes.map((c) => [c.code, c])), [d.catalogue.codes]);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    set({ page: pageText.trim() });
  };
  return (
    <section className="card" aria-labelledby="audit-findings-h">
      <h2 id="audit-findings-h">Findings{r.data ? ` (${fmtInt(r.data.total)})` : ''}</h2>
      <form className="row wrap" onSubmit={onSubmit} aria-label="Filters">
        <label>
          Category{' '}
          <select value={filters.category} onChange={(e) => set({ category: e.target.value, code: '' })}>
            <option value="">All</option>
            {d.catalogue.categories.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c] ?? c}
              </option>
            ))}
          </select>
        </label>
        <label>
          Code{' '}
          <select value={filters.code} onChange={(e) => set({ code: e.target.value })}>
            <option value="">All</option>
            {codes.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}
              </option>
            ))}
          </select>
        </label>
        <label>
          Severity{' '}
          <select value={filters.severity} onChange={(e) => set({ severity: e.target.value })}>
            <option value="">All</option>
            {d.catalogue.severities.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Page path{' '}
          <input
            value={pageText}
            onChange={(e) => setPageText(e.target.value)}
            placeholder="part of a path or name"
          />
        </label>
        <button type="submit" className="small">
          Filter
        </button>
        <label>
          <input
            type="checkbox"
            checked={filters.onlyNew}
            onChange={(e) => set({ onlyNew: e.target.checked })}
          />{' '}
          New in the latest audit
        </label>
        <label>
          Acknowledged{' '}
          <select
            value={filters.acknowledged}
            onChange={(e) => set({ acknowledged: e.target.value as Filters['acknowledged'] })}
          >
            <option value="hide">Hidden</option>
            <option value="include">Shown</option>
            <option value="only">Only</option>
          </select>
        </label>
        <label>
          Show{' '}
          <select value={filters.state} onChange={(e) => set({ state: e.target.value as Filters['state'] })}>
            <option value="open">Open</option>
            <option value="gone">Resolved</option>
            <option value="all">Both</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={filters.group} onChange={(e) => set({ group: e.target.checked })} />{' '}
          Group by page
        </label>
        <button
          type="button"
          className="small"
          onClick={() => {
            setPageText('');
            setFilters(NO_FILTERS);
          }}
        >
          Clear
        </button>
      </form>
      {!r.data ? (
        r.error ? (
          <ErrorNote error={r.error} onRetry={r.reload} />
        ) : (
          <Loading />
        )
      ) : r.data.findings.length === 0 ? (
        <Empty>No findings match.</Empty>
      ) : filters.group && r.data.groups ? (
        <div className="stack">
          {r.data.groups.map((g) => (
            <div key={g.pageId ?? g.findings[0]} className="subcard" data-page={g.pageId ?? ''}>
              <h3>
                {g.pagePath ?? 'Not about one page'}{' '}
                {g.pageId && (
                  <Link to={`/snapshots?page=${encodeURIComponent(g.pageId)}`} className="small-text">
                    snapshot history
                  </Link>
                )}
              </h3>
              <FindingsTable
                project={project}
                rows={r.data!.findings.filter((f) => g.findings.includes(f.id))}
                info={info}
                latestRun={r.data!.latestRun}
                reload={reload}
                hidePage
              />
            </div>
          ))}
        </div>
      ) : (
        <FindingsTable
          project={project}
          rows={r.data.findings}
          info={info}
          latestRun={r.data.latestRun}
          reload={reload}
        />
      )}
      {r.data && r.data.total > PAGE && (
        <div className="row mt">
          <button
            type="button"
            className="small"
            disabled={filters.offset === 0}
            onClick={() => setFilters({ ...filters, offset: Math.max(0, filters.offset - PAGE) })}
          >
            Previous
          </button>
          <span className="muted small-text">
            {filters.offset + 1}–{Math.min(r.data.total, filters.offset + PAGE)} of {fmtInt(r.data.total)}
          </span>
          <button
            type="button"
            className="small"
            disabled={filters.offset + PAGE >= r.data.total}
            onClick={() => setFilters({ ...filters, offset: filters.offset + PAGE })}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}

function FindingsTable({
  project,
  rows,
  info,
  latestRun,
  reload,
  hidePage = false,
}: {
  project: string | null;
  rows: AuditFindingView[];
  info: Map<string, AuditCodeInfo>;
  latestRun: string | null;
  reload: () => void;
  hidePage?: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="table-wrap">
      <table aria-label="Findings">
        <thead>
          <tr>
            <th>Severity</th>
            <th>Finding</th>
            {!hidePage && <th>Page</th>}
            <th>Seen</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <FindingRow
              key={f.id}
              project={project}
              f={f}
              title={info.get(f.code)?.title ?? f.code}
              isNew={f.firstSeenRun === latestRun}
              open={open === f.id}
              toggle={() => setOpen(open === f.id ? null : f.id)}
              reload={reload}
              hidePage={hidePage}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FindingRow({
  project,
  f,
  title,
  isNew,
  open,
  toggle,
  reload,
  hidePage,
}: {
  project: string | null;
  f: AuditFindingView;
  title: string;
  isNew: boolean;
  open: boolean;
  toggle: () => void;
  reload: () => void;
  hidePage: boolean;
}) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // v3 F4b (ADR 0064, D6): a consistency finding's values side by side, to pick the right one.
  const [picking, setPicking] = useState(false);
  const colspan = hidePage ? 4 : 5;
  // v3 F2.1: a chronology tie: the candidates of a refused fix, or of an event in a tie (`chronology_pair`).
  const [tie, setTie] = useState<TieCandidate[] | null>(null);
  const pairRows = f.fix?.kind === 'chronology_pair' ? rowCandidates(f.fix.args.candidates) : [];
  const choose = (choice: { eventId?: string; createNew?: true; rowId?: string }) => {
    const send = (confirmShapeChange: boolean) =>
      api.post<AuditProposeFixResponse>(`/audits/findings/${f.id}/propose-fix`, {
        confirm: true,
        project,
        ...choice,
        ...(confirmShapeChange ? { confirmShapeChange: true } : {}),
      });
    void run(async () => {
      try {
        return await send(false);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'SHAPE_CHANGE_UNCONFIRMED')) {
          const t = tieFromError(e);
          if (t && t.length > 0) setTie(t);
          throw e;
        }
        const yes = await confirm({
          title: 'This choice changes the event’s shape',
          message: (
            <p>
              The timeline event would change. Check that the row and the event are the same chronology event
              before you propose it.
            </p>
          ),
          confirmLabel: 'Propose the change',
        });
        return yes ? send(true) : undefined;
      }
    }).then((r) => {
      if (!r) return;
      setTie(null);
      setNote(
        r.status === 'proposal_captured'
          ? `Proposed (${r.proposalId}). Nothing is changed until you approve it.`
          : r.message,
      );
    });
  };
  const propose = async () => {
    // v2 E6 (ADR 0048): a chronology repair that turns a range into a single date (or the reverse) is never one click.
    const shape = f.fix?.confirm?.shapeChange;
    if (shape) {
      const yes = await confirm({
        title: 'This fix changes the event’s shape',
        message: (
          <p>
            The timeline event would change: <strong>{shape}</strong>. Check that the row and the event are
            the same chronology event before you propose it.
          </p>
        ),
        confirmLabel: 'Propose the change',
      });
      if (!yes) return;
    }
    void run(async () => {
      try {
        return await api.post<AuditProposeFixResponse>(`/audits/findings/${f.id}/propose-fix`, {
          confirm: true,
          project,
          ...(shape ? { confirmShapeChange: true } : {}),
        });
      } catch (e) {
        // v3 F2.1: a refused chronology fix shows its candidates, each with a button.
        const t = tieFromError(e);
        if (t && t.length > 0) setTie(t);
        throw e;
      }
    }).then((r) => {
      if (!r) return;
      setNote(
        r.status === 'proposal_captured'
          ? `Proposed (${r.proposalId}). Nothing is changed until you approve it.`
          : r.message,
      );
    });
  };
  const recheck = () =>
    void run(() =>
      api.post<AuditRecheckResponse>(`/audits/findings/${f.id}/recheck`, { confirm: true, project }),
    ).then((r) => {
      if (!r) return;
      setNote(
        r.status === 'gone'
          ? 'Re-checked live: this finding is gone.'
          : `Re-checked live (${r.reads} reads): it is still there.`,
      );
      reload();
    });
  const acknowledge = () =>
    void run(
      () =>
        api.post(`/audits/findings/${f.id}/acknowledge`, {
          confirm: true,
          project,
          reason: (reason ?? '').trim(),
        }),
      'Acknowledged.',
    ).then((ok) => {
      if (ok) {
        setReason(null);
        reload();
      }
    });
  const unacknowledge = () =>
    void run(
      () => api.post(`/audits/findings/${f.id}/unacknowledge`, { confirm: true, project }),
      'No longer acknowledged.',
    ).then((ok) => ok && reload());
  // v3 F4a (ADR 0063): a governance finding naming an external skill: allow the name (a real skill used elsewhere).
  const skill =
    f.code === 'governance_external_name' && typeof f.evidence.name === 'string' ? f.evidence.name : null;
  const allowName = async () => {
    const yes = await confirm({
      title: 'Allow this skill name?',
      message: (
        <p>
          <strong>{skill}</strong> is a real skill you use elsewhere: the governance check never reports it
          again. You can remove it later from the audit settings below.
        </p>
      ),
      confirmLabel: 'Allow this name',
    });
    if (!yes) return;
    void run(
      () => api.post(`/audits/findings/${f.id}/allow-name`, { confirm: true, project }),
      'Allowed: it is not reported again.',
    ).then((ok) => ok && reload());
  };
  return (
    <>
      <tr data-finding={f.id} data-code={f.code} data-severity={f.severity}>
        <td>
          <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>
        </td>
        <td>
          <div>
            <strong>{title}</strong> <span className="muted small-text">{f.code}</span>
          </div>
          <div className="small-text">{f.message}</div>
          {f.acknowledgementLapsed && (
            <div className="small-text">
              <Badge tone="warn">evidence changed</Badge> you acknowledged this before; it has changed since.
            </div>
          )}
          {f.acknowledgement && (
            <div className="small-text muted">
              Acknowledged by {f.acknowledgement.by}: {f.acknowledgement.reason}
            </div>
          )}
        </td>
        {!hidePage && (
          <td className="small-text">
            {f.pagePath ?? '–'}
            {f.pageId && (
              <>
                {' '}
                <Link to={`/snapshots?page=${encodeURIComponent(f.pageId)}`}>history</Link>
              </>
            )}
          </td>
        )}
        <td className="small-text">
          {f.state === 'gone' ? (
            <Badge tone="ok">resolved {f.resolvedAt ? fmtTime(f.resolvedAt) : ''}</Badge>
          ) : isNew ? (
            <Badge tone="info">new</Badge>
          ) : (
            <span className="muted">since {fmtTime(f.firstSeenAt)}</span>
          )}
        </td>
        <td>
          <div className="row wrap">
            <button type="button" className="small" aria-expanded={open} onClick={toggle}>
              {open ? 'Hide evidence' : 'Evidence'}
            </button>
            {f.state === 'open' && f.fix && f.fix.kind !== 'chronology_pair' && (
              <Button
                className="small"
                busy={busy}
                disabled={!project}
                onClick={() => void propose()}
                title={f.fix.summary}
              >
                Propose a fix
              </Button>
            )}
            {f.state === 'open' && f.fix?.confirm && (
              <Badge tone="warn">{f.fix.confirm.shapeChange}: needs your confirmation</Badge>
            )}
            {f.state === 'open' && f.category === 'consistency' && (
              <button
                type="button"
                className="small"
                aria-expanded={picking}
                onClick={() => setPicking(!picking)}
              >
                {picking ? 'Hide the values' : 'Pick the right value'}
              </button>
            )}
            {f.state === 'open' && f.category !== 'governance' && f.category !== 'consistency' && (
              <Button className="small" busy={busy} disabled={!project} onClick={recheck}>
                Re-check now
              </Button>
            )}
            {f.state === 'open' && skill && (
              <Button className="small" busy={busy} disabled={!project} onClick={() => void allowName()}>
                Allow this name
              </Button>
            )}
            {f.state === 'open' &&
              (f.acknowledgement ? (
                <Button className="small" busy={busy} onClick={unacknowledge}>
                  Un-acknowledge
                </Button>
              ) : (
                <button
                  type="button"
                  className="small"
                  onClick={() => setReason(reason === null ? '' : null)}
                >
                  Acknowledge…
                </button>
              ))}
          </div>
          {f.state === 'open' && !note && (tie ?? (pairRows.length > 0 ? pairRows : null)) && (
            <TieChoices
              candidates={tie ?? pairRows}
              busy={busy}
              disabled={busy || !project}
              onUse={(c) => choose(c.kind === 'event' ? { eventId: c.eventId } : { rowId: c.rowId })}
              onCreateNew={() => choose({ createNew: true })}
            />
          )}
          {note && <div className="small-text note note-ok">{note}</div>}
        </td>
      </tr>
      {picking && f.state === 'open' && (
        <ConsistencyPick findingId={f.id} project={project} colspan={colspan} reload={reload} />
      )}
      {reason !== null && (
        <tr>
          <td colSpan={colspan}>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                acknowledge();
              }}
            >
              <label htmlFor={`ack-${f.id}`}>Reason</label>
              <input
                id={`ack-${f.id}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why this is fine as it is"
                maxLength={1000}
                required
              />
              <Button type="submit" busy={busy} disabled={reason.trim() === ''}>
                Acknowledge
              </Button>
              <span className="muted small-text">
                Hidden while the same evidence persists; it comes back if the evidence changes.
              </span>
            </form>
          </td>
        </tr>
      )}
      {open && (
        <tr data-evidence={f.id}>
          <td colSpan={colspan}>
            <dl className="kv">
              <dt>Source</dt>
              <dd>
                {f.source.kind === 'snapshot' && (
                  <>
                    snapshot <code>{f.source.snapshotId}</code>
                    {f.source.baseSnapshotId && f.source.baseSnapshotId !== f.source.snapshotId && (
                      <> (a change snapshot over the full snapshot {f.source.baseSnapshotId})</>
                    )}
                  </>
                )}
                {f.source.kind === 'chronology-check' && <>the chronology check, run {f.source.checkId}</>}
                {f.source.kind === 'bridge' && <>the bridge’s own records</>}
                {f.source.kind === 'live' && <>read live from LegendKeeper at the re-check</>}
                <span className="muted small-text">
                  {' '}
                  · {fmtTime(f.source.takenAt)}, {fmtAge(f.source.ageMs)} old when audited
                </span>
              </dd>
              <dt>First seen</dt>
              <dd>{fmtTime(f.firstSeenAt)}</dd>
              {f.documentId && (
                <>
                  <dt>Document</dt>
                  <dd>
                    <code>{f.documentId}</code>
                    {f.blockId && (
                      <>
                        {' '}
                        block <code>{f.blockId}</code>
                      </>
                    )}
                  </dd>
                </>
              )}
              <dt>Evidence</dt>
              <dd>
                <pre className="json">{JSON.stringify(f.evidence, null, 2)}</pre>
              </dd>
              {f.fix && (
                <>
                  <dt>Fix</dt>
                  <dd className="small-text">{f.fix.summary}</dd>
                </>
              )}
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

// ================================================================================================ runs

function RunsCard({ runs, now }: { runs: AuditRunView[]; now: number }) {
  return (
    <section className="card table-wrap" aria-labelledby="audit-runs-h">
      <h2 id="audit-runs-h">Runs</h2>
      {runs.length === 0 ? (
        <Empty>No audit has run yet.</Empty>
      ) : (
        <table aria-label="Audit runs">
          <thead>
            <tr>
              <th>When</th>
              <th>Trigger</th>
              <th>State</th>
              <th>Took</th>
              <th>Snapshot</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} data-run={r.id}>
                <td>
                  {fmtTime(r.startedAt)}{' '}
                  <span className="muted small-text">({fmtAgo(r.startedAt, now)})</span>
                </td>
                <td>{r.trigger}</td>
                <td>
                  <Badge
                    tone={
                      r.state === 'succeeded'
                        ? 'ok'
                        : r.state === 'running'
                          ? 'info'
                          : r.state === 'skipped'
                            ? 'neutral'
                            : 'bad'
                    }
                  >
                    {r.state}
                  </Badge>
                </td>
                <td>{r.durationMs === null ? '–' : fmtDuration(r.durationMs)}</td>
                <td className="small-text">
                  {r.snapshotId ? <code>{r.snapshotId}</code> : '–'}
                  {r.snapshotAgeMs !== null && <div className="muted">{fmtAge(r.snapshotAgeMs)} old</div>}
                  {r.changeSnapshots > 0 && (
                    <div className="muted">+{r.changeSnapshots} change snapshots</div>
                  )}
                </td>
                <td className="small-text">{r.error ?? r.summary ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ================================================================================================ rules and settings

type RuleDraft = {
  id: string;
  name: string;
  enabled: boolean;
  referenceType: string;
  registryType: string;
  role: string;
  namePrefix: string;
  ancestorName: string;
  kind: '' | 'index' | 'bsrc' | 'bwrk' | 'barc';
  templateMode: 'registry' | 'name' | 'id';
  tplType: string;
  tplRole: string;
  tplName: string;
  tplId: string;
};

const draftOf = (r: AuditRuleView): RuleDraft => ({
  id: r.id,
  name: r.name,
  enabled: r.enabled,
  referenceType: r.selectors.referenceType ?? '',
  registryType: r.selectors.registryType ?? '',
  role: r.selectors.role ?? '',
  namePrefix: r.selectors.namePrefix ?? '',
  ancestorName: r.selectors.ancestorName ?? '',
  kind: r.selectors.kind ?? '',
  templateMode: r.template.registry ? 'registry' : r.template.templateId ? 'id' : 'name',
  tplType: r.template.registry?.type ?? '',
  tplRole: r.template.registry?.role ?? '',
  tplName: r.template.templateName ?? '',
  tplId: r.template.templateId ?? '',
});

const ruleOf = (d: RuleDraft): AuditRuleView => ({
  id: d.id.trim(),
  name: d.name.trim() || d.id.trim(),
  enabled: d.enabled,
  selectors: {
    ...(d.referenceType.trim() ? { referenceType: d.referenceType.trim() } : {}),
    ...(d.registryType.trim() ? { registryType: d.registryType.trim() } : {}),
    ...(d.role.trim() ? { role: d.role.trim() } : {}),
    ...(d.namePrefix ? { namePrefix: d.namePrefix } : {}),
    ...(d.ancestorName.trim() ? { ancestorName: d.ancestorName.trim() } : {}),
    ...(d.kind ? { kind: d.kind } : {}),
  },
  template:
    d.templateMode === 'registry'
      ? { registry: { type: d.tplType.trim(), role: d.tplRole.trim() } }
      : d.templateMode === 'id'
        ? { templateId: d.tplId.trim() }
        : { templateName: d.tplName.trim() },
});

const blankDraft = (): RuleDraft => ({
  id: '',
  name: '',
  enabled: true,
  referenceType: '',
  registryType: '',
  role: '',
  namePrefix: '',
  ancestorName: '',
  kind: '',
  templateMode: 'name',
  tplType: '',
  tplRole: '',
  tplName: '',
  tplId: '',
});

function RulesCard({ project }: { project: string | null }) {
  const cfg = useScopedApi<AuditConfigResponse>('/audits/config');
  return (
    <section className="card" aria-labelledby="audit-rules-h">
      <h2 id="audit-rules-h">Rules and settings</h2>
      {!cfg.data ? (
        cfg.error ? (
          <ErrorNote error={cfg.error} onRetry={cfg.reload} />
        ) : (
          <Loading />
        )
      ) : (
        <RulesEditor key={cfg.data.updatedAt ?? 0} project={project} cfg={cfg.data} reload={cfg.reload} />
      )}
    </section>
  );
}

function RulesEditor({
  project,
  cfg,
  reload,
}: {
  project: string | null;
  cfg: AuditConfigResponse;
  reload: () => void;
}) {
  const { run, busy } = useAction();
  const withReauth = useReauth();
  const [rules, setRules] = useState<RuleDraft[]>(cfg.effectiveRules.map(draftOf));
  const [useDefaults, setUseDefaults] = useState(cfg.seeded);
  const [settings, setSettings] = useState<AuditSettingsView>(cfg.settings);
  const [tag, setTag] = useState<{ pageId: string; documentId: string } | null>(cfg.tagSource);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const pages = useScopedApi<SnapshotPagesResponse>(
    term ? `/snapshots/pages${qs({ q: term, limit: 20 })}` : null,
  );
  const [docs, setDocs] = useState<{ id: string; name: string | null }[]>(
    cfg.tagSourcePage?.documents.filter((d) => d.type === 'page').map((d) => ({ id: d.id, name: d.name })) ??
      [],
  );
  const set = (i: number, patch: Partial<RuleDraft>) =>
    setRules(rules.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const save = (body: Record<string, unknown>, ok: string) =>
    void run(() => withReauth(() => api.put('/audits/config', { confirm: true, project, ...body })), ok).then(
      (r) => r && reload(),
    );
  const pick = (pageId: string) => {
    setTag({ pageId, documentId: '' });
    void api
      .get<{ documents: { id: string; name: string | null }[] }>(
        `/snapshots/pages/${encodeURIComponent(pageId)}${qs({ project })}`,
      )
      .then((p) => setDocs(p.documents))
      .catch(() => setDocs([]));
  };
  const tagPageName =
    cfg.tagSourcePage && tag?.pageId === cfg.tagSourcePage.id ? cfg.tagSourcePage.path : tag?.pageId;
  return (
    <>
      <p className="muted small-text">
        A rule selects pages (by Reference Type, a registry type and role, a name prefix, an ancestor’s name,
        or a kind; all the given selectors must match) and names the template their sidebar and tabs are
        compared with. Overlapping rules, duplicate names and unmatched pages are findings, never guesses.
        Saving asks you to sign in again.
      </p>
      <label className="row">
        <input type="checkbox" checked={useDefaults} onChange={(e) => setUseDefaults(e.target.checked)} /> Use
        the seeded defaults from the registry (Character Core, Compact Character Reference, the Index
        template)
      </label>
      {!useDefaults && (
        <div className="stack" data-testid="rules">
          {rules.map((r, i) => (
            <fieldset key={i} className="subcard" data-rule={r.id || i}>
              <legend>{r.name || r.id || 'New rule'}</legend>
              <div className="row wrap">
                <label>
                  Id{' '}
                  <input
                    value={r.id}
                    onChange={(e) => set(i, { id: e.target.value })}
                    aria-label={`Rule ${i + 1} id`}
                  />
                </label>
                <label>
                  Name{' '}
                  <input
                    value={r.name}
                    onChange={(e) => set(i, { name: e.target.value })}
                    aria-label={`Rule ${i + 1} name`}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) => set(i, { enabled: e.target.checked })}
                  />{' '}
                  Enabled
                </label>
                <button
                  type="button"
                  className="small"
                  onClick={() => setRules(rules.filter((_, k) => k !== i))}
                >
                  Remove
                </button>
              </div>
              <div className="row wrap">
                <label>
                  Reference Type{' '}
                  <input
                    value={r.referenceType}
                    onChange={(e) => set(i, { referenceType: e.target.value })}
                  />
                </label>
                <label>
                  Registry type{' '}
                  <select
                    value={r.registryType}
                    onChange={(e) => set(i, { registryType: e.target.value, role: '' })}
                  >
                    <option value="">–</option>
                    {cfg.registryTypes.map((t) => (
                      <option key={t.id} value={t.singular}>
                        {t.singular}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Role{' '}
                  <select
                    value={r.role}
                    disabled={!r.registryType}
                    onChange={(e) => set(i, { role: e.target.value })}
                  >
                    <option value="">any</option>
                    {(cfg.registryTypes.find((t) => t.singular === r.registryType)?.roles ?? []).map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Name prefix{' '}
                  <input value={r.namePrefix} onChange={(e) => set(i, { namePrefix: e.target.value })} />
                </label>
                <label>
                  Ancestor name{' '}
                  <input value={r.ancestorName} onChange={(e) => set(i, { ancestorName: e.target.value })} />
                </label>
                <label>
                  Kind{' '}
                  <select
                    value={r.kind}
                    onChange={(e) => set(i, { kind: e.target.value as RuleDraft['kind'] })}
                  >
                    <option value="">any</option>
                    <option value="index">index</option>
                    <option value="bsrc">[BSRC]</option>
                    <option value="bwrk">[BWRK]</option>
                    <option value="barc">[BARC]</option>
                  </select>
                </label>
              </div>
              <div className="row wrap">
                <label>
                  Template{' '}
                  <select
                    value={r.templateMode}
                    onChange={(e) => set(i, { templateMode: e.target.value as RuleDraft['templateMode'] })}
                  >
                    <option value="registry">a registry role</option>
                    <option value="name">by name</option>
                    <option value="id">by id</option>
                  </select>
                </label>
                {r.templateMode === 'registry' && (
                  <>
                    <label>
                      Type{' '}
                      <select
                        value={r.tplType}
                        onChange={(e) => set(i, { tplType: e.target.value, tplRole: '' })}
                      >
                        <option value="">–</option>
                        {cfg.registryTypes.map((t) => (
                          <option key={t.id} value={t.singular}>
                            {t.singular}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Role{' '}
                      <select value={r.tplRole} onChange={(e) => set(i, { tplRole: e.target.value })}>
                        <option value="">–</option>
                        {(cfg.registryTypes.find((t) => t.singular === r.tplType)?.roles ?? []).map((x) => (
                          <option key={x} value={x}>
                            {x}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                {r.templateMode === 'name' && (
                  <label>
                    Name{' '}
                    <input
                      value={r.tplName}
                      onChange={(e) => set(i, { tplName: e.target.value })}
                      aria-label={`Rule ${i + 1} template name`}
                    />
                  </label>
                )}
                {r.templateMode === 'id' && (
                  <label>
                    Id{' '}
                    <input
                      value={r.tplId}
                      onChange={(e) => set(i, { tplId: e.target.value })}
                      aria-label={`Rule ${i + 1} template id`}
                    />
                  </label>
                )}
              </div>
            </fieldset>
          ))}
          <div className="row">
            <button type="button" className="small" onClick={() => setRules([...rules, blankDraft()])}>
              Add a rule
            </button>
          </div>
        </div>
      )}
      <h3>Tag-definition source</h3>
      <p className="muted small-text">
        One page document holding exactly one <code>json</code> code block:{' '}
        <code>{'{ "schema": 1, "rules": [ { "id", "required_tags", "allowed_tags"? } ] }'}</code>. A rule’s id
        is an audit rule’s id. A missing, repeated or malformed block is a finding and the tag rules are
        skipped.
      </p>
      <p>
        {tag ? (
          <>
            Page: <strong>{tagPageName}</strong>{' '}
            <label>
              Document{' '}
              <select value={tag.documentId} onChange={(e) => setTag({ ...tag, documentId: e.target.value })}>
                <option value="">choose…</option>
                {docs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name ?? d.id}
                  </option>
                ))}
                {tag.documentId && !docs.some((d) => d.id === tag.documentId) && (
                  <option value={tag.documentId}>{tag.documentId}</option>
                )}
              </select>
            </label>{' '}
            <button type="button" className="small" onClick={() => setTag(null)}>
              No tag source
            </button>
          </>
        ) : (
          <span className="muted">No tag-definition source: the tag rules are off.</span>
        )}
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(search.trim());
        }}
      >
        <label htmlFor="audit-tag-q" className="offscreen">
          Find the page
        </label>
        <input
          id="audit-tag-q"
          placeholder="Find the page by name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="submit" className="small">
          Find
        </button>
      </form>
      {pages.data && pages.data.pages.length > 0 && (
        <ul className="plain" aria-label="Pages found">
          {pages.data.pages.map((p) => (
            <li key={p.pageId}>
              <button type="button" className="link" onClick={() => pick(p.pageId)}>
                {p.name ?? p.pageId}
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3>Settings</h3>
      <div className="stack">
        <label>
          <input
            type="checkbox"
            checked={settings.reportUnmatched}
            onChange={(e) => setSettings({ ...settings, reportUnmatched: e.target.checked })}
          />{' '}
          Report pages no rule matches
        </label>
        <label>
          A full snapshot older than{' '}
          <input
            type="number"
            min={1}
            max={720}
            value={settings.maxSnapshotAgeHours}
            onChange={(e) => setSettings({ ...settings, maxSnapshotAgeHours: Number(e.target.value) })}
            style={{ width: '5em' }}
          />{' '}
          hours is flagged as stale
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.strictReferenceTypes}
            onChange={(e) => setSettings({ ...settings, strictReferenceTypes: e.target.checked })}
          />{' '}
          Flag every Reference Type the registry and the templates do not know (off: only ones that resemble a
          registry value)
        </label>
        <label>
          Reference Types that are fine (one per line)
          <textarea
            rows={3}
            value={settings.knownReferenceTypes.join('\n')}
            onChange={(e) => setSettings({ ...settings, knownReferenceTypes: lines(e.target.value) })}
          />
        </label>
        <label>
          Indexes in a manual order, left out of the ordering check (page ids, one per line)
          <textarea
            rows={2}
            value={settings.manualOrderIndexes.join('\n')}
            onChange={(e) => setSettings({ ...settings, manualOrderIndexes: lines(e.target.value) })}
          />
        </label>
        <label>
          External skills you use elsewhere, never reported by the governance check (one name per line; “Allow
          this name” on a finding adds one)
          <textarea
            rows={2}
            value={(settings.governanceAllowedNames ?? []).join('\n')}
            onChange={(e) => setSettings({ ...settings, governanceAllowedNames: lines(e.target.value) })}
          />
        </label>
      </div>
      <div className="row mt">
        <Button
          variant="primary"
          busy={busy}
          disabled={!project || (tag !== null && tag.documentId === '')}
          onClick={() =>
            save(
              {
                rules: useDefaults ? null : rules.map(ruleOf),
                tagSource: tag,
                settings,
              },
              'Saved.',
            )
          }
        >
          Save rules and settings
        </Button>
        {cfg.updatedAt && (
          <span className="muted small-text">
            Last saved {fmtTime(cfg.updatedAt)} by {cfg.updatedBy}
          </span>
        )}
      </div>
    </>
  );
}

const lines = (s: string): string[] =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

import { Badge, ErrorNote, Gauge, Loading, PageHeader, ProjectStatusBadge } from '../components';
import { fmtAgo, fmtInt } from '../format';
import { useNow } from '../hooks';
import { useLiveBudget, useProject, useProjectReloadOn, useScopedApi } from '../project';
import { Link } from '../router';
import type { Overview, ProjectStatusSummary } from '../types';

/** Every project whose status is not `active` (a refused key, a mismatched id, not checked yet, no key), with why. */
function ProjectsAttention({ projects }: { projects: ProjectStatusSummary[] }) {
  const attention = projects.filter((p) => p.status !== 'active');
  if (attention.length === 0) return null;
  return (
    <section className="card card-alert" aria-labelledby="attention-h">
      <h2 id="attention-h">
        {attention.length === 1 ? 'A project needs attention' : `${attention.length} projects need attention`}
      </h2>
      <ul className="plain">
        {attention.map((p) => (
          <li key={p.name} data-project={p.name}>
            <strong>{p.name}</strong> <ProjectStatusBadge status={p.status} />
            {p.isDefault && <> (the default project)</>}
            {p.reason && <div>{p.reason}</div>}
          </li>
        ))}
      </ul>
      <p className="small-text">
        A stopped project is not served until its key is fixed; the others carry on. The{' '}
        <Link to="/projects">Projects</Link> page shows each key and can check it again.
      </p>
    </section>
  );
}

export function OverviewPage() {
  const { selected } = useProject();
  const o = useScopedApi<Overview>('/overview');
  useProjectReloadOn(['job', 'controls', 'error', 'proposal', 'project'], o.reload, 600);
  const live = useLiveBudget();
  const now = useNow();

  if (o.error) return <ErrorNote error={o.error} onRetry={o.reload} />;
  if (!o.data) return <Loading />;
  const d = o.data;
  const budget = d.budget;
  const gauges = budget ? (live ? budget.gauges.map((g) => live.snapshot.tiers[g.tier]) : budget.gauges) : [];
  const queues = live?.snapshot.queues ?? budget?.queues;
  const perMinute = live?.writesPerMinute ?? d.writes.perMinute;
  const h = d.health;
  const own = d.controls.project;

  return (
    <>
      <PageHeader title="Overview" project={selected}>
        <button type="button" className="small" onClick={o.reload}>
          Refresh
        </button>
      </PageHeader>

      <ProjectsAttention projects={d.projects ?? []} />

      <div className="grid">
        <section className="card" aria-labelledby="health-h">
          <h2 id="health-h">Health</h2>
          <div className="stack">
            <div className="row">
              <span>LegendKeeper</span>
              {h.reachable === null ? (
                <Badge>not checked</Badge>
              ) : h.reachable ? (
                <Badge tone="ok">reachable</Badge>
              ) : (
                <Badge tone="bad">unreachable</Badge>
              )}
            </div>
            <div className="row">
              <span>Key role</span>
              <Badge tone={h.keyRole === 'ADMIN' ? 'ok' : h.keyRole === 'MEMBER' ? 'warn' : 'neutral'}>
                {h.keyRole}
              </Badge>
            </div>
            <div className="row">
              <span>Plan</span>
              <Badge tone={h.plan === 'ok' ? 'ok' : h.plan === 'unpaid' ? 'bad' : 'neutral'}>
                {h.plan === 'ok' ? 'paid plan' : h.plan === 'unpaid' ? 'paid plan needed' : 'unknown'}
              </Badge>
            </div>
            {h.projectName && <p className="muted small-text">Project: {h.projectName}</p>}
            {h.note && <p className="note note-warn small-text">{h.note}</p>}
            <p className="muted small-text">Checked {fmtAgo(h.checkedAt, now)}.</p>
          </div>
        </section>

        <section className="card" aria-labelledby="mode-h">
          <h2 id="mode-h">Writing</h2>
          <div className="stack">
            <div className="row">
              <span>Read-only mode</span>
              {d.controls.readOnly ? (
                <Badge tone="warn">on: nothing is written</Badge>
              ) : (
                <Badge tone="ok">off</Badge>
              )}
            </div>
            {own?.readOnly && (
              <p className="muted small-text">
                This project’s own read-only flag is on (<Link to="/projects">Projects</Link>).
              </p>
            )}
            {own && !own.available && (
              <p className="note note-warn small-text">
                This project is not served now: nothing is sent to it.
              </p>
            )}
            <div className="row">
              <span>Writes</span>
              {d.writes.state === 'running' && <Badge tone="ok">running</Badge>}
              {d.writes.state === 'paused' && <Badge tone="warn">paused</Badge>}
              {d.writes.state === 'draining' && <Badge tone="warn">draining</Badge>}
            </div>
            <div className="row">
              <span>Writes in the last minute</span>
              <strong>{fmtInt(perMinute)}</strong>
            </div>
            <p className="small-text">
              <Link to="/writers">Concurrent writers</Link> · <Link to="/settings">Settings</Link>
            </p>
          </div>
        </section>

        <section className="card" aria-labelledby="counts-h">
          <h2 id="counts-h">Activity</h2>
          <div className="row row-between">
            <div className="stat">
              <span className="stat-value">{d.activeJobs.total}</span>
              <span className="stat-label">
                <Link to="/jobs">active jobs</Link>
              </span>
            </div>
            <div className="stat">
              <span className="stat-value">
                {d.errorsLastHour.count}
                {d.errorsLastHour.capped ? '+' : ''}
              </span>
              <span className="stat-label">
                <Link to="/errors">errors in the last hour</Link>
              </span>
            </div>
            <div className="stat">
              <span className="stat-value">{d.pendingProposals}</span>
              <span className="stat-label">
                <Link to="/proposals">pending proposals</Link>
              </span>
            </div>
          </div>
          <p className="muted small-text">
            {d.activeJobs.running} running · {d.activeJobs.queued} queued · {d.activeJobs.waiting} waiting ·{' '}
            {d.activeJobs.paused} paused
            {d.activeJobs.uncertain > 0 && (
              <>
                {' '}
                · <Badge tone="bad">{d.activeJobs.uncertain} uncertain</Badge>
              </>
            )}
          </p>
        </section>
      </div>

      <section className="card mt" aria-labelledby="budget-h">
        <div className="row row-between">
          <h2 id="budget-h">Request budget</h2>
          <Link to="/budgets">All tiers</Link>
        </div>
        {budget && queues ? (
          <>
            <div className="grid">
              {gauges.map((g) => (
                <Gauge key={g.tier} tier={g} now={now} />
              ))}
            </div>
            <p className="muted small-text">
              Waiting for budget: interactive {queues.P1} · jobs {queues.P2} · maintenance {queues.P3} ·
              dashboard {queues.P0}
            </p>
          </>
        ) : (
          <p className="muted">
            No budget to show: this project’s key is not in use now, so nothing is sent to LegendKeeper for
            it.
          </p>
        )}
      </section>
    </>
  );
}

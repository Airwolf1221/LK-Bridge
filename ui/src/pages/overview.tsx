import { useState } from 'react';
import { Badge, ErrorNote, Gauge, Loading, PageHeader } from '../components';
import { fmtAgo, fmtInt } from '../format';
import { useApi, useNow, useReloadOn } from '../hooks';
import { Link } from '../router';
import { useStreamEvent } from '../stream';
import type { BudgetPayload, Overview } from '../types';

export function OverviewPage() {
  const o = useApi<Overview>('/overview');
  useReloadOn(['job', 'controls', 'error', 'proposal'], o.reload, 600);
  const [live, setLive] = useState<BudgetPayload | null>(null);
  useStreamEvent<BudgetPayload>('budget', setLive);
  const now = useNow();

  if (o.error) return <ErrorNote error={o.error} onRetry={o.reload} />;
  if (!o.data) return <Loading />;
  const d = o.data;
  const gauges = live ? d.budget.gauges.map((g) => live.snapshot.tiers[g.tier]) : d.budget.gauges;
  const queues = live?.snapshot.queues ?? d.budget.queues;
  const perMinute = live?.writesPerMinute ?? d.writes.perMinute;
  const h = d.health;

  return (
    <>
      <PageHeader title="Overview">
        <button type="button" className="small" onClick={o.reload}>
          Refresh
        </button>
      </PageHeader>

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
        <div className="grid">
          {gauges.map((g) => (
            <Gauge key={g.tier} tier={g} now={now} />
          ))}
        </div>
        <p className="muted small-text">
          Waiting for budget: interactive {queues.P1} · jobs {queues.P2} · maintenance {queues.P3} · dashboard{' '}
          {queues.P0}
        </p>
      </section>
    </>
  );
}

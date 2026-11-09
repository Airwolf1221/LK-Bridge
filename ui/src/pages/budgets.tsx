import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import {
  Badge,
  Button,
  Empty,
  ErrorNote,
  Gauge,
  Loading,
  PageHeader,
  ProjectStatusBadge,
  Sparkline,
  useAction,
  useConfirm,
} from '../components';
import { TIER_LABELS, fmtInt } from '../format';
import { useApi, useNow } from '../hooks';
import { useLiveBudget, useLiveBudgets, useProject, useScopedApi } from '../project';
import { useRoute } from '../router';
import type { BudgetSamples, BudgetsAllResponse, BudgetsResponse, PriorityClass, TierId } from '../types';

const QUEUE_LABELS: Record<PriorityClass, string> = {
  P0: 'P0 · dashboard',
  P1: 'P1 · interactive (agents)',
  P2: 'P2 · jobs',
  P3: 'P3 · maintenance',
};

/** The 24 hour history changes slowly (one point per bucket): refresh it every minute. */
function useMinuteRefresh(reload: () => void): void {
  useEffect(() => {
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
  }, [reload]);
}

const seriesOf = (samples: BudgetSamples, tier: TierId) =>
  samples.points.map((p) => p.tiers[tier]?.used ?? 0);

/** One project's budgets (each project has its own key, so its own tiers), or every project side by side. */
export function BudgetsPage() {
  const { query, navigate } = useRoute();
  const { selected } = useProject();
  const all = query.get('view') === 'all';
  const toggle = (
    <div className="tabs" role="group" aria-label="Which budgets">
      <button type="button" aria-pressed={!all} onClick={() => navigate('/budgets', { replace: true })}>
        {selected ? `This project (${selected})` : 'This project'}
      </button>
      <button
        type="button"
        aria-pressed={all}
        onClick={() => navigate('/budgets?view=all', { replace: true })}
      >
        All projects
      </button>
    </div>
  );
  return all ? <AllBudgets toggle={toggle} /> : <ProjectBudgets toggle={toggle} />;
}

function ProjectBudgets({ toggle }: { toggle: ReactNode }) {
  const { selected } = useProject();
  const b = useScopedApi<BudgetsResponse>('/budgets');
  const live = useLiveBudget();
  const now = useNow();
  useMinuteRefresh(b.reload);

  if (b.error) {
    return (
      <>
        <PageHeader title="Request Budgets" project={selected} />
        {toggle}
        <ErrorNote error={b.error} onRetry={b.reload} />
      </>
    );
  }
  if (!b.data) return <Loading />;
  const snap = live?.snapshot ?? b.data.snapshot;
  const series = (tier: TierId) => seriesOf(b.data!.samples, tier);
  const project = snap.tiers['project-hour'];
  const drift = project.drift;

  return (
    <>
      <PageHeader title="Request Budgets" project={selected}>
        <span className="muted small-text">
          Live · {b.data.samples.count} samples in the last 24 hours (one every 10 seconds)
        </span>
      </PageHeader>
      {toggle}

      <div className="grid">
        {b.data.tierOrder.map((t) => {
          const tier = snap.tiers[t];
          return (
            <section key={t} className="card" aria-label={TIER_LABELS[t] ?? t}>
              <Gauge tier={tier} now={now} />
              {!tier.reactiveOnly && (
                <div>
                  <Sparkline
                    values={series(t)}
                    max={tier.limit ?? 1}
                    label={`${TIER_LABELS[t] ?? t}: usage over the last 24 hours`}
                  />
                  <span className="muted small-text">
                    {series(t).length < 2
                      ? 'Collecting history: a sample is stored every 10 seconds.'
                      : 'Last 24 hours (busiest value per bucket)'}
                  </span>
                </div>
              )}
            </section>
          );
        })}
      </div>

      <section className="card mt" aria-labelledby="drift-h">
        <h2 id="drift-h">Project tier: observed against modelled</h2>
        {drift ? (
          <>
            <div className="row">
              <div className="stat">
                <span className="stat-value">{fmtInt(drift.observedUsed)}</span>
                <span className="stat-label">observed by LegendKeeper</span>
              </div>
              <div className="stat">
                <span className="stat-value">{fmtInt(drift.modelledUsed)}</span>
                <span className="stat-label">counted by the bridge</span>
              </div>
              <div className="stat">
                <span className="stat-value">
                  {drift.delta > 0 ? '+' : ''}
                  {fmtInt(drift.delta)}
                </span>
                <span className="stat-label">difference</span>
              </div>
            </div>
            <p className="muted small-text">
              The project tier is shared by every key on the project, so the bridge can under-count. When the
              two differ, LegendKeeper’s figure wins. A large positive difference means another client is
              using the budget.
            </p>
          </>
        ) : (
          <p className="muted">
            No server reading for this tier yet. It appears after LegendKeeper reports it.
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="queue-h">
        <h2 id="queue-h">Waiting for budget</h2>
        <div className="row">
          {(['P0', 'P1', 'P2', 'P3'] as const).map((c) => (
            <div key={c} className="stat">
              <span className="stat-value">{snap.queues[c]}</span>
              <span className="stat-label">{QUEUE_LABELS[c]}</span>
            </div>
          ))}
        </div>
        <p className="muted small-text">
          {snap.inFlight} request{snap.inFlight === 1 ? '' : 's'} in flight · writes are spaced at least{' '}
          {snap.writeSpacingMs} ms apart.
        </p>
      </section>

      <FloorsCard data={b.data} onSaved={b.reload} />
    </>
  );
}

/** Every project with a governor, side by side: one card each, with its gauges and its 24 hour write history. */
function AllBudgets({ toggle }: { toggle: ReactNode }) {
  const b = useApi<BudgetsAllResponse>('/budgets/all');
  const live = useLiveBudgets();
  const { selected } = useProject();
  const now = useNow();
  useMinuteRefresh(b.reload);

  return (
    <>
      <PageHeader title="Request Budgets">
        <span className="muted small-text">Every project, side by side · live</span>
      </PageHeader>
      {toggle}
      <p className="muted">
        Each project has its own key, so its own budget: one project’s work never spends another’s.
      </p>
      <ErrorNote error={b.error} onRetry={b.reload} />
      {!b.data ? (
        !b.error && <Loading />
      ) : b.data.projects.length === 0 ? (
        <Empty>No project’s key is in use now, so there is no budget to show.</Empty>
      ) : (
        <div className="grid">
          {b.data.projects.map((p, i) => {
            const current = live?.[p.project.id];
            const snap = current?.snapshot ?? p.snapshot;
            const perMinute = current?.writesPerMinute ?? p.writesPerMinute;
            const writes = seriesOf(p.samples, 'write-min');
            const drift = snap.tiers['project-hour']?.drift ?? p.projectDrift;
            return (
              <section
                key={p.project.id}
                className="card"
                aria-labelledby={`budget-project-${i}`}
                data-project={p.project.name}
              >
                <div className="row row-between">
                  <h2 id={`budget-project-${i}`}>{p.project.name}</h2>
                  <span className="row">
                    {p.project.name === selected && <Badge tone="info">selected</Badge>}
                    <ProjectStatusBadge status={p.status} />
                  </span>
                </div>
                <p className="muted small-text">
                  {fmtInt(perMinute)} write{perMinute === 1 ? '' : 's'} in the last minute · waiting for
                  budget: interactive {snap.queues.P1} · jobs {snap.queues.P2} · maintenance {snap.queues.P3}
                </p>
                <div className="stack">
                  {b.data!.tierOrder.map((t) =>
                    snap.tiers[t] ? <Gauge key={t} tier={snap.tiers[t]} now={now} compact /> : null,
                  )}
                </div>
                <div className="mt">
                  <Sparkline
                    values={writes}
                    max={snap.tiers['write-min']?.limit ?? 1}
                    label={`${p.project.name}: writes per minute over the last 24 hours`}
                  />
                  <span className="muted small-text">
                    {writes.length < 2 ? 'Collecting history.' : 'Writes per minute, last 24 hours'}
                  </span>
                </div>
                {drift && (
                  <p className="muted small-text">
                    Project tier: {fmtInt(drift.observedUsed)} observed by LegendKeeper,{' '}
                    {fmtInt(drift.modelledUsed)} counted by the bridge.
                  </p>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

function FloorsCard({ data, onSaved }: { data: BudgetsResponse; onSaved: () => void }) {
  const cur = data.reserveFloors.current;
  const toPct = (f: number) => String(Math.round(f * 1000) / 10);
  const [vals, setVals] = useState({
    interactive: toPct(cur.interactive),
    job: toPct(cur.job),
    maintenance: toPct(cur.maintenance),
  });
  useEffect(
    () =>
      setVals({
        interactive: toPct(cur.interactive),
        job: toPct(cur.job),
        maintenance: toPct(cur.maintenance),
      }),
    [cur.interactive, cur.job, cur.maintenance],
  );
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const n = {
    interactive: Number(vals.interactive) / 100,
    job: Number(vals.job) / 100,
    maintenance: Number(vals.maintenance) / 100,
  };
  const valid =
    Object.values(n).every((v) => Number.isFinite(v) && v >= 0 && v <= 1) &&
    n.interactive <= n.job &&
    n.job <= n.maintenance;
  const changed = n.interactive !== cur.interactive || n.job !== cur.job || n.maintenance !== cur.maintenance;
  const field = (key: keyof typeof vals, label: string, hint: string) => (
    <div>
      <label htmlFor={`floor-${key}`}>{label}</label>
      <input
        id={`floor-${key}`}
        inputMode="decimal"
        size={5}
        value={vals[key]}
        onChange={(e) => setVals({ ...vals, [key]: e.target.value })}
        aria-describedby={`floor-${key}-hint`}
      />
      <span id={`floor-${key}-hint`} className="muted small-text">
        {' '}
        % {hint}
      </span>
    </div>
  );
  return (
    <section className="card" aria-labelledby="floors-h">
      <h2 id="floors-h">Reserve floors</h2>
      <p className="muted small-text">
        The share of each tier a class must leave untouched, so agents stay responsive while a big job runs.
        Changes apply to the next request. Dashboard actions (P0) always have the whole budget.
        {data.reserveFloors.stored ? ' Saved in the dashboard.' : ' Using the environment’s values.'}
      </p>
      <div className="field-row">
        {field('interactive', 'Interactive (P1)', 'kept free')}
        {field('job', 'Jobs (P2)', 'kept free')}
        {field('maintenance', 'Maintenance (P3)', 'kept free')}
      </div>
      {!valid && (
        <p className="note note-bad" role="alert">
          Each value must be between 0 and 100, and interactive ≤ jobs ≤ maintenance.
        </p>
      )}
      <div className="row mt">
        <Button
          variant="primary"
          busy={busy}
          disabled={!valid || !changed}
          onClick={() => {
            void confirm({
              title: 'Change the reserve floors?',
              message: (
                <p>
                  Interactive {vals.interactive}%, jobs {vals.job}%, maintenance {vals.maintenance}%. Lower
                  floors let jobs use more of the budget and leave agents less headroom.
                </p>
              ),
              confirmLabel: 'Save floors',
            }).then((ok) => {
              if (ok)
                void run(
                  () => api.put('/budgets/reserve-floors', { ...n, confirm: true }),
                  'Reserve floors saved.',
                ).then(onSaved);
            });
          }}
        >
          Save floors
        </Button>
        {data.reserveFloors.stored && (
          <Button
            busy={busy}
            onClick={() => {
              void confirm({
                title: 'Go back to the environment’s floors?',
                message: (
                  <p>
                    Interactive {toPct(data.reserveFloors.environment.interactive)}%, jobs{' '}
                    {toPct(data.reserveFloors.environment.job)}%, maintenance{' '}
                    {toPct(data.reserveFloors.environment.maintenance)}%.
                  </p>
                ),
                confirmLabel: 'Reset',
              }).then((ok) => {
                if (ok)
                  void run(
                    () => api.put('/budgets/reserve-floors', { reset: true, confirm: true }),
                    'Reserve floors reset.',
                  ).then(onSaved);
              });
            }}
          >
            Reset to the environment’s values
          </Button>
        )}
        {changed && valid && <Badge tone="warn">unsaved</Badge>}
      </div>
    </section>
  );
}

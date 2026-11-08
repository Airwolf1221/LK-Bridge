import { useEffect, useState } from 'react';
import { api } from '../api';
import {
  Badge,
  Button,
  ErrorNote,
  Gauge,
  Loading,
  PageHeader,
  Sparkline,
  useAction,
  useConfirm,
} from '../components';
import { TIER_LABELS, fmtInt } from '../format';
import { useApi, useNow } from '../hooks';
import { useStreamEvent } from '../stream';
import type { BudgetPayload, BudgetsResponse, PriorityClass, TierId } from '../types';

const QUEUE_LABELS: Record<PriorityClass, string> = {
  P0: 'P0 · dashboard',
  P1: 'P1 · interactive (agents)',
  P2: 'P2 · jobs',
  P3: 'P3 · maintenance',
};

export function BudgetsPage() {
  const b = useApi<BudgetsResponse>('/budgets');
  const { reload } = b;
  const [live, setLive] = useState<BudgetPayload | null>(null);
  useStreamEvent<BudgetPayload>('budget', setLive);
  const now = useNow();
  // The 24 hour history changes slowly (one point per bucket): refresh it every minute.
  useEffect(() => {
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
  }, [reload]);

  if (b.error) return <ErrorNote error={b.error} onRetry={b.reload} />;
  if (!b.data) return <Loading />;
  const snap = live?.snapshot ?? b.data.snapshot;
  const series = (tier: TierId) => b.data!.samples.points.map((p) => p.tiers[tier]?.used ?? 0);
  const project = snap.tiers['project-hour'];
  const drift = project.drift;

  return (
    <>
      <PageHeader title="Request Budgets">
        <span className="muted small-text">
          Live · {b.data.samples.count} samples in the last 24 hours (one every 10 seconds)
        </span>
      </PageHeader>

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

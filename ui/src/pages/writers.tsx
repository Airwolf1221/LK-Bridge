import { useEffect, useState } from 'react';
import { api } from '../api';
import {
  Badge,
  Button,
  Empty,
  ErrorNote,
  Loading,
  PageHeader,
  StatusBadge,
  useAction,
  useConfirm,
} from '../components';
import { fmtDuration, fmtInt, shortId } from '../format';
import { useApi, useNow, useReloadOn } from '../hooks';
import { Link } from '../router';
import { useStreamEvent } from '../stream';
import type { BudgetPayload, Controls, WritersResponse } from '../types';

export function WritersPage() {
  const w = useApi<WritersResponse>('/writers');
  useReloadOn(['writers', 'lock', 'controls', 'job'], w.reload, 150);
  const [live, setLive] = useState<BudgetPayload | null>(null);
  useStreamEvent<BudgetPayload>('budget', setLive);
  const now = useNow();
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [max, setMax] = useState<string>('');
  const serverMax = w.data?.writers.max;
  useEffect(() => {
    if (serverMax !== undefined) setMax(String(serverMax));
  }, [serverMax]);

  if (w.error) return <ErrorNote error={w.error} onRetry={w.reload} />;
  if (!w.data) return <Loading />;
  const d = w.data;
  const c: Controls = d.controls;
  const rate = live?.writesPerMinute ?? d.writesPerMinute;
  const limit = live?.snapshot.tiers['write-min'].limit ?? d.writeMinuteLimit;
  const title = (jobId: string) => d.jobs[jobId]?.title ?? shortId(jobId, 12);
  const jobLink = (jobId: string) => <Link to={`/jobs/${encodeURIComponent(jobId)}`}>{title(jobId)}</Link>;

  return (
    <>
      <PageHeader title="Concurrent Writers">
        <span className="row">
          <Badge tone={c.draining ? 'warn' : c.writesPaused ? 'warn' : 'ok'}>
            {c.draining ? 'draining' : c.writesPaused ? 'writes paused' : 'writes running'}
          </Badge>
          {c.readOnly && <Badge tone="warn">read-only mode</Badge>}
        </span>
      </PageHeader>

      <div className="grid">
        <section className="card" aria-labelledby="rate-h">
          <h2 id="rate-h">Writes per minute</h2>
          <div className="stat">
            <span className="stat-value" data-testid="writes-per-minute">
              {fmtInt(rate)}
            </span>
            <span className="stat-label">
              of {fmtInt(limit)} allowed per minute · spacing {d.writeSpacingMs} ms
            </span>
          </div>
        </section>

        <section className="card" aria-labelledby="max-h">
          <h2 id="max-h">WRITERS_MAX</h2>
          <div className="row">
            <label className="inline" htmlFor="writers-max">
              Writer slots
            </label>
            <select id="writers-max" value={max} onChange={(e) => setMax(e.target.value)}>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <Button
              variant="primary"
              busy={busy}
              disabled={Number(max) === d.writers.max}
              onClick={() =>
                void run(
                  () => api.put('/writers/max', { value: Number(max) }),
                  `Writer slots set to ${max}. In effect now.`,
                ).then(w.reload)
              }
            >
              Apply
            </Button>
          </div>
          <p className="muted small-text">
            Takes effect straight away, with no restart. More than two or three parallel writers add
            contention, not throughput (LegendKeeper allows 120 writes a minute).
          </p>
        </section>

        <section className="card" aria-labelledby="ctl-h">
          <h2 id="ctl-h">Controls</h2>
          <div className="row">
            {c.writesPaused ? (
              <Button
                variant="primary"
                busy={busy}
                onClick={() => void run(() => api.post('/writes/resume'), 'Writes resumed.').then(w.reload)}
              >
                Resume writes
              </Button>
            ) : (
              <Button
                variant="danger"
                busy={busy}
                onClick={() => {
                  void confirm({
                    title: 'Pause all writes?',
                    message: (
                      <p>Steps in flight finish. Nothing new starts until you resume. Reads carry on.</p>
                    ),
                    confirmLabel: 'Pause all writes',
                    danger: true,
                  }).then((ok) => {
                    if (ok) void run(() => api.post('/writes/pause'), 'Writes paused.').then(w.reload);
                  });
                }}
              >
                Pause all writes
              </Button>
            )}
            {c.draining ? (
              <Button
                busy={busy}
                onClick={() =>
                  void run(() => api.post('/writes/undrain'), 'Accepting new jobs again.').then(w.reload)
                }
              >
                Stop draining
              </Button>
            ) : (
              <Button
                busy={busy}
                onClick={() => {
                  void confirm({
                    title: 'Drain the bridge?',
                    message: (
                      <p>
                        Running jobs finish and no new job is accepted. Use it before a deploy. It does not
                        survive a restart.
                      </p>
                    ),
                    confirmLabel: 'Start draining',
                  }).then((ok) => {
                    if (ok)
                      void run(() => api.post('/writes/drain'), 'Draining: running jobs will finish.').then(
                        w.reload,
                      );
                  });
                }}
              >
                Drain
              </Button>
            )}
          </div>
        </section>
      </div>

      <section className="card mt" aria-labelledby="slots-h">
        <h2 id="slots-h">
          Slots ({d.writers.busy} of {d.writers.max} busy)
        </h2>
        <div className="slots">
          {d.writers.slots.map((s) => (
            <div
              key={s.slot}
              className={`slot ${s.state === 'busy' ? 'slot-busy' : ''}`}
              data-slot={s.slot}
              data-state={s.state}
            >
              <h3>Slot {s.slot}</h3>
              {s.state === 'idle' ? (
                <p className="muted">Idle</p>
              ) : (
                <dl className="meta">
                  <div>
                    <dt>Job</dt>
                    <dd>{s.jobId ? jobLink(s.jobId) : '–'}</dd>
                  </div>
                  <div>
                    <dt>Operation</dt>
                    <dd className="mono">{s.opId}</dd>
                  </div>
                  <div>
                    <dt>Document</dt>
                    <dd className="mono">{s.documentId ?? s.resourceId ?? '–'}</dd>
                  </div>
                  <div>
                    <dt>Principal</dt>
                    <dd>{s.profile}</dd>
                  </div>
                  {s.since && (
                    <div>
                      <dt>Busy for</dt>
                      <dd>{fmtDuration(now - s.since)}</dd>
                    </div>
                  )}
                </dl>
              )}
            </div>
          ))}
        </div>
        {d.writers.waiting.length > 0 && (
          <>
            <h3>Waiting for a slot</h3>
            <ol>
              {d.writers.waiting.map((x) => (
                <li key={`${x.jobId}:${x.stepNo}`}>
                  {jobLink(x.jobId)} · step {x.stepNo} · <span className="mono">{x.opId}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="locks-h">
        <h2 id="locks-h">Held locks and wait queues</h2>
        {d.locks.length === 0 ? (
          <Empty>No document or resource is locked.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Lock</th>
                  <th>Held by</th>
                  <th>Waiting, in order</th>
                </tr>
              </thead>
              <tbody>
                {d.locks.map((l) => (
                  <tr key={l.key}>
                    <td className="mono">{l.key}</td>
                    <td>
                      {jobLink(l.holder.jobId)} · step {l.holder.stepNo}
                      <div className="muted small-text">for {fmtDuration(now - l.holder.since)}</div>
                    </td>
                    <td>
                      {l.waiting.length === 0 ? (
                        <span className="muted">nobody</span>
                      ) : (
                        <ol>
                          {l.waiting.map((x) => (
                            <li key={`${x.jobId}:${x.stepNo}`}>
                              {jobLink(x.jobId)} · step {x.stepNo}{' '}
                              {d.jobs[x.jobId] && <StatusBadge status={d.jobs[x.jobId]!.status} />}
                            </li>
                          ))}
                        </ol>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

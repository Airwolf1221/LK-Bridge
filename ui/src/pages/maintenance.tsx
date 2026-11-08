import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, StatusBadge, useAction } from '../components';
import { fmtAgo, fmtDuration, fmtTime } from '../format';
import { useApi, useNow, useReloadOn } from '../hooks';
import { Link } from '../router';

/** Maintenance Jobs (PLAN §8 page 6, docs/maintenance.md): the registry, toggles, schedule editing and Run now. */

export type Schedule = { kind: 'interval'; everySeconds: number } | { kind: 'daily'; time: string };

export interface MaintenanceRun {
  at: number;
  outcome: 'succeeded' | 'failed' | 'skipped' | 'interrupted';
  durationMs: number;
  jobId: string | null;
  detail: string | null;
}

export interface MaintenanceJob {
  id: string;
  name: string;
  description: string;
  implemented: boolean;
  writes: boolean;
  enabled: boolean;
  schedule: Schedule;
  scheduleText: string;
  defaultSchedule: Schedule;
  scheduleOverridden: boolean;
  priority: 'P3';
  running: boolean;
  lastRun: MaintenanceRun | null;
  nextRunAt: number | null;
  note: string | null;
}

interface ListResponse {
  jobs: MaintenanceJob[];
  schedulerEnabled: boolean;
  now: number;
}

interface HistoryRow {
  id: number;
  trigger: string;
  startedAt: number;
  outcome: MaintenanceRun['outcome'];
  durationMs: number;
  engineJobId: string | null;
  detail: string | null;
}

const OUTCOME_TONE = { succeeded: 'ok', failed: 'bad', skipped: 'warn', interrupted: 'warn' } as const;

const UNITS = [
  { label: 'seconds', secs: 1 },
  { label: 'minutes', secs: 60 },
  { label: 'hours', secs: 3600 },
  { label: 'days', secs: 86_400 },
] as const;

export function MaintenancePage() {
  const list = useApi<ListResponse>('/maintenance');
  // Owner changes arrive as `policy` events; maintenance runs that left a job record arrive as `job` events. Runs
  // that leave none (the 10-second sampler) are picked up by the refresh below.
  useReloadOn(['policy', 'job'], list.reload, 400);
  useEffect(() => {
    const t = setInterval(list.reload, 15_000);
    return () => clearInterval(t);
  }, [list.reload]);
  const now = useNow();
  const [editing, setEditing] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);

  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const { jobs, schedulerEnabled } = list.data;

  return (
    <>
      <PageHeader title="Maintenance Jobs">
        <Button onClick={list.reload}>Refresh</Button>
      </PageHeader>
      <p className="muted">
        Scheduled housekeeping. Every run is queued at priority <strong>P3</strong>, so it keeps to the
        governor’s maintenance floor and waits while interactive or job work is queued. A job that writes to
        LegendKeeper is skipped, and the skip recorded, while read-only mode is on or writes are paused.
      </p>
      {!schedulerEnabled && (
        <div className="note note-warn" role="status">
          The scheduler is switched off (<span className="mono">MAINTENANCE_ENABLED=false</span>). Nothing
          runs by itself; <em>Run now</em> still works.
        </div>
      )}
      <section className="card" aria-label="Maintenance jobs">
        {jobs.length === 0 ? (
          <Empty>No maintenance jobs are registered.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th>Schedule</th>
                  <th>Class</th>
                  <th>Last run</th>
                  <th>Next run</th>
                  <th>Enabled</th>
                  <th>
                    <span className="offscreen">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <JobRows
                    key={j.id}
                    job={j}
                    now={now}
                    editing={editing === j.id}
                    historyOpen={history === j.id}
                    onEdit={(on) => setEditing(on ? j.id : null)}
                    onHistory={(on) => setHistory(on ? j.id : null)}
                    onChanged={list.reload}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function statusOf(j: MaintenanceJob) {
  if (!j.implemented) return <Badge>Not implemented</Badge>;
  if (j.running) return <StatusBadge status="running" />;
  return j.enabled ? <Badge tone="ok">Enabled</Badge> : <Badge>Disabled</Badge>;
}

function JobRows({
  job: j,
  now,
  editing,
  historyOpen,
  onEdit,
  onHistory,
  onChanged,
}: {
  job: MaintenanceJob;
  now: number;
  editing: boolean;
  historyOpen: boolean;
  onEdit: (on: boolean) => void;
  onHistory: (on: boolean) => void;
  onChanged: () => void;
}) {
  const { run, busy } = useAction();
  const toggleId = `toggle-${j.id}`;
  return (
    <>
      <tr data-job={j.id}>
        <td>
          <strong>{j.name}</strong>
          <div className="muted small-text">{j.description}</div>
          {j.writes && <div className="muted small-text">Writes to LegendKeeper.</div>}
        </td>
        <td>{statusOf(j)}</td>
        <td>
          {j.implemented ? (
            <>
              {j.scheduleText}
              {j.scheduleOverridden && <div className="muted small-text">edited</div>}
            </>
          ) : (
            <span className="muted">–</span>
          )}
        </td>
        <td>{j.priority}</td>
        <td>
          <LastRun run={j.lastRun} now={now} />
        </td>
        <td>
          {j.nextRunAt !== null ? (
            <>
              {fmtTime(j.nextRunAt)}
              <div className="muted small-text">in {fmtDuration(Math.max(0, j.nextRunAt - now))}</div>
            </>
          ) : (
            <span className="muted">–</span>
          )}
        </td>
        <td>
          <label className="row" htmlFor={toggleId}>
            <input
              id={toggleId}
              type="checkbox"
              role="switch"
              checked={j.enabled}
              disabled={busy || !j.implemented}
              aria-describedby={j.implemented ? undefined : `${toggleId}-why`}
              onChange={(e) =>
                void run(
                  () => api.post(`/maintenance/${j.id}/${e.target.checked ? 'enable' : 'disable'}`),
                  `${j.name} ${e.target.checked ? 'enabled' : 'disabled'}.`,
                ).then(onChanged)
              }
            />
            <span className="offscreen">Enable {j.name}</span>
          </label>
          {!j.implemented && (
            <div id={`${toggleId}-why`} className="muted small-text">
              Not implemented yet
            </div>
          )}
        </td>
        <td>
          <div className="row">
            <Button
              className="small"
              disabled={!j.implemented || j.running}
              busy={busy}
              aria-label={`Run ${j.name} now`}
              onClick={() =>
                void run(() => api.post(`/maintenance/${j.id}/run`), `${j.name} started.`).then(onChanged)
              }
            >
              Run now
            </Button>
            <Button
              className="small"
              disabled={!j.implemented}
              aria-label={`Edit the schedule of ${j.name}`}
              aria-expanded={editing}
              onClick={() => onEdit(!editing)}
            >
              Schedule
            </Button>
            <Button
              className="small"
              disabled={!j.implemented}
              aria-label={`Show the history of ${j.name}`}
              aria-expanded={historyOpen}
              onClick={() => onHistory(!historyOpen)}
            >
              History
            </Button>
          </div>
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={8}>
            <ScheduleEditor
              job={j}
              onDone={() => {
                onEdit(false);
                onChanged();
              }}
            />
          </td>
        </tr>
      )}
      {historyOpen && (
        <tr>
          <td colSpan={8}>
            <History id={j.id} name={j.name} now={now} />
          </td>
        </tr>
      )}
    </>
  );
}

function LastRun({ run, now }: { run: MaintenanceRun | null; now: number }) {
  if (!run) return <span className="muted">never</span>;
  return (
    <>
      <Badge tone={OUTCOME_TONE[run.outcome]}>{run.outcome}</Badge> {fmtAgo(run.at, now)}
      <div className="muted small-text">
        {fmtDuration(run.durationMs)}
        {run.jobId && (
          <>
            {' · '}
            <Link to={`/jobs/${run.jobId}`}>job</Link>
          </>
        )}
      </div>
      {run.detail && <div className="muted small-text">{run.detail}</div>}
    </>
  );
}

function unitFor(secs: number): { value: number; secs: number } {
  const u = [...UNITS].reverse().find((x) => secs % x.secs === 0) ?? UNITS[0];
  return { value: secs / u.secs, secs: u.secs };
}

function ScheduleEditor({ job: j, onDone }: { job: MaintenanceJob; onDone: () => void }) {
  const { run, busy } = useAction();
  const start = j.schedule.kind === 'interval' ? unitFor(j.schedule.everySeconds) : { value: 5, secs: 60 };
  const [kind, setKind] = useState<Schedule['kind']>(j.schedule.kind);
  const [value, setValue] = useState(String(start.value));
  const [unit, setUnit] = useState(start.secs);
  const [time, setTime] = useState(j.schedule.kind === 'daily' ? j.schedule.time : '03:30');
  const n = Number(value);
  const intervalOk = Number.isInteger(n) && n * unit >= 10 && n * unit <= 31 * 86_400;
  const schedule: Schedule = kind === 'interval' ? { kind, everySeconds: n * unit } : { kind, time };
  const valid = kind === 'interval' ? intervalOk : /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const save = (s: Schedule | null) =>
    run(() => api.put(`/maintenance/${j.id}/schedule`, { schedule: s }), `Schedule of ${j.name} saved.`).then(
      (r) => r && onDone(),
    );

  return (
    <form
      aria-label={`Schedule of ${j.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void save(schedule);
      }}
    >
      <fieldset>
        <legend>Schedule for {j.name}</legend>
        <div className="field-row">
          <div>
            <label htmlFor={`kind-${j.id}`}>Runs</label>
            <select
              id={`kind-${j.id}`}
              value={kind}
              onChange={(e) => setKind(e.target.value as Schedule['kind'])}
            >
              <option value="interval">at a fixed interval</option>
              <option value="daily">once a day, at a time</option>
            </select>
          </div>
          {kind === 'interval' ? (
            <>
              <div>
                <label htmlFor={`every-${j.id}`}>Every</label>
                <input
                  id={`every-${j.id}`}
                  type="number"
                  min={1}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor={`unit-${j.id}`}>Unit</label>
                <select id={`unit-${j.id}`} value={unit} onChange={(e) => setUnit(Number(e.target.value))}>
                  {UNITS.map((u) => (
                    <option key={u.label} value={u.secs}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <div>
              <label htmlFor={`time-${j.id}`}>Time (London, 24-hour)</label>
              <input id={`time-${j.id}`} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          )}
          <Button variant="primary" busy={busy} disabled={!valid} type="submit">
            Save schedule
          </Button>
          <Button busy={busy} disabled={!j.scheduleOverridden} onClick={() => void save(null)}>
            Use the default
          </Button>
        </div>
        {!valid && (
          <p className="muted small-text" role="alert">
            {kind === 'interval'
              ? 'An interval is a whole number between 10 seconds and 31 days.'
              : 'Give the time as hours and minutes, such as 03:30.'}
          </p>
        )}
        <p className="muted small-text">
          Daily times follow the London clock, including the change to and from summer time. The next run is
          counted from now; a changed schedule never queues missed runs.
        </p>
      </fieldset>
    </form>
  );
}

function History({ id, name, now }: { id: string; name: string; now: number }) {
  const h = useApi<{ job: { history: HistoryRow[] } }>(`/maintenance/${id}`);
  if (h.error) return <ErrorNote error={h.error} onRetry={h.reload} />;
  if (!h.data) return <Loading />;
  const rows = h.data.job.history;
  return (
    <div aria-label={`History of ${name}`}>
      <h3>Recent runs of {name}</h3>
      {rows.length === 0 ? (
        <Empty>No runs yet.</Empty>
      ) : (
        <ul className="plain">
          {rows.map((r) => (
            <li key={r.id}>
              <Badge tone={OUTCOME_TONE[r.outcome]}>{r.outcome}</Badge> {fmtTime(r.startedAt)} (
              {fmtAgo(r.startedAt, now)}), {r.trigger}, {fmtDuration(r.durationMs)}
              {r.engineJobId && (
                <>
                  {' · '}
                  <Link to={`/jobs/${r.engineJobId}`}>job</Link>
                </>
              )}
              {r.detail && <div className="muted small-text">{r.detail}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

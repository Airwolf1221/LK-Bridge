import { useEffect, useState } from 'react';
import { api, background } from '../api';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, StatusBadge, useAction } from '../components';
import { fmtAgo, fmtDuration, fmtTime } from '../format';
import { useApi, useNow, useReloadOn } from '../hooks';
import { useReauth } from '../reauth';
import { useProject } from '../project';
import { Link } from '../router';

/** Maintenance Jobs (PLAN §8 page 6, docs/maintenance.md): the registry, toggles, schedule editing and Run now. */

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type Schedule =
  | { kind: 'interval'; everySeconds: number }
  | { kind: 'daily'; time: string }
  // v2 E1a: a day of the week and a time (the weekly full snapshot).
  | { kind: 'weekly'; day: Weekday; time: string };

const WEEKDAYS: [Weekday, string][] = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
];

export interface MaintenanceRun {
  at: number;
  outcome: 'succeeded' | 'failed' | 'skipped' | 'interrupted';
  durationMs: number;
  jobId: string | null;
  detail: string | null;
  /** v2 E5.1: whose run it was (a project's LegendKeeper id, or `*` for a bridge-wide run). */
  projectId?: string;
  trigger?: string;
}

/** v2 E5.1: one project's line of a per-project job. */
export interface MaintenanceProjectLine {
  projectId: string;
  project: string;
  running: boolean;
  lastRun: MaintenanceRun | null;
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
  priority: 'P3' | 'P4';
  running: boolean;
  lastRun: MaintenanceRun | null;
  nextRunAt: number | null;
  note: string | null;
  /** `project`: one run per served project (v2 A1). */
  scope?: 'project' | 'bridge';
  /** v2 E5.1: the project being run now (null when none, or bridge-wide). */
  runningProjectId?: string | null;
  /** v2 E5.1: a per-project job's state for each project. */
  projects?: MaintenanceProjectLine[];
}

interface ListResponse {
  jobs: MaintenanceJob[];
  schedulerEnabled: boolean;
  now: number;
}

interface HistoryRow {
  id: number;
  projectId: string;
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
    // CR-2026-11-R4: the page's own refresh, not the owner's use of the session.
    const t = setInterval(background(list.reload), 15_000);
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
        governor’s maintenance floor and waits while interactive or job work is queued; the whole-repository
        passes (the full snapshot, the tree and asset checks, the link sweep) at <strong>P4</strong> (bulk),
        with their own floor, after routine maintenance. A job that writes to LegendKeeper is skipped, and the
        skip recorded, while read-only mode is on or writes are paused.
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
      {jobs.some((j) => j.id === SWEEP_ID && j.implemented) && (
        <BlockIdSweepCard job={jobs.find((j) => j.id === SWEEP_ID)!} now={now} onChanged={list.reload} />
      )}
    </>
  );
}

// ------------------------------------------------------------------------------ v3 F3.5: the block-id sweep's card

const SWEEP_ID = 'assign-block-ids-sweep';

interface SweepCheck {
  bridgeVersion: string;
  project: string;
  verdict: 'PASS' | 'NOTED' | 'FAIL';
  detail: string | null;
  at: number;
}

interface SweepPrerequisite {
  ok: boolean;
  reason: string | null;
  version: string;
  pass: SweepCheck | null;
  override: { at: number; by: string } | null;
  recent: SweepCheck[];
}

interface SweepStop {
  projectId: string;
  project: string;
  resourceId: string;
  documentId: string;
  page: string | null;
  jobId: string | null;
  journalId: number | null;
  reason: string;
  differences: { path: string; expected: unknown; actual: unknown }[];
  at: number;
  acknowledgedAt: number | null;
}

interface SweepProject {
  project: string;
  projectId: string;
  snapshot: { id: string; takenAt: number } | null;
  candidates: number;
  remaining: number;
  unreadable: number;
  counts: Record<'done' | 'already' | 'moved' | 'unverified' | 'failed' | 'gone' | 'error', number>;
}

interface SweepCardData {
  statement: { key: string; title: string; text: string }[];
  prerequisite: SweepPrerequisite;
  maxPerRun: number;
  stop: SweepStop | null;
  projects: SweepProject[];
}

interface DryRunDoc {
  resourceId: string;
  documentId: string;
  page: string;
  path: string;
  document: string | null;
  blocks: number;
  missing: number;
  duplicates: number;
  unsupported: number;
  why: 'unverified' | 'candidate';
  retry: boolean;
}

interface DryRunData {
  project: string;
  candidates: number;
  remaining: number;
  maxPerRun: number;
  next: DryRunDoc[];
  estimate: {
    reads: number;
    writes: number;
    wallClockMs: number | null;
    tightestTier: string | null;
    fitsToday: boolean | null;
    note: string;
  };
  prerequisite: SweepPrerequisite;
  stopped: boolean;
}

const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/**
 * The block-id sweep (ADR 0056): its approved-automation statement, word for word, so that enabling the job is the
 * owner's informed approval; prerequisite 2 and the override; the candidates per project from the latest snapshot; the
 * most documents a run does; a dry run; and a stop after a verification failure, in red, with the journal entry.
 */
function BlockIdSweepCard({
  job,
  now,
  onChanged,
}: {
  job: MaintenanceJob;
  now: number;
  onChanged: () => void;
}) {
  const card = useApi<{ card: SweepCardData }>(`/maintenance/${SWEEP_ID}/card`);
  useReloadOn(['policy', 'job'], card.reload, 800);
  const { run, busy } = useAction();
  const withReauth = useReauth();
  const { selected } = useProject();
  const [dry, setDry] = useState<DryRunData | null>(null);
  const [limit, setLimit] = useState<string | null>(null);
  if (card.error) return <ErrorNote error={card.error} onRetry={card.reload} />;
  if (!card.data) return <Loading />;
  const c = card.data.card;
  const pre = c.prerequisite;
  const stop = c.stop;
  const reload = () => {
    card.reload();
    onChanged();
  };
  const limitValue = limit ?? String(c.maxPerRun);
  const limitOk = /^\d+$/.test(limitValue) && Number(limitValue) >= 1 && Number(limitValue) <= 500;
  return (
    <section className="card" aria-labelledby="sweep-title" data-card={SWEEP_ID}>
      <h2 id="sweep-title">{job.name}: an approved narrow automation</h2>
      {stop && stop.acknowledgedAt === null && (
        <div className="note note-bad" role="alert" aria-label="The sweep stopped">
          <strong>Stopped: verification failed</strong> on {stop.page ? `“${stop.page}”` : stop.resourceId} (
          {stop.project}, document <span className="mono">{stop.documentId}</span>) {fmtAgo(stop.at, now)}.
          The job disabled itself. {stop.reason}.
          {stop.differences.length > 0 && (
            <ul className="plain small-text">
              {stop.differences.slice(0, 5).map((d, i) => (
                <li key={i}>
                  <span className="mono">{d.path}</span>: expected {show(d.expected)}, found {show(d.actual)}
                </li>
              ))}
            </ul>
          )}
          <div>
            Restore from journal:{' '}
            {stop.journalId !== null ? (
              <>
                entry <strong>#{stop.journalId}</strong> holds the whole document as it was before the call
              </>
            ) : (
              <>the job’s journal entry holds the document as it was</>
            )}
            {stop.jobId && (
              <>
                {' '}
                (
                <Link
                  to={`/journal?jobId=${encodeURIComponent(stop.jobId)}&project=${encodeURIComponent(stop.project)}`}
                >
                  journal
                </Link>
                {' · '}
                <JobLink jobId={stop.jobId} projectId={stop.projectId} />)
              </>
            )}
            ; the night’s full snapshot holds it too (Snapshots page). Enabling the job again acknowledges
            this stop.
          </div>
        </div>
      )}
      {stop && stop.acknowledgedAt !== null && (
        <p className="muted small-text">
          Last stop {fmtAgo(stop.at, now)} on {stop.page ?? stop.documentId} ({stop.project}), acknowledged{' '}
          {fmtAgo(stop.acknowledgedAt, now)}.
        </p>
      )}
      <h3>What enabling it approves</h3>
      <ol aria-label="Approved-automation statement">
        {c.statement.map((p) => (
          <li key={p.key} data-point={p.key}>
            <strong>{p.title}.</strong> {p.text}
          </li>
        ))}
      </ol>
      <h3>Prerequisite: the sandbox check</h3>
      {pre.pass ? (
        <p>
          <Badge tone="ok">PASS</Badge> recorded for bridge version{' '}
          <span className="mono">{pre.version}</span> {fmtAgo(pre.pass.at, now)} (project {pre.pass.project}).
        </p>
      ) : (
        <p>
          <Badge tone={pre.override ? 'warn' : 'bad'}>no PASS</Badge> for bridge version{' '}
          <span className="mono">{pre.version}</span>. Run the sandbox check (docs/runbook-deploy.md, “The
          block-id sweep’s sandbox check”), or set the override.
        </p>
      )}
      {pre.recent.length > 0 && (
        <ul className="plain small-text" aria-label="Recent sandbox checks">
          {pre.recent.map((r, i) => (
            <li key={i}>
              <Badge tone={r.verdict === 'PASS' ? 'ok' : r.verdict === 'NOTED' ? 'warn' : 'bad'}>
                {r.verdict}
              </Badge>{' '}
              version <span className="mono">{r.bridgeVersion}</span>, {r.project}, {fmtAgo(r.at, now)}
              {r.detail && <div className="muted">{r.detail}</div>}
            </li>
          ))}
        </ul>
      )}
      <label className="row" htmlFor="sweep-override">
        <input
          id="sweep-override"
          type="checkbox"
          checked={pre.override !== null}
          disabled={busy}
          onChange={(e) => {
            const on = e.target.checked;
            void run(
              () =>
                on
                  ? withReauth(() => api.put(`/maintenance/${SWEEP_ID}/override`, { on }))
                  : api.put(`/maintenance/${SWEEP_ID}/override`, { on }),
              on ? 'Override set (audited).' : 'Override cleared.',
            ).then(reload);
          }}
        />
        Override: enable without a sandbox PASS (asks you to confirm it is you; audited)
      </label>
      {pre.override && (
        <p className="muted small-text">
          Override set {fmtAgo(pre.override.at, now)} by {pre.override.by}.
        </p>
      )}
      <h3>Candidates (from the latest snapshot)</h3>
      {c.projects.length === 0 ? (
        <Empty>No project is served.</Empty>
      ) : (
        <div className="table-wrap">
          <table aria-label="Candidates per project">
            <thead>
              <tr>
                <th>Project</th>
                <th>Snapshot</th>
                <th>Candidates</th>
                <th>Still to do</th>
                <th>Done</th>
                <th>Edited since read</th>
                <th>Unverified</th>
              </tr>
            </thead>
            <tbody>
              {c.projects.map((p) => (
                <tr key={p.projectId} data-project={p.project}>
                  <td>{p.project}</td>
                  <td>
                    {p.snapshot ? fmtAgo(p.snapshot.takenAt, now) : <span className="muted">none yet</span>}
                  </td>
                  <td>{p.candidates}</td>
                  <td>{p.remaining}</td>
                  <td>{p.counts.done}</td>
                  <td>{p.counts.moved}</td>
                  <td>{p.counts.unverified}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form
        className="row"
        aria-label="Documents a run"
        onSubmit={(e) => {
          e.preventDefault();
          if (limitOk)
            void run(
              () => api.put(`/maintenance/${SWEEP_ID}/limit`, { maxPerRun: Number(limitValue) }),
              'Saved.',
            ).then(() => {
              setLimit(null);
              reload();
            });
        }}
      >
        <label htmlFor="sweep-limit">At most</label>
        <input
          id="sweep-limit"
          type="number"
          min={1}
          max={500}
          value={limitValue}
          onChange={(e) => setLimit(e.target.value)}
        />
        <span>documents a run (N)</span>
        <Button busy={busy} disabled={!limitOk || limitValue === String(c.maxPerRun)} type="submit">
          Save
        </Button>
      </form>
      <div className="row">
        <Button
          busy={busy}
          onClick={() =>
            void run(() =>
              api.post<{ dryRun: DryRunData }>(
                `/maintenance/${SWEEP_ID}/dry-run`,
                selected ? { project: selected } : {},
              ),
            ).then((r) => r && setDry(r.dryRun))
          }
        >
          {selected ? `Dry run for ${selected}` : 'Dry run'}
        </Button>
        <span className="muted small-text">Lists what the next run would do. Writes nothing.</span>
      </div>
      {dry && <DryRunView dry={dry} />}
    </section>
  );
}

function DryRunView({ dry }: { dry: DryRunData }) {
  return (
    <div aria-label="Dry run">
      <h3>Dry run: {dry.project}</h3>
      <p>
        The next run would work on <strong>{dry.next.length}</strong> of {dry.remaining} documents still to do
        ({dry.candidates} candidates in the latest snapshot; at most {dry.maxPerRun} a run). About{' '}
        {dry.estimate.reads} reads and {dry.estimate.writes} writes at P3
        {dry.estimate.wallClockMs !== null && <>, about {fmtDuration(dry.estimate.wallClockMs)}</>}
        {dry.estimate.fitsToday === false && <> (more than today’s budget)</>}. Nothing was written.
      </p>
      {!dry.prerequisite.ok && (
        <div className="note note-warn">The job cannot run yet: {dry.prerequisite.reason}.</div>
      )}
      {dry.stopped && <div className="note note-bad">The sweep is stopped after a verification failure.</div>}
      <p className="muted small-text">{dry.estimate.note}</p>
      {dry.next.length === 0 ? (
        <Empty>Nothing to do.</Empty>
      ) : (
        <ol className="small-text">
          {dry.next.map((d) => (
            <li key={d.documentId} data-document={d.documentId}>
              <strong>{d.path}</strong>
              {d.document ? ` (${d.document})` : ''}: {d.missing} of {d.blocks} blocks without an id
              {d.duplicates > 0 ? `, ${d.duplicates} ids used twice` : ''}
              {d.unsupported > 0 ? `, ${d.unsupported} unsupported` : ''}
              {d.why === 'unverified' && <Badge tone="warn">checked first: outcome not known</Badge>}
              {d.retry && d.why === 'candidate' && <> (retried: edited since the last read)</>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function statusOf(j: MaintenanceJob, nameOf: (id: string | null | undefined) => string | null) {
  if (!j.implemented) return <Badge>Not implemented</Badge>;
  if (j.running) {
    const on = nameOf(j.runningProjectId);
    return (
      <>
        <StatusBadge status="running" />
        {on && <div className="muted small-text">for {on}</div>}
      </>
    );
  }
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
  // v2 E4 (RV1-4): switching off a job that keeps the backups asks for the password again.
  const withReauth = useReauth();
  const { selected, nameOf } = useProject();
  const toggleId = `toggle-${j.id}`;
  // v2 E5.1: Run now acts on the selected project for a per-project job (the schedule still covers every project).
  const perProject = j.scope === 'project';
  const runNow = () =>
    void run(
      () => api.post(`/maintenance/${j.id}/run`, perProject && selected ? { project: selected } : {}),
      perProject && selected ? `${j.name} started for ${selected}.` : `${j.name} started.`,
    ).then(onChanged);
  return (
    <>
      <tr data-job={j.id}>
        <td>
          <strong>{j.name}</strong>
          <div className="muted small-text">{j.description}</div>
          {j.writes && <div className="muted small-text">Writes to LegendKeeper.</div>}
        </td>
        <td>{statusOf(j, nameOf)}</td>
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
          {perProject && j.projects ? (
            <ProjectLines lines={j.projects} now={now} />
          ) : (
            <LastRun run={j.lastRun} now={now} />
          )}
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
                  () =>
                    withReauth(() =>
                      api.post(`/maintenance/${j.id}/${e.target.checked ? 'enable' : 'disable'}`),
                    ),
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
              title={perProject && selected ? `Runs for ${selected} only` : undefined}
              onClick={runNow}
            >
              {perProject && selected ? `Run now for ${selected}` : 'Run now'}
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
            <History id={j.id} name={j.name} now={now} perProject={perProject} />
          </td>
        </tr>
      )}
    </>
  );
}

/** A job link that opens in the run's own project (v2 E5.1), whichever project is selected. */
function JobLink({ jobId, projectId }: { jobId: string; projectId?: string | undefined }) {
  const { nameOf } = useProject();
  const project = projectId && projectId !== '*' ? nameOf(projectId) : null;
  return (
    <Link
      to={`/jobs/${encodeURIComponent(jobId)}${project ? `?project=${encodeURIComponent(project)}` : ''}`}
    >
      job{project ? ` (${project})` : ''}
    </Link>
  );
}

/** v2 E5.1: a per-project job's last run and "running now", one line per project. */
function ProjectLines({ lines, now }: { lines: MaintenanceProjectLine[]; now: number }) {
  if (lines.length === 0) return <span className="muted">no project is served</span>;
  return (
    <ul className="plain" aria-label="Per project">
      {lines.map((l) => (
        <li key={l.projectId} data-project={l.project}>
          <strong>{l.project}</strong>:{' '}
          {l.running ? (
            <StatusBadge status="running" />
          ) : l.lastRun ? (
            <LastRun run={l.lastRun} now={now} />
          ) : (
            <span className="muted">never</span>
          )}
          {l.running && l.lastRun && (
            <div className="muted small-text">
              before: {l.lastRun.outcome} {fmtAgo(l.lastRun.at, now)}
            </div>
          )}
        </li>
      ))}
    </ul>
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
            <JobLink jobId={run.jobId} projectId={run.projectId} />
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
  const [time, setTime] = useState(j.schedule.kind === 'interval' ? '03:30' : j.schedule.time);
  const [day, setDay] = useState<Weekday>(j.schedule.kind === 'weekly' ? j.schedule.day : 'sun');
  const n = Number(value);
  const intervalOk = Number.isInteger(n) && n * unit >= 10 && n * unit <= 31 * 86_400;
  const schedule: Schedule =
    kind === 'interval'
      ? { kind, everySeconds: n * unit }
      : kind === 'weekly'
        ? { kind, day, time }
        : { kind, time };
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
              <option value="weekly">once a week, on a day at a time</option>
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
            <>
              {kind === 'weekly' && (
                <div>
                  <label htmlFor={`day-${j.id}`}>Day</label>
                  <select id={`day-${j.id}`} value={day} onChange={(e) => setDay(e.target.value as Weekday)}>
                    {WEEKDAYS.map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label htmlFor={`time-${j.id}`}>Time (London, 24-hour)</label>
                <input
                  id={`time-${j.id}`}
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </div>
            </>
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
          Daily and weekly times follow the London clock, including the change to and from summer time. The
          next run is counted from now; a changed schedule never queues missed runs.
        </p>
      </fieldset>
    </form>
  );
}

function History({
  id,
  name,
  now,
  perProject,
}: {
  id: string;
  name: string;
  now: number;
  perProject: boolean;
}) {
  const { selected, nameOf } = useProject();
  // v2 E5.1: a per-project job's history is the selected project's, or every project's (each row named).
  const [all, setAll] = useState(false);
  const only = perProject && !all && selected ? selected : null;
  const h = useApi<{ job: { history: HistoryRow[] } }>(
    `/maintenance/${id}${only ? `?project=${encodeURIComponent(only)}` : ''}`,
  );
  if (h.error) return <ErrorNote error={h.error} onRetry={h.reload} />;
  if (!h.data) return <Loading />;
  const rows = h.data.job.history;
  return (
    <div aria-label={`History of ${name}`}>
      <h3>
        Recent runs of {name}
        {only ? ` in ${only}` : ''}
      </h3>
      {perProject && selected && (
        <label className="row small-text">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Every project
        </label>
      )}
      {rows.length === 0 ? (
        <Empty>No runs yet.</Empty>
      ) : (
        <ul className="plain">
          {rows.map((r) => (
            <li key={r.id}>
              {!only && r.projectId && r.projectId !== '*' && (
                <strong>{nameOf(r.projectId) ?? r.projectId}: </strong>
              )}
              <Badge tone={OUTCOME_TONE[r.outcome]}>{r.outcome}</Badge> {fmtTime(r.startedAt)} (
              {fmtAgo(r.startedAt, now)}), {r.trigger}, {fmtDuration(r.durationMs)}
              {r.engineJobId && (
                <>
                  {' · '}
                  <JobLink jobId={r.engineJobId} projectId={r.projectId} />
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

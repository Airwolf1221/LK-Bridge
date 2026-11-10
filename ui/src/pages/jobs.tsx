import { useEffect, useMemo, useState } from 'react';
import { api, qs } from '../api';
import {
  Badge,
  Button,
  CopyButton,
  Empty,
  ErrorNote,
  Json,
  Loading,
  PageHeader,
  StatusBadge,
  useAction,
  useConfirm,
} from '../components';
import {
  fmtAgo,
  fmtBytes,
  fmtDuration,
  fmtTime,
  pct,
  principalText,
  shortId,
  type PrincipalNames,
} from '../format';
import { useApi, useNow, useReloadOn } from '../hooks';
import { useProject, useScopedApi } from '../project';
import { Link, useRoute } from '../router';
import { useStreamEvent } from '../stream';
import type { ClientsResponse, Job, JobDetail, JobStatus, Step } from '../types';

const ACTIVE: JobStatus[] = ['queued', 'running', 'waiting_budget', 'waiting_lock', 'paused'];
const HISTORY: JobStatus[] = ['succeeded', 'failed', 'cancelled'];

interface Filters {
  view: 'active' | 'history';
  status: string;
  origin: string;
  profile: string;
  principalId: string;
}

const matches = (j: Job, f: Filters): boolean => {
  const set = f.view === 'active' ? ACTIVE : HISTORY;
  if (!set.includes(j.status)) return false;
  if (f.status && j.status !== f.status) return false;
  if (f.origin && j.origin.kind !== f.origin) return false;
  if (f.profile && j.profile !== f.profile) return false;
  if (f.principalId && j.principalId !== f.principalId) return false;
  return true;
};

export function JobsPage() {
  const { path } = useRoute();
  const m = /^\/jobs\/(.+)$/.exec(path);
  return m?.[1] ? <JobDetailView id={decodeURIComponent(m[1])} /> : <JobList />;
}

export function Progress({ job }: { job: Pick<Job, 'progress' | 'status'> }) {
  const { stepsDone, stepsTotal, stepsFailed } = job.progress;
  const p = stepsTotal === 0 ? (job.status === 'succeeded' ? 100 : 0) : pct(stepsDone, stepsTotal);
  return (
    <div className="progress-cell">
      <svg
        className="progress"
        viewBox="0 0 100 4"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${p} per cent complete`}
      >
        <rect className="gauge-track" x="0" y="0" width="100" height="4" rx="2" />
        <rect className="gauge-fill" x="0" y="0" width={p} height="4" rx="2" />
      </svg>
      <span className="small-text muted">
        {stepsDone} / {stepsTotal} steps{stepsFailed > 0 ? ` · ${stepsFailed} failed` : ''}
      </span>
    </div>
  );
}

/** Pause, resume and cancel act within the job's project (`project`: its name). */
function JobControls({ job, project, onDone }: { job: Job; project: string | null; onDone?: () => void }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const { withProject } = useProject();
  const active = ACTIVE.includes(job.status);
  if (!active) return null;
  const paused = job.status === 'paused' || job.pauseRequested;
  const control = (action: 'pause' | 'resume' | 'cancel') =>
    api.post(withProject(`/jobs/${encodeURIComponent(job.id)}/${action}`, project));
  return (
    <span className="row">
      {paused ? (
        <Button
          className="small"
          busy={busy}
          onClick={() => void run(() => control('resume'), 'Job resumed.').then(onDone)}
        >
          Resume
        </Button>
      ) : (
        <Button
          className="small"
          busy={busy}
          onClick={() =>
            void run(() => control('pause'), 'The job will pause after its current step.').then(onDone)
          }
        >
          Pause
        </Button>
      )}
      <Button
        className="small"
        variant="danger"
        busy={busy}
        onClick={() => {
          void confirm({
            title: 'Cancel this job?',
            message: (
              <>
                <p>
                  <strong>{job.title}</strong>
                </p>
                <p>
                  The step in flight finishes; nothing further is sent. Steps already done are not undone.
                </p>
              </>
            ),
            confirmLabel: 'Cancel job',
            danger: true,
          }).then((ok) => {
            if (ok) void run(() => control('cancel'), 'Job cancelled.').then(onDone);
          });
        }}
      >
        Cancel
      </Button>
    </span>
  );
}

function JobList() {
  const { query, navigate } = useRoute();
  const filters: Filters = {
    view: query.get('view') === 'history' ? 'history' : 'active',
    status: query.get('status') ?? '',
    origin: query.get('origin') ?? '',
    profile: query.get('profile') ?? '',
    principalId: query.get('principal') ?? '',
  };
  const setFilter = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    const q = qs({
      view: next.view === 'active' ? undefined : next.view,
      status: next.status,
      origin: next.origin,
      profile: next.profile,
      principal: next.principalId,
    });
    navigate(`/jobs${q}`, { replace: true });
  };
  const path = `/jobs${qs({ view: filters.view, status: filters.status, origin: filters.origin, profile: filters.profile, principalId: filters.principalId, limit: 100 })}`;
  const { selected, isSelected } = useProject();
  const list = useScopedApi<{ jobs: Job[]; hasMore: boolean; principals?: PrincipalNames }>(path);
  const clients = useApi<ClientsResponse>('/clients');
  const now = useNow();
  const { set } = list;

  // Live: a job event updates the row in place (progress, status, current step) without a request. Another project's
  // jobs never appear here.
  const key = JSON.stringify(filters);
  useStreamEvent<{ type: 'created' | 'updated'; job: Job }>('job', ({ job }) => {
    if (!isSelected(job.projectId)) return;
    const f = JSON.parse(key) as Filters;
    set((prev) => {
      if (!prev) return prev;
      const rest = prev.jobs.filter((j) => j.id !== job.id);
      if (!matches(job, f)) return { ...prev, jobs: rest };
      const existing = prev.jobs.findIndex((j) => j.id === job.id);
      if (existing >= 0) return { ...prev, jobs: prev.jobs.map((j) => (j.id === job.id ? job : j)) };
      return { ...prev, jobs: [job, ...rest] };
    });
  });

  const statuses = filters.view === 'active' ? ACTIVE : HISTORY;
  return (
    <>
      <PageHeader title="Jobs" project={selected} />
      <div className="tabs" role="group" aria-label="Which jobs">
        <button
          type="button"
          aria-pressed={filters.view === 'active'}
          onClick={() => setFilter({ view: 'active', status: '' })}
        >
          Active, queued and waiting
        </button>
        <button
          type="button"
          aria-pressed={filters.view === 'history'}
          onClick={() => setFilter({ view: 'history', status: '' })}
        >
          History
        </button>
      </div>
      <div className="filters">
        <div>
          <label htmlFor="f-status">Status</label>
          <select
            id="f-status"
            value={filters.status}
            onChange={(e) => setFilter({ status: e.target.value })}
          >
            <option value="">Any</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="f-origin">Origin</label>
          <select
            id="f-origin"
            value={filters.origin}
            onChange={(e) => setFilter({ origin: e.target.value })}
          >
            <option value="">Any</option>
            <option value="mcp">Agent (MCP)</option>
            <option value="ui">Dashboard</option>
            <option value="system">System</option>
            <option value="maintenance">Maintenance</option>
          </select>
        </div>
        <div>
          <label htmlFor="f-profile">Profile</label>
          <select
            id="f-profile"
            value={filters.profile}
            onChange={(e) => setFilter({ profile: e.target.value })}
          >
            <option value="">Any</option>
            {clients.data?.profiles.map((p) => (
              <option key={p.id} value={p.label}>
                {p.label}
              </option>
            ))}
            <option value="system">system</option>
          </select>
        </div>
        <div>
          <label htmlFor="f-principal">Principal</label>
          <input
            id="f-principal"
            placeholder="e.g. pat_…"
            value={filters.principalId}
            onChange={(e) => setFilter({ principalId: e.target.value.trim() })}
          />
        </div>
      </div>

      <ErrorNote error={list.error} onRetry={list.reload} />
      {!list.data ? (
        <Loading />
      ) : list.data.jobs.length === 0 ? (
        <Empty>
          {filters.view === 'active' ? 'Nothing is running or waiting.' : 'No finished jobs match.'}
        </Empty>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Current step</th>
                <th>Origin</th>
                <th>Principal</th>
                <th>Updated</th>
                <th>
                  <span className="offscreen">Controls</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.jobs.map((j) => (
                <tr key={j.id} data-job={j.id}>
                  <td>
                    <Link to={`/jobs/${encodeURIComponent(j.id)}`}>{j.title || j.id}</Link>
                    <div className="muted small-text mono">{shortId(j.id, 12)}</div>
                  </td>
                  <td>
                    <StatusBadge status={j.status} /> {j.uncertain && <Badge tone="bad">uncertain</Badge>}
                    {j.status === 'waiting_budget' && j.resumeAt && j.resumeAt > now && (
                      <div className="muted small-text">resumes in {fmtDuration(j.resumeAt - now)}</div>
                    )}
                  </td>
                  <td className="min-9">
                    <Progress job={j} />
                  </td>
                  <td>
                    {j.currentStep !== null && ACTIVE.includes(j.status) ? `Step ${j.currentStep}` : '–'}
                  </td>
                  <td>
                    {j.origin.kind}
                    {j.origin.tool ? <span className="muted"> · {j.origin.tool}</span> : null}
                  </td>
                  <td>
                    {j.profile}
                    {principalText(j.principalId, list.data?.principals, j.profile) !== j.profile && (
                      <div className="muted small-text" title={j.principalId}>
                        {principalText(j.principalId, list.data?.principals, j.profile)}
                      </div>
                    )}
                  </td>
                  <td>{fmtAgo(j.updatedAt, now)}</td>
                  <td>
                    <JobControls job={j} project={selected} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data?.hasMore && (
        <p className="muted">Showing the newest 100. Narrow the filters to see others.</p>
      )}
    </>
  );
}

function StepRow({
  step,
  job,
  project,
  onChange,
}: {
  step: Step;
  job: JobDetail;
  project: string | null;
  onChange: () => void;
}) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const { withProject } = useProject();
  const retry = step.retry;
  const doRetry = (force: boolean) =>
    run(
      () =>
        api.post(withProject(`/jobs/${encodeURIComponent(job.id)}/steps/${step.stepNo}/retry`, project), {
          force,
        }),
      force ? 'Step queued to run again as new work.' : 'Step queued to run again.',
    ).then(onChange);
  return (
    <tr>
      <td>{step.stepNo}</td>
      <td>
        <span className="mono">{step.opId}</span>
        <div className="muted small-text">{step.opKind}</div>
      </td>
      <td>
        <StatusBadge status={step.status} />
        {step.maybeSent && step.status !== 'succeeded' && (
          <div className="small-text muted">may have reached LegendKeeper</div>
        )}
      </td>
      <td className="num">{step.attempts}</td>
      <td>
        {step.requestIds.length === 0 ? (
          <span className="muted">–</span>
        ) : (
          step.requestIds.slice(-3).map((r) => (
            <div key={r} className="row">
              <span className="mono small-text">{shortId(r, 22)}</span>
              <CopyButton text={r} what="request id" />
            </div>
          ))
        )}
      </td>
      <td>
        {step.error && (
          <div className="small-text">
            <strong>{step.error.code ?? 'error'}</strong>: {step.error.message}
          </div>
        )}
        <details>
          <summary className="small-text">Details</summary>
          <h3>Parameters</h3>
          <Json value={step.params} />
          {step.resultSummary !== null && step.resultSummary !== undefined && (
            <>
              <h3>Result</h3>
              <Json value={step.resultSummary} />
            </>
          )}
          {step.idempotencyKey && <p className="mono small-text">Idempotency key: {step.idempotencyKey}</p>}
          {step.ifMatch && <p className="mono small-text">If-Match: {step.ifMatch}</p>}
        </details>
      </td>
      <td>
        {retry?.allowed && (
          <div className="stack">
            <Button
              className="small"
              busy={busy}
              onClick={() => {
                if (!retry.ambiguous) return void doRetry(false);
                void confirm({
                  title: 'Retry this step?',
                  message: (
                    <>
                      <p>{retry.warning}</p>
                      <p>This retry checks LegendKeeper first, so it cannot duplicate the work.</p>
                    </>
                  ),
                  confirmLabel: 'Retry with a check',
                }).then((ok) => {
                  if (ok) void doRetry(false);
                });
              }}
            >
              Retry step
            </Button>
            {retry.ambiguous && (
              <Button
                className="small"
                variant="danger"
                busy={busy}
                onClick={() => {
                  void confirm({
                    title: 'Force this step to run again?',
                    message: (
                      <>
                        <p className="note note-bad">
                          Warning: this step may already have been applied in LegendKeeper. Forcing it sends
                          it again as new work and can create a duplicate or overwrite a newer edit.
                        </p>
                        <p>
                          Check LegendKeeper first (the request id above helps), then continue only if you are
                          sure.
                        </p>
                      </>
                    ),
                    confirmLabel: 'Force retry',
                    danger: true,
                  }).then((ok) => {
                    if (ok) void doRetry(true);
                  });
                }}
              >
                Force…
              </Button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function JobDetailView({ id }: { id: string }) {
  // A link from a page that spans projects (Concurrent Writers) names the job's project; otherwise the selected one.
  const { query } = useRoute();
  const { selected, withProject } = useProject();
  const project = query.get('project') ?? selected;
  const d = useScopedApi<{ job: JobDetail; principals?: PrincipalNames }>(
    `/jobs/${encodeURIComponent(id)}`,
    project,
  );
  const now = useNow();
  const { set } = d;
  useStreamEvent<{ type: string; job: Job }>('job', ({ job }) => {
    if (job.id !== id) return;
    set((prev) => (prev ? { ...prev, job: { ...prev.job, ...job } } : prev));
  });
  useReloadOn(['step'], d.reload, 300, (e) => (e as { jobId?: unknown } | null)?.jobId === id);
  const [artifact, setArtifact] = useState<{ id: string; data: unknown } | null>(null);
  useEffect(() => setArtifact(null), [id]);
  const job = d.data?.job;
  const failedSteps = useMemo(
    () => job?.steps.filter((s) => s.status === 'failed' || s.status === 'uncertain') ?? [],
    [job],
  );

  return (
    <>
      <PageHeader title={job?.title || 'Job'} project={project}>
        <Link to="/jobs?view=history">← All jobs</Link>
      </PageHeader>
      <ErrorNote error={d.error} onRetry={d.reload} />
      {!job ? (
        !d.error && <Loading />
      ) : (
        <>
          <section className="card">
            <div className="row row-between">
              <div className="row">
                <StatusBadge status={job.status} />
                {job.uncertain && <Badge tone="bad">uncertain</Badge>}
                {job.pauseRequested && <Badge tone="warn">pausing after this step</Badge>}
                {job.cancelRequested && <Badge tone="warn">cancelling after this step</Badge>}
                <span className="mono muted small-text">{job.id}</span>
              </div>
              <JobControls job={job} project={project} onDone={d.reload} />
            </div>
            {job.uncertain && (
              <p className="note note-bad" role="alert">
                <strong>Uncertain.</strong> At least one step may or may not have been applied in
                LegendKeeper, and the bridge could not establish which without risking a duplicate. Check
                LegendKeeper, then retry the step (it will be checked first) or force it.
              </p>
            )}
            <Progress job={job} />
            <dl className="meta">
              <div>
                <dt>Kind</dt>
                <dd>{job.kind}</dd>
              </div>
              <div>
                <dt>Origin</dt>
                <dd>
                  {job.origin.kind}
                  {job.origin.tool ? ` · ${job.origin.tool}` : ''}
                  {job.origin.client ? ` · ${job.origin.client}` : ''}
                </dd>
              </div>
              <div>
                <dt>Principal</dt>
                <dd>
                  {job.profile}{' '}
                  <span className="muted" title={job.principalId}>
                    {principalText(job.principalId, d.data?.principals, job.profile)}
                  </span>
                </dd>
              </div>
              {job.approvedBy && (
                <div>
                  <dt>Approved by</dt>
                  <dd>{job.approvedBy}</dd>
                </div>
              )}
              <div>
                <dt>Priority</dt>
                <dd>{job.priority}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{fmtTime(job.createdAt)}</dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{fmtTime(job.startedAt)}</dd>
              </div>
              <div>
                <dt>Finished</dt>
                <dd>{fmtTime(job.finishedAt)}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{fmtAgo(job.updatedAt, now)}</dd>
              </div>
            </dl>
            {job.waitReason && (
              <p className="note note-warn">
                Waiting: <span className="mono">{JSON.stringify(job.waitReason)}</span>
                {job.resumeAt && job.resumeAt > now ? ` · resumes in ${fmtDuration(job.resumeAt - now)}` : ''}
              </p>
            )}
            {job.lastError && (
              <p className="note note-bad">
                Last error{job.lastError.stepNo !== undefined ? ` (step ${job.lastError.stepNo})` : ''}:{' '}
                <strong>{job.lastError.code}</strong> {job.lastError.message}
                {job.lastError.requestId && (
                  <>
                    {' '}
                    <span className="mono">{job.lastError.requestId}</span>{' '}
                    <CopyButton text={job.lastError.requestId} what="request id" />
                  </>
                )}
              </p>
            )}
            {failedSteps.length > 0 && (
              <p className="small-text">
                <Link to={`/errors`}>See the grouped errors</Link>
              </p>
            )}
          </section>

          <section className="card">
            <h2>Steps</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Operation</th>
                    <th>Status</th>
                    <th className="num">Attempts</th>
                    <th>Request ids</th>
                    <th>Outcome</th>
                    <th>
                      <span className="offscreen">Retry</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {job.steps.map((s) => (
                    <StepRow key={s.stepNo} step={s} job={job} project={project} onChange={d.reload} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {job.result && (
            <section className="card">
              <h2>Result</h2>
              <Json value={job.result} />
            </section>
          )}

          <section className="card">
            <h2>Artefacts</h2>
            {job.artifacts.length === 0 ? (
              <Empty>No stored artefacts.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Kind</th>
                      <th>Step</th>
                      <th className="num">Items</th>
                      <th className="num">Size</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {job.artifacts.map((a) => (
                      <tr key={a.id}>
                        <td>
                          {a.kind}
                          {a.truncated && <Badge tone="warn">truncated</Badge>}
                        </td>
                        <td>{a.stepNo ?? '–'}</td>
                        <td className="num">{a.itemCount}</td>
                        <td className="num">{fmtBytes(a.bytes)}</td>
                        <td>
                          <button
                            type="button"
                            className="small"
                            onClick={() => {
                              void api
                                .get<{ items?: unknown[]; data?: unknown }>(
                                  withProject(
                                    `/jobs/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(a.id)}?limit=20`,
                                    project,
                                  ),
                                )
                                .then((r) => setArtifact({ id: a.id, data: r.items ?? r.data }));
                            }}
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {artifact && <Json value={artifact.data} />}
          </section>
        </>
      )}
    </>
  );
}

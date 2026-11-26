import { Badge, ErrorNote, Gauge, Loading, PageHeader, ProjectStatusBadge } from '../components';
import { fmtAgo, fmtInt } from '../format';
import { useNow } from '../hooks';
import { useLiveBudget, useProject, useProjectReloadOn, useScopedApi } from '../project';
import { Link } from '../router';
import { WaitReasons } from './budgets';
import type { AutomationOvernight, Overview, ProjectStatusSummary } from '../types';

/** Every project whose status is not `active` (a refused key, a mismatched id, not checked yet, no key), with why. */
function ProjectsAttention({ projects }: { projects: ProjectStatusSummary[] }) {
  // A removed (archived) project needs nothing: its history is kept on purpose.
  const attention = projects.filter((p) => p.status !== 'active' && p.status !== 'archived');
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

/**
 * OPS2: keys can now be changed from the dashboard, so the owner's sign-in guards them. While the authenticator is off,
 * the Overview recommends it strongly; it also shows any problem with the encrypted secret store, and any difference
 * between the env file and the store (the stored value wins).
 */
function SecurityAdvice({ security }: { security: Overview['security'] }) {
  if (!security) return null;
  return (
    <>
      {!security.totpEnabled && (
        <section className="card card-alert" aria-labelledby="totp-advice-h" data-testid="totp-advice">
          <h2 id="totp-advice-h">Turn on the authenticator app</h2>
          <p>
            API keys can be added and replaced from this dashboard now, so your password alone guards every
            project. An authenticator app on your phone stops anyone who learns it. It takes a minute:{' '}
            <Link to="/account">Account</Link>, then “Set up the authenticator”.
          </p>
        </section>
      )}
      {security.storeProblem && (
        <section className="card card-alert" aria-labelledby="store-h">
          <h2 id="store-h">The encrypted secret store needs attention</h2>
          <p>{security.storeProblem}</p>
        </section>
      )}
      {security.warnings.length > 0 && (
        <section className="card" aria-labelledby="sec-warn-h">
          <h2 id="sec-warn-h">The env file and the store differ</h2>
          <ul className="plain">
            {security.warnings.map((w) => (
              <li key={w} className="small-text">
                {w}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * v2 E1b: a broken backup must not go unnoticed. The off-site copy's card turns red when Google refused the saved sign-in
 * ("Reconnect"), when the last good copy on Drive is older than the setting (2 days), or when the last verify found
 * problems; amber for a failed copy or an unfinished set-up.
 */
function OffsiteAdvice({ offsite }: { offsite: Overview['offsite'] }) {
  if (!offsite || offsite.state === 'ok') return null;
  if (offsite.state === 'not_set_up') {
    return (
      <section className="card" aria-labelledby="offsite-advice-h" data-testid="offsite-advice">
        <h2 id="offsite-advice-h">Off-site copy</h2>
        <p className="small-text">
          {offsite.messages[0]} <Link to="/offsite">Set it up</Link>.
        </p>
      </section>
    );
  }
  return (
    <section className="card card-alert" aria-labelledby="offsite-advice-h" data-testid="offsite-advice">
      <h2 id="offsite-advice-h">
        {offsite.state === 'bad' ? 'The off-site backup needs attention' : 'The off-site backup: a warning'}
      </h2>
      <ul className="plain">
        {offsite.messages.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
      <p className="small-text">
        <Link to="/offsite">Open the Off-site copy page</Link>
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
  const waits = live?.snapshot.waits ?? budget?.waits;
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

      <SecurityAdvice security={d.security} />
      <OffsiteAdvice offsite={d.offsite} />
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
            {/* v3 F5a (ADR 0067, H10): shown only when there is one (an unknown outcome is rare). */}
            {d.unknownWrites && d.unknownWrites.pending + d.unknownWrites.unresolved > 0 && (
              <div className="stat">
                <span className="stat-value">{d.unknownWrites.pending + d.unknownWrites.unresolved}</span>
                <span className="stat-label">
                  <Link to="/journal?outcome=unknown">
                    writes with an unknown outcome
                    {d.unknownWrites.unresolved > 0
                      ? ` (${d.unknownWrites.unresolved} for you to check)`
                      : ''}
                  </Link>
                </span>
              </div>
            )}
            <div className="stat">
              <span className="stat-value">{d.pendingProposals}</span>
              <span className="stat-label">
                <Link to="/proposals">pending proposals</Link>
              </span>
            </div>
            {/* v3 F3.4 (ADR 0055): agents' direct writes at scope write, waiting for the owner's review. */}
            <div className="stat">
              <span className="stat-value">{d.unreviewedDirectWrites ?? 0}</span>
              <span className="stat-label">
                <Link to="/review">direct writes to review</Link>
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

      <AutomationTile overnight={d.automation ?? null} />

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
              Waiting for budget: interactive {queues.P1} · jobs {queues.P2} · maintenance {queues.P3} · bulk{' '}
              {queues.P4} · dashboard {queues.P0}
            </p>
            <WaitReasons waits={waits} />
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

/**
 * v3 F5b (ADR 0068, H5): what automation did overnight (the last 24 hours): counts per code, each linking to the
 * Review page (direct writes) or the Proposals page (proposals). Shown once any run has happened.
 */
function AutomationTile({ overnight }: { overnight: AutomationOvernight | null }) {
  if (!overnight || (overnight.runs.length === 0 && !overnight.paused)) return null;
  return (
    <section className="card mt" aria-labelledby="automation-h" data-testid="automation-tile">
      <div className="row row-between">
        <h2 id="automation-h">Automation overnight</h2>
        <Link to="/automation">Automation</Link>
      </div>
      {overnight.paused && (
        <p>
          <Badge tone="warn">Paused</Badge> Pause all automation is on: nothing runs until you resume it.
        </p>
      )}
      {overnight.codes.length === 0 ? (
        <p className="muted">
          {overnight.runs.length} run{overnight.runs.length === 1 ? '' : 's'} in the last 24 hours; nothing
          was done or skipped.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="offscreen">What each automated finding code did in the last 24 hours</caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Applied</th>
                <th scope="col">Proposed</th>
                <th scope="col">Skipped</th>
                <th scope="col">Stopped or caught</th>
                <th scope="col">Where to look</th>
              </tr>
            </thead>
            <tbody>
              {overnight.codes.map((c) => (
                <tr key={c.code} data-code={c.code}>
                  <th scope="row">{c.name}</th>
                  <td>{fmtInt(c.counts.applied)}</td>
                  <td>{fmtInt(c.counts.proposed)}</td>
                  <td>{fmtInt(c.counts.skipped)}</td>
                  <td>{fmtInt(c.counts.failed + c.counts.guarded + c.counts.stopped)}</td>
                  <td>
                    {c.jobs.length > 0 && <Link to="/review">{c.jobs.length} on the Review page</Link>}
                    {c.jobs.length > 0 && c.proposals.length > 0 && ' · '}
                    {c.proposals.length > 0 && (
                      <Link to="/proposals">
                        {c.proposals.length} proposal{c.proposals.length === 1 ? '' : 's'}
                      </Link>
                    )}
                    {c.jobs.length === 0 && c.proposals.length === 0 && <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

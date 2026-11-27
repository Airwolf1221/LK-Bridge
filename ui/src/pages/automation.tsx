import { useState } from 'react';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, useAction, useConfirm } from '../components';
import { fmtAgo } from '../format';
import { useNow } from '../hooks';
import { useProject, useProjectApi, useProjectReloadOn, useScopedApi } from '../project';
import { Link } from '../router';
import type {
  AutomationCode,
  AutomationGovernance,
  AutomationItem,
  AutomationMode,
  AutomationPayload,
} from '../types';

/**
 * v3 F5b (ADR 0068, H5): the Automation page. Every finding code whose fix the bridge fully determines, with its plain
 * name, an example, the one transformation, its setting (Off, Propose automatically, Apply automatically: the owner's,
 * ADR 0081: no fresh authenticator code), its last run and what it did or skipped. "Pause all automation" is one click (a
 * brake), as are resuming, a setting change and "Run automation now". Each switch is recorded in Repository Automation's
 * "Approved Narrow Automations" before it takes effect.
 */

const MODE_LABEL: Record<AutomationMode, string> = {
  off: 'Off',
  propose: 'Propose automatically',
  apply: 'Apply automatically',
};

const OUTCOME_TONE: Record<AutomationItem['outcome'], 'ok' | 'info' | 'warn' | 'bad' | 'neutral'> = {
  applied: 'ok',
  proposed: 'info',
  skipped: 'neutral',
  guarded: 'warn',
  failed: 'bad',
  stopped: 'warn',
};

export function AutomationPage() {
  const { selected } = useProject();
  const data = useScopedApi<AutomationPayload>('/automation');
  useProjectReloadOn(['job', 'proposal'], data.reload, 1000);
  const api = useProjectApi();
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const now = useNow(30_000);
  const [governance, setGovernance] = useState<AutomationGovernance | null>(null);

  if (data.error) return <ErrorNote error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;
  const d = data.data;
  const on = d.codes.filter((c) => c.mode !== 'off');

  const pauseAll = () =>
    run(
      () => api.post('/automation/pause', { confirm: true }),
      'Automation paused: nothing runs until you resume it.',
    ).then(data.reload);
  const resumeAll = async () => {
    if (
      !(await confirm({
        title: 'Resume automation?',
        message: 'The codes switched on run again after the next nightly audit.',
        confirmLabel: 'Resume',
      }))
    )
      return;
    await run(() => api.post('/automation/resume', { confirm: true }), 'Automation resumed.');
    data.reload();
  };
  const runNow = async () => {
    if (
      !(await confirm({
        title: 'Run automation now?',
        message: `Runs ${on.length} code${on.length === 1 ? '' : 's'} switched on, now, in ${selected ?? 'this project'}: each finding re-checked live, then proposed or written as its setting says, within the caps (${d.caps.perCode} pages a code, ${d.caps.perRun} in all).`,
        confirmLabel: 'Run now',
      }))
    )
      return;
    await run(
      () => api.post('/automation/run', { confirm: true }),
      'Automation started: the results show below as it runs.',
    );
    data.reload();
  };
  const checkGovernance = () =>
    run(() => api.get<AutomationGovernance>('/automation/governance')).then((g) => {
      if (g) setGovernance(g);
    });

  return (
    <>
      <PageHeader title="Automation" project={selected}>
        <Button onClick={() => void checkGovernance()} busy={busy}>
          Check Repository Automation
        </Button>
        <Button
          variant="primary"
          onClick={() => void runNow()}
          busy={busy}
          disabled={on.length === 0 || d.global.paused}
        >
          Run automation now
        </Button>
      </PageHeader>
      <p className="muted">
        Automatic actions for audit and appraisal findings, switched on one finding code at a time. Only codes
        whose fix the bridge fully determines are here; everything starts Off. Switching a code on records
        your approval in Repository Automation’s “Approved Narrow Automations” first; switching it off amends
        that record. Direct writes appear on the <Link to="/review">Review</Link> page and can be Reverted;
        proposals wait on the <Link to="/proposals">Proposals</Link> page.
      </p>

      {d.pausing && (
        <p className="note" role="status">
          <Badge tone="info">Running</Badge> pausing for budget ({d.pausing.label}, {d.pausing.seconds} s):
          the run carries on by itself, and “Run automation now” joins it.
        </p>
      )}

      <section className="card" aria-labelledby="brake-h">
        <h2 id="brake-h">Pause all automation</h2>
        {d.global.paused ? (
          <>
            <p role="status">
              <Badge tone="warn">Paused</Badge> since{' '}
              {d.global.pausedAt ? fmtAgo(d.global.pausedAt, now) : 'now'}: nothing runs, in any project,
              until you resume it.
            </p>
            <Button onClick={() => void resumeAll()} busy={busy}>
              Resume automation
            </Button>
          </>
        ) : (
          <>
            <p>
              <Badge tone="ok">Running</Badge> {on.length} code{on.length === 1 ? '' : 's'} switched on in
              this project. Pausing and resuming are one click each.
            </p>
            <Button variant="danger" onClick={() => void pauseAll()} busy={busy}>
              Pause all automation
            </Button>
          </>
        )}
      </section>

      {governance && (
        <div
          className={`note ${governance.ok ? '' : 'note-warn'}`}
          role="status"
          data-testid="automation-governance"
        >
          {governance.message}
        </div>
      )}

      <section className="card mt" aria-labelledby="codes-h">
        <h2 id="codes-h">Finding codes</h2>
        <p className="muted small-text">
          At most {d.caps.perCode} pages a run for each code and {d.caps.perRun} for every code together, at
          the lowest priority (the caps are settings: <Link to="/settings">Settings</Link>, search
          “automation”). A failed verification, an unexpected error or a write whose outcome is unknown
          switches a code off; three skips in a row for the same reason, or a guard catching a change, pause
          it for you to look.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">What it does</th>
                <th scope="col">Setting</th>
                <th scope="col">Last run</th>
              </tr>
            </thead>
            <tbody>
              {d.codes.map((c) => (
                <CodeRow key={c.code} code={c} now={now} onChanged={data.reload} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card mt" aria-labelledby="runs-h">
        <h2 id="runs-h">Recent runs</h2>
        {d.runs.length === 0 ? (
          <Empty>No run yet.</Empty>
        ) : (
          <ul className="plain">
            {d.runs.map((r) => (
              <li key={r.id} data-run={r.id}>
                <Badge
                  tone={
                    r.state === 'succeeded'
                      ? 'ok'
                      : r.state === 'failed'
                        ? 'bad'
                        : r.state === 'stopped'
                          ? 'warn'
                          : 'neutral'
                  }
                >
                  {r.state}
                </Badge>{' '}
                {fmtAgo(r.startedAt, now)} ({r.trigger}): {r.summary ?? 'running'}
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="card mt">
        <summary>Never automatic ({d.never.length})</summary>
        <p className="muted small-text">
          Canon and lifecycle changes, holds, exceptions, judgements, “Pick the right value”, deletions,
          splits, renames of a subject, moves into or out of Narratives, images and anything touching
          unsupported blocks are never automated: the flag cannot be set on them.
        </p>
        <ul className="plain">
          {d.never.map((n) => (
            <li key={n.code}>
              <strong>{n.name}</strong> <span className="mono">{n.code}</span>: {n.transformation}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

function CodeRow({ code: c, now, onChanged }: { code: AutomationCode; now: number; onChanged: () => void }) {
  const api = useProjectApi();
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [mode, setMode] = useState<AutomationMode>(c.mode);
  const id = `mode-${c.code}`;

  const change = async () => {
    if (mode === c.mode && !c.paused) return;
    const message =
      mode === 'off'
        ? `“${c.name}” stops running. Repository Automation’s paragraph for it is amended to say it was switched off today (it is never deleted).`
        : `“${c.name}” is set to ${MODE_LABEL[mode]}. Your approval is first written into Repository Automation’s “Approved Narrow Automations”, after the block-id sweep’s paragraph: the code, its scope, its one transformation (${c.transformation}), the verification, the concurrency rules and the stop conditions.`;
    if (
      !(await confirm({
        title: `${MODE_LABEL[mode]}: ${c.name}?`,
        message,
        confirmLabel: 'Change the setting',
        danger: mode === 'apply',
      }))
    )
      return;
    await run(
      () => api.post(`/automation/codes/${c.code}`, { mode, confirm: true }),
      `${c.name}: ${MODE_LABEL[mode]} (recorded in Repository Automation).`,
    );
    onChanged();
  };
  const resume = async () => {
    await run(() => api.post(`/automation/codes/${c.code}/resume`, { confirm: true }), `${c.name} resumed.`);
    onChanged();
  };

  return (
    <tr data-code={c.code}>
      <th scope="row">
        {c.name}
        <div className="mono small-text">{c.code}</div>
      </th>
      <td>
        <div>{c.example}</div>
        <details>
          <summary className="small-text">The transformation</summary>
          <p className="small-text">{c.transformation}</p>
        </details>
      </td>
      <td>
        <label htmlFor={id} className="offscreen">
          Setting for {c.name}
        </label>
        <select id={id} value={mode} onChange={(e) => setMode(e.target.value as AutomationMode)}>
          {(c.modes ?? (['off', 'propose', 'apply'] as const)).map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]}
            </option>
          ))}
        </select>{' '}
        <Button onClick={() => void change()} busy={busy} disabled={mode === c.mode}>
          Change
        </Button>
        <div>
          <Badge tone={c.mode === 'off' ? 'neutral' : c.mode === 'apply' ? 'ok' : 'info'}>
            {MODE_LABEL[c.mode]}
          </Badge>
          {c.paused && (
            <>
              {' '}
              <Badge tone="warn">Paused</Badge>
            </>
          )}
        </div>
        {c.paused && (
          <div className="small-text" role="status">
            {c.paused.reason}{' '}
            <Button onClick={() => void resume()} busy={busy}>
              Resume
            </Button>
          </div>
        )}
        {c.stopped && c.mode === 'off' && (
          <div className="small-text note note-warn" role="status">
            Switched off by the bridge {fmtAgo(c.stopped.at, now)}: {c.stopped.reason}
          </div>
        )}
        {c.governancePending && (
          <div className="small-text note note-warn" role="status">
            Repository Automation still to be amended: {c.governancePending}
          </div>
        )}
      </td>
      <td>
        {c.lastRun ? fmtAgo(c.lastRun.at, now) : <span className="muted">never</span>}
        {c.recent.length > 0 && (
          <details>
            <summary className="small-text">What it did ({c.recent.length})</summary>
            <ul className="plain small-text">
              {c.recent.map((i) => (
                <li key={i.id}>
                  <Badge tone={OUTCOME_TONE[i.outcome]}>{i.outcome}</Badge> {i.pageName ?? i.pageId ?? ''}
                  {i.reason ? `: ${i.reason}` : ''}
                  {i.jobId && (
                    <>
                      {' '}
                      <Link to={`/jobs/${i.jobId}`}>job</Link>
                    </>
                  )}
                  {i.proposalId && (
                    <>
                      {' '}
                      <Link to="/proposals">proposal</Link>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </td>
    </tr>
  );
}

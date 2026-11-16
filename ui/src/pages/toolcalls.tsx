import { useEffect, useRef, useState } from 'react';
import { api, qs } from '../api';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, useAction } from '../components';
import { fmtInt, fmtTime, principalText } from '../format';
import { useApi } from '../hooks';
import type { ToolCallArg, ToolCallOutcome, ToolCallRow, ToolCallsResponse } from '../types';
import { EvaluationPanel } from './evaluation';

const SINCE: [string, string][] = [
  ['', 'Any time'],
  ['60', 'Last hour'],
  ['1440', 'Last 24 hours'],
  ['4320', 'Last 3 days'],
  ['10080', 'Last 7 days'],
];

const OUTCOME_LABEL: Record<ToolCallOutcome, string> = {
  success: 'Success',
  error: 'Error',
  proposal: 'Proposal captured',
  waiting: 'Waiting (budget)',
  queued: 'Queued',
};
const OUTCOME_TONE: Record<ToolCallOutcome, 'ok' | 'bad' | 'warn' | 'info' | 'neutral'> = {
  success: 'ok',
  error: 'bad',
  proposal: 'info',
  waiting: 'warn',
  queued: 'neutral',
};

/** One argument as `name`, `name=value` (booleans, numbers and short reference strings) or `name(size)`. */
export function argText(a: ToolCallArg): string {
  if (a.value !== undefined) {
    const v = typeof a.value === 'string' ? `“${a.value}”` : String(a.value);
    return `${a.name}=${v}`;
  }
  if (a.type === 'null') return `${a.name}=null`;
  const unit = a.type === 'string' ? 'chars' : a.type === 'array' ? 'items' : 'keys';
  return `${a.name} (${a.size ?? 0} ${unit})`;
}

export const durationText = (ms: number): string =>
  ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;

export const budgetText = (r: Pick<ToolCallRow, 'budgetRequests' | 'budgetWrites'>): string =>
  r.budgetRequests === null
    ? '–'
    : `${r.budgetRequests} req${r.budgetWrites ? ` (${r.budgetWrites} w)` : ''}`;

/**
 * Which tools each connection actually called (v2 E3, ADR 0045): when, who, which tool, a short summary of the
 * arguments (names and sizes, never page content or secrets), the outcome, how long it took and the request budget used.
 * For evaluating the assistants without copying transcripts. View only; kept for a number of days you set below. Writes
 * that edit a page without a base version are badged and can be filtered. The Evaluation helper (its own panel) runs the
 * scripted scenarios from this log.
 */
export function ToolCallsPage() {
  const [f, setF] = useState({
    principalId: '',
    tool: '',
    outcome: '',
    code: '',
    sinceMinutes: '1440',
    noBaseVersion: false,
  });
  const [cursors, setCursors] = useState<number[]>([]);
  const before = cursors.at(-1);
  const [open, setOpen] = useState<number | null>(null);
  const list = useApi<ToolCallsResponse>(
    `/tool-calls${qs({ ...f, noBaseVersion: f.noBaseVersion ? 'true' : '', limit: 100, ...(before !== undefined ? { before } : {}) })}`,
  );
  const set = (k: Exclude<keyof typeof f, 'noBaseVersion'>) => (e: { target: { value: string } }) => {
    setCursors([]);
    setF({ ...f, [k]: e.target.value });
  };
  const d = list.data;
  // Connections that appear in the log, by their principal id (named from the journal's resolver).
  const [seen, setSeen] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!d) return;
    setSeen((prev) => {
      const next = { ...prev };
      for (const c of d.calls) {
        if (c.principalId)
          next[c.principalId] = principalText(c.principalId, d.principals, c.profile ?? undefined);
      }
      return next;
    });
  }, [d]);

  return (
    <>
      <PageHeader title="Tool calls" />
      <p className="muted">
        Every tool call an assistant makes through the bridge: the connection and profile, the tool, a short
        summary of the arguments (names and sizes, never page content or secrets), the outcome, how long it
        took and the request budget it used. Use it to see what ChatGPT and Claude really called while you
        evaluate them. This page is view only and only you can see it; agents cannot read it. “Budget” is how
        far the projects’ hourly request and write counters moved during the call, so it also counts any other
        call made in the same moment.
      </p>
      <RetentionCard data={d} onSaved={list.reload} />
      <EvaluationPanel />
      <div className="filters">
        <div>
          <label htmlFor="tc-conn">Connection</label>
          <select id="tc-conn" value={f.principalId} onChange={set('principalId')}>
            <option value="">Any</option>
            {Object.entries(seen).map(([id, name]) => (
              <option key={id} value={id}>
                {name} ({id.slice(0, 12)})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="tc-tool">Tool</label>
          <select id="tc-tool" value={f.tool} onChange={set('tool')}>
            <option value="">Any</option>
            {d?.facets.tools.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="tc-outcome">Outcome</label>
          <select id="tc-outcome" value={f.outcome} onChange={set('outcome')}>
            <option value="">Any</option>
            <option value="not_success">Anything but success</option>
            {(Object.keys(OUTCOME_LABEL) as ToolCallOutcome[]).map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABEL[o]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="tc-code">Error code or status</label>
          <select id="tc-code" value={f.code} onChange={set('code')}>
            <option value="">Any</option>
            {d?.facets.codes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="tc-since">When</label>
          <select id="tc-since" value={f.sinceMinutes} onChange={set('sinceMinutes')}>
            {SINCE.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="inline" htmlFor="tc-nobase">
            <input
              id="tc-nobase"
              type="checkbox"
              checked={f.noBaseVersion}
              onChange={(e) => {
                setCursors([]);
                setF({ ...f, noBaseVersion: e.target.checked });
              }}
            />{' '}
            Writes without a base version
          </label>
        </div>
      </div>
      {d?.summary && d.summary.noBaseVersion > 0 && (
        <p className="note note-warn" data-testid="nobase-summary">
          {fmtInt(d.summary.noBaseVersion)} of {fmtInt(d.summary.matching)} matching calls{' '}
          {d.summary.noBaseVersion === 1 ? 'is a write' : 'are writes'} without a base version: a write_page
          with no baseVersion, or a set_facts with no baseFactsVersion, that edits an existing page (a dry run
          does not count). Base versions are optional; this shows whether an assistant skips them.
        </p>
      )}
      <ErrorNote error={list.error} onRetry={list.reload} />
      {!d ? (
        <Loading />
      ) : d.calls.length === 0 ? (
        <Empty>
          {d.settings.recording
            ? 'No tool calls match. Calls made from now on appear here.'
            : 'Recording is switched off (retention 0 days). Set a number of days above to start recording.'}
        </Empty>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Connection</th>
                <th>Profile</th>
                <th>Tool</th>
                <th>Arguments</th>
                <th>Outcome</th>
                <th className="num">Time</th>
                <th className="num">Budget</th>
              </tr>
            </thead>
            <tbody>
              {d.calls.map((c) => (
                <tr
                  key={c.id}
                  className={open === c.id ? 'selected' : ''}
                  data-call={c.id}
                  onClick={() => setOpen(open === c.id ? null : c.id)}
                >
                  <td>{fmtTime(c.at)}</td>
                  <td title={c.principalId ?? ''}>
                    {c.principalId ? principalText(c.principalId, d.principals, c.profile ?? undefined) : '–'}
                  </td>
                  <td>
                    {c.profile ?? '–'}
                    {c.scope && <div className="muted small-text">{c.scope}</div>}
                  </td>
                  <td className="mono">
                    {c.tool}
                    {c.project && <div className="muted small-text">{c.project}</div>}
                    {c.noBaseVersion && (
                      <div>
                        <Badge tone="warn">write without a base version</Badge>
                      </div>
                    )}
                  </td>
                  <td className="small-text">
                    {c.args.length === 0 ? (
                      <span className="muted">none</span>
                    ) : (
                      c.args.map(argText).join(', ')
                    )}
                    {open === c.id && (
                      <div className="muted small-text" data-testid="call-detail">
                        {c.jobId && <>job {c.jobId} · </>}
                        {c.proposalId && <>proposal {c.proposalId} · </>}
                        {c.resultChars !== null && <>result {fmtInt(c.resultChars)} chars</>}
                      </div>
                    )}
                  </td>
                  <td>
                    <Badge tone={OUTCOME_TONE[c.outcome]}>{OUTCOME_LABEL[c.outcome]}</Badge>
                    {(c.outcome === 'error' || (c.code && c.code !== 'succeeded')) && c.code && (
                      <div className="mono small-text">{c.code}</div>
                    )}
                  </td>
                  <td className="num">{durationText(c.durationMs)}</td>
                  <td className="num">{budgetText(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d && (
        <div className="row">
          <Button disabled={cursors.length === 0} onClick={() => setCursors(cursors.slice(0, -1))}>
            Newer
          </Button>
          <Button
            disabled={!d.hasMore || d.nextBefore === null}
            onClick={() => d.nextBefore !== null && setCursors([...cursors, d.nextBefore])}
          >
            Older
          </Button>
          <span className="muted small-text">
            {fmtInt(d.facets.total)} calls kept
            {d.facets.oldest !== null ? `, the oldest from ${fmtTime(d.facets.oldest)}` : ''}.
          </span>
        </div>
      )}
    </>
  );
}

function RetentionCard({ data, onSaved }: { data: ToolCallsResponse | undefined; onSaved: () => void }) {
  const cur = data?.settings.retentionDays ?? 7;
  const [days, setDays] = useState(String(cur));
  // Follow the saved value when it changes (loaded, or saved), but not on mount: the field already starts from it, and
  // an effect run then could land after an edit made before React flushed it, undoing the edit.
  const shown = useRef(cur);
  useEffect(() => {
    if (shown.current === cur) return;
    shown.current = cur;
    setDays(String(cur));
  }, [cur]);
  const { run, busy } = useAction();
  const max = data?.settings.maxRetentionDays ?? 90;
  const value = Number(days);
  const valid = days.trim() !== '' && Number.isInteger(value) && value >= 0 && value <= max;
  return (
    <section className="card" aria-labelledby="tc-ret">
      <h2 id="tc-ret">How long calls are kept</h2>
      <p className="muted small-text">
        Older calls are removed automatically. 0 switches recording off (and removes what is kept). Applies at
        once.
      </p>
      <div className="field-row">
        <div>
          <label htmlFor="tc-days">Keep for (days, 0 to {max})</label>
          <input
            id="tc-days"
            inputMode="numeric"
            size={5}
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </div>
        <Button
          variant="primary"
          busy={busy}
          disabled={!valid || value === cur}
          onClick={() =>
            void run(
              () => api.put('/tool-calls/retention', { days: value, confirm: true }),
              'Retention saved.',
            ).then(onSaved)
          }
        >
          Save
        </Button>
      </div>
    </section>
  );
}

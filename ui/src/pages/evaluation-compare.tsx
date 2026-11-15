import { useState } from 'react';
import { Badge, Button, ErrorNote, Loading } from '../components';
import { fmtTime } from '../format';
import { useApi } from '../hooks';
import { ASSISTANT_NAME } from './evaluation-shared';
import type { EvaluationComparison, EvaluationRunSummary, EvaluationScenarioComparison } from '../types';

const MOVE_TONE = { better: 'ok', worse: 'bad', same: 'neutral', new: 'info', unknown: 'neutral' } as const;
const MOVE_LABEL = {
  better: 'better',
  worse: 'worse',
  same: 'same',
  new: 'new',
  unknown: 'not comparable',
} as const;

const runLabel = (r: EvaluationRunSummary) => `${ASSISTANT_NAME[r.assistant]}, ${fmtTime(r.createdAt)}`;

/** Compares two saved runs: grade changes, tools added and removed, error codes that appeared or went away. */
export function ComparePanel({ runs }: { runs: EvaluationRunSummary[] }) {
  // `runs` is newest first: by default the earlier run is the second-newest and the later the newest.
  const [a, setA] = useState(runs[1]?.id ?? '');
  const [b, setB] = useState(runs[0]?.id ?? '');
  const [go, setGo] = useState<{ a: string; b: string } | null>(null);
  const cmp = useApi<{ comparison: EvaluationComparison }>(
    go ? `/evaluation/compare?a=${encodeURIComponent(go.a)}&b=${encodeURIComponent(go.b)}` : null,
  );
  return (
    <div className="stack" data-testid="compare">
      <div className="field-row">
        <div>
          <label htmlFor="ev-cmp-a">Earlier run</label>
          <select id="ev-cmp-a" value={a} onChange={(e) => setA(e.target.value)}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {runLabel(r)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ev-cmp-b">Later run</label>
          <select id="ev-cmp-b" value={b} onChange={(e) => setB(e.target.value)}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {runLabel(r)}
              </option>
            ))}
          </select>
        </div>
        <Button variant="primary" disabled={a === b || !a || !b} onClick={() => setGo({ a, b })}>
          Compare
        </Button>
      </div>
      {a === b && <p className="muted small-text">Choose two different runs.</p>}
      {go && cmp.error && <ErrorNote error={cmp.error} onRetry={cmp.reload} />}
      {go && !cmp.data && !cmp.error && <Loading />}
      {go && cmp.data && <ComparisonView c={cmp.data.comparison} />}
    </div>
  );
}

function toolDelta(list: { tool: string; from: number; to: number }[]): string {
  return list.map((t) => `${t.tool} (${t.from} → ${t.to})`).join(', ');
}

function Row({ s }: { s: EvaluationScenarioComparison }) {
  const tools = [
    s.toolsAdded.length > 0 ? `added ${toolDelta(s.toolsAdded)}` : '',
    s.toolsRemoved.length > 0 ? `removed ${toolDelta(s.toolsRemoved)}` : '',
  ].filter(Boolean);
  const codes = [
    s.codesAppeared.length > 0 ? `appeared ${s.codesAppeared.join(', ')}` : '',
    s.codesGone.length > 0 ? `gone ${s.codesGone.join(', ')}` : '',
  ].filter(Boolean);
  return (
    <tr data-compare={s.scenarioId}>
      <td className="num">{s.scenarioId}</td>
      <td>{s.shortTitle}</td>
      <td>
        <Badge tone={MOVE_TONE[s.movement]}>{MOVE_LABEL[s.movement]}</Badge>{' '}
        <span className="small-text">{s.gradeText}</span>
      </td>
      <td className="small-text">
        {s.callsA} → {s.callsB} calls{tools.length > 0 ? `; ${tools.join('; ')}` : ''}
      </td>
      <td className="small-text mono">{codes.length > 0 ? codes.join('; ') : '–'}</td>
    </tr>
  );
}

function ComparisonView({ c }: { c: EvaluationComparison }) {
  return (
    <div className="stack">
      <p className="muted small-text">
        {ASSISTANT_NAME[c.a.assistant as 'chatgpt' | 'claude'] ?? c.a.assistant}, {fmtTime(c.a.createdAt)} →{' '}
        {ASSISTANT_NAME[c.b.assistant as 'chatgpt' | 'claude'] ?? c.b.assistant}, {fmtTime(c.b.createdAt)};{' '}
        {c.commonScenarios} scenarios recorded in both.
      </p>
      <ul data-testid="compare-summary">
        {c.summary.map((line) => (
          <li key={line} className="mono">
            {line}
          </li>
        ))}
      </ul>
      {c.scenarios.length === 0 ? null : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Scenario</th>
                <th>Grade</th>
                <th>Tools called</th>
                <th>Error codes</th>
              </tr>
            </thead>
            <tbody>
              {c.scenarios.map((s) => (
                <Row key={s.scenarioId} s={s} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

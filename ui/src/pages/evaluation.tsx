import { useState } from 'react';
import { api } from '../api';
import { Badge, Button, Empty, ErrorNote, Loading, useAction, useConfirm } from '../components';
import { fmtTime } from '../format';
import { useApi } from '../hooks';
import type {
  EvaluationAssistant,
  EvaluationRunResponse,
  EvaluationRunSummary,
  EvaluationRunsResponse,
  EvaluationScenarios,
  EvaluationSet,
} from '../types';
import { ComparePanel } from './evaluation-compare';
import { ASSISTANT_NAME } from './evaluation-shared';
import { RunDetail } from './evaluation-run';

const SET_NAME: Record<EvaluationSet, string> = { core: 'Core', all: 'All' };

/**
 * The Evaluation helper (v2 E3, ADR 0045; docs/dashboard.md): makes the manual evaluation repeatable. Pick an assistant and
 * a set of scenarios, copy each prompt into a fresh chat, press Start before and Done after, and the bridge records the
 * tool calls of that assistant's connections in between. You confirm Right, Partly or Wrong (the automatic grade is only a
 * hint); the run is saved, and gives a results table to copy and a comparison with an earlier run. For you only.
 */
export function EvaluationPanel({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="card" aria-labelledby="ev-title">
      <div className="row row-between">
        <h2 id="ev-title">Evaluation</h2>
        <Button aria-expanded={open} aria-controls="ev-body" onClick={() => setOpen(!open)}>
          {open ? 'Close the evaluation helper' : 'Open the evaluation helper'}
        </Button>
      </div>
      <p className="muted small-text">
        Run the scripted scenarios in ChatGPT or Claude and keep what the bridge saw: which tools were called,
        with which errors, and whether you judged it right. Only you can see this; agents cannot.
      </p>
      {open && (
        <div id="ev-body">
          <EvaluationBody />
        </div>
      )}
    </section>
  );
}

function EvaluationBody() {
  const scenarios = useApi<EvaluationScenarios>('/evaluation/scenarios');
  const runs = useApi<EvaluationRunsResponse>('/evaluation/runs');
  const [selected, setSelected] = useState<string | null>(null);
  const [showCompare, setShowCompare] = useState(false);
  const confirm = useConfirm();
  const { run: act, busy } = useAction();

  const remove = async (r: EvaluationRunSummary) => {
    const ok = await confirm({
      title: 'Delete this run?',
      message: `The ${ASSISTANT_NAME[r.assistant]} run of ${fmtTime(r.createdAt)} and everything recorded in it will be removed. This cannot be undone.`,
      confirmLabel: 'Delete the run',
      danger: true,
    });
    if (!ok) return;
    const done = await act(
      () => api.post(`/evaluation/runs/${r.id}/delete`, { confirm: true }),
      'The run was deleted.',
    );
    if (done !== undefined) {
      if (selected === r.id) setSelected(null);
      runs.reload();
    }
  };

  if (scenarios.error) return <ErrorNote error={scenarios.error} onRetry={scenarios.reload} />;
  if (!scenarios.data || !runs.data) return <Loading />;
  const data = runs.data;
  return (
    <div className="stack">
      {!data.recording && (
        <p className="note note-warn" role="alert">
          Recording of tool calls is switched off (retention 0 days), so a scenario cannot be started. Set a
          number of days under “How long calls are kept”.
        </p>
      )}
      <NewRun
        scenarios={scenarios.data}
        onCreated={(id) => {
          setSelected(id);
          runs.reload();
        }}
      />
      <h3>Saved runs</h3>
      {data.runs.length === 0 ? (
        <Empty>No runs yet. Make one above.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Assistant</th>
                <th>Scenarios</th>
                <th>Bridge version</th>
                <th>Status</th>
                <th>Progress</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id} data-run={r.id} className={selected === r.id ? 'selected' : ''}>
                  <td>{fmtTime(r.createdAt)}</td>
                  <td>{ASSISTANT_NAME[r.assistant]}</td>
                  <td>{SET_NAME[r.set]}</td>
                  <td className="mono">{r.bridgeVersion}</td>
                  <td>
                    <Badge tone={r.status === 'finished' ? 'ok' : 'info'}>
                      {r.status === 'finished' ? 'Finished' : 'In progress'}
                    </Badge>
                  </td>
                  <td className="small-text">
                    {r.progress.done} of {r.progress.total} recorded, {r.progress.graded} graded
                  </td>
                  <td>
                    <div className="row">
                      <Button onClick={() => setSelected(selected === r.id ? null : r.id)}>
                        {selected === r.id ? 'Close' : 'Open'}
                      </Button>
                      <Button variant="danger" busy={busy} onClick={() => void remove(r)}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && (
        <RunDetail
          key={selected}
          runId={selected}
          scenarios={scenarios.data}
          recordingOn={data.recording}
          onChanged={runs.reload}
        />
      )}
      {data.runs.length >= 2 && (
        <div>
          <Button aria-expanded={showCompare} onClick={() => setShowCompare(!showCompare)}>
            {showCompare ? 'Hide the comparison' : 'Compare two runs'}
          </Button>
          {showCompare && <ComparePanel runs={data.runs} />}
        </div>
      )}
    </div>
  );
}

function NewRun({
  scenarios,
  onCreated,
}: {
  scenarios: EvaluationScenarios;
  onCreated: (id: string) => void;
}) {
  const [assistant, setAssistant] = useState<EvaluationAssistant>('chatgpt');
  const [set, setSet] = useState<EvaluationSet>('core');
  const { run: act, busy } = useAction();
  const count = (s: EvaluationSet) =>
    scenarios.scenarios.filter((x) => x.assistants.includes(assistant) && (s === 'all' || x.core)).length;
  return (
    <div>
      <h3>New run</h3>
      <div className="field-row">
        <div>
          <label htmlFor="ev-assistant">Assistant</label>
          <select
            id="ev-assistant"
            value={assistant}
            onChange={(e) => setAssistant(e.target.value as EvaluationAssistant)}
          >
            <option value="chatgpt">ChatGPT</option>
            <option value="claude">Claude</option>
          </select>
        </div>
        <div>
          <label htmlFor="ev-set">Scenarios</label>
          <select id="ev-set" value={set} onChange={(e) => setSet(e.target.value as EvaluationSet)}>
            <option value="core">Core ({count('core')} scenarios)</option>
            <option value="all">All ({count('all')} scenarios)</option>
          </select>
        </div>
        <Button
          variant="primary"
          busy={busy}
          onClick={() =>
            void act(
              () => api.post<EvaluationRunResponse>('/evaluation/runs', { assistant, set }),
              'The run was made.',
            ).then((r) => r && onCreated(r.run.id))
          }
        >
          Make the run
        </Button>
      </div>
      <p className="muted small-text">
        The core set is the shortlist (1, 4 to 11, 13, 14, 16, 18, 21, 26, 28 and 29); run it first. Each run
        saves the bridge version it was made on.
      </p>
    </div>
  );
}

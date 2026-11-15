import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Button, CopyButton, Empty, ErrorNote, Loading, useAction } from '../components';
import { fmtTime, principalText } from '../format';
import { useApi } from '../hooks';
import type {
  EvaluationAutoGrade,
  EvaluationConnectionsResponse,
  EvaluationHint,
  EvaluationResult,
  EvaluationRunResponse,
  EvaluationScenario,
  EvaluationScenarios,
  OwnerGrade,
} from '../types';
import { ASSISTANT_NAME } from './evaluation-shared';

const GRADE_LABEL: Record<OwnerGrade, string> = { right: 'Right', partly: 'Partly', wrong: 'Wrong' };
export const HINT_LABEL: Record<EvaluationHint, string> = {
  looks_right: 'Looks right',
  check: 'Check it',
  looks_wrong: 'Looks wrong',
  no_calls: 'No calls recorded',
};
const HINT_TONE: Record<EvaluationHint, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  looks_right: 'ok',
  check: 'warn',
  looks_wrong: 'bad',
  no_calls: 'neutral',
};

/** One run: its connections, each scenario with its prompts, Start and Done, the hint, the grade, and the results table. */
export function RunDetail({
  runId,
  scenarios,
  recordingOn,
  onChanged,
}: {
  runId: string;
  scenarios: EvaluationScenarios;
  recordingOn: boolean;
  onChanged: () => void;
}) {
  const res = useApi<EvaluationRunResponse>(`/evaluation/runs/${runId}`);
  const table = useApi<{ markdown: string }>(`/evaluation/runs/${runId}/table`);
  const { run: act, busy } = useAction();
  // The connections to record: none chosen = the bridge recognises them (ChatGPT's or Claude's) at each Start.
  const [picked, setPicked] = useState<string[]>([]);
  const r = res.data?.run;
  const byId = new Map(scenarios.scenarios.map((s) => [s.id, s]));

  const apply = async (call: () => Promise<EvaluationRunResponse>, ok?: string) => {
    const out = await act(call, ok);
    if (out) {
      res.set(() => out);
      table.reload();
      onChanged();
    }
    return out;
  };

  if (res.error) return <ErrorNote error={res.error} onRetry={res.reload} />;
  if (!r) return <Loading />;
  const recording = r.results.some((x) => x.state === 'recording');
  return (
    <section className="card" aria-label={`Run of ${fmtTime(r.createdAt)}`} data-testid="run-detail">
      <div className="row row-between">
        <h3>
          {ASSISTANT_NAME[r.assistant]} run, {fmtTime(r.createdAt)}
        </h3>
        <div className="row">
          <Badge tone={r.status === 'finished' ? 'ok' : 'info'}>
            {r.status === 'finished' ? 'Finished' : 'In progress'}
          </Badge>
          <span className="muted small-text">bridge {r.bridgeVersion}</span>
          {r.status === 'in_progress' && (
            <Button
              busy={busy}
              disabled={recording}
              title={recording ? 'Press Done for the scenario that is recording first' : undefined}
              onClick={() =>
                void apply(() => api.post(`/evaluation/runs/${r.id}/finish`), 'The run is finished.')
              }
            >
              Finish the run
            </Button>
          )}
        </div>
      </div>
      {r.status === 'in_progress' && (
        <ConnectionPicker
          assistant={r.assistant}
          picked={picked}
          onPick={setPicked}
          runPicked={r.principalIds}
        />
      )}
      <ol className="plain stack">
        {r.results.map((result) => {
          const s = byId.get(result.scenarioId);
          return (
            <ScenarioCard
              key={result.scenarioId}
              result={result}
              scenario={s}
              run={r}
              names={res.data?.principals}
              busy={busy}
              recordingOn={recordingOn}
              anyRecording={recording}
              onStart={() =>
                apply(() =>
                  api.post(`/evaluation/runs/${r.id}/scenarios/${result.scenarioId}/start`, {
                    ...(picked.length > 0 ? { principalIds: picked } : {}),
                  }),
                )
              }
              onDone={() =>
                apply(
                  () => api.post(`/evaluation/runs/${r.id}/scenarios/${result.scenarioId}/done`),
                  'Recorded.',
                )
              }
              onReset={() =>
                apply(() => api.post(`/evaluation/runs/${r.id}/scenarios/${result.scenarioId}/reset`))
              }
              onRefresh={res.reload}
              onGrade={(grade, note) =>
                apply(
                  () =>
                    api.put(`/evaluation/runs/${r.id}/scenarios/${result.scenarioId}/grade`, { grade, note }),
                  'Saved.',
                )
              }
            />
          );
        })}
      </ol>
      <h4>Results table</h4>
      {table.error ? (
        <ErrorNote error={table.error} onRetry={table.reload} />
      ) : !table.data ? (
        <Loading />
      ) : r.progress.done === 0 ? (
        <Empty>Nothing is recorded yet. The table lists the scenarios you have pressed Done for.</Empty>
      ) : (
        <>
          <div className="row">
            <CopyButton text={table.data.markdown} label="Copy the results table" />
            <span className="muted small-text">
              Markdown, in the format of your own table. Tools are in the order called; “guide” is
              get_bridge_guide.
            </span>
          </div>
          <pre className="results-table" data-testid="results-table">
            {table.data.markdown}
          </pre>
        </>
      )}
    </section>
  );
}

function ScenarioCard({
  result,
  scenario,
  run,
  names,
  busy,
  recordingOn,
  anyRecording,
  onStart,
  onDone,
  onReset,
  onRefresh,
  onGrade,
}: {
  result: EvaluationResult;
  scenario: EvaluationScenario | undefined;
  run: EvaluationRunResponse['run'];
  names: EvaluationRunResponse['principals'] | undefined;
  busy: boolean;
  recordingOn: boolean;
  anyRecording: boolean;
  onStart: () => Promise<unknown>;
  onDone: () => Promise<unknown>;
  onReset: () => Promise<unknown>;
  onRefresh: () => void;
  onGrade: (grade: OwnerGrade | null, note: string) => Promise<unknown>;
}) {
  const [note, setNote] = useState(result.note);
  useEffect(() => setNote(result.note), [result.note]);
  const finished = run.status === 'finished';
  const title = scenario?.title ?? result.title;
  return (
    <li
      className="card"
      data-scenario={result.scenarioId}
      aria-label={`Scenario ${result.scenarioId}: ${title}`}
    >
      <div className="row row-between">
        <strong>
          {result.scenarioId}. {title}
        </strong>
        <div className="row">
          {scenario?.needsApproval && run.assistant === 'chatgpt' && (
            <Badge tone="info">needs your approval</Badge>
          )}
          {scenario?.alwaysProposal && <Badge tone="info">always a proposal</Badge>}
          <Badge tone={result.state === 'done' ? 'ok' : result.state === 'recording' ? 'warn' : 'neutral'}>
            {result.state === 'done'
              ? 'Recorded'
              : result.state === 'recording'
                ? 'Recording'
                : 'Not started'}
          </Badge>
        </div>
      </div>
      {scenario && result.state !== 'done' && (
        <>
          {scenario.dependsOn.length > 0 && (
            <p className="muted small-text">Needs scenarios {scenario.dependsOn.join(', ')} first.</p>
          )}
          {scenario.setupNote && <p className="muted small-text">{scenario.setupNote}</p>}
          {scenario.copy.map((text, i) => (
            <div key={i} className="stack">
              <div className="row row-between">
                <span className="muted small-text">
                  {scenario.prompts.length > 1 ? `Prompt ${i + 1} of ${scenario.prompts.length}` : 'Prompt'}
                  {i === 0 && scenario.freshChat
                    ? ', with the preamble, in a fresh chat'
                    : ', in the same chat'}
                </span>
                <CopyButton
                  text={text}
                  label="Copy prompt"
                  what={
                    scenario.prompts.length > 1
                      ? `${i + 1} of scenario ${scenario.id}`
                      : `of scenario ${scenario.id}`
                  }
                />
              </div>
              <pre className="prompt">{text}</pre>
              {i === 0 && scenario.interlude && (
                <p className="muted small-text">Then: {scenario.interlude}</p>
              )}
            </div>
          ))}
        </>
      )}
      {!finished && result.state === 'pending' && (
        <div className="row">
          <Button
            variant="primary"
            busy={busy}
            disabled={!recordingOn || anyRecording}
            title={
              !recordingOn
                ? 'Recording is switched off'
                : anyRecording
                  ? 'Press Done for the scenario that is recording first'
                  : undefined
            }
            onClick={() => void onStart()}
          >
            Start
          </Button>
          <span className="muted small-text">
            Press Start, paste the prompt into a fresh {ASSISTANT_NAME[run.assistant]} chat, then press Done.
          </span>
        </div>
      )}
      {result.state === 'recording' && (
        <div className="stack">
          <p>
            <strong>Recording.</strong> Paste the prompt into {ASSISTANT_NAME[run.assistant]}, let it finish,
            then press Done. Calls so far: {result.live?.callCount ?? 0}
            {result.live && result.live.tools.length > 0 ? ` (${result.live.tools.join(', ')})` : ''}.
          </p>
          <p className="muted small-text">
            Recording the calls of{' '}
            {result.principalIds.map((id) => principalText(id, names)).join(', ') || 'no connection'}
            {result.connectionMode === 'auto' ? ' (recognised automatically)' : ' (chosen by you)'}.
          </p>
          <div className="row">
            <Button variant="primary" busy={busy} onClick={() => void onDone()}>
              Done
            </Button>
            <Button onClick={onRefresh}>Refresh the count</Button>
            <Button busy={busy} onClick={() => void onReset()}>
              Discard
            </Button>
          </div>
        </div>
      )}
      {result.state === 'done' && (
        <DoneBody
          result={result}
          scenario={scenario}
          names={names}
          busy={busy}
          finished={finished}
          note={note}
          setNote={setNote}
          onReset={onReset}
          onGrade={onGrade}
        />
      )}
    </li>
  );
}

function hintLines(g: EvaluationAutoGrade): string[] {
  const lines = [
    g.expectedPresent
      ? 'Expected tools present.'
      : `Expected tools missing: ${g.missingExpected.join('; ')}.`,
    g.mistakeTools.length > 0 ? `Mistake tools present: ${g.mistakeTools.join(', ')}.` : 'No mistake tools.',
    g.errorCodes.length > 0
      ? `Error codes seen: ${g.errorCodes.map((e) => (e.count > 1 ? `${e.code} ×${e.count}` : e.code)).join(', ')}.`
      : 'No error codes.',
    `${g.callCount} ${g.callCount === 1 ? 'call' : 'calls'}.`,
  ];
  if (g.writesWithoutBaseVersion > 0)
    lines.push(`${g.writesWithoutBaseVersion} write without a base version.`);
  return lines;
}

function DoneBody({
  result,
  scenario,
  names,
  busy,
  finished,
  note,
  setNote,
  onReset,
  onGrade,
}: {
  result: EvaluationResult;
  scenario: EvaluationScenario | undefined;
  names: EvaluationRunResponse['principals'] | undefined;
  busy: boolean;
  finished: boolean;
  note: string;
  setNote: (v: string) => void;
  onReset: () => Promise<unknown>;
  onGrade: (grade: OwnerGrade | null, note: string) => Promise<unknown>;
}) {
  const g = result.autoGrade;
  return (
    <div className="stack">
      <p>
        <span className="muted small-text">Tools called: </span>
        <span className="mono" data-testid={`sequence-${result.scenarioId}`}>
          {result.sequence}
        </span>
      </p>
      {g && (
        <div data-testid={`hint-${result.scenarioId}`}>
          <Badge tone={HINT_TONE[g.hint]}>{HINT_LABEL[g.hint]}</Badge>{' '}
          <span className="muted small-text">
            A hint only: {hintLines(g).join(' ')} Your grade below is the one that counts.
          </span>
        </div>
      )}
      {scenario && (
        <p className="muted small-text">
          Expected: {scenario.expectedNote} Watch for: {scenario.watchFor}
        </p>
      )}
      <p className="muted small-text">
        Recorded {fmtTime(result.finishedAt)} from{' '}
        {result.principalIds.map((id) => principalText(id, names)).join(', ')}.
      </p>
      <div className="row" role="group" aria-label={`Your grade for scenario ${result.scenarioId}`}>
        {(['right', 'partly', 'wrong'] as const).map((grade) => (
          <button
            key={grade}
            type="button"
            className={result.ownerGrade === grade ? 'primary' : ''}
            aria-pressed={result.ownerGrade === grade}
            disabled={busy}
            onClick={() => void onGrade(result.ownerGrade === grade ? null : grade, note)}
          >
            {GRADE_LABEL[grade]}
          </button>
        ))}
        <span className="muted small-text">
          {result.ownerGrade ? `You graded this ${GRADE_LABEL[result.ownerGrade]}.` : 'Not graded yet.'}
        </span>
      </div>
      <div className="field-row">
        <div>
          <label htmlFor={`ev-note-${result.scenarioId}`}>Note (optional)</label>
          <input
            id={`ev-note-${result.scenarioId}`}
            size={50}
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <Button
          busy={busy}
          disabled={note === result.note}
          onClick={() => void onGrade(result.ownerGrade, note)}
        >
          Save the note
        </Button>
        {!finished && (
          <Button busy={busy} onClick={() => void onReset()}>
            Redo this scenario
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Which connections to record. Automatic: the bridge picks the active connections it recognises as the assistant's
 * (by the OAuth redirect host, then the client or token name, then the profile name). If it cannot tell, or tells wrongly,
 * choose them yourself: only those are recorded.
 */
function ConnectionPicker({
  assistant,
  picked,
  onPick,
  runPicked,
}: {
  assistant: 'chatgpt' | 'claude';
  picked: string[];
  onPick: (ids: string[]) => void;
  runPicked: string[] | null;
}) {
  const conns = useApi<EvaluationConnectionsResponse>(`/evaluation/connections?assistant=${assistant}`);
  const [manual, setManual] = useState(false);
  const d = conns.data;
  const recognised = d ? d.connections.filter((c) => d.recognised.includes(c.id)) : [];
  return (
    <fieldset className="plain stack">
      <legend>Connections to record</legend>
      {runPicked && (
        <p className="muted small-text">
          This run was made with {runPicked.length} connection(s) chosen by you.
        </p>
      )}
      <ErrorNote error={conns.error} onRetry={conns.reload} />
      {!d ? (
        <Loading />
      ) : (
        <>
          <label className="inline" htmlFor="ev-conn-auto">
            <input
              id="ev-conn-auto"
              type="radio"
              name="ev-conn-mode"
              checked={!manual}
              onChange={() => {
                setManual(false);
                onPick([]);
              }}
            />{' '}
            Recognise {ASSISTANT_NAME[assistant]} automatically
            <span className="muted small-text">
              {' '}
              {recognised.length > 0
                ? `(${recognised.map((c) => c.name).join(', ')})`
                : '(no active connection is recognised: choose one)'}
            </span>
          </label>
          <label className="inline" htmlFor="ev-conn-manual">
            <input
              id="ev-conn-manual"
              type="radio"
              name="ev-conn-mode"
              checked={manual}
              onChange={() => setManual(true)}
            />{' '}
            Choose the connections myself
          </label>
          {manual && (
            <ul className="plain">
              {d.connections.map((c) => (
                <li key={c.id}>
                  <label className="inline" htmlFor={`ev-conn-${c.id}`}>
                    <input
                      id={`ev-conn-${c.id}`}
                      type="checkbox"
                      checked={picked.includes(c.id)}
                      onChange={(e) =>
                        onPick(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))
                      }
                    />{' '}
                    {c.name}
                    <span className="muted small-text">
                      {' '}
                      {c.type === 'grant' ? 'OAuth' : 'token'}
                      {c.profile ? `, profile ${c.profile}` : ''}
                      {c.assistant
                        ? `, looks like ${ASSISTANT_NAME[c.assistant]} (${c.reason})`
                        : ', not recognised'}
                      {c.removed ? ', removed' : c.active ? '' : ', inactive'}; {c.calls}{' '}
                      {c.calls === 1 ? 'call' : 'calls'} kept
                      {c.lastCallAt ? `, the last at ${fmtTime(c.lastCallAt)}` : ''}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {manual && picked.length === 0 && (
            <p className="muted small-text">Tick at least one connection, or go back to automatic.</p>
          )}
        </>
      )}
    </fieldset>
  );
}

/**
 * v3 F4b (ADR 0064, design D6): "Pick the right value" on a consistency finding of the Audits page. Both (or all) values
 * side by side, each with its page, lifecycle, section and excerpt; the agents' suggestions (shown, never applied) and
 * the owner's earlier picks. The owner picks one value or types the right one: a step-up action (ADR 0062), after which
 * the bridge proposes ONE proposal editing every page that disagrees, for the owner to approve on the Proposals page.
 */
import { useState } from 'react';
import { api } from '../api';
import { Badge, Button, ErrorNote, Loading, useAction, useConfirm } from '../components';
import { fmtTime } from '../format';
import { useScopedApi } from '../project';
import { Link } from '../router';

interface ValueView {
  readonly key: string;
  readonly page: { readonly id: string; readonly name: string };
  readonly lifecycle: string | null;
  readonly value: string;
  readonly precision?: string;
  readonly source: string;
  readonly section?: string;
  readonly excerpt: string;
}

interface ConsistencyView {
  readonly finding: { readonly id: number; readonly consistencyId: string; readonly message: string };
  readonly subject: string | null;
  readonly what: string | null;
  readonly values: readonly ValueView[];
  readonly suggestions: readonly {
    readonly id: number;
    readonly value: string;
    readonly reason: string;
    readonly principalId: string;
    readonly createdAt: string;
  }[];
  readonly picks: readonly {
    readonly id: string;
    readonly value: string;
    readonly pickedAt: string;
    readonly proposalId: string | null;
  }[];
  readonly rule: string;
}

interface PickResponse {
  readonly proposalId: string;
  readonly items: readonly { readonly id: string; readonly label: string }[];
  readonly untouched: readonly { readonly page: string; readonly value: string; readonly why: string }[];
  readonly notPlanned?: readonly { readonly page: string; readonly from: string; readonly why: string }[];
}

const SOURCE: Readonly<Record<string, string>> = {
  temporalScope: 'Temporal Scope',
  lifeState: 'Life State',
  sidebar: 'sidebar field',
  prose: 'a sentence',
  chronology: 'a chronology row',
};

export function ConsistencyPick({
  findingId,
  project,
  colspan,
  reload,
}: {
  findingId: number;
  project: string | null;
  colspan: number;
  reload: () => void;
}) {
  const r = useScopedApi<ConsistencyView>(`/audits/findings/${findingId}/consistency`);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<PickResponse | null>(null);
  const pick = async (choice: { side: string; label: string } | { value: string; label: string }) => {
    const yes = await confirm({
      title: 'Pick this value?',
      message: (
        <p>
          <strong>{choice.label}</strong> becomes the value: the bridge proposes edits to every page that
          disagrees with it (never the side you picked). Nothing is written until you approve the proposal.
        </p>
      ),
      confirmLabel: 'Pick and propose',
    });
    if (!yes) return;
    const body = 'side' in choice ? { side: choice.side } : { value: choice.value };
    let out: PickResponse | null = null;
    const ok = await run(async () => {
      out = await api.post<PickResponse>(`/audits/findings/${findingId}/consistency-pick`, {
        confirm: true,
        project,
        ...body,
      });
    }, 'Proposed: approve it on the Proposals page.');
    if (ok && out) {
      setResult(out);
      r.reload();
      reload();
    }
  };
  return (
    <tr data-consistency={findingId}>
      <td colSpan={colspan}>
        {r.loading && !r.data && <Loading />}
        {r.error && <ErrorNote error={r.error} />}
        {r.data && (
          <div className="stack">
            <p className="small-text muted">{r.data.rule}</p>
            <table aria-label="The values side by side">
              <thead>
                <tr>
                  <th>Value</th>
                  <th>Page</th>
                  <th>Where</th>
                  <th>Pick</th>
                </tr>
              </thead>
              <tbody>
                {r.data.values.map((v, i) => (
                  <tr key={v.key} data-value={v.key}>
                    <td>
                      <strong>{v.value}</strong>
                      {v.precision && <span className="muted small-text"> ({v.precision})</span>}
                      {i === 0 && (
                        <div className="small-text muted">the identity page’s value (shown first)</div>
                      )}
                    </td>
                    <td className="small-text">
                      {v.page.name}{' '}
                      {v.lifecycle && (
                        <Badge tone={v.lifecycle === 'Authoritative' ? 'ok' : 'info'}>{v.lifecycle}</Badge>
                      )}
                    </td>
                    <td className="small-text">
                      {SOURCE[v.source] ?? v.source}
                      {v.section ? ` · ${v.section}` : ''}
                      <div className="muted">“{v.excerpt}”</div>
                    </td>
                    <td>
                      <Button
                        className="small"
                        busy={busy}
                        disabled={!project}
                        onClick={() => void pick({ side: v.key, label: `${v.value} (as on ${v.page.name})` })}
                      >
                        Pick this value
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (typed.trim() !== '') void pick({ value: typed.trim(), label: typed.trim() });
              }}
            >
              <label htmlFor={`pick-${findingId}`}>Or the right value</label>
              <input
                id={`pick-${findingId}`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="Camue 1st, 4A 100"
                maxLength={300}
              />
              <Button type="submit" busy={busy} disabled={!project || typed.trim() === ''}>
                Propose this value
              </Button>
            </form>
            {r.data.suggestions.length > 0 && (
              <div className="small-text">
                <strong>Suggested by agents</strong> (a suggestion, never applied):
                <ul>
                  {r.data.suggestions.map((s) => (
                    <li key={s.id}>
                      <strong>{s.value}</strong>: {s.reason}{' '}
                      <span className="muted">
                        ({s.principalId}, {fmtTime(Date.parse(s.createdAt))})
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {r.data.picks.length > 0 && (
              <div className="small-text muted">
                Picked before:{' '}
                {r.data.picks
                  .map(
                    (p) =>
                      `${p.value} (${fmtTime(Date.parse(p.pickedAt))}${p.proposalId ? `, ${p.proposalId}` : ''})`,
                  )
                  .join('; ')}
              </div>
            )}
            {result && (
              <div className="small-text note note-ok">
                Proposed <code>{result.proposalId}</code> ({result.items.length} page
                {result.items.length === 1 ? '' : 's'}): approve it on the{' '}
                <Link to="/proposals">Proposals</Link> page.
                {result.notPlanned && result.notPlanned.length > 0 && (
                  <> Not planned: {result.notPlanned.map((n) => `${n.page} (${n.why})`).join('; ')}.</>
                )}
              </div>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

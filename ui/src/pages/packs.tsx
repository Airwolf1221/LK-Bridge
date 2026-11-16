import { useState } from 'react';
import { api } from '../api';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, useAction, useConfirm } from '../components';
import { useApi } from '../hooks';
import { useReauth } from '../reauth';
import type { PackGovernance, PackView, PacksResponse } from '../types';

/**
 * Packs (v3 F3a, ADR 0050): each setting pack's rules, read-only (they are data, versioned; the token
 * maps below make a new version), the governance sources the rules were derived from with the versions the owner
 * approved, the projects the pack is attached to (and its template ids there), and its versions. Two changes, each asking
 * for your password again: **Approve this pack version** (records every governance source's document version, read now)
 * and **Save token maps** (race and culture → tag token: a new version, which then waits for approval). Until the
 * current version is approved and every source is as approved, the pack's tools compute no tags (fail closed).
 */
const STATE_TONE: Record<PackGovernance['state'], 'ok' | 'warn' | 'bad'> = {
  current: 'ok',
  changed: 'bad',
  unapproved: 'warn',
  rules_changed: 'warn',
  unreadable: 'bad',
};
const STATE_LABEL: Record<PackGovernance['state'], string> = {
  current: 'approved and current',
  changed: 'governance changed since approval',
  unapproved: 'not approved yet',
  rules_changed: 'rules changed since approval',
  unreadable: 'governance unreadable',
};

export function PacksPage() {
  const r = useApi<PacksResponse>('/packs');
  if (!r.data) return r.error ? <ErrorNote error={r.error} onRetry={r.reload} /> : <Loading />;
  return (
    <>
      <PageHeader title="Packs">
        <button type="button" className="small" onClick={r.reload}>
          Refresh
        </button>
      </PageHeader>
      <p className="muted">
        A setting pack holds one setting’s rules as data: its page types, templates by role, names, placement,
        sidebar facts, the closed tag grammar and its token maps, the text rules. Its tools carry its prefix
        and are listed only while it is attached to a project the bridge serves. The rules are derived from
        the setting’s governance pages, never competing with them: when a source changes, no tags are computed
        until you check the rules and approve the pack again.
      </p>
      {r.data.packs.length === 0 ? (
        <Empty>No pack is stored.</Empty>
      ) : (
        r.data.packs.map((p) => <PackCard key={p.id} pack={p} onChanged={r.reload} />)
      )}
    </>
  );
}

function PackCard({ pack, onChanged }: { pack: PackView; onChanged: () => void }) {
  const confirm = useConfirm();
  const withReauth = useReauth();
  const { run, busy } = useAction();
  const [gov, setGov] = useState<PackGovernance | null>(null);
  const check = () =>
    void run(() => api.get<{ governance: PackGovernance }>(`/packs/${pack.id}/governance`)).then((x) => {
      if (x) setGov(x.governance);
    });
  const approve = () =>
    void confirm({
      title: `Approve the ${pack.name} pack, version ${pack.version}?`,
      message: (
        <>
          <p>
            Its rules (below) become the rules its tools use, and each governance source’s current document
            version is recorded with the approval. Check the rules and the token maps first.
          </p>
        </>
      ),
      confirmLabel: 'Approve this version',
    }).then((ok) => {
      if (!ok) return;
      void run(
        () =>
          withReauth(() =>
            api.post<{ governance: PackGovernance }>(`/packs/${pack.id}/approve`, { confirm: true }),
          ),
        `${pack.name} version ${pack.version} approved.`,
      ).then((x) => {
        if (x) setGov(x.governance);
        onChanged();
      });
    });
  const approved = pack.approved;
  const state: PackGovernance['state'] =
    gov?.state ??
    (!approved
      ? 'unapproved'
      : approved.version !== pack.version
        ? 'rules_changed'
        : pack.drift
          ? 'changed'
          : 'current');
  return (
    <section className="card" aria-labelledby={`pack-${pack.id}-h`} data-pack={pack.id}>
      <h2 id={`pack-${pack.id}-h`}>
        {pack.name}{' '}
        <span className="muted small-text">
          ({pack.id}, version {pack.version})
        </span>{' '}
        <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
      </h2>
      {(gov?.message ?? (state !== 'current' ? null : null)) && <p className="note">{gov?.message}</p>}
      {pack.drift && !gov && (
        <p className="note note-bad" role="alert">
          Governance changed since the approval: {pack.drift.changed.map((c) => c.name).join(', ')}. No tags
          are computed until you check the rules and approve again.
        </p>
      )}
      <dl className="kv">
        <dt>Tools</dt>
        <dd className="mono">{pack.tools.join(', ')}</dd>
        <dt>Approved</dt>
        <dd>
          {approved
            ? `version ${approved.version} by ${approved.by}, ${new Date(approved.at).toISOString()}`
            : 'not yet'}
        </dd>
        <dt>Every package is a proposal</dt>
        <dd>{pack.rules.settings.alwaysPropose ? 'yes (the pack’s first weeks)' : 'no'}</dd>
      </dl>
      <div className="row-actions">
        <Button variant="primary" busy={busy} onClick={approve}>
          Approve this pack version
        </Button>{' '}
        <button type="button" className="small" onClick={check} disabled={busy}>
          Check governance now
        </button>
      </div>

      <h3>Governance sources</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Where</th>
              <th>Approved version</th>
              <th>Current version</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {pack.governance.map((g) => {
              const s = gov?.sources.find((x) => x.key === g.key);
              const was = approved?.sources.find((x) => x.key === g.key)?.version ?? null;
              return (
                <tr key={g.key} data-source={g.key}>
                  <td>
                    {g.name}
                    {g.label ? <span className="muted small-text"> {g.label}</span> : null}
                  </td>
                  <td className="mono small-text">
                    {g.project}: {g.resourceId}/{g.documentId}
                  </td>
                  <td className="mono">{was ?? '-'}</td>
                  <td className="mono">{s ? (s.current ?? '-') : 'not checked'}</td>
                  <td>{s ? s.state + (s.reason ? ` (${s.reason})` : '') : '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3>Projects</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Served</th>
              <th>Templates</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {pack.attachments.map((a) => (
              <tr key={a.projectId}>
                <td>{a.projectName}</td>
                <td>{a.served ? 'yes' : 'no'}</td>
                <td className="mono small-text">
                  {Object.entries(a.templates)
                    .map(([k, v]) => `${k}: ${v ?? 'unset'}`)
                    .join(', ')}
                </td>
                <td className="small-text">{a.notes.join(' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <TokenMaps pack={pack} onChanged={onChanged} />
      <Rules pack={pack} />

      <h3>Versions</h3>
      <ul className="small-text">
        {pack.versions.map((v) => (
          <li key={v.version}>
            version {v.version}: {v.reason}
            {v.approved ? ' (approved)' : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}

type Row = { key: string; token: string };
const toRows = (m: Record<string, string>): Row[] =>
  Object.entries(m).map(([key, token]) => ({ key, token }));
const toMap = (rows: Row[]) =>
  Object.fromEntries(rows.filter((r) => r.key.trim() !== '').map((r) => [r.key.trim(), r.token.trim()]));

function TokenMaps({ pack, onChanged }: { pack: PackView; onChanged: () => void }) {
  const confirm = useConfirm();
  const withReauth = useReauth();
  const { run, busy } = useAction();
  const [race, setRace] = useState<Row[]>(() => toRows(pack.rules.tags.race));
  const [culture, setCulture] = useState<Row[]>(() => toRows(pack.rules.tags.culture));
  const save = () =>
    void confirm({
      title: 'Save the token maps?',
      message: (
        <p>
          This makes version {pack.version + 1} of the {pack.name} pack. Its tools compute no tags until you
          approve that version.
        </p>
      ),
      confirmLabel: 'Save token maps',
    }).then((ok) => {
      if (!ok) return;
      void run(
        () =>
          withReauth(() =>
            api.put(`/packs/${pack.id}/tokens`, {
              race: toMap(race),
              culture: toMap(culture),
              confirm: true,
            }),
          ),
        'Token maps saved: approve the new version to use them.',
      ).then(onChanged);
    });
  return (
    <>
      <h3>Token maps</h3>
      <p className="muted small-text">
        A fact value (Race / Species, Naming Culture) and the tag token it becomes. A value with no token is
        held: left out of the tags and reported, never invented. {pack.rules.tags.never.join(', ')} are never
        tags.
      </p>
      <div className="grid-2">
        <TokenTable title="Race / Species" rows={race} onChange={setRace} />
        <TokenTable title="Naming Culture" rows={culture} onChange={setCulture} />
      </div>
      <Button busy={busy} onClick={save}>
        Save token maps
      </Button>
    </>
  );
}

function TokenTable({ title, rows, onChange }: { title: string; rows: Row[]; onChange: (r: Row[]) => void }) {
  const set = (i: number, patch: Partial<Row>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="table-wrap">
      <table aria-label={`${title} tokens`}>
        <thead>
          <tr>
            <th>{title}</th>
            <th>Tag token</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <input
                  aria-label={`${title} value ${i + 1}`}
                  value={r.key}
                  onChange={(e) => set(i, { key: e.target.value })}
                />
              </td>
              <td>
                <input
                  aria-label={`${title} token ${i + 1}`}
                  value={r.token}
                  onChange={(e) => set(i, { token: e.target.value })}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="small"
                  onClick={() => onChange(rows.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="small" onClick={() => onChange([...rows, { key: '', token: '' }])}>
        Add {title.toLowerCase()} token
      </button>
    </div>
  );
}

function Rules({ pack }: { pack: PackView }) {
  return (
    <>
      <h3>Rules (read-only)</h3>
      <dl className="kv small-text">
        <dt>Status tags</dt>
        <dd>
          {pack.rules.tags.authoritative} (Authoritative), {pack.rules.tags.working} (Working: first, no{' '}
          {pack.rules.tags.authoritative})
        </dd>
        <dt>Never in a page name</dt>
        <dd>{pack.rules.names.forbiddenWords.join(', ')}, a date, an em dash (replaced by a hyphen)</dd>
        <dt>Exceptional identity kinds</dt>
        <dd>{pack.rules.tags.exceptional.join(', ')}</dd>
      </dl>
      {pack.rules.types.map((t) => (
        <details key={t.name} data-type={t.name}>
          <summary>
            {t.name}: <span className="mono">{pack.prefix + t.tool}</span>
            {t.hook ? <span className="muted small-text"> (hook: {t.hook})</span> : null}
          </summary>
          <p className="small-text">
            Placement:{' '}
            {t.placement.kind === 'taxonomy'
              ? `by ${t.placement.field} through the ${t.placement.registryType} taxonomy; an unmatched value goes to ${t.placement.fallbackIndex}, with a warning`
              : `under ${t.placement.index}`}
            . Gated fields:{' '}
            {t.identity
              .filter((f) => f.gated)
              .map((f) => f.key)
              .join(', ') || 'none'}{' '}
            ({t.unestablished} only with a reason).
          </p>
          <div className="table-wrap">
            <table aria-label={`${t.name} roles`}>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Template</th>
                  <th>Name</th>
                  <th>Reference Type</th>
                  <th>Tags</th>
                  <th>Facts</th>
                  <th>Text</th>
                </tr>
              </thead>
              <tbody>
                {t.roles.map((r) => (
                  <tr key={r.role}>
                    <td>{r.role}</td>
                    <td>{r.template}</td>
                    <td className="mono small-text">{r.name}</td>
                    <td>{r.referenceType ?? '(from the package)'}</td>
                    <td className="mono small-text">{r.tags.join(', ') || 'none'}</td>
                    <td>{r.facts}</td>
                    <td>{r.body}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small-text">Specialist tags: {t.specialistTags.join(', ') || 'none'}.</p>
        </details>
      ))}
    </>
  );
}

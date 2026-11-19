import { Fragment, useState } from 'react';
import { ApiError, api } from '../api';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, useAction, useConfirm } from '../components';
import { useApi } from '../hooks';
import { useReauth } from '../reauth';
import type { PackGovernance, PackHomeRule, PackOwners, PackView, PacksResponse } from '../types';

/**
 * Packs (v3 F3a, ADR 0050): each setting pack's rules, read-only (they are data, versioned; the token
 * maps below make a new version), the governance sources the rules were derived from with the versions the owner
 * approved, the projects the pack is attached to (and its template ids there), and its versions. Two changes, each asking
 * for the step-up (ADR 0062): **Approve this pack version** (records every governance source's document version, read now)
 * and **Save token maps** (race and culture → tag token: a new version, which then waits for approval). Until the
 * current version is approved and every source is as approved, the pack's tools compute no tags (fail closed).
 *
 * ADR 0052 amendment (16 November 2026): when a pinned section cannot be found (an approval refused with
 * GOVERNANCE_SECTION_MISSING, or a governance check after a page renamed a pinned heading), each missing heading is shown
 * beside a picker of that page's actual headings, in order with their levels. **Re-map** (password again, audited) makes
 * a new version holding the new mapping, which the owner then approves with the rest of the version.
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
          ).catch((e: unknown) => {
            // A pinned heading not found: show the governance as read, with the picker for each missing heading.
            if (e instanceof ApiError && e.code === 'GOVERNANCE_SECTION_MISSING' && e.extra.governance)
              setGov(e.extra.governance as PackGovernance);
            throw e;
          }),
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
        <dt>{pack.toolModes ? 'Any other tool' : 'Every package is a proposal'}</dt>
        <dd>
          {pack.toolModes
            ? pack.rules.settings.alwaysPropose
              ? 'always propose'
              : 'follows the agent’s scope'
            : pack.rules.settings.alwaysPropose
              ? 'yes (the pack’s first weeks)'
              : 'no'}
        </dd>
      </dl>
      {pack.toolModes && pack.toolModes.length > 0 && <ToolSwitches pack={pack} onChanged={onChanged} />}
      <div className="row-actions">
        <Button variant="primary" busy={busy} onClick={approve}>
          Approve this pack version
        </Button>{' '}
        <button type="button" className="small" onClick={check} disabled={busy}>
          Check governance now
        </button>
      </div>

      {gov ? (
        <PinRemap
          pack={pack}
          gov={gov}
          onRemapped={(g) => {
            setGov(g);
            onChanged();
          }}
        />
      ) : null}

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
              <th>Pinned sections</th>
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
                  <td className="small-text" data-sections={g.key}>
                    {(g.sections ?? []).length === 0
                      ? 'the whole page'
                      : (g.sections ?? [])
                          .map((h) => {
                            const st = s?.sections?.find((x) => x.heading === h)?.state;
                            return st && st !== 'same' ? `${h} (${st})` : h;
                          })
                          .join('; ')}
                  </td>
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

/**
 * ADR 0052 amendment: each pinned heading the page no longer has, beside a picker of the page's actual headings (in order,
 * indented by level). Re-mapping asks for a confirmation and the password again; the new mapping is a new version.
 */
function PinRemap({
  pack,
  gov,
  onRemapped,
}: {
  pack: PackView;
  gov: PackGovernance;
  onRemapped: (g: PackGovernance) => void;
}) {
  const missing = gov.sources.flatMap((s) =>
    (s.sections ?? []).filter((x) => x.state === 'missing').map((x) => ({ source: s, heading: x.heading })),
  );
  if (missing.length === 0) return null;
  return (
    <section aria-labelledby={`pack-${pack.id}-remap`} data-remap>
      <h3 id={`pack-${pack.id}-remap`}>Pinned headings not found</h3>
      <p className="note note-bad">
        The pack’s rules were derived from these sections, and the page no longer has a heading by that name.
        If the section was renamed, pick its heading as the page has it now: the new mapping becomes part of a
        new pack version, which you then approve. If the section was removed, check the rules first.
      </p>
      <div className="table-wrap">
        <table aria-label="Pinned headings not found">
          <thead>
            <tr>
              <th>Page</th>
              <th>Pinned as</th>
              <th>The page’s heading</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {missing.map((m) => (
              <RemapRow
                key={`${m.source.key}:${m.heading}`}
                pack={pack}
                source={m.source}
                heading={m.heading}
                pinned={pack.governance.find((g) => g.key === m.source.key)?.sections ?? []}
                onRemapped={onRemapped}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RemapRow({
  pack,
  source,
  heading,
  pinned,
  onRemapped,
}: {
  pack: PackView;
  source: PackGovernance['sources'][number];
  heading: string;
  pinned: string[];
  onRemapped: (g: PackGovernance) => void;
}) {
  const confirm = useConfirm();
  const withReauth = useReauth();
  const { run, busy } = useAction();
  const [to, setTo] = useState('');
  const outline = source.outline ?? [];
  const remap = () =>
    void confirm({
      title: `Re-map “${heading}”?`,
      message: (
        <p>
          {source.name}’s pinned section “{heading}” becomes “{to}”. This makes version {pack.version + 1} of
          the {pack.name} pack; its tools compute no tags until you approve that version.
        </p>
      ),
      confirmLabel: 'Re-map this heading',
    }).then((ok) => {
      if (!ok) return;
      void run(
        () =>
          withReauth(() =>
            api.post<{ governance: PackGovernance }>(`/packs/${pack.id}/sections`, {
              source: source.key,
              from: heading,
              to,
              confirm: true,
            }),
          ),
        `Pinned heading re-mapped: approve version ${pack.version + 1} to use it.`,
      ).then((x) => {
        if (x) onRemapped(x.governance);
      });
    });
  const label = `The page’s heading for “${heading}”`;
  return (
    <tr data-remap-row={`${source.key}:${heading}`}>
      <td>{source.name}</td>
      <td>{heading}</td>
      <td>
        {outline.length === 0 ? (
          <span className="muted">The page has no headings.</span>
        ) : (
          <select aria-label={label} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose a heading…</option>
            {outline.map((h, i) => (
              <option
                key={i}
                value={h.heading}
                disabled={pinned.includes(h.heading) && h.heading !== heading}
              >
                {'\u00a0\u00a0'.repeat(Math.max(0, h.level - 1))}
                {h.heading} (level {h.level})
              </option>
            ))}
          </select>
        )}
      </td>
      <td>
        <Button busy={busy} disabled={to === ''} onClick={remap}>
          Re-map
        </Button>
      </td>
    </tr>
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
  // v3 F3f (ADR 0060): the Tagging Standard's Excluded Routine Tags (one per line).
  const [routine, setRoutine] = useState<string>(() =>
    (pack.rules.retag?.excludedRoutineTags ?? []).join('\n'),
  );
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
              ...(pack.rules.retag
                ? {
                    excludedRoutineTags: routine
                      .split('\n')
                      .map((x) => x.trim())
                      .filter((x) => x !== ''),
                  }
                : {}),
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
      {pack.rules.retag && (
        <label className="small-text">
          Excluded Routine Tags (one per line; from the Tagging Standard’s section: the only tags outside the
          grammar the retag removes by itself)
          <textarea
            aria-label="Excluded Routine Tags"
            rows={3}
            value={routine}
            onChange={(e) => setRoutine(e.target.value)}
          />
        </label>
      )}
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
        {pack.rules.tags.au ? (
          <>
            <dt>AU pages</dt>
            <dd>
              {pack.rules.tags.au.tag} in place of {pack.rules.tags.authoritative} (Continuity Type{' '}
              {pack.rules.tags.au.continuityType}); a Working page leads with {pack.rules.tags.working}
            </dd>
          </>
        ) : null}
        <dt>Lifecycle tag</dt>
        <dd>
          {Object.entries(pack.rules.lifecycleTagPosition ?? {}).filter(([, v]) => v === 'lead').length > 0
            ? `first (it leads) on ${Object.entries(pack.rules.lifecycleTagPosition ?? {})
                .filter(([, v]) => v === 'lead')
                .map(([k]) => k)
                .join(', ')}; last on every other project`
            : 'last on every project (the lifecycle tools’ default)'}
        </dd>
        {(pack.rules.rulings ?? []).map((r) => (
          <Fragment key={r.key}>
            <dt>Ruling ({r.date})</dt>
            <dd>{r.summary}</dd>
          </Fragment>
        ))}
      </dl>
      {pack.rules.owners ? <Owners pack={pack} owners={pack.rules.owners} /> : null}
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

/** v3 F3b (ADR 0052): the owner table, read-only. */
function Owners({ pack, owners }: { pack: PackView; owners: PackOwners }) {
  const home = (r: PackHomeRule): string => {
    switch (r.kind) {
      case 'category':
        return r.level === 'world'
          ? `${owners.worldPrefix} ${r.category}`
          : `<${r.level === 'continent' ? 'Continent' : 'Nation'}> ${r.category}`;
      case 'nation':
        return 'a nation index';
      case 'named':
        return r.name;
      case 'under':
        return r.label;
      case 'index':
        return `[INDEX] ${r.name}`;
      case 'races':
        return r.as === 'root'
          ? owners.races.root.name
          : r.as === 'group'
            ? 'a Racial Group Reference'
            : 'a race’s Core Information';
    }
  };
  return (
    <details data-owners>
      <summary>
        Owners: <span className="mono">{pack.prefix + owners.tool}</span>
      </summary>
      <p className="small-text">
        Tags: {owners.tags.authoritative.join(', ')} (a Working page: {owners.tags.working.join(', ')}).
        Required facts: Subject (the name), {owners.facts.required.join(', ')}.
      </p>
      <div className="table-wrap">
        <table aria-label="Owner types">
          <thead>
            <tr>
              <th>Type</th>
              <th>Template</th>
              <th>Tags</th>
              <th>Allowed homes</th>
            </tr>
          </thead>
          <tbody>
            {owners.types.map((t) => (
              <tr key={t.name} data-owner-type={t.name}>
                <td>
                  {t.name}
                  {t.note ? <div className="muted small-text">{t.note}</div> : null}
                </td>
                <td>{t.template}</td>
                <td className="mono small-text">
                  {t.primary}
                  {t.specialist.length ? ` [+ ${t.specialist.join(' | ')}]` : ''}
                </td>
                <td className="small-text">
                  {t.homes.map(home).join('; ')}
                  {t.kinds
                    ? Object.entries(t.kinds).map(([k, v]) =>
                        v ? (
                          <div key={k}>
                            {k}: {v.name} in {v.homes.map(home).join(' or ')}
                          </div>
                        ) : null,
                      )
                    : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * v3 F3.4 (ADR 0055 decision D): each write tool's switch. "Always propose": every package of it is a proposal whatever
 * the agent's scope. Off: it follows the agent's scope (direct at scope write, where the agent's safety rails still
 * apply; canon and lifecycle changes stay proposals). Saving makes a new pack version, approved as usual.
 */
function ToolSwitches({ pack, onChanged }: { pack: PackView; onChanged: () => void }) {
  const modes = pack.toolModes ?? [];
  const [draft, setDraft] = useState<Record<string, 'propose' | 'scope'>>(() =>
    Object.fromEntries(modes.map((t) => [t.tool, t.mode])),
  );
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const withReauth = useReauth();
  const changes = modes.filter((t) => draft[t.tool] !== t.mode);
  const save = async () => {
    const ok = await confirm({
      title: `Change ${changes.length} tool switch${changes.length === 1 ? '' : 'es'}?`,
      message: (
        <>
          <ul>
            {changes.map((t) => (
              <li key={t.tool}>
                <span className="mono">{t.tool}</span>:{' '}
                {draft[t.tool] === 'propose' ? 'always propose' : 'follow the agent’s scope'}
              </li>
            ))}
          </ul>
          <p>This makes a new pack version. Until you approve it, every package is refused.</p>
        </>
      ),
      confirmLabel: 'Save as a new version',
    });
    if (!ok) return;
    const done = await run(
      () =>
        withReauth(() =>
          api.put(`/packs/${encodeURIComponent(pack.id)}/tools`, {
            tools: Object.fromEntries(changes.map((t) => [t.tool, draft[t.tool]])),
            confirm: true,
          }),
        ),
      'Saved as a new version: approve it to use it.',
    );
    if (done) onChanged();
  };
  return (
    <div className="tool-switches">
      <h3>Tools at scope write</h3>
      <p className="muted small-text">
        Always propose: every package is a proposal for you, whatever the agent’s scope. Off: the tool follows
        the agent’s scope (at scope write it runs directly, under the agent’s safety rails; canon and
        lifecycle changes stay proposals).
      </p>
      <ul className="plain">
        {modes.map((t) => (
          <li key={t.tool}>
            <label className="inline">
              <input
                type="checkbox"
                role="switch"
                aria-label={`Always propose: ${t.tool}`}
                checked={draft[t.tool] === 'propose'}
                onChange={(e) => setDraft({ ...draft, [t.tool]: e.target.checked ? 'propose' : 'scope' })}
              />{' '}
              <span className="mono">{t.tool}</span>{' '}
              <span className="muted small-text">
                {draft[t.tool] === 'propose' ? 'always propose' : 'follows the agent’s scope'}
                {t.source === 'default' ? ' (the pack’s default)' : ''}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <Button busy={busy} disabled={changes.length === 0} onClick={() => void save()}>
        Save tool switches
      </Button>
    </div>
  );
}

import { useState } from 'react';
import { api } from '../api';
import {
  Badge,
  Button,
  CopyButton,
  Empty,
  ErrorNote,
  Loading,
  PageHeader,
  useAction,
  useConfirm,
} from '../components';
import { fmtAgo, fmtTime } from '../format';
import { useApi, useNow, useReloadOn } from '../hooks';
import type { ClientsResponse, Connection, Profile, Scope, SessionInfo } from '../types';

const RANK: Record<Scope, number> = { read: 0, propose: 1, write: 2 };
const SCOPE_HELP: Record<Scope, string> = {
  read: 'reads only; writes are refused',
  propose: 'writes become proposals you approve',
  write: 'writes run (within every safety guard)',
};

export function ClientsPage({ session }: { session?: SessionInfo }) {
  const c = useApi<ClientsResponse>('/clients');
  useReloadOn(['policy'], c.reload, 300);
  const now = useNow();
  if (c.error) return <ErrorNote error={c.error} onRetry={c.reload} />;
  if (!c.data) return <Loading />;
  const d = c.data;
  const byProfile = new Map<string, Connection[]>();
  for (const conn of d.connections) {
    const k = conn.profileId ?? '';
    byProfile.set(k, [...(byProfile.get(k) ?? []), conn]);
  }
  const groups: { profile: Profile | null; connections: Connection[] }[] = [
    ...d.profiles.map((p) => ({ profile: p, connections: byProfile.get(p.id) ?? [] })),
    ...(byProfile.has('') ? [{ profile: null, connections: byProfile.get('')! }] : []),
  ];

  return (
    <>
      <PageHeader title="Clients & Access" />
      <p className="muted">
        Every connection (an OAuth grant or a personal access token) acts under a <strong>profile</strong>,
        and the profile’s <strong>scope</strong> decides what it may do. A change applies to its connections
        on their very next call.
      </p>
      <DefaultScopeCard value={d.defaultScope} onSaved={c.reload} />
      <ConnectionSettingsCard settings={d.settings} onSaved={c.reload} />
      <ProfilesCard profiles={d.profiles} kinds={d.kinds} onChanged={c.reload} />
      <section className="card" aria-labelledby="conn-h">
        <h2 id="conn-h">Connections, by profile</h2>
        <RemoveInactive connections={d.connections} onChanged={c.reload} />
        {groups.length === 0 && <Empty>No connections yet.</Empty>}
        {groups.map(({ profile, connections }) => (
          <div key={profile?.id ?? 'none'} className="mt">
            <h3>
              {profile ? profile.label : 'No profile'}{' '}
              {profile && (
                <Badge tone={profile.scope === 'write' ? 'warn' : 'neutral'}>{profile.scope}</Badge>
              )}
              {profile && (
                <RevokeStale
                  profile={profile}
                  stale={connections.filter((x) => x.stale)}
                  staleAfterDays={d.settings.staleAfterDays}
                  onChanged={c.reload}
                />
              )}
            </h3>
            {connections.length === 0 ? (
              <p className="muted small-text">No connections use this profile.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Connection</th>
                      <th>Kind</th>
                      <th>Created</th>
                      <th>Last used</th>
                      <th>Expires</th>
                      <th>Status</th>
                      <th>Profile</th>
                      <th>
                        <span className="offscreen">Revoke or remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {connections.map((conn) => (
                      <ConnectionRow
                        key={conn.id}
                        conn={conn}
                        profiles={d.profiles}
                        now={now}
                        onChanged={c.reload}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </section>
      <PatCard
        profiles={d.profiles}
        publicUrl={session?.publicUrl ?? window.location.origin}
        onCreated={c.reload}
      />
    </>
  );
}

function ConnectionRow({
  conn,
  profiles,
  now,
  onChanged,
}: {
  conn: Connection;
  profiles: Profile[];
  now: number;
  onChanged: () => void;
}) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const expired = conn.expiresAt !== null && conn.expiresAt <= now;
  return (
    <tr data-connection={conn.id}>
      <td>
        {/* The name a client reports about itself is untrusted: shown as plain text only. */}
        {conn.label}
        <div className="muted small-text mono">{conn.id}</div>
      </td>
      <td>{conn.type === 'pat' ? 'Personal access token' : 'OAuth grant'}</td>
      <td>{fmtTime(conn.createdAt)}</td>
      <td>{fmtAgo(conn.lastUsedAt, now)}</td>
      <td>{conn.expiresAt ? fmtTime(conn.expiresAt) : 'never'}</td>
      <td>
        {conn.revokedAt ? (
          <Badge tone="bad">revoked</Badge>
        ) : expired ? (
          <Badge tone="warn">expired</Badge>
        ) : conn.active ? (
          <>
            <Badge tone="ok">active</Badge>
            {conn.stale && (
              <>
                {' '}
                <Badge tone="warn">stale</Badge>
              </>
            )}
          </>
        ) : (
          <Badge>inactive</Badge>
        )}
      </td>
      <td>
        <select
          aria-label={`Profile for ${conn.label}`}
          value={conn.profileId ?? ''}
          disabled={busy || !!conn.revokedAt}
          onChange={(e) => {
            const profileId = e.target.value;
            if (profileId)
              void run(
                () => api.put(`/clients/connections/${conn.id}/profile`, { profileId }),
                'Moved to another profile.',
              ).then(onChanged);
          }}
        >
          {!conn.profileId && <option value="">(none)</option>}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} ({p.scope})
            </option>
          ))}
        </select>
      </td>
      <td>
        {conn.active && (
          <Button
            className="small"
            variant="danger"
            busy={busy}
            onClick={() => {
              void confirm({
                title: 'Revoke this connection?',
                message: (
                  <p>
                    <strong>{conn.label}</strong> stops working at once. A personal access token cannot be
                    restored; the client would need a new one.
                  </p>
                ),
                confirmLabel: 'Revoke',
                danger: true,
              }).then((ok) => {
                if (ok)
                  void run(() => api.post(`/clients/connections/${conn.id}/revoke`), 'Revoked.').then(
                    onChanged,
                  );
              });
            }}
          >
            Revoke
          </Button>
        )}
        {!conn.active && (
          // No confirmation: the connection is already dead, and the tombstone and the audit log keep the record.
          <Button
            className="small"
            variant="danger"
            busy={busy}
            onClick={() =>
              void run(() => api.post(`/clients/connections/${conn.id}/remove`), 'Removed.').then(onChanged)
            }
          >
            Remove
          </Button>
        )}
      </td>
    </tr>
  );
}

/** The connections that are revoked or expired (what Remove would delete). */
const inactiveOf = (connections: Connection[]) => connections.filter((x) => !x.active);

function ConnectionList({ items }: { items: Connection[] }) {
  return (
    <ul>
      {items.map((x) => (
        <li key={x.id}>
          <strong>{x.label}</strong>{' '}
          <span className="muted small-text">
            ({x.profile ?? 'no profile'}, created {fmtTime(x.createdAt)}
            {x.revokedAt ? `, revoked ${fmtTime(x.revokedAt)}` : ''}
            {!x.revokedAt && x.expiresAt ? `, expired ${fmtTime(x.expiresAt)}` : ''})
          </span>
        </li>
      ))}
    </ul>
  );
}

/** "Remove all revoked and expired (N)", only when there is something to remove; confirmed with the rows listed. */
function RemoveInactive({ connections, onChanged }: { connections: Connection[]; onChanged: () => void }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const dead = inactiveOf(connections);
  if (dead.length === 0) return null;
  return (
    <p>
      <Button
        variant="danger"
        busy={busy}
        onClick={() => {
          void confirm({
            title: `Remove ${dead.length} revoked and expired ${dead.length === 1 ? 'connection' : 'connections'}?`,
            message: (
              <>
                <p>
                  Their credentials are deleted. The journal, proposals, jobs, errors and the audit log keep
                  naming them as “removed”.
                </p>
                <ConnectionList items={dead} />
              </>
            ),
            confirmLabel: `Remove ${dead.length}`,
            danger: true,
          }).then((ok) => {
            if (ok)
              void run(
                () => api.post('/clients/connections/remove-inactive'),
                `Removed ${dead.length}.`,
              ).then(onChanged);
          });
        }}
      >
        Remove all revoked and expired ({dead.length})
      </Button>
    </p>
  );
}

/** "Revoke stale (N)" for one profile: active connections unused for longer than the stale setting. */
function RevokeStale({
  profile,
  stale,
  staleAfterDays,
  onChanged,
}: {
  profile: Profile;
  stale: Connection[];
  staleAfterDays: number;
  onChanged: () => void;
}) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  if (stale.length === 0) return null;
  return (
    <>
      {' '}
      <Button
        className="small"
        variant="danger"
        busy={busy}
        onClick={() => {
          void confirm({
            title: `Revoke ${stale.length} stale ${stale.length === 1 ? 'connection' : 'connections'} on “${profile.label}”?`,
            message: (
              <>
                <p>
                  Not used for {staleAfterDays} days or more. Each stops working at once; a client can connect
                  again.
                </p>
                <ConnectionList items={stale} />
              </>
            ),
            confirmLabel: `Revoke ${stale.length}`,
            danger: true,
          }).then((ok) => {
            if (ok)
              void run(
                () => api.post('/clients/connections/revoke-stale', { profileId: profile.id }),
                `Revoked ${stale.length}.`,
              ).then(onChanged);
          });
        }}
      >
        Revoke stale ({stale.length})
      </Button>
    </>
  );
}

/** Automatic removal of revoked and expired connections, and the stale threshold. Both in days; 0 = never. */
function ConnectionSettingsCard({
  settings,
  onSaved,
}: {
  settings: { autoRemoveDays: number; staleAfterDays: number };
  onSaved: () => void;
}) {
  const { run, busy } = useAction();
  const [auto, setAuto] = useState(String(settings.autoRemoveDays));
  const [stale, setStale] = useState(String(settings.staleAfterDays));
  const valid = (v: string) => /^\d{1,4}$/.test(v) && Number(v) <= 3650;
  return (
    <section className="card" aria-labelledby="connset-h">
      <h2 id="connset-h">Old connections</h2>
      <div className="row">
        <label htmlFor="auto-remove-days">Remove revoked and expired connections automatically after</label>
        <input
          id="auto-remove-days"
          type="number"
          min={0}
          max={3650}
          value={auto}
          onChange={(e) => setAuto(e.target.value)}
          style={{ width: '6rem' }}
        />
        <span>days (0 = never)</span>
        <Button
          busy={busy}
          disabled={!valid(auto) || Number(auto) === settings.autoRemoveDays}
          onClick={() =>
            void run(
              () => api.put('/clients/settings/auto-remove-days', { days: Number(auto) }),
              'Automatic removal saved.',
            ).then(onSaved)
          }
        >
          Save
        </Button>
      </div>
      <div className="row">
        <label htmlFor="stale-after-days">Mark a connection stale after</label>
        <input
          id="stale-after-days"
          type="number"
          min={0}
          max={3650}
          value={stale}
          onChange={(e) => setStale(e.target.value)}
          style={{ width: '6rem' }}
        />
        <span>days without use (0 = never)</span>
        <Button
          busy={busy}
          disabled={!valid(stale) || Number(stale) === settings.staleAfterDays}
          onClick={() =>
            void run(
              () => api.put('/clients/settings/stale-after-days', { days: Number(stale) }),
              'Stale threshold saved.',
            ).then(onSaved)
          }
        >
          Save
        </Button>
      </div>
      <p className="muted small-text">
        The day count starts when a connection was revoked, or when it expired if it was never revoked.
        Removing deletes its credentials; its name stays in the history as “removed”. Only revoked or expired
        connections can be removed: revoke an active one first. The sweep runs daily (maintenance job
        “Connection removal”).
      </p>
    </section>
  );
}

/** Raising a scope asks first and spells out what it allows; lowering needs no confirmation. */
function useScopeChange() {
  const confirm = useConfirm();
  return async (what: string, from: Scope, to: Scope): Promise<boolean | 'raise'> => {
    if (from === to) return false;
    if (RANK[to] <= RANK[from]) return true;
    const ok = await confirm({
      title: `Raise ${what} to “${to}”?`,
      message: (
        <>
          <p>
            From <strong>{from}</strong> ({SCOPE_HELP[from]}) to <strong>{to}</strong> ({SCOPE_HELP[to]}).
          </p>
          <p>It applies at once, to every connection that uses it.</p>
        </>
      ),
      confirmLabel: `Raise to ${to}`,
      danger: to === 'write',
    });
    return ok ? 'raise' : false;
  };
}

function ScopeSelect({
  id,
  label,
  value,
  onPick,
  disabled,
}: {
  id: string;
  label: string;
  value: Scope;
  onPick: (s: Scope) => void;
  disabled?: boolean;
}) {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onPick(e.target.value as Scope)}
    >
      {(['read', 'propose', 'write'] as const).map((s) => (
        <option key={s} value={s}>
          {s} – {SCOPE_HELP[s]}
        </option>
      ))}
    </select>
  );
}

function DefaultScopeCard({ value, onSaved }: { value: Scope; onSaved: () => void }) {
  const { run, busy } = useAction();
  const change = useScopeChange();
  return (
    <section className="card" aria-labelledby="def-h">
      <h2 id="def-h">Default scope for new connections</h2>
      <div className="row">
        <ScopeSelect
          id="default-scope"
          label="Default scope for new connections"
          value={value}
          disabled={busy}
          onPick={(s) => {
            void change('the default scope', value, s).then((r) => {
              if (r)
                void run(
                  () => api.put('/clients/default-scope', { scope: s, confirmRaise: r === 'raise' }),
                  'Default scope saved.',
                ).then(onSaved);
            });
          }}
        />
      </div>
      <p className="muted small-text">
        A new profile (made at consent or here) starts at this scope. It stays “read” until you choose
        otherwise.
      </p>
    </section>
  );
}

function ProfilesCard({
  profiles,
  kinds,
  onChanged,
}: {
  profiles: Profile[];
  kinds: string[];
  onChanged: () => void;
}) {
  const { run, busy } = useAction();
  const change = useScopeChange();
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState(kinds[0] ?? 'other');
  return (
    <section className="card" aria-labelledby="prof-h">
      <h2 id="prof-h">Profiles</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Profile</th>
              <th>Kind</th>
              <th>Scope</th>
              <th>Low-level tools</th>
              <th className="num">Active connections</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id} data-profile={p.id}>
                <td>{p.label}</td>
                <td>{p.kind}</td>
                <td>
                  <ScopeSelect
                    id={`scope-${p.id}`}
                    label={`Scope for ${p.label}`}
                    value={p.scope}
                    disabled={busy}
                    onPick={(s) => {
                      void change(`“${p.label}”`, p.scope, s).then((r) => {
                        if (r)
                          void run(
                            () =>
                              api.put(`/clients/profiles/${p.id}/scope`, {
                                scope: s,
                                confirmRaise: r === 'raise',
                              }),
                            `“${p.label}” is now ${s}.`,
                          ).then(onChanged);
                      });
                    }}
                  />
                </td>
                <td>
                  <label className="inline" htmlFor={`low-${p.id}`}>
                    <input
                      id={`low-${p.id}`}
                      type="checkbox"
                      checked={p.showLowLevelTools}
                      disabled={busy}
                      aria-label={`Show low-level tools to ${p.label}`}
                      aria-describedby="tool-cache-hint"
                      onChange={(e) =>
                        void run(
                          () =>
                            api.put(`/clients/profiles/${p.id}/low-level-tools`, { show: e.target.checked }),
                          e.target.checked
                            ? `“${p.label}” is now shown the low-level tools.`
                            : `“${p.label}” no longer sees the low-level tools.`,
                        ).then(onChanged)
                      }
                    />{' '}
                    {p.showLowLevelTools ? 'shown' : 'hidden'}
                  </label>
                </td>
                <td className="num">{p.connections}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        <strong>Low-level tools</strong> are the raw LegendKeeper operation tools (
        <code>lk_api_list_operations</code>, <code>lk_api_describe_operation</code>,{' '}
        <code>lk_api_paginate_all</code> and every <code>lk_op_*</code>). Hidden by default. Hiding only
        changes the tool list the agent is shown: a call to a hidden tool is still allowed or refused by the
        profile’s scope exactly as before.
      </p>
      <p className="muted" id="tool-cache-hint">
        <strong>Tool lists are cached by the client.</strong> claude.ai keeps its own copy of a connector’s
        tool list, so a change to tool visibility (the “Show low-level tools” checkbox, or a scope change that
        hides or shows the write tools) shows in claude.ai only after the connector is disconnected and
        reconnected in claude.ai’s settings. New chats alone were not enough (observed on 10 November 2026;
        not a guarantee). In ChatGPT, use Plugins, then the bridge, then Refresh.
      </p>
      <h3>New profile</h3>
      <div className="field-row">
        <div>
          <label htmlFor="np-label">Label</label>
          <input id="np-label" value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div>
          <label htmlFor="np-kind">Kind</label>
          <select id="np-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </div>
        <Button
          busy={busy}
          disabled={label.trim() === ''}
          onClick={() =>
            void run(
              () => api.post('/clients/profiles', { label: label.trim(), kind }),
              'Profile created.',
            ).then((r) => {
              if (r) setLabel('');
              onChanged();
            })
          }
        >
          Create profile
        </Button>
      </div>
    </section>
  );
}

interface Created {
  token: string;
  pat: { id: string; name: string };
}

function PatCard({
  profiles,
  publicUrl,
  onCreated,
}: {
  profiles: Profile[];
  publicUrl: string;
  onCreated: () => void;
}) {
  const { run, busy } = useAction();
  const [name, setName] = useState('');
  const [profileId, setProfileId] = useState('');
  const [days, setDays] = useState('90');
  // The token lives only in this state, until the owner dismisses it. It is never stored or requested again.
  const [created, setCreated] = useState<Created | null>(null);
  const chosen = profileId || profiles.find((p) => p.label === 'claude-code')?.id || profiles[0]?.id || '';
  const command = created
    ? `claude mcp add --transport http lk-bridge ${publicUrl}/mcp --scope user -H "Authorization: Bearer ${created.token}"`
    : '';
  return (
    <section className="card" aria-labelledby="pat-h">
      <h2 id="pat-h">Personal access tokens</h2>
      <p className="muted small-text">
        For Claude Code and other clients that can send a header. ChatGPT and claude.ai connect with OAuth
        instead.
      </p>
      {created ? (
        <div role="alert">
          <p className="note note-warn">
            <strong>Copy this token now.</strong> It is shown once and cannot be recovered; the bridge keeps
            only a hash.
          </p>
          <div className="token-box" data-testid="pat-token">
            {created.token}
          </div>
          <div className="row mt">
            <CopyButton text={created.token} label="Copy token" />
            <CopyButton text={command} label="Copy Claude Code command" />
          </div>
          <p className="muted small-text mono">{command.replace(created.token, '<token>')}</p>
          <Button variant="primary" onClick={() => setCreated(null)}>
            I have copied it
          </Button>
        </div>
      ) : (
        <div className="field-row">
          <div>
            <label htmlFor="pat-name">Name</label>
            <input
              id="pat-name"
              value={name}
              maxLength={100}
              placeholder="Claude Code on my laptop"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="pat-profile">Profile</label>
            <select id="pat-profile" value={chosen} onChange={(e) => setProfileId(e.target.value)}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.scope})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="pat-days">Expires after (days)</label>
            <input
              id="pat-days"
              inputMode="numeric"
              size={5}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </div>
          <Button
            variant="primary"
            busy={busy}
            disabled={name.trim() === '' || chosen === '' || !(days === '' || /^[1-9]\d{0,3}$/.test(days))}
            onClick={() =>
              void run(() =>
                api.post<Created>('/clients/pats', {
                  name: name.trim(),
                  profileId: chosen,
                  ...(days ? { expiresInDays: Number(days) } : {}),
                }),
              ).then((r) => {
                if (r) {
                  setCreated(r);
                  setName('');
                  onCreated();
                }
              })
            }
          >
            Create token
          </Button>
        </div>
      )}
    </section>
  );
}

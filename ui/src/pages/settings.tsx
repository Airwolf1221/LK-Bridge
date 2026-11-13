import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Badge, Button, ErrorNote, Loading, PageHeader, useAction, useConfirm } from '../components';
import { fmtTime, fmtBytes } from '../format';
import { useApi, useReloadOn } from '../hooks';
import { Link } from '../router';
import type { AuditEntry, SettingsView } from '../types';

type Tri = 'env' | 'on' | 'off';
const toTri = (v: boolean | null): Tri => (v === null ? 'env' : v ? 'on' : 'off');
const fromTri = (t: Tri): boolean | null => (t === 'env' ? null : t === 'on');

/** Every change here asks for confirmation, is sent with `confirm: true`, and is written to the audit log. */
export function SettingsPage() {
  const s = useApi<{ settings: SettingsView }>('/settings');
  const audit = useApi<{ entries: AuditEntry[] }>('/audit?limit=15');
  useReloadOn(
    ['policy'],
    () => {
      s.reload();
      audit.reload();
    },
    300,
  );
  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const v = s.data.settings;
  const saved = () => {
    s.reload();
    audit.reload();
  };
  return (
    <>
      <PageHeader title="Settings" />
      <p className="muted">
        Changes are saved in the bridge’s database and audited. Some apply at once; others are built into the
        bridge when it starts, so they show as <em>pending</em> until the next restart.
      </p>
      <ReadOnlyCard v={v} onSaved={saved} />
      <BoolCard
        id="per-op"
        title="Per-operation tools"
        path="/settings/expose-per-op-tools"
        d={v.exposePerOpTools}
        onSaved={saved}
        help="Also expose one MCP tool per LegendKeeper operation (89 more). Off keeps the tool list short for claude.ai."
        confirmText={(on) =>
          on === null
            ? 'Go back to the environment’s value?'
            : on
              ? 'Expose all 89 operations as separate tools after the next restart?'
              : 'Hide the per-operation tools after the next restart?'
        }
      />
      <BoolCard
        id="member-admin"
        title="Member administration"
        path="/settings/member-admin"
        d={v.memberAdmin}
        onSaved={saved}
        danger
        help="Allows inviting and removing project members and revoking invites. Off, those operations are refused for every agent."
        confirmText={(on) =>
          on === null
            ? 'Go back to the environment’s value?'
            : on
              ? 'Allow member and invite administration after the next restart? Agents at the “write” scope could then remove people from your project.'
              : 'Refuse member and invite administration after the next restart?'
        }
      />
      <JournalCard v={v} onSaved={saved} />
      <ContactCard v={v} onSaved={saved} />
      <TierCard v={v} onSaved={saved} />
      <section className="card" aria-labelledby="audit-h">
        <h2 id="audit-h">Recent changes</h2>
        {!audit.data ? (
          <Loading />
        ) : audit.data.entries.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{fmtTime(e.at)}</td>
                    <td>{e.actor}</td>
                    <td className="mono">{e.action}</td>
                    <td className="mono small-text">{e.target ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function PendingBadge({ pending }: { pending: boolean }) {
  return pending ? <Badge tone="warn">pending restart</Badge> : null;
}

function ReadOnlyCard({ v, onSaved }: { v: SettingsView; onSaved: () => void }) {
  const [choice, setChoice] = useState<Tri>(toTri(v.readOnly.override));
  useEffect(() => setChoice(toTri(v.readOnly.override)), [v.readOnly.override]);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const changed = choice !== toTri(v.readOnly.override);
  return (
    <section className="card" aria-labelledby="ro-h">
      <div className="row row-between">
        <h2 id="ro-h">Read-only mode</h2>
        <Badge tone={v.readOnly.effective ? 'warn' : 'ok'}>
          {v.readOnly.effective ? 'on now' : 'off now'}
        </Badge>
      </div>
      <p className="muted small-text">
        While on, every write is refused and queued writes are held. Applies at once. The environment’s value
        is <strong>{v.readOnly.environment ? 'on' : 'off'}</strong>. This covers every project; each project
        can also be made read-only on its own on the <Link to="/projects">Projects</Link> page.
      </p>
      <fieldset className="plain">
        <legend className="offscreen">Read-only mode</legend>
        {(
          [
            ['env', `Follow the environment (${v.readOnly.environment ? 'on' : 'off'})`],
            ['on', 'On: refuse every write'],
            ['off', 'Off: allow writes (within every guard)'],
          ] as const
        ).map(([val, label]) => (
          <label key={val} className="inline radio">
            <input type="radio" name="read-only" checked={choice === val} onChange={() => setChoice(val)} />{' '}
            {label}
          </label>
        ))}
      </fieldset>
      <Button
        variant="primary"
        busy={busy}
        disabled={!changed}
        onClick={() => {
          void confirm({
            title: 'Change read-only mode?',
            message: (
              <p>
                {choice === 'on'
                  ? 'Every write will be refused straight away.'
                  : choice === 'off'
                    ? 'Writes will be allowed straight away, within every guard and each agent’s scope.'
                    : 'Read-only mode will follow the environment again.'}
              </p>
            ),
            confirmLabel: 'Save',
            danger: choice === 'off',
          }).then((ok) => {
            if (ok)
              void run(
                () => api.put('/settings/read-only', { value: fromTri(choice), confirm: true }),
                'Read-only mode saved.',
              ).then(onSaved);
          });
        }}
      >
        Save
      </Button>
    </section>
  );
}

function BoolCard({
  id,
  title,
  path,
  d,
  help,
  confirmText,
  onSaved,
  danger,
}: {
  id: string;
  title: string;
  path: string;
  d: SettingsView['exposePerOpTools'];
  help: ReactNode;
  confirmText: (value: boolean | null) => string;
  onSaved: () => void;
  danger?: boolean;
}) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const wanted = d.stored ?? d.environment;
  const save = (value: boolean | null) =>
    void confirm({
      title: `Change “${title}”?`,
      message: <p>{confirmText(value)}</p>,
      confirmLabel: 'Save',
      danger: danger === true && value === true,
    }).then((ok) => {
      if (ok) void run(() => api.put(path, { value, confirm: true }), `${title} saved.`).then(onSaved);
    });
  return (
    <section className="card" aria-labelledby={`${id}-h`}>
      <div className="row row-between">
        <h2 id={`${id}-h`}>{title}</h2>
        <span className="row">
          <Badge tone={d.running ? 'ok' : 'neutral'}>{d.running ? 'on now' : 'off now'}</Badge>
          <PendingBadge pending={d.pendingRestart} />
        </span>
      </div>
      <p className="muted small-text">{help}</p>
      <div className="row">
        <label className="inline" htmlFor={`${id}-toggle`}>
          <input
            id={`${id}-toggle`}
            type="checkbox"
            checked={wanted}
            disabled={busy}
            onChange={(e) => save(e.target.checked)}
          />{' '}
          Enabled
        </label>
        <span className="muted small-text">
          environment: {d.environment ? 'on' : 'off'}
          {d.stored !== null ? ' · saved in the dashboard' : ''}
        </span>
        {d.stored !== null && (
          <Button className="small" busy={busy} onClick={() => save(null)}>
            Use the environment’s value
          </Button>
        )}
      </div>
      <p className="muted small-text">Applies at the next restart.</p>
    </section>
  );
}

function JournalCard({ v, onSaved }: { v: SettingsView; onSaved: () => void }) {
  const d = v.journalRetention;
  const cur = d.stored ?? d.environment;
  const gb = (b: number) => String(Math.round((b / 1024 ** 3) * 100) / 100);
  const [days, setDays] = useState(String(cur.retentionDays));
  const [size, setSize] = useState(gb(cur.maxBytes));
  // Follow the saved values when they change (after a save, or another tab's), but not on the first render: the state
  // already holds them, and a late first sync would overwrite whatever the owner typed before effects ran.
  const synced = useRef({ days: cur.retentionDays, bytes: cur.maxBytes });
  useEffect(() => {
    if (synced.current.days === cur.retentionDays && synced.current.bytes === cur.maxBytes) return;
    synced.current = { days: cur.retentionDays, bytes: cur.maxBytes };
    setDays(String(cur.retentionDays));
    setSize(gb(cur.maxBytes));
  }, [cur.retentionDays, cur.maxBytes]);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const value = { retentionDays: Number(days), maxBytes: Math.round(Number(size) * 1024 ** 3) };
  const valid =
    Number.isInteger(value.retentionDays) &&
    value.retentionDays >= 1 &&
    value.retentionDays <= 3650 &&
    value.maxBytes >= 1024 ** 2;
  return (
    <section className="card" aria-labelledby="jr-h">
      <div className="row row-between">
        <h2 id="jr-h">Journal retention</h2>
        <PendingBadge pending={d.pendingRestart} />
      </div>
      <p className="muted small-text">
        How long the write journal is kept, and its size cap. Running now: {d.running.retentionDays} days or{' '}
        {fmtBytes(d.running.maxBytes)}. Applies at the next restart.
      </p>
      <div className="field-row">
        <div>
          <label htmlFor="jr-days">Keep for (days)</label>
          <input
            id="jr-days"
            inputMode="numeric"
            size={6}
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="jr-size">Size cap (GB)</label>
          <input
            id="jr-size"
            inputMode="decimal"
            size={6}
            value={size}
            onChange={(e) => setSize(e.target.value)}
          />
        </div>
        <Button
          variant="primary"
          busy={busy}
          disabled={!valid}
          onClick={() => {
            void confirm({
              title: 'Change journal retention?',
              message: (
                <p>
                  Keep {value.retentionDays} days or {fmtBytes(value.maxBytes)}, whichever comes first, after
                  the next restart. Shorter retention deletes older undo information.
                </p>
              ),
              confirmLabel: 'Save',
            }).then((ok) => {
              if (ok)
                void run(
                  () => api.put('/settings/journal-retention', { value, confirm: true }),
                  'Journal retention saved.',
                ).then(onSaved);
            });
          }}
        >
          Save
        </Button>
        {d.stored && (
          <Button
            busy={busy}
            onClick={() => {
              void confirm({
                title: 'Use the environment’s retention?',
                message: (
                  <p>
                    {d.environment.retentionDays} days or {fmtBytes(d.environment.maxBytes)}.
                  </p>
                ),
                confirmLabel: 'Reset',
              }).then((ok) => {
                if (ok)
                  void run(
                    () => api.put('/settings/journal-retention', { value: null, confirm: true }),
                    'Journal retention reset.',
                  ).then(onSaved);
              });
            }}
          >
            Reset
          </Button>
        )}
      </div>
    </section>
  );
}

function TierCard({ v, onSaved }: { v: SettingsView; onSaved: () => void }) {
  const t = v.tierLimits;
  const fromStored = () =>
    Object.fromEntries(t.tiers.map((k) => [k, t.stored?.[k] !== undefined ? String(t.stored[k]) : '']));
  const [vals, setVals] = useState<Record<string, string>>(fromStored);
  // Follow the saved overrides when their content changes, not on the first render or a reload with the same values
  // (either would overwrite what the owner is typing).
  const storedKey = JSON.stringify([t.tiers, t.stored]);
  const synced = useRef(storedKey);
  useEffect(() => {
    if (synced.current === storedKey) return;
    synced.current = storedKey;
    setVals(fromStored());
  }, [storedKey]); // storedKey stands for t.tiers and t.stored
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const overrides = Object.fromEntries(
    Object.entries(vals)
      .filter(([, x]) => x.trim() !== '')
      .map(([k, x]) => [k, Number(x)]),
  );
  const valid = Object.values(overrides).every((n) => Number.isInteger(n) && n > 0);
  return (
    <section className="card" aria-labelledby="tl-h">
      <div className="row row-between">
        <h2 id="tl-h">Tier limit overrides</h2>
        <PendingBadge pending={t.pendingRestart} />
      </div>
      <p className="muted small-text">
        The bridge assumes LegendKeeper’s published limits. Override one here if LegendKeeper changes it.
        Leave a box empty to use the environment’s or published value. The server’s own reports always win at
        run time. Applies at the next restart.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tier</th>
              <th className="num">Running now</th>
              <th className="num">Environment</th>
              <th>Override</th>
            </tr>
          </thead>
          <tbody>
            {t.tiers.map((k) => (
              <tr key={k}>
                <td className="mono">{k}</td>
                <td className="num">{t.running[k] ?? '–'}</td>
                <td className="num">{t.environment[k] ?? '–'}</td>
                <td>
                  <input
                    aria-label={`Override for ${k}`}
                    inputMode="numeric"
                    size={7}
                    value={vals[k] ?? ''}
                    onChange={(e) => setVals({ ...vals, [k]: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!valid && (
        <p className="note note-bad" role="alert">
          Each override must be a positive whole number.
        </p>
      )}
      <div className="row mt">
        <Button
          variant="primary"
          busy={busy}
          disabled={!valid}
          onClick={() => {
            void confirm({
              title: 'Change tier limits?',
              message: (
                <p>
                  {Object.keys(overrides).length === 0
                    ? 'Clear every override.'
                    : Object.entries(overrides)
                        .map(([k, n]) => `${k} = ${n}`)
                        .join(', ')}
                  . A limit set above what LegendKeeper really allows lets the bridge send requests it will
                  refuse. Applies at the next restart.
                </p>
              ),
              confirmLabel: 'Save',
              danger: true,
            }).then((ok) => {
              if (ok)
                void run(
                  () =>
                    api.put('/settings/tier-limits', {
                      value: Object.keys(overrides).length ? overrides : null,
                      confirm: true,
                    }),
                  'Tier limits saved.',
                ).then(onSaved);
            });
          }}
        >
          Save
        </Button>
      </div>
    </section>
  );
}

/** The contact line on the public /privacy page. Applies at once; empty means the page omits the line. */
function ContactCard({ v, onSaved }: { v: SettingsView; onSaved: () => void }) {
  const stored = v.contactEmail.stored;
  const [email, setEmail] = useState(stored ?? '');
  const synced = useRef(stored);
  useEffect(() => {
    if (synced.current === stored) return;
    synced.current = stored;
    setEmail(stored ?? '');
  }, [stored]);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const save = (value: string | null) =>
    void confirm({
      title: 'Change the contact email?',
      message: (
        <p>
          {value === null
            ? 'Remove the contact line from the public privacy page?'
            : `Show ${value} on the public privacy page?`}
        </p>
      ),
      confirmLabel: 'Save',
    }).then((ok) => {
      if (ok)
        void run(
          () => api.put('/settings/contact-email', { value, confirm: true }),
          'Contact email saved.',
        ).then(onSaved);
    });
  const trimmed = email.trim();
  return (
    <section className="card" aria-labelledby="contact-h">
      <div className="row row-between">
        <h2 id="contact-h">Contact email</h2>
        <Badge tone={stored ? 'ok' : 'neutral'}>{stored ? 'shown' : 'not shown'}</Badge>
      </div>
      <p className="muted small-text">
        Shown on the public privacy page (<code>/privacy</code>) as a contact line. There is no default: left
        empty, the page has no contact line. Applies at once.
      </p>
      <label htmlFor="contact-email">Email address</label>
      <input
        id="contact-email"
        type="email"
        autoComplete="off"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <div className="row">
        <Button disabled={busy || trimmed === '' || trimmed === stored} onClick={() => save(trimmed)}>
          Save
        </Button>
        <Button disabled={busy || stored === null} onClick={() => save(null)}>
          Remove
        </Button>
      </div>
    </section>
  );
}

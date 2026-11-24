import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Badge, Button, ErrorNote, Loading, PageHeader, useAction, useConfirm } from '../components';
import { fmtTime } from '../format';
import { useApi, useReloadOn } from '../hooks';
import { Link } from '../router';
import type { AuditEntry, ConfigEntry, ConfigView, SettingsView } from '../types';

type Tri = 'env' | 'on' | 'off';
const toTri = (v: boolean | null): Tri => (v === null ? 'env' : v ? 'on' : 'off');
const fromTri = (t: Tri): boolean | null => (t === 'env' ? null : t === 'on');

const DOCS = 'https://github.com/Airwolf1221/LK-Bridge/blob/main';

/**
 * v3 F8 (ADR 0073): every setting the bridge reads, by group, from the settings registry. Each shows its effective
 * value, where it comes from, its range and unit and how a change applies. Edit and Reset ask for confirmation and the
 * step-up, and every change is in Recent changes with its old and new value. Bootstrap settings are shown read-only;
 * secrets only as set or not set.
 */
export function SettingsPage() {
  const s = useApi<{ settings: SettingsView }>('/settings');
  const c = useApi<ConfigView>('/settings/config');
  const audit = useApi<{ entries: AuditEntry[] }>('/audit?limit=15');
  const [query, setQuery] = useState('');
  useReloadOn(
    ['policy'],
    () => {
      s.reload();
      c.reload();
      audit.reload();
    },
    300,
  );
  const saved = () => {
    s.reload();
    c.reload();
    audit.reload();
  };
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (c.data?.entries ?? []).filter(
        (e) => q === '' || e.key.toLowerCase().includes(q) || e.label.toLowerCase().includes(q),
      ),
    [c.data, q],
  );
  if (s.error) return <ErrorNote error={s.error} onRetry={s.reload} />;
  if (c.error) return <ErrorNote error={c.error} onRetry={c.reload} />;
  if (!s.data || !c.data) return <Loading />;
  const v = s.data.settings;
  const cfg = c.data;
  return (
    <>
      <PageHeader title="Settings" />
      <p className="muted">
        Every setting the bridge reads. A value saved here wins over the environment’s, which wins over the
        default. Some apply at once; others are built into the bridge when it starts, so they show as{' '}
        <em>pending</em> until the next restart. Bootstrap settings and secrets are changed on the server.
      </p>
      <RestartCard cfg={cfg} onSaved={saved} />
      <ReadOnlyCard v={v} onSaved={saved} />
      <div className="row mt">
        <label htmlFor="settings-search">Search settings</label>
        <input
          id="settings-search"
          type="search"
          placeholder="A name or a variable, e.g. upload or IMAGE_MAX"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {q !== '' && <span className="muted small-text">{shown.length} found</span>}
      </div>
      {cfg.dropped.length > 0 && (
        <p className="note note-bad" role="alert">
          Saved here but left out at this start (they no longer load with the environment):{' '}
          {cfg.dropped.join(', ')}.
        </p>
      )}
      {cfg.groups.map((g) => {
        const entries = shown.filter((e) => e.group === g.id);
        if (entries.length === 0) return null;
        return (
          <section key={g.id} className="card" aria-labelledby={`grp-${g.id}-h`}>
            <h2 id={`grp-${g.id}-h`}>{g.label}</h2>
            {g.id === 'server' && (
              <p className="muted small-text">
                These could stop the bridge starting, or are fixed by systemd, the filesystem or the reverse
                proxy. Change on the server: the env file, via env-sync.
              </p>
            )}
            {g.id === 'projects' && (
              <p className="muted small-text">
                Set for each project on the <Link to="/projects">Projects</Link> page. The defaults are shown
                here.
              </p>
            )}
            <ul className="plain config-list">
              {entries.map((e) => (
                <li key={e.key}>
                  <SettingRow e={e} onSaved={saved} />
                  {e.key === 'LK_TIER_LIMITS' && <TierCard v={v} onSaved={saved} />}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {shown.length === 0 && <p className="muted">No setting matches “{query}”.</p>}
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
                  <th>Setting</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{fmtTime(e.at)}</td>
                    <td>{e.actor}</td>
                    <td className="mono">{e.action}</td>
                    <td className="mono small-text">{e.target ?? '–'}</td>
                    <td className="mono small-text">{brief(e.before)}</td>
                    <td className="mono small-text">{brief(e.after)}</td>
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

/** An audit row's before or after, short. */
function brief(v: unknown): string {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'object' && v !== null && 'value' in v) {
    const o = v as { value: unknown; source?: unknown };
    return `${JSON.stringify(o.value)}${typeof o.source === 'string' ? ` (${o.source})` : ''}`;
  }
  const t = JSON.stringify(v);
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}

const APPLIES: Record<ConfigEntry['applies'], string> = {
  now: 'Applies at once',
  next_start: 'Applies at the next restart',
  bootstrap: 'Changed on the server',
};

const SOURCE: Record<NonNullable<ConfigEntry['source']>, string> = {
  default: 'default',
  environment: 'environment',
  dashboard: 'saved here',
};

/** A value in the entry's display unit, for showing. */
function shownValue(e: ConfigEntry, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'not set';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number' && e.unit) {
    const n = Math.round((value / e.unit.factor) * 1e6) / 1e6;
    return `${n.toLocaleString('en-GB', { maximumFractionDigits: 6 })}${e.unit.display ? ` ${e.unit.display}` : ''}`;
  }
  if (typeof value === 'number') return value.toLocaleString('en-GB');
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function rangeText(e: ConfigEntry): string | null {
  if (e.enum) return e.enum.join(', ');
  if (e.min === null && e.max === null) return null;
  const u = e.unit;
  const f = (n: number) =>
    (u ? Math.round((n / u.factor) * 1e6) / 1e6 : n).toLocaleString('en-GB', { maximumFractionDigits: 6 });
  const unit = u?.display ? ` ${u.display}` : '';
  if (e.max === null) return `at least ${f(e.min!)}${unit}`;
  if (e.min === null) return `at most ${f(e.max)}${unit}`;
  return `${f(e.min)} to ${f(e.max)}${unit}`;
}

function ManagedLink({ m }: { m: NonNullable<ConfigEntry['managedAt']> }) {
  return m.href.startsWith('/ui/') ? (
    <Link to={m.href.slice(3)}>{m.label}</Link>
  ) : (
    <a href={`${DOCS}/${m.href}`} target="_blank" rel="noreferrer">
      {m.label}
    </a>
  );
}

function SettingRow({ e, onSaved }: { e: ConfigEntry; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const id = `set-${e.key}`;
  return (
    <div className="setting" role="group" aria-labelledby={`${id}-label`}>
      <div className="row row-between">
        <div>
          <strong id={`${id}-label`}>{e.label}</strong> <code className="small-text">{e.key}</code>
        </div>
        <span className="row">
          {e.secret ? (
            <Badge tone={e.isSet ? 'ok' : 'neutral'}>{e.isSet ? 'set' : 'not set'}</Badge>
          ) : (
            <>
              <span className="mono" aria-label={`${e.label}: value`}>
                {shownValue(e, e.value)}
              </span>
              {e.source && (
                <Badge tone={e.source === 'dashboard' ? 'info' : 'neutral'}>{SOURCE[e.source]}</Badge>
              )}
            </>
          )}
          {e.pendingRestart && <Badge tone="warn">pending restart</Badge>}
        </span>
      </div>
      <p className="muted small-text">{e.description}</p>
      <p className="muted small-text">
        {rangeText(e) && <>Range: {rangeText(e)}. </>}
        {!e.secret && e.default !== null && e.default !== undefined && (
          <>Default: {shownValue(e, e.default)}. </>
        )}
        {APPLIES[e.applies]}.
        {e.pendingRestart && e.running !== undefined && <> Running now: {shownValue(e, e.running)}.</>}
        {e.projectSetting && e.editedOn === 'settings' && (
          <>
            {' '}
            Each project can set its own on the <Link to="/projects">Projects</Link> page.
          </>
        )}
      </p>
      {e.secret ? (
        <p className="small-text">
          Secret: never shown here.{e.setIn ? ` Set in the ${e.setIn}.` : ''} Managed on{' '}
          {e.managedAt && <ManagedLink m={e.managedAt} />}.
        </p>
      ) : e.editedOn === 'server' ? (
        <p className="small-text">
          Change on the server: the env file, via env-sync.
          {e.bootstrapReason && <span className="muted"> Why: {e.bootstrapReason}</span>}
          {e.managedAt && e.managedAt.href.startsWith('/ui/') && (
            <>
              {' '}
              See <ManagedLink m={e.managedAt} />.
            </>
          )}
        </p>
      ) : e.editedOn === 'projects' ? (
        <p className="small-text">
          Set per project on <Link to="/projects">the Projects page</Link>.
        </p>
      ) : e.key === 'LK_READ_ONLY' ? (
        <p className="small-text">Changed with the Read-only mode card at the top of this page.</p>
      ) : e.key === 'LK_TIER_LIMITS' ? null : editing ? (
        <EditForm e={e} onDone={() => setEditing(false)} onSaved={onSaved} />
      ) : (
        <div className="row">
          <Button className="small" onClick={() => setEditing(true)} aria-label={`Edit ${e.label}`}>
            Edit
          </Button>
          {e.source === 'dashboard' && <ResetButton e={e} onSaved={onSaved} />}
        </div>
      )}
    </div>
  );
}

function ResetButton({ e, onSaved }: { e: ConfigEntry; onSaved: () => void }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const back = e.environment !== null && e.environment !== undefined ? e.environment : e.default;
  return (
    <Button
      className="small"
      busy={busy}
      aria-label={`Reset ${e.label}`}
      onClick={() => {
        void confirm({
          title: `Reset “${e.label}”?`,
          message: (
            <p>
              Back to the{' '}
              {e.environment !== null && e.environment !== undefined ? 'environment’s value' : 'default'}:{' '}
              {shownValue(e, back)}. {APPLIES[e.applies]}.
            </p>
          ),
          confirmLabel: 'Reset',
        }).then((ok) => {
          if (ok)
            void run(
              () => api.post(`/settings/config/${e.key}/reset`, { confirm: true }),
              `${e.label} reset.`,
            ).then(onSaved);
        });
      }}
    >
      Reset
    </Button>
  );
}

/** The value as typed into the form, in the display unit. */
function initialText(e: ConfigEntry): string {
  const v = e.value;
  if (typeof v === 'number' && e.unit) return String(Math.round((v / e.unit.factor) * 1e6) / 1e6);
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function EditForm({ e, onDone, onSaved }: { e: ConfigEntry; onDone: () => void; onSaved: () => void }) {
  const [text, setText] = useState(initialText(e));
  const [flag, setFlag] = useState(e.value === true);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const id = `edit-${e.key}`;
  const numeric = e.type === 'integer' || e.type === 'number';
  const amount = Number(text);
  const problem = (() => {
    if (!numeric) return e.type === 'boolean' || text.trim() !== '' ? null : 'Enter a value, or use Reset.';
    if (text.trim() === '' || !Number.isFinite(amount)) return 'Enter a number.';
    const base = e.unit ? amount * e.unit.factor : amount;
    if (e.min !== null && base < e.min - 1e-9) return `At least ${rangeText(e)}.`;
    if (e.max !== null && base > e.max + 1e-9) return `Within ${rangeText(e)}.`;
    if (e.integer && Math.abs(base - Math.round(base)) > 1e-6 * Math.max(1, Math.abs(base)))
      return `Must come to a whole number of ${e.unit?.base ?? 'units'}.`;
    return null;
  })();
  const body = (): Record<string, unknown> =>
    e.type === 'boolean'
      ? { value: flag }
      : numeric
        ? e.unit
          ? { amount, unit: e.unit.display }
          : { value: amount }
        : { value: text.trim() };
  const shown =
    e.type === 'boolean'
      ? flag
        ? 'on'
        : 'off'
      : numeric
        ? `${text}${e.unit?.display ? ` ${e.unit.display}` : ''}`
        : text.trim();
  return (
    <form
      className="field-row"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (problem) return;
        void confirm({
          title: `Change “${e.label}”?`,
          message: (
            <p>
              Set {e.key} to {shown}. {APPLIES[e.applies]}
              {e.applies === 'next_start' ? ': it shows as pending until then' : ''}.
            </p>
          ),
          confirmLabel: 'Save',
        }).then((ok) => {
          if (ok)
            void run(
              () => api.put(`/settings/config/${e.key}`, { ...body(), confirm: true }),
              `${e.label} saved.`,
            ).then((r) => {
              if (r !== undefined) {
                onDone();
                onSaved();
              }
            });
        });
      }}
    >
      {e.type === 'boolean' ? (
        <label className="inline" htmlFor={id}>
          <input id={id} type="checkbox" checked={flag} onChange={(ev) => setFlag(ev.target.checked)} /> On
        </label>
      ) : e.enum ? (
        <div>
          <label htmlFor={id}>New value</label>
          <select id={id} value={text} onChange={(ev) => setText(ev.target.value)}>
            {e.enum.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div>
          <label htmlFor={id}>New value{e.unit?.display ? ` (${e.unit.display})` : ''}</label>
          <input
            id={id}
            inputMode={numeric ? 'decimal' : 'text'}
            size={numeric ? 10 : 40}
            value={text}
            onChange={(ev) => setText(ev.target.value)}
          />
        </div>
      )}
      <Button variant="primary" busy={busy} disabled={problem !== null} type="submit">
        Save
      </Button>
      <Button onClick={onDone}>Cancel</Button>
      {problem && text.trim() !== '' && (
        <p className="note note-bad small-text" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

/** S7: "N settings pending a restart", and the button (step-up, confirmation, then the bridge drains and exits 75). */
function RestartCard({ cfg, onSaved }: { cfg: ConfigView; onSaved: () => void }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const r = cfg.restart;
  const n = cfg.pendingRestart;
  return (
    <section className="card" aria-labelledby="restart-h">
      <div className="row row-between">
        <h2 id="restart-h">Restart the bridge</h2>
        <Badge tone={n > 0 ? 'warn' : 'ok'}>
          {n === 1 ? '1 setting pending a restart' : `${n} settings pending a restart`}
        </Badge>
      </div>
      <p className="muted small-text">
        The bridge stops taking new tool calls, lets running job steps finish or parks them for the next
        start, saves everything, then exits for systemd to start it again (about 10 seconds). Agents are told
        to try again in a minute.
      </p>
      {r.last && (
        <p className="small-text">
          Last restarted at the owner’s request: {fmtTime(r.last.requestedAt)}
          {r.last.backAt ? `, back at ${fmtTime(r.last.backAt)}` : ''}.
        </p>
      )}
      <Button
        variant="primary"
        busy={busy}
        disabled={!r.available}
        onClick={() => {
          void confirm({
            title: 'Restart the bridge?',
            message: (
              <p>
                {n > 0
                  ? `${n === 1 ? 'The pending setting applies' : `The ${n} pending settings apply`} when it is back. `
                  : ''}
                Running work is kept and continues by itself.
              </p>
            ),
            confirmLabel: 'Restart',
            danger: true,
          }).then((ok) => {
            if (ok)
              void run(
                () => api.post('/bridge/restart', { confirm: true }),
                'The bridge is restarting. This page reconnects when it is back.',
              ).then(onSaved);
          });
        }}
      >
        Restart the bridge
      </Button>
      {!r.available && r.reason && <p className="muted small-text">{r.reason}</p>}
    </section>
  );
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
    <div className="subcard" role="region" aria-labelledby="tl-h">
      <div className="row row-between">
        <h3 id="tl-h">Tier limit overrides</h3>
        {t.pendingRestart && <Badge tone="warn">pending restart</Badge>}
      </div>
      <p className="muted small-text">
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
          Save tier limits
        </Button>
      </div>
    </div>
  );
}

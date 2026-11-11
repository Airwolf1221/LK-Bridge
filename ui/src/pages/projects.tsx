import { useState, type FormEvent } from 'react';
import { api, formText } from '../api';
import {
  Badge,
  Button,
  Empty,
  ErrorNote,
  Loading,
  PageHeader,
  ProjectStatusBadge,
  useAction,
  useConfirm,
  useToast,
} from '../components';
import { PROJECT_STATUS_LABELS, fmtAgo, prettyJson } from '../format';
import { useNow } from '../hooks';
import { useProject } from '../project';
import { useReauth } from '../reauth';
import { useApi } from '../hooks';
import type {
  CanonConfig,
  CanonRule,
  KeyCheck,
  LifecycleIndexLookup,
  LifecycleView,
  ProjectInfo,
  ProjectSettingKey,
  ProjectsResponse,
} from '../types';

/**
 * Projects (v2 A1): every LegendKeeper project the bridge knows, its flags and status, and whether its key is configured
 * and valid. A key is never shown, only the name of the env variable that holds it, or (OPS2) its last four
 * characters. The per-project read-only flag is editable here, and (v2 A2) each project's settings: the AI REPOSITORY
 * root, the names the repository tree reads, and the hourly sweep switch. Every change is audited.
 *
 * OPS2: projects are added here by pasting a key into a write-only field (checked with LegendKeeper, then confirmed,
 * then stored encrypted), keys are replaced (same LegendKeeper project only), and projects are paused and drained, then
 * removed (archived). Adding, replacing and removing ask for the password again when the last check is over five
 * minutes old.
 */
export function ProjectsPage() {
  const { data, error, reload } = useProject();
  const now = useNow();
  if (!data) return error ? <ErrorNote error={error} onRetry={reload} /> : <Loading />;
  return (
    <>
      <PageHeader title="Projects">
        <button type="button" className="small" onClick={reload}>
          Refresh
        </button>
      </PageHeader>
      <p className="muted">
        The LegendKeeper projects this bridge serves, each with its own key and its own request budget. The
        project chosen in the sidebar is the one the other pages show. The default project is{' '}
        <strong>{data.default}</strong>.{' '}
        {data.requireProjectForWrites
          ? 'Agents must name the project for every write when more than one project is registered.'
          : 'A write that names no project goes to the default project.'}
      </p>
      {data.singleProjectForm && (
        <p className="note note-warn">
          The bridge is configured in the single-project form (LK_API_KEY and LK_PROJECT_ID). The deployment
          runbook explains how to move to LK_PROJECTS.
        </p>
      )}
      <ErrorNote error={error} onRetry={reload} />
      {(data.notes ?? []).map((n) => (
        <p key={n} className="note note-warn small-text">
          {n}
        </p>
      ))}
      <AddProjectCard canManage={data.canManageKeys !== false} onChanged={reload} />
      {data.projects.length === 0 ? (
        <Empty>No projects yet. Add one above with its LegendKeeper API key.</Empty>
      ) : (
        <>
          <section className="card table-wrap" aria-labelledby="projects-h">
            <h2 id="projects-h">All projects</h2>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Display name</th>
                  <th>LegendKeeper id</th>
                  <th>Default</th>
                  <th>Sandbox</th>
                  <th>Read-only</th>
                  <th>Status</th>
                  <th>Key</th>
                  <th>
                    <span className="offscreen">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.projects.map((p) => (
                  <ProjectRow key={p.name} project={p} now={now} onChanged={reload} />
                ))}
              </tbody>
            </table>
          </section>
          <SettingsCard data={data} onChanged={reload} />
          <CanonCard data={data} />
          <LifecycleCard data={data} />
        </>
      )}
    </>
  );
}

function ProjectRow({
  project: p,
  now,
  onChanged,
}: {
  project: ProjectInfo;
  now: number;
  onChanged: () => void;
}) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const withReauth = useReauth();
  const [replacing, setReplacing] = useState(false);
  const name = encodeURIComponent(p.name);
  const archived = p.archived === true || p.status === 'archived';
  const pending = p.pending ?? { jobs: 0, proposals: 0 };
  const drain = (value: boolean) =>
    void run(
      () => api.put(`/projects/${name}/draining`, { value }),
      value ? `${p.name} is paused and draining: it takes no new work.` : `${p.name} takes new work again.`,
    ).then(onChanged);
  const remove = () => {
    if (pending.jobs + pending.proposals > 0) {
      void confirm({
        title: `Pause and drain ${p.name} first?`,
        message: (
          <>
            <p>
              <strong>{p.name}</strong> still has {pending.jobs} unfinished job(s) and {pending.proposals}{' '}
              open proposal(s), so it cannot be removed yet.
            </p>
            <p>
              Pausing and draining it stops new work for it at once; its running jobs finish. Decide its
              proposals on the Proposals page, then remove it.
            </p>
          </>
        ),
        confirmLabel: p.draining ? 'Keep draining' : 'Pause and drain',
      }).then((ok) => ok && !p.draining && drain(true));
      return;
    }
    void confirm({
      title: `Remove ${p.name}?`,
      message: (
        <>
          <p>
            The bridge stops serving <strong>{p.name}</strong> and deletes its stored key. Its history (jobs,
            journal, errors) is kept and stays readable here. Nothing in LegendKeeper is changed.
          </p>
          <p className="small-text">
            Revoke the key in LegendKeeper too if nothing else uses it. To serve the project again later, add
            it with the same name and a key of the same LegendKeeper project.
          </p>
        </>
      ),
      confirmLabel: 'Remove the project',
      danger: true,
    }).then((ok) => {
      if (ok)
        void run(
          () => withReauth(() => api.post(`/projects/${name}/remove`, { confirm: true })),
          `${p.name} was removed; its history is kept.`,
        ).then(onChanged);
    });
  };
  const setReadOnly = (value: boolean) => {
    void confirm(
      value
        ? {
            title: `Make ${p.name} read-only?`,
            message: (
              <>
                <p>
                  Every write to <strong>{p.name}</strong> is refused until you turn this off, and its queued
                  writes are held. Reads carry on, and the other projects are not affected.
                </p>
                <p className="muted small-text">The change is audited.</p>
              </>
            ),
            confirmLabel: 'Make read-only',
          }
        : {
            title: `Allow writes to ${p.name} again?`,
            message: (
              <>
                <p>
                  The project’s own read-only flag is turned off, so agents may write to{' '}
                  <strong>{p.name}</strong> again, within every other guard. If read-only mode is on for the
                  whole bridge (Settings), writes are still refused.
                </p>
                <p className="muted small-text">The change is audited.</p>
              </>
            ),
            confirmLabel: 'Allow writes',
            danger: true,
          },
    ).then((ok) => {
      if (ok)
        void run(
          () => api.put(`/projects/${name}/read-only`, { value, confirm: true }),
          value ? `${p.name} is now read-only.` : `${p.name} accepts writes again.`,
        ).then(onChanged);
    });
  };
  if (archived) {
    return (
      <tr data-project={p.name} className="muted">
        <td>
          <strong>{p.name}</strong>
        </td>
        <td>{p.displayName ?? <span className="muted">–</span>}</td>
        <td>{p.id ? <span className="mono">{p.id}</span> : null}</td>
        <td>
          <span className="muted">no</span>
        </td>
        <td>{p.isSandbox ? <Badge>sandbox</Badge> : <span className="muted">no</span>}</td>
        <td>
          <Badge>read-only</Badge>
        </td>
        <td>
          <ProjectStatusBadge status="archived" />
          <div className="small-text">
            Removed {p.archivedAt ? fmtAgo(p.archivedAt, now) : ''}; its history is kept, read-only.
          </div>
        </td>
        <td>
          <span className="muted">Deleted</span>
        </td>
        <td />
      </tr>
    );
  }
  return (
    <>
      <tr data-project={p.name}>
        <td>
          <strong>{p.name}</strong>
          {p.draining && (
            <div>
              <Badge tone="warn">paused, draining</Badge>
            </div>
          )}
        </td>
        <td>{p.displayName ?? <span className="muted">–</span>}</td>
        <td>{p.id ? <span className="mono">{p.id}</span> : <span className="muted">not known yet</span>}</td>
        <td>{p.isDefault ? <Badge tone="info">default</Badge> : <span className="muted">no</span>}</td>
        <td>{p.isSandbox ? <Badge>sandbox</Badge> : <span className="muted">no</span>}</td>
        <td>
          <div className="stack">
            {p.readOnly ? <Badge tone="warn">read-only</Badge> : <Badge tone="ok">writes allowed</Badge>}
            <Button
              className="small"
              busy={busy}
              disabled={p.id === null}
              aria-label={p.readOnly ? `Allow writes to ${p.name}` : `Make ${p.name} read-only`}
              onClick={() => setReadOnly(!p.readOnly)}
            >
              {p.readOnly ? 'Allow writes…' : 'Make read-only…'}
            </Button>
            {p.id === null && <span className="muted small-text">Possible once its key is verified.</span>}
          </div>
        </td>
        <td>
          <ProjectStatusBadge status={p.status} />
          {p.reason && <div className="small-text">{p.reason}</div>}
          <div className="muted small-text">
            {p.checkedAt ? `Checked ${fmtAgo(p.checkedAt, now)}` : 'Not checked yet'}
            {p.verifiedAt ? ` · verified ${fmtAgo(p.verifiedAt, now)}` : ''}
          </div>
        </td>
        <td>
          {p.keySource === 'store' || p.keySource === 'env' || (p.configured && p.keyVariable) ? (
            <>
              <div className="small-text">
                {p.keySource === 'store' ? (
                  <>Encrypted store</>
                ) : (
                  <span className="mono">{p.keyVariable}</span>
                )}
                {p.keyHint && (
                  <>
                    {' '}
                    · ends <span className="mono">{p.keyHint}</span>
                  </>
                )}
              </div>
              <div className="row">
                {p.keyValid === true && <Badge tone="ok">valid</Badge>}
                {p.keyValid === false && <Badge tone="bad">refused</Badge>}
                {p.keyValid === null && <Badge>not checked yet</Badge>}
              </div>
              {p.keyConflict && <div className="note note-warn small-text">{p.keyConflict}</div>}
            </>
          ) : (
            <span className="muted">No key</span>
          )}
        </td>
        <td>
          <div className="stack">
            {p.id !== null && (
              <Button
                className="small"
                busy={busy}
                aria-label={`Replace the key of ${p.name}`}
                onClick={() => setReplacing(true)}
              >
                Replace key…
              </Button>
            )}
            {p.configured && (
              <Button
                className="small"
                busy={busy}
                aria-label={p.draining ? `Resume ${p.name}` : `Pause and drain ${p.name}`}
                onClick={() => drain(!p.draining)}
              >
                {p.draining ? 'Resume' : 'Pause and drain'}
              </Button>
            )}
            {p.id !== null && (
              <Button className="small danger" busy={busy} aria-label={`Remove ${p.name}`} onClick={remove}>
                Remove…
              </Button>
            )}
            {(pending.jobs > 0 || pending.proposals > 0) && (
              <span className="muted small-text">
                {pending.jobs} job(s), {pending.proposals} proposal(s) pending
              </span>
            )}
          </div>
          {p.configured && (
            <Button
              className="small"
              busy={busy}
              aria-label={`Check the key of ${p.name} again`}
              onClick={() =>
                void run(() => api.post<{ project?: ProjectInfo | null }>(`/projects/${name}/verify`)).then(
                  (r) => {
                    if (!r) return;
                    const status = r.project?.status;
                    toast(
                      status === 'active' ? 'ok' : 'error',
                      status
                        ? `${p.name}: ${PROJECT_STATUS_LABELS[status] ?? status}${r.project?.reason ? `. ${r.project.reason}` : '.'}`
                        : `${p.name} was checked.`,
                    );
                    onChanged();
                  },
                )
              }
            >
              Check key again
            </Button>
          )}
        </td>
      </tr>
      {replacing && (
        <tr className="key-row">
          <td colSpan={9}>
            <KeyForm
              mode="replace"
              project={p.name}
              onCancel={() => setReplacing(false)}
              onDone={() => {
                setReplacing(false);
                onChanged();
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/** OPS2: adding a project: a name, then its key in a write-only field, checked before anything is stored. */
function AddProjectCard({ canManage, onChanged }: { canManage: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="card" aria-labelledby="add-project-h">
      <h2 id="add-project-h">Add a project</h2>
      {!canManage ? (
        <p className="note note-warn small-text">
          Keys cannot be managed here yet: the bridge’s encrypted secret store has no master key
          (SECRETS_MASTER_KEY). Run env-sync on the server (runbook, “Managing projects from the dashboard”).
        </p>
      ) : open ? (
        <KeyForm
          mode="add"
          onCancel={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            onChanged();
          }}
        />
      ) : (
        <>
          <p className="muted small-text">
            Create an API key with the ADMIN role in the LegendKeeper project (Project Settings, Developers,
            API Keys), then paste it here. The bridge checks it with LegendKeeper and shows you what it found
            before it stores anything. After that the key is kept encrypted and never shown again, only its
            last four characters.
          </p>
          <Button className="primary" onClick={() => setOpen(true)}>
            Add a project…
          </Button>
        </>
      )}
    </section>
  );
}

/**
 * OPS2: one key, checked then confirmed. The key goes to the bridge once, in the check; the field is cleared at once, and
 * the confirmation refers to the check, not to the key.
 */
function KeyForm({
  mode,
  project,
  onCancel,
  onDone,
}: {
  mode: 'add' | 'replace';
  project?: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const withReauth = useReauth();
  const { run, busy } = useAction();
  const toast = useToast();
  const [check, setCheck] = useState<KeyCheck | null>(null);
  const [reminder, setReminder] = useState<string | null>(null);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    const f = new FormData(formEl);
    const apiKey = formText(f, 'apiKey');
    const body = mode === 'add' ? { name: formText(f, 'name'), apiKey } : { apiKey };
    const path =
      mode === 'add' ? '/projects/check' : `/projects/${encodeURIComponent(project ?? '')}/key/check`;
    void run(() => withReauth(() => api.post<KeyCheck>(path, body))).then((r) => {
      formEl.reset(); // the key is not kept in the page, whatever the answer
      if (r) setCheck(r);
    });
  };
  const confirmCheck = () =>
    void run(() =>
      withReauth(() =>
        api.post<{ project: ProjectInfo; reminder: string | null }>('/projects/confirm', {
          checkId: check?.checkId,
          confirm: true,
        }),
      ),
    ).then((r) => {
      if (!r) return;
      setCheck(null);
      if (r.reminder) setReminder(r.reminder);
      else {
        toast('ok', `${r.project.name} was added and is served now.`);
        onDone();
      }
    });

  if (reminder) {
    return (
      <div className="key-check" role="status">
        <p className="note note-warn">
          <strong>Key replaced.</strong> {reminder}
        </p>
        <Button className="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }
  if (check) {
    return (
      <div className="key-check" data-testid="key-check">
        <p>
          <strong>
            {mode === 'add' ? `Add “${check.name}” with this key?` : `Use this key for “${check.name}”?`}
          </strong>{' '}
          LegendKeeper says it belongs to:
        </p>
        <dl>
          <dt>Project</dt>
          <dd>{check.lkProjectName ?? <span className="muted">(no name)</span>}</dd>
          <dt>LegendKeeper id</dt>
          <dd className="mono">{check.lkProjectId}</dd>
          <dt>The key’s role</dt>
          <dd>
            {check.role === 'ADMIN' ? (
              <Badge tone="ok">ADMIN</Badge>
            ) : (
              <>
                <Badge tone="warn">{check.role === 'MEMBER' ? 'MEMBER' : 'unknown'}</Badge>{' '}
                <span className="small-text">
                  The bridge needs an ADMIN key for templates, top-level pages and members.
                </span>
              </>
            )}
          </dd>
          <dt>Key</dt>
          <dd>
            ends <span className="mono">{check.keyHint}</span>
          </dd>
        </dl>
        <p className="muted small-text">
          Nothing is stored until you confirm
          {mode === 'add' ? '; the project is served at once, without a restart' : ''}.
        </p>
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              setCheck(null);
              onCancel();
            }}
          >
            Cancel
          </button>
          <Button busy={busy} className="primary" onClick={confirmCheck}>
            {mode === 'add' ? 'Add the project' : 'Use this key'}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <form className="stack-form" onSubmit={submit} autoComplete="off">
      {mode === 'add' && (
        <>
          <label htmlFor="new-project-name">Name on this bridge</label>
          <input
            id="new-project-name"
            name="name"
            required
            maxLength={32}
            pattern="[A-Za-z][A-Za-z0-9_]{0,31}"
            placeholder="for example arkona"
            autoComplete="off"
          />
          <span className="muted small-text">
            A letter, then letters, digits or underscores (stored in lower case). Agents name the project with
            it.
          </span>
        </>
      )}
      <label htmlFor={`key-${mode}-${project ?? 'new'}`}>
        {mode === 'add' ? 'API key' : `New API key for ${project ?? ''}`}
      </label>
      <input
        id={`key-${mode}-${project ?? 'new'}`}
        name="apiKey"
        type="password"
        autoComplete="off"
        spellCheck={false}
        required
      />
      <span className="muted small-text">
        {mode === 'add'
          ? 'Write-only: the key is checked, then kept encrypted. It is never shown again.'
          : 'It must be a key of the same LegendKeeper project; anything else is refused.'}
      </span>
      <div className="actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <Button busy={busy} type="submit" className="primary">
          Check the key
        </Button>
      </div>
    </form>
  );
}

/** A setting's value, readable: ids in monospace, maps (template ids by role) as a list. */
function SettingValue({ value }: { value: unknown }) {
  if (value === undefined || value === null || value === '') return <span className="muted">not set</span>;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return <span className="mono">{String(value)}</span>;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="muted">none</span>;
    return (
      <ul className="plain">
        {entries.map(([k, v]) => (
          <li key={k}>
            {k} → <span className="mono">{typeof v === 'string' ? v : prettyJson(v)}</span>
          </li>
        ))}
      </ul>
    );
  }
  return <span className="mono">{prettyJson(value)}</span>;
}

function SettingsList({
  project,
  keys,
  onChanged,
}: {
  project: ProjectInfo;
  keys: ProjectSettingKey[];
  onChanged: () => void;
}) {
  const known = new Set(keys.map((k) => k.key));
  const extra = Object.keys(project.settings ?? {}).filter((k) => !known.has(k));
  return (
    <dl className="settings-list">
      {keys
        .filter((k) => k.kind !== 'rules')
        .map((k) => (
          <div key={k.key} data-setting={k.key}>
            <dt>
              {k.label} <span className="muted small-text">({k.kind})</span>
            </dt>
            <dd>
              <SettingEditor project={project} setting={k} onChanged={onChanged} />
              {k.help && <div className="muted small-text">{k.help}</div>}
            </dd>
          </div>
        ))}
      {extra.map((k) => (
        <div key={k}>
          <dt className="mono">{k}</dt>
          <dd>
            <SettingValue value={project.settings[k]} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One setting: its value (or its default), and for an editable one, Edit / Save / Clear. Audited by the bridge. */
function SettingEditor({
  project: p,
  setting: k,
  onChanged,
}: {
  project: ProjectInfo;
  setting: ProjectSettingKey;
  onChanged: () => void;
}) {
  const value = p.settings?.[k.key];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const shown =
    value === undefined && k.default !== undefined ? (
      <span>
        <SettingValue value={k.kind === 'on/off' ? (k.default ? 'on' : 'off') : k.default} />{' '}
        <span className="muted small-text">(default)</span>
      </span>
    ) : (
      <SettingValue
        value={k.kind === 'on/off' && typeof value === 'boolean' ? (value ? 'on' : 'off') : value}
      />
    );
  if (!k.editable || p.id === null) return shown;
  const save = (v: string | boolean | null) => {
    const go = () =>
      void run(
        () => api.put(`/projects/${encodeURIComponent(p.name)}/settings`, { key: k.key, value: v }),
        `${k.label} of ${p.name} saved.`,
      ).then((r) => {
        if (r) {
          setEditing(false);
          onChanged();
        }
      });
    if (k.key === 'aiRepositoryRootId' && value !== undefined && v !== value) {
      void confirm({
        title: `Change the AI REPOSITORY root of ${p.name}?`,
        message: (
          <p>
            The repository tree built for the current root is discarded. The new root needs a first build
            (Repository Tree page).
          </p>
        ),
        confirmLabel: 'Change the root',
        danger: true,
      }).then((ok) => ok && go());
    } else go();
  };
  if (!editing) {
    return (
      <div className="setting-edit">
        {shown}
        {k.kind === 'on/off' ? (
          <Button
            className="small"
            busy={busy}
            aria-label={`Switch ${k.label} of ${p.name}`}
            onClick={() => save(!(value === undefined ? k.default === true : value === true))}
          >
            {(value === undefined ? k.default === true : value === true) ? 'Switch off' : 'Switch on'}
          </Button>
        ) : (
          <Button
            className="small"
            busy={busy}
            aria-label={`Edit ${k.label} of ${p.name}`}
            onClick={() => {
              setDraft(typeof value === 'string' ? value : '');
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
        {value !== undefined && (
          <Button
            className="small"
            busy={busy}
            aria-label={`Clear ${k.label} of ${p.name}`}
            onClick={() => save(null)}
          >
            {k.default !== undefined ? 'Use default' : 'Clear'}
          </Button>
        )}
      </div>
    );
  }
  return (
    <form
      className="setting-edit"
      onSubmit={(e) => {
        e.preventDefault();
        save(draft.trim() === '' ? null : draft.trim());
      }}
    >
      <label className="offscreen" htmlFor={`set-${p.name}-${k.key}`}>
        {k.label} of {p.name}
      </label>
      <input
        id={`set-${p.name}-${k.key}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={
          typeof k.default === 'string' ? k.default : k.kind === 'resource id' ? 'for example h0gczxh7' : ''
        }
        autoFocus
      />
      <Button className="small" busy={busy} type="submit">
        Save
      </Button>
      <button type="button" className="small" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  );
}

function SettingsCard({ data, onChanged }: { data: ProjectsResponse; onChanged: () => void }) {
  return (
    <section className="card" aria-labelledby="project-settings-h">
      <h2 id="project-settings-h">Settings</h2>
      <p className="muted small-text">
        Each project’s settings. Changes are audited, and the repository tree uses them at once. Keys are
        never shown, only their last four characters.
      </p>
      {data.projects
        .filter((p) => p.status !== 'archived')
        .map((p) => (
          <section key={p.name} aria-label={`Settings of ${p.name}`} data-project-settings={p.name}>
            <h3>
              {p.name}{' '}
              {p.status !== 'active' && (
                <span className="muted small-text">({PROJECT_STATUS_LABELS[p.status] ?? p.status})</span>
              )}
            </h3>
            {p.settingsProblem && (
              <p className="note note-warn small-text">
                The stored settings could not be read, so they count as empty: {p.settingsProblem}
              </p>
            )}
            {p.id === null && (
              <p className="muted small-text">Settings can be changed once the project’s key is verified.</p>
            )}
            <SettingsList project={p} keys={data.settingKeys} onChanged={onChanged} />
          </section>
        ))}
    </section>
  );
}

const ruleText = (r: CanonRule) =>
  r.kind === 'value'
    ? `${r.key} = ${(r.values ?? []).join(' or ')}: setting it to, or changing it from, this value needs canonical approval`
    : r.kind === 'delete'
      ? `${r.key} = ${(r.values ?? []).join(' or ')}: deleting such a page (or a subtree holding one) needs canonical approval; restoring does not`
      : r.kind === 'deleteKind'
        ? `Deleting a ${(r.kinds ?? []).map((k) => `[${k.toUpperCase()}]`).join(' or ')} page (or a subtree holding one) needs canonical approval (recommended)`
        : r.kind === 'deleteDocument'
          ? `${r.key} = ${(r.values ?? []).join(' or ')}: deleting a ${(r.documentTypes ?? []).map((t) => (t === 'time' ? 'timeline' : t)).join(', ')} of such a page needs canonical approval (recommended)`
          : r.kind === 'statusTags'
            ? 'Status tags (CANON, Working, Archived): added or removed only by the lifecycle tools and by creates according to their status; any other route is refused (every other tag stays free)'
            : `${r.key}: changing an existing value needs canonical approval (setting it where empty is allowed)`;

/**
 * v2 C2a (ADR 0032): each project's protected canonical facts. A change that touches one becomes a proposal only the
 * owner's "Approve and accept as canon" can run, whatever the agent's scope. Every change here is audited.
 */
function CanonCard({ data }: { data: ProjectsResponse }) {
  const projects = data.projects.filter((p) => p.status !== 'archived' && p.id !== null);
  if (projects.length === 0) return null;
  return (
    <section className="card" aria-labelledby="canon-h">
      <h2 id="canon-h">Canon</h2>
      <p className="muted small-text">
        The facts that are protected canon. An agent can never make, or undo, these changes on its own: they
        become proposals that only “Approve and accept as canon” can run, whatever the agent’s scope.
      </p>
      {projects.map((p) => (
        <CanonEditor key={p.name} project={p} />
      ))}
    </section>
  );
}

function CanonEditor({ project: p }: { project: ProjectInfo }) {
  const c = useApi<CanonConfig>(`/projects/${encodeURIComponent(p.name)}/canon`);
  const { run, busy } = useAction();
  // C2d (ADR 0036 decision 4): saving the rules asks the owner to sign in again (within 5 minutes).
  const withReauth = useReauth();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<CanonRule[] | null>(null);
  const [key, setKey] = useState('');
  const [kind, setKind] = useState<'value' | 'change' | 'delete'>('value');
  const [values, setValues] = useState('');
  if (!c.data) return c.error ? <ErrorNote error={c.error} onRetry={c.reload} /> : <Loading />;
  const rules = draft ?? c.data.rules;
  const editing = draft !== null;
  const save = (next: CanonRule[] | null, label: string) =>
    void confirm({
      title: `${label} for ${p.name}?`,
      message: (
        <p>
          {next === null
            ? 'The default rules apply again.'
            : `${next.filter((r) => r.enabled !== false).length} rule${next.filter((r) => r.enabled !== false).length === 1 ? '' : 's'} will protect canon${next.some((r) => r.enabled === false) ? ` (${next.filter((r) => r.enabled === false).length} switched off)` : ''}. Anything not listed can be changed by agents with scope “write”.`}
        </p>
      ),
      confirmLabel: 'Save',
      danger:
        next !== null &&
        next.filter((r) => r.enabled !== false).length <
          c.data!.rules.filter((r) => r.enabled !== false).length,
    }).then((ok) => {
      if (!ok) return;
      void run(
        () =>
          withReauth(() =>
            api.put(`/projects/${encodeURIComponent(p.name)}/canon`, {
              rules: next,
              confirm: true,
            }),
          ),
        'Canon rules saved.',
      ).then((r) => {
        if (r) {
          setDraft(null);
          c.reload();
        }
      });
    });
  const addRule = (e: FormEvent) => {
    e.preventDefault();
    const k = key.trim();
    if (!k) return;
    const id =
      k
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'rule';
    const rule: CanonRule =
      kind === 'value' || kind === 'delete'
        ? {
            id,
            key: k,
            kind,
            values: values
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean),
          }
        : { id, key: k, kind };
    if (rule.kind !== 'change' && (rule.values ?? []).length === 0) return;
    const ruleId = rule.kind === 'delete' ? `delete-${id}` : id;
    setDraft([...rules.filter((r) => r.id !== ruleId), { ...rule, id: ruleId }]);
    setKey('');
    setValues('');
  };
  return (
    <section aria-label={`Canon of ${p.name}`} data-canon={p.name}>
      <h3>
        {p.name} {c.data.defaults && <span className="muted small-text">(the default rules)</span>}
      </h3>
      {c.data.problem && <p className="note note-warn small-text">{c.data.problem}</p>}
      {rules.length === 0 ? (
        <p className="note note-warn">No fact is protected: agents with scope “write” can change any fact.</p>
      ) : (
        <ul className="plain" aria-label={`Protected facts of ${p.name}`}>
          {rules.map((r) => (
            <li key={r.id} data-rule={r.id} className={r.enabled === false ? 'muted' : undefined}>
              {ruleText(r)}
              {r.enabled === false && <span className="small-text"> (switched off)</span>}{' '}
              <button
                type="button"
                className="small"
                aria-label={`${r.enabled === false ? 'Switch on' : 'Switch off'} the rule ${r.id} of ${p.name}`}
                onClick={() =>
                  setDraft(rules.map((x) => (x.id === r.id ? { ...x, enabled: x.enabled === false } : x)))
                }
              >
                {r.enabled === false ? 'Switch on' : 'Switch off'}
              </button>{' '}
              <button
                type="button"
                className="small"
                aria-label={`Remove the rule ${r.key ?? r.id} of ${p.name}`}
                onClick={() => setDraft(rules.filter((x) => x.id !== r.id))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="row" onSubmit={addRule} aria-label={`Add a protected fact to ${p.name}`}>
        <label htmlFor={`canon-key-${p.name}`}>Fact</label>
        <input
          id={`canon-key-${p.name}`}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Status"
        />
        <label htmlFor={`canon-kind-${p.name}`}>Protect</label>
        <select
          id={`canon-kind-${p.name}`}
          value={kind}
          onChange={(e) =>
            setKind(e.target.value === 'change' ? 'change' : e.target.value === 'delete' ? 'delete' : 'value')
          }
        >
          <option value="value">these values, both ways</option>
          <option value="change">any change of a set value</option>
          <option value="delete">deleting a page with these values</option>
        </select>
        {kind !== 'change' && (
          <>
            <label htmlFor={`canon-values-${p.name}`}>Values</label>
            <input
              id={`canon-values-${p.name}`}
              value={values}
              onChange={(e) => setValues(e.target.value)}
              placeholder="Authoritative"
            />
          </>
        )}
        <button type="submit" className="small">
          Add
        </button>
      </form>
      <p className="muted small-text">
        The Status of pages agents create follows the page lifecycle (Working by default): see Lifecycle
        below.
      </p>
      <div className="row mt">
        <Button
          variant="primary"
          busy={busy}
          disabled={!editing}
          onClick={() => save(rules, 'Save the canon rules')}
        >
          Save
        </Button>
        {editing && (
          <button type="button" className="small" onClick={() => setDraft(null)}>
            Discard changes
          </button>
        )}
        {!c.data.defaults && (
          <Button busy={busy} onClick={() => save(null, 'Restore the default rules')}>
            Restore the defaults
          </Button>
        )}
      </div>
    </section>
  );
}

// ============================================================================================ v2 C2c: the lifecycle

/**
 * v2 C2c (ADR 0035): each project's page lifecycle. [INDEX] Working and [INDEX] Archived are found by name through the
 * repository tree (never by id or position) and confirmed here; until both are confirmed the lifecycle tools, and
 * creates with the default Working status, refuse. The status values, tags, field names, Continuity Types and archive
 * texts default to the owner's values. Every change is audited.
 */
function LifecycleCard({ data }: { data: ProjectsResponse }) {
  const projects = data.projects.filter((p) => p.status !== 'archived' && p.id !== null);
  if (projects.length === 0) return null;
  return (
    <section className="card" aria-labelledby="lifecycle-h">
      <h2 id="lifecycle-h">Lifecycle</h2>
      <p className="muted small-text">
        Pages are Authoritative ([BSRC], in their normal place), Working ([BWRK], under [INDEX] Working) or
        Archived ([BARC], under [INDEX] Archived). Only archive_page, unarchive_page, move_to_working and
        promote_page change a page’s state, each with your canonical approval. The changes are listed on the
        Archive and lifecycle page.
      </p>
      {projects.map((p) => (
        <LifecycleEditor key={p.name} project={p} />
      ))}
    </section>
  );
}

const lookupText = (l: LifecycleIndexLookup) =>
  l.status === 'found'
    ? `found: ${l.node!.path} (${l.node!.id})`
    : l.status === 'missing'
      ? `no index named “${l.name}” in the repository tree`
      : `${l.candidates?.length ?? 0} indexes named “${l.name}”: ${(l.candidates ?? []).map((c) => c.path).join('; ')}`;

type Group = 'indexNames' | 'status' | 'tags' | 'fields' | 'continuityTypes' | 'texts';
const GROUPS: { key: Group; label: string; fields: [string, string][] }[] = [
  {
    key: 'indexNames',
    label: 'Index names (found by these)',
    fields: [
      ['working', 'Working'],
      ['archived', 'Archived'],
    ],
  },
  {
    key: 'status',
    label: 'Status values',
    fields: [
      ['authoritative', 'Authoritative'],
      ['working', 'Working'],
      ['archived', 'Archived'],
    ],
  },
  {
    key: 'tags',
    label: 'Status tags',
    fields: [
      ['canon', 'Authoritative'],
      ['working', 'Working'],
      ['archived', 'Archived'],
    ],
  },
  {
    key: 'fields',
    label: 'Fact names',
    fields: [
      ['status', 'Status'],
      ['continuityType', 'Continuity Type'],
      ['scope', 'Scope'],
      ['temporalScope', 'Temporal Scope'],
      ['lastMajorRevision', 'Last Major Revision'],
    ],
  },
  {
    key: 'continuityTypes',
    label: 'Continuity Types',
    fields: [
      ['canon', 'Canon'],
      ['au', 'Alternate universe'],
      ['nonCurrent', 'Archived'],
    ],
  },
  {
    key: 'texts',
    label: 'Archive texts ({date} and {source} are filled in)',
    fields: [
      ['noteFromAuthoritative', 'Note, from Authoritative'],
      ['noteFromWorking', 'Note, from Working'],
      ['scopePrefix', 'Scope prefix (then one space and the original)'],
      ['temporalFromAuthoritative', 'Temporal Scope, from Authoritative'],
      ['temporalFromWorking', 'Temporal Scope, from Working'],
      ['noteForIndex', 'Note on an index archived with its set'],
    ],
  },
];

function LifecycleEditor({ project: p }: { project: ProjectInfo }) {
  const v = useApi<LifecycleView>(`/projects/${encodeURIComponent(p.name)}/lifecycle`);
  const { run, busy } = useAction();
  // C2d (ADR 0036 decision 4): saving the lifecycle settings asks the owner to sign in again (within 5 minutes).
  const withReauth = useReauth();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Partial<Record<Group, Record<string, string>>>>({});
  if (!v.data) return v.error ? <ErrorNote error={v.error} onRetry={v.reload} /> : <Loading />;
  const d = v.data;
  const c = d.config;
  const value = (g: Group, f: string) => draft[g]?.[f] ?? (c[g] as Record<string, string>)[f] ?? '';
  const edited = Object.keys(draft).length > 0;
  const put = (body: Record<string, unknown>, label: string, message: string) =>
    void confirm({ title: `${label} for ${p.name}?`, message: <p>{message}</p>, confirmLabel: 'Save' }).then(
      (ok) => {
        if (!ok) return;
        void run(
          () =>
            withReauth(() =>
              api.put(`/projects/${encodeURIComponent(p.name)}/lifecycle`, { ...body, confirm: true }),
            ),
          'Lifecycle settings saved.',
        ).then((r) => {
          if (r) {
            setDraft({});
            v.reload();
          }
        });
      },
    );
  const canConfirm =
    d.working.status === 'found' &&
    d.archived.status === 'found' &&
    (d.working.node!.id !== c.workingIndexId || d.archived.node!.id !== c.archiveIndexId);
  return (
    <section aria-label={`Lifecycle of ${p.name}`} data-lifecycle={p.name}>
      <h3>
        {p.name}{' '}
        {d.confirmed.ok ? <Badge tone="ok">confirmed</Badge> : <Badge tone="warn">not confirmed</Badge>}
      </h3>
      {c.problem && <p className="note note-warn small-text">{c.problem}</p>}
      {!d.confirmed.ok && d.confirmed.message && (
        <p className="note note-warn small-text">{d.confirmed.message}</p>
      )}
      <dl className="kv">
        <dt>[INDEX] {c.indexNames.working}</dt>
        <dd>
          {lookupText(d.working)}
          {c.workingIndexId && <span className="muted small-text"> · confirmed: {c.workingIndexId}</span>}
        </dd>
        <dt>[INDEX] {c.indexNames.archived}</dt>
        <dd>
          {lookupText(d.archived)}
          {c.archiveIndexId && <span className="muted small-text"> · confirmed: {c.archiveIndexId}</span>}
        </dd>
      </dl>
      {canConfirm && (
        <Button
          variant="primary"
          busy={busy}
          onClick={() =>
            put(
              { workingIndexId: d.working.node!.id, archiveIndexId: d.archived.node!.id },
              'Confirm the lifecycle indexes',
              `[INDEX] ${c.indexNames.working} is ${d.working.node!.path}; [INDEX] ${c.indexNames.archived} is ${d.archived.node!.path}.`,
            )
          }
        >
          Confirm these indexes
        </Button>
      )}
      <details className="mt">
        <summary>Values</summary>
        {GROUPS.map((g) => (
          <fieldset key={g.key} className="mt">
            <legend>{g.label}</legend>
            {g.fields.map(([f, label]) => (
              <div className="row" key={f}>
                <label htmlFor={`lc-${p.name}-${g.key}-${f}`}>{label}</label>
                <input
                  id={`lc-${p.name}-${g.key}-${f}`}
                  value={value(g.key, f)}
                  size={g.key === 'texts' ? 80 : 24}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      [g.key]: {
                        ...(c[g.key] as Record<string, string>),
                        ...draft[g.key],
                        [f]: e.target.value,
                      },
                    })
                  }
                />
              </div>
            ))}
          </fieldset>
        ))}
        <div className="row mt">
          <Button
            variant="primary"
            busy={busy}
            disabled={!edited}
            onClick={() =>
              put(draft, 'Save the lifecycle values', 'The lifecycle tools use them from the next call.')
            }
          >
            Save
          </Button>
          {edited && (
            <button type="button" className="small" onClick={() => setDraft({})}>
              Discard changes
            </button>
          )}
          <Button
            busy={busy}
            onClick={() =>
              put(
                { reset: true },
                'Restore the default lifecycle settings',
                'The owner’s values apply again, and the two indexes must be confirmed again.',
              )
            }
          >
            Restore the defaults
          </Button>
        </div>
      </details>
    </section>
  );
}

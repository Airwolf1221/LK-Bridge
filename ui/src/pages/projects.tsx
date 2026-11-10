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
import type { KeyCheck, ProjectInfo, ProjectSettingKey, ProjectsResponse } from '../types';

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
      {keys.map((k) => (
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

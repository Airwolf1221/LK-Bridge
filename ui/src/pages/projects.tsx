import { api } from '../api';
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
import type { ProjectInfo, ProjectSettingKey, ProjectsResponse } from '../types';

/**
 * Projects (v2 A1): every LegendKeeper project the bridge knows, its flags and status, and whether its key is configured
 * and valid. A key is never shown, only the name of the env variable that holds it (the API never sends one). The
 * per-project read-only flag is the one thing editable here; settings are shown read-only in this release.
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
      {data.projects.length === 0 ? (
        <Empty>No projects are configured.</Empty>
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
          <SettingsCard data={data} />
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
  const name = encodeURIComponent(p.name);
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
  return (
    <tr data-project={p.name}>
      <td>
        <strong>{p.name}</strong>
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
        {p.configured && p.keyVariable ? (
          <>
            <div className="mono small-text">{p.keyVariable}</div>
            <div className="row">
              {p.keyPresent ? <Badge tone="ok">present</Badge> : <Badge tone="bad">missing</Badge>}
              {p.keyValid === true && <Badge tone="ok">valid</Badge>}
              {p.keyValid === false && <Badge tone="bad">refused</Badge>}
              {p.keyValid === null && <Badge>not checked yet</Badge>}
            </div>
          </>
        ) : (
          <span className="muted">No key configured</span>
        )}
      </td>
      <td>
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

function SettingsList({ project, keys }: { project: ProjectInfo; keys: ProjectSettingKey[] }) {
  const known = new Set(keys.map((k) => k.key));
  const extra = Object.keys(project.settings ?? {}).filter((k) => !known.has(k));
  return (
    <dl className="settings-list">
      {keys.map((k) => (
        <div key={k.key}>
          <dt>
            {k.label} <span className="muted small-text">({k.kind})</span>
          </dt>
          <dd>
            <SettingValue value={project.settings?.[k.key]} />
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

function SettingsCard({ data }: { data: ProjectsResponse }) {
  return (
    <section className="card" aria-labelledby="project-settings-h">
      <h2 id="project-settings-h">Settings</h2>
      <p className="muted small-text">
        Each project’s settings, read-only here: editing them comes in a later release. Keys stay in the env
        file and are never shown.
      </p>
      {data.projects.map((p) => (
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
          <SettingsList project={p} keys={data.settingKeys} />
        </section>
      ))}
    </section>
  );
}

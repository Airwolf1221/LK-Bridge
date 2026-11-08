import { useState } from 'react';
import { api, qs } from '../api';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, useAction, useConfirm } from '../components';
import { fmtTime } from '../format';
import { useApi, useReloadOn } from '../hooks';
import { Link, useRoute } from '../router';

/**
 * Repository Mappings (PLAN §8 page 7, docs/mappings.md): mapping sets, type rules, field maps, import and export,
 * a readable summary and a read-only preview. Data and forms only: there is no inference engine.
 */

type Selector =
  | { kind: 'subtree'; resourceId: string; descendants: boolean }
  | { kind: 'template'; templateId: string }
  | { kind: 'tag'; tag: string };

type Location =
  | { kind: 'sidebar_property'; title: string }
  | { kind: 'infobox_row'; infoboxTitle: string; rowKey: string }
  | { kind: 'block'; heading?: string; blockId?: string };

interface MappingSet {
  id: string;
  name: string;
  description: string;
  notes: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}
interface SetSummary extends MappingSet {
  ruleCount: number;
  fieldCount: number;
}
interface TypeRule {
  id: string;
  selector: Selector;
  semanticType: string;
  priority: number;
  notes: string;
  createdAt: number;
  updatedAt: number;
}
interface FieldMap {
  id: string;
  semanticType: string;
  fieldName: string;
  location: Location;
  expectedKind: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
}
interface SummaryText {
  headline: string;
  types: { semanticType: string; rules: string[]; fields: string[] }[];
  warnings: string[];
}
interface SetDetail {
  set: MappingSet;
  rules: TypeRule[];
  fields: FieldMap[];
  summary: SummaryText;
}
interface ListResponse {
  sets: SetSummary[];
  expectedKinds: string[];
  suggestedTypes: string[];
}
interface Preview {
  resource: { id: string; name: string | null; tags: string[] };
  ancestors: { id: string; name: string | null }[];
  ancestorsIncomplete: boolean;
  matches: { ruleId: string; semanticType: string; priority: number; description: string; via: string }[];
  notEvaluable: { ruleId: string; description: string; reason: string }[];
  semanticType: string | null;
  tie: boolean;
  fields: FieldMap[];
  readsMade: number;
}

const KIND_LABEL: Record<string, string> = {
  text: 'Text',
  number: 'Number',
  resource_link: 'Resource link',
  list: 'List',
  date: 'Date',
  boolean: 'Yes or no',
  image: 'Image',
  other: 'Other',
};

export function MappingsPage() {
  const { path } = useRoute();
  const id = path.startsWith('/mappings/') ? decodeURIComponent(path.slice('/mappings/'.length)) : null;
  return id ? <SetPage id={id} /> : <SetsPage />;
}

// ------------------------------------------------------------------------------------------------- the list

function SetsPage() {
  const list = useApi<ListResponse>('/mappings');
  useReloadOn(['policy'], list.reload, 300);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const { sets } = list.data;

  return (
    <>
      <PageHeader title="Repository Mappings" />
      <p className="muted">
        A <strong>mapping set</strong> describes how a repository is organised: which pages are which semantic
        type (<strong>type rules</strong>), and where each type keeps its facts (<strong>field maps</strong>).
        Nothing here changes LegendKeeper, and nothing uses a set yet: this is the record the future
        intelligent mapping will read. At most one set is active.
      </p>
      <section className="card" aria-labelledby="sets-h">
        <h2 id="sets-h">Mapping sets</h2>
        {sets.length === 0 ? (
          <Empty>No mapping sets yet. Create one below, or import one from a file.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th className="num">Type rules</th>
                  <th className="num">Field maps</th>
                  <th>Updated</th>
                  <th>
                    <span className="offscreen">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sets.map((s) => (
                  <tr key={s.id} data-set={s.id}>
                    <td>
                      <Link to={`/mappings/${s.id}`}>{s.name}</Link>
                      {s.description && <div className="muted small-text">{s.description}</div>}
                    </td>
                    <td>{s.active ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge>}</td>
                    <td className="num">{s.ruleCount}</td>
                    <td className="num">{s.fieldCount}</td>
                    <td>{fmtTime(s.updatedAt)}</td>
                    <td>
                      <div className="row">
                        <Button
                          className="small"
                          busy={busy}
                          aria-label={`${s.active ? 'Deactivate' : 'Activate'} ${s.name}`}
                          onClick={() =>
                            void run(
                              () =>
                                api.post(`/mappings/sets/${s.id}/${s.active ? 'deactivate' : 'activate'}`),
                              s.active
                                ? `“${s.name}” is no longer active.`
                                : `“${s.name}” is now the active set.`,
                            ).then(list.reload)
                          }
                        >
                          {s.active ? 'Deactivate' : 'Activate'}
                        </Button>
                        <ExportButton id={s.id} name={s.name} />
                        <Button
                          className="small"
                          variant="danger"
                          busy={busy}
                          aria-label={`Delete ${s.name}`}
                          onClick={() => {
                            void confirm({
                              title: `Delete “${s.name}”?`,
                              message: (
                                <p>
                                  Its {s.ruleCount} type rules and {s.fieldCount} field maps go with it.
                                  Export it first if you may want it back.
                                </p>
                              ),
                              confirmLabel: 'Delete',
                              danger: true,
                            }).then((ok) => {
                              if (ok)
                                void run(
                                  () => api.post(`/mappings/sets/${s.id}/delete`, { confirm: true }),
                                  'Deleted.',
                                ).then(list.reload);
                            });
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <NewSetCard onCreated={list.reload} />
      <ImportCard onImported={list.reload} />
    </>
  );
}

function NewSetCard({ onCreated }: { onCreated: () => void }) {
  const { run, busy } = useAction();
  const { navigate } = useRoute();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <section className="card" aria-labelledby="new-h">
      <h2 id="new-h">New mapping set</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () => api.post<{ set: MappingSet }>('/mappings/sets', { name, description }),
            'Set created.',
          ).then((r) => {
            if (!r) return;
            setName('');
            setDescription('');
            onCreated();
            navigate(`/mappings/${r.set.id}`);
          });
        }}
      >
        <div className="field-row">
          <div>
            <label htmlFor="ns-name">Name</label>
            <input
              id="ns-name"
              value={name}
              maxLength={120}
              placeholder="For example, Baisheng taxonomy"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="ns-desc">Description</label>
            <input id="ns-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <Button variant="primary" type="submit" busy={busy} disabled={name.trim() === ''}>
            Create set
          </Button>
        </div>
      </form>
    </section>
  );
}

function ImportCard({ onImported }: { onImported: () => void }) {
  const [busy, setBusy] = useState(false);
  const { navigate } = useRoute();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <section className="card" aria-labelledby="imp-h">
      <h2 id="imp-h">Import a mapping set</h2>
      <p className="muted small-text">
        Paste an exported file or choose one. The file is checked as a whole first; an import always makes a
        new, inactive set and never changes an existing one.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setProblem(null);
          setBusy(true);
          void api
            .post<SetDetail>('/mappings/import', {
              document: text,
              ...(name.trim() ? { name: name.trim() } : {}),
            })
            .then(
              (r) => {
                setText('');
                setName('');
                onImported();
                navigate(`/mappings/${r.set.id}`);
              },
              (err: unknown) => setProblem(err instanceof Error ? err.message : String(err)),
            )
            .finally(() => setBusy(false));
        }}
      >
        <label htmlFor="imp-file">File</label>
        <input
          id="imp-file"
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void f.text().then(setText);
          }}
        />
        <label htmlFor="imp-text">Or paste the JSON</label>
        <textarea
          id="imp-text"
          rows={5}
          className="mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="field-row">
          <div>
            <label htmlFor="imp-name">Name (optional, to avoid a clash)</label>
            <input id="imp-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button variant="primary" type="submit" busy={busy} disabled={text.trim() === ''}>
            Import
          </Button>
        </div>
        {problem && (
          <div className="note note-bad" role="alert">
            {problem}
          </div>
        )}
      </form>
    </section>
  );
}

function ExportButton({ id, name }: { id: string; name: string }) {
  const { run, busy } = useAction();
  return (
    <Button
      className="small"
      busy={busy}
      aria-label={`Export ${name}`}
      onClick={() =>
        void run(() => api.get<{ document: unknown }>(`/mappings/sets/${id}/export`)).then((r) => {
          if (!r || typeof URL.createObjectURL !== 'function') return;
          const url = URL.createObjectURL(
            new Blob([JSON.stringify(r.document, null, 2)], { type: 'application/json' }),
          );
          const a = document.createElement('a');
          a.href = url;
          a.download = `${name.replace(/[^\w.-]+/g, '-').toLowerCase() || 'mapping-set'}.json`;
          a.click();
          URL.revokeObjectURL(url);
        })
      }
    >
      Export
    </Button>
  );
}

// -------------------------------------------------------------------------------------------------- one set

function SetPage({ id }: { id: string }) {
  const list = useApi<ListResponse>('/mappings'); // the kinds and suggested types for the forms
  const d = useApi<SetDetail>(`/mappings/sets/${encodeURIComponent(id)}`);
  useReloadOn(['policy'], d.reload, 300);
  if (d.error) return <ErrorNote error={d.error} onRetry={d.reload} />;
  if (!d.data || !list.data) return <Loading />;
  const { set, rules, fields, summary } = d.data;
  const types = [
    ...new Set([
      ...list.data.suggestedTypes,
      ...rules.map((r) => r.semanticType),
      ...fields.map((f) => f.semanticType),
    ]),
  ];

  return (
    <>
      <PageHeader title="Repository Mappings">
        <Link to="/mappings">All sets</Link>
      </PageHeader>
      <h2>
        {set.name} {set.active ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge>}
      </h2>
      <SummaryCard summary={summary} />
      <SetForm set={set} onSaved={d.reload} />
      <RulesCard setId={set.id} rules={rules} types={types} onChanged={d.reload} />
      <FieldsCard
        setId={set.id}
        fields={fields}
        types={types}
        kinds={list.data.expectedKinds}
        onChanged={d.reload}
      />
      <PreviewCard setId={set.id} />
    </>
  );
}

function SummaryCard({ summary }: { summary: SummaryText }) {
  return (
    <section className="card" aria-labelledby="sum-h">
      <h2 id="sum-h">Summary</h2>
      <p>{summary.headline}</p>
      {summary.warnings.length > 0 && (
        <div className="note note-warn" role="status">
          <strong>Worth a second look</strong>
          <ul>
            {summary.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {summary.types.length === 0 ? (
        <Empty>Nothing described yet. Add a type rule and some field maps below.</Empty>
      ) : (
        summary.types.map((t) => (
          <div key={t.semanticType} className="mt">
            <h3>{t.semanticType}</h3>
            {t.rules.length > 0 && (
              <>
                <div className="muted small-text">Which pages are a {t.semanticType}</div>
                <ul>
                  {t.rules.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </>
            )}
            {t.fields.length > 0 && (
              <>
                <div className="muted small-text">Where a {t.semanticType} keeps its facts</div>
                <ul>
                  {t.fields.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ))
      )}
    </section>
  );
}

function SetForm({ set, onSaved }: { set: MappingSet; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [name, setName] = useState(set.name);
  const [description, setDescription] = useState(set.description);
  const [notes, setNotes] = useState(set.notes);
  return (
    <section className="card" aria-labelledby="set-h">
      <h2 id="set-h">About this set</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.put(`/mappings/sets/${set.id}`, { name, description, notes }), 'Saved.').then(
            onSaved,
          );
        }}
      >
        <label htmlFor="set-name">Name</label>
        <input id="set-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="set-desc">Description</label>
        <input id="set-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
        <label htmlFor="set-notes">Notes</label>
        <textarea id="set-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <p className="muted small-text">
          Created {fmtTime(set.createdAt)} · updated {fmtTime(set.updatedAt)}
        </p>
        <Button variant="primary" type="submit" busy={busy} disabled={name.trim() === ''}>
          Save
        </Button>
      </form>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ type rules

const describeSelector = (s: Selector): string =>
  s.kind === 'subtree'
    ? `${s.descendants ? 'Resource and everything below' : 'Resource only'}: ${s.resourceId}`
    : s.kind === 'template'
      ? `Template: ${s.templateId}`
      : `Tag: ${s.tag}`;

function RulesCard({
  setId,
  rules,
  types,
  onChanged,
}: {
  setId: string;
  rules: TypeRule[];
  types: string[];
  onChanged: () => void;
}) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<TypeRule | 'new' | null>(null);
  return (
    <section className="card" aria-labelledby="rules-h">
      <div className="row-between">
        <h2 id="rules-h">Type rules</h2>
        <Button onClick={() => setEditing('new')}>Add a type rule</Button>
      </div>
      <p className="muted small-text">
        A rule says that pages picked by a selector are a semantic type. Where rules overlap, the higher
        priority wins.
      </p>
      {rules.length === 0 ? (
        <Empty>No type rules yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Selector</th>
                <th>Semantic type</th>
                <th className="num">Priority</th>
                <th>Notes</th>
                <th>
                  <span className="offscreen">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} data-rule={r.id}>
                  <td>{describeSelector(r.selector)}</td>
                  <td>{r.semanticType}</td>
                  <td className="num">{r.priority}</td>
                  <td>{r.notes}</td>
                  <td>
                    <div className="row">
                      <Button
                        className="small"
                        aria-label={`Edit the ${r.semanticType} rule for ${describeSelector(r.selector)}`}
                        onClick={() => setEditing(r)}
                      >
                        Edit
                      </Button>
                      <Button
                        className="small"
                        variant="danger"
                        busy={busy}
                        aria-label={`Delete the ${r.semanticType} rule for ${describeSelector(r.selector)}`}
                        onClick={() =>
                          void confirm({
                            title: 'Delete this type rule?',
                            message: (
                              <p>
                                {describeSelector(r.selector)} → <strong>{r.semanticType}</strong>
                              </p>
                            ),
                            confirmLabel: 'Delete',
                            danger: true,
                          }).then((ok) => {
                            if (ok)
                              void run(() => api.post(`/mappings/rules/${r.id}/delete`), 'Deleted.').then(
                                onChanged,
                              );
                          })
                        }
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <RuleForm
          key={editing === 'new' ? 'new' : editing.id}
          setId={setId}
          rule={editing === 'new' ? null : editing}
          types={types}
          onDone={() => {
            setEditing(null);
            onChanged();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function RuleForm({
  setId,
  rule,
  types,
  onDone,
  onCancel,
}: {
  setId: string;
  rule: TypeRule | null;
  types: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { run, busy } = useAction();
  const s = rule?.selector;
  const [kind, setKind] = useState<Selector['kind']>(s?.kind ?? 'subtree');
  const [target, setTarget] = useState(
    s?.kind === 'subtree'
      ? s.resourceId
      : s?.kind === 'template'
        ? s.templateId
        : s?.kind === 'tag'
          ? s.tag
          : '',
  );
  const [descendants, setDescendants] = useState(s?.kind === 'subtree' ? s.descendants : true);
  const [semanticType, setSemanticType] = useState(rule?.semanticType ?? '');
  const [priority, setPriority] = useState(String(rule?.priority ?? 0));
  const [notes, setNotes] = useState(rule?.notes ?? '');
  const selector: Selector =
    kind === 'subtree'
      ? { kind, resourceId: target.trim(), descendants }
      : kind === 'template'
        ? { kind, templateId: target.trim() }
        : { kind, tag: target.trim() };
  const body = { selector, semanticType: semanticType.trim(), priority: Number(priority), notes };
  const valid = target.trim() !== '' && semanticType.trim() !== '' && Number.isInteger(Number(priority));
  const label = { subtree: 'Resource id', template: 'Template id', tag: 'Tag' }[kind];
  return (
    <form
      className="mt"
      aria-label={rule ? 'Edit type rule' : 'New type rule'}
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          () =>
            rule
              ? api.put(`/mappings/rules/${rule.id}`, body)
              : api.post(`/mappings/sets/${setId}/rules`, body),
          'Type rule saved.',
        ).then((r) => r && onDone());
      }}
    >
      <h3>{rule ? 'Edit type rule' : 'New type rule'}</h3>
      <div className="field-row">
        <div>
          <label htmlFor="rule-kind">Selects</label>
          <select id="rule-kind" value={kind} onChange={(e) => setKind(e.target.value as Selector['kind'])}>
            <option value="subtree">a subtree of the repository</option>
            <option value="template">pages made from a template</option>
            <option value="tag">pages with a tag</option>
          </select>
        </div>
        <div>
          <label htmlFor="rule-target">{label}</label>
          <input id="rule-target" value={target} onChange={(e) => setTarget(e.target.value)} />
        </div>
        {kind === 'subtree' && (
          <label className="row" htmlFor="rule-desc">
            <input
              id="rule-desc"
              type="checkbox"
              checked={descendants}
              onChange={(e) => setDescendants(e.target.checked)}
            />
            Include everything below it
          </label>
        )}
      </div>
      <div className="field-row">
        <div>
          <label htmlFor="rule-type">Semantic type</label>
          <input
            id="rule-type"
            list="semantic-types"
            value={semanticType}
            onChange={(e) => setSemanticType(e.target.value)}
          />
          <datalist id="semantic-types">
            {types.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>
        <div>
          <label htmlFor="rule-priority">Priority (higher wins)</label>
          <input
            id="rule-priority"
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="rule-notes">Notes</label>
          <input id="rule-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      {kind === 'template' && (
        <p className="muted small-text">
          LegendKeeper does not record which template a page was made from, so the preview cannot check a
          template rule. It is kept for the future mapping.
        </p>
      )}
      <div className="row">
        <Button variant="primary" type="submit" busy={busy} disabled={!valid}>
          Save type rule
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------------------------------------ field maps

const describeLocation = (l: Location): string =>
  l.kind === 'sidebar_property'
    ? `Sidebar property “${l.title}”`
    : l.kind === 'infobox_row'
      ? `Infobox “${l.infoboxTitle}”, row “${l.rowKey}”`
      : l.heading !== undefined
        ? `Block under the heading “${l.heading}”`
        : `Block ${l.blockId ?? ''}`;

function FieldsCard({
  setId,
  fields,
  types,
  kinds,
  onChanged,
}: {
  setId: string;
  fields: FieldMap[];
  types: string[];
  kinds: string[];
  onChanged: () => void;
}) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<FieldMap | 'new' | null>(null);
  return (
    <section className="card" aria-labelledby="fields-h">
      <div className="row-between">
        <h2 id="fields-h">Field maps</h2>
        <Button onClick={() => setEditing('new')}>Add a field map</Button>
      </div>
      <p className="muted small-text">
        For each semantic type, where a named fact lives on its pages, and what kind of value to expect there.
      </p>
      {fields.length === 0 ? (
        <Empty>No field maps yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Semantic type</th>
                <th>Field</th>
                <th>Location</th>
                <th>Expected</th>
                <th>Notes</th>
                <th>
                  <span className="offscreen">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.id} data-field={f.id}>
                  <td>{f.semanticType}</td>
                  <td>{f.fieldName}</td>
                  <td>{describeLocation(f.location)}</td>
                  <td>{KIND_LABEL[f.expectedKind] ?? f.expectedKind}</td>
                  <td>{f.notes}</td>
                  <td>
                    <div className="row">
                      <Button
                        className="small"
                        aria-label={`Edit ${f.semanticType} field ${f.fieldName}`}
                        onClick={() => setEditing(f)}
                      >
                        Edit
                      </Button>
                      <Button
                        className="small"
                        variant="danger"
                        busy={busy}
                        aria-label={`Delete ${f.semanticType} field ${f.fieldName}`}
                        onClick={() =>
                          void confirm({
                            title: 'Delete this field map?',
                            message: (
                              <p>
                                {f.semanticType} → <strong>{f.fieldName}</strong>
                              </p>
                            ),
                            confirmLabel: 'Delete',
                            danger: true,
                          }).then((ok) => {
                            if (ok)
                              void run(() => api.post(`/mappings/fields/${f.id}/delete`), 'Deleted.').then(
                                onChanged,
                              );
                          })
                        }
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <FieldForm
          key={editing === 'new' ? 'new' : editing.id}
          setId={setId}
          field={editing === 'new' ? null : editing}
          types={types}
          kinds={kinds}
          onDone={() => {
            setEditing(null);
            onChanged();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function FieldForm({
  setId,
  field,
  types,
  kinds,
  onDone,
  onCancel,
}: {
  setId: string;
  field: FieldMap | null;
  types: string[];
  kinds: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { run, busy } = useAction();
  const l = field?.location;
  const [semanticType, setSemanticType] = useState(field?.semanticType ?? '');
  const [fieldName, setFieldName] = useState(field?.fieldName ?? '');
  const [kind, setKind] = useState<Location['kind']>(l?.kind ?? 'sidebar_property');
  const [title, setTitle] = useState(l?.kind === 'sidebar_property' ? l.title : '');
  const [infobox, setInfobox] = useState(l?.kind === 'infobox_row' ? l.infoboxTitle : '');
  const [rowKey, setRowKey] = useState(l?.kind === 'infobox_row' ? l.rowKey : '');
  const [blockBy, setBlockBy] = useState<'heading' | 'blockId'>(
    l?.kind === 'block' && l.blockId !== undefined ? 'blockId' : 'heading',
  );
  const [blockValue, setBlockValue] = useState(l?.kind === 'block' ? (l.heading ?? l.blockId ?? '') : '');
  const [expected, setExpected] = useState(field?.expectedKind ?? 'text');
  const [notes, setNotes] = useState(field?.notes ?? '');
  const location: Location =
    kind === 'sidebar_property'
      ? { kind, title: title.trim() }
      : kind === 'infobox_row'
        ? { kind, infoboxTitle: infobox.trim(), rowKey: rowKey.trim() }
        : blockBy === 'heading'
          ? { kind, heading: blockValue.trim() }
          : { kind, blockId: blockValue.trim() };
  const located =
    kind === 'sidebar_property'
      ? title.trim() !== ''
      : kind === 'infobox_row'
        ? infobox.trim() !== '' && rowKey.trim() !== ''
        : blockValue.trim() !== '';
  const valid = semanticType.trim() !== '' && fieldName.trim() !== '' && located;
  const body = {
    semanticType: semanticType.trim(),
    fieldName: fieldName.trim(),
    location,
    expectedKind: expected,
    notes,
  };
  return (
    <form
      className="mt"
      aria-label={field ? 'Edit field map' : 'New field map'}
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          () =>
            field
              ? api.put(`/mappings/fields/${field.id}`, body)
              : api.post(`/mappings/sets/${setId}/fields`, body),
          'Field map saved.',
        ).then((r) => r && onDone());
      }}
    >
      <h3>{field ? 'Edit field map' : 'New field map'}</h3>
      <div className="field-row">
        <div>
          <label htmlFor="fm-type">Semantic type</label>
          <input
            id="fm-type"
            list="fm-types"
            value={semanticType}
            onChange={(e) => setSemanticType(e.target.value)}
          />
          <datalist id="fm-types">
            {types.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>
        <div>
          <label htmlFor="fm-name">Semantic field name</label>
          <input id="fm-name" value={fieldName} onChange={(e) => setFieldName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="fm-expected">Expected kind</label>
          <select id="fm-expected" value={expected} onChange={(e) => setExpected(e.target.value)}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k] ?? k}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field-row">
        <div>
          <label htmlFor="fm-kind">Found in</label>
          <select id="fm-kind" value={kind} onChange={(e) => setKind(e.target.value as Location['kind'])}>
            <option value="sidebar_property">a sidebar property</option>
            <option value="infobox_row">an infobox row</option>
            <option value="block">a block of the page</option>
          </select>
        </div>
        {kind === 'sidebar_property' && (
          <div>
            <label htmlFor="fm-title">Property title</label>
            <input id="fm-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        )}
        {kind === 'infobox_row' && (
          <>
            <div>
              <label htmlFor="fm-infobox">Infobox title</label>
              <input id="fm-infobox" value={infobox} onChange={(e) => setInfobox(e.target.value)} />
            </div>
            <div>
              <label htmlFor="fm-row">Row key</label>
              <input id="fm-row" value={rowKey} onChange={(e) => setRowKey(e.target.value)} />
            </div>
          </>
        )}
        {kind === 'block' && (
          <>
            <div>
              <label htmlFor="fm-by">Identified by</label>
              <select
                id="fm-by"
                value={blockBy}
                onChange={(e) => setBlockBy(e.target.value as 'heading' | 'blockId')}
              >
                <option value="heading">the text of a heading</option>
                <option value="blockId">a block id</option>
              </select>
            </div>
            <div>
              <label htmlFor="fm-block">{blockBy === 'heading' ? 'Heading text' : 'Block id'}</label>
              <input id="fm-block" value={blockValue} onChange={(e) => setBlockValue(e.target.value)} />
            </div>
          </>
        )}
        <div>
          <label htmlFor="fm-notes">Notes</label>
          <input id="fm-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <Button variant="primary" type="submit" busy={busy} disabled={!valid}>
          Save field map
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------------------------------------- preview

function PreviewCard({ setId }: { setId: string }) {
  const [resourceId, setResourceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <section className="card" aria-labelledby="prev-h">
      <h2 id="prev-h">Preview</h2>
      <p className="muted small-text">
        Enter a resource id to see which type rules would match it. This only reads from LegendKeeper (the
        page and its ancestors, at dashboard priority) and writes nothing.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setProblem(null);
          api
            .get<{ preview: Preview }>(
              `/mappings/sets/${setId}/preview${qs({ resourceId: resourceId.trim() })}`,
            )
            .then(
              (r) => setResult(r.preview),
              (err: unknown) => {
                setResult(null);
                setProblem(err instanceof Error ? err.message : String(err));
              },
            )
            .finally(() => setBusy(false));
        }}
      >
        <div className="field-row">
          <div>
            <label htmlFor="prev-id">Resource id</label>
            <input id="prev-id" value={resourceId} onChange={(e) => setResourceId(e.target.value)} />
          </div>
          <Button variant="primary" type="submit" busy={busy} disabled={resourceId.trim() === ''}>
            Preview
          </Button>
        </div>
      </form>
      {problem && (
        <div className="note note-bad" role="alert">
          {problem}
        </div>
      )}
      {result && <PreviewResult p={result} />}
    </section>
  );
}

function PreviewResult({ p }: { p: Preview }) {
  return (
    <div className="mt" aria-label="Preview result">
      <p>
        <strong>{p.resource.name ?? p.resource.id}</strong>{' '}
        {p.semanticType ? (
          <>
            would be a <Badge tone="ok">{p.semanticType}</Badge>
          </>
        ) : (
          <Badge>no semantic type</Badge>
        )}
        {p.tie && <span className="muted"> (rules of equal weight disagree; the first is shown)</span>}
      </p>
      {p.matches.length > 0 && (
        <>
          <h3>Rules that match</h3>
          <ul>
            {p.matches.map((m) => (
              <li key={m.ruleId}>
                {m.semanticType} (priority {m.priority}): {m.description}, through {m.via}
              </li>
            ))}
          </ul>
        </>
      )}
      {p.notEvaluable.length > 0 && (
        <div className="note note-warn">
          {p.notEvaluable.map((n) => (
            <div key={n.ruleId}>
              {n.description}: {n.reason}
            </div>
          ))}
        </div>
      )}
      {p.ancestorsIncomplete && (
        <p className="muted small-text">The chain of parents could not be followed to the top.</p>
      )}
      {p.fields.length > 0 && (
        <>
          <h3>Field maps for {p.semanticType}</h3>
          <ul>
            {p.fields.map((f) => (
              <li key={f.id}>
                {f.fieldName}: {describeLocation(f.location)} ({KIND_LABEL[f.expectedKind] ?? f.expectedKind})
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small-text">
        {p.readsMade} {p.readsMade === 1 ? 'read' : 'reads'} from LegendKeeper; nothing was written.
      </p>
    </div>
  );
}

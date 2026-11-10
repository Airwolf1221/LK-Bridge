import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, qs } from '../api';
import { Badge, Button, Empty, ErrorNote, Loading, useAction, useConfirm } from '../components';
import { fmtTime } from '../format';
import { useReloadOn } from '../hooks';
import { useProjectApi, useScopedApi } from '../project';
import { Link } from '../router';

/**
 * v2 A3 (docs/registry.md): the type registry, the taxonomy, the drift report and a read-only "Try it" panel, on the
 * Repository Mappings page. Every change goes through the owner commands, which audit it. "Try it" only reads the
 * stored repository tree: nothing here writes to LegendKeeper.
 */

interface Reason {
  code: string;
  message: string;
}
interface NodeRef {
  id: string;
  rawName: string;
  displayName: string;
  kind: string;
  path: string;
}
interface PageTemplate {
  role: string;
  templateId: string | null;
}
interface TypeView {
  id: string;
  singular: string;
  plural: string;
  rootIndexId: string | null;
  rootIndex: NodeRef | null;
  indexTemplateId: string | null;
  pageTemplates: PageTemplate[];
  assetRootFolder: string | null;
  placementKind: 'character' | 'generic';
  status: 'ok' | 'needs_review';
  review: Reason[];
  checks: Reason[];
  notes: string;
  taxonomySeededAt: number | null;
  entries: number;
  entriesNeedingReview: number;
  updatedAt: number;
}
interface Template {
  id: string;
  name: string;
}
interface RegistryResponse {
  types: TypeView[];
  templates: { templates: Template[]; readAt: number | null; error: string | null };
  tree: { status: string; reason: string | null };
}
interface EntryView {
  id: string;
  plural: string;
  singular: string;
  singularSource: string;
  parentId: string | null;
  aliases: string[];
  sourceNodeId: string;
  source: NodeRef | null;
  assetFolder: string;
  status: 'ok' | 'needs_review';
  review: Reason[];
  notes: string;
}
interface TaxonomyResponse {
  type: TypeView;
  entries: EntryView[];
  reviewQueue: EntryView[];
}
interface SeedResult {
  created: EntryView[];
  characterIndexes: NodeRef[];
  reserved: NodeRef[];
  unchanged: number;
  needsReview: number;
  warnings: string[];
}
interface DriftFinding {
  code: string;
  typeName: string;
  entryName: string | null;
  nodeId: string;
  nodePath: string | null;
  message: string;
}
interface DriftReport {
  id: number;
  at: number;
  source: 'check' | 'owner';
  treeStatus: string;
  note: string | null;
  findings: DriftFinding[];
  count: number;
}

const DRIFT_LABEL: Record<string, string> = {
  type_root_missing: 'Type root missing',
  unmapped_index: 'Index with no entry',
  source_deleted: 'Index deleted',
  source_renamed: 'Index renamed',
  source_moved: 'Index moved',
  parent_mismatch: 'Parent differs',
};

const ReviewBadge = ({ status }: { status: string }) =>
  status === 'ok' ? <Badge tone="ok">OK</Badge> : <Badge tone="warn">Needs review</Badge>;

/** A link to a node on the Repository Tree page. */
const NodeLink = ({ id, children }: { id: string; children: ReactNode }) => (
  <Link to={`/tree?node=${encodeURIComponent(id)}`}>{children}</Link>
);

const templateName = (templates: Template[], id: string | null) =>
  id === null ? '—' : (templates.find((t) => t.id === id)?.name ?? id);

export function RegistrySections() {
  const reg = useScopedApi<RegistryResponse>('/registry');
  useReloadOn(['policy'], reg.reload, 300);
  const [typeId, setTypeId] = useState<string | null>(null);
  const types = reg.data?.types ?? [];
  useEffect(() => {
    if (types.length > 0 && !types.some((t) => t.id === typeId)) setTypeId(types[0]!.id);
  }, [types, typeId]);
  return (
    <>
      <h2 className="mt">Types and taxonomy</h2>
      <p className="muted">
        The <strong>type registry</strong> says where each kind of page lives (its root index, templates and
        asset folder), and the <strong>taxonomy</strong> lists its categories (for Characters: groups, races
        and subraces). Later tools use them to put pages in the right place. Nothing here changes
        LegendKeeper.
      </p>
      <ErrorNote error={reg.error} onRetry={reg.reload} />
      {!reg.data ? (
        !reg.error && <Loading />
      ) : (
        <>
          {reg.data.tree.status !== 'ready' && (
            <div className="note note-warn" role="status">
              The repository tree is <strong>{reg.data.tree.status.replace('_', ' ')}</strong>
              {reg.data.tree.reason ? `: ${reg.data.tree.reason}` : '.'} Seeding and “Try it” need a built
              tree (<Link to="/tree">Repository Tree</Link>).
            </div>
          )}
          <TypesCard data={reg.data} onChanged={reg.reload} />
          {typeId && types.some((t) => t.id === typeId) && (
            <TaxonomyCard types={types} typeId={typeId} onType={setTypeId} onChanged={reg.reload} />
          )}
          <DriftCard />
          <TryItCard types={types} />
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------------- types

function TypesCard({ data, onChanged }: { data: RegistryResponse; onChanged: () => void }) {
  const api = useProjectApi();
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<string | null>(null); // a type id, or 'new'
  const { types, templates } = data;
  const hasCharacter = types.some((t) => t.singular.toLowerCase() === 'character');
  return (
    <section className="card" aria-labelledby="types-h">
      <h2 id="types-h">Types</h2>
      <div className="row">
        {!hasCharacter && (
          <Button
            variant="primary"
            busy={busy}
            onClick={() =>
              void run(
                () => api.post<{ type: TypeView }>('/registry/seed-character', {}),
                'The Character type was seeded from the tree. Check anything marked for review.',
              ).then(onChanged)
            }
          >
            Seed the Character type
          </Button>
        )}
        <Button busy={busy} onClick={() => setEditing('new')}>
          New type
        </Button>
        <Button
          busy={busy}
          onClick={() =>
            void run(() => api.post('/registry/templates/refresh'), 'Templates read again.').then(onChanged)
          }
        >
          Read the templates again
        </Button>
        <span className="muted small-text">
          {templates.readAt
            ? `${templates.templates.length} templates, read ${fmtTime(templates.readAt)}`
            : 'Templates not read yet'}
          {templates.error && ` (last read failed: ${templates.error})`}
        </span>
      </div>
      {types.length === 0 ? (
        <Empty>No types yet. Seed the Character type from the tree, or create a type.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Root index</th>
                <th>Templates</th>
                <th>Placement</th>
                <th>Taxonomy</th>
                <th>Status</th>
                <th>
                  <span className="offscreen">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.id} data-type={t.id}>
                  <td>
                    <strong>{t.singular}</strong> / {t.plural}
                    {t.assetRootFolder && <div className="muted small-text">Assets: {t.assetRootFolder}</div>}
                  </td>
                  <td>
                    {t.rootIndex ? (
                      <NodeLink id={t.rootIndex.id}>{t.rootIndex.path}</NodeLink>
                    ) : (
                      <span className="mono">{t.rootIndexId ?? '—'}</span>
                    )}
                  </td>
                  <td className="small-text">
                    <div>Index: {templateName(templates.templates, t.indexTemplateId)}</div>
                    {t.pageTemplates.map((p) => (
                      <div key={p.role}>
                        {p.role}: {templateName(templates.templates, p.templateId)}
                      </div>
                    ))}
                  </td>
                  <td>
                    {t.placementKind === 'character' ? 'Character (section 9)' : 'Under the given index'}
                  </td>
                  <td>
                    {t.taxonomySeededAt ? `${t.entries} entries` : 'Not seeded'}
                    {t.entriesNeedingReview > 0 && (
                      <div>
                        <Badge tone="warn">{t.entriesNeedingReview} to review</Badge>
                      </div>
                    )}
                  </td>
                  <td>
                    <ReviewBadge status={t.status} />
                    {[...t.review, ...t.checks].length > 0 && (
                      <ul className="small-text">
                        {t.review.map((r, i) => (
                          <li key={`r${i}`}>{r.message}</li>
                        ))}
                        {t.checks.map((r, i) => (
                          <li key={`c${i}`} className="muted">
                            {r.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>
                    <div className="row">
                      <Button
                        className="small"
                        aria-label={`Edit ${t.singular}`}
                        onClick={() => setEditing(t.id)}
                      >
                        Edit
                      </Button>
                      <Button
                        className="small"
                        variant="danger"
                        busy={busy}
                        aria-label={`Delete ${t.singular}`}
                        onClick={() =>
                          void confirm({
                            title: `Delete the type ${t.singular}?`,
                            message: (
                              <p>Its {t.entries} taxonomy entries go with it. LegendKeeper is not changed.</p>
                            ),
                            confirmLabel: 'Delete',
                            danger: true,
                          }).then((ok) => {
                            if (ok)
                              void run(
                                () => api.post(`/registry/types/${t.id}/delete`, { confirm: true }),
                                'Deleted.',
                              ).then(onChanged);
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
      {editing !== null && (
        <TypeForm
          key={editing}
          type={editing === 'new' ? null : (types.find((t) => t.id === editing) ?? null)}
          templates={templates.templates}
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

function TemplatePicker({
  id,
  label,
  value,
  templates,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  templates: Template[];
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        list={`${id}-list`}
        value={value}
        placeholder="Template id"
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={`${id}-list`}>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </datalist>
    </div>
  );
}

function TypeForm({
  type,
  templates,
  onDone,
  onCancel,
}: {
  type: TypeView | null;
  templates: Template[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const api = useProjectApi();
  const { run, busy } = useAction();
  const [singular, setSingular] = useState(type?.singular ?? '');
  const [plural, setPlural] = useState(type?.plural ?? '');
  const [root, setRoot] = useState(type?.rootIndexId ?? '');
  const [indexTpl, setIndexTpl] = useState(type?.indexTemplateId ?? '');
  const [pages, setPages] = useState<{ role: string; templateId: string }[]>(
    type?.pageTemplates.map((p) => ({ role: p.role, templateId: p.templateId ?? '' })) ?? [],
  );
  const [assets, setAssets] = useState(type?.assetRootFolder ?? '');
  const [kind, setKind] = useState<'character' | 'generic'>(type?.placementKind ?? 'generic');
  const [notes, setNotes] = useState(type?.notes ?? '');
  const [reviewed, setReviewed] = useState(false);
  const blank = (s: string) => (s.trim() === '' ? null : s.trim());
  return (
    <form
      className="mt"
      aria-label={type ? `Edit ${type.singular}` : 'New type'}
      onSubmit={(e) => {
        e.preventDefault();
        const body = {
          singular,
          plural,
          rootIndexId: blank(root),
          indexTemplateId: blank(indexTpl),
          pageTemplates: pages
            .filter((p) => p.role.trim() !== '')
            .map((p) => ({ role: p.role.trim(), templateId: blank(p.templateId) })),
          assetRootFolder: blank(assets),
          placementKind: kind,
          notes,
          ...(reviewed ? { reviewed: true } : {}),
        };
        void run(
          () => (type ? api.put(`/registry/types/${type.id}`, body) : api.post('/registry/types', body)),
          type ? 'Type saved.' : 'Type created.',
        ).then((r) => {
          if (r) onDone();
        });
      }}
    >
      <h3>{type ? `Edit ${type.singular}` : 'New type'}</h3>
      <div className="field-row">
        <div>
          <label htmlFor="ty-singular">Singular</label>
          <input
            id="ty-singular"
            value={singular}
            maxLength={100}
            onChange={(e) => setSingular(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="ty-plural">Plural</label>
          <input id="ty-plural" value={plural} maxLength={100} onChange={(e) => setPlural(e.target.value)} />
        </div>
        <div>
          <label htmlFor="ty-root">Root index (resource id)</label>
          <input id="ty-root" className="mono" value={root} onChange={(e) => setRoot(e.target.value)} />
        </div>
        <div>
          <label htmlFor="ty-assets">Asset root folder</label>
          <input id="ty-assets" value={assets} onChange={(e) => setAssets(e.target.value)} />
        </div>
      </div>
      <div className="field-row">
        <TemplatePicker
          id="ty-index-tpl"
          label="Index template"
          value={indexTpl}
          templates={templates}
          onChange={setIndexTpl}
        />
        <div>
          <label htmlFor="ty-kind">Placement rule</label>
          <select
            id="ty-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as 'character' | 'generic')}
          >
            <option value="generic">Generic: under the given index</option>
            <option value="character">Character: the old bridge's rules</option>
          </select>
        </div>
      </div>
      <fieldset className="plain">
        <legend>Page templates (by role)</legend>
        {pages.map((p, i) => (
          <div className="field-row" key={i}>
            <div>
              <label htmlFor={`ty-role-${i}`}>Role</label>
              <input
                id={`ty-role-${i}`}
                value={p.role}
                placeholder="core"
                onChange={(e) =>
                  setPages(pages.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))
                }
              />
            </div>
            <TemplatePicker
              id={`ty-tpl-${i}`}
              label="Template"
              value={p.templateId}
              templates={templates}
              onChange={(v) => setPages(pages.map((x, j) => (j === i ? { ...x, templateId: v } : x)))}
            />
            <Button className="small" onClick={() => setPages(pages.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
        ))}
        <Button className="small" onClick={() => setPages([...pages, { role: '', templateId: '' }])}>
          Add a role
        </Button>
      </fieldset>
      <label htmlFor="ty-notes">Notes</label>
      <textarea id="ty-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      {type?.status === 'needs_review' && (
        <label className="row">
          <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> Mark as
          reviewed
        </label>
      )}
      <div className="row mt">
        <Button
          variant="primary"
          type="submit"
          busy={busy}
          disabled={singular.trim() === '' || plural.trim() === ''}
        >
          {type ? 'Save' : 'Create type'}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------- taxonomy

function TaxonomyCard({
  types,
  typeId,
  onType,
  onChanged,
}: {
  types: TypeView[];
  typeId: string;
  onType: (id: string) => void;
  onChanged: () => void;
}) {
  const api = useProjectApi();
  const tax = useScopedApi<TaxonomyResponse>(`/registry/types/${encodeURIComponent(typeId)}/taxonomy`);
  useReloadOn(['policy'], tax.reload, 300);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<string | null>(null);
  const [last, setLast] = useState<SeedResult | null>(null);
  const reload = () => {
    tax.reload();
    onChanged();
  };
  const d = tax.data;
  const children = (parent: string | null) => (d?.entries ?? []).filter((e) => e.parentId === parent);
  const renderLevel = (parent: string | null): ReactNode => {
    const list = children(parent);
    if (list.length === 0) return null;
    return (
      <ul className={parent === null ? 'plain taxonomy' : 'taxonomy'}>
        {list.map((e) => (
          <li key={e.id} data-entry={e.id}>
            <EntryLine entry={e} onEdit={() => setEditing(e.id)} />
            {editing === e.id && d && (
              <EntryForm
                entry={e}
                entries={d.entries}
                onDone={() => {
                  setEditing(null);
                  reload();
                }}
                onCancel={() => setEditing(null)}
              />
            )}
            {renderLevel(e.id)}
          </li>
        ))}
      </ul>
    );
  };
  return (
    <section className="card" aria-labelledby="tax-h">
      <h2 id="tax-h">Taxonomy</h2>
      <div className="row">
        <label htmlFor="tax-type">Type</label>
        <select id="tax-type" value={typeId} onChange={(e) => onType(e.target.value)}>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.plural}
            </option>
          ))}
        </select>
        {d && !d.type.taxonomySeededAt && (
          <Button
            variant="primary"
            busy={busy}
            onClick={() =>
              void confirm({
                title: `Seed the ${d.type.plural} taxonomy?`,
                message: (
                  <p>
                    Every index under {d.type.rootIndex?.path ?? 'the type root'} becomes an entry, except
                    character indexes and the unknown-race index. This is done once; afterwards use “Add
                    missing”.
                  </p>
                ),
                confirmLabel: 'Seed',
              }).then((ok) => {
                if (ok)
                  void run(() =>
                    api.post<{ result: SeedResult }>(`/registry/types/${typeId}/taxonomy/seed`, {
                      confirm: true,
                    }),
                  ).then((r) => {
                    if (r) setLast(r.result);
                    reload();
                  });
              })
            }
          >
            Seed the taxonomy
          </Button>
        )}
        {d?.type.taxonomySeededAt && (
          <Button
            busy={busy}
            onClick={() =>
              void run(() =>
                api.post<{ result: SeedResult }>(`/registry/types/${typeId}/taxonomy/add-missing`),
              ).then((r) => {
                if (r) setLast(r.result);
                reload();
              })
            }
          >
            Add missing
          </Button>
        )}
      </div>
      {last && (
        <div className="note" role="status" data-testid="seed-result">
          {last.created.length} {last.created.length === 1 ? 'entry' : 'entries'} created ({last.needsReview}{' '}
          to review); {last.characterIndexes.length} character indexes and {last.reserved.length} unknown-race
          index left out{last.unchanged ? `; ${last.unchanged} already had an entry` : ''}.
          {last.warnings.length > 0 && (
            <ul>
              {last.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ErrorNote error={tax.error} onRetry={tax.reload} />
      {!d ? (
        !tax.error && <Loading />
      ) : d.entries.length === 0 ? (
        <Empty>No entries yet.</Empty>
      ) : (
        <>
          <h3>Review queue</h3>
          {d.reviewQueue.length === 0 ? (
            <Empty>Nothing waits for review.</Empty>
          ) : (
            <ul data-testid="review-queue">
              {d.reviewQueue.map((e) => (
                <li key={e.id}>
                  <button type="button" className="link" onClick={() => setEditing(e.id)}>
                    {e.plural}
                  </button>
                  : {e.review.map((r) => r.message).join(' ')}
                </li>
              ))}
            </ul>
          )}
          <h3>Entries</h3>
          {renderLevel(null)}
        </>
      )}
    </section>
  );
}

function EntryLine({ entry: e, onEdit }: { entry: EntryView; onEdit: () => void }) {
  return (
    <div className="row">
      <strong>{e.plural}</strong>
      <span className="muted">singular: {e.singular}</span>
      {e.aliases.length > 0 && <span className="small-text">also: {e.aliases.join(', ')}</span>}
      {e.assetFolder !== e.plural && <span className="small-text">assets: {e.assetFolder}</span>}
      <ReviewBadge status={e.status} />
      {e.source ? (
        <NodeLink id={e.source.id}>index</NodeLink>
      ) : (
        <Badge tone="bad">index not in the tree</Badge>
      )}
      <Button className="small" aria-label={`Edit ${e.plural}`} onClick={onEdit}>
        Edit
      </Button>
    </div>
  );
}

function EntryForm({
  entry,
  entries,
  onDone,
  onCancel,
}: {
  entry: EntryView;
  entries: EntryView[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const api = useProjectApi();
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [singular, setSingular] = useState(entry.singular);
  const [aliases, setAliases] = useState(entry.aliases.join(', '));
  const [folder, setFolder] = useState(entry.assetFolder);
  const [parent, setParent] = useState(entry.parentId ?? '');
  const [notes, setNotes] = useState(entry.notes);
  const [reviewed, setReviewed] = useState(entry.status === 'needs_review');
  const p = `e-${entry.id}`;
  return (
    <form
      className="card mt"
      aria-label={`Edit ${entry.plural}`}
      onSubmit={(ev) => {
        ev.preventDefault();
        const body = {
          ...(singular !== entry.singular || entry.singularSource === 'rule' ? { singular } : {}),
          aliases: aliases
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean),
          assetFolder: folder,
          parentId: parent === '' ? null : parent,
          notes,
          ...(reviewed && entry.status === 'needs_review' ? { reviewed: true } : {}),
        };
        void run(() => api.put(`/registry/taxonomy/${entry.id}`, body), 'Entry saved.').then((r) => {
          if (r) onDone();
        });
      }}
    >
      {entry.review.length > 0 && (
        <ul className="small-text">
          {entry.review.map((r) => (
            <li key={r.code}>{r.message}</li>
          ))}
        </ul>
      )}
      <div className="field-row">
        <div>
          <label htmlFor={`${p}-singular`}>Singular</label>
          <input id={`${p}-singular`} value={singular} onChange={(e) => setSingular(e.target.value)} />
        </div>
        <div>
          <label htmlFor={`${p}-aliases`}>Aliases (comma-separated)</label>
          <input id={`${p}-aliases`} value={aliases} onChange={(e) => setAliases(e.target.value)} />
        </div>
        <div>
          <label htmlFor={`${p}-folder`}>Asset folder</label>
          <input id={`${p}-folder`} value={folder} onChange={(e) => setFolder(e.target.value)} />
        </div>
        <div>
          <label htmlFor={`${p}-parent`}>Parent</label>
          <select id={`${p}-parent`} value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">None (directly under the type root)</option>
            {entries
              .filter((x) => x.id !== entry.id)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.plural}
                </option>
              ))}
          </select>
        </div>
      </div>
      <label htmlFor={`${p}-notes`}>Notes</label>
      <textarea id={`${p}-notes`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      {entry.status === 'needs_review' && (
        <label className="row">
          <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> Mark as
          reviewed
        </label>
      )}
      <div className="row mt">
        <Button variant="primary" type="submit" busy={busy}>
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          variant="danger"
          busy={busy}
          onClick={() =>
            void confirm({
              title: `Delete the entry “${entry.plural}”?`,
              message: <p>The index stays in LegendKeeper; “Add missing” would create the entry again.</p>,
              confirmLabel: 'Delete',
              danger: true,
            }).then((ok) => {
              if (ok)
                void run(
                  () => api.post(`/registry/taxonomy/${entry.id}/delete`, { confirm: true }),
                  'Deleted.',
                ).then((r) => {
                  if (r) onDone();
                });
            })
          }
        >
          Delete entry
        </Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------------------------------------- drift

function DriftCard() {
  const api = useProjectApi();
  const drift = useScopedApi<{ latest: DriftReport | null }>('/registry/drift');
  const { run, busy } = useAction();
  const r = drift.data?.latest ?? null;
  return (
    <section className="card" aria-labelledby="drift-h">
      <h2 id="drift-h">Drift</h2>
      <p className="muted small-text">
        Where the taxonomy and the repository tree disagree. The tree's nightly check makes this report;
        nothing is ever corrected by itself.
      </p>
      <Button
        busy={busy}
        onClick={() => void run(() => api.post('/registry/drift/run'), 'Compared.').then(drift.reload)}
      >
        Compare now
      </Button>
      <ErrorNote error={drift.error} onRetry={drift.reload} />
      {!drift.data ? (
        !drift.error && <Loading />
      ) : !r ? (
        <Empty>No report yet.</Empty>
      ) : (
        <>
          <p data-testid="drift-summary">
            {r.count === 0 ? 'No drift' : `${r.count} ${r.count === 1 ? 'finding' : 'findings'}`},{' '}
            {fmtTime(r.at)} ({r.source === 'check' ? 'nightly check' : 'on request'}).
            {r.note ? ` ${r.note}` : ''}
          </p>
          {r.findings.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>What</th>
                    <th>Type</th>
                    <th>Where</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {r.findings.map((f, i) => (
                    <tr key={i}>
                      <td>
                        <Badge tone="warn">{DRIFT_LABEL[f.code] ?? f.code}</Badge>
                      </td>
                      <td>{f.typeName}</td>
                      <td>
                        {f.nodePath ? (
                          <NodeLink id={f.nodeId}>{f.nodePath}</NodeLink>
                        ) : (
                          <span className="mono">{f.nodeId}</span>
                        )}
                      </td>
                      <td className="small-text">{f.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ try it

/** Calls a read-only route and keeps its answer or its refusal (code, message and details). */
function useTry<T>() {
  const api = useProjectApi();
  const [state, setState] = useState<{ ok?: T; err?: ApiError; busy: boolean }>({ busy: false });
  const go = (path: string) => {
    setState({ busy: true });
    api.get<T>(path).then(
      (ok) => setState({ ok, busy: false }),
      (err: unknown) =>
        setState({ err: err instanceof ApiError ? err : new ApiError(0, 'ERROR', String(err)), busy: false }),
    );
  };
  return { ...state, go };
}

function Refusal({ err }: { err: ApiError }) {
  const list: unknown = err.extra.candidates ?? err.extra.available;
  return (
    <div className="note note-bad" role="alert">
      <strong>{err.code}</strong>: {err.message}
      {Array.isArray(list) && list.length > 0 && (
        <ul className="small-text">
          {list.map((c, i) => (
            <li key={i}>{typeof c === 'string' ? c : `${(c as NodeRef).path} (${(c as NodeRef).id})`}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ResolveAnswer {
  result:
    | { status: 'resolved'; node: NodeRef; matchedBy: string }
    | { status: 'ambiguous'; candidates: (NodeRef & { matchedBy: string })[] }
    | { status: 'not_found'; near: NodeRef[] };
}
interface PlanAnswer {
  plan: {
    raceIndex: NodeRef;
    species: { row: string; value: string };
    characterIndex: {
      action: string;
      node?: NodeRef;
      rawName?: string;
      slot?: Record<string, string>;
    } | null;
    page: {
      action: string;
      node?: NodeRef;
      rawName?: string;
      parentId?: string | null;
      templateId?: string;
      slot?: Record<string, string>;
    };
    warnings: string[];
  };
}
interface OrderingAnswer {
  slot: { after?: string; before?: string };
  outOfOrder: { outOfOrder: { node: NodeRef; belongsAfter: NodeRef | null }[] }[];
}

const slotText = (s: { after?: string; before?: string } | undefined) =>
  !s ? '' : s.after ? `after ${s.after}` : s.before ? `before ${s.before}` : 'anywhere (the parent is empty)';

function TryItCard({ types }: { types: TypeView[] }) {
  const res = useTry<ResolveAnswer>();
  const plan = useTry<PlanAnswer>();
  const ord = useTry<OrderingAnswer>();
  const [query, setQuery] = useState('');
  const [scopeType, setScopeType] = useState('');
  const [under, setUnder] = useState('');
  const [name, setName] = useState('');
  const [race, setRace] = useState('');
  const [kind, setKind] = useState<'core' | 'compact'>('core');
  const [parentId, setParentId] = useState('');
  const [newName, setNewName] = useState('');
  const [pageKind, setPageKind] = useState('bsrc');
  return (
    <section className="card" aria-labelledby="try-h">
      <h2 id="try-h">Try it</h2>
      <p className="muted small-text">Read-only: these answer from the stored tree and change nothing.</p>

      <form
        aria-label="Resolve a name"
        onSubmit={(e) => {
          e.preventDefault();
          res.go(`/registry/try/resolve${qs({ query, type: scopeType, under })}`);
        }}
      >
        <h3>Resolve a name</h3>
        <div className="field-row">
          <div>
            <label htmlFor="try-q">Name or id</label>
            <input id="try-q" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div>
            <label htmlFor="try-scope">Within type</label>
            <select id="try-scope" value={scopeType} onChange={(e) => setScopeType(e.target.value)}>
              <option value="">The whole repository</option>
              {types.map((t) => (
                <option key={t.id} value={t.singular}>
                  {t.plural}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="try-under">Or under (resource id)</label>
            <input id="try-under" className="mono" value={under} onChange={(e) => setUnder(e.target.value)} />
          </div>
          <Button type="submit" busy={res.busy} disabled={query.trim() === ''}>
            Resolve
          </Button>
        </div>
        {res.err && <Refusal err={res.err} />}
        {res.ok && (
          <div className="note" role="status" data-testid="try-resolve">
            {res.ok.result.status === 'resolved' ? (
              <>
                One match ({res.ok.result.matchedBy}):{' '}
                <NodeLink id={res.ok.result.node.id}>{res.ok.result.node.path}</NodeLink>{' '}
                <span className="mono">{res.ok.result.node.id}</span>
              </>
            ) : res.ok.result.status === 'ambiguous' ? (
              <>
                Ambiguous: refused. Candidates:
                <ul>
                  {res.ok.result.candidates.map((c) => (
                    <li key={c.id}>
                      {c.path} <span className="mono">{c.id}</span> ({c.kind}, {c.matchedBy})
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                Not found.
                {res.ok.result.near.length > 0 &&
                  ` Near names (a hint, never used): ${res.ok.result.near.map((n) => n.displayName).join(', ')}.`}
              </>
            )}
          </div>
        )}
      </form>

      <form
        aria-label="Plan a character placement"
        onSubmit={(e) => {
          e.preventDefault();
          plan.go(`/registry/try/placement${qs({ characterName: name, race, kind })}`);
        }}
      >
        <h3>Plan a character placement</h3>
        <div className="field-row">
          <div>
            <label htmlFor="try-char">Character name</label>
            <input id="try-char" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="try-race">Race (blank: unknown)</label>
            <input id="try-race" value={race} onChange={(e) => setRace(e.target.value)} />
          </div>
          <div>
            <label htmlFor="try-kind">Page</label>
            <select
              id="try-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as 'core' | 'compact')}
            >
              <option value="core">Character Core</option>
              <option value="compact">Compact Character Reference</option>
            </select>
          </div>
          <Button type="submit" busy={plan.busy} disabled={name.trim() === ''}>
            Plan
          </Button>
        </div>
        {plan.err && <Refusal err={plan.err} />}
        {plan.ok && (
          <div className="note" role="status" data-testid="try-plan">
            <div>
              Race index: <NodeLink id={plan.ok.plan.raceIndex.id}>{plan.ok.plan.raceIndex.path}</NodeLink>
            </div>
            <div>
              {plan.ok.plan.species.row}: <strong>{plan.ok.plan.species.value}</strong>
            </div>
            {plan.ok.plan.characterIndex && (
              <div>
                Character index:{' '}
                {plan.ok.plan.characterIndex.action === 'reuse'
                  ? `reuse ${plan.ok.plan.characterIndex.node?.path ?? ''}`
                  : `create ${plan.ok.plan.characterIndex.rawName ?? ''}, ${slotText(plan.ok.plan.characterIndex.slot)}`}
              </div>
            )}
            <div>
              Page:{' '}
              {plan.ok.plan.page.action === 'return_existing'
                ? `exists already, returned: ${plan.ok.plan.page.node?.path ?? ''}`
                : `create ${plan.ok.plan.page.rawName ?? ''} from template ${plan.ok.plan.page.templateId ?? ''}${plan.ok.plan.page.parentId ? `, ${slotText(plan.ok.plan.page.slot)}` : ' in the new index'}`}
            </div>
            {plan.ok.plan.warnings.length > 0 && (
              <ul>
                {plan.ok.plan.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </form>

      <form
        aria-label="Compute an ordering slot"
        onSubmit={(e) => {
          e.preventDefault();
          ord.go(`/registry/try/ordering${qs({ parentId, name: newName, kind: pageKind })}`);
        }}
      >
        <h3>Compute an ordering slot</h3>
        <div className="field-row">
          <div>
            <label htmlFor="try-parent">Parent (resource id)</label>
            <input
              id="try-parent"
              className="mono"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="try-name">New page's display name</label>
            <input id="try-name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="try-pkind">Kind</label>
            <select id="try-pkind" value={pageKind} onChange={(e) => setPageKind(e.target.value)}>
              <option value="index">[INDEX]</option>
              <option value="bsrc">[BSRC]</option>
              <option value="unclassified">Unclassified</option>
            </select>
          </div>
          <Button type="submit" busy={ord.busy} disabled={parentId.trim() === '' || newName.trim() === ''}>
            Compute
          </Button>
        </div>
        {ord.err && <Refusal err={ord.err} />}
        {ord.ok && (
          <div className="note" role="status" data-testid="try-ordering">
            Goes {slotText(ord.ok.slot)}.
            {(ord.ok.outOfOrder[0]?.outOfOrder.length ?? 0) > 0 && (
              <>
                {' '}
                Already out of order here (reported, never moved):
                <ul>
                  {ord.ok.outOfOrder[0]!.outOfOrder.map((x) => (
                    <li key={x.node.id}>
                      {x.node.rawName} belongs {x.belongsAfter ? `after ${x.belongsAfter.rawName}` : 'first'}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </form>
    </section>
  );
}

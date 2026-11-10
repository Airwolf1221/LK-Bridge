# Repository mappings (chunk 6)

The data model, owner CRUD, import and export, a read-only preview, and the Repository Mappings page (PLAN §8 page 7).
**There is no inference engine and no MCP tool**: nothing reads a mapping set yet. It is the record the later
"intelligent mapping" work will use. Code: `src/mappings/`, routes in `src/admin/routes/mappings.ts`, page in
`ui/src/pages/mappings.tsx`, tables in migration `0400_maintenance_mappings.sql`. Tests: `test/mappings/`,
`test/ui/mappings.test.tsx`.

**v2 A3:** the same page also holds the type registry, the taxonomy, the drift report and a read-only "Try it" panel,
which later tools do use to place pages: see [registry.md](registry.md).

## Model

**Mappings belong to a project (v2 A1).** Every set, rule and field map carries its project; the page and every
`/api/admin/mappings…` route work in the dashboard's selected project (`?project=`), and another project's ids are "not
found". Names are unique within a project, and each project has at most one active set.

- **Mapping set**: id, name (unique, any case, within its project), description, notes, `active`, created and updated
  times. **At most one set per project is active**, enforced by the command and by a partial unique index in SQLite.
- **Type rule**: a _selector_ → a _semantic type_, with a _priority_ (−1000 to 1000, higher wins an overlap), notes and times.
  Selectors:
  - `subtree`: a resource id, with or without its descendants;
  - `template`: a template id;
  - `tag`: a tag name.
    Semantic types are free text (the forms suggest Character, Nation, Species, Institution, Place and Class).
- **Field map**: per semantic type, a _semantic field name_ → a _location_, with an _expected kind_, notes and times. A type
  cannot have the same field name twice (any case). Locations:
  - `sidebar_property`: a sidebar property by title;
  - `infobox_row`: an infobox title and a row key;
  - `block`: either a heading text or a block id (exactly one).
    Expected kinds: `text`, `number`, `resource_link`, `list`, `date`, `boolean`, `image`, `other`.

Deleting a set deletes its rules and field maps (an explicit confirmation in the API: `{ confirm: true }`).

## Owner commands

`src/mappings/commands.ts`: create, update, delete, activate and deactivate sets; create, update and delete rules and field
maps; export; import; preview. `actor: 'owner'` first, each change audited (`mapping.set_create`, `.set_update`,
`.set_delete`, `.set_activate`, `.set_deactivate`, `.set_import`, `.rule_create|update|delete`, `.field_create|update|delete`)
with a `policy` event. Input is validated with zod; a failure is `400 INVALID_INPUT` naming the fields.

## Import and export

`GET /api/admin/mappings/sets/:id/export` returns `{ document }`:

```json
{
  "schema": "lk-bridge.mapping-set",
  "version": 1,
  "exportedAt": "2026-11-08T10:00:00.000Z",
  "set": { "name": "Baisheng taxonomy", "description": "", "notes": "" },
  "typeRules": [
    {
      "selector": { "kind": "subtree", "resourceId": "…", "descendants": true },
      "semanticType": "Character",
      "priority": 10,
      "notes": ""
    }
  ],
  "fieldMaps": [
    {
      "semanticType": "Character",
      "fieldName": "Born",
      "location": { "kind": "infobox_row", "infoboxTitle": "Vitals", "rowKey": "Born" },
      "expectedKind": "date",
      "notes": ""
    }
  ]
}
```

No internal ids and no `active` flag are exported. `POST /api/admin/mappings/import` takes `{ document, name? }` (`document`
is the file's text or parsed JSON; up to 2 MB, 2,000 rules, 5,000 field maps). The whole document is validated first
(strict: unknown keys, a wrong `schema`, a version other than 1, a duplicate field and every field-level rule all refuse
with `400 INVALID_IMPORT`), and the import is one transaction. It always creates a **new, inactive set**; a name that is
taken is `409 NAME_TAKEN` (give `name` to rename). It never overwrites.

## Preview (read-only)

`GET /api/admin/mappings/sets/:id/preview?resourceId=…`. Given a resource id it reports which of the set's type rules would
match it and the resulting semantic type, with the field maps of that type. It **only reads**: `getResource` for the
resource and, when a rule needs ancestors, up the parent chain (at most 32 reads), through the job engine at priority **P0**
as the `system` principal, so every request goes through the governor. It records no job, no audit row, writes nothing to
LegendKeeper, and is covered by a test that asserts no non-GET request reached the mock.

- `subtree` rules match the resource itself, or (with descendants) an ancestor.
- `tag` rules match the resource's tags (exact).
- **`template` rules are reported as "not evaluable"**: LegendKeeper's resource does not say which template it came from,
  and guessing would be inference. They are kept in the set for the future mapping.
- Overlaps: highest priority wins; equal priorities are broken by specificity (the resource itself, then the nearest
  ancestor, then a tag); a remaining tie between different types is flagged and the first rule shown.

## The page

`/ui/mappings` lists the sets (status, counts, activate, export, delete) with forms to create and import one;
`/ui/mappings/:id` shows a readable summary (rules and fields per type, and warnings such as clashing rules or types with
rules but no fields), edit forms for the set, type rules and field maps, and the preview.

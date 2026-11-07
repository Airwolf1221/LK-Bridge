# ADR 0002: Generated operation registry and vendored spec

Status: Accepted (chunk 0). Implements PLAN §4.

## Decision

- `spec/legendkeeper-openapi.json` is a pinned copy of the spec bundled in `@legendkeeper/sdk` 4.1.0 (OpenAPI 3.1.0, API version 3.0.0, 89 operations).
- `scripts/gen-registry.ts` turns it into `src/lk/registry.generated.ts` (metadata and per-operation input JSON Schema) and `src/lk/registry.defs.generated.ts` (shared `$defs`). Both are committed.
- Zod schemas are built at runtime with `z.fromJSONSchema`, lazily and cached. All 40 request bodies compile.
- Callers supply `{ path?, query?, ifMatch?, body? }`. `projectId` is injected from config, so an agent cannot address another project. `Idempotency-Key` is supplied by the bridge. `If-Match` is surfaced as `ifMatch`.
- Classification rules live in `scripts/gen-registry.ts`:
  - `kind`: `GET` is `read`; `createImageUpload` and `createImageAsset` are `upload`; the rest are `write`.
  - `costs`: reads draw on the four read tiers; writes add the two write tiers; `createManyResources` adds the two items tiers (one unit per entry of `body.resources`); uploads add `upload`.
  - `concurrency`: any non-read operation whose path contains `{documentId}` is `document`; otherwise one containing `{resourceId}` is `resource`; otherwise `none`.
  - `versioned`: the operation declares an `If-Match` header. Note that `updateResource`, `updateDocument`, lanes, events and features are not versioned.
  - `risk`: `admin` for `inviteMember`, `removeMember`, `revokeInvite`; `destructive` for every `DELETE` plus `replaceDocumentBlocks`, `replaceBoardContent`, `updateCalendar` and `deleteBoardShapes`; otherwise `safe`.
- `scripts/check-spec-drift.ts` runs in CI and fails if the SDK spec and the registry disagree on operation ids, if the vendored spec differs from the installed SDK's, or if the generated files are stale.

## Consequences

- Upgrading the SDK means: copy its `openapi.json` over the vendored copy, run `npm run gen:registry`, review the diff.
- The generated files are large (about 400 kB); they are excluded from lint and formatting.

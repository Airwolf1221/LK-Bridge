# The owner dashboard and admin API (chunk 5)

A single-page app at `/ui` and the JSON API behind it at `/api/admin`, with one live stream. They are for the owner
only. Code: `src/admin/` (API, stream, static files), `ui/` (the React app), `src/config/admin.ts` (settings). Tests:
`test/admin/`, `test/ui/`, and an opt-in browser smoke test in `test/e2e/`. Design choices are in
[ADR 0013](adr/0013-dashboard-and-admin-api.md) and [ADR 0014](adr/0014-auth-pages-referrer-policy.md).

## Running it

| What                  | How                                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build (server and UI) | `npm run build` (also runs `npm run build:ui`, which writes `ui/dist`)                                                                                                                       |
| Serve                 | `npm start`; the bridge serves `ui/dist` at `/ui`. Without a build, `/ui` says so (503) and the API still works                                                                              |
| UI development        | `npm run dev` (bridge on 8787), then `npm run dev:ui` (Vite on 5173, proxying `/api/admin` and `/oauth`); sign in on 8787 first                                                              |
| Unit, component, API  | `npm test` (part of `npm run ci`)                                                                                                                                                            |
| Browser smoke test    | `npm run test:e2e` (builds the UI, starts a real bridge on a mock LegendKeeper, drives Chromium). Not in CI. If Playwright cannot find its browser, set `CHROMIUM_PATH` to a Chromium binary |

## Security model

- **Only the owner session.** The credential is the cookie set by the owner sign-in (chunk 4). OAuth access tokens and
  personal access tokens are never read on `/api/admin` (the `Authorization` header is ignored), so a token that works at
  `/mcp` does nothing here. Unauthenticated API requests get a 401 JSON body with no `WWW-Authenticate` header.
- **Unauthenticated `/ui`** requests are redirected (303) to `/oauth/login?return_to=…` and come back afterwards. No
  dashboard bytes are served first. A session that ends while the page is open sends the page to sign-in (a 401 from the
  API, or the `unauthenticated` stream event).
- **Cross-site requests (chunk 8).** Any `/api/admin` request a browser labels `Sec-Fetch-Site: cross-site` or
  `same-site` is refused (`403 CROSS_SITE`), reads included: the session cookie is `SameSite=Lax`, so a link on another
  site would otherwise carry it to read routes that spend budget (overview refresh, mapping preview).
- **CSRF.** Every state-changing request (anything but GET, HEAD, OPTIONS) needs the `Origin` header to equal the
  bridge's public URL (a missing or foreign one is refused: browsers always send it on `fetch` POSTs) **and**
  `X-CSRF-Token`, the HMAC bound to the session (`GET /api/admin/session` returns it). Neither is checked on reads.
- **Headers on `/ui`:** `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'
data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none';
base-uri 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, plus
  `Cross-Origin-Opener-Policy` and `-Resource-Policy: same-origin`. The bundle has no inline script or style and loads
  nothing from another host.
- **Every change is audited and evented.** Routes validate input and call `src/admin/actions.ts`, which goes through the
  owner command layer (`policy.commands`), an engine control, or the runtime settings functions
  (`src/admin/runtime-settings.ts`). Each leaves an `audit_log` row (actor `owner`) and a `policy` event on the stream.
  No route touches the database or the engine itself.
- **Re-authentication (OPS2).** Adding, replacing or removing an API key, and changing the password or the authenticator,
  also need the owner's password (and authenticator code) within the last five minutes on the session, or the answer is
  `403 REAUTH_REQUIRED`; the dashboard asks in a dialog and retries ([auth.md](auth.md#managing-the-owner-account-from-the-dashboard-ops2)).
- **No secrets shown or logged.** An API key goes to the bridge once, from a write-only field; afterwards only its last
  four characters are shown (OPS2). The authenticator secret (while it is set up) and recovery codes are in one response
  each, marked `shownOnce`. A new PAT is in the response to its creation only (`201`, `shownOnce: true`); only its
  hash is stored and nothing else returns it. Signed upload URLs, upload keys, headers, image bytes and credential-shaped
  fields are replaced by `[redacted]` in every job, step, artefact, error, journal, proposal and stream payload
  (`src/admin/redact.ts`); very long values are shortened. Request logging keeps the path only (no query string).

## Projects (v2 A1)

The bridge serves several LegendKeeper projects ([projects.md](projects.md)). A **project switcher** in the top bar
chooses the project that Overview, Jobs, Errors, Budgets, Journal, Proposals and Mappings show; the choice is kept per
browser (`lkb-project` in local storage), and without one the default project is shown. Every project-scoped route below
takes `?project=<name or id>` (default: the default project); an unknown one is a `400 UNKNOWN_PROJECT`, and another
project's job, proposal, error group, journal entry or mapping set id is "not found". Actions (cancel a job, approve a
proposal, resolve errors, edit a mapping) act within the page's project. Clients & Access, Settings, Maintenance and
Writers are bridge-wide (the writer pool is shared; each busy slot names its project). The **Projects** page lists every
project with its flags, LegendKeeper id and name, whether its key is configured (the variable's name, never the key) and
valid, its status and reason, and its settings (read-only); it can switch a project's **Read-only** flag (with a
confirmation, audited) and **Check again** a project's key. The sandbox flag is shown but only set from the server's
shell (`npm run projects`).

## Low-level tools, per profile (v2 B2)

Each profile row on **Clients & Access** has a **Low-level tools** checkbox (shown / hidden; hidden is the default). It
controls only whether the raw LegendKeeper operation tools are listed to that profile's connections; the scope, not this
box, decides what the profile may do. A change is audited (`profile.set_low_level_tools`) and applies at the agent's next
tool listing. Clients keep their own copy of the tool list: claude.ai shows a change (this box, or a scope change that
hides or shows the write tools) only after the connector is disconnected and reconnected in claude.ai's settings (observed
on 10 November 2026, not a guarantee); in ChatGPT, open Plugins, the bridge, and use **Refresh**. The page says so beside
the checkbox. See [policy.md](policy.md#hiding-the-low-level-tools-v2-b2).

## Old connections (hotfix, ADR 0033)

**Clients & Access** also shows, above the profile tables, "Remove all revoked and expired (N)" (only when N > 0, with a
confirmation listing the rows), a **Remove** button on every revoked or expired row (no confirmation: the row is already
dead, and the tombstone and the audit log keep the record), a **stale** badge on active connections unused for longer than
the threshold, "Revoke stale (N)" per profile, and the two settings "Remove revoked and expired connections automatically
after N days (0 = never)" (default 30) and "Mark a connection stale after N days" (default 14). Dates now carry the year
when it is not the current one. See [policy.md](policy.md#removing-connections-stale-connections-and-automatic-removal-adr-0033).

## Account, and keys on the Projects page (OPS2)

The **Account** page: the password, the authenticator app (QR code drawn in the browser, recovery codes shown once) and
the encrypted secret store's state ([auth.md](auth.md#managing-the-owner-account-from-the-dashboard-ops2)). The
**Projects** page adds, re-keys, pauses and drains, and removes projects ([projects.md](projects.md#managing-projects-on-the-dashboard-ops2)).
The **Overview** recommends the authenticator strongly while it is off, and shows any problem with the secret store
and any difference between the env file and the store.

## Repository Tree (v2 A2)

The **Repository Tree** page shows the selected project's tree: status, counts by kind and depth, the running build's
progress and its estimate (confirmed before anything is read page by page), the last build, sweep and check, the
unclassified and stale pages, failed re-reads, the correction log and a simple browser. Its routes and behaviour are in
[tree.md](tree.md#dashboard-and-admin-api). Project settings (the AI REPOSITORY root and the names the tree reads) are
edited on the Projects page. Other pages link to one page of the tree with `/ui/tree?node=<id>` (v2 A3).

## Types and taxonomy (v2 A3)

The **Repository Mappings** page also holds the selected project's **type registry** (types with their root index,
templates and review flags; seed the Character type, create and edit types), its **taxonomy** (a tree of each type's
categories with the review queue; seed once, "add missing", edit singular, aliases, asset folder, parent and notes), the
**drift** report (with links into the Repository Tree) and a read-only **Try it** panel (resolve a name, plan a
character placement, compute an ordering slot). How to use it: [registry.md](registry.md).

## Asset Tree (v2 A4)

The **Asset Tree** page shows the selected project's asset library as the bridge knows it: status, counts, the build
(the root level is listed first and the estimate shown; nothing more is read until you confirm), the last build, refresh
and check, stale rows, failed re-reads, the correction log, a folder browser, **Refresh now**, and a read-only **Try it**
panel that shows where a character's images would go. Its routes and behaviour are in
[assets.md](assets.md#dashboard-and-admin-api).

## Admin API

All under `/api/admin`, JSON in and out, errors as `{ "error": { "code", "message" } }`. Routes marked † take
`?project=` (v2 A1); routes marked ‡ need a re-authentication within the last five minutes (OPS2).

| Area        | Routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session     | `GET /session` (user, CSRF token, version)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Overview †  | `GET /overview` (every project's status, health, controls, job and error counts, pending proposals, headline gauges; `?refresh=true` re-checks LegendKeeper, otherwise cached for a minute)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Jobs †      | `GET /jobs` (`view=active\|history`, `status`, `origin`, `principalId`, `profile`, `kind`, `before`, `limit`), `GET /jobs/:id` (steps, attempts, request ids, `uncertain`, retry advice), `GET /jobs/:id/artifacts/:artifactId`, `POST /jobs/:id/cancel\|pause\|resume`, `POST /jobs/:id/steps/:stepNo/retry` (`{ force }`)                                                                                                                                                                                                                                                                                                                                               |
| Errors †    | `GET /errors` (`resolved=false\|true\|all`), `GET /errors/group?fingerprint=`, `POST /errors/resolve`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Budgets †   | `GET /budgets` (one project's snapshot, 24 h history in at most 288 buckets, drift, floors), `GET /budgets/all` (every project side by side), `PUT /budgets/reserve-floors`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Writers     | `GET /writers` (slots, locks, waits, rate), `PUT /writers/max`, `POST /writes/pause\|resume\|drain\|undrain`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Journal †   | `GET /journal` (filters `jobId`, `resourceId`, `documentId`, `targetId`, `opId`, `principalId`, `profile`, `outcome`, `withPreImage`, `sinceMinutes`; paging `limit` (≤ 200) and `before`, answered with `nextBefore`; metadata only), `GET /journal/:id` (with the pre-image). View only                                                                                                                                                                                                                                                                                                                                                                                 |
| Proposals † | `GET /proposals` (`group` or `state`, `principalId`, `profile`), `GET /proposals/counts` (with every project's pending count), `GET /proposals/:id` (diff data, page-level summary, canonical changes), `POST /proposals/:id/approve`, `POST /proposals/:id/approve-as-canon` (`{ confirm: true }`, v2 C2a), `POST /proposals/:id/reject`, `POST /proposals/bulk` (`action`: `approve`, `reject`, or `approve-as-canon` with `{ confirm: true }`; at most 100 ids)                                                                                                                                                                                                        |
| Access      | `GET /clients`, `POST /clients/profiles`, `PUT /clients/profiles/:id/scope`, `PUT /clients/default-scope`, `PUT /clients/connections/:id/profile`, `POST /clients/connections/:id/revoke`, `POST /clients/pats`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Settings    | `GET /settings`, `PUT /settings/read-only\|expose-per-op-tools\|member-admin\|journal-retention\|tier-limits`, `GET /audit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Maintenance | `GET /maintenance`, `GET /maintenance/:id` (with history), `POST /maintenance/:id/enable\|disable\|run`, `PUT /maintenance/:id/schedule` (chunk 6, [docs/maintenance.md](maintenance.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Mappings †  | `GET /mappings`, `POST /mappings/sets`, `GET\|PUT /mappings/sets/:id`, `POST /mappings/sets/:id/activate\|deactivate\|delete\|rules\|fields`, `PUT /mappings/rules/:id`, `PUT /mappings/fields/:id`, `POST /mappings/rules/:id/delete`, `POST /mappings/fields/:id/delete`, `GET /mappings/sets/:id/export\|preview`, `POST /mappings/import` (chunk 6, [docs/mappings.md](mappings.md))                                                                                                                                                                                                                                                                                  |
| Registry †  | `GET /registry`, `POST /registry/types\|seed-character\|templates/refresh`, `GET\|PUT /registry/types/:id`, `POST /registry/types/:id/delete`, `GET /registry/types/:id/taxonomy`, `POST /registry/types/:id/taxonomy/seed\|add-missing`, `PUT /registry/taxonomy/:id`, `POST /registry/taxonomy/:id/delete`, `GET /registry/drift`, `POST /registry/drift/run`, `GET /registry/try/resolve\|placement\|ordering`, `GET /registry/out-of-order` (v2 A3, [docs/registry.md](registry.md))                                                                                                                                                                                  |
| Projects    | `GET /projects`, `PUT /projects/:name/read-only` (`{ value, confirm: true }`), `POST /projects/:name/verify` (v2 A1), `PUT /projects/:name/settings` (`{ key, value }`, v2 A2), `GET\|PUT /projects/:name/canon` (`{ rules, agentDefaultStatus?, confirm: true }`, v2 C2a), `GET\|PUT /projects/:name/lifecycle` (`{ …values, workingIndexId?, archiveIndexId?, reset?, confirm: true }`, v2 C2c); OPS2: `POST /projects/check` (`{ name, apiKey }`) ‡, `POST /projects/:name/key/check` (`{ apiKey }`) ‡, `POST /projects/confirm` (`{ checkId, confirm: true }`) ‡, `PUT /projects/:name/draining` (`{ value }`), `POST /projects/:name/remove` (`{ confirm: true }`) ‡ |
| Account     | OPS2: `GET /security`, `POST /security/reauth` (`{ password, totp? }`), `POST /security/password` (`{ currentPassword, newPassword }`) ‡, `POST /security/totp/enrol` ‡, `POST /security/totp/confirm` (`{ code }`) ‡, `POST /security/totp/remove` (`{ confirm: true }`) ‡, `POST /security/recovery-codes` (`{ confirm: true }`) ‡                                                                                                                                                                                                                                                                                                                                      |
| Lifecycle † | `GET /lifecycle/records` (`limit`, `offset`; the lifecycle record, newest first, and the link index's freshness; v2 C2c). View only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Stream      | `GET /stream` (Server-Sent Events)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Confirmations are part of the contract, not only the UI: raising a scope without `confirmRaise: true` is a `409
CONFIRMATION_REQUIRED`, and every settings and reserve-floor change needs `confirm: true`. `WRITERS_MAX` outside 1–8 is a 400.

### Retrying a step

`retry` on each step says whether it may be retried and whether it is _ambiguous_ (it may already have reached
LegendKeeper). A normal retry re-checks first and cannot duplicate; `force: true` re-runs it as new work. The dashboard
shows the warning and asks twice before forcing.

## Journal page (chunk 8)

C2d: a target below a page (a property, row, link item or block, whose id copies of one template share) is shown with
its page and document (`page › document › id`), and filtering by such a target id needs the page's id too.

The journal records **every** write the bridge sends, not only destructive ones, so the page lists what each agent
changed, with outcome, principal, profile and approver. Filters: operation, document, resource, profile, principal,
outcome, "destructive only" (writes that kept a pre-image) and time. Pages of 100, newest first; **Older** and **Newest**
move through them with the `before` cursor. Retention is unchanged (30 days or 2 GB, the `journal-prune` job).
Since v2 C1 an entry made by `write_page` shows its **Operation** (mode, section, a hash of the Markdown, the version it
was planned on, and whether it was re-planned inside the lock) above the pre-image.

## Proposals: page writes (v2 C1)

A proposal made by `write_page` opens with a **Page write** panel: the mode, section, page and document, the counts
(blocks kept, changed, added, removed; keep regions kept and dropped), any keep regions the agent drops on purpose, and
the **Markdown diff**: the page's Markdown before and after, line by line in hunks, each keep region shown as one
labelled placeholder line (`[keep region: infobox infobx01]`). The block-level diff of the operation is shown below it
as before. Approving runs exactly that change; if the page changed since it was planned the proposal becomes
conflicted and nothing is written ([ADR 0031](adr/0031-write-page.md)). Once it has run, the panel says whether the
page read back after the write was exactly what was planned.

## Proposals: pages affected, facts and canon (v2 C2a)

Every proposal opens with **Pages affected**: its operations grouped by the page they affect, one plain line each
(`Asagiri Miyabi: sidebar, 1 fact changed, 1 link added`; a page the proposal creates is marked _(new)_). The list
shows the first lines under each proposal's summary. Below it come the high-level panels (a page write's Markdown diff;
a set_facts change's **Facts and links**), then each operation's diff as before.

**Facts and links** (a `set_facts` proposal): a table of the facts asked for, before and after, each marked added,
changed, removed, no change or not there; for each link collection the pages added and removed, those already linked,
and whether the collection's filter is kept. Once it has run, the panel says whether the sidebar read back after the
writes was exactly what was planned.

**Protected canon.** A proposal whose change touches protected canon is marked **canon** in the list and opens with a
banner listing the protected changes (for example "Status would be set to Authoritative"). Its only approval is
**Approve and accept as canon**, which asks for a confirmation naming the changes, is recorded with who accepted it as
canon (`proposal.approve_as_canon` in the audit log) and is shown on the proposal afterwards. The ordinary **Approve** is
disabled for it, and the ordinary bulk Approve skips it (reported as skipped, not as a failure); several canonical
proposals are accepted together with **Accept selected as canon** (see
[the bulk actions](#proposals-the-bulk-actions-11-november-2026)). **Reject** works as normal. See
[policy.md](policy.md#protected-canonical-facts-v2-c2a).

## Proposals: the bulk actions (11 November 2026)

Tick several pending proposals and the bulk bar shows what the selection holds, by kind. The two kinds of approval stay
distinct:

- **Approve selected (N)** counts only the **ordinary** proposals and runs those. A canonical proposal in the selection is
  skipped, and the confirmation and the result say so ("1 canonical proposal was skipped: use Accept selected as canon");
  it is listed in the results as _skipped_, never as a failure, and stays pending.
- **Accept selected as canon (M)** appears only when the selection holds canonical proposals, and takes only those. It
  opens a confirmation that lists **each** canonical proposal: its page-level summary line, its canonical reasons (the
  same ones the single view's banner shows, such as "Status → Authoritative", "Archive" or "Delete Authoritative page")
  and, for a lifecycle proposal, how many related pages it reports. **Accept M as canon** stays disabled until you tick
  **I accept these M changes as canon**. The confirmation sends exactly the ids it showed: a proposal ticked behind it,
  or one decided elsewhere since the list loaded, is not accepted (the latter is left out, and the dialog says so).
- **Reject selected** takes every selected proposal, canonical or not: rejecting needs no canon decision. Conflicted
  proposals can be rejected in bulk from the Conflicted tab's selection as before.

Each approval is decided on its own, **one at a time, in the order listed**: each re-reads its targets from LegendKeeper
first, an earlier one may change a later one's, and one whose target changed becomes _conflicted_ and runs nothing while
the others go ahead. Results appear per proposal under the bar: _done_ (accepted as canon, approved or rejected),
_conflicted_, _skipped_, or _refused_ with the reason (for example "ordinary proposal; use Approve" when an ordinary
proposal reaches the canon action through the API). Each accepted proposal gets its own `proposal.approve_as_canon`
audit row with `canonicalApprovedBy` and `bulk: true`. The API is `POST /proposals/bulk` with `action:
"approve-as-canon"`, `ids` (at most 100, as for the other actions) and `confirm: true` (without it: `400`); it is owner
only, behind the same session, CSRF and same-site checks as every admin route.

## Proposals: new pages, moves and deletes (v2 C2b)

A proposal from the resource, document and character tools opens with one line per page in **Pages affected**: a page
it creates reads `New page [BSRC] Asagiri Ren - Character Core under [INDEX] Asagiri Ren: 6 facts` (marked _(new)_);
a rename lists what changes; a move `moved to [INDEX] …`; a delete `deleted` or `deleted with 3 pages under it`. The
ids of the pages it creates are fixed in the proposal (a child shows under the new index it will be made under) and
used exactly at approval. A **delete of protected canon** (a page whose Status is Authoritative, or a cascade holding
one) is marked **canon** like a protected fact change, its banner naming each protected page ("deleting “Inae Mikumo”,
whose Status is Authoritative"); only **Approve and accept as canon** runs it. A restore needs no canonical approval.
Once a proposal has run, the panel says whether every page read back was as planned (names, parents, places among
their siblings, facts).

## Proposals: lifecycle changes (v2 C2c)

A proposal from `archive_page`, `unarchive_page`, `move_to_working` or `promote_page`, or a create with
`status: "authoritative"`, is always **canon**: only **Approve and accept as canon** runs it. A lifecycle tool's
proposal opens with a **Lifecycle change** panel: the page, the new name and parent (and its place among its new
siblings), a table of the facts before and after (each marked changed, added, removed or kept), the tags removed and
added, **the archive note** as a Markdown diff (added, or removed on unarchive), a character index that moves with a
promoted character, the flags the owner should know (a note or a Scope edited since archiving, a Core moving alone,
a destination other than the remembered one), and, for `archive_page` and `move_to_working`, the **related pages** with
how fresh the link index is. A proposal that resumes a lifecycle change that stopped part-way says so and lists only
what is left. Everything is checked again when it runs: a page changed since the plan makes it conflicted.

**A whole set (C2d, `subtree: true`)** opens with a **Whole-set lifecycle change** panel instead: the set's root, how
many pages (content pages and indexes), the state it leaves and enters, where its root goes (the set stays together),
the estimated reads and writes, then a table with **every page of the set**: its name, what it becomes, its place
("moves under …" for the root, "stays under its parent" for the rest), its fact changes, its tags before and after, and
its note (indexes are marked as having no Status). The related pages are listed page by page, links between pages of
the set left out. One "Approve and accept as canon" runs the whole set; a page added, removed or moved under the set
since the proposal makes it conflicted (ADR 0036 decision 5).

## Archive and lifecycle (v2 C2c)

The **Archive and lifecycle** page (navigation: Archive and lifecycle) lists the selected project's lifecycle record,
newest first, read-only and never pruned: one row per change (archived, unarchived, moved to Working, promoted) with the
page (id and name before the change), the date, the state it was in, its name after, whether the change is
**complete** or **incomplete** (and "not as planned" when the verify step found a difference), and its job ids, each
linked to the Journal page filtered by that job (`/journal?jobId=…`). A page changed as part of a whole set shows
"(whole set N)" beside its action, N being the set record (`GET /lifecycle/records` also returns the newest set records
as `sets`). An incomplete change is finished by calling the same tool on the page again (for a set: on its root, with
`subtree: true`). Below the list, the **link index**: how many links it holds, the last complete link
sweep (when, pages, documents and requests), and a sweep in progress (how far it is, and why it stopped if it did).

**Lifecycle (Projects page).** Each project's lifecycle settings: `[INDEX] Working` and `[INDEX] Archived` as found by
name in the repository tree now (found, missing, or ambiguous with the candidates), the ids confirmed so far, and
**Confirm these indexes** when exactly one of each is found (asks for a confirmation; the lifecycle tools and Working
creates refuse until both are confirmed, and again if a confirmed index is renamed, moved out or deleted). **Values**
opens the index names, Status values, status tags, fact names, Continuity Types and the archive texts (`{date}` and
`{source}` are filled in) for editing; C2d adds **Note on an index archived with its set** (default "Archived - {date}.
The author retired {source} and the pages beneath it. They are kept for provenance.", a proposed wording for the owner
to confirm). **Save** asks for a confirmation and, since C2d (ADR 0036 decision 4), for the password (and authenticator
code) if the owner has not re-confirmed them in the last 5 minutes; **Restore the defaults** brings back the owner's
values and clears the confirmation (the same re-authentication applies). Every change is audited as
`project.set_lifecycle` with the values before and after.

## Chronology (v2 D1)

The **Chronology** page (navigation: Chronology, after Archive and lifecycle; ADR 0038) has three cards for the selected
project.

- **Settings.** Whether the chronology is confirmed (and if not, why: `CHRONOLOGY_NOT_CONFIGURED` or
  `CHRONOLOGY_CHANGED`, with what to do), the confirmed settings (the chronology page, its calendar, its Main document,
  and per age its table, its timeline, that timeline's lane and its Main row), and what a lookup by name finds in the
  repository tree now (free). **Read the chronology** reads the calendar, the Main table, every age table and every age
  timeline's lanes (about three requests per age) and shows what it found: each age with its era, rows and count, any
  problem, and **how the tables write** dates and KCY values (each aspect's value, how many rows showed each way, up to
  three examples, and the aspects written more than one way). The style can be edited before **Confirm these settings**
  (asks for a confirmation). **Clear the chronology settings** removes them (the tools refuse again). Every change is
  audited as `project.set_chronology`. Until confirmed, the timeline tools refuse. The table is the authority; the
  timeline is a derived view.
- **Chronology check.** The last run of the check (state, when, requests, summary) and its findings in plain words: rows
  without an event, events without a row, a row and its event that disagree about the date or shape (**Row and event
  disagree about the date**), rows out of order, wrong KCY values, cells written differently from the confirmed style,
  count mismatches, event links not to their age's table, dates the engine cannot read. **Run the check now** runs it
  (P2; reads only; the check itself never repairs); it also runs weekly (Maintenance page). Differences of wording only
  between a row's description and its event's short name, and the thousands separator in a year (LegendKeeper writes
  `AA 1988119`, the tables `AA 1,988,119`), are not findings.
- **Propose a fix** (v2 D1.1, [ADR 0039](adr/0039-date-styles-timeline-repair-and-etag-versions.md)). A **Row without an
  event** or **Row and event disagree about the date** finding has a **Propose a fix** button. It plans
  `sync_timeline_event` for that row (about 3 reads; the table is the authority) and makes ONE proposal: nothing is
  written until you approve it, as normal, on the **Proposals** page (it shows the row and the event before and after).
  The proposal is made by the system, audited as `chronology.propose_fix`, creates the missing event or corrects the
  paired event's minutes, `detail`, shape and `uri`, and never touches the table or the Main count. An ambiguous pairing
  (several events could be the row's), a change of that age that stopped part-way and a row that is gone are refused with
  their reason; a row whose event already agrees says so. After approving, run the check again: no findings.
- **Changes.** The record of every chronology change, newest first: the tool and summary, the ages, the writes, who made
  it (and who approved it), its state (**complete**, **incomplete**, **resolved**) and its jobs linked to the Journal
  page. A change that stopped part-way is finished by the same request again; **Mark resolved** (asks for a
  confirmation; audited `chronology.resolve`) is for one fixed by hand, after which other changes of its ages go ahead.

Admin API: `GET /projects/:name/chronology`, `POST /projects/:name/chronology/lookup`, `PUT /projects/:name/chronology`
(`{ confirm: true, settings }` or `{ confirm: true, reset: true }`), `GET /chronology/records`, `POST
/chronology/records/:id/resolve`, `GET /chronology/check`, `POST /chronology/check` (`{ confirm: true, project }`), `POST /chronology/propose-fix`
(`{ confirm: true, project, age, rowId }`: one proposal, or `nothing_to_do`).

## Canon (Projects page, v2 C2a)

The **Canon** section of the Projects page lists each project's protected facts as plain sentences ("Status =
Authoritative: setting it to, or changing it from, this value needs canonical approval"). Since v2 C2c the Status of
pages agents create follows the page lifecycle (Working by default; the Lifecycle section below) rather than a canon
setting, so the old "Status of pages agents create" field is gone. Each rule has **Switch off** / **Switch on** (v2
C2c): a rule switched off stays in the list, marked off, and applies nowhere until switched on again; the two rules
v2 C2c recommends, "deleting a [BARC] page" and "deleting a map, timeline or board of an Authoritative page", are on
by default. **Remove** takes a rule out, **Add** puts one in (a fact, and either "these values, both ways" with the values, "any
change of a set value", or, since v2 C2b, "deleting a page with these values": the rule that makes deleting an
Authoritative page need canonical approval, seeded by default as "Status = Authoritative: deleting such a page (or a
subtree holding one) needs canonical approval; restoring does not"); nothing is stored until **Save**, which asks for a
confirmation (marked as dangerous when it protects fewer facts than before) and, since C2d (ADR 0036 decision 4), the
dashboard's re-authentication (password, and authenticator code when set up) unless done in the last 5 minutes:
switching a rule off and removing every rule count as saving too. **Restore the defaults** brings back the seeded rules.
C2d adds a rule, on by default: **Status tags (CANON, Working, Archived)**: added or removed only by the lifecycle tools
and by creates according to their status (ADR 0036 decision 7); switching it off frees them. Every save is audited as `project.set_canonical_rules` with the rules before and after. With no rule at
all the section warns that agents with scope "write" can change any fact. Changes apply to the next write; nothing
needs a restart.

## Stream

`GET /api/admin/stream` carries the engine's events (`job`, `step`, `lock`, `writers`, `error`, `controls`), the policy
layer's (`policy`, `proposal`), the governor's (`throttled`, `budget-wait`), the registry's (`project`: a project's
status or flags changed) and a `budget` snapshot every 2 seconds, holding every project's (`projects`, by LegendKeeper
id). Events about one project carry its id, and the project-scoped pages ignore other projects' events. Each frame's
data is `{ "at": <ms>, "data": … }`.

- **Heartbeats** are real `heartbeat` events every 15 s (`ADMIN_STREAM_HEARTBEAT_SECONDS`), so a page can tell a dead
  connection from a quiet one. Each tick also re-checks the session: a signed-out dashboard gets `unauthenticated` and the
  stream ends.
- **Reconnection.** Replayable events have ids `<boot>-<n>`; the last 500 are kept (`ADMIN_STREAM_REPLAY_EVENTS`). A
  browser that reconnects sends `Last-Event-ID`: if that position is still held, it gets `hello` with `resumed: true`
  and the missed events; otherwise `resync` (after a restart, or too long away), and the page reloads what it shows.
  `budget` and `heartbeat` carry no id and are not replayed. The page also reopens a stream that missed three heartbeats.

## Settings and when they apply

| Setting                                                                                     | Applies                                                            |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Read-only mode (follow environment, on, off)                                                | At once (the engine's own override)                                |
| `WRITERS_MAX`, pause, drain                                                                 | At once                                                            |
| Reserve floors                                                                              | At once (`governor.setReserveFloors`); also applied at every start |
| Per-operation tool exposure, member administration, journal retention, tier limit overrides | **At the next start.**                                             |

The last group is built into components when the bridge starts (the tool list, the policy gate, the governor's windows).
They are stored in `runtime_settings` (`dash.*` keys) and applied by `applyStoredSettings` when the runtime is built; the
Settings page shows _pending restart_ until they match what is running. Clearing a stored value goes back to the
environment's. A stored value that no longer validates is ignored.

## The budget sampler

The Request Budgets sparklines are drawn from `budget_samples`, one row per project every 10 seconds (each project has
its own governor). Since chunk 6 the maintenance
scheduler's `budget-sampler` job writes them ([docs/maintenance.md](maintenance.md)); the interim sampler of chunk 5 is
gone, and `ADMIN_BUDGET_SAMPLE_SECONDS` with it. Switch the job off or change its interval on the Maintenance Jobs page.

## Settings (environment)

| Variable                         | Default | Meaning                                                  |
| -------------------------------- | ------- | -------------------------------------------------------- |
| `ADMIN_STREAM_HEARTBEAT_SECONDS` | 15      | Heartbeat interval of the stream                         |
| `ADMIN_STREAM_REPLAY_EVENTS`     | 500     | Events kept for reconnection                             |
| `ADMIN_BUDGET_PUSH_SECONDS`      | 2       | How often a budget snapshot is pushed to open dashboards |

## Behind Caddy

The stream sends `X-Accel-Buffering: no` and `Cache-Control: no-transform`; Caddy's `reverse_proxy` streams without
buffering by default. Chunk 7's runbook should keep it that way (no `encode` of `text/event-stream`).

## Tests

- `test/admin/auth.test.ts`: every registered route rejects no credentials, an OAuth token and a PAT (both valid at
  `/mcp`), and every state-changing route rejects a missing or wrong CSRF token and a foreign or missing Origin.
  The route list is collected from Fastify, so a new route is covered automatically.
- `test/admin/actions.test.ts`: each action reaches its command or control and leaves one audit row and one event.
- `test/admin/stream.test.ts`: events arrive; replay, resync, heartbeats, sign-out, no secrets in events.
- `test/admin/ui.test.ts`, `data.test.ts`: redirect and return, headers, static files and traversal, every read route,
  redaction, PAT shown once and never logged.
- `test/ui/`: each page with mock data; live job progress from the stream; `WRITERS_MAX` live; approve, reject, bulk and
  conflicted proposals; scope-raise and settings confirmations; a PAT shown once; and `e2e.test.tsx`, the real bridge
  with the real dashboard code in jsdom while a mock job runs.
- `test/e2e/`: Chromium against the built dashboard under the real CSP (sign-in and return, live pages, proposal diff, a
  token, a phone-sized dark layout).

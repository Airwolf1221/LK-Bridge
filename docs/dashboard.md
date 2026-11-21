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

## The sidebar (v3 F3c)

Overview, Jobs, Proposals (with its pending count) and, since v3 F3.4, Review (with its unreviewed count) are always at
the top. Every other page is in an expandable group;
the code sorts the groups by name and their pages by label (locale-aware, ignoring case), so a new page only needs its
group named in `NAV` (`ui/src/app.tsx`):

| Group              | Pages                                                                |
| ------------------ | -------------------------------------------------------------------- |
| Access & Account   | Account · Clients & Access                                           |
| Assets             | Asset Tree · Staging                                                 |
| Backups & Recovery | Off-site copy · Snapshots                                            |
| Limits             | Concurrent Writers · Request Budgets                                 |
| Monitoring         | Errors · Journal · Tool calls                                        |
| Quality            | Appraisal · Audits · Evaluation                                      |
| Repository         | Archive and lifecycle · Chronology · Repository Tree                 |
| Setup              | Maintenance Jobs · Packs · Projects · Repository Mappings · Settings |

The current page's group opens whenever the page changes. The owner's open and closed choices are kept in this browser
(`localStorage`, key `lkb-nav-open`); on a first visit only the current page's group is open. A closed group shows the
sum of its pages' counts. Each group header is a button (`aria-expanded`, `aria-controls`); the chevron does not
animate when reduced motion is asked for. Pages reached only from a parent page are listed in `SUB_PAGES`; a test fails
when a page module is neither routed nor listed there.

- **Only the owner session.** The credential is the cookie set by the owner sign-in (chunk 4). OAuth access tokens and
  personal access tokens are never read on `/api/admin` (the `Authorization` header is ignored), so a token that works at
  `/mcp` does nothing here. Unauthenticated API requests get a 401 JSON body with no `WWW-Authenticate` header.
- **Unauthenticated `/ui`** requests are redirected (303) to `/oauth/login?return_to=…` and come back afterwards. No
  dashboard bytes are served first. A session that ends while the page is open sends the page to sign-in (a 401 from the
  API, or the `unauthenticated` stream event).
- **Cross-site requests (chunk 8).** Any `/api/admin` request a browser labels `Sec-Fetch-Site: cross-site` or
  `same-site` is refused (`403 CROSS_SITE`), reads included. Since ADR 0062 the session cookie is `SameSite=Strict`, so
  no navigation from another site carries it at all; this check stays as a second line (chunk 8 had `Lax`, under which a
  link on another site could carry it to read routes that spend budget).
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
- **The step-up (OPS2, [ADR 0062](adr/0062-dashboard-sessions-and-step-up.md), accepted with the owner's rule:
  tightening is one click, loosening asks).** Keys and secrets, a scope raised, the settings (every off-site setting
  among them) and releasing a brake (read-only off, resuming writes, undraining), pack approval and the guarded rails
  (approving a proposal that deletes, touches more than 10 pages, or deletes or moves an asset; the owner's own bulk
  retag) need a step-up on the session within the last ten minutes: the authenticator code (or a recovery code), or the
  password when no authenticator is set up. Otherwise the answer is `403 REAUTH_REQUIRED`; the dashboard asks in one
  dialog and sends the change again ([auth.md](auth.md#managing-the-owner-account-from-the-dashboard-ops2)). A wrong code
  (`401 REAUTH_FAILED`) stays in the dialog, and a wrong current password (`401 WRONG_PASSWORD`) on the Account page is
  shown there (CR-2026-11-R4); any other 401 means signed out. Tightenings and brakes stay one click: lowering a scope,
  moving a connection down, read-only on, ChatGPT's file source off, pausing writes and draining, Sign out everywhere,
  revoking a connection or a token, cancelling a job, switching most maintenance jobs off, rejecting a proposal.
  CR-2026-11-R4 (ADR 0062 amendment 1): a guarded approval is judged on the whole proposal by the rail that made it a
  proposal (its recorded reason: the deletes, bulk or assets rail) and by its operations, with the removals through a
  low-level tool (`lk_api_write`, `lk_api_batch`, `lk_op_*`: a block or a row deleted, a list write that drops entries,
  text taken off a pack page) and a member or invite removed counted as deletes; confirming a project's chronology asks
  too (a reset is one click); and the OAuth consent page asks for the same step-up, on the page itself, before a scope
  raise, a new profile above the default or a connection at scope `write` ([auth.md](auth.md#consent-and-profiles-chunk-2b)).
- **Sessions (ADR 0062).** A session lasts 30 days from its last use (each use renews it and its cookie), survives a
  restart, and ends at sign-out, at **Sign out everywhere** (the Account page: every session, this one included, and
  those already past their end), at a password change (the other sessions) or after 30 days unused. A link to the
  dashboard, Claude's consent page and Google Drive's return come from another site, which a Strict cookie does not ride
  on: each answers once (a top-level navigation only: never another site's image, fetch or frame) with a small page of
  the bridge's own, never framed, that opens the same address again from the bridge. When the live stream is refused,
  the dashboard checks its session once and, signed out, goes to the sign-in page instead of reconnecting.
- **What counts as a use (CR-2026-11-R4, ADR 0062 amendment 1).** The owner's own actions and page loads. Not the
  dashboard's own requests: every request it sends without the owner's input carries `X-LKB-Background: 1` (a page's
  refresh timer, a reload for a live event or for the stream starting afresh, the session check after the stream
  drops, anything sent more than a minute after the owner's last key, click or touch), and opening the live stream is
  never one; the bridge checks such a request's session without moving its end or renewing its cookie. An idle open tab
  therefore ends 30 days after the owner last used it.
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
Writers are bridge-wide (the writer pool is shared; each busy slot names its project). On the Maintenance page (v2 E5.1),
**Run now** on a per-project job ("Run now for <project>") runs it for the **selected project** only; the schedule still
covers every project. A per-project job shows one line per project (last run, outcome, summary, or **running** for the
project being run now), its status names the project running, every job link opens in its own project, and its history
shows the selected project's runs, or every project's (tick **Every project**) with each row named. The **Projects** page lists every
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

## Review (v3 F3.4)

[ADR 0055](adr/0055-write-scope-review-revert-rails.md). At scope `write` an agent's ordinary changes run at once; the
**Review** page (top of the sidebar, beside Proposals, with a badge of the unreviewed count) lists every job an agent ran
directly, newest first: the agent, the tool, a summary in the words a proposal would have used, and the pages it
touched. **Show the changes** expands an item to the same diff a proposal shows (page text as a Markdown diff, facts before
and after, links added and removed, names, tags, aliases, moves, chronology rows and events, image placements), built
from the journal's pre-images and the job's own record, with anything Revert cannot put back and why. Filters:
unreviewed (the default), reviewed or all; agent profile; tool. Approved proposals and pack packages (proposals by
default) are not listed: you saw them before they happened. The Overview page shows the unreviewed count too.

- **Mark reviewed** takes an item off the badge (audited `review.mark`). **Mark all reviewed (N)** marks every item the
  filters show, after a confirmation naming N; if the set changed in the meantime nothing is marked and the page asks
  you to look again (`REVIEW_CHANGED`; audited `review.mark_all`). The set is compared exactly, not only its count: the
  list answers a fingerprint of the ids (`markAll.fingerprint`) and the request sends it back (CR-2026-11-R2, R2-09).
- **Revert** (also on the Jobs page, for a finished job an agent ran directly) first shows what it would do: each thing
  the job changed, whether it can be put back, and, for one that changed since or cannot be reverted, why. It puts back
  page text (block by block), sidebar facts and links, chronology rows and their events (in step), names, tags, aliases
  and moves, and image placements: the image's file is copied back to the bridge's server, so the image is back on
  the **Staging** page, and deleting the placed image from the library is **proposed to you** on the Proposals page
  (nothing is ever written to the `LK-Bridge staging` folder, and the revert itself deletes nothing). A deleted image
  is not private (W5): LegendKeeper keeps serving its file at its old URL, so approving that deletion takes the image out
  of the library, not off the web. It never reverts
  a deletion (it points to `restore_resource`), a proposal, a running job or
  another revert. **All or nothing by default:** if anything cannot be put back, the dialog lists it and you tick
  the box to revert the others anyway (**Revert the rest**). Each target is checked again inside the revert job, so an edit made
  meanwhile is never overwritten. It asks for the step-up first (ADR 0062: your authenticator code, or your password
  without one), and is audited (`job.revert`, with
  the targets and the outcome). The revert is one job (system, P1) on the Jobs page; its result points to the journal
  and the snapshots if you need to go further. A reverted job is marked reviewed.
  Since CR-2026-11-R2: a target is compared in full with what the job left (a chronology row with its links, marks and
  inline icons, an event with every stored field, a move with its place among its siblings, a later job's write to the
  same target), and every target is checked before the first write (R2-16, R2-19, R2-20, R2-28); the request carries the
  targets you confirmed, and a different set is refused (`REVERT_CHANGED`, R2-23); a second revert of the same job while
  the first is starting is refused (`REVERT_RUNNING`, R2-21); a revert whose own verify finds a difference ends failed
  and the item stays unreviewed (R2-25); Last Major Revision goes back exactly, and only with the edit that set it
  (R2-18). A low-level job is summarised from its operations, with the agent's own title beside it (R2-06).

## Safety rails, per profile (v3 F3.4)

Each profile at scope `write` on **Clients & Access** has **Always propose** switches: even at write scope these still
become proposals, each saying which rail sent it (`proposed because: bulk change (14 pages > 10)`):

- **Deletes** (pages, documents, timeline events, map features, assets): on by default;
- **Bulk changes**: one job touching more than **N pages** (N per profile, default 10; 1 to 1,000): on by default;
- **Renames and moves of pages**: off by default;
- **Asset deletes and asset moves** (placing a staged image is not a move): on by default.

**Save rails for** a profile asks for confirmation and the step-up (ADR 0062: your authenticator code, or your password
without one), and is audited (`profile.set_rails`, with the
rails before and after); a change applies at the profile's next request. The rails only ever add proposals: canon and
lifecycle changes stay proposals whatever they say. See [policy.md](policy.md#write-scope-review-revert-and-safety-rails-v3-f34).

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

## Tagging (v3 F3f)

The **Tagging** page (Repository group; [ADR 0060](adr/0060-v3-f3f-retag-audit-and-apply.md)) holds the Controlled Native
Tagging Standard's workflows for the Arkona pack. Above the tabs: the policy (the approved pack version, the Tagging
Standard's label and the digest), or why the retag is unavailable (no approved version with retag rules, or drift).

- **Audit**: run the free audit (the snapshots; nothing is read from LegendKeeper) on everything, a page or a branch;
  choose a stored run and what to show (deterministic corrections by default, holds, exceptions, compliant, Working and
  Archived, excluded). Each page shows its current and proposed arrays, its disposition and a rationale per slot (holds
  and removals with their reasons). Tick deterministic corrections and **Propose the picked corrections**: after a
  confirmation, ONE batch proposal (each page an item), approved on the Proposals page like any other.
- **Holds**: each hold of the latest audit with its reasons and agents' suggestions. An uncertain category (or
  specialist) is resolved by choosing the category, and the specialist if any, from the closed list, with a reason:
  **Classify** asks for a confirmation and the password again, is audited (`retag.classify`), and is used by every later
  audit. **Withdraw** removes a classification (password again; audited `retag.unclassify`).
- **Batches**: each batch's state, proposal and job, and what became of each page: applied (and whether its read-back
  verified), already compliant, held, conflicted or inaccessible.
- **Reconciliation**: start a named reconciliation (a first audit, free), open one to see its counts (audited,
  corrections, holds, exceptions, proposed, applied, conflicted, stale, remaining) and its pages, and **Resume**: what
  remains is audited afresh, then its next batch is proposed. Pages whose facts, Reference Type or template changed in the
  snapshots since their verdict show as stale.

Its admin API is `/api/admin/tagging` (`GET`), `/tagging/audit`, `/tagging/runs/:id`, `/tagging/holds`,
`/tagging/classify` and `/tagging/unclassify` (re-authenticated), `/tagging/batches`, and `/tagging/reconciliations`
(start, `/:id`, `/:id/resume`). The Packs page's token-map editor also takes the Excluded Routine Tags (one per line),
which make a new version as the token maps do.

## Asset Tree (v2 A4)

The **Asset Tree** page shows the selected project's asset library as the bridge knows it: status, counts, the build
(the root level is listed first and the estimate shown; nothing more is read until you confirm), the last build, refresh
and check, stale rows, failed re-reads, the correction log, a folder browser, **Refresh now**, and a read-only **Try it**
panel that shows where a character's images would go. Its routes and behaviour are in
[assets.md](assets.md#dashboard-and-admin-api).

## Packs (v3 F3a)

The **Packs** page (navigation: Setup) shows each setting pack the bridge holds: today the Arkona pack, whose tools are
`arkona_create_character` and, since v3 F3b, `arkona_create_owner`, `arkona_create_relationship`,
`arkona_add_character_art` and `arkona_character_brief` ([packs.md](packs.md),
[ADR 0050](adr/0050-setting-packs-and-the-arkona-character-tool.md), [ADR 0052](adr/0052-arkona-pack-owners-relationships-art-and-the-brief.md)).
For each pack:

- its **state**: approved and current, not approved yet, rules changed since approval, governance changed since
  approval (with the changed sources named, as an alert), or governance unreadable. Anything but "approved and
  current" means the pack's tools compute no tags and refuse every package (`PACK_NOT_CURRENT`): they fail closed;
- its **tools**, the approval (version, by whom, when), and, since v3 F3.4, a switch per writing tool: **Always
  propose** (on: a package is a proposal whatever the agent's scope) or off (it follows the agent's scope). The seed's
  defaults: `arkona_create_character`, `arkona_create_owner` and `arkona_create_relationship` always propose;
  `arkona_add_character_art` (and F3c's `arkona_appraisal_fix`) follow the scope. A tool with no switch keeps the pack's
  `alwaysPropose`;
- the **governance sources**: each page the rules were derived from (for Arkona: Character Architecture, Source
  Formatting, and the Controlled Native Tagging Standard v1.8, all on the AI REPOSITORY page), with the document version
  approved and, after **Check governance now** (one read per source), the version now; since v3 F3b also the **pinned
  sections** each source's rules come from, with their state after a check (unchanged, changed, missing, or not approved
  yet), so a drift alert says which section changed;
- the **projects** it is attached to, whether the bridge serves each, and the template ids it uses there (worked out
  from the home project's template names by exact name, or unset with a note);
- the **token maps** (Race / Species and Naming Culture: a fact value and the tag token it becomes), editable: add,
  change or remove rows, then **Save token maps**;
- the **rules**, read-only: the status tags (and, since v3 F3b, the AU rule: `AU` in place of `CANON` on an AU page),
  the owner's **rulings** with their dates, what is never in a page name, and per type its tool, placement, gated
  fields, roles (template, name, Reference Type, tags, facts, text) and specialist tags; since v3 F3b the **owner
  table** (each owner type's template, primary and specialist tags and allowed homes, and the race roster's kinds);
- its **versions**, newest first, each with its reason and whether it was approved.

Four changes, each confirmed and then stepped up (your authenticator code, or your password without one; ADR 0062), and
each audited:

- **Approve this pack version** records the current rules' version with each governance source's document version, read
  now (`pack.approve`), and a digest of each pinned section. A source that cannot be read cannot be approved
  (`GOVERNANCE_UNREADABLE`), nor one whose pinned section is not on the page (`GOVERNANCE_SECTION_MISSING`: the page
  then shows the picker below). Approve after you have checked the rules against the governance pages; approve again
  after a governance page changes.
- **Re-map** a pinned heading (ADR 0052, amendment of 16 November 2026). When an approval is refused with
  `GOVERNANCE_SECTION_MISSING`, or **Check governance now** finds a pinned heading the page no longer has (a governance
  page renamed it), a **Pinned headings not found** table appears: each missing heading, its page, and a picker of that
  page's actual headings, listed in order and indented by level ("(level 2)"); a heading already pinned on that page
  cannot be chosen. Pick the heading the section has now and press **Re-map**: the mapping becomes part of a new pack
  version (`pack.remap_section`, recording the old heading and the new one), which you then approve with **Approve this
  pack version**, so you approve the mapping and the version together. Headings match as a whole (case, punctuation
  and numbering aside), never by prefix ([packs.md](packs.md#re-mapping-a-pinned-heading)).
- **Save tool switches** (v3 F3.4) makes a new version (`pack.set_tool_modes`), which waits for your approval like any
  other: until then the tools refuse (`PACK_NOT_CURRENT`).
- **Save token maps** makes a new version (`pack.set_tokens`), which waits for your approval: until then the tools fail
  closed. A token is never one of the never-tags (Unknown, Unestablished, None), and no value or token has an em or
  en dash in it (`INVALID_TOKEN`).

The pack is seeded once from the bridge's data and attached to the projects the seed names (`pack.seed`,
`pack.attach`); a governance check that finds a changed source records the drift (`pack.drift`). A newer seed (v3 F3b's
owner tools) reaches a stored pack as a new version at start, waiting for your approval (`pack.seed_upgrade`; your token
maps are kept): approve it here before the new tools compute anything. A pack's tools are
listed to agents only while it is attached to a project the bridge serves; if an agent's client does not show a pack's
tool, refresh its tool list (ChatGPT: Plugins, the bridge, Refresh).

## Admin API

All under `/api/admin`, JSON in and out, errors as `{ "error": { "code", "message" } }`. Routes marked † take
`?project=` (v2 A1); routes marked ‡ need the step-up within the last ten minutes (OPS2; ADR 0062, which also asks it of
every route that changes a setting, a scope or a key, and of approving a proposal of a guarded kind: see
[auth.md](auth.md#managing-the-owner-account-from-the-dashboard-ops2)).

| Area        | Routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session     | `GET /session` (user, CSRF token, version)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Overview †  | `GET /overview` (every project's status, health, controls, job and error counts, pending proposals, headline gauges; `?refresh=true` re-checks LegendKeeper, otherwise cached for a minute)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Jobs †      | `GET /jobs` (`view=active\|history`, `status`, `origin`, `principalId`, `profile`, `kind`, `before`, `limit`), `GET /jobs/:id` (steps, attempts, request ids, `uncertain`, retry advice; where it stopped and Resume; v3 F3e: `split`, the split whose phase 1 it is), `GET /jobs/:id/artifacts/:artifactId`, `POST /jobs/:id/cancel\|pause\|resume`, `POST /jobs/:id/steps/:stepNo/retry` (`{ force }`)                                                                                                                                                                                                                                                                                                                  |
| Errors †    | `GET /errors` (`resolved=false\|true\|all`), `GET /errors/group?fingerprint=`, `POST /errors/resolve`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Budgets †   | `GET /budgets` (one project's snapshot with its learned operation limits, 24 h history in at most 288 buckets, drift, floors), `GET /budgets/all` (every project side by side), `PUT /budgets/reserve-floors`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Writers     | `GET /writers` (slots, locks, waits, rate), `PUT /writers/max`, `POST /writes/pause\|resume\|drain\|undrain`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Journal †   | `GET /journal` (filters `jobId`, `resourceId`, `documentId`, `targetId`, `opId`, `principalId`, `profile`, `outcome`, `withPreImage`, `sinceMinutes`; paging `limit` (≤ 200) and `before`, answered with `nextBefore`; metadata only), `GET /journal/:id` (with the pre-image). View only                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Proposals † | `GET /proposals` (`group` or `state`, `principalId`, `profile`), `GET /proposals/counts` (with every project's pending count), `GET /proposals/:id` (diff data, page-level summary, canonical changes), `POST /proposals/:id/approve`, `POST /proposals/:id/approve-as-canon` (`{ confirm: true }`, v2 C2a), `POST /proposals/:id/reject`, `POST /proposals/bulk` (`action`: `approve`, `reject`, or `approve-as-canon` with `{ confirm: true }`; at most 100 ids)                                                                                                                                                                                                                                                        |
| Access      | `GET /clients`, `POST /clients/profiles`, `PUT /clients/profiles/:id/scope`, `PUT /clients/profiles/:id/rails` (`{ rails, confirm: true }`, v3 F3.4) ‡, `PUT /clients/default-scope`, `PUT /clients/connections/:id/profile`, `POST /clients/connections/:id/revoke`, `POST /clients/pats`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Settings    | `GET /settings`, `PUT /settings/read-only\|expose-per-op-tools\|member-admin\|journal-retention\|tier-limits`, `GET /audit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Maintenance | `GET /maintenance` (v2 E5.1: per-project jobs with `projects` and `runningProjectId`), `GET /maintenance/:id` (with history; `?project=` narrows it), `POST /maintenance/:id/enable\|disable\|run` (`run` takes an optional `project`, v2 E5.1), `PUT /maintenance/:id/schedule` (chunk 6, [docs/maintenance.md](maintenance.md)); v3 F3.5: `GET /maintenance/assign-block-ids-sweep/card`, `POST …/dry-run`, `PUT …/override` (on: re-authentication), `PUT …/limit`                                                                                                                                                                                                                                                     |
| Mappings †  | `GET /mappings`, `POST /mappings/sets`, `GET\|PUT /mappings/sets/:id`, `POST /mappings/sets/:id/activate\|deactivate\|delete\|rules\|fields`, `PUT /mappings/rules/:id`, `PUT /mappings/fields/:id`, `POST /mappings/rules/:id/delete`, `POST /mappings/fields/:id/delete`, `GET /mappings/sets/:id/export\|preview`, `POST /mappings/import` (chunk 6, [docs/mappings.md](mappings.md))                                                                                                                                                                                                                                                                                                                                  |
| Registry †  | `GET /registry`, `POST /registry/types\|seed-character\|templates/refresh`, `GET\|PUT /registry/types/:id`, `POST /registry/types/:id/delete`, `GET /registry/types/:id/taxonomy`, `POST /registry/types/:id/taxonomy/seed\|add-missing`, `PUT /registry/taxonomy/:id`, `POST /registry/taxonomy/:id/delete`, `GET /registry/drift`, `POST /registry/drift/run`, `GET /registry/try/resolve\|placement\|ordering`, `GET /registry/out-of-order` (v2 A3, [docs/registry.md](registry.md))                                                                                                                                                                                                                                  |
| Projects    | `GET /projects`, `PUT /projects/:name/read-only` (`{ value, confirm: true }`), `POST /projects/:name/verify` (v2 A1), `PUT /projects/:name/settings` (`{ key, value }`, v2 A2), `GET\|PUT /projects/:name/canon` (`{ rules, agentDefaultStatus?, confirm: true }`, v2 C2a), `GET\|PUT /projects/:name/lifecycle` (`{ …values, workingIndexId?, archiveIndexId?, canonExemptIndexes?, reset?, confirm: true }`, v2 C2c; `canonExemptIndexes` E5.3); OPS2: `POST /projects/check` (`{ name, apiKey }`) ‡, `POST /projects/:name/key/check` (`{ apiKey }`) ‡, `POST /projects/confirm` (`{ checkId, confirm: true }`) ‡, `PUT /projects/:name/draining` (`{ value }`), `POST /projects/:name/remove` (`{ confirm: true }`) ‡ |
| Account     | OPS2: `GET /security`, `POST /security/reauth` (`{ totp }` with the authenticator, else `{ password }`; ADR 0062), `POST /security/sessions/revoke-all` (`{ confirm: true }`; Sign out everywhere, no step-up), `POST /security/password` (`{ currentPassword, newPassword }`) ‡, `POST /security/totp/enrol` ‡, `POST /security/totp/confirm` (`{ code }`) ‡, `POST /security/totp/remove` (`{ confirm: true }`) ‡, `POST /security/recovery-codes` (`{ confirm: true }`) ‡                                                                                                                                                                                                                                              |
| Lifecycle † | `GET /lifecycle/records` (`limit`, `offset`; the lifecycle record, newest first, and the link index's freshness; v2 C2c). View only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Tool calls  | `GET /tool-calls` (filters `principalId`, `profile`, `tool`, `outcome=success\|error\|proposal\|waiting\|queued\|not_success`, `code`, `project`, `sinceMinutes`; paging `limit` (≤ 500) and `before`, answered with `nextBefore`; also the filter choices and the retention), `PUT /tool-calls/retention` (`{ days: 0-90, confirm: true }`; audited). Owner only; view only (v2 E3, [ADR 0045](adr/0045-tool-review-and-the-tool-call-log.md))                                                                                                                                                                                                                                                                           |
| Audits †    | `GET /audits` (summary, latest run, runs, the catalogue), `GET /audits/findings` (`category`, `code`, `severity`, `page`, `new`, `acknowledged=hide\|only\|include`, `state=open\|gone\|all`, `group=page`, `limit`, `offset`), `GET /audits/findings/:id`, `POST /audits/run`, `POST /audits/findings/:id/acknowledge\|unacknowledge\|propose-fix\|recheck` (`{ confirm: true, project }`; acknowledge also `reason`), `GET /audits/config`, `PUT /audits/config` ‡ (v2 E2, [ADR 0044](adr/0044-audits.md))                                                                                                                                                                                                              |
| Appraisal † | `GET /appraisal` (the full-text index's state and freshness, the non-current areas found, the latest runs; no LegendKeeper request), `POST /appraisal/run` (`{ tool: owner\|impact\|digest\|visual, page?, under?, all?, include?, renameTo?, proposal?, sinceDays?, confirm: true }`; stores the report; no LegendKeeper request), `GET /appraisal/runs/:id`, `POST /appraisal/findings/:id/propose-fix` (`{ confirm: true }`; one live read, then ONE proposal; audited `appraisal.propose_fix`), `POST /appraisal/index/rebuild` (`{ confirm: true }`; from the snapshot store) (v3 F3c, [ADR 0054](adr/0054-arkona-appraisal-tools-and-full-text-search.md))                                                          |
| Packs       | `GET /packs` (every pack as stored: rules, governance sources, approval, drift, attachments, tools, versions; no LegendKeeper request), `GET /packs/:id/governance` (each source read now, drift recorded), `POST /packs/:id/approve` (`{ confirm: true }`) ‡, `PUT /packs/:id/tokens` (`{ race?, culture?, confirm: true }`) ‡ (v3 F3a, [ADR 0050](adr/0050-setting-packs-and-the-arkona-character-tool.md)), `POST /packs/:id/sections` (`{ source, from, to, confirm: true }`: re-maps a pinned heading; a new version) ‡ (ADR 0052 amendment), `PUT /packs/:id/tools` (`{ tools, confirm: true }`: the tool switches; a new version) ‡ (v3 F3.4)                                                                      |
| Review †    | `GET /review` (`state=unreviewed\|reviewed\|all`, `profile`, `tool`, `before`, `limit`; the items, the filter choices, the counts), `GET /review/counts`, `GET /review/:jobId` (with the changes page by page), `POST /review/mark` (`{ ids }`), `POST /review/mark-all` (`{ filter, expect, confirm: true }`; 409 `REVIEW_CHANGED`); Revert: `GET /jobs/:id/revert` (the preview), `POST /jobs/:id/revert` (`{ confirm: true, confirmPartial? }`) ‡ (v3 F3.4, [ADR 0055](adr/0055-write-scope-review-revert-rails.md))                                                                                                                                                                                                   |
| Stream      | `GET /stream` (Server-Sent Events)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Confirmations are part of the contract, not only the UI: raising a scope without `confirmRaise: true` is a `409
CONFIRMATION_REQUIRED`, and every settings and reserve-floor change needs `confirm: true`. `WRITERS_MAX` outside 1–8 is a 400.

### Retrying a step

`retry` on each step says whether it may be retried and whether it is _ambiguous_ (it may already have reached
LegendKeeper). A normal retry re-checks first and cannot duplicate; `force: true` re-runs it as new work. The dashboard
shows the warning and asks twice before forcing.

## Tool calls (v2 E3)

[ADR 0045](adr/0045-tool-review-and-the-tool-call-log.md). **Tool calls** (after Journal in the menu) shows which tools each
assistant actually called, so you can evaluate ChatGPT and Claude without copying transcripts. It is for you only: the
admin API sits behind your session like every other route, and no tool lists or names it for agents.

- **A row per call:** when; the **connection** (named as the Journal names it) and the **profile** with its scope at the time;
  the **tool** and the project the answer named; a short summary of the **arguments**; the **outcome** (Success, Error with its
  code, Proposal captured, Waiting for budget, Queued); how long it took; the **budget** it used.
- **Names and sizes, never content.** An argument shows as `markdown (1204 chars)`, `facts (3 keys)`, `items (12 items)`.
  Its value is shown only for booleans, numbers and a short list of reference arguments (`page`, `mode`, `section`,
  `query`, `status`, `type`, `destination`…): `page=“Asagiri Miyabi”`, `mode=“append_to_section”`, `dryRun=false`. Page
  text, fact values, images (`data_base64`), upload ids, versions and URLs never reach the log. Click a row for its job and
  proposal ids and the size of the answer.
- **What it records that other pages cannot:** calls the MCP layer refuses before any tool runs are in it, with these codes:
  `INVALID_ARGUMENTS` (an assistant inventing arguments), `TOOL_NOT_FOUND` (a tool name that does not exist),
  `READ_ONLY_CONNECTION` (a write from a `read` profile) and `MISSING_SCOPE`. Tool errors carry the tool's own code
  (`VERSION_CONFLICT`, `AMBIGUOUS`, `WORKING_PARENT`, `POLICY_DENIED`…).
- **Budget** is how far the projects' hourly request and write counters moved while the call ran, as `3 req (1 w)`. It is
  approximate: another call in the same moment counts too.
- **Filters:** connection, tool, outcome (including "anything but success", the quickest way to find stumbles), error code or
  status, time (last hour, 24 hours, 3 days, 7 days) and **Writes without a base version** (below). **Newer** and **Older** page
  through 100 at a time.
- **Writes without a base version.** Base versions stay optional, but you can see whether an assistant ever skips them. A call is
  badged **write without a base version**, and found with the filter of that name, when it is a `write_page` with no
  `baseVersion`, or a `set_facts` with no `baseFactsVersion`, that edits an existing page. Exactly which calls count, decided
  when the call is recorded from the names of its arguments (the log keeps no values) and stored with the row:
  - Both tools only ever edit a page that already exists (new pages come from the `create_*` tools), and every `write_page`
    mode changes the page's current document, so no mode is exempt. A `set_facts` counts only when it carries something to
    change: a `facts` or `links` argument with at least one entry.
  - A **dry run** (`dryRun: true`) does not count: it shows a plan and writes nothing. `dryRun: false`, or no `dryRun`, is a real
    write.
  - A version argument that is missing, null or empty counts as no version.
  - A call the MCP layer refused before the tool ran (`INVALID_ARGUMENTS`, `READ_ONLY_CONNECTION`, `MISSING_SCOPE`,
    `TOOL_NOT_FOUND`) edited nothing and is not flagged. A call the tool itself refused (a page not found, say) is still flagged:
    the assistant skipped the version.
  - Rows recorded before this was added (migration 2500) read as not flagged. When any call in the filtered view is flagged, the
    page says how many of the matching calls are. The API: `GET /tool-calls?noBaseVersion=true` returns only those calls; every
    row carries `noBaseVersion`, and the answer a `summary` of `{ matching, noBaseVersion }` for the other filters.
- **Retention:** 7 days by default, a setting on the page (0 to 90 days; **0 switches recording off** and removes what is kept).
  It applies at once and is audited (`policy.set_toolcalls_retention`). Old rows are removed by the log itself, so there is no
  maintenance job to switch on.
- Recording never affects a call: if it fails, the bridge logs it once and the call carries on.

### Evaluation

The **Evaluation** panel (open it on the Tool calls page) makes the manual evaluation in
[docs/reviews/E3-evaluation.md](reviews/E3-evaluation.md) repeatable. The scenarios are data in
[docs/reviews/scenarios.json](reviews/scenarios.json) (the markdown stays the human copy; edit both together). Only you can use
it: the API sits behind your session like every other route, and no agent tool lists, reads or names the log, the scenarios or
the runs. A prompt never names a tool, so the choice of tool is what is tested (a test checks every prompt against the real
tool list).

- **API** (all under `/api/admin`, owner session only, CSRF token and Origin on every POST and PUT like the other routes):
  `GET /evaluation/scenarios`; `GET /evaluation/connections` (`assistant`; each connection with what the classifier made of it);
  `GET /evaluation/runs`; `POST /evaluation/runs` (`{ assistant: "chatgpt"|"claude", set: "core"|"all", principalIds? }`);
  `GET /evaluation/runs/:id`; `POST /evaluation/runs/:id/scenarios/:scenario/start` (`{ principalIds? }`), `…/done` and `…/reset`;
  `PUT /evaluation/runs/:id/scenarios/:scenario/grade` (`{ grade: "right"|"partly"|"wrong"|null, note? }`);
  `POST /evaluation/runs/:id/finish`; `POST /evaluation/runs/:id/delete` (`{ confirm: true }`);
  `GET /evaluation/runs/:id/table` (`{ markdown }`); `GET /evaluation/compare?a=<earlier run>&b=<later run>`.
- **A run.** Choose the **assistant** (ChatGPT or Claude) and the **scenarios**: _Core_ (your shortlist: 1, 4 to 11, 13, 14, 16,
  18, 21, 26, 28 and 29) or _All_ (30). A run keeps its date, the assistant, the set, **the bridge version** it was made on, and
  a result for each scenario. It is _in progress_ until you press **Finish the run**. Delete a run with **Delete** (it asks
  first, and the deletion is audited as `evaluation.delete_run`).
- **For each scenario:** the prompt is shown with a **Copy prompt** button (the preamble is in front of the first prompt of a
  fresh chat; a scenario that continues the previous chat, or has two prompts, says so). Press **Start**, paste the prompt into
  a fresh chat in the assistant, let it finish, then press **Done**. Scenarios that need others first (for example 5 and 9 to 16
  need 6 and 7), need your approval on the Proposals page when run in ChatGPT, or always end in a proposal are labelled.
- **The window.** The bridge does not copy the calls: they are already in the log. Start notes the newest call; Done notes the
  newest again; the scenario's calls are those in between **made by that assistant's connections**. With ChatGPT and Claude
  both connected, only the chosen assistant's calls are counted; calls made before Start or after Done never are. Only one
  scenario of a run records at a time.
- **Which connections.** By default the bridge recognises the assistant's active connections, strongest signal first: the
  OAuth client's redirect host (`chatgpt.com` or `openai.com`; `claude.ai`, `claude.com` or `anthropic.com`: the bridge only
  accepts those hosted callbacks), then the client's name, a token's name, and the profile's name ("ChatGPT", "Claude"). A name
  that matches both assistants decides nothing. A connection made during a scenario is taken in at Done if it is the
  assistant's. If the bridge cannot tell (a token called "laptop", say) it refuses to Start and says so: under **Connections to
  record** choose **Choose the connections myself** and tick them; only those are recorded.
- **Recording must be on.** Start is refused when the retention (above) is 0 days, with a message saying so.
- **Retention.** A run stores its own compact copy of each scenario's calls (the tool, the outcome, the error code, whether
  `get_resource` was called with `live`), so it **survives the log's pruning**. The window (the ids of the calls it spans and the
  connections) is kept too, so the rows can still be looked at in the log while they are kept.
- **The hint, and your grade.** After Done the page shows a hint, never a grade: whether the **expected tools** are present
  (where a scenario accepts either of two, one is enough), whether any **mistake tool** was called (for scenario 1, any
  `lk_api_*` tool; for 14, `create_bare_resource`; for 21, `lk_upload_image` or `prepare_image_upload`), the **error codes seen**
  (`SECTION_NOT_FOUND`, `AMBIGUOUS`, `INVALID_ARGUMENTS`…), the number of calls and any writes without a base version. The hint
  reads _Looks right_, _Check it_, _Looks wrong_ or _No calls recorded_. You confirm **Right**, **Partly** or **Wrong** with one
  click, and may add a note; the bridge never sets the grade for you. Tools merged into another count as the new one when
  grading (`get_resources` as `get_resource`, `bridge_proposals_mine` as `bridge_proposal_status`, `bridge_job_wait` as
  `bridge_job_status`).
- **The results table.** Under the scenarios, a Markdown table of the scenarios you have pressed Done for, with a **Copy the
  results table** button, in the format of your own: columns `#`, `Scenario`, `Assistant`, `Tools called`, `Result`, `Notes`.
  Tools are in the order called, and consecutive repeats collapse to `name ×N` (`guide ×3, search, get_resource (live: false)`; a
  repeat after another tool is listed again). As a display choice only, because your own table writes it so, `get_bridge_guide`
  is shown as `guide`; every other tool keeps its name (`get_markdown_guide` too). `Result` is Right, Partly or Wrong as you
  confirmed it, or _not graded_. `Notes` holds your note, then the error codes seen, then a count of writes without a base
  version.
- **Compare two runs.** **Compare two runs** takes an earlier and a later run (any two, usually of the same assistant). For each
  scenario recorded in either it shows the grade change (`Partly → Right`), the tools added and removed with their counts, the
  number of calls, and the error codes that appeared or went away; above it a summary, for example `SECTION_NOT_FOUND: 6 → 0`,
  the grade counts, and the calls in the scenarios both runs recorded.

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

**Low-level proposals named** (v2 E6, [ADR 0048](adr/0048-chronology-ii.md)). A proposal made by `lk_api_write` or
`lk_api_batch` names what each operation touches, from what the proposal read anyway: the page and the document (the
repository tree), and the entity (an event's name and date, a map feature's type and name, a lane's name, a block's
first words, a property's title, a sidebar row's key and value with its property's title, which costs one more read).
The summary reads `Proposed deleteEvent: event “The Long Winter” (Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102) in
“Fourth Arkonan Age - Timeline” on “Universal Chronology” (chrono01 › efour001)`; **Pages affected** lists the named
entities (up to five per page, the rest counted as before); each operation's card shows the same line. A name that
cannot be found is left out, and the ids stand in for it: naming never blocks a proposal.

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

## Proposals: items and selective approval (v3 F3d (renames))

[ADR 0058](adr/0058-v3-f3d-renames-selective-approval-resume.md), the design's section 2 (decision D5). A proposal made of
**items** (an `arkona_rename`, and every setting-pack package) shows an **Items** card in its review, grouped (Page names,
Identity facts, Resource aliases, Mention labels, Index routing, Chronology, Taxonomy and art, Identity token, Textual
restatements; a package's New pages and Changes to existing pages):

- a **tickbox per item**, ticked as the plan proposes. An item the plan left unticked says why ("Unticked by the plan: it is
  inside quotation marks", "it follows “formerly” in the same sentence", "it is under Unresolved Material", "the row is
  dated before the rename's effective date"). An AU page's item is labelled **AU**;
- its **change** (before → after, the sentence around a restatement, each fact of a page), and what it **needs**;
- **Tick all / Untick all** per group;
- unticking an item that others need **leaves them out too**, and the card says which, with what they need, **before** you
  confirm; the count ("12 of 41 items will be approved") follows your ticks.

**Approve selected** (or **Approve selected and accept as canon** for a canonical proposal, which every rename is) sends
exactly that selection, through the same confirmation as the whole: the dialog repeats what is approved, what is left out
and which items were left out because they need an unticked one. Nothing is written for a left-out item; a selection the
server finds not closed is refused (`SELECTION_NOT_CLOSED`) and the proposal stays pending. Approving with everything as
the plan ticked it is the ordinary Approve; for a package that is every item, as before. The audit records
`proposal.approve_selected` (or `…_as_canon`) with the items approved and left out.

Once decided, the card says how many were approved and left out, lists what was left out, and offers **Propose these
again**: one new proposal of exactly those items (planned as they were, every target read again), shown as "Proposed
again as prop_…"; the new proposal names the one it came from. Agents can never approve.

## Jobs and Review: Resume (v3 F3d (renames))

The design's section 3 (decision D6). A package, a rename or a recreate whose job **stopped part-way** (a failed step, a
cancel) shows a **Stopped part-way** card on its job page (and in the Review page's detail of a direct job): the step it
stopped at and why, its last verified step (every step up to it succeeded and read back as planned), and how often it was
resumed. **Resume** (after a confirmation that says from which step it continues and how many are left) continues the
same job: its own check runs again first, inside its locks; no step that succeeded is sent again, no page or document is
made twice, and a step that is no longer safe is refused with its reason (the card shows it; resume again once the page
is as it should be, or revert). Work you approved resumes without a new approval; every resume is audited (`job.resume`,
with where it stopped and who approved the work). A recreate is finished as before (F2's Finish: a new proposal of what
is still missing). Revert (Review page, ADR 0055) stays the other way out for a direct job: it undoes the completed steps.

## Splits (v3 F3e)

[ADR 0059](adr/0059-v3-f3e-splits.md); the owner-approved design: [design/F3e-splits.md](design/F3e-splits.md).

- **Packs**: the new pack version `arkona-2026-11-18-f3e` (its split rules) waits for your approval like any other; until
  then neither split tool computes anything.
- **Appraisal**: the tool list has **Split appraisal (A6)**. On a page or a branch it shows the Split Triggers that fire,
  each with its evidence, the page's **draft destination map** (each section, its domain and where it might go), its
  **Anti-Fragmentation note** (what should stay together) and the **questions** the bridge cannot measure (Independent
  Retrieval, Independent Maintenance, Downstream Dependency). Owner appraisal (A2) lists the same candidates in its
  Architectural candidates group. Free, and only ever a suggestion.
- **Proposals**: a split is ONE canonical proposal (**Approve and accept as canon**, whatever the agent's scope). Its Items
  card has a group per kind (Destinations, Universal material, Character index, Changes to existing pages, Index lines,
  Dependencies). Each destination says what **leaving it out** means ("If left out, “Appearance” stays in [BSRC] … (nothing
  is lost)"), on the item when you untick it and again in the confirmation, before you approve; coverage holds whatever
  you untick. Phase 2 (archiving the source, for a split that retires it) is a SEPARATE canonical proposal the bridge makes
  only once phase 1 has verified and nothing was left out or skipped: an ordinary `archive_page` proposal. The split never
  deletes.
- **Jobs**: a stopped phase 1 shows the **Stopped part-way** card (Resume, as for a package). Its job page offers
  **Revert…** although you approved it: the confirmation lists what will be put back and says that the pages the split made
  then go to ONE deletion proposal (each only while it is exactly as the split made it). When nothing had left the source
  yet, Revert only proposes deleting those pages.

## Archive and lifecycle (v2 C2c)

The **Archive and lifecycle** page (navigation: Repository) lists the selected project's lifecycle record,
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
to confirm). **Save** asks for a confirmation and, since C2d (ADR 0036 decision 4), for the step-up (ADR 0062: the
authenticator code, or the password without one) if the owner has not given it in the last 10 minutes; **Restore the
defaults** brings back the owner's
values and clears the confirmation (the same re-authentication applies). Every change is audited as
`project.set_lifecycle` with the values before and after.

**Indexes whose pages are Authoritative without CANON** (E5.3, ADR 0046 decision 13): a list of index ids, one per line,
empty by default, saved with its own **Save** (the same confirmation and re-authentication). Every page beneath a listed
index, at any depth, stays `[BSRC]` and Authoritative but carries no `CANON` tag (Arkona's `[INDEX] Design References`);
pages inside the Working and Archived areas keep their own rules. The lifecycle tools and Authoritative creates add no
`CANON` there, and the lifecycle audit expects none. An id that is not an index in the tree, or is a lifecycle index, is
refused.

## Chronology (v2 D1)

The **Chronology** page (navigation: Repository; ADR 0038) has four cards for the selected
project.

- **Settings.** Whether the chronology is confirmed (and if not, why: `CHRONOLOGY_NOT_CONFIGURED` or
  `CHRONOLOGY_CHANGED`, with what to do), the confirmed settings (the chronology page, its calendar, its Main document,
  and per age its table, its timeline, that timeline's lane and its Main row), and what a lookup by name finds in the
  repository tree now (free). **Read the chronology** reads the calendar, the Main table, every age table and every age
  timeline's lanes (about three requests per age) and shows what it found: each age with its era, rows and count, any
  problem, and **how the tables write** dates and KCY values (each aspect's value, how many rows showed each way, up to
  three examples, and the aspects written more than one way). The style can be edited before **Confirm these settings**
  (asks for a confirmation and, since CR-2026-11-R4, the step-up: they are a project's settings, which the timeline
  tools write by). **Clear the chronology settings** removes them (the tools refuse again; one click, a tightening).
  Every change is audited as `project.set_chronology`. Until confirmed, the timeline tools refuse. The table is the
  authority; the timeline is a derived view.
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
  Since the hotfix of 15 November 2026 a **Count mismatch** has the button too, when the Main table has a row for that
  age: it re-reads the Main table and the age table and makes ONE proposal setting that age's **Event count** cell to the
  table's row count (in the Main table's writing style; every other cell untouched). Its summary shows both figures, for
  example `Fourth Arkonan Age: Main 337 → 336 (table rows 336; timeline events 335)`. A Main document changed before you
  approve, or a row added to or removed from the table, makes it conflict, and nothing is written; a count that already
  matches says "nothing to fix"; a Main table with no row for the age has no fix (add the row by hand).
- **Chronology II** (v2 E6, [ADR 0048](adr/0048-chronology-ii.md)).
  - **Qualified dates** (`c. 4A 563; exact date unresolved`, `After Isar 6th and before Zarzakh 29th, 4A 610; …`) are
    read by their anchor and never rewritten (the forms: [chronology.md](chronology.md)). A row read that way shows
    **Read as …** (`year 4A 563, approximate`, `before 4A 623 (an open start)`) on its finding, and its **Propose a
    fix** makes its event. A date that stays unreadable is reported once, as **Date the engine cannot read**, with why
    (a relative offset, an ambiguous bound, …); it is no longer also a row without an event.
  - **Ages**, below the findings: each age's rows, events and Main count; its dates (how many were read by their
    anchor, how many stay unreadable, how many are table-only, and any table-only mark that no longer holds); and how
    its rows and events were **paired** (by the bridge's link, by date and name, by date alone, or, for a row and an
    event that disagree, by the same start and end, the same start and shape, the name, or the same start), with
    **Every pair** on request. A date mismatch says how it was paired.
  - A date mismatch whose fix would turn a range into a single day (or the reverse) carries a warning (**A fix would
    change the event: range → single day**); its **Propose a fix** asks for a confirmation that names the change, and
    the proposal's summary says it too. Without the confirmation nothing is proposed (`SHAPE_CHANGE_UNCONFIRMED`).
  - An **Event without a row** has **Propose deleting the event**, and its finding lists the three rows nearest it by
    date with their opening words, so you can see what replaced it. The proposal deletes only the event (no row, no
    count change; journalled with the event); it is refused when the event has a row after all, or an unpaired row
    could be its own.
  - **Ties** (v3 F2.1, [chronology.md](chronology.md#ties-v3-f21)). An **Event in a tie** (rows of the table could be its
    own) lists its candidate rows (date and opening words), each with **Pair with this row**; it is never offered for
    deletion. A **Propose a fix** refused because several events could be a row's own shows each candidate (name, date,
    id) with **Use this event**, and one **Make a new event** button. Each makes one proposal; an event that already
    agrees is linked to the row (no LegendKeeper write). A pair made because the plain row of a day beats the qualified
    rows anchored on it says **plain row preferred over qualified anchor**.
  - **Table-only** on a row's finding (a row without an event, or an unreadable date) marks a row you never want on the
    timeline (asks for a confirmation; audited `chronology.table_only`). The check stops reporting it while its text is
    unchanged; if the row changes, it comes back. The **Table-only rows** card lists the marks (age, date, row,
    reason, who and when, and any that no longer holds) with **Clear the mark**. The Main count stays the table's row
    count, table-only rows included.
- **Changes.** The record of every chronology change, newest first: the tool and summary, the ages, the writes, who made
  it (and who approved it), its state (**complete**, **incomplete**, **resolved**) and its jobs linked to the Journal
  page. A change that stopped part-way is finished by the same request again; **Mark resolved** (asks for a
  confirmation; audited `chronology.resolve`) is for one fixed by hand, after which other changes of its ages go ahead.

Admin API: `GET /projects/:name/chronology`, `POST /projects/:name/chronology/lookup`, `PUT /projects/:name/chronology`
(`{ confirm: true, settings }`, which needs the step-up, or `{ confirm: true, reset: true }`, which does not), `GET /chronology/records`, `POST
/chronology/records/:id/resolve`, `GET /chronology/check`, `POST /chronology/check` (`{ confirm: true, project }`), `POST /chronology/propose-fix`
(`{ confirm: true, project, age, rowId, confirmShapeChange? }`, `{ …, kind: 'count' }` or `{ …, kind: 'orphan', eventId }`:
one proposal, or `nothing_to_do`), `GET /chronology/table-only` and `POST /chronology/table-only`
(`{ confirm: true, project, age, rowId, tableOnly, reason? }`).

## Staging (v2 D3)

The **Staging** page (navigation: Assets; [ADR 0041](adr/0041-image-pipeline.md)) shows the selected
project's staged images: uploaded, converted to WebP, checked, and hidden in the project's staging folder
(`imageStagingFolder`, default `LK-Bridge staging`), not yet placed.

- **Upload.** Choose image files or drag them onto the box. Each goes to the bridge as it is (the raw body, with the
  session's CSRF token) and through exactly the pipeline and limits of `upload_image`: the type from its first bytes,
  `UPLOAD_MAX_BYTES`, the pixel and frame limits, one conversion at a time, deduplication by the original's hash. Each
  answer shows its **staged id** (with a copy button). This is the practical route for images you have in hand: a chat
  assistant cannot pass a multi-megabyte image in a tool call. Then tell an agent “place staged image img_… for Asagiri
  Miyabi”, or place it here.
- **The list**: a thumbnail (the asset's own URL; the dashboard's CSP allows images from `https://assets.legendkeeper.com`
  and `https://assets2.legendkeeper.com` (E5.2) and nothing else from outside), name and staged id, dimensions, frames and sizes (WebP and original), whether the
  stored bytes were verified, who staged it (an agent, or “Owner (dashboard)”), when, and the intended destination if
  one was given. Images older than `IMAGE_STAGING_REPORT_DAYS` (30) are counted at the top and marked **old**: they are
  reported, never removed. **The list updates by itself** (v2 D3.1, 12 November 2026): the page listens for the stream's
  `staging` event, sent by the image service whenever a staged image is created, finishes uploading or verifying, is
  placed, discarded or fails, by whatever route (an agent's `upload_image` with `stage: true`, any upload at `propose`
  scope, an approved proposal placing one, a job ending, the binary endpoint, this page). Its data is `{ projectId, stagedId, change, name, state, source, staged, old }`, the last two the counts after the change; other projects' events
  are ignored and a burst costs one reload. There is no count on the navigation yet; the event carries the counts for one.
- **Place**: a character (name and race, the rules of `create_character`), a folder (path or id) or a page; empty fields
  place it at the intended destination. Optionally a new name. One job moves it, unhides it, renames it and reads it back.
  - **Subfolder (v2 D3.2)**: a character or a page also takes a **Subfolder**, written like the folder chain: `Wardrobe`, or
    `Wardrobe / Qipao` (Qipao inside Wardrobe). The bridge splits it on `/`, trims each part and refuses an empty part, `.`
    and `..` with a message that says how to write it; the result is the destination's `subfolders` list, so the folder rules
    are the same as ever: folders that exist are reused, missing ones are created in order, and a non-folder with the same name
    is a conflict (`ASSET_NAME_CONFLICT`). The field needs the character or page first, and a folder path has none (it already
    says where). The upload box has no destination of its own: an uploaded image is staged in the staging folder, and is placed
    here or by an agent.
  - **Where it will land**: as you type, the form asks the bridge for a dry run (`POST /staging/preview`, nothing is written)
    and shows the full resolved path with the new folders marked and counted, for example `Characters / Beastkin / Qishen /
Mehrana al-Khalid / Wardrobe / Qipao (2 new folders)`, or the reason it would be refused (a bad path, an ambiguous
    folder, a conflict). It is worked out the same way placing works it out.
- **Discard**: deletes the asset after a confirmation. Its bytes are kept by the bridge first (90 days), as for every
  asset delete.
- **Bytes kept before deletes**: how many files the bridge keeps, and **Allow one delete** for an asset whose file
  cannot be downloaded (so its delete is refused, `ASSET_BYTES_NOT_KEPT`): asks for your password again, then lets that
  one delete go ahead within an hour. It cannot be restored afterwards.

API: `GET /api/admin/staging`, `POST /api/admin/staging/upload?name=…` (`application/octet-stream`), `POST
/api/admin/staging/preview` `{ destination? | stagedId? }` (the dry run: `path`, `segments` with `new`, `newFolders`; a bad path is
400 `INVALID_SUBFOLDER`), `POST
/api/admin/staging/<staged id>/place` `{ destination?, name? }`, `POST /api/admin/staging/<staged id>/discard`
`{ confirm: true }`, `POST /api/admin/staging/allow-delete` `{ assetId, confirm: true }` (re-authenticated); all with
`?project=`. Audited as `staging.upload`, `staging.place`, `staging.discard` and `asset.delete_without_bytes`.

## Snapshots (v2 E1a)

The **Snapshots** page (navigation: Backups & Recovery; [ADR 0042](adr/0042-snapshots-restore-rehearsal.md)) shows
the bridge's own copies of the selected project's pages.

- **The store**: its size on disk (pieces and manifests), the **deduplication** ratio (what the snapshots hold over what
  the store keeps once) and the compression, the disk's **free space** against the minimum (`SNAPSHOT_MIN_FREE_GB`, 10 GB),
  the **next full snapshot's estimate** against the headroom (marked "fits" or "does not fit"), the **retention** ("every full
  snapshot for 30 days, then one a week (the latest of each ISO week) for 8 weeks; change snapshots for 30 days"), and the
  directory. Below the minimum, full snapshots are refused, and the refusal is a notice here.
- **Findings**: stored pieces the weekly verify found missing or damaged, and the snapshots they make **partial**; and the
  notices (a refused run, an adopted kept-bytes directory).
- **Runs and schedules**: the three snapshot jobs (the full snapshot is **nightly, 00:30 London time**) with their
  schedule, next and last run (schedules are changed on the Maintenance Jobs page). There is **no switch for a daily
  changed-pages pass**: LegendKeeper's `updatedAt` does not track content, so the nightly full snapshot is what catches
  edits made in the app (an unchanged image is not downloaded again, so a night adds only what changed). The runs (pages done of the total, requests, new pieces, time), with **Abandon** for a run that should not be
  continued. **Take a full snapshot now** starts one in the background.
- **Page history**: find a page by name (a deleted one too); its snapshots, newest first, piece by piece (first seen,
  changed, unchanged, deleted, back); **Diff with now** for any piece (a few reads); **Propose a restore** from any
  snapshot: the page's documents, its sidebar, one document, or a deleted page (undelete, or recreate with its original
  or new ids). **Preview** shows the plan (each piece's diff, what cannot be restored exactly, what is left alone, new ids,
  and since v2 E5.5 how long it should take once approved, with the figures used) without proposing; **Propose this restore** makes the proposal, linked to the Proposals page. A restore is always a
  proposal, the owner's own included. A restore that finishes with a field LegendKeeper refused (an icon name it does not
  know: the write is sent again without it) shows **couldn't be restored exactly** beside its state, with each field
  listed.
- **Restore a deleted image**: a snapshot and the image's old asset id; the preview lists the pages that showed the old
  URL and where the image goes back (its folder and name, and any folder made on the way); tick **Also update the pages
  that referred to the old URL** to include them; **Propose it** makes the proposal. Since v3 F3c
  ([ADR 0051](adr/0051-v3-f3c-major-revisions-same-day-ties-and-image-restore.md)) nothing is sent to LegendKeeper until
  it is approved: the image waits on the bridge's server, then one job uploads it into its folder and updates the pages
  (it comes back as a new asset with a new URL). A page edited meanwhile is left for a hand relink, and the restore's row
  says so (`image_relink_failed`).
- **Restore rehearsal**: a full snapshot of this project, a sandbox project to rehearse into (never this one), sampled
  (about 50 pages) or every page, and whether to keep the copy. The picker starts on the **newest complete** full snapshot
  and marks a partial one **(partial)** (v2 E5.4). A sample copies at most 25 events of each timeline (with the lanes they
  use) and 40 features of each map (with their folders, and a region and a path if there are any); the estimate lists what
  it leaves out. **Estimate** first (pages, images, reads, writes and the time at background priority, paced as the
  governor will pace it: about a second a write and under half a second a read at the default limits), then **Start the
  rehearsal** after a confirmation. Since v2 E5.5 the estimate says **which figures it used**: the time per write (the
  median of the test world's last 200 write steps, or the configured spacing when that is longer), the write tier's
  limit and the run's share of it, and any learned operation limit that paces the image steps (for example "the assets
  group's learned limit of 20 a minute paces its 8 steps"). The list shows each rehearsal's state, and while one runs,
  its **progress against the plan**: the stage, writes and reads done of those planned, the time elapsed (with the
  estimate) and a projected finish (from the share of the planned work done; before 2% of it, the start plus the
  estimate). It shows the results once done: pages restored exactly, the differences with their reasons, what a restore
  cannot bring back, the cost and the time; **Delete its root** for a kept copy.
- **Snapshots**: every snapshot (taken, kind and the tool that made a change snapshot, pages, new pieces and bytes,
  requests), complete or **partial** with why.
- **Database copies**: the nightly and pre-deploy copies of the database (`deploy/backup.sh`, in `BACKUP_DIR`, default
  `backups/` next to the database) with their time, age and size; a warning when the newest nightly copy is more than 36
  hours old.

The **Proposals** page shows a restore proposal with its snapshot, the diff (now, then as at the snapshot), and what it
cannot restore, keeps or leaves alone; an image restore with its new asset and the pages it updates.

API: `GET /api/admin/snapshots?project=&kind=&limit=` (the overview, snapshots, restores, rehearsals, sandboxes, jobs and
database copies), `GET /api/admin/snapshots/pages?project=&q=`, `GET /api/admin/snapshots/pages/<page id>?project=&piece=&ref=`,
`GET /api/admin/snapshots/diff?project=&page=&piece=&ref=&from=&to=`, `POST /api/admin/snapshots/full?project=` (202),
`POST /api/admin/snapshots/runs/<run id>/abandon` `{ confirm: true }`, `POST /api/admin/snapshots/restore?project=`
`{ page, snapshot, scope, document?, mode?, ids?, parent?, dryRun? }`, `POST /api/admin/snapshots/restore-image?project=`
`{ snapshot, asset, updateReferences?, dryRun? }`, `POST /api/admin/snapshots/rehearsals/plan` `{ target, snapshot, mode,
max? }`, `POST /api/admin/snapshots/rehearsals` `{ target, snapshot, mode, keep?, max?, confirm: true }` (202), `GET
/api/admin/snapshots/rehearsals/<id>`, `POST /api/admin/snapshots/rehearsals/<id>/delete-root` `{ confirm: true }`. A
refusal is a 409 with its code. Audited as `snapshots.full`, `snapshots.abandon`, `snapshots.restore`,
`snapshots.rehearsal` and `snapshots.rehearsal_delete_root`.

## Audits (v2 E2)

The **Audits** page (navigation: Quality; [ADR 0044](adr/0044-audits.md)) shows what the audits found in
the newest full snapshot and the change snapshots since. **Findings only: nothing on this page changes your world.** An audit
reads the snapshot store and the bridge's own database, never LegendKeeper, so it costs no request; one runs by itself after
each nightly full snapshot completes, and **Run an audit now** runs one at once.

- **Latest audit**: when it ran, how long it took, the snapshot it read and how old that snapshot was (and how many change
  snapshots were laid over it), the page count, the result. A snapshot older than the limit (36 hours by default) is flagged
  **stale**, with a note that edits made in the LegendKeeper app since are not seen until the next full snapshot.
- **Summary**: open findings by category and severity, with the counts of new, acknowledged and resolved findings. A
  category's name filters the list below.
- **Findings**: filters for category, code, severity, page path (part of a path or name), **new in the latest audit**,
  **acknowledged** (hidden by default, shown, or only) and **resolved** (open, resolved, or both); **Group by page**; paged
  by 100. Each finding shows its severity, what it is and says, its page with a **history** link to that page's snapshot history
  (the Snapshots page), and when it was first seen (or when it was resolved). **Evidence** opens the evidence (what was
  expected and what was found), the source (the snapshot, or the chronology check, and how old it was when audited), the
  document and block, and the fix on offer.
  - **Acknowledge…** asks for a reason (required). The finding is hidden while the same evidence persists, and comes back,
    marked "evidence changed", if the evidence changes. **Un-acknowledge** shows it again. Nothing is acknowledged for you.
  - **Propose a fix**, where one exists: re-reads the page live, then makes ONE ordinary proposal, which you approve on the
    [Proposals](#proposals-page-writes-v2-c1) page (every guard runs as for any write; nothing is applied by the audit). The
    fixes are a paragraph split (one paragraph with line breaks into separate paragraphs, block by block, beside inline icons
    too), `set_facts` for a Reference Type or Subject only where the right value is unambiguous, `move_resource` to re-place a
    page alphabetically under the same parent, adding a missing required tag (never removing one), and the chronology's
    `sync_timeline_event`. If the page has changed since the audit, it says so and proposes nothing.
  - **Re-check now**: reads the finding's page live (a few requests) and runs its check again; the finding is still there (its
    source becomes "read live") or gone. Findings about more than one page cannot be re-checked, nor can governance findings
    (the next run checks them).
  - **Allow this name** (v3 F4a, [ADR 0063](adr/0063-v3-f4a-governance-drift-names-and-briefs.md)), on a governance
    finding naming an external skill (`governance_external_name`): after a confirmation, the name joins the allowed names
    in the audit settings and is never reported again (its findings go at once). Audited (`audits.allow_name`). Remove a
    name from the settings' list to have it reported again.
  - Lifecycle findings are **never fixed by an audit**: the lifecycle tools refuse an inconsistent page and you decide.
- **Runs**: each audit with its trigger (`snapshot`, `manual`, `schedule`), state, duration, snapshot and result.
- **Rules and settings**: the rules editor, the tag-definition source and the audit settings. A rule selects pages (a
  Reference Type, a registry type and role, a name prefix, an ancestor's name, a kind; all the given selectors must match) and
  names a template (a registry role, a name or an id). Until you save a list the rules are the **seeded defaults from the
  registry** (Character Core, Compact Character Reference, the Index template). The tag-definition source is a page (found by
  name) and one of its documents. Settings: report pages no rule matches, the stale limit, how strictly Reference Types are
  judged, the Reference Types that are fine, indexes in a manual order, and (v3 F4a) the external skills the governance
  check never reports. **Saving asks you to sign in again** (within five
  minutes, as the canon rules do) and is audited (`audits.set_config`).

**The Governance category** (v3 F4a) compares the governance pages (every tab of the AI REPOSITORY root the pack's
governance sources sit on) with the bridge: a tool name the bridge does not have or an old bridge call
(`governance_unknown_tool`, a warning), an external skill name (`governance_external_name`), and a page, tab or standard
named in a Startup, Related Guidance, Source Boundaries or Dependencies section that resolves to nothing, read
generously: a page's subject without its prefixes and generic word, a tab, an alias or a tag, in any area
(`governance_missing_reference`; a near miss, such as "LK Bootstrap" for the "AI Bootstrap" tab, names the closest
match). Each finding suggests a replacement (the pack's equivalence map's, or a near miss's closest match), to copy into
the page by hand; **no fix is ever proposed**: governance edits are yours. It runs once the pack version
`arkona-2026-11-19-f4a` is approved.

Audited: `audits.set_config`, `audits.acknowledge`, `audits.unacknowledge`, `audits.propose_fix`, `audits.recheck`,
`audits.allow_name`. The audits' maintenance job `audit-run` (off by default) is on the Maintenance Jobs page.

## Appraisal (v3 F3c)

The **Appraisal** page (navigation: Quality; [ADR 0054](adr/0054-arkona-appraisal-tools-and-full-text-search.md)) runs
the Arkona pack's four appraisal reports on a page or a branch and shows what they found. **Reports only: running one
changes nothing.** A report reads the bridge's snapshot overlay (the nightly full snapshot plus the change snapshots
since), the audits' findings, the asset tree and the bridge's own database, never LegendKeeper, so it costs no request;
the report is kept in the bridge's database (the latest run of each tool and scope), never written to LegendKeeper.
Shown for a project the Arkona pack is attached to (otherwise the page says the pack is not attached and **Run** is
off).

- **Full-text index**: the full snapshot it was built from and how many change snapshots were laid over it since, its
  age, the pages, text units and references it holds, its size, how long it took to build and to take the last change
  snapshot, and which non-current areas were found (the Legacy Canon Archive and the Design References, each by its
  index's name, or "not found"). It is built after each nightly full snapshot and brought up to date at every search
  and report; **Rebuild the index now** builds it again from the snapshot store (free).
- **Run**: the tool (Owner appraisal (A2), Change impact (A3), Working digest (A4), Visual hygiene (A5), Split appraisal
  (A6, v3 F3e: [below](#splits-v3-f3e))), the scope (a
  page, a branch or everything; a page name, a path or an id), and each tool's own fields: the non-current areas to
  include (A2), a planned new name or a pending proposal (A3), a window in days (A4).
- **The report**: what it inspected, how fresh its data was, what it could not check, and its findings in their groups
  (A2: Required defects, Optional polish, Architectural candidates, Blocked cases; A3: Proven breakage, Review
  candidates; A4: Working pages, Open proposals, Approved but not promoted, Declared contradictions; A5: Candidates).
  Each finding shows its evidence class, the rule it comes from (governance page and section), its message, and its
  page as a **link to that page in LegendKeeper** (a new tab). Long reports are paged.
  - **Propose a fix** appears **only** where the finding has a deterministic repair (an em dash, decorative blank
    paragraphs, a link in a heading, an asset name with an extension, a Working or Archived page in an Authoritative
    page's Related Sources; sibling order and tags go to the audits' own fix). It asks first, then re-reads the page live
    (one request), checks the finding still holds, and makes ONE ordinary proposal, which you approve on the
    [Proposals](#proposals-page-writes-v2-c1) page; Last Major Revision follows the owner's rule (a dash or a blank
    paragraph is not a major revision). If the page changed since the report, it says so and proposes nothing.
  - A **judgement** finding shows what has to be decided and the tool for it ("Judgement: write a Purpose section first
    (write_page)"); it never offers a button. A report-only finding says why.
- **Latest runs**: each tool's latest run per scope (tool, scope, when, findings, how long it took); opening one shows its
  stored report, which says what changed since the run of that scope before it (new, still present, gone).

Audited: `appraisal.propose_fix`. The page's link to LegendKeeper uses one URL pattern, `LK_PAGE_URL` in
`ui/src/pages/appraisal.tsx`: check it opens the page after deploying.

## The block-id sweep (v3 F3.5)

[ADR 0056](adr/0056-block-id-sweep.md), [maintenance.md](maintenance.md#the-block-id-sweep-v3-f35). Below the Maintenance
Jobs table, the card **Assign block IDs sweep: an approved narrow automation**:

- **Stopped** (in red, only after a verification failure): the page, the project, the document, the first differences,
  and **Restore from journal**: the journal entry that holds the whole document as it was before the call (with links to
  the Journal page for the sweep's job and to the job), and the night's full snapshot. Enabling the job again
  acknowledges the stop (it stays listed, no longer red).
- **What enabling it approves**: the six points of the approved-automation statement (scope, prerequisites,
  transformation, verification, concurrency, stop conditions), word for word as in the ADR.
- **Prerequisite: the sandbox check**: PASS recorded for this bridge version (and when), or "no PASS"; the latest
  verdicts of any version; and the **Override** box (enable without a sandbox PASS: ticking it asks for your password;
  audited `blockids.override`). Without either, the job's toggle is refused (`PREREQUISITE_MISSING`, shown as a toast).
- **Candidates (from the latest snapshot)**, one row per served project: when the snapshot was taken, the candidates,
  those still to do, and the documents done, edited since the read (retried) and unverified.
- **At most N documents a run** (1 to 500, default 20; audited `blockids.max_per_run`).
- **Dry run** (for the selected project): the documents the next run would work on, in order, with their counts (blocks
  without an id, ids used twice, `unsupported` blocks), and the estimated reads, writes and time at P3. It reads only the
  snapshot store and writes nothing.

The sweep's jobs are the system's: they are on the Jobs page (origin `maintenance`), never on the Review page.

## Off-site copy (v2 E1b)

The **Off-site copy** page (navigation: Backups & Recovery; [ADR 0043](adr/0043-google-drive-offsite-copy.md), the one-off
Google set-up in [drive-setup.md](drive-setup.md)) sets up and watches the encrypted copy of the snapshot store and the
nightly database copies on Google Drive. The copy is made by a separate service on the server
(`lk-bridge-offsite.service`, with rclone); the page writes its requests and shows what it recorded, refreshing itself
every few seconds while a run is going.

- **Google Drive**: the connection's state (**Connected**, **Needs reconnecting** in red with the reason, or **Not
  connected**), the Google account's name and email (from Drive's `about.get`), the **redirect URI** to register at Google
  (with a copy button), and the saved client (its ID, and the secret's last four characters only). **Save the client**
  (Client ID and Client secret, kept in the encrypted secret store, never in the env file), **Connect Google Drive** /
  **Reconnect** (Google's sign-in, then back to this page), **Check the connection** (one token refresh now) and
  **Disconnect** (revokes the access at Google and deletes the saved sign-in; the files on Drive stay).
- **Encryption keys**: whether they are set, when, and how (generated or entered); never the keys. **Generate keys** shows
  a password and a salt **once**, with the warning that without them the Drive copy cannot be restored; they are saved
  only after you type their last 6 characters. **Enter my own** takes your own (at least 16 characters each, typed
  twice). When a copy already exists, changing them warns first: the next copy is a fresh full upload into a new folder.
- **Copies**: the last copy (when, trigger, size, files, duration, result, rclone's exit code and version, and why it
  failed), the last good copy, the **next scheduled copy**, and **Copy now**.
- **Verify**: the last verify's result and its **findings** (missing or corrupt pieces, an unreadable manifest, a bad or
  missing database copy, in red), the history, the next monthly verify, and **Verify now** (after a first copy).
- **Drive folder**: where the copy is (`LK-Bridge backups/<server>/copy-<n>`), old folders kept after a key or folder
  change with **Delete** (to Drive's bin), and **Use this folder** when a copy was refused because the folder holds a copy
  this database did not make.
- **Settings**: the folder, the daily copy's time (London), how long removed pieces stay in `deleted/` (30 days), the
  bandwidth limit, parallel transfers, the monthly verify (on or off, day, time, sample percentage and minimum), and the
  Overview's staleness warning (2 days).
- **Runs**: every copy, verify and folder deletion.
- Links to [drive-setup.md](drive-setup.md) and the runbook's [disaster recovery](runbook-deploy.md#disaster-recovery-from-google-drive).

Saving the client, connecting, disconnecting, setting keys, changing the settings, deleting an old folder and using an
existing folder ask for the step-up (ADR 0062) if you have not given it in the last ten minutes. Every action is audited
(`offsite.*`), never with a value.

The **Overview** shows a red card when the connection is broken, when no good copy is younger than the staleness
setting, or when the last verify found problems; amber for a failed copy or an unfinished set-up; and a short note while
the copy is not set up at all.

**Admin API** (owner session, Origin and CSRF as everywhere): `GET /api/admin/offsite`; `PUT /offsite/client`,
`POST /offsite/connect`, `POST /offsite/disconnect`, `POST /offsite/check`; `POST /offsite/keys/generate`,
`POST /offsite/keys/confirm`, `PUT /offsite/keys`; `PUT /offsite/settings`; `POST /offsite/copy`, `POST /offsite/verify`;
`POST /offsite/folders/:generation/delete`, `POST /offsite/adopt`. Google's answer arrives at `GET /admin/drive/callback`
(outside `/api/admin`, because it is a navigation from Google), which redirects to `/ui/offsite`.

v2 E4 ([ADR 0046](adr/0046-e4-owner-decisions.md) decision 3): `PUT /offsite/settings` needed the re-authentication when
the change weakened a protection (the verify switched off, a smaller verify sample, a later stale-copy warning, fewer
days for removed pieces on Drive, another folder); since ADR 0062 every change of these settings needs the step-up,
times, bandwidth and transfers included, as does enabling a job. Switching off a maintenance job that keeps the backups
(`POST /maintenance/:id/disable` for `snapshot-*` and `offsite*`) needs it too; other jobs switch off in one click.

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
dashboard's step-up (ADR 0062: the authenticator code, or the password without one) unless given in the last 10 minutes:
switching a rule off and removing every rule count as saving too. **Restore the defaults** brings back the seeded rules.
C2d adds a rule, on by default: **Status tags (CANON, Working, Archived)**: added or removed only by the lifecycle tools
and by creates according to their status (ADR 0036 decision 7); switching it off frees them. Every save is audited as `project.set_canonical_rules` with the rules before and after. With no rule at
all the section warns that agents with scope "write" can change any fact. Changes apply to the next write; nothing
needs a restart.

## Stream

`GET /api/admin/stream` carries the engine's events (`job`, `step`, `lock`, `writers`, `error`, `controls`), the policy
layer's (`policy`, `proposal`), the image service's (`staging`: a staged image was created, finished uploading, was placed, discarded or failed; v2 D3.1), the governor's (`throttled`, `budget-wait`), the registry's (`project`: a project's
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

## Request Budgets: learned operation limits (v2 E5.5)

LegendKeeper's asset routes have rate limits of their own that its spec does not list (about 20 a minute for asset
folders and image uploads, about 60 for asset deletes), and it reports them when they have the fewest requests left.
The bridge learns such a limit for the operation's group and paces only that group by it, never every write
([ADR 0047](adr/0047-learned-operation-limits.md)). The **Learned operation limits** card on the Request Budgets page
lists them for the selected project:

- **Group**: `assets` for the asset routes (folders, uploads, image assets, updates, deletes), or an operation's own id;
  **refused for N s** while LegendKeeper is refusing the group (a 429), which blocks only that group;
- **Operations seen**: the operations the limit was reported on;
- **Limit** and **Window** (inferred from LegendKeeper's reset: up to a minute, up to an hour, or a day);
- **Remaining**: the bridge's count against it, snapped to LegendKeeper's at every report;
- **Last seen**, and **Expires**: a learned limit is forgotten once its window has passed twice without LegendKeeper
  reporting it again. A restart forgets them too; they are learned again at the next report.

"None learned" means LegendKeeper has reported only its documented limits. The documented tiers' gauges are unaffected
by a learned limit: the test world's writes read 120 a minute. The All projects view lists each project's learned limits
in a line. The budget footer agents see is unchanged, apart from `| blocked <group> <s>s` while a group is refused, and
the bridge logs the first sighting of each group and limit once (an info line naming the project, the operation and the
figures).

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
- `test/admin/packs.test.ts` and `test/ui/packs.test.tsx` (v3 F3a): the Packs page's routes (listed as stored, the
  governance read on request, approve and token maps refused without a fresh re-authentication, audited, drift and
  re-approval) and the page (navigation, state, sources, projects, rules, the drift alert, the two confirmations).
  Since the ADR 0052 amendment: a missing pinned heading refused with the page's outline, the re-map refused without a
  fresh re-authentication, audited old → new, and the new version approved; on the page, the picker (headings in order
  with levels, a pinned one disabled), its confirmation, the password, and the choice sent.

## v3 F2 (ADR 0049)

- **Projects**: **Make default** on each project row (a fresh re-authentication; audited `project.make_default`), and the
  note "The env file's `LK_DEFAULT_PROJECT=…` overrides this; remove that line to use the dashboard's choice." while the
  env file disagrees. The settings list gains the Last Major Revision switches and housekeeping keys, and
  `imageStagingMaxDays`.
- **Snapshots**: a partial snapshot's row expands to list its missing pieces (page, piece, reference, reason). The
  restores list has **Finish** on a recreate that stopped part-way (audited `snapshots.finish_recreate`).
- **Staging**: staged images wait on the bridge's server; the thumbnail is the bridge's own copy
  (`GET /api/admin/staging/:id/image`, the owner's session). An image past `IMAGE_STAGING_MAX_DAYS` shows the date it will
  be removed from the server unless it is placed. Discard removes the server copy (no job). Images staged in LegendKeeper
  before F2 are marked so until `npm run images -- migrate-staging` moves them.
- **Chronology**: a new finding, "Event name's date out of step with its row" (`name_drift`), with **Propose a fix** (a
  name-only update).
- **Audits**: a new category, **Asset library**, with the finding "Sibling asset folders with exactly the same name"
  (`duplicate_asset_folders`) and its **Propose a fix** (merge into the earliest; delete the emptied duplicates, deepest
  first).
- **Jobs**: a job's result lists `foldersUsed` (each folder found or created) and `followUps` (a Last Major Revision write
  that failed after the edit: `lmr_failed`; the job itself succeeded and the edit stayed written).

## v3 F3a (ADR 0050)

- **Packs**: a new page, after Repository Mappings ([above](#packs-v3-f3a)): each setting pack's state, governance
  sources, projects and template ids, token maps, read-only rules and versions; **Approve this pack version** and
  **Save token maps**, each re-authenticated and audited (`pack.approve`, `pack.set_tokens`; also `pack.seed`,
  `pack.attach`, `pack.drift`, `pack.replace_rules`).
- **Proposals**: a package from `arkona_create_character` is one proposal, shown page by page (each new page with its
  facts and tags, each change to an existing page, each image and the folders it creates). It is canonical ("Approve and
  accept as canon") when it makes canon.

## Pick the right value (v3 F4b)

On the Audits page, a finding of the **Consistency** category has **Pick the right value**: the identity page's value and
each restatement side by side (page, lifecycle, where, excerpt), each with **Pick this value**, a field to type the
right value, the agents' suggestions (shown, never applied) and the earlier picks. A pick asks for the step-up (ADR 0062:
a pack-level decision), then makes ONE proposal editing every page that disagrees; approve it on the Proposals page
(selectively if wanted; more than 10 pages asks for the step-up again). The job is revertible from the Jobs page. **Pick
this value** sends the value as shown with the side: when that side reads otherwise now (a page changed after the
audit), the pick is refused ("SIDE_CHANGED") and nothing is proposed; run the audit again and pick again. Each edit is
made where the check read the value, and only there; the proposal lists what it leaves as it is, with why (a value
changed since, a quotation, a page archived since, a date split by formatting).

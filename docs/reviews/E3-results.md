# E3 evaluation: the owner's results (14 to 15 November 2026)

**Source:** the owner ran scenarios 1 to 8 in both assistants (ChatGPT and Claude in claude.ai), then a shortlist, using the
script in [E3-evaluation.md](E3-evaluation.md). **Every run ended right.** This page keeps the table as the owner sent it,
the patterns drawn from it, and what [E3b](../adr/0045-tool-review-and-the-tool-call-log.md) did about them. The decisions on
the review's proposals are in [E3-tools.md](E3-tools.md) section 3.2.

In _Tools called_, `guide` is `get_bridge_guide` (the owner's shorthand; the repeated-call count is `×n`). _Result_ is the
owner's judgement. Scenarios not listed were not run.

## The results

|   # | Scenario                    | Assistant | Tools called                                                                                                                                                 | Result          | Notes                                                                                                  |
| --: | --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------ |
|   1 | Partial name                | ChatGPT   | guide ×3, search, get_resource (live: false)                                                                                                                 | Right           | guide section "find pages" → SECTION_NOT_FOUND, self-corrected                                         |
|   1 | Partial name                | Claude    | list_projects, search, get_resource (live: false)                                                                                                            | Right           |                                                                                                        |
|   2 | Browse repo                 | ChatGPT   | guide, browse_repository_tree                                                                                                                                | Right           |                                                                                                        |
|   2 | Browse repo                 | Claude    | list_projects, browse_repository_tree                                                                                                                        | Right           |                                                                                                        |
|   3 | Tag search                  | ChatGPT   | guide, list_tags, search tag:CANON                                                                                                                           | Right           |                                                                                                        |
|   3 | Tag search                  | Claude    | list_projects, list_tags, guide, search                                                                                                                      | Right           |                                                                                                        |
|   4 | Read one section            | ChatGPT   | guide ×3, search, read_document ×2                                                                                                                           | Right           | guide section "Read a page's text (or one section)" → SECTION_NOT_FOUND                                |
|   4 | Read one section            | Claude    | list_projects, search, get_resource, read_document ×2                                                                                                        | Right           |                                                                                                        |
|   5 | Facts of three pages        | ChatGPT   | guide ×3, get_resources ×2                                                                                                                                   | Right           | first get_resources → AMBIGUOUS; went to the Cores                                                     |
|   5 | Facts of three pages        | Claude    | list_projects, get_resources, guide, get_resource ×2                                                                                                         | Right           | AMBIGUOUS; tried the indexes first, found nothing, then the Cores                                      |
|   6 | Create a Working character  | Claude    | list_projects, create_character (dry run), guide, create_character, get_resource                                                                             | Right           |                                                                                                        |
|   7 | Two specialist pages        | Claude    | list_templates, create_resource ×2 (with parent)                                                                                                             | Right           |                                                                                                        |
|   8 | Promote the set             | ChatGPT   | guide, bridge_info, search, browse_repository_tree, search, promote_page (dry run), promote_page, bridge_proposal_status                                     | Right           |                                                                                                        |
|   8 | Promote the set             | Claude    | guide ×2, promote_page (dry run), promote_page, bridge_proposal_status                                                                                       | Right           | guide section "Promote" → SECTION_NOT_FOUND                                                            |
|   9 | Ambiguous page name         | Claude    | list_projects, search, guide, get_resource (index), get_resource (Core), set_facts                                                                           | Right           | went to the index first, found no Scope, then the Core                                                 |
|  10 | Edit with baseVersion       | ChatGPT   | guide, search, guide ×2, read_document, get_markdown_guide, write_page, bridge_proposal_status                                                               | Right           | baseVersion passed; guide section miss again                                                           |
|  10 | Edit with baseVersion       | Claude    | list_projects, search, guide, get_markdown_guide, read_document, write_page (dry run), write_page                                                            | Right           | baseVersion passed both times                                                                          |
|  11 | Two facts together          | Claude    | list_projects, search, guide, get_resource (index), get_resource (Core), set_facts                                                                           | Right           | index first again                                                                                      |
|  13 | Recovering from a conflict  | Claude    | list_projects, guide, search, read_document, get_markdown_guide, write_page, read_document, write_page                                                       | Right           | VERSION_CONFLICT, re-read, succeeded                                                                   |
|  14 | Page from a template        | ChatGPT   | guide ×3, list_templates, search, create_resource, bridge_proposal_status                                                                                    | Right           | guide section miss again                                                                               |
|  14 | Page from a template        | Claude    | list_projects, guide, list_templates, bridge_info, create_resource (dry run), create_resource                                                                | Right           | create_bare_resource never chosen                                                                      |
|  16 | Archive a Working concept   | Claude    | list_projects, search, guide, archive_page (dry run), archive_page, bridge_proposal_status                                                                   | Right           |                                                                                                        |
|  18 | Chronology event            | Claude    | list_projects, calendar_date, guide, bridge_info, create_timeline_event (dry run), create_timeline_event                                                     | Right           |                                                                                                        |
|  21 | Image into Wardrobe / Qipao | Claude    | list_projects, search, browse_asset_tree, guide, bridge_info, upload_image ×2 (dry run), get_resource, upload_image (dry run), upload_image, bridge_job_wait | Right           | first tries: FOLDER_REQUIRED, then PAGE_NOT_UNDER_CHARACTERS (a Working character); then worked it out |
|  26 | Canon by editing Status     | ChatGPT   | guide ×3, search, get_resource, guide, promote_page (dry run)                                                                                                | Right in effect | no destination was given, so it stopped and said so instead of guessing; guide section miss again      |
|  28 | Low-level fallback          | ChatGPT   | guide ×2, lk_api_read (listMembers)                                                                                                                          | Right           |                                                                                                        |
|  28 | Low-level fallback          | Claude    | list_projects, lk_api_describe_operation, lk_api_read (listMembers)                                                                                          | Right           | didn't read the guide; the server instructions were enough                                             |
|  29 | Impossible: a secret        | Claude    | list_projects, bridge_info                                                                                                                                   | Right           | refused cleanly                                                                                        |

## Patterns

- **Guide section names are guessed.** Six or more `SECTION_NOT_FOUND`, mostly ChatGPT; every one self-corrected, but each
  wasted calls (scenarios 1, 4, 8, 10, 14 and 26).
- **Claude reaches for a character's `[INDEX]` page first** when it wants the character's facts or Scope (scenarios 5, 9
  and 11).
- **`upload_image` with `for_page` cannot derive a folder** for a Working character's page, or for a specialist page
  (scenario 21: `FOLDER_REQUIRED`, then `PAGE_NOT_UNDER_CHARACTERS`).
- **Base versions were passed every time**, and conflict recovery worked (scenarios 10, 13).
- **`create_bare_resource` was never chosen wrongly.** The low-level fallback was used correctly (scenario 28), and
  `lk_api_batch` never.

## What E3b did about it

The owner's answers to P1 to P11 and the fixes for these patterns are in
[ADR 0045](../adr/0045-tool-review-and-the-tool-call-log.md) (the "E3b" section) and [E3-tools.md](E3-tools.md) section 3.2.
In short:

| Finding                                            | What changed                                                                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guessed guide sections                             | Both guides match a section loosely (case, punctuation, key words, synonyms, the which-tool table's labels); "How to decide" lists the exact names.                               |
| `[INDEX]` first                                    | `AMBIGUOUS` for one character's pages names each role and says where the facts live; `get_resource` on an `[INDEX]` names the Core with its id; the guide says it too.            |
| `upload_image` for a Working or specialist page    | `for_page` reads the race from the character's Race / Species fact (tree, else one live read); only then does it refuse, saying exactly what to pass.                             |
| Four tools folded into others, two hidden          | `get_resources`, `bridge_proposals_mine` and `bridge_job_wait` merged (the old names answer "renamed to …" for one release); `lk_upload_image` and `create_bare_resource` hidden. |
| "Are base versions ever skipped?" (P9 not applied) | The Tool calls page flags a `write_page` or `set_facts` call that edits existing content without `baseVersion` / `baseFactsVersion`.                                              |
| A manual run was tedious                           | The Tool calls page has an Evaluation panel and the scenarios are data (`docs/reviews/scenarios.json`); see [dashboard.md](../dashboard.md).                                      |

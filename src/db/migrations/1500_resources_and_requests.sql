-- v2 C2b (ADR 0034): the resource, document and character tools.
--
-- 1. `operation_id` (PLAN-v2 4.13): an optional id on every create. Kept per project and principal with a hash of the
--    normalised request: the same id with the same request returns the earlier result (the job, its outcome, or the
--    proposal) and never writes twice; the same id with a different request is refused (OPERATION_ID_REUSED). A row is
--    `reserved` while its call plans, then names its job or proposal. Kept at least as long as the journal.
CREATE TABLE operation_ids (
  project_id   TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  tool         TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('reserved', 'job', 'proposal', 'answered')),
  job_id       TEXT,
  proposal_id  TEXT,
  result       TEXT,                     -- JSON: the first answer (the plan and how it ended, or was queued)
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, principal_id, operation_id)
) WITHOUT ROWID;
CREATE INDEX operation_ids_created ON operation_ids (created_at);

-- 2. Duplicate requests (PLAN-v2 4.13, section 9): a request for a named thing (`character:<name key>`) while another for
--    the same thing is planning, queued, running or a pending proposal is refused (DUPLICATE_REQUEST), across
--    principals. One row per thing: the latest request for it.
CREATE TABLE request_claims (
  project_id   TEXT NOT NULL,
  claim_key    TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  tool         TEXT NOT NULL,
  label        TEXT NOT NULL,
  job_id       TEXT,
  proposal_id  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, claim_key)
) WITHOUT ROWID;

-- 3. `factsVersion`: the sidebar state at each facts version the bridge handed out (get_resource, set_facts, creates),
--    so a stale `baseFactsVersion` can be answered with what changed. A cache: five per page, seven days; a version it
--    does not remember is still a conflict, without the list of changes.
CREATE TABLE facts_versions (
  project_id  TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  version     TEXT NOT NULL,
  state       TEXT NOT NULL,             -- JSON: the normalised sidebar (rows by rank, collections), as hashed
  stored_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, resource_id, version)
) WITHOUT ROWID;

-- 4. Deleting an Authoritative page needs canonical approval (decided by the owner on 10 November 2026). Projects using
--    the default rules get it from the defaults; a project whose own rules are stored gets the same rule added, once,
--    unless it already has a rule of that kind. (Shown in the Canon section of the Projects page; no audit row is written
--    here, as an INSERT into the AUTOINCREMENT audit log would change its sequence even when no project needs the rule.)
UPDATE projects
   SET settings = json_insert(settings, '$.canonicalRules[#]',
         json('{"id":"delete-authoritative","key":"Status","kind":"delete","values":["Authoritative"],"note":"Deleting a page whose Status is Authoritative (or, with a cascade, any page of the subtree) needs canonical approval; restoring needs none."}'))
 WHERE json_valid(settings)
   AND json_type(settings, '$.canonicalRules') = 'array'
   AND NOT EXISTS (SELECT 1 FROM json_each(projects.settings, '$.canonicalRules') r
                    WHERE json_extract(r.value, '$.kind') = 'delete');

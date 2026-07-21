-- EXECUTION E2: binds an assembled task-context document to the runner that
-- was actually dispatched to read it.
--
-- THE NUMBER IS DELIBERATELY UNASSIGNED. 0019 is the highest number merged
-- when E2 was written; the PM assigns the real number and renames this file
-- (and DISPATCH_CONTEXT_SCOPE_MIGRATION_NAME in persistence/v2/migrate.ts) at
-- integration.
--
-- WHY THIS TABLE EXISTS. EXECUTION E1's runner-facing fetch route
-- (GET /api/v2/execution/task-context/:documentId) only AUTHENTICATES the
-- caller: a valid Ed25519 signature from ANY paired runner satisfies it, for
-- ANY project's document, because runner identity carries no project or job
-- scope. That is fine for identity, wrong for authorization -- a runner
-- dispatched to project A's task should not be able to read project B's
-- repository facts, directives, or task briefing just because it can sign a
-- request. This table is the missing entitlement: one row per
-- (runner, document) pair, written the moment a task is actually scheduled
-- with that document among its context_refs.
--
-- DELIBERATELY NOT FOREIGN-KEYED TO dispatch_jobs. The authorization check
-- only ever needs (runner_id, context_document_id); dispatch_job_id and
-- run_id are carried for audit/traceability only. Coupling the security
-- check itself to the full dispatch_jobs/commands/agent_runs FK chain would
-- make every future caller of this table (including test fixtures) drag that
-- whole chain along for no safety benefit -- the row is only ever written by
-- Phase4Coordinator.schedule()'s caller, immediately after that call
-- succeeds and a real dispatch_jobs row already exists.
--
-- ON CONFLICT: a runner may be re-dispatched the same shared document (the
-- project's repository/directives/memory sections are content-addressed and
-- reused across every task) under a new dispatch job. The primary key is
-- (runner_id, context_document_id) precisely so that stays a single
-- authorization row, refreshed to point at the latest dispatch.
CREATE TABLE dispatch_context_documents (
  runner_id TEXT NOT NULL,
  context_document_id TEXT NOT NULL,
  dispatch_job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (runner_id, context_document_id)
);
CREATE INDEX dispatch_context_documents_document_idx
  ON dispatch_context_documents (context_document_id);
CREATE INDEX dispatch_context_documents_dispatch_job_idx
  ON dispatch_context_documents (dispatch_job_id);

REVOKE ALL PRIVILEGES ON dispatch_context_documents FROM PUBLIC;
REVOKE ALL PRIVILEGES ON dispatch_context_documents FROM norns_app;
GRANT SELECT, INSERT, UPDATE ON dispatch_context_documents TO norns_app;

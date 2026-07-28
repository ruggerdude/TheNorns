-- ONBOARDING: missing UPDATE grant on project_onboarding_repository_intents.
--
-- MIGRATION NUMBER IS DELIBERATELY UNASSIGNED (`NNNN_`). The integrating PM
-- assigns the number, renames the file, and registers it in
-- apps/server/src/persistence/v2/migrate.ts at the same time.
--
-- WHY
-- ---
-- 0018 granted only SELECT, INSERT on project_onboarding_repository_intents,
-- but projectOnboardingService.reserveRepositoryIntent locks the intent row
-- with `SELECT ... FOR UPDATE` (projectOnboardingService.ts:547-553), and in
-- PostgreSQL a FOR UPDATE row lock requires the UPDATE privilege. Under the
-- restricted production role (norns_app) every `new_repo` onboarding therefore
-- failed with "permission denied" and surfaced as the generic 500 from the
-- onboarding catch-all. PGlite tests do not model the restricted role, so the
-- gap was invisible in CI.
--
-- AUDIT of the tables created by 0016 and 0018 versus what the code does:
--
--   * project_onboarding_submissions (0016, GRANT SELECT, INSERT):
--       SELECT  — projectOnboardingService.ts:418 (replay short-circuit)
--       INSERT  — projectOnboardingService.ts:465 (ON CONFLICT DO NOTHING)
--     No UPDATE/DELETE/FOR UPDATE anywhere; the existing grant is sufficient.
--
--   * project_onboarding_repository_intents (0018, GRANT SELECT, INSERT):
--       SELECT ... FOR UPDATE — projectOnboardingService.ts:547-553 (needs UPDATE)
--       INSERT               — projectOnboardingService.ts:563 (covered)
--     Missing UPDATE is the only gap; granted below.
--
-- Additive and forward-only. Replay-safe: GRANT is idempotent.

DO $intents_update$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'norns_app') THEN
    -- Required by the `SELECT ... FOR UPDATE` row lock in
    -- projectOnboardingService.reserveRepositoryIntent (projectOnboardingService.ts:551).
    EXECUTE 'GRANT UPDATE ON project_onboarding_repository_intents TO norns_app';
  END IF;
END;
$intents_update$;

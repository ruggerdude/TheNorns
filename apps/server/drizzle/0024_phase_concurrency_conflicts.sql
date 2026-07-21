-- EXECUTION E12: conflict safety for concurrent tasks inside one phase.
--
-- THE NUMBER IS DELIBERATELY UNASSIGNED. 0023 is the highest number merged when
-- E12 was written; the PM assigns the real number and renames this file (and
-- PHASE_CONCURRENCY_CONFLICTS_MIGRATION_NAME in persistence/v2/migrate.ts) at
-- integration.
--
-- WHY THIS TABLE EXISTS
-- ====================
--
-- EXECUTION E5 made two dispatches in one project structurally independent
-- (per-dispatch runner identity), which is what makes `max_concurrent_tasks > 1`
-- safe at the transport layer. It does nothing about the layer underneath: two
-- agents editing ONE repository. Each run gets its own worktree (E4) and pushes
-- its own branch, so the two never corrupt each other WHILE RUNNING -- but they
-- can, and eventually will, produce two branches off the same base that touch
-- the same lines. Somebody has to merge those, and the refoundation's answer --
-- which this table preserves -- is that "somebody" is a human, always.
--
-- The refoundation's `engine/integration.ts` encoded that rule as CLEAN MERGES
-- ONLY: a merge that conflicts blocks the node, spawns a human-visible
-- conflict-resolution node that REPLACES the original, and refuses to integrate
-- until a human confirms. That module never ran in production (it is imported
-- only by its own tests) and it assumes a server-side git checkout that the V2
-- architecture deliberately does not have -- the repository lives on the user's
-- laptop runner, or in GitHub Actions, never on the relay. So the mechanism is
-- superseded here; the RULE is not. This table is the V2 form of "the conflict
-- became a thing a human must look at, and nothing proceeds until they do".
--
-- WHAT A ROW MEANS
-- ================
--
-- One row = "two sibling runs in this phase both published unintegrated work
-- from the same base revision, and Norns cannot prove they are disjoint."
-- It is a CANDIDATE, detected from facts the relay actually holds
-- (`agent_runs.published_branch` / `.published_commit_sha` / `.expected_revision`
-- from 0022), not a git merge result -- the relay has no repository to merge in
-- and does not pretend otherwise. Detection is deliberately FAIL-CLOSED: absent
-- a declared, provably-disjoint file scope on BOTH tasks, an overlap is
-- assumed. A false positive costs a human one glance and one dismissal; a false
-- negative costs them a silently mangled repository, which is the failure this
-- whole table exists to prevent.
--
-- Nothing in this codebase merges anything. There is no auto-resolution path to
-- disable, and this table adds none: `resolution` records what the HUMAN did,
-- after they did it, in their own repository.
CREATE TABLE IF NOT EXISTS run_integration_conflicts (
  id                        TEXT PRIMARY KEY,
  schema_version            INTEGER NOT NULL DEFAULT 2,
  project_id                TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id                  TEXT NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
  -- The later-published side ("this run conflicts with an earlier sibling").
  run_id                    TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  task_id                   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  branch                    TEXT NOT NULL,
  commit_sha                TEXT NOT NULL,
  -- The earlier-published side.
  counterpart_run_id        TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  counterpart_task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  counterpart_branch        TEXT NOT NULL,
  counterpart_commit_sha    TEXT NOT NULL,
  -- The common ancestor both runs were dispatched against.
  base_revision             TEXT NOT NULL,
  -- 'declared_scope_overlap' -- both tasks declared conflict keys and they
  --   intersect; `overlap_keys` names exactly which.
  -- 'undeclared_scope'       -- at least one task declared no file scope, so
  --   disjointness is UNPROVEN. Fail closed. `overlap_keys` is empty.
  detection_basis           TEXT NOT NULL
    CHECK (detection_basis IN ('declared_scope_overlap', 'undeclared_scope')),
  overlap_keys              JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                    TEXT NOT NULL DEFAULT 'awaiting_human'
    CHECK (status IN ('awaiting_human', 'resolved', 'dismissed')),
  -- What the human did in their own repository. NEVER written by Norns on its
  -- own behalf: every non-null value here has a named actor beside it.
  --   'merged_manually' -- they reconciled the branches themselves.
  --   'superseded'      -- one side's work was abandoned/redone.
  --   'not_a_conflict'  -- inspected, genuinely disjoint, dismissed.
  resolution                TEXT
    CHECK (resolution IN ('merged_manually', 'superseded', 'not_a_conflict')),
  resolution_note           TEXT,
  resolved_by_actor_type    TEXT,
  resolved_by_actor_id      TEXT,
  detected_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at               TIMESTAMPTZ,
  -- A terminal row must say who ended it and how. An open row must claim
  -- neither. This is the constraint that makes "no silent resolution" a
  -- database invariant rather than a convention: there is no way to write a
  -- resolved conflict without naming the actor who resolved it.
  CONSTRAINT run_integration_conflicts_resolution_shape CHECK (
    (status = 'awaiting_human'
       AND resolution IS NULL AND resolved_at IS NULL
       AND resolved_by_actor_type IS NULL AND resolved_by_actor_id IS NULL)
    OR
    (status IN ('resolved', 'dismissed')
       AND resolution IS NOT NULL AND resolved_at IS NOT NULL
       AND resolved_by_actor_type IS NOT NULL AND resolved_by_actor_id IS NOT NULL)
  ),
  CONSTRAINT run_integration_conflicts_distinct_runs CHECK (run_id <> counterpart_run_id)
);

-- One row per unordered pair of runs. The detector always writes the pair with
-- the later publication as `run_id`, so the ordering is stable and this index
-- makes re-detection idempotent rather than duplicative -- a phase re-scan, a
-- replayed publication event, or a server restart mid-scan cannot produce a
-- second copy of the same conflict for a human to resolve twice.
CREATE UNIQUE INDEX IF NOT EXISTS run_integration_conflicts_pair_unique
  ON run_integration_conflicts (run_id, counterpart_run_id);

-- The read path the UI and the completion gate both use: "does this phase have
-- anything a human still has to look at?"
CREATE INDEX IF NOT EXISTS run_integration_conflicts_open_idx
  ON run_integration_conflicts (phase_id, status)
  WHERE status = 'awaiting_human';

CREATE INDEX IF NOT EXISTS run_integration_conflicts_task_idx
  ON run_integration_conflicts (task_id, status);

-- Production runs under a restricted role and pglite tests do not model that,
-- so a missing grant is invisible in CI and fails only in production. Every new
-- table needs this (same shape as 0020/0021).
REVOKE ALL PRIVILEGES ON run_integration_conflicts FROM PUBLIC;
REVOKE ALL PRIVILEGES ON run_integration_conflicts FROM norns_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON run_integration_conflicts TO norns_app;

-- `task_coordination_constraints` (0005) already exists and already gates
-- dispatch inside `Phase4Coordinator.schedule()` -- a task whose `conflict_keys`
-- intersect an ACTIVE sibling's is refused. E12's audit found that gate has
-- never once fired in production for a reason worth stating plainly: NOTHING IN
-- THIS CODEBASE HAS EVER INSERTED A ROW INTO THAT TABLE. Two readers, zero
-- writers. The mutual exclusion was real code over an always-empty table.
--
-- E12 gives it a writer (`TaskConflictScopeRepository.declare()`), which needs
-- no schema change. What it does need is a default that is honest about the
-- distinction the old column could not express: a task with NO declared scope
-- and a task declared to touch NOTHING were both the empty array. The first
-- must fail closed at detection time; the second is a real, provable claim of
-- disjointness. This column separates them, and defaults every existing row to
-- the truthful answer for pre-E12 data: nobody ever declared anything.
ALTER TABLE task_coordination_constraints
  ADD COLUMN IF NOT EXISTS conflict_scope_declared BOOLEAN NOT NULL DEFAULT false;

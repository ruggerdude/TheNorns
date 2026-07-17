# Phase 3 Candidate Evidence — Existing Projects and Persistent Phases

Date: 2026-07-16

Status: implementation complete under the human owner's manual-gating policy.
Phase 4 is not started by this record.

## Delivered

- Durable local-runner repository bindings using opaque runner, workspace, and
  repository identifiers; raw local filesystem paths never enter the control
  plane.
- Durable GitHub installation/repository bindings with an explicit permission
  set and no token or private-key fields.
- Immutable binding identity and replay-deduplicated binding creation.
- Atomic repository ingestion that creates architecture evidence, the first
  ArchitectureRevision, repository facts, constraints, and project policies.
- Persistent Phase creation with optimistic project versioning, dependencies,
  stable replay identity, and append-only creation events.
- Immutable, hash-bound StrategyVersion retention.
- Human approval that atomically materializes Objectives, Tasks,
  TaskDependencies, AgentAssignments, approved budget, and approved Phase
  state.
- Project Resume projection containing current architecture, repositories,
  phases, task progress, active work, decisions, memory, recent completions,
  and the next recommended action.
- Authenticated HTTP APIs and production restricted-PostgreSQL startup wiring.
- Web Project Resume and direct persistent-phase creation workflow.

## Verification

- `pnpm -r typecheck` — green across contracts, adapters, runner, web, and
  server.
- `pnpm -r test` — green across the workspace.
- Contracts: 13 files, 107 tests passed.
- Web: 14 files, 37 tests passed.
- Server suite — green, including the new Phase 3 source-binding, ingestion,
  phase, strategy, Resume, and authenticated API suites plus all Phase 1/2
  regression coverage.
- Focused Phase 3 tests prove replay safety, immutable identities, hash
  verification, atomic approval/materialization, optimistic version conflicts,
  authorization, and the open-project/create-phase exit flow.

## Exit-condition demonstration

An imported existing project can be opened through Project Resume, which
returns its current architecture, repository binding, memory, phases, task
state, attention items, and next action. A human can create a new persistent
phase without replacing imported history or rebuilding the project plan. A
converged StrategyVersion can then be retained, approved, and atomically
materialized into canonical execution entities.

## Deferred to later phases

- Runner execution and relay dispatch remain Phase 4.
- Just-in-time GitHub installation-token delivery at push time remains coupled
  to the Phase 4 runner channel; Phase 3 persists no reusable GitHub token.
- Broader executive dashboard and notification work remains Phase 5+.

# Phase 4 Candidate Evidence — Coordinator-to-runner Vertical Slice

Date: 2026-07-16

Status: implementation complete under the human owner's manual-gating policy.
Candidate branch: `refoundation/phase4-coordinator-runner`.

## Delivered

- Dependency-aware task scheduling against an approved persistent Phase and a
  connected repository binding.
- Atomic AgentRun creation, assignment activation, Task lifecycle transitions,
  budget reservation, stable command creation, and durable dispatch outbox.
- PostgreSQL leasing with `FOR UPDATE SKIP LOCKED`, expired-lease recovery,
  stable command identity, bounded retries, and dead-letter handling.
- Reconnect redelivery of delivered-but-unfinished commands. The runner's
  disk-backed command record prevents a redelivered command ID from executing
  twice.
- Generation-fenced and replay-deduplicated runner-event persistence, applied
  in connection order before the server acknowledges the event watermark.
- Runner-owned approved-path resolution, Git worktrees, signed context fetch,
  byte/hash verification, Codex/Claude model selection, exact-commit
  verification, structured logs/status/usage, and cleanup.
- Production CLI injection of the Phase 4 executor from runner-local approved
  repository and verification-policy configuration.
- Human review and integration evidence gates before Task completion.
- Transactional Task, Objective, Phase, assignment, budget, and Project Memory
  closure.
- Terminal command rejection, cancellation, expiry, runner failure, and
  dead-letter paths cannot leave a live reservation.
- Periodic stuck-run detection with deterministic DecisionPoint deduplication,
  plus the existing audited orphan-reservation sweep.
- Authenticated schedule and completion APIs and production PostgreSQL/WebSocket
  wiring. The server executes no repository shell command.

## Recovery evidence

The Phase 4 integration suite proves:

1. scheduling writes lifecycle state, reservation, command, and outbox in one
   transaction;
2. a dispatcher crash after lease acquisition is recovered after lease expiry;
3. recovery redelivers the identical command ID;
4. duplicate runner events apply once;
5. green verification advances the designated run and task to review;
6. review plus integration closes the task, objective, phase, assignment,
   reservation, and memory record;
7. delivery exhaustion dead-letters the job, blocks work, expires the run, and
   releases the reservation;
8. a runner-side command rejection durably blocks the task and releases budget;
9. repeated recovery scans create only one open DecisionPoint for unchanged
   stuck-run state.

## Verification

- Focused Phase 4 server tests: 7 tests passed.
- Contracts, runner, and server typechecks: green.
- Full `pnpm run ci`: green before final evidence commit; repeated after the
  production-runner and recovery additions for the final candidate.

## Operational configuration

See `docs/runbooks/PHASE-4-RUNNER.md`. Raw local paths and verification command
allowlists are runner-local. Credentials and fetch secrets are not stored in
dispatch envelopes or exposed to runtime sandbox environments.

## Scope note

This candidate closes the Phase 4 exit gate for one production-shaped task.
The existing protocol still defines interactive interrupt, suspend, resume,
cancel, and stop-after-current controls. Binding those controls to long-lived
V2 runtime sessions is intentionally not represented as complete by this
evidence; it remains an operational hardening item before unattended pilot
use, not a prerequisite for the single-task vertical-slice exit demonstration.


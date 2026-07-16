# Phase 1 Brief — Domain and Persistence Foundation

**Status:** Candidate frozen — independent review pending
**Authorized:** 2026-07-16
**Branch:** `refoundation/phase1-domain-persistence`
**Candidate implementation:** `7244dd8430128b99acb8e5facc4d7575ff3e05a8`
**Program baseline:** 14 FSE
**Program manager / integration owner:** ChatGPT Sol
**Primary implementation:** Backend Sonnet
**Race, failure, and recovery verification:** Codex
**Independent contract review:** Claude Fable 5

## Objective

Create the versioned domain, normalized schema, and transactional application
boundary that later phases can migrate to and execute against without
discarding or modifying legacy production data.

Phase 1 establishes foundations. It does not migrate live users/projects or
activate real repository execution.

## Work packages

### P1-A — V2 contracts

- Project, Phase, Objective, Task, TaskDependency.
- StrategyVersion and approval/convergence rules.
- AgentProfile, AgentAssignment, AgentRun.
- DecisionPoint, DecisionRecord.
- ProjectMemoryEntry and ArchitectureRevision.
- Task and AgentRun state machines plus pure Task-from-Run projection.
- Phase-local TaskDependency enforcement.
- Domain/audit event envelopes and schema versions.
- Application-command idempotency contract.
- Budget-reservation terminal outcomes.
- Immutable dispatch-job/command identity.

Owner: contracts implementation agent.
Integration owner: Sol.

### P1-B — normalized schema and additive migration

- Drizzle schema for the Phase 1 canonical tables.
- Additive SQL migration; `norns_state` remains untouched.
- Foreign keys and project scoping.
- Optimistic aggregate versions.
- Unique event stream versions.
- Append-only event/audit permissions design.
- Idempotency uniqueness and stored results.
- Immutable command identity per dispatch job.
- DecisionPoint open-condition uniqueness.
- Budget reservations and migration ledger.

Owner: persistence/schema implementation agent.
Review: Codex and Sol.

### P1-C — transactional application boundary

- One transaction for state, events, audit, budget, command, and outbox.
- Actor-scoped idempotency replay/conflict behavior.
- Expected-version conflict behavior.
- Stable command ID across transport redelivery.
- Lifecycle fold-versus-row reconciliation.
- Reservation settlement/release/orphan sweep.
- DecisionPoint condition upsert/supersession.

Owner: backend/control-plane implementation.
Race/fault verification: Codex.

### P1-D — compatibility boundary

- Repository interfaces between existing APIs and storage.
- Legacy ProjectStore adapter remains the production default.
- Relational implementation remains capability-flagged and non-destructive.
- No Phase 2 import or cutover logic.

Owner: Sol integration with backend implementation.

### P1-E — gate evidence

- PGlite/PostgreSQL-shaped schema and transaction tests.
- State-without-event and event-without-state detection.
- Production lifecycle mutation chokepoint, reconciliation quarantine, and
  architecture-fitness enforcement.
- Concurrent duplicate-command test.
- Dispatcher redelivery stable-ID test.
- Budget terminal-outcome and orphan tests.
- Cross-phase dependency rejection.
- Task/AgentRun exhaustive transition tests.
- DecisionPoint restart/dedup test.
- Resolved-condition suppression until the material fingerprint changes.
- Additive migration, backup, and restore evidence.
- Candidate contract review packet for Claude Fable 5.

Owner: Codex plus Sol.

## Invariants

1. No application/package contract removes or breaks V1 behavior.
2. No migration deletes or rewrites `norns_state`.
3. No V2 production cutover occurs in Phase 1.
4. Task is canonical; graph remains a projection.
5. TaskDependency is phase-local.
6. Strategy materialization requires convergence and no unresolved must-fix
   finding; no override command exists.
7. Lifecycle rows and lifecycle events commit together.
8. One dispatch job has one immutable command ID across redelivery.
9. Idempotency key reuse with a different request is rejected.
10. Only one equivalent DecisionPoint may remain open.
11. The MVP remains single-server-instance.

## Candidate freeze and review sequence

1. Contracts/schema reach candidate status.
2. Sol verifies implementation and evidence.
3. Candidate package is frozen for read-only review.
4. Claude Fable 5 returns findings.
5. Findings are dispositioned under the standing independence rules.
6. Required remediation lands.
7. Sol records the final contract freeze.

## Exit gate

The Phase 1 exit criteria are exactly those in
[`REFOUNDATION-PROGRAM.md`](../REFOUNDATION-PROGRAM.md). Passing component
tests alone is insufficient. Phase 2 cannot begin until the independent
contract review and final freeze are complete and the human authorizes the
next phase.

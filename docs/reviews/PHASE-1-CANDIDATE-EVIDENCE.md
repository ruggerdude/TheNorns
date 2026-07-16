# Phase 1 Candidate Evidence — Domain and Persistence Foundation

**Candidate implementation:** `7244dd8430128b99acb8e5facc4d7575ff3e05a8`
**Branch:** `refoundation/phase1-domain-persistence`
**Parent authorization commit:** `f924b7f`
**Evidence date:** 2026-07-16
**Status:** Candidate frozen for independent read-only review

## Scope delivered

- V2-prefixed contracts alongside the unchanged V1 contract surface.
- Persistent Project, Phase, Objective, Task, dependency, strategy, agent,
  run, decision, memory, architecture, repository, evidence, budget, command,
  outbox, event, audit, and migration entities.
- Separate Task and AgentRun state machines with a pure designated-run
  projection.
- Canonical StrategyVersion hashing, approval validation, and exact
  materialization.
- Actor/family-scoped command idempotency, stored result replay, committed
  failure replay, and explicit in-progress conflict behavior.
- Additive normalized PostgreSQL/Drizzle schema. The legacy `norns_state`
  table remains unchanged and is included in backup/restore evidence.
- Project-, phase-, task-, run-, repository-, approval-, evidence-, and
  supersession-scoped foreign keys, including nullable-scope shape checks.
- One pinned database transaction abstraction for PostgreSQL and PGlite.
- Production SQL adapters for idempotency, lifecycle transitions,
  DecisionPoint deduplication/supersession, budget resolution/orphan sweep,
  and lifecycle reconciliation.
- Guarded Task/AgentRun lifecycle mutation chokepoint that atomically writes
  the operational row, domain event, and audit event.
- Architecture-fitness enforcement against lifecycle SQL outside the guarded
  adapter.
- Legacy ProjectStore compatibility port with immutable graph views. The
  legacy adapter remains the production default.

## Verification result

`pnpm run ci` passed at the candidate commit:

| Workspace | Result |
|---|---:|
| Contracts | 93 passed |
| Adapters | 12 passed, 1 live-provider smoke skipped |
| Web | 37 passed |
| Server | 188 passed, 1 live-planning test skipped |
| Lint | Green |
| Typecheck | Green |
| Build | Green |

The two skips are existing environment-dependent live tests. They are not
Phase 1 failures.

Known non-blocking output:

- Vite reports the existing production bundle above 500 kB.
- One existing React test logs a shorthand/non-shorthand style warning.

## Phase 1 finding coverage

| Finding | Candidate evidence |
|---|---|
| REF-REC-1 | `lifecycleMutation.ts`, SQL adapter, reconciliation quarantine, one-sided fault tests, and architecture-fitness tests |
| REF-REC-2 | Stable command ID derived from dispatch-job ID; command/job uniqueness and redelivery tests |
| REF-REC-6 | Exhaustive Task/AgentRun transitions, designated/superseded run rules, verification gating, and Task projection tests |
| REF-REC-7 | Stable condition key/fingerprint/revision, one-open constraint, unchanged-closed suppression, atomic supersession, and crash/restart test |
| REF-REC-10 | Contract validation plus composite database constraints reject cross-phase TaskDependencies |
| REF-REC-13 | Actor/family/key scope, request fingerprints, stored responses, mismatch audit, committed-failure replay, retention horizons, and retriable in-progress behavior |
| REF-REC-16 contract | Terminal settlement/release/retention outcomes and orphan sweep contract/tests |

## Internal adversarial checks

The contract pass found and corrected four pre-freeze defects:

1. Strategy materialization originally omitted immutable execution fields.
2. Approval validation did not bind every computed/stored/command hash.
3. Task projection could apply an illegal transition.
4. Domain-event stream and entity identity could diverge.

A separate final gate audit found and corrected:

1. lifecycle mutations were not yet enforced through a production
   chokepoint;
2. unchanged resolved DecisionPoints could reopen;
3. an in-progress idempotency response could imply a false owning command ID;
4. canonical pointers and nullable scope chains required stronger composite
   foreign keys.

The re-audit reported no remaining implementation blocker for candidate
review.

## Explicit non-scope

- No legacy user/project import or cutover.
- No production switch from ProjectStore to the relational repository.
- No removal or rewrite of `norns_state`.
- No live repository execution.
- No Phase 2 migration behavior.
- No Phase 4 dispatcher crash/delivery proof.
- No multi-instance claim.

Phase 2 remains prohibited until the independent review, finding
dispositions, final Phase 1 freeze, and a separate human authorization.

## Program control

The Phase 1 baseline remains 14 FSE. Final actual/variance accounting is
recorded at the Phase 1 exit gate after review remediation; this candidate
packet does not declare the phase complete or consume contingency by fiat.

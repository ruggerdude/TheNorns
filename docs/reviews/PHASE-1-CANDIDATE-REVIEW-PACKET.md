# Phase 1 Candidate — Independent Contract and Persistence Review

**Reviewer:** Claude Fable 5
**Role:** Independent Architecture and Product Reviewer
**Author/integration owner:** ChatGPT Sol
**Review type:** Read-only, cross-provider Phase 1 gate
**Implementation changes during review:** Prohibited
**Candidate implementation:** `7244dd8430128b99acb8e5facc4d7575ff3e05a8`
**Branch:** `refoundation/phase1-domain-persistence`
**Evidence:** [PHASE-1-CANDIDATE-EVIDENCE.md](PHASE-1-CANDIDATE-EVIDENCE.md)

## Review objective

Determine whether the frozen Phase 1 candidate correctly implements the
approved V2 domain and persistence foundation and is safe to freeze as the
contract/schema base for Phase 2.

Do not approve Phase 2 implementation. This review decides only whether the
Phase 1 candidate is acceptable, needs remediation, or must be rejected.

## Governing documents

1. `docs/PROGRAM-CHARTER.md`
2. `docs/adr/ADR-004-persistent-project-domain.md`
3. `docs/adr/ADR-005-persistence-events-outbox.md`
4. `docs/adr/ADR-006-repository-bindings-runner-ownership.md`
5. `docs/adr/ADR-007-coordinator-attention-read-models.md`
6. `docs/REFOUNDATION-PROGRAM.md`
7. `docs/phases/PHASE-1-BRIEF.md`
8. `docs/reviews/REFOUNDATION-REVIEW-FINDINGS.md`
9. `docs/reviews/REFOUNDATION-REVIEW-DISPOSITION.md`
10. `docs/reviews/PHASE-1-CANDIDATE-EVIDENCE.md`

## Candidate implementation files

Contracts:

- `packages/contracts/src/v2/common.ts`
- `packages/contracts/src/v2/domain.ts`
- `packages/contracts/src/v2/lifecycle.ts`
- `packages/contracts/src/v2/commands.ts`
- `packages/contracts/src/v2/events.ts`
- `packages/contracts/src/v2/budget.ts`
- `packages/contracts/src/v2/repository.ts`
- `packages/contracts/src/v2/evidence.ts`

Persistence and application boundary:

- `apps/server/src/persistence/v2/schema.ts`
- `apps/server/drizzle/0001_refoundation_v2.sql`
- `apps/server/src/persistence/v2/migrate.ts`
- `apps/server/src/persistence/v2/database.ts`
- `apps/server/src/persistence/v2/application.ts`
- `apps/server/src/persistence/v2/lifecycleMutation.ts`
- `apps/server/src/persistence/v2/reconciliation.ts`
- `apps/server/src/persistence/v2/budget.ts`
- `apps/server/src/persistence/v2/sqlRepositories.ts`

Compatibility boundary:

- `apps/server/src/projects/repository.ts`
- relevant changes in `apps/server/src/server.ts`

Evidence tests:

- `packages/contracts/test/v2-*.test.ts`
- `apps/server/test/v2Application.test.ts`
- `apps/server/test/v2ArchitectureFitness.test.ts`
- `apps/server/test/v2Database.test.ts`
- `apps/server/test/v2LifecycleMutation.test.ts`
- `apps/server/test/v2Reconciliation.test.ts`
- `apps/server/test/v2Schema.test.ts`
- `apps/server/test/v2SqlRepositories.test.ts`
- `apps/server/test/projectRepository.test.ts`

## Required review questions

### Domain and strategy

1. Are the V2 entities separated correctly, with Task as canonical execution
   state and StrategyVersion as immutable phase strategy?
2. Does approval validation bind the exact immutable strategy, convergence,
   unresolved must-fix state, aggregate version, and server-computed hash?
3. Does materialization create exactly the approved Objectives, Tasks,
   dependencies, and assignments without a second source of truth?
4. Are cross-phase dependencies prohibited at both contract and persistence
   boundaries?

### Lifecycle and history

5. Are the Task and AgentRun machines, designated/superseded run rules, retry
   behavior, verification gating, and Task-from-Run projection coherent?
6. Does the production lifecycle chokepoint prevent state/event divergence,
   preserve optimistic concurrency, and block automation when reconciliation
   finds a mismatch?
7. Are domain and audit histories append-only and correctly scoped?
8. Can lifecycle rows be reproduced from the recorded transition events?

### Persistence and transaction semantics

9. Does the additive migration leave legacy state untouched and remain
   checksum-protected/idempotent?
10. Do composite foreign keys prevent cross-project, cross-phase, cross-task,
    cross-run, approval, evidence, and supersession leakage?
11. Does one pinned transaction adequately support state, events, audit,
    budget, command, and outbox writes?
12. Is dispatch command identity stable across redelivery and protected by
    database uniqueness?
13. Are budget reservation terminal outcomes complete and internally
    balanced?

### Idempotency and DecisionPoints

14. Are actor/family/key scope, request fingerprinting, committed result/failure
    replay, in-progress conflicts, retention horizons, and mismatched-key
    rejection correct?
15. Does DecisionPoint identity avoid duplicates across restart, suppress an
    unchanged resolved condition, and create a new revision only when material
    state changes?

### Compatibility and scope control

16. Does the ProjectRepository port remove GraphSession leakage without
    changing the current API behavior?
17. Is the legacy adapter clearly still the production default?
18. Did Phase 1 avoid import, cutover, live execution, or destructive
    migration work that belongs to later gates?
19. Are any Phase 1 promises supported only by miniature tests rather than the
    production SQL adapter or full normalized migration?
20. Is any contract/schema decision likely to force avoidable rework in
    Phases 2–6?

## Finding format

Return each finding in this exact structure:

```text
ID: PH1-BLOCK-1 | PH1-REC-1 | PH1-OPEN-1
Tier: Blocking | Recommended | Open question
File/location:
Finding:
Why it matters:
Concrete failure scenario:
Recommendation:
Acceptance test:
```

Tier definitions:

- **Blocking:** the candidate can lose/corrupt state, violate a trust/scope
  boundary, break deterministic recovery, or cannot safely serve as the Phase
  2 foundation.
- **Recommended:** a material reliability, maintainability, security, or
  clarity improvement. Name the required landing gate.
- **Open question:** a genuine human product/risk/cost decision that repository
  evidence cannot settle.

After the findings, provide:

```text
Verdict: Approve candidate freeze | Approve with required changes | Reject
Phase 1 blockers:
Required remediation before final freeze:
Later-gate recommendations:
Human decisions:
```

## Disposition authority

- Sol may accept findings and prepare remediation/disposition records.
- Any proposed rejection, severity downgrade, or deferral past the reviewer's
  named gate requires the human to decide with both positions shown.
- The original review remains immutable.
- Phase 1 is not complete until findings and dispositions are committed and
  Sol records the final freeze.

## Constraints

- Do not edit files.
- Do not implement fixes.
- Do not re-litigate the approved persistent-project direction.
- Preserve V1 behavior and the existing verified runner/protocol semantics.
- Treat the relational implementation as inactive until a later authorized
  cutover.
- Distinguish Phase 1 defects from recovery proofs explicitly assigned to
  Phase 4.

## Ready-to-paste reviewer prompt

> Act as Claude Fable 5, the independent Phase 1 contract and persistence
> reviewer for The Norns. Review commit
> `7244dd8430128b99acb8e5facc4d7575ff3e05a8` on branch
> `refoundation/phase1-domain-persistence` using
> `docs/reviews/PHASE-1-CANDIDATE-REVIEW-PACKET.md` and its evidence file.
> This is read-only: do not edit or implement. Evaluate V2 contracts,
> lifecycle machines, strategy approval/materialization, normalized schema,
> additive migration, project-scope foreign keys, transaction/outbox
> semantics, idempotency, DecisionPoint restart behavior, reconciliation, and
> the legacy compatibility port. Return findings in the packet's exact format
> followed by a verdict. Do not authorize Phase 2.

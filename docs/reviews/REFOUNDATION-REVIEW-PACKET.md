# The Norns Re-foundation Architecture Review Packet

**Reviewer:** Claude Fable 5
**Role:** Independent Architecture and Product Reviewer
**Author/integration owner:** ChatGPT Sol
**Review type:** Read-only, cross-provider phase gate
**Implementation changes:** Prohibited during this review

## Review objective

Determine whether the approved controlled re-foundation is internally
consistent, safely migrates the current product, and can deliver the Program
Charter MVP without a rewrite or hidden reintroduction of plan-centric state.

## Files to review

1. `docs/PROGRAM-CHARTER.md`
2. `docs/PHASE-0-ARCHITECTURE-REVIEW.md`
3. `docs/adr/ADR-001-tech-stack.md` — including the 2026-07-16 identity
   amendment
4. `docs/adr/ADR-004-persistent-project-domain.md`
5. `docs/adr/ADR-005-persistence-events-outbox.md`
6. `docs/adr/ADR-006-repository-bindings-runner-ownership.md`
7. `docs/adr/ADR-007-coordinator-attention-read-models.md`
8. `docs/REFOUNDATION-PROGRAM.md`
9. `docs/reviews/REFOUNDATION-REPO-MAP.md`

Use these current implementation files as evidence:

- `apps/server/src/projects/store.ts`
- `apps/server/src/graph/session.ts`
- `apps/server/src/graph/graph.ts`
- `apps/server/src/persistence/pg.ts`
- `apps/server/src/engine/workflow.ts`
- `apps/server/src/engine/dispatch.ts`
- `apps/server/src/engine/execution.ts`
- `apps/server/src/server.ts`
- `apps/server/src/main.ts`
- `apps/runner/src/daemon.ts`
- `apps/web/src/Projects.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/Dashboard.tsx`
- `packages/contracts/src/plan.ts`
- `packages/contracts/src/protocol.ts`
- `packages/contracts/src/memory.ts`
- `packages/contracts/src/approval.ts`

## Decisions already approved

Do not re-litigate the product mission or return to the old plan-first product.
The following direction is approved:

1. Projects are persistent and contain multiple phases.
2. Plans become immutable phase strategy versions.
3. Tasks and task dependencies are canonical execution/graph state.
4. Normalized PostgreSQL, domain history, and a transactional outbox replace
   whole-store snapshots as production truth.
5. Repository execution belongs to the Local Runner.
6. The coordinator is deterministic application logic; LLMs propose and
   summarize.
7. Project Resume and Portfolio Attention are first-class read models.
8. Existing users and projects must be preserved.

Findings should improve the implementation safety or internal consistency of
that direction, not propose a different product.

## Required review questions

### Domain and contracts

1. Are Project, Phase, Objective, Task, AgentProfile, AgentAssignment, AgentRun,
   DecisionPoint, DecisionRecord, Memory, and ArchitectureRevision separated
   correctly?
2. Does StrategyVersion approval materialize work without creating a second
   source of truth?
3. Are task versus run lifecycle responsibilities clear enough?
4. Are there missing invariants that would permit historical-state loss or
   cross-project leakage?

### Identity, scope, and governance

5. Does ADR-001’s identity amendment adequately ratify the shipped
   account/password/invite/admin scope without silently expanding into
   collaborative multi-tenant RBAC?
6. Are target session-token hashing, expiry, cookie, recent-auth, recovery, and
   audit-attribution requirements sufficient?
7. Does the post-GATE ratification map account for every architecture-relevant
   change that landed without an ADR?
8. Does the disposition-authority rule preserve reviewer independence?

### Persistence and migration

9. Is the hybrid normalized-state/domain-event model coherent?
10. Is the state/event/audit/outbox transaction boundary complete?
11. Are idempotency, optimistic concurrency, runner event ingestion, leases,
   terminal-state races, and budget reservation semantics sufficient?
12. Can legacy users, sessions, projects, plans, graph edits, assignments, and
   approvals be migrated and rolled back safely?
13. Does the plan/graph reconciliation policy avoid silent guessing?

### Runner and source trust boundary

14. Is local folder selection feasible and secure through the Local Runner?
15. Are GitHub App credentials and repository permissions correctly bounded?
16. Are all repository, worktree, sandbox, verification, and push
    responsibilities on the correct side of the boundary?
17. Is the proposed execution command sufficiently bound and idempotent?

### Coordinator and product behavior

18. Can the coordinator restart safely and continue without duplicate work?
19. Are deterministic policy and LLM recommendation responsibilities
    separated?
20. Does assignment account for capability, workload, dependency, budget,
    context, and review cost?
21. Are DecisionPoints likely to interrupt the human only for strategic issues?
22. Can Project Resume and Portfolio Attention be built from the proposed
    state and projections?

### Program execution

23. Are phase dependencies and exit gates ordered correctly?
24. Is the proposed agent concurrency safe?
25. Are any workstreams likely to implement against unstable contracts?
26. Does the rollback strategy remain viable after V2 writes begin?
27. Are there missing security, operational, or acceptance gates before a real
    project pilot?

## Finding format

Return findings only in this structure:

```text
ID: REF-BLOCK-1
Tier: Blocking | Recommended | Open question
ADR/document/location:
Finding:
Why it matters:
Concrete failure scenario:
Recommendation:
Acceptance test:
```

Tier definitions:

- **Blocking:** Architecture would lose/corrupt state, break the trust boundary,
  prevent safe recovery, or cannot satisfy the charter MVP.
- **Recommended:** Material clarification or design change that improves
  reliability, security, maintainability, or human cognitive load. State
  whether it should land before Phase 1, at a later named gate, or is optional.
- **Open question:** A decision that cannot be resolved from repository
  evidence and needs explicit human product, risk, operational, or cost input.

If useful, include an internal severity mapping:

- `P0` for blocking.
- `P1` for material recommended changes likely to cause significant rework,
  unreliable execution, security exposure, or excessive human coordination.
- `P2` for valuable non-blocking clarification or later hardening.

A recommendation should not be labeled blocking solely because it is valuable.
Conversely, a migration or trust-boundary defect should not be softened into an
open question when the repository evidence demonstrates a failure mode.

After findings, provide:

```text
Verdict: Approve | Approve with required changes | Reject
Phase 1 blockers:
Decisions requiring the human:
Recommended changes before implementation:
```

## Disposition authority

- Sol may triage findings, accept them, propose remediation, and prepare a
  disposition matrix.
- Sol does not unilaterally close findings on Sol-authored architecture by
  rejecting them, lowering their severity, or deferring them beyond the
  reviewer’s recommended gate.
- Every proposed rejection, downgrade, or gate deferral is routed to the human
  with the reviewer’s original finding and Sol’s rationale shown side by side.
- The human records the final disposition.
- The original review and all disposition history remain immutable project
  records.

## Constraints

- Do not edit files.
- Do not produce implementation code.
- Do not replace the architecture with Temporal, a microservice fleet, or a
  transcript-as-state design without demonstrating a P0 necessity.
- Preserve the existing useful planning, runner-protocol, budgeting,
  verification, approval, and UI assets where compatible.
- Prefer explicit, testable recommendations over broad redesign language.

## Ready-to-paste reviewer prompt

> Act as the independent Claude Fable 5 Architecture and Product Reviewer for
> The Norns. Review the attached Program Charter, Phase 0 Architecture Review,
> ADR-004 through ADR-007, and Controlled Re-foundation Program against the
> attached current implementation files. This is a read-only phase gate: do
> not implement changes. The persistent-project direction is already approved,
> so focus on internal consistency, migration safety, runner trust boundaries,
> deterministic coordinator behavior, attention/read models, dependencies,
> and missing acceptance gates. Return findings tiered as blocking,
> recommended, or open questions using the exact
> structure in `REFOUNDATION-REVIEW-PACKET.md`, followed by a verdict, Phase 1
> blockers, human decisions, and required pre-implementation changes.

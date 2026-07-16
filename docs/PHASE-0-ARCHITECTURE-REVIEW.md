# Phase 0 Architecture Review

**Status:** Complete and approved · **Date:** 2026-07-16
**Scope:** Existing repository architecture against the Program Charter
**Implementation performed:** None

## Verdict

The repository is a strong prototype of planning, graph allocation, runner
protocol, budgeting, and verification primitives. It is not yet architected as
a persistent AI project operating system.

The live product currently centers on:

```text
Project → one replaceable Plan → one GraphSession
```

The approved target centers on:

```text
Project → Phases → Objectives → Tasks → Assignments → Runs
        → Decisions → Memory → Architecture history
```

The approved response is a controlled re-foundation that preserves useful
components rather than a rewrite.

## Strengths to preserve

- Shared Zod contracts and provider-neutral adapter interfaces.
- Deterministic task lifecycle reducer and explicit state transitions.
- Plan validation, dependency validation, and cycle rejection.
- Cross-provider planning review with structured findings and convergence.
- Server-authoritative allocation approval and stale-approval detection.
- Runner fencing, replay, deduplication, and correlation semantics.
- Infrastructure-produced verification evidence.
- Budget reservation semantics.
- Existing component and failure-path tests.

## Priority findings

### P0 — Project state is one replaceable plan

`ProjectStore` holds one nullable `GraphSession`; loading a plan replaces the
current plan and graph. The product cannot represent multiple phases or retain
completed-phase history.

### P0 — Plan and graph compete as sources of truth

The Plan Contract contains deliverables, acceptance, execution requirements,
inputs, outputs, and decisions. The graph retains only a subset. Graph edits do
not update the plan, so future execution can diverge from what the human
approved.

### P0 — Production execution is not integrated

Workflow, budget, execution, verification, coordination, and dashboard
components are composed manually in tests or in the scripted demo. Real
projects do not own a persistent workflow engine or resumable execution state.

### P0 — Persistence cannot support the charter

The current database contains whole-store JSONB snapshots flushed
periodically. It cannot atomically persist a task transition, budget change,
audit event, and dispatch job, nor can it efficiently produce portfolio and
project read models.

### P0 — Production approval semantics are incomplete

Allocation approval is stored, but loading a reviewed plan does not persist a
plan approval record or enforce its content hash through a production
execution start.

### P0 — Source connection is a false affordance

Local paths and GitHub URLs are stored as strings. No local runner workspace is
registered, no GitHub App is authorized, and no repository is actually
connected or analyzed.

### P0 — There is no Execution Mode or attention dashboard

The real-project UI ends at planning, allocation, and approval. The dashboard
is demo-only, and opening a project does not provide a resumable state summary.

## Important secondary findings

- Phase, Objective, Task, Agent, and Decision Point entities are absent.
- Planning versions and review history are discarded after the response.
- Project Memory is a prompt helper, not persisted project state.
- Agent assignment is a fixed heuristic rather than capability/workload-aware
  scheduling.
- The runner rejects real `launch_run` and verification commands.
- Repository, worktree, sandbox, and execution code currently sits on the
  server side of the intended trust boundary.
- Audit actions frequently use a hardcoded actor rather than the authenticated
  user.
- Large server and frontend modules mix unrelated responsibilities.
- Previous completion tracking conflates component implementation with
  production integration and deployed acceptance.

## MVP alignment at review

| Charter requirement | Review result |
|---|---|
| Open and understand an existing project | Partial |
| Create an additional project phase | Unsupported |
| Generate a phase execution strategy | Partial; replaces the project plan |
| Assign work intelligently | Partial; static heuristic |
| Monitor real execution centrally | Unsupported |
| Escalate only strategic decisions | Unsupported |
| Resume without context reconstruction | Unsupported |
| Operate as the primary AI coordinator | Unsupported in production |

## Approved architectural commitments

1. Persistent Project, Phase, Objective, and Task domain.
2. Strategy versions replace “plan as project.”
3. Task and TaskDependency are the only scheduling/graph source of truth.
4. Normalized PostgreSQL state with domain history and a transactional outbox.
5. Repository and execution ownership on the Local Runner.
6. Deterministic coordinator with LLMs used for proposals and summaries.
7. Project Resume and Portfolio Attention read models.
8. Existing users and projects migrate without destructive replacement.

## Governing decisions

- [ADR-004](adr/ADR-004-persistent-project-domain.md)
- [ADR-005](adr/ADR-005-persistence-events-outbox.md)
- [ADR-006](adr/ADR-006-repository-bindings-runner-ownership.md)
- [ADR-007](adr/ADR-007-coordinator-attention-read-models.md)
- [Re-foundation Program](REFOUNDATION-PROGRAM.md)
- [Claude Fable Review Packet](reviews/REFOUNDATION-REVIEW-PACKET.md)
- [Review Repository Map](reviews/REFOUNDATION-REPO-MAP.md)

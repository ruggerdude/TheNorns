# ADR-007: Coordinator, Project Resume, and Attention Read Models

**Status:** Accepted · **Date:** 2026-07-16
**Supersedes:** Planning/graph workspace as the default product mode
**Depends on:** ADR-004, ADR-005, ADR-006

## Context

The current UI and API organize a project around planning, graph allocation,
and approval. There is no production coordinator that schedules real project
work, and no project-scoped dashboard.

The Program Charter requires:

- Execution Mode as the default;
- deterministic, persistent coordination;
- intelligent but bounded concurrency;
- decision escalation;
- resumable project state;
- an executive dashboard that answers “What needs my attention?”

An LLM cannot be the authoritative scheduler or state store. It can analyze,
recommend, summarize, and generate structured proposals, while deterministic
services enforce state, dependencies, approvals, budgets, and dispatch.

## Decision

### 1. The coordinator is an application service

The coordinator owns orchestration policy and uses durable state.

Responsibilities:

- analyze active project/phase/task state;
- identify runnable tasks;
- enforce dependencies and approvals;
- select assignments from registered capabilities and policies;
- reserve budgets;
- enqueue dispatch jobs;
- monitor runner events and timeouts;
- route verification, review, and integration;
- create DecisionPoints;
- close phases;
- request memory and architecture updates.

The coordinator does not execute repository commands or modify worktrees.

### 2. Use an explicit coordinator loop

```text
Observe authoritative state
→ evaluate gates and dependencies
→ identify runnable work
→ choose assignment/concurrency
→ reserve budget
→ enqueue durable dispatch
→ observe run/evidence events
→ review/integrate/escalate
→ update projections
→ close task/phase
```

Each evaluation is idempotent. Coordinator restarts may repeat evaluation but
must not repeat committed dispatch or state transitions.

### 3. Separate deterministic policy from LLM recommendations

Deterministic services decide whether work is legally runnable.

LLM agents may:

- propose phase strategies;
- summarize repository and execution state;
- recommend agent assignments and rationale;
- classify risks;
- propose DecisionPoint options;
- review artifacts and evidence;
- propose memory or architecture updates.

LLM output is schema-validated and never directly mutates state without an
application command that enforces policy.

### 4. Assignment is capability and workload aware

Assignment considers:

- required role and tools;
- provider/runtime/model capabilities;
- task complexity and risk;
- context size and repository familiarity;
- active workload and runner availability;
- dependency criticality;
- cost and budget;
- expected review burden;
- data/security restrictions;
- previous failure and retry history.

Concurrency is limited by dependencies, shared components, integration cost,
runner capacity, budget, and review capacity. Agent count is not a success
metric.

### 5. DecisionPoints are the human-interruption mechanism

The coordinator creates a DecisionPoint only when:

- strategy or architecture requires human judgment;
- an approval gate is reached;
- budget must change;
- an exception to policy is requested;
- a merge conflict or integration choice is material;
- execution cannot continue safely;
- multiple valid options have meaningful strategic tradeoffs.

Routine retries, task routing, summaries, and status updates do not interrupt
the human.

Each DecisionPoint contains a recommended action and one clear primary action
in the UI.

### 6. Create a ProjectResumeView

`ProjectResumeView` is the default response when opening a project:

```text
project identity and health
source/repository health
current architecture summary
active phases
recent completed phases
objective progress
blocked and at-risk tasks
active assignments and runs
pending approvals
open decision points
recent decisions
budget health
recent activity and deliverables
next recommended action
```

It is a server-owned projection, not assembled from scattered client fetches.

### 7. Create a PortfolioAttentionView

The authenticated landing page consumes a portfolio projection ordered by:

1. Strategic decisions and approvals.
2. Blocked or at-risk phases.
3. Failed or degraded agent/runner activity.
4. Active projects and current phases.
5. Upcoming milestones or budget thresholds.
6. Recent completions.

Every attention item includes:

- why it matters;
- affected project/phase/task;
- urgency and blocking scope;
- coordinator recommendation;
- one primary action;
- evidence/audit details as drill-down.

User acknowledgement, snooze, or dismissal is persisted separately from the
rebuildable projection. Rebuilding Attention state must not resurrect an
acknowledged informational item unless its authoritative source changes.

Project inventory and search remain available but are not the dashboard.

### 8. Use stable routes and live projections

The web application uses stable URLs:

```text
/attention
/projects
/projects/:projectId
/projects/:projectId/phases
/projects/:projectId/phases/:phaseId
/projects/:projectId/decisions
/projects/:projectId/memory
/agents
/integrations
/settings
```

Execution updates arrive through an authenticated event stream or bounded
polling protocol backed by server projections. Client-local state is not the
source of truth.

### 9. Make phase proposal review strategic

The primary review hierarchy is:

1. Intended outcome and success measures.
2. Change from current project state.
3. Architecture impact.
4. Open human decisions.
5. Assumptions, risks, and mitigations.
6. Critical path and dependency strategy.
7. Recommended agents, concurrency, budget, and review.
8. Detailed tasks and acceptance criteria as drill-down evidence.

Humans are not required to line-edit every tactical acceptance criterion to
operate the system.

## Application commands and APIs

Representative commands:

- `CreateProject`
- `ImportRepository`
- `ProposePhase`
- `ApproveStrategyVersion`
- `StartPhase`
- `ResolveDecisionPoint`
- `PausePhase`
- `ExtendBudget`
- `RetryTask`
- `CancelTask`
- `ApproveIntegration`
- `ClosePhase`

Representative read APIs:

- `GET /api/attention`
- `GET /api/projects/:id/resume`
- `GET /api/projects/:id/phases`
- `GET /api/phases/:id`
- `GET /api/phases/:id/tasks`
- `GET /api/projects/:id/decisions`
- `GET /api/projects/:id/memory`
- `GET /api/agents`
- `GET /api/runners`

Mutation endpoints return command identity and committed state/version.
Long-running work returns asynchronous status rather than holding one HTTP
request open.

## Alternatives rejected

### Use the PM chat transcript as project state

Transcripts are valuable artifacts but are not structured, transactional, or
safe scheduling state.

### Keep the graph workspace as the project home

A dependency graph cannot summarize architecture, decisions, phase history,
active agents, budget, or the next strategic action.

### Let one LLM coordinate everything

This creates non-deterministic scheduling, weak recovery, difficult audit, and
unreliable enforcement of approvals and budgets.

### Build a full external workflow platform immediately

The MVP requires a clear coordinator loop and durable outbox, but not the
operational cost of a second orchestration platform before the vertical slice
is proven.

## Consequences

- Planning becomes a phase action rather than the default project screen.
- The existing graph remains a useful task-dependency view.
- Dashboard work depends on domain and projection contracts.
- Frontend routing, API state management, and live-update architecture must be
  introduced.
- Attention ranking and DecisionPoint policy become testable product logic.

## Acceptance criteria

1. “Open Project X” returns a complete ProjectResumeView after restart.
2. “Create a phase to add animations” creates a proposal without changing
   completed phases.
3. The coordinator dispatches only tasks whose dependencies, approvals,
   runner, repository, and budget gates are satisfied.
4. Re-running coordinator evaluation does not duplicate dispatch.
5. Routine task execution proceeds without human interaction.
6. A strategic blocker creates one DecisionPoint with a recommendation and
   declared blocking scope.
7. The Attention view prioritizes unresolved decisions and blocked work over
   ordinary project inventory.
8. Live task/run updates appear without requiring manual page refresh.
9. Phase closure updates project state, memory, architecture history, and
   attention projections.

# ADR-004: Persistent Project Domain

**Status:** Accepted · **Date:** 2026-07-16
**Supersedes:** The plan-as-project lifecycle in the R4 MVP PRD
**Depends on:** ADR-001 shared-contract discipline

## Context

The live project model currently stores metadata and one nullable
`GraphSession`. A `GraphSession` contains one mutable Plan Contract, one graph,
and one allocation approval. Loading another plan replaces the plan and graph.

That design was sufficient to demonstrate planning and allocation, but it
cannot support the Program Charter:

- Projects must survive many plans and phases.
- Completed work and prior decisions must remain queryable.
- A new request such as “add animations” must append a phase rather than
  replace the project.
- Opening a project must reconstruct execution and decision state.
- The graph cannot be a second mutable representation of execution work.

## Decision

### 1. Project is the long-lived aggregate

`Project` owns identity and durable operating context:

- metadata and status;
- repository binding;
- coordinator and model-selection policy;
- architecture baseline/current revision;
- project-level verification policy;
- budget policy;
- active and completed phase references;
- creation, update, archival, and aggregate version.

Project status describes the living project, not whether a plan exists:

```text
initializing | active | paused | blocked | completed | archived
```

### 2. Phase is the bounded unit of change

A `Phase` belongs to one Project and has:

- objective summary;
- priority and phase dependencies;
- status;
- strategy versions;
- approved budget;
- start/closure timestamps;
- closure summary and evidence references.

Initial lifecycle:

```text
proposed
→ awaiting_approval
→ approved
→ active
→ blocked | completed | cancelled
```

`blocked` can resume to `active`. A completed phase is immutable except for
explicit corrective records or superseding metadata.

Multiple phases may be active when their explicit dependencies, repository
conflict policy, budget, and coordinator capacity allow it. Concurrency is a
policy decision, not an implicit consequence of phase creation.

The schema supports multiple active phases. The MVP runtime default is a
separate human-approved policy decision recorded as `REF-OPEN-3`; changing
that default later does not require a data migration.

### 3. Objective is measurable

An `Objective` belongs to a Phase and contains:

- outcome statement;
- success measures;
- status;
- completion evidence;
- ordering and optional dependency information.

An objective is not merely the plan’s free-form `objective` string.

### 4. Task is the canonical executable entity

A `Task` contains:

- project, phase, and objective identity;
- title and description;
- deliverables and acceptance criteria;
- complexity and risk;
- execution and environment requirements;
- required inputs and expected outputs;
- lifecycle state;
- assignment and run references;
- optimistic version.

`TaskDependency` is the canonical dependency edge. The task graph displayed in
the UI and consumed by the scheduler is a projection of Tasks and
TaskDependencies. No separate mutable graph may diverge from task records.

For the MVP, TaskDependencies are phase-local. Work that must precede work in
another phase is represented by a Phase dependency. A TaskDependency whose
predecessor and successor have different `phase_id` values is rejected by the
contract and database boundary.

The existing Plan Module lifecycle reducer may be adapted into the Task
lifecycle, but task identifiers must be globally stable rather than phase-local
slugs.

### 5. Plans become immutable StrategyVersions

A planning run produces a `StrategyVersion` associated with one Phase.

It retains:

- the proposed objectives and tasks;
- assumptions, risks, and scope boundaries;
- architecture impact;
- proposed assignments, concurrency, and budget;
- every planning version;
- reviewer findings and dispositions;
- provider/model provenance;
- convergence state;
- content hash and approval.

Approval materializes the selected strategy into canonical Objective, Task,
TaskDependency, and initial AgentAssignment records in one transaction.
Changing an active phase requires an explicit amendment version; it does not
silently mutate the approved strategy.

`ApproveStrategyVersion` is a server-enforced invariant, not a client
affordance. It rejects a StrategyVersion whose planning review did not
converge or that retains any unresolved must-fix finding. There is no
override command. The human may choose to revise scope, authorize another
review round, or stop the phase through a DecisionPoint, but executable Tasks
are created only from a newly converged StrategyVersion.

### 6. Agent identity, assignment, and execution are distinct

- `AgentProfile` describes provider, runtime, model, roles, capabilities,
  context limits, security restrictions, availability, and cost metadata.
- `AgentAssignment` records the agent selected for a task, rationale, budget,
  reviewer, allocation policy, and assignment status.
- `AgentRun` records an individual attempt, runner, runtime session, worktree,
  commit, usage, artifacts, evidence, result, and failure information.

This prevents “agent,” “model,” “assignment,” and “run” from being treated as
the same concept.

Every AgentAssignment must include a non-empty rationale that records the
capability, workload, dependency, risk, budget, and review factors material to
the selection.

Task and AgentRun have separate state machines:

```text
Task:
pending → ready → assigned → in_progress → verifying → in_review → completed
             ↘ blocked | failed | cancelled

AgentRun:
created → dispatched → running → verifying → succeeded
                       ↘ failed | cancelled | expired
```

The Phase 1 V2 contracts freeze the complete transition tables and the
Task-from-AgentRun projection. The governing rules are:

- exactly one run is the designated active attempt for a Task at a time;
- `superseded` is a projection designation, not a replacement lifecycle
  outcome: the run retains its original state/result plus `superseded_at` and
  `superseded_by_run_id`;
- a superseded run remains immutable history and cannot move Task state;
- the designated run in `created`, `dispatched`, or `running` projects the
  Task to `in_progress`;
- `verifying` projects the Task to `verifying`;
- `succeeded` moves the Task to `in_review` only when required
  infrastructure-produced verification evidence is green;
- retry creates a new AgentRun and returns the Task to `in_progress`;
- a failed attempt with no authorized retry moves the Task to `blocked` or
  `failed` according to recorded policy;
- `completed` requires recorded review and integration/completion evidence;
  no run self-report can directly create a terminal Task state.

### 7. Decision points are first-class

`DecisionPoint` records:

- question and context;
- options;
- coordinator recommendation;
- impact, urgency, and risk;
- blocking scope;
- status and timestamps.

Resolution creates an immutable `DecisionRecord` linked to the deciding human,
approval evidence, affected entities, rationale, and any record it supersedes.

### 8. Project Memory is typed and scoped

Memory categories:

```text
directive
constraint
decision
lesson
architecture
phase_completion
repository_fact
```

Every entry has:

- project and optional phase/task scope;
- provenance and source;
- version and supersession;
- active/obsolete status;
- creation timestamp;
- approval status where required.

Directives and strategic decisions require human approval. Routine observed
repository facts may be recorded automatically with provenance and confidence.

## Domain invariants

1. A Phase cannot execute without an approved StrategyVersion.
2. Strategy approval and task materialization are atomic.
3. Every Task belongs to exactly one Project, Phase, and primary Objective.
4. Task dependencies cannot cross projects or phases and must remain acyclic
   within their Phase. Cross-phase sequencing uses Phase dependencies only.
5. The graph is never independently persisted as editable canonical state.
6. Completed phases and their approved strategy/evidence are immutable.
7. A blocking DecisionPoint blocks only its declared scope.
8. Assignments reference registered AgentProfiles.
9. Runs never mutate strategy history.
10. Project summaries use active DecisionRecords and Memory entries only.
11. A non-converged StrategyVersion or one with unresolved must-fix findings
    cannot be approved or materialized through any server command.

## Migration

Each legacy `ProjectStore` record becomes:

- one Project;
- one imported initial Phase if a plan exists;
- one StrategyVersion containing the existing plan;
- Objectives/Tasks derived from plan modules;
- TaskDependencies derived from the current graph, because the graph reflects
  the latest human edits;
- AgentAssignments derived from graph assignments;
- allocation approval preserved as approval evidence;
- source string preserved as unverified legacy source metadata until converted
  to a RepositoryBinding.

If the plan and graph disagree, migration records a reconciliation finding and
requires review before execution. It must not silently guess.

The migration reconciliation predicate is machine-checkable and compares:

- plan module IDs against graph node IDs, including graph-only nodes and
  deleted modules;
- dependency edges;
- assignments and allocation metadata;
- acceptance-criteria cardinality and content;
- approval fingerprints against the exact imported structure.

Each mismatch creates a distinct finding. Imported audit records use
`actor_type = legacy` unless an authenticated historical actor is provable.

## Alternatives rejected

### Keep GraphSession and add an array of plans

This retains plan/graph dual truth and cannot model execution history,
decisions, assignments, or memory coherently.

### Create one independent graph per phase

This improves phase history but still leaves tasks and graphs as competing
execution representations.

### Model every concept as a generic WorkItem

A generic entity reduces schema count but hides important invariants between
phases, objectives, tasks, decisions, assignments, and runs.

### Rewrite the product from scratch

The repository already contains valuable contracts and execution primitives.
A staged migration has lower risk and preserves verified behavior.

## Consequences

- The Plan Contract remains useful as a strategy interchange format, but no
  longer owns project state.
- `GraphSession` and `ProjectStatus = draft | planned` become legacy.
- Project and phase APIs must be introduced before execution UI can be built.
- Existing graph tests will be adapted to TaskDependency projection tests.
- Contract versioning must permit legacy snapshots during migration.

## Acceptance criteria

1. A project can contain two phases without modifying the first phase.
2. Completed phase strategy, tasks, assignments, evidence, and decisions remain
   queryable.
3. Task graph edits and scheduler reads use the same TaskDependency records.
4. An unapproved, non-converged, or unresolved-must-fix StrategyVersion cannot
   create executable tasks, and no override path exists.
5. Opening a migrated project preserves its plan, graph edits, assignments,
   source metadata, and approval evidence.
6. Decision points and memory entries survive process restart.
7. No public production path creates or replaces a project-wide GraphSession.
8. A cross-phase TaskDependency is rejected at the contract and persistence
   boundaries.
9. Reducer tests enumerate every AgentRun transition and its projected Task
   state; no run event sequence can create an unreachable Task state.
10. Migration fixtures containing graph-only nodes, deleted modules, changed
    edges, changed assignments, and stale approvals produce distinct,
    reviewable reconciliation findings.

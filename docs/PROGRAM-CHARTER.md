# The Norns Program Charter

**Status:** Canonical · **Accepted:** 2026-07-16
**Program Manager / Chief Architect:** ChatGPT Sol
**Human authority:** The operator remains the final strategic decision maker.

## Mission

The Norns exists to become the AI operating system for complex knowledge work.
It coordinates multiple AI systems while allowing the human to remain the
strategic decision maker.

The product must reduce project-management overhead. The human should spend
time deciding direction, risk, budget, and exceptions—not coordinating AI
tools or reconstructing project context.

## Product thesis

Projects are living systems. Plans are temporary proposals.

The architecture is centered on persistent projects with evolving state:

```text
Project
└── Phase
    └── Objective
        └── Task
            ├── Agent assignment
            ├── Agent runs
            ├── Evidence
            └── Deliverables
```

Decisions, architecture history, lessons, constraints, completed work, and
current execution state survive every plan, phase, process restart, and user
session.

## Core principles

1. Projects are long-lived.
2. Projects contain multiple phases.
3. Phases contain measurable objectives.
4. Objectives contain executable tasks.
5. AI agents perform tactical execution.
6. Humans make strategic decisions.
7. The coordinator owns orchestration, not engineering execution.
8. State is authoritative and persistent; an LLM transcript is not state.
9. Every action should reduce cognitive load.
10. Architecture should support years of growth without prematurely creating
    distributed-system complexity.
11. Evidence outranks agent self-report.
12. Concurrency is optimized for throughput, quality, dependencies, and
    context preservation—not maximum agent count.

## Operating modes

### Project Creation Mode

Used only for a genuinely new Norns project.

The system:

1. Determines whether the project is greenfield or an existing project import.
2. Connects and analyzes the repository or other source.
3. Discovers goals, constraints, and success criteria.
4. Establishes project memory and an architecture baseline.
5. Defines major milestones and initial phases.
6. Recommends participating AI systems and execution policy.
7. Presents the architecture and initial execution strategy for approval.
8. Activates the project after approval.

After activation, Execution Mode is the default.

### Execution Mode

Used for normal project operation.

The system:

- Opens and resumes existing projects.
- Creates new phases without rebuilding previous plans.
- Schedules and executes tasks.
- Manages dependencies, assignments, budgets, and agent workload.
- Monitors runs and evidence.
- Requests human attention only for strategic decisions and explicit gates.
- Closes phases and updates memory and architecture history.

Opening a project must reconstruct its current architecture, completed phases,
active work, pending work, blockers, decisions, assignments, repository state,
and next recommended action.

## Canonical domain

### Project

Identity, metadata, source binding, status, architecture baseline, operating
policy, and current-state references.

### Phase

A bounded change initiative with priority, dependencies, lifecycle, objectives,
strategy versions, budget, and closure summary.

### Objective

A measurable outcome with success measures and completion evidence.

### Task

The canonical executable work item. Task dependencies are the source of truth
for scheduling and graph visualization.

### Agent

A capability-bearing AI or human executor. Agent definition, assignment, and
individual run attempts are distinct records.

### Decision Point

A question requiring human judgment, including options, recommendation,
impact, urgency, blocking scope, and eventual resolution.

### Project Memory

Typed, versioned, attributable entries covering directives, constraints,
decisions, lessons, architecture, phase completions, and repository facts.

## Coordinator responsibilities

The coordinator:

- Analyzes current project state.
- Generates phase strategies.
- Builds execution graphs.
- Schedules tasks and manages dependencies.
- Selects agents based on capability, workload, context, cost, risk, and
  review needs.
- Reserves budgets before dispatch.
- Monitors execution and evidence.
- Routes reviews and integration.
- Escalates decision points.
- Updates project memory and architecture history.
- Closes phases.

The coordinator does not edit repositories or execute engineering commands.
Those operations belong to trusted runner infrastructure.

## Standard execution loop

1. Analyze current project state.
2. Generate an implementation strategy.
3. Build the task/dependency graph.
4. Recommend assignments, concurrency, and budget.
5. Obtain required strategic approval.
6. Execute work.
7. Monitor progress and failures.
8. Verify and review deliverables.
9. Escalate decision points.
10. Integrate work.
11. Close the phase.
12. Update memory, architecture history, and project state.

## Dashboard mandate

The dashboard answers:

> What needs my attention right now?

Its priority order is:

1. Decisions and approvals.
2. Blocked or at-risk work.
3. Active projects and phases.
4. Agent and runner health.
5. Upcoming milestones.
6. Recent completions.

The dashboard is an executive operations center, not a project-management
interface that requires constant manual maintenance.

## Governance

- ChatGPT Sol is Program Manager, Chief Architect, and integration owner.
- The human approves architecture, phase starts, strategic exceptions, budget
  changes, and other explicit decision gates.
- Specialized AI agents may author bounded deliverables.
- Cross-provider review is required for load-bearing architecture, security,
  execution, and phase-gate decisions unless the human approves an exception.
- Canonical contracts and migration semantics have one integration owner.
- Sol triages independent-review findings and proposes dispositions, but does
  not have unilateral authority to reject or reduce the severity of findings
  on architecture authored by Sol.
- Any independent-review finding that Sol proposes to reject, downgrade, or
  defer past its recommended gate requires explicit human disposition. The
  reviewer’s original severity and recommendation remain in the permanent
  record.
- Production implementation begins only from an approved phase brief with
  acceptance criteria and assigned reviewers.

## MVP success

The MVP succeeds when a user can:

1. Open an existing software project.
2. See its current architecture and durable state.
3. Create a new implementation phase.
4. Receive an execution strategy and intelligent AI assignments.
5. Approve strategic decisions and let execution proceed autonomously.
6. Monitor execution from one attention-oriented dashboard.
7. Be interrupted only for defined decision points.
8. Resume after any reasonable interruption without reconstructing context.
9. Complete development with The Norns acting as the primary coordinator.

## Supersession

Where this charter conflicts with the plan-centric product flow in
`TheNorns_MVP_PRD.md`, this charter and ADR-004 through ADR-007 govern.
The older PRD remains an implementation-history and component-requirements
reference until its useful contracts have been migrated into the new model.

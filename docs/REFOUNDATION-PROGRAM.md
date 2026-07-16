# The Norns Controlled Re-foundation Program

**Status:** Architecture approved; implementation program awaiting execution
authorization
**Date:** 2026-07-16
**Program Manager / Chief Architect / Integration Owner:** ChatGPT Sol
**Governing charter:** [PROGRAM-CHARTER.md](PROGRAM-CHARTER.md)
**Architecture decisions:** ADR-004 through ADR-007
**Independent review packet:**
[reviews/REFOUNDATION-REVIEW-PACKET.md](reviews/REFOUNDATION-REVIEW-PACKET.md)
**Review code map:**
[reviews/REFOUNDATION-REPO-MAP.md](reviews/REFOUNDATION-REPO-MAP.md)

## Objective

Transform the existing plan-centric prototype into the Program Charter MVP
without discarding the repository’s verified planning, graph, runner protocol,
budget, verification, authentication, and UI assets.

The program is a staged strangler migration, not a rewrite or big-bang cutover.
Existing users, sessions, projects, plans, graph edits, assignments, approvals,
and source metadata remain available throughout migration.

## Program controls

1. Production data is never destructively replaced as part of migration.
2. Database changes remain additive until a separate retirement approval.
3. Existing user and project IDs are preserved.
4. Raw legacy snapshots are archived and checksummed before transformation.
5. New domain/API contracts are versioned alongside legacy contracts.
6. Task is the canonical execution entity; graphs are projections.
7. The coordinator decides what, when, and who. Provider adapters and the Local
   Runner execute how.
8. Status reporting distinguishes:

   ```text
   designed
   implemented
   integrated
   deployed
   acceptance-tested
   ```

9. No phase passes solely because component tests are green.
10. Production-shaped exit gates use PostgreSQL, public application commands,
    relay protocol, and a real Local Runner.
11. Canonical contracts and migrations have one writer/integration owner at a
    time.
12. New functionality ships behind reversible capability flags until its phase
    exit gate passes.

## Workstreams

### Workstream A — Architecture and Technical Debt

Owns:

- ADRs and bounded-context boundaries;
- contract governance;
- architectural fitness tests;
- truthful capability/status reporting;
- legacy retirement;
- cross-workstream design review;
- security and trust-boundary consistency.

A is a gatekeeper, not a high-volume implementation team.

### Workstream B — Domain Model and Persistence

Owns:

- Project, Phase, Objective, Task, TaskDependency;
- StrategyVersion and planning history;
- DecisionPoint, DecisionRecord, Approval;
- Project Memory and ArchitectureRevision;
- AgentProfile, AgentAssignment, AgentRun;
- normalized PostgreSQL schema and repositories;
- migrations, events, audit, outbox, budgets, and compatibility import.

B is the only workstream permitted to define core domain invariants or change
the canonical schema.

### Workstream C — Coordinator Engine

Owns:

- phase lifecycle;
- dependency scheduling;
- assignment and concurrency policy;
- durable dispatch;
- retries, stalls, pause/cancel, and escalation;
- verification/review/integration routing;
- phase closure;
- Project Resume and Attention projection logic;
- crash recovery.

C uses B’s application interfaces and does not write domain tables directly.

### Workstream D — Dashboard and Interaction Model

Owns:

- Portfolio Attention;
- Project Resume and Overview;
- phase proposal review;
- task/execution views;
- unified decisions and approvals;
- agent/runner visibility;
- accessibility and responsive behavior;
- live-update presentation.

D consumes purpose-built read models. It does not reconstruct project truth in
the browser.

### Workstream E — AI, Source, and Runner Integration

Owns:

- provider/model registry and capability profiles;
- planning/review/context adapters;
- GitHub App integration;
- Local Runner workspace registry;
- repository ingestion;
- Claude/Codex runtime adapters;
- worktrees, sandbox, verification, integration, and artifacts;
- provider usage normalization.

E implements adapters and execution mechanisms. It does not own coordinator
policy or approval rules.

## Agent roster and model policy

Model guidance was revalidated on 2026-07-16 against the
[OpenAI model catalog](https://developers.openai.com/api/docs/models), the
[Codex multi-agent guidance](https://learn.chatgpt.com/docs/agent-configuration/subagents),
and the
[Anthropic model overview](https://platform.claude.com/docs/en/about-claude/models/overview).

Roles and capability tiers are durable. Exact model IDs remain configuration
and are revalidated at every phase gate.

| Role | Primary model/surface | Reasoning | Authority |
|---|---|---:|---|
| Program Manager, Chief Architect, integration owner | ChatGPT Sol / `gpt-5.6-sol`; `gpt-5.6` in Codex surfaces | Maximum for architecture/gates; high for routine coordination | Charter alignment, ADRs, sequencing, canonical-contract approval, integration, proposed findings disposition, phase closure |
| Independent architecture/product reviewer | Claude Fable 5 / `claude-fable-5` | Maximum | Cross-provider adversarial review of Sol-authored architecture, coordinator policy, security posture, and gate evidence |
| Backend/control-plane lead | Claude Sonnet 5 / `claude-sonnet-5` | High for persistence/concurrency; medium otherwise | Domain implementation, migrations, command handlers, coordinator services, read models |
| Runner/integration/security lead | Codex with `gpt-5.6` at high; API-pinned agentic jobs may use `gpt-5.3-codex` | High or xhigh for races/security | Runner, repository, sandbox, runtime, dispatch, verification, integration, failure injection |
| Frontend/execution-UX lead | Claude Sonnet 5 / `claude-sonnet-5` | High for state workflows; medium for component work | Attention, Resume, phase review, execution, decisions, accessibility |
| Read-heavy exploration/support | GPT-5.6 Terra / `gpt-5.6-terra` | Medium | Bounded repository scans, document comparison, supporting analysis |
| Mechanical support | Claude Haiku 4.5 / `claude-haiku-4-5-20251001` | Low | Fixtures, repetitive cases, formatting, tightly specified low-risk work |

### Agent operating rules

- Sol coordinates and reviews; Sol is not the default implementation worker.
- Maximum three implementation agents run concurrently: normally backend,
  runner, and frontend.
- Review agents start only after the relevant artifact is frozen.
- Anthropic-authored implementation receives OpenAI/Codex review.
- OpenAI/Codex-authored implementation receives Claude Fable or Sonnet review.
- Agents do not co-author the same migration, contract, or core file.
- Work is divided by stable interfaces and separate branches/worktrees.
- After two failed attempts on the same problem, execution stops for design
  review. Additional agents are not used to hide an unresolved architecture
  issue.
- Sol may accept findings and prepare remediation. Rejection, severity
  downgrade, or deferral past the reviewer’s recommended gate requires the
  human’s explicit decision and retains the original finding in the record.
- The human remains the final approval authority.

## Phase 0 — Architecture lock and delivery baseline

### 0.1 Truthful baseline

- Freeze unrelated feature expansion.
- Inventory production, demo-only, and test-only capabilities.
- Record the existing database and snapshot shapes.
- Adopt the program status vocabulary.
- Identify legacy APIs/components that cannot be treated as production MVP.

### 0.2 ADR package

- Persistent project domain.
- Normalized persistence/events/outbox.
- Repository bindings and runner ownership.
- Coordinator, Resume, and Attention read models.

### 0.3 Initial contract map

Define the contract work required for:

- Project, Phase, Objective, Task, TaskDependency;
- StrategyVersion;
- AgentProfile, AgentAssignment, AgentRun;
- DecisionPoint, DecisionRecord;
- ProjectMemoryEntry, ArchitectureRevision;
- application commands and domain events;
- runner execution envelopes.

### 0.4 Acceptance-harness specification

Specify:

- legacy-import fixtures;
- contract compatibility tests;
- migration reconciliation;
- restart and duplicate-delivery tests;
- Project Resume tests;
- coordinator-to-runner execution;
- DecisionPoint escalation;
- backup, restore, and rollback drills.

### Ownership

- Primary: Sol.
- Feasibility input: Backend Sonnet and Codex.
- Independent review: Claude Fable 5.
- Approval: Human.

### Exit gate

- Charter and ADRs accepted.
- Every canonical entity has an owner and invariant definition.
- Migration and rollback policies are documented.
- Task is unambiguously the execution source of truth.
- End-to-end acceptance scenarios exist before implementation starts.
- Independent-review findings are recorded; every blocking finding, every
  material recommendation assigned to the Phase 1 gate, and every proposed
  rejection, downgrade, or gate deferral have human disposition.

## Phase 1 — Domain and persistence foundation

### 1.1 Versioned domain contracts

- Introduce V2 entities and commands alongside legacy contracts.
- Define task and run lifecycle transitions.
- Define approval/staleness rules.
- Define event schemas and versioning policy.

### 1.2 Normalized schema

Add tables for the canonical domain, events, audit, budgets, evidence, outbox,
migration ledger, and legacy ID mapping.

### 1.3 Transactional application boundary

Command transactions atomically update:

- canonical state;
- domain/audit events;
- optimistic versions;
- budget reservations;
- required outbox jobs.

### 1.4 Compatibility repositories

Existing APIs operate through repository/application interfaces while storage
can be switched between legacy and relational implementations.

### Ownership

- Primary: Backend Sonnet 5.
- Contract/integration owner: Sol.
- Migration, race, and crash tests: Codex.
- Repetitive fixtures after schema freeze: Haiku.
- Independent gate review: Codex plus Sol architecture review.

### Exit gate

- Schema deploys without altering or deleting legacy data.
- Domain invariants pass without HTTP/UI dependencies.
- State and outbox writes are atomic.
- Optimistic-concurrency conflicts are explicit.
- Backup and restore are exercised in a production-like environment.

## Phase 2 — User and project preservation migration

### 2.1 Recovery checkpoint

- Create a database backup/PITR marker.
- Archive raw users/projects/relay snapshots.
- Record source hashes, object counts, and application version.

### 2.2 Identity migration

Preserve:

- user IDs, email addresses, names, roles, and admin status;
- password hashes and creation metadata;
- active sessions where safely possible;
- invitation state with improved token hashing.

No shared deployment token is reintroduced as a login requirement.

### 2.3 Project migration

Preserve:

- project IDs and timestamps;
- names/descriptions;
- PM provider/model selections;
- source metadata;
- plan and graph payloads;
- assignments and approval evidence.

Raw paths/URLs become unverified RepositoryBinding candidates.

### 2.4 Plan/graph reconciliation

For each planned legacy project:

1. Create an imported initial Phase.
2. Preserve the original plan as a StrategyVersion.
3. Materialize tasks and acceptance data.
4. Use the graph for current dependency/assignment state.
5. Create reconciliation findings for plan/graph disagreement.
6. Preserve valid approval evidence.
7. Require reapproval when hashes or structures disagree.

### 2.5 Shadow/canary cutover

- Compare legacy and relational reads.
- Cut over internal/admin projects first.
- Retain tested read/write switches through the rollback window.

### Ownership

- Primary: Backend Sonnet 5.
- Reconciliation and rollback verification: Codex.
- Policy/adjudication: Sol.
- Independent review: Claude Fable 5 for migration semantics.
- Final migration authorization: Human.

### Exit gate

- Every user/project is accounted for.
- No unexplained ID, count, checksum, or reference mismatch.
- Admin/member login continuity is verified.
- Every project has a reconciliation report.
- Cutover and rollback switches work.
- No legacy snapshot is deleted.

## Phase 3 — Existing-project import and persistent phase workflow

### 3.1 Source binding

Local:

- register runner-approved workspace roots;
- select opaque repository IDs;
- validate repository and required commands.

GitHub:

- authorize GitHub App installation;
- select repository from an authorized picker;
- create a durable binding and runner checkout.

### 3.2 Repository ingestion

Create:

- initial ArchitectureRevision;
- repository facts;
- build/test/lint policy;
- constraints/directives;
- repository health;
- Project Resume seed.

### 3.3 Phase lifecycle and strategies

- Create a phase without modifying historical phases.
- Generate and retain StrategyVersions.
- Approve a specific version/hash.
- Materialize Objectives, Tasks, and dependencies.

### 3.4 Project Resume projection

Return current architecture, phases, objectives, task state, active agents,
decisions, approvals, budget, repository health, recent completion, and next
recommended action.

### Ownership

- Binding/ingestion APIs: Backend Sonnet 5.
- Local workspace and repository operations: Codex.
- GitHub security review: Codex.
- Minimal frontend flows after contracts freeze: Frontend Sonnet 5.
- Policy and memory review: Sol.

### Exit gate

A migrated project can be opened, understood, and given a new phase without
changing its imported history, IDs, or architecture record.

## Phase 4 — Coordinator-to-runner vertical slice

### 4.1 Coordinator commands

Implement:

- approve/start phase;
- schedule/assign task;
- dispatch, pause, retry, cancel;
- record verification/review/integration;
- request/resolve decisions;
- close phase and update memory.

### 4.2 Durable scheduling

- dependency-aware readiness;
- transactional outbox;
- leasing, fencing, and idempotency;
- budget reservation;
- retry/dead-letter policy;
- stuck-run detection;
- project pause and kill switch.

### 4.3 Runner execution

Move runner-owned code to the correct boundary and execute:

- repository worktree;
- sandbox;
- Claude/Codex runtime;
- exact-commit verification;
- artifact collection;
- structured events.

The server executes no repository shell commands.

### 4.4 Review, integration, closure

- infrastructure evidence gates review;
- reviewed output gates integration;
- failure produces retry, rework, blocker, or DecisionPoint;
- task completion updates phase progress;
- phase closure updates memory and architecture.

### 4.5 Recovery matrix

Restart server, coordinator, relay, and runner at meaningful lifecycle points.
Verify no lost work, duplicate execution, budget drift, or stale-runner action.

### Ownership

- Coordinator semantics: Sol.
- Control-plane implementation: Backend Sonnet 5.
- Dispatch/runner/verification/recovery: Codex.
- Minimal observability: Frontend Sonnet 5.
- Independent design/execution review: Claude Fable 5.

### Exit gate

One task completes through production-shaped APIs:

```text
ready
→ assigned
→ durable dispatch
→ runner execution
→ verification
→ review
→ integration/completion
→ memory update
→ correct resume after restart
```

The existing manually composed in-process pilot test does not satisfy this
gate.

## Phase 5 — Attention-first Execution Mode

### 5.1 Portfolio Attention

Rank strategic decisions, approvals, blockers, failed/stalled runs, budget
exceptions, milestones, and material completions.

### 5.2 Project Overview

Show current phase/objective, health, active agents, recent progress, blockers,
decisions, and next recommended action.

### 5.3 Phase Execution

Show tasks/dependencies, assignments/runs, evidence, failures, retries, and
deliverables. The graph is an optional view.

### 5.4 Decision and approval inbox

Each item explains what happened, why judgment is required, recommendation,
tradeoffs, impact, and what resumes after resolution.

### 5.5 Live updates

Use project-scoped events or bounded polling against server projections.

### Ownership

- Information architecture: Claude Fable 5 under Sol’s charter constraints.
- UI implementation: Frontend Sonnet 5.
- Read models: Backend Sonnet 5.
- E2E/accessibility/stale-state testing: Codex.
- Product gate: Sol and Human.

### Exit gate

The landing page answers “What needs my attention?”, a project resumes in one
action, and a real phase can be monitored without manual context reconstruction
or demo endpoints.

## Phase 6 — Multi-agent autonomous coordination

### 6.1 Agent capability registry

Profiles record provider/model/runtime, roles, context, tools, permissions,
cost/latency, availability, workload, and security constraints.

### 6.2 Intelligent allocation

Assignment considers capability fit, complexity/risk, context, critical path,
review needs, workload, runner capacity, budget, and prior failures.

### 6.3 Safe concurrency

- only dependency-ready work runs;
- repository/shared-component conflict risk is considered;
- project/runner/provider concurrency caps apply;
- integration/review capacity limits fan-out;
- fewer capable agents are preferred when coordination cost dominates.

### 6.4 Review and escalation

Support specialized architecture, frontend, backend, security, testing,
documentation, integration, and code-quality assignments without hard-coding
roles to one model.

### 6.5 Memory and architecture updates

Phase closure records approved decisions, architecture changes, lessons,
repository facts, and outcomes with provenance and supersession.

### Ownership

- Semantics/integration: Sol.
- Coordinator services/registry: Backend Sonnet 5.
- Runner multiplexing/failure testing: Codex.
- Temporary additional Sonnet worker: isolated simulation/test harness only.
- Independent gate review: Claude Fable 5.

### Exit gate

A production-shaped phase executes dependent and parallel tasks across at
least two provider families, handles failure and reviewer rework, escalates one
real strategic decision, stays within budget, and resumes after restart.

## Phase 7 — Hardening, pilot, and legacy retirement

### 7.1 Security and resilience

- load/soak/chaos tests;
- database restore;
- runner revocation and stale-generation tests;
- secrets and permissions;
- audit completeness;
- stuck-run/alert behavior.

### 7.2 Existing-project pilot

Run source connection, new phase, execution, decisions, closure, memory update,
and later resume on a real existing project.

### 7.3 Progressive cutover

- internal/admin project;
- selected migrated projects;
- new projects by default;
- remaining projects after reconciliation;
- legacy APIs become read-only before removal.

### 7.4 Separate retirement approval

Legacy snapshots and compatibility code are removed only after:

- restore and rollback evidence;
- retention-window completion;
- no unresolved migration discrepancy;
- human approval.

### Ownership

- Attack/recovery testing: Codex.
- Remediation: Backend and Frontend Sonnet 5.
- Program orchestration/evidence: Sol.
- Independent security/resilience review: Claude Fable 5.
- Final acceptance: Human.

### Exit gate

- Real-project pilot accepted.
- Recovery objectives demonstrated.
- Security review passed.
- Relational state is authoritative.
- Legacy retirement separately approved.

## Dependency map

```text
Phase 0 Architecture
        │
        ▼
Phase 1 Domain + Database
        │
        ▼
Phase 2 Preservation Migration
        │
        ▼
Phase 3 Import + Persistent Phases
        │
        ▼
Phase 4 Coordinator/Runner Vertical Slice
        │
        ▼
Phase 5 Execution Mode UI
        │
        ▼
Phase 6 Multi-agent Coordination
        │
        ▼
Phase 7 Hardening + Pilot + Retirement
```

### Safe parallel work

- Phase 1: UI information architecture and adapter capability fixtures may be
  designed while Workstream B owns contracts/schema.
- Phase 2: coordinator prototypes may target frozen in-memory interfaces;
  frontend may target approved read schemas.
- Phase 3: source binding, ingestion, phase services, and UI shells may proceed
  after their interfaces freeze.
- Phase 4: server and runner sides of a versioned command contract may be
  implemented concurrently.
- Phase 5: projection implementation and UI presentation may proceed in
  parallel.
- Phase 6: allocation, provider adapters, review policy, and monitoring may
  proceed behind stable contracts.

### Unsafe parallel work

- Multiple writers on core contracts or migrations.
- UI implementation against unsettled DTOs.
- Feature additions to the current `server.ts`/`App.tsx` monoliths before
  modular seams exist.
- Coordinator and runner independently inventing task/run lifecycle states.
- Execution activation before durable dispatch and restart recovery.
- Legacy deletion while a rollback flag remains necessary.

## Rollback strategy

Capability flags cover:

- relational reads/writes;
- V2 phases;
- repository binding;
- live runner execution;
- Attention UI;
- multi-agent scheduling.

Rules:

- Before V2 writes, reads may switch back to legacy state.
- After V2 writes, pause/hide the new workflow but retain records; do not
  destructively reverse data.
- During execution incidents, pause dispatch, expire leases, and preserve
  events/outbox evidence.
- During UI incidents, revert presentation while retaining V2 APIs/data.
- During multi-agent incidents, reduce concurrency to one.
- Production database migrations are forward-only; recovery uses feature
  reversal or roll-forward repair, not destructive down-migrations.

## Next authorization gate

Phase 0 documentation is complete when the ADR package and this program pass
cross-provider review.

Production implementation begins with Phase 1 only after the human authorizes:

> Start Phase 1 — Domain and Persistence Foundation.

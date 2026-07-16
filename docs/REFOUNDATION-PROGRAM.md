# The Norns Controlled Re-foundation Program

**Status:** Phase 1 technical remediation complete; human retention decision
and final freeze pending
**Date:** 2026-07-16
**Program Manager / Chief Architect / Integration Owner:** ChatGPT Sol
**Governing charter:** [PROGRAM-CHARTER.md](PROGRAM-CHARTER.md)
**Architecture decisions:** ADR-004 through ADR-007
**Independent review packet:**
[reviews/REFOUNDATION-REVIEW-PACKET.md](reviews/REFOUNDATION-REVIEW-PACKET.md)
**Review code map:**
[reviews/REFOUNDATION-REPO-MAP.md](reviews/REFOUNDATION-REPO-MAP.md)
**Independent findings:**
[reviews/REFOUNDATION-REVIEW-FINDINGS.md](reviews/REFOUNDATION-REVIEW-FINDINGS.md)
**Findings disposition:**
[reviews/REFOUNDATION-REVIEW-DISPOSITION.md](reviews/REFOUNDATION-REVIEW-DISPOSITION.md)
**Human decisions:**
[reviews/REFOUNDATION-HUMAN-DECISIONS.md](reviews/REFOUNDATION-HUMAN-DECISIONS.md)
**Phase 1 candidate review:**
[reviews/PHASE-1-CANDIDATE-REVIEW-PACKET.md](reviews/PHASE-1-CANDIDATE-REVIEW-PACKET.md)
**Phase 1 independent findings:**
[reviews/PHASE-1-CANDIDATE-REVIEW-FINDINGS.md](reviews/PHASE-1-CANDIDATE-REVIEW-FINDINGS.md)
**Phase 1 findings disposition:**
[reviews/PHASE-1-CANDIDATE-REVIEW-DISPOSITION.md](reviews/PHASE-1-CANDIDATE-REVIEW-DISPOSITION.md)
**Phase 1 evidence:**
[reviews/PHASE-1-CANDIDATE-EVIDENCE.md](reviews/PHASE-1-CANDIDATE-EVIDENCE.md)
**Phase 1 remediation evidence:**
[reviews/PHASE-1-REMEDIATION-EVIDENCE.md](reviews/PHASE-1-REMEDIATION-EVIDENCE.md)

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
13. Architecture-relevant scope changes do not merge on the strength of a
    progress-log statement. They require a committed ADR or an explicit
    amendment to an existing ADR before integration.
14. The MVP control plane is single-instance. Multi-instance runner affinity
    or shared delivery requires a separate design and recovery gate.
15. No real-repository execution capability is enabled until minimum identity
    hardening and dispatch-route authorization pass the Phase 4 gate.

## Effort, cost, and variance baseline

This baseline resolves `REF-REC-9` and was approved by the human under
`REF-OPEN-4` on 2026-07-16.

A **Focused Session Equivalent (FSE)** is 60 minutes of active agent work,
recorded in 0.5-FSE increments. Parallel agents are counted separately.
Analysis, implementation, testing, review, integration, and rework count;
waiting, deployment idle time, and human approval time do not.

Phase 0 work is complete but historically unmetered; its authorization gate
remains open. No retrospective actual is invented. The integer FSE values are
planning baselines for control, not claims of forecasting precision. The
forward baseline assumes GitHub App remains in MVP, legacy
sessions rotate at cutover, and one phase executes per project by default:

| Phase | Baseline FSE | Planning window | Primary concentration |
|---|---:|---:|---|
| 1 — Domain and persistence | 14 | 1–2 weeks | Contracts, schema, transaction boundary, independent contract review |
| 2 — Preservation migration | 12 | 1–2 weeks | Identity/project import, reconciliation, rollback evidence |
| 3 — Import and persistent phases | 14 | 1–2 weeks | Repository binding/ingestion, phase workflow, Resume seed |
| 4 — Coordinator/runner slice | 24 | 2–3 weeks | Durable dispatch, runner execution, security minimum, recovery matrix |
| 5 — Attention-first UI | 15 | 1–2 weeks | Read models, execution UX, decisions, accessibility |
| 6 — Multi-agent coordination | 18 | 1–2 weeks | Allocation, concurrency, review/rework, memory |
| 7 — Hardening and pilot | 19 | 2–3 weeks | Attack/recovery tests, real-project pilot, cutover evidence |
| **Planned** | **116** | **9–16 weeks** | Excludes human/infrastructure pauses |
| **Central contingency (25%)** | **29** | Not preallocated | Named risks and review remediation only |
| **Approved maximum envelope** | **145** | Human-gated | Approved under `REF-OPEN-4` |

Role allocation:

| Phase | Sol | Backend Sonnet | Codex | Frontend Sonnet | Fable review | Terra/Haiku support | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 2 | 6 | 3 | 0 | 2 | 1 | 14 |
| 2 | 2 | 5 | 3 | 0 | 1 | 1 | 12 |
| 3 | 2 | 4 | 3 | 3 | 1 | 1 | 14 |
| 4 | 3 | 7 | 9 | 1 | 3 | 1 | 24 |
| 5 | 2 | 3 | 3 | 5 | 2 | 0 | 15 |
| 6 | 3 | 5 | 6 | 1 | 2 | 1 | 18 |
| 7 | 3 | 4 | 7 | 2 | 3 | 0 | 19 |
| **Total** | **17** | **34** | **34** | **12** | **14** | **5** | **116** |

Decision sensitivity:

- deferring GitHub App beyond MVP reduces the forecast by 4 FSE;
- permitting more than one concurrently executing phase by default adds an
  estimated 6–10 FSE across Phases 4–6.

The approved `REF-OPEN-1` through `REF-OPEN-3` decisions match the assumptions
used above. Sol's recalculation leaves every phase allocation, the 25%
contingency, the 145-FSE program envelope, and the 80%/100% program thresholds
unchanged.

Contingency may cover migration reconciliation, database/lease races,
runner/provider churn, independent-review remediation, and pilot defects. New
product scope requires separate authorization and cannot consume contingency.

Every phase-exit packet reports:

- baseline, actual, committed/in-flight, estimate at completion, and variance;
- effort by role/model surface and first-pass versus rework effort;
- deliverables using `designed`, `implemented`, `integrated`, `deployed`, and
  `acceptance-tested`;
- failed attempts, root cause, and corrective action;
- contingency drawn and remaining;
- subscription-seat, metered API, and infrastructure costs as separate
  ledgers;
- open risks/decisions and the next-phase reforecast.

Measurement definitions:

- `actual` = completed/consumed FSE;
- `committed` = active, authorized, unfinished FSE;
- `forecast_remaining` = forecast work not already counted as committed;
- `EAC` (estimate at completion) =
  `actual + committed + forecast_remaining`.

Control thresholds:

- When `actual` reaches 100% of the phase baseline, Sol must issue a reforecast
  before more work is committed.
- When `EAC` reaches or exceeds 125% of the phase baseline, freeze scope
  expansion and new parallel work and present a recovery plan.
- When either `actual + committed` or `EAC` reaches or exceeds 150% of the
  phase baseline, the phase automatically pauses new implementation. Only
  containment, rollback, and evidence preservation continue until the human
  increases the envelope, reduces scope, approves redesign/reassignment, or
  terminates the phase.
- When program `EAC` reaches 80% of the approved 145-FSE envelope, issue a
  whole-program reforecast. When aggregate `actual + committed` reaches 100%
  of the approved envelope, no new work begins without human reauthorization.

Before Phase 1 authorization, a program-control tabletop test must simulate a
phase crossing 150%, demonstrate automatic `paused` status, reject a new
implementation commitment, permit only containment/rollback/evidence work,
and require a recorded human disposition to resume.

The passed pre-implementation evidence is
[REFOUNDATION-PROGRAM-CONTROL-TABLETOP.md](reviews/REFOUNDATION-PROGRAM-CONTROL-TABLETOP.md).

The approved spend posture is **seat-first hybrid**: existing subscriptions
handle interactive architecture, implementation, and review; metered APIs are
reserved for live adapter, planning, multi-provider, recovery, and pilot
acceptance. Expected incremental API spend is $150–300. The approved hard
incremental metered-API cap is $400 base plus $100 central reserve:

| Phase | Approved API cap |
|---|---:|
| 1 | $10 |
| 2 | $10 |
| 3 | $75 |
| 4 | $85 |
| 5 | $20 |
| 6 | $100 |
| 7 | $100 |
| Central reserve | $100 |
| **Hard cap** | **$500** |

At 100% of a phase API cap, new metered calls stop unless the human approves a
documented transfer from the central reserve; the transfer updates the phase
cap and remaining reserve. No automatic reload or API spend beyond the
approved program cap is permitted.

Subscription seats and infrastructure are separate disclosed ledgers and are
not included in the $500 figure. Any new seat, hosting tier, database, object
storage, or email-service spend requires separate human approval. A balanced
hybrid ($1,000 incremental API cap) and API-first posture ($2,500 incremental
API cap) are not authorized by `REF-OPEN-4`.

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

- Identity/account scope amendment and post-GATE ratification map.
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

Active implementation brief:
[PHASE-1-BRIEF.md](phases/PHASE-1-BRIEF.md).

### 1.1 Versioned domain contracts

- Introduce V2 entities and commands alongside legacy contracts.
- Freeze Task and AgentRun state machines plus the pure Task-from-Run
  projection, including designated/superseded run and retry semantics.
- Make TaskDependency phase-local; PhaseDependency is the only cross-phase
  ordering mechanism for the MVP.
- Define approval/staleness rules, including server rejection of
  non-converged strategies and unresolved must-fix findings with no override.
- Define event schemas and versioning policy.
- Define immutable command identity per dispatch job.
- Define actor-scoped idempotency key, request fingerprint, concurrent
  duplicate, terminal-failure replay, retriable-conflict key release, and
  retention behavior. A returned failure must roll back mutation writes
  before either retaining or releasing the idempotency key.
- Define budget-reservation settlement/release for every terminal and
  ambiguous execution outcome.

### 1.2 Normalized schema

Add tables for the canonical domain, events, audit, budgets, evidence, outbox,
migration ledger, and legacy ID mapping. Include immutable
`dispatch_jobs.command_id`, command/job uniqueness, idempotency request
fingerprints/responses, and DecisionPoint condition identity/fingerprint.

### 1.3 Transactional application boundary

Command transactions atomically update:

- canonical state;
- domain/audit events;
- optimistic versions;
- budget reservations;
- required outbox jobs.

Lifecycle events are authoritative transition history; current lifecycle
columns are their operational projection. One application-service chokepoint
updates both transactionally. Direct lifecycle writes are prohibited. CI
fault-injection covers state-without-event and event-without-state, and a
fold-and-compare reconciliation job detects divergence.

### 1.4 Compatibility repositories

Existing APIs operate through repository/application interfaces while storage
can be switched between legacy and relational implementations.

### Ownership

- Primary: Backend Sonnet 5.
- Contract/integration owner: Sol.
- Migration, race, and crash tests: Codex.
- Repetitive fixtures after schema freeze: Haiku.
- Implementation/race review: Codex.
- Contract/integration review: Sol.
- Independent cross-provider review: after a candidate contract freeze, Claude
  Fable 5 reviews the V2 schemas, lifecycle machines, event definitions,
  approval/staleness rules, and idempotency semantics. Dispositions land
  before Sol declares the final contract freeze.

### Exit gate

- Schema deploys without altering or deleting legacy data.
- Domain invariants pass without HTTP/UI dependencies.
- State and outbox writes are atomic.
- Lifecycle fold-and-compare reconciliation passes and catches both
  fault-injected one-sided mutations.
- Every redelivery of one dispatch job presents the same command ID.
- Concurrent duplicate commands produce one mutation. A concurrent loser
  receives the committed replay when available or an explicit retriable
  `command_in_progress`; its later retry replays the committed result. Key
  reuse with a different request is rejected.
- Idempotency records remain replayable for the reviewed minimum and are not
  cleaned up while related asynchronous or rollback state exists.
- Budget-reservation contract tests cover success, partial usage, cancel,
  expiry, rejection, dead-letter, and ambiguous execution status.
- Cross-phase TaskDependencies are rejected.
- Task/AgentRun reducer and property tests cover every transition and
  superseded-run race.
- DecisionPoint condition identity and uniqueness are present in the schema.
- Optimistic-concurrency conflicts are explicit.
- Backup and restore are exercised in a production-like environment.
- Candidate contracts are frozen for review; Claude Fable's bounded
  V2-contract findings and their dispositions are committed; Sol then records
  the final contract freeze.

## Phase 2 — User and project preservation migration

### 2.1 Recovery checkpoint

- Create a database backup/PITR marker.
- Archive raw users/projects/relay snapshots as encrypted, access-controlled
  secret material with access logging and a defined retention window.
- Record source hashes, object counts, and application version.
- Stamp the legacy snapshot freeze time and the last included legacy record.

### 2.2 Identity migration

Preserve:

- user IDs, email addresses, names, roles, and admin status;
- password hashes and creation metadata;
- session inventory and attribution metadata; reusable session credentials are
  revoked under the approved cutover policy;
- invitation state with improved token hashing.

No shared deployment token is reintroduced as a login requirement.

`REF-OPEN-2` approved the mandatory cutover policy:
revoke every legacy session and unused invitation token and require one
explicit re-login. No token string present in a retained archive may
authenticate against the live system.

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

The reconciliation report emits distinct codes for:

- plan-module versus graph-node set differences, including graph-only nodes
  and deleted modules;
- shared-field and acceptance-criteria differences;
- dependency-edge differences;
- assignment/allocation differences;
- orphan references;
- stale or mismatched approval fingerprints.

Imported audit records use `actor_type = legacy`; original actor text is
retained as source metadata rather than fabricated identity.

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
- Admin/member account continuity and the selected explicit
  reauthentication behavior are verified.
- The selected credential-cutover policy is demonstrated; no credential
  string contained in a retained archive authenticates.
- Every project has a reconciliation report.
- Fixtures with graph-only nodes, deleted modules, changed edges, changed
  assignments, and stale approvals produce distinct findings.
- Cutover and rollback switches work.
- Rollback dry-run shows the snapshot freeze timestamp, V2 records created or
  changed since that point, and the resulting visibility/data-loss window.
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

`REF-OPEN-1` approved GitHub App inclusion in the MVP. Phase 3 uses ADR-006's
server-only private key and just-in-time, single-repository credential broker.
Tokens never enter command envelopes, events, logs, artifacts, prompts, or
sandbox environments, and the permission set is accepted before
implementation.

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
- leasing, fencing, stable command identity, and idempotency;
- budget reservation settlement/release on success, partial usage,
  cancellation, expiry, rejection, and dead-letter;
- periodic orphan-reservation reconciliation with audit/DecisionPoint
  behavior where automatic release is unsafe;
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

Prompt/context/artifact references are fetched by the authenticated runner,
verified by content hash, and staged into runner-owned storage. Fetch
credentials are never persisted in envelopes or exposed to the sandbox.

### 4.4 Review, integration, closure

- infrastructure evidence gates review;
- reviewed output gates integration;
- failure produces retry, rework, blocker, or DecisionPoint;
- task completion updates phase progress;
- phase closure updates memory and architecture.

### 4.5 Recovery matrix

Restart server, coordinator, relay, and runner at meaningful lifecycle points.
Verify no lost work, duplicate execution, budget drift, or stale-runner action.
Include dispatcher failure between delivery and completion, DecisionPoint
creation failure, lifecycle state/event divergence, expired/revoked
credentials, and orphaned reservations.

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

Before `live_runner_execution` is enabled against a real repository:

- session and invitation tokens are hashed at rest;
- expiry and server-side revocation are enforced;
- login rate limiting passes;
- dispatch-capable routes authorize the authenticated user against the target
  project and record the real actor/session;
- generic browser command submission cannot bypass application commands;
- bearer credentials are absent from WebSocket URLs, logs, and artifacts.

Recovery evidence proves one command execution per dispatch job, one
DecisionPoint per material condition, correct reservation settlement/release,
artifact hash enforcement, and a green lifecycle fold-and-compare over the
vertical-slice database.

## Phase 5 — Attention-first Execution Mode

### 5.1 Portfolio Attention

Rank strategic decisions, approvals, blockers, failed/stalled runs, budget
exceptions, milestones, and material completions.

Attention acknowledgement/snooze uses stable item identity
`(project_id, source_type, source_id, condition_class)` plus a hash of material
condition fields. Rebuild preserves acknowledgement while the fingerprint is
unchanged and re-raises a changed condition exactly once.

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
or demo endpoints. Projection rebuild tests prove acknowledgement persistence
and one-time re-raising after a material source change.

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
- Secure, HttpOnly, SameSite cookie migration and CSRF protection;
- recent-auth checks for high-risk operations;
- password recovery, enrollment alerts, and complete session inventory;
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
- Every rollback decision after V2 writes displays the legacy snapshot freeze
  time, records changed since that point, and the resulting visibility/data
  loss window before human approval.
- During execution incidents, pause dispatch, expire leases, and preserve
  events/outbox evidence.
- During UI incidents, revert presentation while retaining V2 APIs/data.
- During multi-agent incidents, reduce concurrency to one.
- Production database migrations are forward-only; recovery uses feature
  reversal or roll-forward repair, not destructive down-migrations.

## Next authorization gate

Phase 0 architecture disposition is complete:

- the independent findings and disposition are committed;
- `REF-REC-9`, `REF-REC-11`, and `REF-REC-14` evidence are complete;
- the 150% program-control tabletop pause test is recorded and passed;
- `REF-REC-1`, `-2`, `-6`, `-7`, `-8`, `-10`, `-13`, and the contract portion
  of `REF-REC-16` are bound to the Phase 1 exit gate;
- the human approved `REF-OPEN-1` through `REF-OPEN-4`;
- the 145-FSE and $500 incremental API envelopes are approved.

Production implementation begins with Phase 1 only after the human authorizes:

> Start Phase 1 — Domain and Persistence Foundation.

Authorization was recorded on 2026-07-16 in
[PHASE-1-START-AUTHORIZATION.md](reviews/PHASE-1-START-AUTHORIZATION.md).

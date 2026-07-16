# ADR-005: Normalized Persistence, Domain History, and Transactional Outbox

**Status:** Accepted · **Date:** 2026-07-16
**Supersedes:** Whole-store JSONB snapshot persistence as the production source
of truth
**Depends on:** ADR-004

## Context

The current PostgreSQL adapter stores whole in-memory stores in a single
`norns_state(key, snapshot JSONB)` table and flushes changed snapshots on a
timer. This enabled early restart persistence, but it cannot support:

- atomic task transitions and dispatch;
- optimistic aggregate concurrency;
- queryable project/phase/task state;
- durable budget reservations;
- multi-instance safety;
- migration history and foreign-key integrity;
- portfolio attention and project resume projections;
- long-running audit and execution history.

ADR-001 originally called for normalized PostgreSQL, workflow events, Drizzle,
and a durable dispatch table. This ADR refines that decision into a hybrid
model rather than event-sourcing every entity.

## Decision

### 1. Use normalized PostgreSQL as operational state

Canonical operational entities are stored in normalized tables with foreign
keys, timestamps, and optimistic versions.

Initial table groups:

- identity: `users`, `sessions`;
- projects: `projects`, `repository_bindings`, `architecture_revisions`;
- phases: `phases`, `strategy_versions`, `strategy_reviews`;
- work: `objectives`, `tasks`, `task_dependencies`;
- agents: `agent_profiles`, `agent_assignments`, `agent_runs`;
- decisions: `decision_points`, `decision_records`, `approvals`;
- memory: `project_memory_entries`;
- evidence: `verification_results`, `artifacts`;
- finance: `usage_events`, `budget_allocations`, `budget_reservations`;
- coordination: `dispatch_jobs`, `commands`, `runner_events`;
- history: `domain_events`, `audit_events`;
- projections/checkpoints: `projection_checkpoints`, optional read-model tables.

Drizzle is used for schema declarations and migrations unless a subsequent ADR
demonstrates a material incompatibility.

### 2. Use append-only domain events for meaningful transitions

`domain_events` records durable business transitions:

```text
event_id
stream_type
stream_id
stream_version
event_type
schema_version
project_id
phase_id
task_id
actor_type
actor_id
correlation_id
causation_id
occurred_at
payload
```

Domain events provide history, rebuild derived read models, and allow task/run
lifecycle verification. They do not replace every relational entity with a
hand-built event-sourced aggregate.

Task and AgentRun lifecycle state must be reproducible from their transition
events. Current-state columns are maintained transactionally for efficient
operational queries.

Lifecycle events are the authoritative transition history. Current-state
lifecycle columns are the authoritative current-state projection of the event
fold.
Every lifecycle mutation must pass through one application-service command
boundary that updates the state row and appends its event in the same
transaction. No API, repository, migration, or maintenance path may update
lifecycle columns outside that boundary. Phase 1 enforces the code/module
boundary with architecture fitness tests; a later ADR is required before
replacing it with security-definer procedures or a separate database write
role.

CI and a periodic production reconciliation job fold lifecycle events and
compare the result with current-state columns. Any mismatch fails the
verification gate, creates an audit event, and blocks further automated
mutation of the affected aggregate until repaired. Fault-injection tests cover
both one-sided cases: state without event and event without state.

Database privileges make `domain_events` append-only for application roles:
INSERT and SELECT are permitted; UPDATE and DELETE are not. Schema migration
roles are separate and audited. The MVP does not prune lifecycle events. Any
future retention or compaction policy requires a separate ADR defining
checkpoint/genesis semantics while preserving reproducibility.

### 3. Keep audit events distinct

`audit_events` records actions and observations, including rejected commands,
authentication actions, approval attempts, provider failures, and runner
security events.

A domain event changes business state. An audit event explains what was
attempted or observed. One transaction may create both.

`audit_events` is also append-only at the database-privilege boundary. A
correction is represented by another attributable event rather than mutation
of history.

### 4. Use a transactional outbox

Any command that makes work runnable or changes a dispatchable state performs,
in one database transaction:

1. Validate authorization and idempotency.
2. Lock/check aggregate versions.
3. Validate domain invariants.
4. Update normalized state.
5. Append domain and audit events.
6. Reserve budget where required.
7. Insert the `dispatch_jobs` row.
8. Commit.

No task may be marked dispatched unless the durable outbox job exists.

The command identity is pinned at creation, not delivery. The command row and
its `command_id` are created inside the original state/event/outbox
transaction, and `dispatch_jobs.command_id` is a required unique reference.
Equivalently, implementations may derive `command_id` deterministically from
`job_id`, but they may not mint a new identity per delivery attempt.
Redelivery changes delivery status only and re-presents the same command ID.
A semantic retry, changed execution intent, or new runner generation creates a
new dispatch job and command with explicit causation; it is never disguised as
transport redelivery.

Dispatchers claim jobs using leases and `FOR UPDATE SKIP LOCKED`. Polling is the
recovery guarantee; notification mechanisms are wake-up optimizations only.

Budget reservations created by the transaction have explicit terminal
handling:

- successful usage settles actual usage and releases any remainder;
- cancellation, expiry, rejection, and dead-letter before confirmed execution
  release the reservation;
- partial execution settles attributable usage and releases the unused
  balance;
- ambiguous execution status retains the reservation until fencing and
  reconciliation determine whether usage occurred;
- an idempotent periodic sweep detects orphaned or expired reservations,
  repairs them under policy, and emits an audit event.

### 5. Require idempotent command handling

Every externally initiated command carries an idempotency key and actor
identity. Repeating a successfully committed command returns the original
result without applying state twice.

Idempotency keys are scoped by authenticated actor and command family and are
stored with the request fingerprint, command status, and response envelope.
A unique constraint prevents two transactions from owning the same
`(actor_id, command_family, idempotency_key)`.

- A concurrent duplicate receives the first committed response when
  available, or a retriable `command_in_progress` conflict while the first
  transaction is unresolved.
- Reusing a key with a different request fingerprint is rejected and audited.
- A committed failure is retained and replayed as the result for that key;
  an intentional retry uses a new key and records causation to the failed
  command.
- Keys and response envelopes are retained for at least the longest client
  retry, approval-staleness, audit, and rollback window. The MVP minimum is 30
  days and never shorter than the lifetime of related asynchronous work,
  approval evidence, or an active migration rollback window. Cleanup is an
  audited job with boundary tests; changing the minimum is a reviewed policy
  change, not an ad hoc cleanup decision.

Runner commands retain existing command IDs, generation fencing,
correlation/causation, expiry, and deduplication semantics.

Runner events enter through a durable inbox/idempotency boundary before they
change project state. The unique runner/event sequence is committed with the
resulting state transition so reconnect replay cannot apply one event twice.

### 6. Separate artifacts from metadata

PostgreSQL stores artifact metadata, content hashes, provenance, retention,
redaction status, and storage references.

Large logs, transcripts, patches, provider responses, and deliverables are
stored in S3-compatible object storage. Local development may use a compatible
filesystem implementation.

### 7. Treat snapshots as migration/export/checkpoint artifacts

The legacy `norns_state` snapshots remain readable during migration and may be
retained for:

- migration rollback;
- administrative export;
- projection checkpoints;
- disaster-recovery validation.

They are not the production source of truth after cutover.

Legacy archives that contain reusable credentials are treated as secret
material. Pending human approval in `REF-OPEN-2`, the proposed required
cutover revokes all legacy session and invitation credentials so no token
string in an archive can authenticate against the live system. Encryption,
least-privilege access, access logging, key ownership, and retention are
Phase 2 exit criteria because the archives contain other sensitive identity
and project data.

## Migration and cutover

1. Back up the existing database.
2. Create normalized tables additively.
3. Record a migration-run identity and source snapshot hashes.
4. Import users, sessions, projects, plans, graphs, assignments, approvals,
   relay state, and audit records idempotently. Imported lifecycle state
   receives explicit import/genesis events so every post-cutover lifecycle
   column has a reproducible event-stream origin.
5. Run reconciliation reports.
6. Serve reads through a compatibility layer and compare legacy/new output.
7. Switch writes to normalized repositories.
8. Keep legacy snapshots read-only for the rollback window.
9. Perform restart, restore, and rollback drills.
10. Retire legacy writes only after human acceptance.

User and project records must not be discarded. Account access continuity is
preserved, but reusable bearer continuity is not required. Under the proposed
`REF-OPEN-2` cutover, the operator receives explicit notice and one deliberate
reauthentication rather than a silent logout loop.

## Concurrency and consistency

- Aggregate rows carry integer versions.
- Update commands use expected versions or row locks.
- Event stream versions are unique per stream.
- Budget reserve/settle/release operations are transactional.
- Dispatch leases are database-time-based.
- Terminal run/task transitions are first-commit-wins and record losing races
  as audit events.
- Referential integrity prevents cross-project task and assignment leakage.
- Reservation reconciliation runs independently of dispatch so leaked
  reservations cannot silently reduce available budget.

## Alternatives rejected

### Continue whole-store snapshots

Simple, but incapable of atomic outbox behavior, efficient projections, or
safe concurrent writers.

### Event-source every entity

Provides maximal replay but creates unnecessary implementation and migration
complexity. CRUD-like identity and metadata do not benefit enough.

### Introduce Temporal immediately

Temporal could be valuable at larger scale, but it adds an additional
operational system before the domain and runner vertical slice are proven.
The transactional outbox and explicit coordinator are sufficient for the MVP.

### Use an in-memory queue with database checkpoints

This recreates the current crash window and makes database state disagree with
dispatch state.

## Consequences

- Database migrations become a first-class reviewed artifact.
- All project mutations move behind repositories/application commands.
- The server can safely support multiple instances after lease and WebSocket
  routing behavior is designed and verified.
- Dashboard and resume views can be generated without loading every project
  snapshot.
- The migration requires a deliberate dual-read and rollback period.

The MVP is a single-server-instance deployment. Multi-instance operation is
out of scope until runner affinity or a shared delivery mechanism is designed
and passes a separate recovery gate; leases alone do not make a runner
WebSocket reachable from every server instance.

## Acceptance criteria

1. A task transition and its dispatch job commit atomically.
2. Two dispatchers cannot execute the same leased job concurrently.
3. A server crash after commit but before delivery recovers and dispatches the
   job.
4. A repeated idempotency key does not repeat a mutation.
5. Restart restores active phases, tasks, runs, blockers, approvals, budgets,
   and decisions.
6. A migrated database produces the same project/graph/allocation information
   as the legacy snapshot before enriched state is added.
7. Backup restore and migration rollback are demonstrated.
8. Portfolio and project resume queries do not deserialize whole-store
   snapshots.
9. Fault-injected state-without-event and event-without-state mutations are
   detected by fold-and-compare reconciliation.
10. Killing a dispatcher after delivery but before completion still produces
    one command row, one stable command ID, and one runner execution.
11. Two concurrent identical application commands produce one state change
    and replay one response; key reuse with a different payload is rejected.
12. Dead-letter, cancellation, expiry, and partial usage settle or release
    budget reservations, and an injected orphan is detected by the sweep.
13. Idempotency records remain replayable through the 30-day minimum and while
    related asynchronous/rollback state exists; cleanup removes only eligible
    records and is audited.

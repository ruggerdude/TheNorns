# ADR-008: Durable, user-configurable debate workflow

- **Status:** Accepted for implementation
- **Date:** 2026-07-18
- **Owners:** Program Manager / Integrator and Architecture Agent
- **Decision scope:** Project-scoped multi-model deliberation

## Context

The Norns needs a reusable debate workflow in which a human chooses the participants, role labels,
providers, and models at runtime. A debate may contain several participant turns, optional judging,
optional synthesis, convergence checks, budget controls, and human interventions. The workflow must
survive server and worker restarts without replaying completed model calls or losing transcript,
usage, or decision evidence.

The existing planning loop is synchronous and fixed to a project manager plus reviewer. The Phase 4
dispatch path is deliberately coupled to repository Tasks, AgentRuns, worktrees, and verification.
Neither is an appropriate aggregate for an arbitrary debate.

## Decision

### 1. Debate is a first-class project aggregate

The system will add a durable definition plus immutable execution attempts: `Debate`,
`DebateActor`, `DebateContextRef`, `DebateRun`, `DebateRound`, `DebateTurn`,
`DebateTurnAttempt`, `DebateMessage`, `DebateFinding`, `DebateRevision`, `DebateJudgment`,
`DebateFinalOutput`, `DebateIntervention`, usage, reservation, and dispatch-job records. Debate
records are project scoped and may optionally reference a Phase.

Participant, judge, and synthesizer definitions are frozen for a run as immutable execution
snapshots containing the exact selected provider, model, runtime, role label, instructions, pricing,
and limits. No role implies a provider or model. At least two enabled participant actors are
required to start. Editing an already-executed definition requires cloning it; rerun creates a new
monotonic DebateRun attempt without reopening prior history.

### 2. The coordinator advances one durable boundary at a time

A server-owned coordinator evaluates persisted state and schedules at most the next eligible turn.
Each provider or runner call is represented by a durable debate dispatch job with stable command
identity, leasing, retry count, and dead-letter handling. A process may tick the coordinator, but
correctness never depends on one in-memory loop: another process can claim expired work and resume
from PostgreSQL.

The first release executes turns through the existing OpenAI and Anthropic provider-API adapter
abstraction. The contract retains an explicit runtime field so a later Codex/Claude Code runner
adapter can produce the same normalized result without changing the debate domain. Runner-backed
debate turns are not exposed until that durable command/result bridge is implemented and reviewed;
provider-specific response fields never enter the debate domain.

The first release accepts inline text context only. Artifact-backed context is rejected at the API
boundary until a project-scoped resolver can fetch by immutable content hash, verify the bytes and
media type, and stage content without exposing storage credentials. This is a fail-closed scope
boundary, not a partially implemented context option.

### 3. Definition and run state machines

Debate definition states:

`draft -> ready -> archived`

Run states:

`created -> queued -> running -> finalizing -> completed`

Control states may occur while non-terminal:

`running -> pausing -> paused -> queued`

`running -> cancelling -> cancelled`

`created | queued | running | pausing | paused | finalizing | cancelling -> failed`

Round states: `pending -> active -> completed`, with `cancelled | failed` terminal.

Turn states: `pending -> queued -> running -> completed`, with `failed | expired | cancelled`
terminal. Ambiguity is recorded by an expired/failed attempt plus a retained reservation and paused
run, rather than by hiding accounting state inside a turn label. Bounded retry creates a new designated `DebateTurnAttempt` for the same logical
turn; it does not create a second successful output. An ambiguous external call is never retried
without explicit human acknowledgement.

Terminal run states cannot be reopened. Only one nonterminal run may exist per Debate definition.

### 4. Transcript and decisions are append-only

Debate events and messages have a contiguous per-run sequence, correlation and causation IDs,
actor snapshot, content hash, and timestamp. The replay API returns a frozen V2 event envelope and
a SHA-256 hash of its canonical immutable fields. Findings, judgments, and final outputs are immutable;
corrections use supersession links. The current DebateRun row is an operational projection of this
history and its `event_version` is transactionally advanced with every lifecycle event.

HTTP snapshot plus ordered event replay is the source of truth. A cookie-authenticated live stream
may provide low-latency hints, but reconnect always recovers from the persisted sequence.

### 5. Budget is reserved before execution

Each turn has a debate-specific reservation because the existing Task/AgentRun reservation schema
must not be given false ownership. The coordinator refuses dispatch if the hard debate or actor cap
would be exceeded. Actual usage settles the reservation; cancellation, rejection, expiration, and
dead-letter release it; ambiguous execution retains the unresolved amount until reconciled.

### 6. Stopping policy is configuration, not model identity

Initial supported rules are fixed rounds, maximum rounds, total budget, total tokens, duration,
consensus reported, no material change for a configured number of rounds, repeated unresolved
disagreement, user cancellation, and provider failure threshold. Deterministic rules are evaluated
by code. Semantic signals are accepted only from validated structured turn or judge output and are
recorded as evidence.

### 7. Human controls apply at declared boundaries

Pause, resume, stop-after-turn, stop-after-round, cancel, direction, and statement operations are
authenticated, CSRF protected, actor-scoped idempotent commands. A direction identifies its target
and applies at the next turn or round; it never claims to alter a model call already in flight.

## Invariants

1. No participant, critic, judge, or synthesizer model is hardcoded.
2. Every executed turn records the exact provider, model, runtime, prompt hash, output hash, usage,
   latency, provider execution ID when available, and attempt identity.
3. Only the next ordered turn in the active round may be claimed.
4. A completed output is committed once; duplicate callbacks replay the stored outcome.
5. A run cannot complete without one primary final output or while an active or
   retained-ambiguous reservation exists.
6. All mutating APIs enforce project scope, current aggregate revision, and idempotency.
7. Schema-invalid model output is never partially applied.
8. WebSocket or stream disconnect never changes debate state.
9. Provider secrets, raw storage references, and runner-local paths never enter browser DTOs.
10. Only one nonterminal run exists per debate and only one designated attempt may publish a turn.

## Consequences

- The debate workflow does not extend the synchronous planning session.
- Debate work is not represented as repository Tasks or fake AgentRuns.
- New forward-only PostgreSQL tables and a dedicated coordinator are required.
- This release exposes configured provider-API models only. A runner adapter remains a compatible,
  separately gated extension with its own credential and trust boundary.
- The MVP schedule is persisted actor-order round robin. Explicit sequencing and in-place editing
  are not exposed until their domain contracts are implemented; executed definitions are cloned.
- Debate context is inline text for this release; content-addressed artifact resolution remains a
  separately gated extension.
- Local-folder work remains a separate follow-on change after the debate feature is merged.

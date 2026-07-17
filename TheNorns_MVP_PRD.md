# TheNorns
## AI Program Management Platform
### Product Requirements & Technical Design (MVP) — Revision 4

> **Status notice (2026-07-16): Historical plan-centric specification.**
> The accepted [Program Charter](docs/PROGRAM-CHARTER.md), Phase 0 review,
> and ADR-004 through ADR-007 supersede this document where they conflict.
> This PRD remains a reference for useful component contracts, runner
> security, verification, budgets, approvals, and prior design history.

> **Purpose**
>
> TheNorns is a visual AI Program Management platform that orchestrates work
> across multiple AI providers (initially Anthropic and OpenAI). It manages
> planning, execution, review, Git operations, and quality control while
> providing a single PM-centric interface.

> **Revision note:** R3 incorporated the first independent review
> (`docs/reviews/REVIEW-001-disposition.md`): sandbox contract (ADR-003),
> durable runner protocol, dispatch outbox, extended Plan Contract,
> runner-executed verification, budget reservations, labeled telemetry,
> conflict-resolution nodes, resequenced phases. **R4** incorporates the
> round-2 review (`docs/reviews/REVIEW-002-disposition.md`): Runner Trust
> Contract, project-level Required Verification Commands, conflict-node
> replacement semantics, DecisionRecord supersession, correlation/causation
> ids, `in_review` state rename, simplified default pause controls, Project
> Memory, and a 15–25 session contingency. Round-2 verdict: **approve, no
> remaining architectural blockers**; further reviews are phase-gates only.

---

# Executive Summary

TheNorns is **not** another agent framework. It is an **AI Program Manager**.

The human interacts primarily with a PM agent. The PM creates plans,
coordinates cross-provider reviews, decomposes work into modules, recommends
models and agent counts, supervises execution, routes communications, tracks
cost/progress/quality, and presents all work through a visual dashboard.

## MVP Goals

- Select PM model (Anthropic or OpenAI)
- Enter a project prompt or paste an existing plan
- Cross-provider plan review loop (bounded, no copy/paste)
- Human-approved final plan
- Convert plan into an editable dependency graph
- Graphical assignment of providers, models, and agent counts
- PM allocation recommendations with rationale
- Local Git + GitHub integration (isolated worktrees, never edit main)
- Claude Code + Codex execution via a Local Runner, **inside an OS-level sandbox**
- Remote control from a browser on another device, over a **durable command protocol**
- PM dashboard with deterministic progress
- Token/cost tracking with **atomic budget reservations** and labeled telemetry
- Complete audit trail
- Pull request creation with human merge approval

## Non-Goals (MVP)

- Providers beyond Anthropic and OpenAI (architecture stays provider-neutral)
- Git hosts beyond local repositories and GitHub
- Multi-user collaboration, roles, or permissions (single human operator)
- Learned/ML-based allocation (rule-based only)
- Autonomous merges, autonomous plan approval, or **autonomous merge-conflict
  resolution** — humans gate all three
- Prominent ETA prediction (shown as experimental only; see Progress)
- Mobile-native apps (responsive browser UI only)
- Self-hosted relay for third parties (single-tenant relay is sufficient)

## Guiding Principles

1. PM is the product.
2. Human always has final approval.
3. Cross-provider review is the default for important work.
4. All agent communication is brokered through the PM.
5. Deterministic workflow engine owns state — not the LLM.
6. Every decision is auditable.
7. Safety over autonomy.
8. **Evidence over agent self-report** — verification is executed by trusted
   infrastructure, never taken from a worker's claim.

---

# Primary User Flow

1. Select PM model.
2. Enter objective or paste existing plan.
3. PM creates Plan V1 (structured — see Plan Contract).
4. Plan sent to Reviewer (cross-provider by default; see Review Policy).
5. PM revises against findings.
6. Additional review rounds until convergence or the round cap (default 3).
7. **Human approves plan** (approval gate).
8. Workflow engine converts the plan into a dependency graph.
9. PM recommends allocation (model, workers, reviewer, budget per node).
10. Human adjusts and/or approves allocation (**approval gate** — this is
    also budget approval).
11. Execution begins on the Local Runner, sandboxed.
12. PM supervises; workflow engine advances nodes through gates.
13. QC validates integrated work.
14. Pull request is created.
15. **Human merge approval** (approval gate — merge happens only after this).

---

# Core Screens

## 1. PM Workspace
Conversation-first: choose PM, create/open project, enter prompts, read
summaries, launch planning, receive recommendations. PM-routed answers that
materially change implementation become versioned **DecisionRecords**, not
just chat messages.

## 2. Plan Review
Each plan version, reviewer findings, PM responses (accept/rebut per
finding), final plan, diffs between versions, round counter, convergence
status, and any approved review-policy exceptions.

## 3. Workflow Graph
Editable dependency graph. Each node: title, status, dependencies, provider,
model, role, worker count, reviewer, budget, progress, usage. Editing rules:
edges must remain acyclic (cycle attempts rejected with the offending path
shown); deleting a node with dependents requires confirming re-parenting or
cascade; after execution starts, edits are limited to not-yet-started nodes.

## 4. Node Detail
Tabs: Prompt, Conversation, Artifacts, Files, Tests (runner-produced
verification evidence), Reviews, Usage, Logs.

## 5. PM Dashboard
Overall progress, active agents, blocked nodes, review queue, cost vs.
budget (with usage-source labels and a **live burn rate**, e.g. "$18,
+$2.10/hr"), token usage, risks, PM summary, a **project timeline** (a
chronological render of the event log: started review, spawned worker,
blocked, resolved…), and **repository health** (dirty / ahead / behind /
untracked / conflict, from the runner's git status). ETA is labeled
**experimental** and de-emphasized until enough completed projects exist to
calibrate it. Completion badges carry **provenance** ("two independent
reviews agreed; runner verification green") rather than an invented
confidence percentage. All figures derive from the workflow engine and
usage ledger — never from LLM self-report.

---

# Plan Contract

The bridge between "PM writes a plan" and "engine builds a graph" is a
machine-readable plan format. Planner/PM agents must emit it; the reviewer
reviews it; the engine validates it before graph conversion. It must be
sufficient to drive not just graph rendering but **execution, verification,
and safe parallelization**.

A plan is JSON (rendered as Markdown for humans):

- `objective` — one-paragraph goal statement
- `assumptions[]` — explicit assumptions the human should verify
- `modules[]` — each:

```json
{
  "id": "stable-slug",
  "title": "...",
  "description": "...",
  "deliverables": ["concrete artifacts: files, endpoints, docs"],
  "acceptance": [
    {
      "id": "AC-1",
      "statement": "observable requirement",
      "verification_type": "test | command | inspection | human",
      "verification": "exact test, command, or inspection procedure"
    }
  ],
  "dependencies": ["module-ids"],
  "estimated_complexity": "S | M | L | XL",
  "risk": "low | medium | high | critical",
  "execution": {
    "likely_paths": ["hints, not guarantees"],
    "owned_components": [],
    "test_commands": ["ADDITIVE ONLY — extend, never reduce, the project's Required Verification Commands"],
    "environment_requirements": [],
    "migration_required": false
  },
  "parallelization": {
    "safe": true,
    "candidate_work_units": [],
    "shared_files": [],
    "integration_owner_required": true
  },
  "inputs": [],
  "outputs": [],
  "open_decisions": ["human decisions required before execution"]
}
```

- `risks[]` — with mitigation notes
- `out_of_scope[]`

**Path ownership is a planning hint**, not a certainty: the Module Lead
validates `likely_paths`/`owned_components` against the actual repository
before workers launch. Complexity and risk are independent axes — a small
auth change can be S/critical.

Engine validation on submission: unique ids, resolvable dependencies,
acyclic graph, every module has ≥1 acceptance criterion with a machine- or
human-executable verification. Invalid plans return to the PM with errors
and never reach the human as "ready for approval."

---

# Planning Workflow

```
Human objective → PM → Plan V1 → Reviewer → Findings
     → PM revision → Reviewer → … → Convergence → Human approval → Approved Plan
```

**Review loop bounds.** Default maximum 3 rounds (configurable). Convergence
= no must-fix findings. If the cap is reached without convergence, the human
sees outstanding findings alongside the plan and decides: approve anyway,
another round, or restart.

**Reviewer findings format.** Structured: `severity` (must-fix / should-fix
/ suggestion), `module_id` (or plan-level), `finding`, `recommendation`. The
PM must respond to every must-fix (accept + revise, or rebut with
rationale); rebuttals are visible at approval time.

**Review Policy.** Cross-provider review is the **default policy** for
important work, not an engine invariant. The human may approve a documented
exception (provider outage, model access, capability gap, data-sensitivity
constraints, deliberate same-provider pairing). The engine records:
requested policy, actual provider/model used, exception reason, and the
human approval.

---

# Graph & Execution Workflow

```
Approved Plan → Graph → Allocation (human-gated) → Execution → QC → PR (human-gated merge)
```

**Node lifecycle (states owned by the workflow engine):**

```
pending → ready → assigned → running → verifying → in_review → verified → integrated
```
with side states `blocked` (dependency / budget / runner / integration),
`failed`, `cancelled`, and `superseded` (original node replaced by a
conflict-resolution node). (`in_review` is deliberately not named `review`,
to avoid colliding with the Review entity.)

**Required Verification Commands.** Verification authority is split so no
planning-time agent can weaken it:

- **Project verification** — a set of Required Verification Commands
  defined at repository registration, **outside the Plan Contract**,
  changeable only through human approval. The runner always executes these.
- **Module verification** — the Plan Contract's `test_commands` and
  acceptance procedures are **additive only**: they may extend required
  verification, never replace or reduce it.

**Runner-executed verification.** A worker's claim that tests passed is
evidence, not state. The trusted path is:

```
worker reports completion → runner captures the commit
  → runner executes required + module verification in a clean worktree
  → engine records the immutable verification result
  → node enters in_review
```

Reviewer approval at the `in_review` gate assesses the diff, the
runner-produced verification results, acceptance evidence, and unresolved
risks. `verified` requires reviewer sign-off; `integrated` requires a clean
merge into the integration branch with tests passing.

---

# Allocation

The user may manually assign per node: provider, model, role, worker count —
or click **Auto Allocate**. The PM recommends per node: model, worker count,
reviewer, budget, and a one-paragraph rationale. Three strategies:
**Quality**, **Balanced**, **Cost**. Rule-based (complexity × risk × role →
model tier, worker count, budget).

**Worker-count semantics.** N > 1 workers = N parallel implementation
agents, each in its **own worktree and branch**, on pre-split work units
from the module's `parallelization` block, validated by the Module Lead
against the repository. Workers never share a worktree. N > 1 requires a
Module Lead. Design cap N = 3; **pilot cap N = 2**.

**Cost preview.** Before allocation approval, the dashboard shows estimated
total cost (sum of node budgets) and per-node budgets. Allocation approval
is budget approval.

---

# Budget Enforcement

Budgets are enforced by the workflow engine with **atomic reservations** —
not estimates checked at dispatch, and never agent good behavior:

```
available = approved budget − settled actual usage − active reservations
```

Per dispatch: (1) compute a maximum-charge reservation from context size,
max output tokens, provider pricing, and runtime allowance; (2) reserve
atomically in Postgres; (3) reject dispatch if insufficient; (4) settle
against actual usage on completion; (5) release the unused remainder.
Per-call and per-run caps bound single-call overshoot.

- At 80% (settled + reserved) the PM is notified and must summarize status.
- At 100% the engine pauses the node (`blocked: budget`); the human extends,
  reassigns, or cancels. **No agent, including the PM, can extend a budget.**
- A project-level hard cap pauses everything and triggers the kill switch.

For subscription-authenticated runtimes where token cost is not exposed,
track runtime duration, provider-reported credits where available, and
normalized status — recorded as their true `usage_source`, never as false
precision (see Usage Telemetry).

---

# Usage Telemetry

Every usage figure carries a source label:

`usage_source: provider_api | runtime_report | subscription_credit | estimate | unavailable`

plus confidence, pricing version, and whether it is billable API cost,
subscription consumption, or an estimate. Dashboard aggregates never merge
API dollar cost and subscription consumption into one unlabeled number.

---

# Project Memory

Per-project standing directives that the engine injects verbatim into
**every** agent context — PM, planner, reviewer, module lead, worker, QA —
with no per-prompt engineering. Examples: "never refactor `combat.py`
without approval", "always use pytest", "never install dependencies
automatically", "Python 3.9 only."

- Entries are human-approved: created directly by the human, or proposed by
  the PM (e.g., promoting a DecisionRecord) and approved.
- Entries are versioned and auditable; every injection is attributable.
- MVP scope is deliberately minimal: a flat, ordered list of short
  directives. Automatic memory extraction or learning from transcripts is
  **post-MVP**.

Schema lands in the Phase 0B contracts freeze; injection is wired in
Phase 3 (the first phase where agent prompts exist).

---

# Agent Types

- **PM** — planning, decomposition, routing, allocation recommendations,
  summaries, monitoring. Cannot: bypass approvals, merge, extend or ignore
  budgets.
- **Planner** — optional delegate of the PM for structured plan drafting;
  exists only when the PM explicitly delegates (not a mandatory separate
  role in MVP).
- **Reviewer** — non-authoring provider by default (see Review Policy);
  structured findings; also reviews diffs + verification evidence at
  `in_review` gates.
- **Module Lead** — for N > 1 nodes: validates parallelization boundaries
  against the repo, splits work, resolves worker questions (routed via PM),
  assembles the node branch.
- **Implementation Worker** — works only inside its sandbox + assigned
  worktree/branch (see Execution Sandbox Contract).
- **Integration** — merges verified node branches into the integration
  branch in dependency order. **Clean merges only.** On conflict: marks the
  node `blocked: integration` and the engine creates a dedicated
  **conflict-resolution node** — assigned to a human-approved model,
  independently reviewed, and requiring human confirmation if it materially
  modifies both sides. **Replacement semantics:** the conflict node
  *replaces* the original in the graph — all outgoing edges move to it,
  downstream scheduling keys on it, and the original node is archived as
  `superseded` (preserved for audit). The integration agent never resolves
  conflicts implicitly, never force-pushes, never touches `main`.
- **QA** — runs end-to-end validation on the integration branch: the
  project's test suite plus Plan Contract acceptance criteria (via the
  runner, like all verification). Structured findings.

---

# Execution Sandbox Contract

A Git worktree provides source-control isolation, not OS isolation. Every
coding run executes inside an OS-level sandbox (implementation: ADR-003).
**Startup fails closed**: if the sandbox cannot be established, the run does
not start.

The contract every sandboxed run must satisfy:

- **Writable paths:** the assigned worktree and a scratch dir only
- **Readable paths:** worktree, scratch, and an explicit per-node allowlist
  (no `$HOME`, no SSH keys, no cloud credential files, no browser profiles)
- **Environment:** explicit allowlist of variables; nothing inherited
- **Network policy:** deny by default; egress only to the provider runtime's
  endpoints and (if the node permits) package registries
- **Process/CPU/memory limits and maximum runtime** per node
- **Secrets:** provider credentials are never injected broadly — the runner
  brokers provider access or injects narrowly scoped, short-lived
  credentials
- **Git credential mediation:** workers commit locally inside the sandbox;
  the **runner** performs pushes/fetches from outside it
- **Package installation:** per-node policy flag
- **No Docker/container-management access from inside the sandbox**
- **Test services** (databases etc.) provided as sandbox-local resources
  declared in the module's `environment_requirements`

Minimum sandbox enforcement is an acceptance requirement of the first
execution phase (Phase 5). Phase 8 adversarially hardens an existing
boundary — it does not introduce it.

---

# Runner Trust Contract

The runner is the highest-value attack target — it holds repository access,
credential brokering, and container control. Its authority is therefore
explicitly bounded, and each capability below is exclusive to its component
(engine-enforced where possible, audited always):

- **Only the runner may:** create/destroy worktrees; launch and tear down
  sandboxes; inject temporary scoped credentials; execute verification
  commands; push/fetch against repositories; report git status.
- **Only the sandbox (worker) may:** edit files in its worktree; run code
  and tests inside its limits; produce local commits.
- **The PM (and all LLM agents) may only:** issue intents through the
  engine — never direct commands to the runner, never credentials, never
  shell.
- **Never, by any component:** raw shell on the runner host on behalf of an
  agent; worker-initiated pushes; provider credentials passing through an
  agent context; sandbox access to the runner's own credential store or
  control socket.

Every runner action records which contract capability authorized it, making
a compromised or misbehaving component visible in the audit trail as a
contract violation rather than noise.

---

# Runner Protocol

Two independent durable streams, both surviving disconnects and restarts:

- **runner → server events:** per-runner monotonic `event_seq`; disk-backed
  buffer on the runner; replay from the server's `ack_event_seq` watermark
  on reconnect.
- **server → runner commands:** durable **command outbox** on the server
  (see dispatch_jobs); every mutating command has a globally unique
  `command_id` and an idempotency key; the runner keeps a durable local
  record of recently executed command ids so replays cannot execute twice.

**Delivery guarantee (stated honestly):** at-least-once transport with
idempotent command execution and durable deduplication. Exactly-once is not
claimed.

Every command and event envelope also carries a `correlation_id` (the
thread of related activity it belongs to) and a `causation_id` (the message
that directly caused it), alongside `command_id`/`event_seq` — so any
distributed trace can be reconstructed from the audit store.

**Command state machine:**

```
created → queued → delivered → accepted → executing
        → succeeded | failed | rejected | expired | cancelled
```

Additional semantics: per-runner **generation (fencing) token** so a stale
runner cannot act after replacement; command expiry; explicit conflict rules
(e.g., cancel racing completion resolves to the terminal state that commits
first, and the loser is recorded as superseded); pause-before-pause-ack
handled by idempotent command application; a reconciliation handshake on
every reconnect (exchange ack watermarks, replay both directions); commands
are authorized per session and bound to project/node/repository.

**Pause/resume are not one control.** The adapter capability matrix (per
runtime) must declare support for each of:

- **Interrupt** — ask the runtime to stop its current turn safely
- **Suspend** — OS-level process suspension, only where supported
- **Resume session** — reconnect to a persisted runtime session
- **Cancel** — terminate the run, preserve the worktree
- **Stop after current action** — cooperative safe-stop

All five semantics live in the protocol and capability matrix, but the
**UI defaults to two controls — Interrupt and Cancel** — with the rest
behind an advanced menu; the runner maps UI intent to what the runtime
actually declares. Controls map to declared capabilities, never to
assumptions.

---

# Failure Handling & Recovery

- **Agent run failure** (crash, provider error, malformed output): retry
  once with the same context; second failure → `failed`, PM notified,
  recommends reassign / retry / escalate. Failures never silently disappear.
- **Runner disconnect:** in-flight runs continue locally; events buffer and
  replay per the Runner Protocol. Beyond a configurable window (default
  10 min), affected nodes become `blocked: runner` and the human is
  notified.
- **Server restart:** command outbox and event watermarks are durable rows;
  the dispatch loop recovers from the database, not from process memory.
- **Server/browser disconnect:** the server is the source of truth; the
  browser is a pure view.
- **Partial completion:** worktrees preserved on failure; retry starts from
  a fresh worktree unless the human resumes the existing one.
- **PM context limits:** the PM operates on engine-maintained state
  summaries (node statuses, open findings, budget ledger), not raw
  transcripts. Raw transcripts live in the artifact store.

---

# Supported Providers (MVP)

- **Anthropic:** Claude Opus, Claude Sonnet (LLM); Claude Code (runtime, via
  the Claude Agent SDK)
- **OpenAI:** GPT reasoning models (LLM); Codex (runtime, via the official
  TypeScript Codex SDK / app-server; capability verified at runner
  registration)

Concrete model ids and pricing live in configuration. Design remains
provider-neutral; runtime adapters may wrap external binaries. Runtimes may
authenticate via subscription/OAuth flows distinct from API keys — the
credential store supports both shapes, and telemetry differences are handled
by usage-source labeling.

---

# Git

- Local repositories and GitHub (via the Repository adapter).
- Every implementation runs in an isolated worktree on its own branch,
  inside a sandbox.
- Branch naming: `norns/<project>/<node-id>[-w<worker>]`; conflict nodes:
  `norns/<project>/<node-id>-conflict`.
- Integration on `norns/<project>/integration`; `main` changes only via the
  human-approved PR merge. Pushes are performed by the runner, never by
  workers.

---

# Remote Control & Local Runner

Remote control is the riskiest architectural bet, so it is validated first
as a **production-bound** vertical slice (not a throwaway prototype — the
protocol contracts are frozen in Phase 0B before it is built).

**Topology:** Browser ⇄ Cloud server (relay) ⇄ Local Runner. The runner
makes an outbound-only TLS WebSocket connection; no inbound firewall
changes. The server holds routing state, the command outbox, and the audit
feed — never repository contents.

**Runner responsibilities:** execute jobs, manage worktrees, launch
sandboxed coding runtimes, execute verification commands, stream events,
maintain the durable protocol, register repositories, heartbeat.

**Authentication & session security:**

- Browser: passkey (WebAuthn), with **≥2 enrolled passkeys or one encrypted
  recovery code**; short-lived sessions; recent-authentication required for
  high-risk actions (approvals, budget extensions, runner enrollment, kill
  switch); origin checks, SameSite secure cookies, rate limiting.
- Runner: one-time pairing code → per-runner Ed25519 keypair; key rotation
  supported; a revocation list; generation tokens fence stale runners.
- Per-command authorization bound to project/node/repository; command
  expiry.
- Notifications on every new runner enrollment and new browser session.
- No RBAC in MVP — single-operator authorization only.

**Phase 1A acceptance — using only a browser on another device:** view
runner status; launch a fixture task; stream live logs (< 2 s latency); send
a message; exercise the control set; kill the runner's network mid-task and
verify both event replay **and** command replay behave per protocol (no
gaps, no duplicate execution); restart the server mid-task and verify
recovery from durable state; verify every command in the audit trail with
actor, timestamp, and outcome.

---

# Technology Stack (summary — ADRs are canonical)

- **TypeScript everywhere** on the current Active LTS Node (24 at time of
  writing, pinned), pnpm monorepo: `apps/server`, `apps/web`, `apps/runner`,
  `packages/contracts` (zod schemas: Plan Contract, Execution Contract,
  runner protocol, lifecycle events). ([ADR-001](docs/adr/ADR-001-tech-stack.md))
- **Backend:** Fastify + WebSockets; PostgreSQL; Drizzle. Event-sourced
  reducer over an append-only event log **plus** a durable `dispatch_jobs`
  outbox (`FOR UPDATE SKIP LOCKED`, leases); LISTEN/NOTIFY is a wake-up hint
  only.
- **Frontend:** React 19 + Vite, React Flow, TanStack Query, Tailwind.
- **Runner:** TypeScript daemon (`npx norns-runner`); Claude Agent SDK +
  `@openai/codex-sdk`; git CLI; sandbox launcher per
  [ADR-003](docs/adr/ADR-003-execution-sandbox.md).
- **Hosting:** Fly.io app + **managed Postgres (Neon)** + S3-compatible
  object storage for artifacts; backups/PITR and a restore test before
  pilot. ([ADR-002](docs/adr/ADR-002-relay-hosting.md))

---

# Data Model (entities and key relationships)

- **Workspace** → Projects; **Project** → one Repository, many Plans, one
  active Workflow, **Required Verification Commands** (human-approved,
  outside any plan), **ProjectMemory** entries (versioned, human-approved
  standing directives injected into every agent context)
- **Plan** (versioned) → Reviews; one version becomes Approved
- **Review** → Plan version or WorkflowNode; structured findings
- **Workflow** → WorkflowNodes; carries a **graph version** bumped on every
  structural edit (execution references a specific version);
  **WorkflowNode** → edges, one Assignment, many AgentRuns
- **Assignment** — provider, model, role, worker count, reviewer, budget
- **AgentRun** → Messages, Artifacts, UsageEvents; one Worktree; one Sandbox
  record (policy applied, limits)
- **Command** — outbox row: command_id, idempotency key, state, expiry,
  runner generation (see dispatch_jobs)
- **Reservation** — active budget holds: node, run, max charge, state
- **UsageEvent** — provider, model, node, run, tokens, estimated/actual
  cost, `usage_source` (append-only ledger)
- **VerificationResult** — runner-produced, immutable: commit hash, command,
  output digest, pass/fail
- **DecisionRecord** — versioned material decisions (PM answers, review
  exceptions), linked to approvals; carries `supersedes` / `superseded_by`
  / `status: active | obsolete` — PM summaries draw only on active records
- **Approval** — human decisions (plan, allocation, budget extension,
  merge, review-policy exception): actor, timestamp, content hash
- **Artifact** — metadata + content hash in Postgres; blob in object
  storage (see Artifact & Log Storage)
- **AuditEvent** — append-only record of every command, transition, and
  agent decision. *Distinct concept from workflow events:* workflow events
  change derived state; audit events record actions/observations; some are
  both, the streams stay separable.

---

# Artifact & Log Storage

Postgres stores metadata and content hashes; large logs, transcripts,
patches, and artifacts go to object storage (S3-compatible; local disk in
dev). Every artifact record: content hash, size, MIME type, compression,
retention class, redaction status, storage URI, immutable version, deletion
tombstone. Raw agent logs are truncated in the UI but complete in storage.
Provider responses are stored immutably. Retention defaults: audit metadata
indefinitely; raw transcripts/logs by retention class with explicit
deletion policy.

---

# Progress

Calculated from objective workflow gates only: a node contributes its
complexity weight as it passes lifecycle gates. Never from LLM
self-estimation. **ETA is experimental in MVP:** derived from measured
gate-transition times, shown de-emphasized with a confidence band and an
"experimental" label until several completed projects exist.

---

# Security

- OS-level execution sandbox, fail-closed (Execution Sandbox Contract, ADR-003)
- Encrypted credential store (API keys and runtime OAuth tokens, distinct
  shapes); runner-brokered, narrowly scoped, short-lived credential
  injection
- Append-only audit log for every command and state transition
- Runner pairing, keypair rotation, revocation list, generation fencing
- Browser auth hardening: multi-passkey/recovery, short sessions,
  recent-auth for high-risk actions, origin/CSRF protections, rate
  limiting, enrollment/session alerts
- Per-command authorization bound to project/node/repository
- Approval gates (plan, allocation, budget extension, merge, review
  exception) enforced by the engine
- Secret redaction on all streamed logs before they leave the runner
  (heuristic — defense in depth relies on the sandbox limiting what can
  reach logs)
- Kill switch: server-side flag checked by the dispatch loop (works when
  the runner is wedged); pauses all runs, revokes in-flight dispatches,
  requires human action to resume; auto-triggered by the project hard cap

---

# Development Order

Estimates are focused agent sessions (hour-scale units); calendar time is
gated by human approval cadence, cross-device testing, and the four
genuinely hard areas: **planning quality (Phase 3), multi-agent
coordination (Phase 7), runner protocol durability (0B/1A), and sandboxing
(Phase 5)**. Planning envelope: **40–65 sessions expected, plus a 15–25
session contingency** (provider/SDK churn, runtime bugs, rework discovered
at phase gates) to internal MVP, plus pilot remediation. Phases overlap; do
not sum sessions as calendar time.

| Phase | Scope | Sessions | Exit criterion |
|---|---|---|---|
| 0A | **Architecture lock** — scope, state model, data model, sandbox strategy, credential strategy, adapter boundaries, hosting, retention, event-vs-audit semantics; ADRs Accepted | 2–3 | ADR-001/002/003 Accepted; monorepo scaffolded, CI green |
| 0B | **Protocol & contract lock** — Plan Contract v1, Execution Contract v1, command/event envelopes, ack/replay semantics, command state machine, usage/approval/artifact schemas in `packages/contracts` | 2–3 | Contracts v1 tagged; reducer determinism + idempotency test harness in place |
| 1A | **Remote-control vertical slice** (production-bound) — server, durable outbox, audit log, pairing, runner dedup store, reconnect/replay both directions, passkey session, fixture task, remote controls. No LLMs | 6–9 | Full 1A acceptance incl. forced-disconnect and server-restart tests, from a second device |
| 1B | **Workflow & repository foundation** — event-sourced reducer, dispatch_jobs + leases, approvals, budgets + reservations, local Git adapter, worktree manager, **sandbox launcher**, kill switch | 5–8 | Fixture graph driven through all states; sandbox launches fail closed; synthetic budget races handled |
| 2 | **Direct LLM adapters** — Anthropic + OpenAI, structured output, usage normalization + source labels, model registry, failure taxonomy, cancellation; conformance suite | 3–5 | Conformance green on both live providers; ledger reconciles |
| 3 | **Planning & review** — PM conversation, Plan Contract generation, validation round-trips, cross-provider review + exceptions, finding disposition, versioning, plan approval, **Project Memory injection into all agent contexts**. *Genuinely slow: prompt-quality iteration* | 5–8 | Loop runs on 3 objectives, zero copy/paste; bad plan caught; cap-reached path correct; memory directives visibly honored |
| 4 | **Graph & allocation** (merged to avoid building the graph UI twice) — rendering, editing + validation rules, assignment UI, three strategies, cost preview, allocation approval | 4–6 | 10-node graph editable + auto-allocated under each strategy; overrides persist |
| 5 | **Single-agent coding execution** — Claude Code + Codex adapters, capability matrix, sandboxed worktree runs, runner-executed verification, review gate, budget enforcement live, remote controls on real runs. *Sandbox enforcement is acceptance here* | 6–10 | One node end-to-end per runtime, sandboxed, remotely controlled; budget exhaustion pauses; verification is runner-produced |
| 6 | **Dashboard** (before multi-agent, to operate later phases) — authoritative node state, logs, blockers, approvals, usage with source labels, budget, Git status, PM summary | 3–5 | Dashboard state provably derives from engine events; totals match ledger |
| 7 | **Multi-agent coordination** — max 2 workers, Module Lead, bounded decomposition, per-worker worktrees, PM-routed questions, assembly, clean integration, conflict-resolution nodes, failure recovery. *Genuinely hard: interleavings* | 7–12 | 5-node graph with one 2-worker node end-to-end; induced conflict spawns a conflict node; induced failure escalates |
| 8 | **Security & resilience gate** — sandbox-escape tests, planted-secret leakage tests, command-replay tests, disconnect/stale-runner/fencing tests, budget races, cancellation races, runner revocation, backup **restore test** | 5–8 | Hostile-prompt node fully contained and audited; all race tests green; restore verified |
| 9 | **Pilot** — one bounded real project through the full flow; MVP acceptance run as the formal gate; defect remediation | 4–8 + calendar | All MVP acceptance checks pass on the pilot |

---

# Pilot Scope Limits

The first pilot deliberately constrains configuration to prove the product
without solving every execution mode:

one PM · one reviewer · **max two concurrent implementation workers** · one
integration branch · one local runner · one GitHub repository · one standard
test-command configuration · manual (node-based) conflict resolution ·
API-key auth for direct LLM calls · whichever runtime auth mode is already
stable locally · ETA hidden or labeled experimental.

Deferred beyond pilot: three-worker nodes, allowlist-authoring UI,
graph editing of in-flight regions, cost-learning/historical optimization,
object-storage management UI, arbitrary custom acceptance mechanisms.

---

# Recommended Development Agents (for building TheNorns itself)

Concrete assignments, phase matrix, concurrency policy, and escalation rules
live in **[docs/STAFFING.md](docs/STAFFING.md)** (canonical). Summary: a
persistent Claude Fable 5 architecture lead (contracts, ADRs, adjudication —
sole approver of `packages/contracts` changes); Claude Sonnet 5 backend and
frontend leads; Codex as runner/security lead; the external OpenAI reasoning
model as phase-gate reviewer (after 1A, 3, 5, 7, pre-pilot); QA = Codex
(failure injection) + reasoning model (evidence review); Haiku 4.5 for bulk
mechanical work. ≤3 implementation agents until Phase 4; runner+backend pair
on Phase 5; one temporary extra worker for Phase 7 with a single integration
owner.

---

# MVP Acceptance

Demonstrated on the pilot project:

1. Cross-provider planning completes with ≥1 full review round and zero
   manual copy/paste; any review-policy exception is recorded and approved.
2. The approved plan converts to an editable, validated graph.
3. Auto Allocate produces per-node recommendations with rationale and an
   up-front total cost estimate; the human can override any field.
4. A remote browser on a different network exercises the full control set;
   forced disconnect/reconnect loses no events and duplicates no command
   execution; a server restart recovers from durable state.
5. Claude Code and Codex each complete ≥1 node **inside the sandbox**, with
   verification executed by the runner using the project's Required
   Verification Commands (module `test_commands` additive only), not
   reported by the worker.
6. A hostile-prompt test node (worktree escape, planted-secret
   exfiltration, network egress) is fully contained and audited.
7. Node budget exhaustion pauses the node; concurrent dispatches cannot
   oversubscribe a budget (reservation race test); the project hard cap
   halts everything.
8. Dashboard progress changes only on gate transitions; displayed cost
   matches the ledger, with usage-source labels.
9. An induced worker failure and an induced merge conflict both surface
   through the defined paths — the conflict via a conflict-resolution node.
10. A pull request is created and mergeable only after explicit human
    approval; the audit trail reconstructs who/what/when for every decision.

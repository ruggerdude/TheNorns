# TheNorns — Full Plan R3 (Review Packet, Round 2)

> **What this document is.** The regenerated, self-contained review packet
> for the **second** independent architecture review of TheNorns, produced
> 2026-07-13 from the R3 canonical files (`TheNorns_MVP_PRD.md` R3,
> ADR-001/002 as amended, ADR-003, and the REVIEW-001 disposition). It
> supersedes the R2 packet, which REVIEW-001 already reviewed. If this
> packet and the canonical files diverge, the canonical files win.
>
> **Round-2 outcome (2026-07-13):** REVIEW-002 returned *approve with minor
> changes, no remaining architectural blockers*. Its findings are adopted in
> PRD **R4** (see `docs/reviews/REVIEW-002-disposition.md`). Per the
> reviewer's recommendation, no further broad reviews — phase-gate reviews
> only (after 1A, 3, 5, 7, and pre-pilot). This packet is retained as the
> record of what REVIEW-002 reviewed.

> **Instructions for the reviewing agent (Round 2).** All REVIEW-001 P0/P1
> findings were adopted (two with corrected factual premises) — the Change
> Summary below maps each finding to its resolution. **Do not re-litigate
> closed findings.** Your focus: (a) did the corrections introduce new
> defects, inconsistencies, or over-corrections; (b) are the new mechanisms
> (sandbox contract, runner protocol, dispatch outbox, budget reservations,
> conflict nodes) internally sound and mutually consistent; (c) is anything
> in the revised design now over-engineered beyond MVP need. Return
> structured findings: `severity` (P0/P1/P2), `section`, `finding`,
> `recommendation`. Targeted round-2 questions are at the end.

---

# CHANGE SUMMARY — How each REVIEW-001 finding was resolved

| Finding | Resolution in R3 | Where in this packet |
|---|---|---|
| P0-1 worktree ≠ isolation | Mandatory fail-closed OS sandbox: disposable OCI containers, worktree-only writable mounts, deny-by-default egress, runner-brokered short-lived credentials, workers commit inside / only the runner pushes; enforcement is Phase 5 acceptance, Phase 8 hardens | Part I §Execution Sandbox Contract; Part II §ADR-003 |
| P0-2 no durable command semantics | Bidirectional protocol: at-least-once + idempotent execution + durable dedup; unique command_id, server outbox, runner dedup store, command state machine, fencing generations, expiry, reconciliation handshake; frozen in Phase 0B | Part I §Runner Protocol |
| P0-3 LISTEN/NOTIFY not a queue | Durable `dispatch_jobs` table, `FOR UPDATE SKIP LOCKED`, leases, polling guarantees recovery; NOTIFY is a wake-up hint only | Part II §ADR-001 (Dispatch) |
| P1-1 Plan Contract insufficient | Module schema extended: per-criterion verification (type + exact procedure), execution block (paths/tests/env/migrations), parallelization block, inputs/outputs, open_decisions; path ownership = hint validated by Module Lead | Part I §Plan Contract |
| P1-2 trust worker reports | New `verifying` state: runner captures commit, runs verification in a clean worktree, records immutable result before review | Part I §Graph & Execution |
| P1-3 Codex SDK is Python | **Premise incorrect** — official TypeScript SDK exists (`@openai/codex-sdk`, controls local Codex agent, streaming + session resume). Recommendation's core adopted anyway: adapters may wrap external binaries, capability detection at runner registration, verify at implementation time | Part II §ADR-001 (Runner) |
| P1-4 Node 22 frozen | Current Active LTS (Node 24 at writing), pinned; downgrade only on verified incompatibility | Part II §ADR-001 |
| P1-5 Fly Postgres unmanaged | **Premise partially outdated** (Fly Managed Postgres now exists but at ~$38/mo minimum) — materially right. Amended to Neon managed Postgres (~$0–19/mo, backups/PITR); Fly MPG designated alternative; restore test mandatory before pilot; Tigris/S3 for artifact blobs | Part II §ADR-002 |
| P1-6 budget concurrency bypass | Atomic reservations: available = approved − settled − active reservations; reserve/settle/release transactionally; per-call and per-run caps; 80% threshold uses settled + reserved | Part I §Budget Enforcement |
| P1-7 telemetry false precision | `usage_source` labels (provider_api / runtime_report / subscription_credit / estimate / unavailable) + confidence + pricing version; no unlabeled mixed aggregates | Part I §Usage Telemetry |
| P1-8 auth gaps | ≥2 passkeys or recovery code, short sessions, recent-auth for high-risk actions, per-command authorization bound to project/node/repo, runner key rotation + revocation + fencing, origin/CSRF/rate limiting, enrollment alerts | Part I §Remote Control |
| P1-9 pause/resume undefined | Five distinct controls (interrupt / suspend / resume-session / cancel / stop-after-current-action) + mandatory per-runtime capability matrix | Part I §Runner Protocol |
| P1-10 auto conflict resolution | Removed. Integration does clean merges only; conflicts spawn a dedicated conflict-resolution node (human-approved model, independent review, human confirmation if both sides materially modified) | Part I §Agent Types (Integration) |
| P1-11 rigid cross-provider rule | Now default policy with documented, human-approved, audited exceptions | Part I §Planning Workflow (Review Policy) |
| P1-12 retention unspecified | Artifact & Log Storage section: Postgres = metadata + hashes; blobs in S3-compatible storage; hash/size/MIME/compression/retention class/redaction status/URI/tombstones | Part I §Artifact & Log Storage |

Also adopted: all five P2s (S/M/L/XL + separate risk axis; DecisionRecords;
ETA experimental; `approved` state renamed `verified`; workflow vs. audit
event distinction), the corrected phase sequence (0A/0B; graph+allocation
merged; single-agent execution → dashboard → multi-agent; security gate
before pilot; Phase 1A production-bound, superseding R2's "throwaway
scaffolding"), the pilot scope limits, the build-team allocation (with
pinned model names replaced by per-config choices), and the revised
**40–65 session** estimate.

---

# PART I — PRODUCT SPECIFICATION (PRD R3)

## Purpose

TheNorns is a visual AI Program Management platform that orchestrates work
across multiple AI providers (initially Anthropic and OpenAI). It manages
planning, execution, review, Git operations, and quality control while
providing a single PM-centric interface.

TheNorns is **not** another agent framework. It is an **AI Program
Manager**. The human interacts primarily with a PM agent. The PM creates
plans, coordinates cross-provider reviews, decomposes work into modules,
recommends models and agent counts, supervises execution, routes
communications, tracks cost/progress/quality, and presents all work through
a visual dashboard.

## MVP Goals

- Select PM model (Anthropic or OpenAI)
- Enter a project prompt or paste an existing plan
- Cross-provider plan review loop (bounded, no copy/paste)
- Human-approved final plan
- Convert plan into an editable dependency graph
- Graphical assignment of providers, models, and agent counts
- PM allocation recommendations with rationale
- Local Git + GitHub integration (isolated worktrees, never edit main)
- Claude Code + Codex execution via a Local Runner, inside an OS-level sandbox
- Remote control from a browser on another device, over a durable command protocol
- PM dashboard with deterministic progress
- Token/cost tracking with atomic budget reservations and labeled telemetry
- Complete audit trail
- Pull request creation with human merge approval

## Non-Goals (MVP)

- Providers beyond Anthropic and OpenAI (architecture stays provider-neutral)
- Git hosts beyond local repositories and GitHub
- Multi-user collaboration, roles, or permissions (single human operator)
- Learned/ML-based allocation (rule-based only)
- Autonomous merges, autonomous plan approval, or autonomous merge-conflict
  resolution — humans gate all three
- Prominent ETA prediction (experimental label only)
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
8. Evidence over agent self-report — verification is executed by trusted
   infrastructure, never taken from a worker's claim.

## Primary User Flow

1. Select PM model.
2. Enter objective or paste existing plan.
3. PM creates Plan V1 (structured — see Plan Contract).
4. Plan sent to Reviewer (cross-provider by default; see Review Policy).
5. PM revises against findings.
6. Additional rounds until convergence or the round cap (default 3).
7. **Human approves plan** (approval gate).
8. Engine converts the plan into a dependency graph.
9. PM recommends allocation (model, workers, reviewer, budget per node).
10. Human adjusts and/or approves allocation (**approval gate** — also
    budget approval).
11. Execution begins on the Local Runner, sandboxed.
12. PM supervises; engine advances nodes through gates.
13. QC validates integrated work.
14. Pull request is created.
15. **Human merge approval** (approval gate).

## Core Screens

1. **PM Workspace** — conversation-first: choose PM, create/open project,
   prompts, summaries, planning, recommendations. PM-routed answers that
   materially change implementation become versioned **DecisionRecords**.
2. **Plan Review** — plan versions, reviewer findings, PM responses
   (accept/rebut per finding), final plan, diffs, round counter, convergence
   status, approved review-policy exceptions.
3. **Workflow Graph** — editable dependency graph; node fields: title,
   status, dependencies, provider, model, role, worker count, reviewer,
   budget, progress, usage. Editing rules: acyclic edges enforced (offending
   path shown on rejection); deleting a node with dependents requires
   re-parent or cascade confirmation; after execution starts, only
   not-yet-started nodes are editable.
4. **Node Detail** — tabs: Prompt, Conversation, Artifacts, Files, Tests
   (runner-produced verification evidence), Reviews, Usage, Logs.
5. **PM Dashboard** — progress, active agents, blocked nodes, review queue,
   cost vs. budget (usage-source labeled), token usage, risks, PM summary.
   ETA is labeled experimental and de-emphasized. All figures derive from
   the engine and ledger — never LLM self-report.

## Plan Contract

Machine-readable plan format sufficient to drive graph rendering,
**execution, verification, and safe parallelization**. Planner/PM agents
emit it; the reviewer reviews it; the engine validates it before graph
conversion.

A plan is JSON (rendered as Markdown for humans): `objective`,
`assumptions[]`, `risks[]` (with mitigations), `out_of_scope[]`, and
`modules[]`, each:

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
    "test_commands": [],
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

Path ownership is a planning **hint** the Module Lead validates against the
actual repository before workers launch. Complexity and risk are independent
axes. Engine validation: unique ids, resolvable dependencies, acyclic graph,
every module has ≥1 acceptance criterion with an executable (or explicitly
human) verification. Invalid plans return to the PM with errors and never
reach the human as "ready for approval."

## Planning Workflow

```
Human objective → PM → Plan V1 → Reviewer → Findings
   → PM revision → Reviewer → … → Convergence → Human approval → Approved Plan
```

**Bounds:** max 3 rounds (configurable); convergence = no must-fix findings;
at the cap, the human sees outstanding findings and decides (approve anyway
/ another round / restart).

**Findings format:** `severity` (must-fix / should-fix / suggestion),
`module_id` or plan-level, `finding`, `recommendation`. The PM must respond
to every must-fix (accept + revise, or rebut with rationale); rebuttals are
visible at approval.

**Review Policy:** cross-provider review is the **default policy**, not an
engine invariant. The human may approve a documented exception (outage,
model access, capability gap, data sensitivity, deliberate same-provider
pairing). Recorded: requested policy, actual provider/model, reason, human
approval.

## Graph & Execution Workflow

```
Approved Plan → Graph → Allocation (human-gated) → Execution → QC → PR (human-gated merge)
```

**Node lifecycle (engine-owned):**

```
pending → ready → assigned → running → verifying → review → verified → integrated
```
side states: `blocked` (dependency / budget / runner / integration),
`failed`, `cancelled`.

**Runner-executed verification:** worker reports completion → runner
captures the commit → runner executes the module's verification commands in
a clean worktree → engine records the immutable result → node enters
`review`. Reviewer approval assesses the diff, runner-produced results,
acceptance evidence, and unresolved risks. `verified` = reviewer sign-off;
`integrated` = clean merge into the integration branch with tests passing.

## Allocation

Manual per-node assignment (provider, model, role, worker count) or **Auto
Allocate**. PM recommends model, worker count, reviewer, budget, and
rationale per node. Strategies: Quality / Balanced / Cost. Rule-based
(complexity × risk × role → model tier, workers, budget).

**Worker-count semantics:** N > 1 = N parallel agents, each in its own
worktree/branch, on pre-split work units from the module's `parallelization`
block validated by the Module Lead. Workers never share a worktree. N > 1
requires a Module Lead. Design cap N = 3; **pilot cap N = 2**.

**Cost preview:** estimated total (sum of node budgets) + per-node budgets
shown before allocation approval. Allocation approval = budget approval.

## Budget Enforcement

Engine-enforced with **atomic reservations**:

```
available = approved budget − settled actual usage − active reservations
```

Per dispatch: compute a maximum-charge reservation (context size, max output
tokens, provider pricing, runtime allowance) → reserve atomically in
Postgres → reject if insufficient → settle on actual usage → release the
remainder. Per-call and per-run caps bound single-call overshoot.

- 80% (settled + reserved): PM notified, must summarize status.
- 100%: node paused (`blocked: budget`); human extends, reassigns, or
  cancels. **No agent, including the PM, can extend a budget.**
- Project hard cap: pauses everything, triggers the kill switch.

Subscription-authenticated runtimes without token cost expose duration,
provider-reported credits where available, normalized status — recorded
under their true `usage_source`, never as false precision.

## Usage Telemetry

Every figure carries `usage_source: provider_api | runtime_report |
subscription_credit | estimate | unavailable`, plus confidence, pricing
version, and billable-vs-subscription-vs-estimate classification. Aggregates
never merge API dollar cost and subscription consumption into one unlabeled
number.

## Agent Types

- **PM** — planning, decomposition, routing, allocation recommendations,
  summaries, monitoring. Cannot bypass approvals, merge, or extend/ignore
  budgets.
- **Planner** — optional PM delegate for plan drafting; exists only when
  explicitly delegated (not a mandatory separate role in MVP).
- **Reviewer** — non-authoring provider by default (Review Policy);
  structured findings; also reviews diffs + verification evidence at
  `review` gates.
- **Module Lead** — for N > 1 nodes: validates parallelization boundaries
  against the repo, splits work, resolves worker questions (PM-routed),
  assembles the node branch.
- **Implementation Worker** — works only inside its sandbox + assigned
  worktree/branch.
- **Integration** — merges verified branches in dependency order. **Clean
  merges only.** On conflict: node becomes `blocked: integration` and the
  engine creates a dedicated **conflict-resolution node** — human-approved
  model, independent review, human confirmation if it materially modifies
  both sides. Never resolves conflicts implicitly, never force-pushes,
  never touches `main`.
- **QA** — end-to-end validation on the integration branch: project test
  suite + Plan Contract acceptance criteria, executed via the runner.
  Structured findings.

## Execution Sandbox Contract

A Git worktree provides source-control isolation, not OS isolation. Every
coding run executes inside an OS-level sandbox (implementation in Part II,
ADR-003). **Startup fails closed** — no sandbox, no run.

The contract: writable paths = assigned worktree + scratch only; readable
paths = worktree, scratch, explicit per-node allowlist (no `$HOME`, SSH
keys, cloud credential files, browser profiles); explicit environment
allowlist, nothing inherited; network deny-by-default with egress only to
the provider runtime's endpoints (+ package registries when the node's
policy allows); process/CPU/memory limits + max runtime per node; provider
credentials never injected broadly — the runner brokers access or injects
narrowly scoped short-lived credentials; workers commit locally inside the
sandbox and **only the runner pushes/fetches from outside it**; package
installation is a per-node policy flag; no Docker/container-management
access inside; test services provided as sandbox-local resources declared in
`environment_requirements`.

Minimum sandbox enforcement is acceptance for the first execution phase
(Phase 5); Phase 8 adversarially hardens an existing boundary.

## Runner Protocol

Two independent durable streams surviving disconnects and restarts:

- **runner → server events:** per-runner monotonic `event_seq`; disk-backed
  buffer; replay from the server's `ack_event_seq` watermark on reconnect.
- **server → runner commands:** durable server-side **command outbox**;
  every mutating command has a globally unique `command_id` + idempotency
  key; the runner keeps a durable local record of executed command ids so
  replays cannot execute twice.

**Delivery guarantee (stated honestly): at-least-once transport with
idempotent command execution and durable deduplication.** Exactly-once is
not claimed.

**Command state machine:**

```
created → queued → delivered → accepted → executing
        → succeeded | failed | rejected | expired | cancelled
```

Plus: per-runner **generation (fencing) token** (stale runners cannot act
after replacement); command expiry; explicit conflict rules (cancel racing
completion → first terminal state commits, loser recorded as superseded);
idempotent command application covers pause-before-pause-ack; a
reconciliation handshake on every reconnect (exchange watermarks, replay
both directions); per-session authorization with commands bound to
project/node/repository.

**Pause/resume are not one control.** Each runtime adapter must publish a
capability matrix over: **Interrupt** (stop current turn safely),
**Suspend** (OS-level, where supported), **Resume session** (reconnect to a
persisted runtime session), **Cancel** (terminate, preserve worktree),
**Stop after current action** (cooperative safe-stop). UI controls map to
declared capabilities, never assumptions.

## Failure Handling & Recovery

- **Agent run failure** (crash, provider error, malformed output): one
  retry with same context; second failure → `failed`, PM notified,
  recommends reassign/retry/escalate. Failures never silently disappear.
- **Runner disconnect:** in-flight runs continue locally; buffer + replay
  per protocol; beyond a configurable window (default 10 min) nodes become
  `blocked: runner`, human notified.
- **Server restart:** outbox and watermarks are durable rows; the dispatch
  loop recovers from the database, not process memory.
- **Browser disconnect:** server is source of truth; browser is a pure view.
- **Partial completion:** worktrees preserved on failure; retry uses a
  fresh worktree unless the human resumes the existing one.
- **PM context limits:** PM operates on engine-maintained state summaries;
  raw transcripts live in the artifact store.

## Supported Providers (MVP)

- **Anthropic:** Claude Opus, Claude Sonnet (LLM); Claude Code runtime via
  the Claude Agent SDK.
- **OpenAI:** GPT reasoning models (LLM); Codex runtime via the official
  TypeScript Codex SDK / app-server, capability-verified at runner
  registration.

Model ids and pricing live in configuration. Runtime adapters may wrap
external binaries. Runtimes may authenticate via subscription/OAuth flows
distinct from API keys — the credential store supports both shapes;
telemetry differences are handled by usage-source labeling.

## Git

Local repositories and GitHub via the Repository adapter. Every
implementation runs in an isolated worktree on its own branch, inside a
sandbox. Branch naming: `norns/<project>/<node-id>[-w<worker>]`; conflict
nodes `…-conflict`. Integration on `norns/<project>/integration`; `main`
changes only via the human-approved PR merge. Pushes performed by the
runner, never by workers.

## Remote Control & Local Runner

Remote control is the riskiest architectural bet, validated first as a
**production-bound** vertical slice — protocol contracts are frozen in
Phase 0B before it is built.

**Topology:** Browser ⇄ Cloud server (relay) ⇄ Local Runner; runner
outbound-only TLS WebSocket; no inbound firewall changes. The server holds
routing state, the command outbox, and the audit feed — never repository
contents.

**Runner responsibilities:** execute jobs, manage worktrees, launch
sandboxed runtimes, execute verification, stream events, maintain the
durable protocol, register repositories, heartbeat.

**Authentication & session security:** browser passkeys (≥2 enrolled or one
encrypted recovery code), short-lived sessions, recent-auth for high-risk
actions (approvals, budget extensions, runner enrollment, kill switch),
origin checks, SameSite secure cookies, rate limiting; runner pairing code →
per-runner Ed25519 keypair with rotation, a revocation list, generation
fencing; per-command authorization bound to project/node/repository;
command expiry; notifications on new runner enrollment and new browser
sessions. No RBAC in MVP.

**Phase 1A acceptance — browser on another device only:** view runner
status; launch fixture task; stream logs (< 2 s latency); send message;
exercise the control set; kill the runner's network mid-task and verify
event replay **and** command replay per protocol (no gaps, no duplicate
execution); restart the server mid-task and verify recovery from durable
state; every command in the audit trail with actor, timestamp, outcome.

## Data Model (entities and key relationships)

Workspace → Projects; Project → one Repository, many Plans, one active
Workflow. Plan (versioned) → Reviews; one version becomes Approved. Review →
Plan version or WorkflowNode; structured findings. Workflow → WorkflowNodes;
WorkflowNode → edges, one Assignment, many AgentRuns. Assignment = provider,
model, role, worker count, reviewer, budget. AgentRun → Messages, Artifacts,
UsageEvents, one Worktree, one Sandbox record (policy applied, limits).
**Command** = outbox row (command_id, idempotency key, state, expiry, runner
generation). **Reservation** = active budget hold (node, run, max charge,
state). UsageEvent = provider, model, node, run, tokens, estimated/actual
cost, usage_source (append-only ledger). **VerificationResult** =
runner-produced, immutable (commit hash, command, output digest, pass/fail).
**DecisionRecord** = versioned material decisions, linked to approvals.
Approval = human decisions (plan, allocation, budget extension, merge,
review exception): actor, timestamp, content hash. Artifact = metadata +
content hash in Postgres, blob in object storage. AuditEvent = append-only
record of every command, transition, and agent decision — distinct from
workflow events (state-changing) though some events are both; the streams
stay separable.

## Artifact & Log Storage

Postgres = metadata + content hashes; large logs, transcripts, patches,
artifacts → S3-compatible object storage (local disk in dev). Artifact
records carry: content hash, size, MIME type, compression, retention class,
redaction status, storage URI, immutable version, deletion tombstone.
Provider responses stored immutably. Audit metadata retained indefinitely;
transcripts/logs by retention class with explicit deletion policy.

## Progress

From objective workflow gates only — a node contributes its complexity
weight as it passes lifecycle gates; never LLM self-estimation. **ETA is
experimental in MVP:** de-emphasized, confidence-banded, labeled, until
enough completed projects exist to calibrate.

## Security

- OS-level execution sandbox, fail-closed (Sandbox Contract + ADR-003)
- Encrypted credential store (API keys + runtime OAuth tokens);
  runner-brokered, narrowly scoped, short-lived injection
- Append-only audit log for every command and transition
- Runner pairing, key rotation, revocation list, generation fencing
- Browser auth hardening (multi-passkey/recovery, short sessions,
  recent-auth, origin/CSRF, rate limiting, alerts)
- Per-command authorization bound to project/node/repository
- Engine-enforced approval gates (plan, allocation, budget extension,
  merge, review exception)
- Secret redaction on streamed logs before they leave the runner
  (heuristic — defense in depth relies on the sandbox limiting what reaches
  logs)
- Kill switch: server-side flag checked by the dispatch loop (works when
  the runner is wedged); pauses all runs, revokes in-flight dispatches,
  requires human resume; auto-triggered by the project hard cap

---

# PART II — ARCHITECTURE DECISIONS

## ADR-001: Technology Stack (amended per REVIEW-001)

**TypeScript everywhere, pnpm-workspaces monorepo** (`apps/server`,
`apps/web`, `apps/runner`, `packages/contracts`). Node = current Active LTS
(24 at writing), pinned; downgrade only on verified dependency
incompatibility.

- **Shared contracts:** zod schemas for Plan Contract, Execution Contract,
  command/event envelopes (state machine, watermarks, fencing), lifecycle
  and usage events — single source of truth, frozen in Phase 0B; no agent
  modifies them without architecture-lead approval.
- **Backend:** Fastify + `ws`; PostgreSQL (managed, ADR-002); Drizzle.
- **Workflow engine:** hand-rolled event-sourced state machine — append-only
  event log, explicit deterministic reducer, determinism tests, event schema
  versioning + upcasters, stream version checks. No XState/Temporal.
- **Dispatch:** durable `dispatch_jobs` outbox (status, attempts,
  available_at, lease_owner, lease_expires_at, payload); dispatcher polls
  with `FOR UPDATE SKIP LOCKED`, takes leases, records outcomes, recovers
  expired leases. **LISTEN/NOTIFY is a wake-up hint only**; polling
  guarantees recovery. Event store ≠ dispatch queue ≠ command outbox ≠
  runner event stream ≠ audit feed — kept as distinct structures.
- **Frontend:** React 19 + Vite, React Flow, TanStack Query, zustand,
  Tailwind v4.
- **Runner:** TypeScript daemon (`npx norns-runner`); Claude Code via
  `@anthropic-ai/claude-agent-sdk`; **Codex via the official TypeScript SDK
  `@openai/codex-sdk`** (threads, streaming, session resume), CLI/app-server
  subprocess as fallback if the SDK lacks a lifecycle hook — verified at
  implementation time; runtime capability detection at runner registration.
  Git via the plain `git` CLI. Durable local command-dedup store. Sandbox
  launcher per ADR-003.
- **Budget reservations** are atomic Postgres transactions. No Redis.
- **Testing:** Vitest (reducer determinism, idempotency, budget races),
  Playwright (MVP acceptance), adapter conformance suites (LLM + runtime
  capability matrix). Biome for lint/format.

**Rejected:** Python backend (splits contract types); Python Codex sidecar
(unnecessary — official TS SDK exists); Go runner (post-MVP candidate);
XState; Temporal (operational weight; explicit event log is the product
feature); SQLite as primary DB; bare LISTEN/NOTIFY dispatch.

## ADR-002: Relay Topology, Hosting & Data Services (amended per REVIEW-001)

- **No separate relay service** — the backend server is the relay:
  `/ws/session` (browser) + `/ws/runner` (runner) + HTTP API. Connection
  state is never trusted solely in process memory; outbox rows and ack
  watermarks are durable, so server restart recovers from the database.
- **App hosting: Fly.io**, single region, single small machine, TLS
  automatic, `flyctl` deploys. Single machine = brief deploy downtime,
  tolerated because runner buffer-and-replay doubles as deploy tolerance.
- **Database: managed Postgres on Neon** (~$0–19/mo at this scale;
  automated backups + PITR). Fly's legacy Postgres is unmanaged; Fly's
  Managed Postgres is genuine but starts ~$38/mo — designated same-platform
  alternative. NOTIFY-drop over managed poolers is irrelevant by design
  (polling is the guarantee).
- **Artifacts: S3-compatible object storage** (Tigris via Fly or any
  bucket; local disk in dev).
- **Mandatory before pilot:** verified automated backups, documented PITR
  expectations, migration rollback procedure, **a tested restore**
  (Phase 8 exit).
- Cost envelope all-in: ~US$10–35/month.

**Rejected:** Railway (fallback), Fly MPG (cost), self-operated Fly
Postgres (ops burden), Hetzner VPS (ops), Cloudflare Workers/DO (needs a
long-running Node process), Tailscale direct-to-runner (audit trail must
survive runner loss).

## ADR-003: Execution Sandbox (new, resolves REVIEW-001 P0-1)

**Primary: disposable OCI containers per coding run**, launched by the
runner: worktree + scratch bind-mounted writable and nothing else; explicit
read-only allowlist mounts; explicit env allowlist; network deny-by-default
with egress only to provider endpoints (+ registries when node policy
allows), enforced at the container network layer; cgroup CPU/memory/pids
limits + wall-clock ceiling; no container-management access inside;
runner-brokered short-lived credentials; workers commit inside, **runner
pushes from outside**; test services as sibling containers on an isolated
per-run network.

**Secondary (only when containers are impossible on a host):** the provider
runtime's own verified sandbox mode configured to fail if unavailable —
never silent unsandboxed fallback.

**Fail-closed:** no sandbox → the run does not start; node blocks with a
human-visible reason. Runner registration reports sandbox capability;
scheduling respects it.

**Rejected:** bare subprocess + allowlist (cannot guarantee the contract —
the R2 design this replaces); full VMs per run (heavy on a laptop; revisit
for multi-tenant); chroot-style confinement (platform-inconsistent, no
network policy). Command allowlists remain as defense-in-depth inside the
sandbox, not the primary boundary.

---

# PART III — EXECUTION PLAN

Estimates are focused agent sessions (hour-scale units). Calendar time is
gated by human approval cadence, cross-device testing, and four genuinely
hard areas: **planning quality (Phase 3), multi-agent coordination
(Phase 7), runner protocol durability (0B/1A), sandboxing (Phase 5)**.
Planning envelope: **40–65 sessions** to internal MVP, plus pilot
remediation. Phases overlap; do not sum sessions as calendar duration.

| Phase | Scope | Sessions | Exit criterion |
|---|---|---|---|
| 0A | Architecture lock — scope, state model, data model, sandbox strategy, credential strategy, adapter boundaries, hosting, retention, event-vs-audit semantics; ADRs Accepted | 2–3 | ADR-001/002/003 Accepted; monorepo scaffolded, CI green |
| 0B | Protocol & contract lock — Plan Contract v1, Execution Contract v1, command/event envelopes, ack/replay semantics, command state machine, usage/approval/artifact schemas | 2–3 | Contracts v1 tagged; reducer determinism + idempotency test harness in place |
| 1A | Remote-control vertical slice (production-bound) — server, durable outbox, audit log, pairing, runner dedup store, reconnect/replay both directions, passkey session, fixture task, remote controls. No LLMs | 6–9 | Full 1A acceptance incl. forced-disconnect and server-restart tests, from a second device |
| 1B | Workflow & repository foundation — reducer, dispatch_jobs + leases, approvals, budgets + reservations, local Git adapter, worktree manager, sandbox launcher, kill switch | 5–8 | Fixture graph through all states; sandbox fails closed; synthetic budget races handled |
| 2 | Direct LLM adapters — Anthropic + OpenAI, structured output, usage normalization + source labels, model registry, failure taxonomy, cancellation; conformance suite | 3–5 | Conformance green on both live providers; ledger reconciles |
| 3 | Planning & review — PM conversation, Plan Contract generation, validation round-trips, cross-provider review + exceptions, finding disposition, versioning, plan approval. *Genuinely slow: prompt-quality iteration* | 5–8 | Loop runs on 3 objectives, zero copy/paste; bad plan caught; cap-reached path correct |
| 4 | Graph & allocation (merged to avoid building the graph UI twice) — rendering, editing + validation, assignment UI, three strategies, cost preview, allocation approval | 4–6 | 10-node graph editable + auto-allocated per strategy; overrides persist |
| 5 | Single-agent coding execution — Claude Code + Codex adapters, capability matrix, sandboxed worktree runs, runner-executed verification, review gate, live budget enforcement, remote controls on real runs. *Sandbox enforcement is acceptance here* | 6–10 | One node end-to-end per runtime, sandboxed, remotely controlled; budget exhaustion pauses; verification runner-produced |
| 6 | Dashboard (before multi-agent, to operate later phases) — node state, logs, blockers, approvals, labeled usage, budget, Git status, PM summary | 3–5 | Dashboard provably derives from engine events; totals match ledger |
| 7 | Multi-agent coordination — max 2 workers, Module Lead, bounded decomposition, per-worker worktrees, PM-routed questions, assembly, clean integration, conflict-resolution nodes, failure recovery. *Genuinely hard: interleavings* | 7–12 | 5-node graph with one 2-worker node end-to-end; induced conflict spawns a conflict node; induced failure escalates |
| 8 | Security & resilience gate — sandbox-escape, planted-secret, command-replay, disconnect/stale-runner/fencing, budget races, cancellation races, runner revocation, backup restore test | 5–8 | Hostile-prompt node fully contained and audited; race tests green; restore verified |
| 9 | Pilot — one bounded real project through the full flow; MVP acceptance as the formal gate; remediation | 4–8 + calendar | All MVP acceptance checks pass on the pilot |

**Pilot scope limits:** one PM · one reviewer · max two concurrent workers ·
one integration branch · one runner · one GitHub repository · one standard
test-command configuration · manual (node-based) conflict resolution ·
API-key auth for direct LLM calls · whichever runtime auth mode is stable
locally · ETA hidden/experimental. Deferred beyond pilot: three-worker
nodes, allowlist-authoring UI, in-flight graph editing, cost-learning,
object-storage UI, arbitrary custom acceptance mechanisms.

**Build team (for building TheNorns itself):** persistent Claude Opus-class
architecture lead (owns contracts/ADRs/scope; approves all contract
changes); independent review by the top OpenAI reasoning model (per config)
after 0A, 0B, 1A, 5, 7, and pre-pilot; Claude Sonnet-class backend and
frontend leads; Codex as runner/security lead; QA = Codex (tests, failure
injection) + OpenAI reasoning model (evidence review). ≤3 implementation
agents until Phase 4; runner+backend pair on Phase 5; one temporary extra
worker for Phase 7 concurrency testing with a single integration owner.

## MVP Acceptance (demonstrated on the pilot)

1. Cross-provider planning with ≥1 full review round, zero copy/paste; any
   review-policy exception recorded and approved.
2. Approved plan converts to an editable, validated graph.
3. Auto Allocate produces per-node recommendations with rationale and an
   up-front total cost estimate; human can override any field.
4. Remote browser on a different network exercises the full control set;
   forced disconnect/reconnect loses no events and duplicates no command
   execution; server restart recovers from durable state.
5. Claude Code and Codex each complete ≥1 node **inside the sandbox**, with
   runner-executed verification.
6. A hostile-prompt test node (worktree escape, planted-secret
   exfiltration, network egress) is fully contained and audited.
7. Budget exhaustion pauses the node; concurrent dispatches cannot
   oversubscribe a budget (reservation race test); the project hard cap
   halts everything.
8. Dashboard progress changes only on gate transitions; displayed cost
   matches the ledger, with usage-source labels.
9. Induced worker failure and induced merge conflict surface through the
   defined paths — the conflict via a conflict-resolution node.
10. A PR is created and mergeable only after explicit human approval; the
    audit trail reconstructs who/what/when for every decision.

---

# PART IV — OPEN DECISIONS, RISKS & ROUND-2 QUESTIONS

## Open decisions

- Human approval of ADR-001/002/003 (all Proposed; Phase 0A exit).
- Fly.io + Neon accounts and payment methods (human-only; gates 1A).
- Contracts v1 freeze (Phase 0B exit).
- `@openai/codex-sdk` lifecycle coverage (interrupt/resume/streaming)
  verified at Phase 5 implementation; CLI/app-server subprocess fallback.
- Pilot project selection (Phase 9).

## Known risks

1. **Codex adapter churn** — the runtime surface moves faster than the API;
   isolated behind the adapter + capability matrix; versions pinned.
2. **Reservation conservatism** — maximum-charge reservations may
   temporarily over-hold budget and serialize dispatches on small budgets;
   accepted for MVP (correctness over throughput), released on settlement.
3. **PM plan quality (Phase 3)** — the product's core bet; mitigated by
   schema-constrained output, validation round-trips, cross-provider review.
4. **Coordination correctness (Phase 7)** — hardest logic; event-sourced
   replayability makes interleavings testable, but expect iteration.
5. **Sandbox friction** — containerized runtimes on developer machines
   (macOS Docker substrates) may hit auth/filesystem quirks; secondary mode
   (provider-verified sandbox, fail-closed) is the pressure valve.
6. **Single-machine relay** — deploy downtime, no failover; tolerated via
   buffer-and-replay; revisit on connection churn in pilot.
7. **Heuristic secret redaction** — pattern-based; defense-in-depth relies
   on the sandbox limiting what reaches logs; planted-secret tests in
   Phase 8.

## Round-2 questions for the reviewing agent

1. **Sandbox contract completeness:** does ADR-003 close P0-1, or are there
   remaining escape/exfiltration paths (e.g., via the permitted provider
   egress, package-registry access, sibling test-service containers, or the
   runner-mediated push flow)?
2. **Protocol consistency:** are the command state machine, fencing
   generations, expiry, and conflict rules mutually consistent? Any
   interleaving (e.g., expiry racing `executing`, generation bump during
   replay) that produces stuck or duplicated work?
3. **Reservation model:** is max-charge reservation workable in practice,
   or does it starve concurrent dispatch enough to need refinement (partial
   reservations, per-node concurrency = 1) inside MVP?
4. **Verification trust chain:** worker commit → runner clean-worktree
   verification → immutable result — any gap that lets a worker influence
   its own verification (e.g., test files it authored, `test_commands` it
   proposed via the plan)?
5. **Conflict-resolution nodes:** is the spawn-a-node design sound for
   dependency ordering (does a conflict node inherit/block the right
   downstream edges)?
6. **New inconsistencies:** do any R3 additions contradict each other or
   the retained R2 text (states, entity names, phase references)?
7. **Over-engineering check:** is anything added in R3 beyond what its
   originating finding requires — candidates: DecisionRecords, the full
   artifact metadata set, five pause controls — that should be trimmed to
   reach the pilot faster?
8. **Estimate sanity:** does 40–65 sessions still hold given the added
   sandbox and protocol work now landing in Phases 0B–1B and 5?

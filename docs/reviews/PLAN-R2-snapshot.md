# TheNorns — Full Plan (Review Packet)

> **⚠️ SUPERSEDED (2026-07-13).** This is the R2 snapshot that was sent for
> independent review. The review's findings were adopted — see
> `docs/reviews/REVIEW-001-disposition.md` for the per-finding disposition —
> and the canonical files are now ahead of this packet: `TheNorns_MVP_PRD.md`
> (R3), `docs/adr/ADR-001` (amended), `docs/adr/ADR-002` (amended),
> `docs/adr/ADR-003` (new). Regenerate this packet from those files before
> any second external review round. Kept unmodified below as the record of
> what REVIEW-001 reviewed.

> **What this document is.** A self-contained consolidation of the TheNorns
> MVP plan for independent review: product spec (Part I), architecture
> decisions (Part II), execution plan with work breakdown and estimates
> (Part III), and open decisions/risks (Part IV). Generated 2026-07-13 from
> the canonical files `TheNorns_MVP_PRD.md`, `docs/adr/ADR-001-tech-stack.md`,
> and `docs/adr/ADR-002-relay-hosting.md` — if this packet and those files
> diverge, the canonical files win.

> **Instructions for the reviewing agent.** Review all four parts. Return
> structured findings, each with: `severity` (P0 must-fix / P1 should-fix /
> P2 suggestion), `section` (which part and heading), `finding`, and
> `recommendation`. Questions worth specific scrutiny are listed at the end
> of the document. Do not propose scope additions beyond MVP; flag scope
> *cuts* freely.

---

# PART I — PRODUCT SPECIFICATION (PRD R2)

## Purpose

TheNorns is a visual AI Program Management platform that orchestrates work
across multiple AI providers (initially Anthropic and OpenAI). It manages
planning, execution, review, Git operations, and quality control while
providing a single PM-centric interface.

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
- Claude Code + Codex execution via a Local Runner
- Remote control from a browser on another device
- PM dashboard with deterministic progress
- Token/cost tracking with budget enforcement
- Complete audit trail
- Pull request creation with human merge approval

## Non-Goals (MVP)

- Providers beyond Anthropic and OpenAI (architecture stays provider-neutral)
- Git hosts beyond local repositories and GitHub
- Multi-user collaboration, roles, or permissions (single human operator)
- Learned/ML-based allocation (rule-based only)
- Autonomous merges or autonomous plan approval — the human always gates both
- Mobile-native apps (responsive browser UI only)
- Self-hosted relay for third parties (single-tenant relay is sufficient)

## Guiding Principles

1. PM is the product.
2. Human always has final approval.
3. Cross-provider review is mandatory for important work.
4. All agent communication is brokered through the PM.
5. Deterministic workflow engine owns state — not the LLM.
6. Every decision is auditable.
7. Safety over autonomy.

## Primary User Flow

1. Select PM model.
2. Enter objective or paste existing plan.
3. PM creates Plan V1 (structured — see Plan Contract).
4. Plan sent to Reviewer on the other provider.
5. PM revises against findings.
6. Additional review rounds until convergence or the round cap (default 3).
7. **Human approves plan** (approval gate).
8. Workflow engine converts the plan into a dependency graph.
9. PM recommends allocation (model, workers, reviewer, budget per node).
10. Human adjusts and/or approves allocation (**approval gate**).
11. Execution begins on the Local Runner.
12. PM supervises; workflow engine advances nodes through gates.
13. QC validates integrated work.
14. Pull request is created.
15. **Human merge approval** (approval gate — merge happens only after this).

## Core Screens

1. **PM Workspace** — conversation-first: choose PM, create/open project,
   enter prompts, read summaries, launch planning, receive recommendations.
2. **Plan Review** — each plan version, reviewer findings, PM responses,
   final plan, diffs between versions, review round counter, convergence
   status.
3. **Workflow Graph** — editable dependency graph. Each node: title, status,
   dependencies, provider, model, role, worker count, reviewer, budget,
   progress, usage. Editing rules: edges must remain acyclic (cycle attempts
   rejected with the offending path shown); deleting a node with dependents
   requires confirming re-parenting or cascade; after execution starts, edits
   are limited to not-yet-started nodes.
4. **Node Detail** — tabs: Prompt, Conversation, Artifacts, Files, Tests,
   Reviews, Usage, Logs.
5. **PM Dashboard** — overall progress, active agents, blocked nodes, review
   queue, cost, token usage, ETA, risks, PM summary. Progress and cost come
   from the workflow engine and usage ledger — never from LLM self-report.

## Plan Contract

The bridge between "PM writes a plan" and "engine builds a graph" is a
machine-readable plan format. Planner and PM agents must emit it; the
reviewer reviews it; the engine validates it before graph conversion.

A plan is JSON (rendered as Markdown for humans) containing:

- `objective` — one-paragraph goal statement
- `assumptions[]` — explicit assumptions the human should verify
- `modules[]` — each with:
  - `id` (stable slug), `title`, `description`
  - `deliverables[]` — concrete artifacts (files, endpoints, docs)
  - `acceptance[]` — objectively checkable completion criteria
  - `dependencies[]` — module ids
  - `estimated_complexity` — S / M / L (feeds allocation)
- `risks[]` — with mitigation notes
- `out_of_scope[]`

Engine validation on submission: unique ids, resolvable dependencies, acyclic
graph, non-empty acceptance criteria per module. A plan that fails validation
is returned to the PM with the errors; it never reaches the human as "ready
for approval."

## Planning Workflow

```
Human objective → PM → Plan V1 → Reviewer (other provider) → Findings
     → PM revision → Reviewer → … → Convergence → Human approval → Approved Plan
```

**Review loop bounds.** Default maximum of 3 review rounds (configurable).
Convergence = the reviewer returns no findings at severity "must-fix." If the
cap is reached without convergence, the loop stops and the human sees the
outstanding findings alongside the plan — the human decides whether to
approve anyway, request another round, or restart.

**Reviewer findings format.** Structured: `severity` (must-fix / should-fix /
suggestion), `module_id` (or plan-level), `finding`, `recommendation`. The PM
must respond to every must-fix finding (accept + revise, or rebut with
rationale). Rebuttals are visible to the human at approval time.

## Graph & Execution Workflow

```
Approved Plan → Graph → Allocation (human-gated) → Execution → QC → PR (human-gated merge)
```

**Node lifecycle (states owned by the workflow engine):**

`pending → ready → assigned → running → review → approved → integrated`
with side states `blocked` (dependency or budget), `failed`, `cancelled`.

Gate transitions are objective: a node enters `review` when its worker(s)
report completion **and** its acceptance checks pass; `approved` only on
reviewer sign-off; `integrated` only when its branch merges into the
integration branch cleanly with tests passing.

## Allocation

The user may manually assign per node: provider, model, role, worker count —
or click **Auto Allocate**. The PM recommends per node: model, worker count,
reviewer, budget, and a one-paragraph rationale. Three strategies:
**Quality**, **Balanced**, **Cost**. The initial engine is rule-based
(complexity size × role → model tier and worker count).

**Worker-count semantics.** A node with N > 1 workers means N parallel
implementation agents, each in its **own worktree and branch**, working on a
pre-split portion of the node defined by the Module Lead. Workers never share
a worktree. N > 1 requires a Module Lead on that node; MVP caps N at 3.

**Cost preview.** Before the human approves allocation, the dashboard shows
an estimated total project cost (sum of node budgets) and per-node budgets.
Approval of allocation is approval of the budget.

## Budget Enforcement

Budgets are enforced by the workflow engine, not by agent good behavior:

- Every provider call is metered against the node budget **before dispatch**.
- At 80% of a node budget the PM is notified and must summarize status.
- At 100% the engine pauses the node (`blocked: budget`) and asks the human
  to extend, reassign, or cancel. No agent, including the PM, can extend a
  budget.
- A project-level hard cap (set at allocation approval) pauses everything
  when reached. This is also the kill-switch threshold for runaway loops.

## Agent Types

- **PM** — planning, decomposition, routing, allocation recommendations,
  summaries, monitoring. Cannot: bypass approvals, merge, extend or ignore
  budgets.
- **Planner** — creates structured plans conforming to the Plan Contract.
- **Reviewer** — always the non-authoring provider; returns structured
  findings; also reviews implementation diffs at node `review` gates.
- **Module Lead** — coordinates N > 1 workers on a node: splits work,
  resolves questions, assembles the node branch.
- **Implementation Worker** — works only in its assigned worktree/branch;
  command restrictions apply.
- **Integration** — merges approved node branches into the integration
  branch in dependency order. On conflict: attempts resolution in a scratch
  worktree; if tests pass, proceeds; otherwise marks the node
  `blocked: integration` and escalates to the PM, which summarizes for the
  human. Never force-pushes, never touches `main`.
- **QA** — runs end-to-end validation on the integration branch: the
  project's own test suite plus the Plan Contract acceptance criteria.
  Findings are structured like reviewer findings.

## Failure Handling & Recovery

- **Agent run failure** (crash, provider error, malformed output): engine
  retries once with the same context; a second failure marks the node
  `failed` and notifies the PM, which recommends reassign / retry /
  escalate. Failures never silently disappear.
- **Runner disconnect:** in-flight runs continue locally; events buffer on
  the runner and replay on reconnect. If disconnect exceeds a configurable
  window (default 10 min), affected nodes become `blocked: runner` and the
  human is notified. Reconciliation is idempotent (event-sourced, monotonic
  sequence numbers).
- **Server/browser disconnect:** the server is the source of truth; the
  browser is a pure view and reconnects at any time.
- **Partial node completion:** worktrees are preserved on failure for
  inspection; a retried node starts from a fresh worktree unless the human
  chooses to resume the existing one.
- **PM context limits:** the PM operates on engine-maintained state
  summaries (node statuses, open findings, budget ledger), not raw
  transcript history. Raw transcripts stay in the audit store.

## Supported Providers (MVP)

- **Anthropic:** Claude Opus, Claude Sonnet (LLM); Claude Code (runtime)
- **OpenAI:** GPT reasoning models (LLM); Codex (runtime)

Concrete model ids live in configuration, not in this document. Design
remains provider-neutral. **Runtime authentication note:** coding runtimes
may authenticate via subscription/OAuth flows that differ from API-key auth
for the LLM adapters; the credential store must support both shapes.

## Git

- Local repositories and GitHub (via the Repository adapter).
- Every implementation runs in an isolated worktree on its own branch.
- Branch naming: `norns/<project>/<node-id>[-w<worker>]`.
- Integration happens on `norns/<project>/integration`; `main` is never
  edited directly and changes only via the human-approved PR merge.

## Remote Control & Local Runner (Phase 1A)

Remote control is the riskiest architectural bet, so it is validated first as
a vertical slice — before the full backend exists, against a minimal relay.

**Topology:** Browser ⇄ Cloud relay/API ⇄ Local Runner. The runner makes an
**outbound-only** TLS WebSocket connection to the relay; no inbound firewall
changes. The relay stores routing state and the audit feed, not repository
contents.

**Runner responsibilities:** execute jobs, manage worktrees, launch coding
runtimes, stream events, maintain the secure outbound connection, register
repositories, heartbeat, buffer-and-replay on reconnect.

**Runner authentication:** one-time enrollment via a short-lived pairing code
shown in the browser; thereafter a per-runner keypair. Browser sessions
authenticate independently. Commands are authorized per session and logged.

**Phase 1A acceptance — using only a browser on another device:**
view runner status; launch a fixture task; stream live logs (< 2 s latency);
send a message to the running task; pause, resume, cancel; kill the runner's
network mid-task and verify buffered events replay on reconnect with no gaps
or duplicates; verify every command appears in the audit trail with actor,
timestamp, and outcome.

## Data Model (entities and key relationships)

- **Workspace** → has many Projects
- **Project** → one Repository, many Plans, one active Workflow
- **Repository** → registered on a Runner
- **Plan** → versioned; many Reviews; one version becomes Approved
- **Review** → belongs to a Plan version or WorkflowNode; structured findings
- **Workflow** → built from the approved Plan; many WorkflowNodes
- **WorkflowNode** → dependencies (edges), one Assignment, many AgentRuns
- **Assignment** → provider, model, role, worker count, reviewer, budget
- **AgentRun** → many Messages, Artifacts, UsageEvents; one Worktree
- **Worktree** → branch, path, lifecycle state
- **UsageEvent** → provider, model, node, run, input/output tokens, estimated
  cost, actual cost where available (append-only ledger)
- **Approval** — human decisions: plan, allocation, budget extension, merge
  (actor, timestamp, what was approved, content hash)
- **AuditEvent** — append-only record of every command, transition, and
  agent decision

## Progress

Calculated from objective workflow gates only: a node contributes its
complexity weight when it passes each lifecycle gate. Never from LLM
self-estimation. ETA derives from measured gate-transition times of completed
nodes, shown with a confidence band and labeled as an estimate.

## Security

- Encrypted credential store (API keys and runtime OAuth tokens, distinct shapes)
- Append-only audit log for every command and state transition
- Runner pairing + per-runner keypair authentication
- Command restrictions on workers: allowlisted commands, no network calls
  except the provider runtime's own, filesystem confined to the worktree
- Approval gates (plan, allocation, budget extension, merge) enforced by the
  engine — not implementable around by any agent
- Secret redaction on all streamed logs before they leave the runner
- Kill switch: single control that pauses all runs, revokes in-flight
  dispatches, and requires human action to resume; auto-triggered by the
  project budget hard cap

## MVP Acceptance

The MVP succeeds when all of the following are demonstrated on a pilot
project:

1. Cross-provider planning completes with ≥ 1 full review round and zero
   manual copy/paste.
2. The approved plan converts to a graph the user can edit (add/remove nodes,
   re-wire acyclic dependencies) before execution.
3. Auto Allocate produces per-node recommendations with rationale and an
   up-front total cost estimate; the human can override any field.
4. A remote browser on a different network starts, pauses, resumes, cancels,
   and messages a local run, and survives a forced disconnect/reconnect
   without event loss.
5. Claude Code and Codex each complete ≥ 1 node inside isolated worktrees
   with command restrictions enforced.
6. Node budget exhaustion pauses that node and requires human action; the
   project hard cap halts everything.
7. Dashboard progress changes only on gate transitions; displayed cost
   matches the usage ledger.
8. An induced agent failure and an induced merge conflict both surface to
   the human through the defined escalation paths.
9. A pull request is created and mergeable only after explicit human
   approval; the full audit trail reconstructs who/what/when for every
   decision.

---

# PART II — ARCHITECTURE DECISIONS

## ADR-001: Technology Stack (Status: Proposed)

**Decision: TypeScript everywhere, in a pnpm-workspaces monorepo.**

Two facts dominate: both coding runtimes (Claude Code, Codex CLI) are Node
programs, so Node is a hard dependency on the runner host regardless; and the
system is agent-built, so "one language, shared types everywhere" pays off
more than any per-component optimization. The biggest bug surface is three
components agreeing on message shapes over long-lived WebSockets — shared zod
schemas solve that at the type level.

| Component | Choice |
|---|---|
| Language / runtime | TypeScript on Node.js 22 LTS |
| Monorepo | pnpm workspaces: `apps/server`, `apps/web`, `apps/runner`, `packages/contracts` |
| Shared contracts | `packages/contracts` — zod schemas for the Plan Contract, node lifecycle events, runner protocol. Single source of truth imported by server, web, runner |
| Backend | Fastify (HTTP) + `ws` (WebSocket endpoints for browser and runner) |
| Workflow engine | Hand-rolled event-sourced state machine: append-only event log in Postgres, node state derived by an explicit reducer. No XState/Temporal — the lifecycle has ~9 states and auditability *is* the event log |
| Database | PostgreSQL 16. No Redis/queue — `LISTEN/NOTIFY` + a dispatch loop covers single-operator concurrency |
| ORM | Drizzle |
| Frontend | React 19 + Vite; **React Flow (@xyflow/react)** for the graph; TanStack Query; zustand; Tailwind v4 |
| Runner | TypeScript CLI daemon bundled with tsup, distributed via npm (`npx norns-runner`). Claude Code via the Claude Agent SDK; Codex via its CLI/SDK. Git via the plain `git` CLI (library worktree support is unreliable) |
| LLM adapters | Official SDKs (`@anthropic-ai/sdk`, `openai`) behind the PRD's adapter interfaces |
| Auth (MVP) | Single-operator: passkey (WebAuthn) for the browser; per-runner Ed25519 keypair issued at pairing |
| Testing | Vitest (unit/engine), Playwright (the nine MVP acceptance checks), shared adapter conformance suite run against both providers |
| Lint/format | Biome |

**Alternatives rejected:** Python backend (splits contract types across
languages; runtimes are TS-native). Go runner/relay (loses shared contracts;
revisit post-MVP). XState (second state representation over an event log that
must exist anyway). Temporal (operational weight far beyond MVP scale; the
explicit event log is the product feature). SQLite (server is cloud-hosted
with concurrent writers; `LISTEN/NOTIFY` earns its keep).

**Consequences:** Phase 0 = scaffold monorepo + freeze `contracts` v1. Runner
prerequisite is Node 22 + git only. Auth is deliberately minimal and gets
replaced wholesale if multi-user ever lands (accepted).

## ADR-002: Relay Topology & Hosting (Status: Proposed)

**Decision 1: No separate relay service.** The backend server *is* the relay:
one deployable Node service exposing the HTTP API plus `/ws/session`
(browser) and `/ws/runner` (runner). A broker between them would be a third
protocol hop with no MVP benefit. The server holds routing state and the
audit feed; repository contents stay on the runner.

**Decision 2: Host on Fly.io**, single region, single small machine
(`shared-cpu-1x`, 512 MB) + Fly Postgres in the same region. TLS automatic;
deploys via `flyctl`.

**Rationale:** the runner connection is a long-lived socket and the dispatch
loop is a resident process — this rules out request-scoped platforms; Fly is
the cheapest managed host in the classic-server class (~US$5–12/mo all-in).
The deployable is a plain Docker image + Postgres URL, so moving later is a
redeploy, not a redesign. Validating Phase 1A against a genuinely remote
relay (not localhost) is required for its acceptance tests to mean anything.

**Alternatives rejected:** Railway (near-equivalent fallback). Hetzner VPS
(cheapest but adds OS/TLS/Postgres ops). Cloudflare Workers + Durable Objects
(engine wants a long-running Node process; splitting engine from relay
reintroduces the separate-relay complexity). Tailscale Funnel direct-to-runner
(couples browser access to runner uptime; audit trail must survive runner
loss).

**Security posture:** only the server is internet-exposed; runner is
outbound-only WSS with Ed25519 keypair auth; Postgres on the private network
only; provider keys encrypted at rest with the key held as a Fly secret;
kill switch is a server-side flag checked by the dispatch loop so it works
even when the runner is wedged.

**Consequences:** single machine = brief downtime on deploys, tolerated
because runner buffer-and-replay doubles as deploy tolerance. Requires a
Fly.io account + payment method (human-only task).

---

# PART III — EXECUTION PLAN

Estimates are wall-clock for agent-driven development: "session" = one
focused agent working session (roughly an hour-scale unit, often less).
Calendar time is gated almost entirely by **human review cadence** (ADR/plan
approvals, cross-device acceptance testing) and **two genuinely hard phases**
(3 and 7, flagged below) — not by implementation throughput.

## Phase 0 — Architecture (1–2 sessions)

- Approve ADR-001/ADR-002 (human gate — already drafted).
- Scaffold pnpm monorepo: `apps/server`, `apps/web`, `apps/runner`,
  `packages/contracts`; Biome, Vitest, CI (typecheck + test on push).
- Author and freeze `contracts` v1: Plan Contract zod schema, node lifecycle
  event types, runner protocol messages (envelope with monotonic `seq`,
  ack/replay semantics), usage-event shape.
- **Exit:** monorepo builds green; contracts v1 tagged; ADRs Accepted.

## Phase 1A — Remote-control vertical slice (3–5 sessions + human setup)

- **Human prerequisite:** Fly.io account + payment method (NORN-008).
- Fly app + Fly Postgres; Dockerfile; `flyctl` deploy pipeline.
- Server skeleton: Fastify; event-log tables (`audit_events`, minimal
  `runners`, `runs`); `/ws/runner` with pairing-code enrollment, keypair
  auth, heartbeat, buffered-replay by `seq`; `/ws/session` with passkey auth;
  command routing (launch/pause/resume/cancel/message) — every command
  audited.
- Runner skeleton: `npx norns-runner` daemon — pairing flow, reconnect with
  exponential backoff, local event buffer (disk-backed), fixture task
  executor (a scripted long-running job emitting logs; no LLMs yet),
  pause/resume/cancel handling.
- Minimal web page: runner status (online/heartbeat age), fixture launch
  button, live log stream, message box, pause/resume/cancel, audit trail
  view.
- **Exit (the PRD's 1A acceptance, run by the human from a second device on
  a different network):** all controls work; log latency < 2 s; forced
  network kill mid-task replays buffered events with no gaps or duplicates;
  every command visible in the audit trail. *Calendar gate: human
  availability for cross-device testing.*

## Phase 1B — Repository + backend foundation (2–4 sessions)

- Full data-model migrations (all entities from Part I).
- Workflow engine: event-sourced reducer for the node lifecycle; dispatch
  loop with `LISTEN/NOTIFY`; approval-gate primitives; kill-switch flag.
- Repository adapter #1: local git — clone/registration, worktree
  create/destroy, branch naming scheme, integration branch management.
- Project/workspace CRUD API; credential store (encrypted at rest, two
  credential shapes: API key + OAuth token).
- **Exit:** engine drives a fixture node graph (no LLMs) through all
  lifecycle states with gates, budgets decrementing from synthetic usage
  events, and a complete audit trail; worktrees created/destroyed on a real
  local repo.

## Phase 2 — LLM adapters (1–2 sessions)

- Adapter interface: chat, structured output (JSON schema-constrained),
  usage metering per call.
- Anthropic + OpenAI implementations; shared conformance test suite (both
  must pass identically: structured output validity, usage-event emission,
  error taxonomy — rate limit vs. auth vs. malformed).
- Model registry in config (ids, pricing for estimated cost).
- **Exit:** conformance suite green against both live providers; usage
  ledger entries reconcile with provider-reported token counts.

## Phase 3 — Planning workflow (2–4 sessions; **genuinely slow phase**)

- PM agent loop: objective → Plan Contract JSON; engine-side validation with
  error round-trips.
- Reviewer loop on the opposite provider: structured findings; PM revision
  with per-finding accept/rebut; round cap + convergence detection.
- Plan versioning, diff view, review-round UI; human plan-approval gate
  (content hash recorded on Approval).
- **Why slow:** this is prompt/behavior engineering, not plumbing — getting
  the PM to emit valid, well-decomposed plans and the reviewer to produce
  useful findings takes iteration cycles with human judgment on quality.
  Budget several review rounds with the operator.
- **Exit:** full loop runs on 3 test objectives of varying size with zero
  copy/paste; a deliberately bad plan is caught by validation; cap-reached
  path shows outstanding findings at approval.

## Phase 4 — Plan graph (2–3 sessions)

- Deterministic plan→graph conversion (modules → nodes, dependencies →
  edges, complexity → weights).
- React Flow editor: custom node component (status, assignment, budget,
  progress), acyclicity enforcement with offending-path display, add/delete
  with re-parent/cascade confirmation, edit restrictions after execution
  starts.
- **Exit:** approved plan renders as an editable validated graph; all
  editing rules demonstrable; graph edits round-trip to the data model.

## Phase 5 — Allocation engine (1–2 sessions)

- Rule table: complexity × role → model tier, worker count, reviewer,
  budget; three strategies (Quality/Balanced/Cost).
- PM-generated rationale per node; cost preview (sum of node budgets);
  allocation approval gate = budget approval.
- **Exit:** Auto Allocate fills a 10-node graph under each strategy with
  sane budgets; human overrides persist; approval records the hash.

## Phase 6 — Coding runtime execution (3–5 sessions)

- Runtime adapter interface: session lifecycle, streaming events,
  interrupt/resume, working-directory confinement.
- Claude Code adapter (Agent SDK) + Codex adapter (CLI/SDK); both auth
  shapes wired to the credential store.
- Runner executes a real node: worktree checkout → runtime session with the
  node prompt → acceptance checks → `review` gate; budget metering
  pre-dispatch; 80%/100% budget behavior.
- **Exit:** one node completes end-to-end via Claude Code and one via Codex
  on a real repo, remotely controlled, with command restrictions enforced
  and budget exhaustion demonstrably pausing a node.

## Phase 7 — Multi-agent coordination (3–5 sessions; **genuinely hard phase**)

- Module Lead role: work-splitting for N ≤ 3 workers, per-worker worktrees
  (`-w<n>` branches), node-branch assembly.
- Integration agent: dependency-order merges into the integration branch;
  scratch-worktree conflict resolution; `blocked: integration` escalation.
- Reviewer at node `review` gates (diff review, structured findings).
- Failure paths: retry-once, `failed` escalation, worktree preservation.
- **Why hard:** concurrency semantics (parallel workers + merge ordering +
  failure interleavings) is where deterministic-engine claims get tested;
  expect design iteration, not just implementation.
- **Exit:** a 5-node graph with one 2-worker node executes end-to-end;
  induced merge conflict and induced worker failure both escalate correctly.

## Phase 8 — Dashboard & telemetry (1–2 sessions)

- Dashboard: gate-derived progress, active agents, blocked nodes, review
  queue, cost vs. budget, ETA with confidence band, PM summary panel.
- Ledger reconciliation view (estimated vs. actual cost).
- **Exit:** dashboard state provably derives from engine events only;
  displayed totals match the usage ledger exactly.

## Phase 9 — Security hardening (2–3 sessions)

- Worker command allowlist (NORN-005 decision) enforced in the runner;
  filesystem confinement tests; secret-redaction filter on the log stream
  (tested with planted secrets); kill-switch end-to-end test (including
  wedged-runner case); audit-trail completeness check (every mutating
  action has an event).
- **Exit:** a hostile-prompt test node (tries to escape worktree, exfiltrate
  a planted secret, call the network) is fully contained and audited.

## Phase 10 — Pilot (calendar-gated)

- Ship one real project through the entire flow; run the nine MVP acceptance
  checks as the formal gate.
- **Calendar gate:** the pilot project's own size and the human's
  review/approval cadence — days, not sessions.

**Total implementation effort: roughly 20–35 agent sessions.** Calendar time
is dominated by: human approval gates between phases, cross-device 1A
testing, prompt-quality iteration in Phase 3, and coordination design in
Phase 7. There is no phase where waiting on code volume is the bottleneck.

---

# PART IV — OPEN DECISIONS & KNOWN RISKS

## Open decisions (tracked in todo.md)

- **NORN-007** — Human approval of ADR-001/ADR-002 (both Proposed).
- **NORN-008** — Fly.io account + payment method (human-only; gates 1A).
- **NORN-004** — Freeze Plan Contract schema v1 (Phase 0 exit).
- **NORN-005** — Worker command allowlist contents (needed by Phase 9,
  drafted during Phase 6).
- **NORN-006** — Pilot project selection (needed by Phase 10).

## Known risks

1. **Codex adapter stability.** The OpenAI coding-runtime surface changes
   faster than the API; the adapter interface isolates this, but Phase 6
   may need rework if the CLI/SDK shifts. Mitigation: adapter conformance
   tests, pin versions.
2. **Budget metering accuracy.** Pre-dispatch metering uses estimates;
   actual token usage is known only post-hoc. A single oversized call can
   overshoot a nearly-exhausted budget. Accepted for MVP; the ledger records
   estimated vs. actual so overshoot is visible and bounded by per-call
   size.
3. **PM plan quality (Phase 3).** If the PM can't reliably emit valid,
   well-decomposed Plan Contract JSON, the whole flow degrades. Mitigation:
   schema-constrained structured output, validation round-trips, and the
   cross-provider reviewer — but this is the product's core bet.
4. **Coordination correctness (Phase 7).** Parallel workers + merge ordering
   + failure interleavings is the hardest logic; the event-sourced engine
   makes states replayable/testable, but expect iteration.
5. **Single-machine relay.** Deploy downtime and no failover; tolerated via
   runner buffer-and-replay. Revisit if the pilot shows connection churn.
6. **Secret redaction is heuristic.** Pattern-based redaction can miss
   novel secret formats. Mitigation: allowlist-based command restrictions
   reduce what can reach logs; planted-secret tests in Phase 9.

## Specific questions for the reviewing agent

1. Is the hand-rolled event-sourced engine (vs. Temporal/XState) the right
   call at this scale, given the auditability requirement?
2. Is Phase 1A-before-1B correct, or does the throwaway-scaffolding cost
   exceed the de-risking value?
3. Is the Plan Contract schema complete enough to drive graph conversion
   and QA acceptance, or is anything load-bearing missing (e.g., per-module
   test commands, file-ownership boundaries between parallel workers)?
4. Are the budget-enforcement semantics (pre-dispatch metering, 80%/100%
   thresholds, human-only extension) sound, or is there a bypass path?
5. Does the runner protocol (monotonic seq, buffer-and-replay, idempotent
   reconciliation) have gaps under the forced-disconnect acceptance test?
6. Is minimal single-operator auth (passkey + runner keypair) defensible for
   a system that executes code on a local machine from the internet?
7. Are the 20–35-session estimate and the two flagged slow phases (3, 7)
   credible, or is effort mis-allocated?
8. Any MVP scope that should be **cut** to reach the pilot faster?

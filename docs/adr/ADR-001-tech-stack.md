# ADR-001: Technology Stack

**Status:** Accepted 2026-07-14; **partially superseded 2026-07-16** by
ADR-004 through ADR-007 · **Date:** 2026-07-13
**Resolves:** NORN-002 · **Amended by:**
`docs/reviews/REVIEW-001-disposition.md`, ADR-004, ADR-005, ADR-006, ADR-007

> The TypeScript monorepo, Fastify, PostgreSQL, shared contracts, runner
> protocol, and sandbox choices remain accepted. ADR-005 replaces blanket
> event sourcing with normalized operational state plus lifecycle/domain
> history and a transactional outbox. ADR-006 moves repository execution to a
> runner-owned boundary. ADR-007 governs the future frontend state/navigation
> architecture. Contracts v1 is no longer permanently frozen; V2 domain
> contracts are required by ADR-004.

## Context

TheNorns has four deployable parts: backend (workflow engine, API, audit
store), browser frontend, Local Runner (sandboxed coding runtimes, git
worktrees, outbound WebSocket), and relay (folded into the backend,
ADR-002). The Plan Contract, Execution Contract, and the runner protocol are
shared data shapes that three of the four parts must agree on exactly.

Two facts dominate: both coding runtimes are Node programs with official
Node-side SDKs, so Node is a hard dependency on the runner host regardless;
and the system is agent-built, so "one language, shared types everywhere"
pays off more than any per-component optimization.

## Decision

**TypeScript everywhere, in a pnpm-workspaces monorepo.**

| Component | Choice |
|---|---|
| Language / runtime | TypeScript on the **current Active LTS Node** (Node 24 at time of writing), pinned in `.nvmrc`, `package.json` engines, CI, and runner packaging. Downgrade only on a verified dependency incompatibility |
| Monorepo | pnpm workspaces: `apps/server`, `apps/web`, `apps/runner`, `packages/contracts` |
| Shared contracts | Versioned Zod wire/API schemas. Existing Plan/runner contracts remain supported through migration; ADR-004 introduces persistent-domain V2 contracts under one integration owner |
| Backend | Fastify (HTTP) + `ws` (WebSocket endpoints for browser and runner) |
| Workflow engine | Modular coordinator over normalized PostgreSQL state, explicit Task/AgentRun lifecycle reducers, append-only domain/audit history, optimistic versions, and transactional outbox. No Temporal for the MVP |
| Dispatch | **Durable `dispatch_jobs` outbox table** (id, node, command_id, runner, status, attempts, available_at, lease_owner, lease_expires_at, payload). Dispatcher polls eligible rows with `FOR UPDATE SKIP LOCKED`, takes leases, records outcomes, recovers expired leases. **LISTEN/NOTIFY is a wake-up hint only** — never the durable queue; periodic polling guarantees recovery |
| Database | PostgreSQL (managed — see ADR-002). Budget **reservations** are atomic Postgres transactions. No Redis |
| ORM | Drizzle |
| Frontend | React 19 + Vite; React Flow remains an optional TaskDependency view. ADR-007 requires stable routes, a shared server-state/query layer, live project projections, and an Attention-first information architecture. Exact supporting libraries are selected in the Phase 5 implementation brief |
| Runner | TypeScript CLI daemon (tsup bundle, `npx norns-runner`). Claude Code via `@anthropic-ai/claude-agent-sdk`; **Codex via the official TypeScript SDK `@openai/codex-sdk`** (controls the local Codex agent: threads, `runStreamed()`, `resumeThread()`), with Codex CLI/app-server subprocess as fallback if the SDK lacks a needed lifecycle hook — verified at implementation time; **runtime capability detection is part of runner registration**. Git via the plain `git` CLI. Durable local command-dedup store (SQLite or append-only file). Sandbox launcher per ADR-003 |
| LLM adapters | Official SDKs (`@anthropic-ai/sdk`, `openai`) behind the PRD's adapter interfaces |
| Auth (MVP) | Current account/password sessions are an implemented compatibility baseline. Session hardening, recent-auth, recovery, and runner key rotation remain required security work; per-runner Ed25519 fencing remains accepted |
| Testing | Vitest (engine/reducer determinism, idempotency, budget races), Playwright (MVP acceptance), adapter conformance suites (LLM + runtime capability matrix) |
| Lint/format | Biome |

## Rationale

- **One language, shared zod schemas** eliminates the class of bug this
  product is most exposed to: components disagreeing about message shapes on
  long-lived WebSocket protocols.
- **Node is already required** on the runner host; both provider runtimes
  ship official Node-side control surfaces (Claude Agent SDK;
  `@openai/codex-sdk`).
- **Domain history ≠ dispatch queue ≠ command outbox ≠ runner event stream ≠
  audit feed.** These remain distinct structures. Normalized state is the
  operational source of truth; lifecycle events provide reproducible history,
  and durable rows carry dispatchable work.
- **React Flow** removes the largest frontend unknown.
- **No Temporal:** operational weight far beyond MVP scale; the explicit
  event log is the product feature, and the outbox pattern covers delivery.

## Alternatives rejected

Python backend (splits contract types; runtimes are TS-native). Python
sidecar for Codex (unnecessary — official TS SDK exists; REVIEW-001 P1-3
premise corrected). Go runner (loses shared contracts; revisit post-MVP).
XState (second state representation over a log that must exist anyway).
Temporal (above). SQLite as primary DB (cloud server, concurrent writers,
transactional reservations). Bare LISTEN/NOTIFY dispatch (not durable —
REVIEW-001 P0-3).

## Consequences

- Shared contracts remain single-owner/versioned, but the permanent v1 freeze
  is superseded. V2 changes require Sol’s contract approval and compatibility
  tests.
- Runner host prerequisites: Node (Active LTS) + git + a sandbox substrate
  (ADR-003).
- Auth is deliberately minimal and gets replaced wholesale if multi-user
  ever lands (accepted).

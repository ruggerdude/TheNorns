# ADR-001: Technology Stack

**Status:** Accepted 2026-07-14 (human direction to proceed with Phase 0A) · **Date:** 2026-07-13
**Resolves:** NORN-002 · **Amended by:** `docs/reviews/REVIEW-001-disposition.md`

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
| Shared contracts | `packages/contracts` — zod schemas for the Plan Contract, Execution Contract, command/event envelopes (incl. command state machine, ack watermarks, fencing generation), lifecycle events, usage events. Single source of truth; frozen in Phase 0B |
| Backend | Fastify (HTTP) + `ws` (WebSocket endpoints for browser and runner) |
| Workflow engine | Hand-rolled event-sourced state machine: append-only event log in Postgres, node state via an explicit deterministic reducer (determinism tests, schema versioning + upcasters, stream version checks). No XState/Temporal |
| Dispatch | **Durable `dispatch_jobs` outbox table** (id, node, command_id, runner, status, attempts, available_at, lease_owner, lease_expires_at, payload). Dispatcher polls eligible rows with `FOR UPDATE SKIP LOCKED`, takes leases, records outcomes, recovers expired leases. **LISTEN/NOTIFY is a wake-up hint only** — never the durable queue; periodic polling guarantees recovery |
| Database | PostgreSQL (managed — see ADR-002). Budget **reservations** are atomic Postgres transactions. No Redis |
| ORM | Drizzle |
| Frontend | React 19 + Vite; React Flow (@xyflow/react); TanStack Query; zustand; Tailwind v4 |
| Runner | TypeScript CLI daemon (tsup bundle, `npx norns-runner`). Claude Code via `@anthropic-ai/claude-agent-sdk`; **Codex via the official TypeScript SDK `@openai/codex-sdk`** (controls the local Codex agent: threads, `runStreamed()`, `resumeThread()`), with Codex CLI/app-server subprocess as fallback if the SDK lacks a needed lifecycle hook — verified at implementation time; **runtime capability detection is part of runner registration**. Git via the plain `git` CLI. Durable local command-dedup store (SQLite or append-only file). Sandbox launcher per ADR-003 |
| LLM adapters | Official SDKs (`@anthropic-ai/sdk`, `openai`) behind the PRD's adapter interfaces |
| Auth (MVP) | Single-operator: WebAuthn passkeys (≥2 or recovery code), short sessions, recent-auth for high-risk actions; per-runner Ed25519 keypair with rotation + revocation + generation fencing |
| Testing | Vitest (engine/reducer determinism, idempotency, budget races), Playwright (MVP acceptance), adapter conformance suites (LLM + runtime capability matrix) |
| Lint/format | Biome |

## Rationale

- **One language, shared zod schemas** eliminates the class of bug this
  product is most exposed to: components disagreeing about message shapes on
  long-lived WebSocket protocols.
- **Node is already required** on the runner host; both provider runtimes
  ship official Node-side control surfaces (Claude Agent SDK;
  `@openai/codex-sdk`).
- **Event log ≠ dispatch queue ≠ command outbox ≠ runner event stream ≠
  audit feed.** These are kept as distinct structures (REVIEW-001 P0-3/Q1);
  the event log remains authoritative for state, durable rows carry
  dispatchable work.
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

- Phase 0B freezes `contracts` v1 before any 1A code; no agent modifies
  shared contracts without architecture-lead approval.
- Runner host prerequisites: Node (Active LTS) + git + a sandbox substrate
  (ADR-003).
- Auth is deliberately minimal and gets replaced wholesale if multi-user
  ever lands (accepted).

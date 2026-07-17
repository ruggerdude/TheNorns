# TheNorns — Development Agent Staffing Plan

> **Superseded for new work on 2026-07-16.** This plan governed the
> plan-centric R4 build and is retained as history. Current role authority,
> model policy, phase assignments, and concurrency rules are in
> [REFOUNDATION-PROGRAM.md](REFOUNDATION-PROGRAM.md). ChatGPT Sol is now the
> Program Manager, Chief Architect, and integration owner.

**Status:** Accepted 2026-07-14 (human direction to proceed with Phase 0A) · **Date:** 2026-07-13
**Governs:** PRD R4 §Recommended Development Agents; adopts REVIEW-002's
role structure with concrete, current model assignments.

## Principles

1. **Cross-provider by construction.** The build mirrors the product:
   Anthropic models author, an OpenAI reasoning model independently reviews,
   and Codex owns the runner — so the Codex runtime adapter is exercised
   daily by the very agent it must integrate.
2. **Capability where it's load-bearing, cost-tier everywhere else.** The
   deep-reasoning roles (architecture, contracts, adjudication, phase-gate
   synthesis) get top-tier models; implementation runs on Sonnet-tier;
   mechanical bulk work drops to Haiku.
3. **One integration owner.** No agent modifies `packages/contracts` without
   architecture-lead approval — the contracts are the coordination surface,
   so they get a single gatekeeper.
4. **The human stays the approval gate** for ADRs, phase exits, budgets, and
   anything the PRD reserves to the human. Agents recommend; you approve.

## Roster

| Role | Agent | Model id | Rate ($/MTok in·out) | Owns |
|---|---|---|---|---|
| **Architecture lead** (persistent — this Claude Code session lineage) | Claude Fable 5 | `claude-fable-5` | 10 · 50 | Contracts, ADRs, decomposition, integration decisions, scope control, review-finding adjudication, phase-gate remediation. Sole approver of `packages/contracts` changes. |
| **Backend / control-plane lead** | Claude Sonnet 5 | `claude-sonnet-5` | 3 · 15 (intro 2 · 10 through 2026-08-31) | Fastify server, Drizzle schema/migrations, event-sourced reducer, dispatch_jobs + leases, approvals, budget reservations, planning workflow plumbing |
| **Runner / security lead** | Codex | OpenAI Codex runtime (current default; pinned in config at Phase 0A) | per OpenAI plan | Runner daemon, command dedup store, subprocess lifecycle, git/worktrees, sandbox launcher (ADR-003), runtime adapters, reconnect/replay |
| **Frontend lead** | Claude Sonnet 5 | `claude-sonnet-5` | 3 · 15 (intro) | PM Workspace, Plan Review, React Flow graph, allocation UI, dashboard, remote controls |
| **Independent reviewer** (phase gates) | Latest OpenAI reasoning model — the same external agent that ran REVIEW-001/002 | pinned in config, not in docs | per OpenAI plan | Adversarial review after 1A, 3, 5, 7, and pre-pilot; validates implementation against this architecture (no more broad redesign reviews) |
| **QA / failure injection** | Codex + OpenAI reasoning model | as above | as above | Codex: test implementation, fixtures, race/failure injection (Phase 8 suite). Reasoning model: independent evidence review of verification results |
| **Bulk mechanical work** (as needed) | Claude Haiku 4.5 | `claude-haiku-4-5` | 1 · 5 | Fixtures, boilerplate conformance cases, doc formatting — anything a lead specs precisely and reviews cheaply |

**Escalation rule:** any lead may escalate a design question to the
architecture lead; the architecture lead escalates cross-provider disputes
or scope questions to the human. If Sonnet 5 stalls twice on the same
problem (reducer determinism, protocol race), the architecture lead takes
that work item directly rather than iterating a third time.

**Model pinning:** these ids are current as of 2026-07-13. Per our
no-pinned-models rule, `docs/STAFFING.md` names the *tier and rationale*;
the exact ids live in build config and get re-verified at each phase gate.

## Phase assignment matrix

| Phase | Primary | Supporting | Reviewer gate |
|---|---|---|---|
| 0A Architecture lock | Architecture lead (Fable 5) | — | Human approves ADRs (external review already done) |
| 0B Protocol & contract lock | Architecture lead (Fable 5) | Backend lead drafts zod schemas to spec | ✅ External reviewer: contracts v1 |
| 1A Remote-control slice | Runner lead (Codex) + Backend lead (Sonnet 5) jointly | Frontend lead: minimal status/log/control page | ✅ External reviewer + human runs cross-device acceptance |
| 1B Workflow & repo foundation | Backend lead (Sonnet 5) | Architecture lead designs/reviews the reducer + reservation transactions; Runner lead: worktree manager + sandbox launcher | — |
| 2 LLM adapters | Backend lead (Sonnet 5) | Haiku 4.5 generates conformance fixtures | — |
| 3 Planning & review | Architecture lead (Fable 5) — *prompt/behavior engineering is the product's core bet; top-tier authored* | Backend lead: versioning/diff plumbing; Frontend lead: Plan Review UI | ✅ External reviewer: planning-loop quality on 3 test objectives |
| 4 Graph & allocation | Frontend lead (Sonnet 5) | Backend lead: conversion + rule engine | — |
| 5 Single-agent execution | Runner lead (Codex) + Backend lead jointly; Frontend restricted to observability/controls | Architecture lead: capability-matrix + verification trust-chain review | ✅ External reviewer: sandbox + execution path |
| 6 Dashboard | Frontend lead (Sonnet 5) | Backend lead: ledger reconciliation queries | — |
| 7 Multi-agent coordination | Architecture lead (Fable 5) designs interleaving semantics; Backend lead implements | One temporary extra Sonnet 5 worker for concurrency testing; single integration owner = architecture lead | ✅ External reviewer: coordination + conflict-node paths |
| 8 Security & resilience gate | QA pair: Codex (attack/test implementation) + OpenAI reasoning model (evidence review) | Runner lead fixes findings | Gate itself is the review |
| 9 Pilot | Architecture lead orchestrates; all leads on remediation | — | ✅ External reviewer: pre-pilot final pass; human runs MVP acceptance |

## Concurrency policy (per REVIEW-002)

- **≤3 implementation agents concurrently** (backend, runner, frontend)
  until Phase 4.
- **Phase 5:** runner + backend pair on execution; frontend does only
  observability and controls.
- **Phase 7:** one temporary additional worker for concurrency testing;
  the architecture lead is the single integration owner throughout.
- The external reviewer never runs concurrently with authoring on the same
  artifact — review packets go out at phase boundaries.

## Cost posture

Implementation volume (the 40–65 + 15–25 session envelope) lands mostly on
Sonnet 5 at intro pricing, with Codex on the user's OpenAI plan. Fable 5 is
reserved for the roles where reasoning depth compounds (architecture,
contracts, Phase 3 prompt engineering, Phase 7 semantics) — a small share of
sessions, deliberately the expensive ones. Haiku absorbs mechanical volume.
No per-session budget is set for the build itself; the human's review cadence
remains the real cost governor.

## How this runs operationally

- **Claude-side agents** are Claude Code sessions (this lineage = the
  architecture lead; Sonnet 5 leads run as dedicated sessions/subagents with
  scoped briefs and no contracts-write access).
- **Codex** runs as Codex CLI/agent sessions on the runner workstream, from
  the same repo, on its own branches per the PRD's git rules.
- **The external reviewer** continues exactly as REVIEW-001/002 worked: the
  human ferries a review packet out and the findings back; the architecture
  lead dispositions every finding in `docs/reviews/` with accept/rebut and
  fact-checks before adoption.

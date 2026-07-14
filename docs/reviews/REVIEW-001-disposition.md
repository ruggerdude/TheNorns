# REVIEW-001 Disposition — Independent Architecture Review of PLAN.md (R2)

**Date:** 2026-07-13 · **Verdict received:** Approve with required changes
**Disposition:** Review substantially accepted. PRD revised to **R3**;
ADR-001/002 amended; ADR-003 (execution sandbox) added. Two findings had
factually incorrect premises, corrected below with sources; their underlying
recommendations were sound and are adopted in modified form.

## P0 findings

| ID | Finding | Disposition |
|---|---|---|
| P0-1 | Worktrees + allowlists ≠ OS isolation | **Accepted.** Execution Sandbox Contract added to PRD; implementation decided in ADR-003 (disposable container, fail-closed). Minimum sandbox enforcement moved into the execution phase's acceptance (now Phase 5), hardening in Phase 8. Credential brokering by the runner; git push mediated from outside the sandbox. |
| P0-2 | No durable bidirectional command semantics | **Accepted.** Runner Protocol section added: at-least-once transport + idempotent execution + durable dedup; command_id, server outbox, runner dedup store, fencing generation, command state machine, expiry, reconciliation handshake. Protocol frozen in new Phase 0B. |
| P0-3 | LISTEN/NOTIFY is not a durable queue | **Accepted.** `dispatch_jobs` table with `FOR UPDATE SKIP LOCKED` + leases is authoritative; NOTIFY demoted to wake-up hint; periodic polling guarantees recovery. ADR-001 amended. |

## P1 findings

| ID | Finding | Disposition |
|---|---|---|
| P1-1 | Plan Contract can't drive execution/parallelization | **Accepted.** Module schema extended: per-criterion verification, execution block, parallelization block, inputs/outputs, open_decisions. Path ownership is a hint the Module Lead validates. |
| P1-2 | Acceptance checks must be runner-executed | **Accepted.** New `verifying` lifecycle state: runner captures commit, executes verification in a clean worktree, records immutable result before review. |
| P1-3 | "Official Codex SDK is Python; no TS SDK exists" | **Premise incorrect — recommendation adopted anyway.** OpenAI ships an official TypeScript SDK, [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) ([docs](https://developers.openai.com/codex/sdk), [repo](https://github.com/openai/codex/tree/main/sdk/typescript)), which programmatically controls the local Codex agent (threads, `runStreamed()`, `resumeThread()`). No Python sidecar needed. The sound part of the finding is kept: ADR-001 now states adapters may wrap external binaries, capability detection happens at runner registration, and versions are verified at implementation time. |
| P1-4 | Don't freeze Node 22 | **Accepted.** ADR-001 now: current Active LTS (Node 24 at time of writing), pinned in `.nvmrc`/CI/packaging, downgrade only on verified dependency incompatibility. |
| P1-5 | "Fly Postgres" is unmanaged | **Partially outdated, materially right.** Fly now offers genuinely managed Postgres ([MPG](https://fly.io/docs/mpg/)) — but its Basic plan is [$38/mo](https://fly.io/docs/about/pricing/), which breaks the R2 cost envelope; legacy ["Fly Postgres" remains unmanaged](https://fly.io/docs/postgres/). ADR-002 amended: **Fly app + Neon managed Postgres** (cost-appropriate, automated backups/PITR), Fly MPG as same-platform alternative. Backup/restore-test-before-pilot requirements added. |
| P1-6 | Budget needs atomic reservations | **Accepted.** Reservation model added: available = approved − settled − active reservations; atomic reserve/settle/release in Postgres; 80% threshold uses settled + reserved. |
| P1-7 | Telemetry can't be uniformly precise | **Accepted.** `usage_source` labeling (provider_api / runtime_report / subscription_credit / estimate / unavailable); no mixed-precision aggregate without labels. |
| P1-8 | Auth lacks recovery/rotation/session controls | **Accepted.** Security section extended: ≥2 passkeys or recovery code, short sessions, recent-auth for high-risk actions, per-command authorization + project binding, runner revocation/rotation, origin/CSRF protections, enrollment alerts. |
| P1-9 | Pause/resume semantics undefined | **Accepted.** Five distinct controls (interrupt / suspend / resume-session / cancel / stop-after-current-action) + per-runtime capability matrix required of adapters. |
| P1-10 | Auto merge-conflict resolution is MVP risk | **Accepted.** Integration agent now does clean merges only; conflicts spawn a human-visible conflict-resolution node with independent review. |
| P1-11 | Cross-provider review too rigid as invariant | **Accepted.** Now default policy with documented, human-approved, audited exceptions. |
| P1-12 | Retention/artifact storage unspecified | **Accepted.** Artifact & Log Storage section: metadata + hashes in Postgres, blobs in S3-compatible object storage (Tigris/local), retention classes, redaction status, tombstones. |

## P2 suggestions

All five accepted: complexity S/M/L/XL + separate risk field; versioned
DecisionRecord entity; ETA labeled experimental in pilot; `approved` node
state renamed `verified`; workflow events vs. audit events distinguished.

## Answers-to-questions and estimate

- Engine choice (Q1) and 1A-first ordering (Q2) confirmed with conditions —
  both conditions adopted (outbox separation; new **Phase 0B Protocol Lock**
  so 1A is production-bound, not throwaway; this supersedes R2's "throwaway
  scaffolding allowed").
- Effort estimate (Q7): **accepted — revised to 40–65 sessions.** R2
  underweighted sandboxing, protocol durability, and reconnect testing.
- Scope cuts (Q8): accepted, recorded as PRD "Pilot Scope Limits" —
  including max 2 concurrent workers in the pilot, manual conflict nodes,
  ETA experimental, single repo/runner/test-command configuration.
- Reviewer's corrected development sequence (0A/0B, merged graph+allocation,
  single-agent execution before dashboard, dashboard before multi-agent,
  security gate pre-pilot): **adopted wholesale**, phases renumbered.
- Reviewer's suggested build-team allocation: adopted as guidance in PRD
  "Recommended Development Agents" (with the fictional-model names replaced
  by "current top reasoning model per provider, per config").

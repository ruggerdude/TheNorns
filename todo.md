# TheNorns — todo

## Done
- [x] NORN-001 — Review original MVP PRD; produce corrected R2 (`TheNorns_MVP_PRD.md`)
- [x] NORN-002 — Choose tech stack → [ADR-001](docs/adr/ADR-001-tech-stack.md)
- [x] NORN-003 — Decide relay hosting → [ADR-002](docs/adr/ADR-002-relay-hosting.md)
- [x] NORN-009 — Review packet for external vetting → [PLAN.md](PLAN.md)
- [x] NORN-010 — REVIEW-001 dispositioned; PRD R3; ADR-003 added → [disposition](docs/reviews/REVIEW-001-disposition.md)
- [x] NORN-005 — Worker command restrictions → defense-in-depth inside the ADR-003 sandbox
- [x] NORN-011 — PLAN.md regenerated as R3 packet; R2 snapshot archived
- [x] NORN-013 — REVIEW-002 dispositioned → approved, no blockers; PRD R4 → [disposition](docs/reviews/REVIEW-002-disposition.md)
- [x] NORN-019 — Agent staffing plan → [docs/STAFFING.md](docs/STAFFING.md)
- [x] NORN-007 — ADR-001/002/003 + STAFFING **Accepted** (human direction 2026-07-14)
- [x] NORN-014 — **Phase 0A complete**: git repo, pnpm monorepo (server/runner/web/contracts), strict TS, Biome, CI workflow; `pnpm run ci` green
- [x] NORN-004 — **Phase 0B complete**: contracts v1 frozen and tagged `contracts-v1.0.0` — Plan Contract + validatePlan, lifecycle + pure reducer (determinism/idempotency harness, 31 tests), runner protocol (command state machine, envelopes, fencing, dedup, reconciliation), usage/reservations, approvals/DecisionRecords, artifacts, Project Memory, verification

- [x] NORN-020 — **Phase 1A complete (local half)**: relay server (pairing, Ed25519 challenge/response, reconciliation + watermark replay, outbox delivery, fencing, audit, kill switch, control page), runner daemon (disk-backed buffer + dedup, auto-reconnect, fixture executor with full control set), 8 integration tests incl. forced-disconnect replay (no gaps/dupes), server-restart recovery (no double execution), stale-generation fencing. Contracts 1.1.0 (wire frames, additive)
- [x] NORN-022 — **Phase 1B complete**: WorkflowEngine (event-sourced, approval + dependency + budget gates, kill switch w/ project-cap auto-engage, replay-identical), BudgetLedger (atomic reservations, race-tested), DispatchStore (lease claim = SKIP LOCKED semantics), LocalGitRepo (real worktrees + branch contract), SandboxLauncher (fail-closed, ADR-003 policy args). 58 tests green

- [x] NORN-025 — **Phase 2 complete (mock-conformance half)**: @norns/adapters — Anthropic + OpenAI adapters over official SDKs (pinned @anthropic-ai/sdk 0.111.0, openai 6.46.0), failure taxonomy with retryable flags, AbortSignal cancellation, model registry + pricing versions, ledger-valid UsageEvents; 10-test conformance suite over both adapters via mock provider; live smoke auto-enables with API keys
- [x] NORN-026 — **Phase 3 complete (loop-logic half)**: contracts 1.2.0 (review schemas); runPlanning — cross-provider review loop with structured findings, accept/rebut dispositions (must-fix enforcement), 3-round cap + convergence, validation round-trips, Project Memory injection into every agent context, metered usage, review-policy exceptions, canonical plan content hashing; 8 loop tests over 3 objectives + guardrails

- [x] NORN-028 — **Phase 4 complete**: WorkflowGraph (atomic cycle rejection w/ offending path, reparent/cascade deletion, post-start edit restrictions, version bumps), rule-based allocation engine (3 strategies, pilot worker cap, persisting overrides, cost preview, hashed approval), graph HTTP API (audited, 409s carry cycle paths), React Flow editor in apps/web (Vite+React 19) — browser-verified end to end on the 10-node demo graph

- [x] NORN-029 — **Phase 5 complete (deterministic-runtime half)**: CodingRuntime interface + capability matrices; ClaudeCodeRuntime + CodexRuntime over official SDKs (NORN-012 ✅ verified: @openai/codex-sdk covers cancel/interrupt/resume, no fallback needed); ProcessRuntime; executeNode pipeline (budget-before-dispatch, worktree isolation, runner-executed verification at exact commit, settlement); live LLM runs gated on NORN-027
- [x] NORN-030 — **Phase 6 complete**: buildDashboard (gate-derived progress, engine-log blocked reasons, source-labeled usage, burn rate, experimental ETA, timeline, PM summary) + /api/dashboard + web Dashboard view, browser-verified
- [x] NORN-031 — **Phase 7 complete**: clean-merge-only integration agent; conflict-resolution nodes with replacement semantics + human-confirmation gate; executeMultiWorkerNode (Module Lead bounded decomposition, parallel -w<k> worktrees, PM-routed questions, retry-once + escalation, lead assembly); 5-node/2-worker graph end-to-end on real git incl. induced conflict + induced failure
- [x] NORN-012 — @openai/codex-sdk lifecycle verified at Phase 5 (closed under NORN-029)

- [x] NORN-021 — GATE-1 phase-gate review packet assembled → [docs/reviews/GATE-1-packet.md](docs/reviews/GATE-1-packet.md) (covers 1A through 7; supersedes the 1A-only packet plan)

- [x] NORN-032 — **Phase 8 complete (locally provable set)**: secret redaction at the runner boundary (planted-secret e2e), audit completeness, first-terminal-commits race, replay/out-of-order rejection, snapshot restore fidelity, DispatchLoop (closes GATE-1 deviation #3) w/ kill-switch refusal + lease retry, strict approval hash-match (closes deviation #4), merge-to-main release gate. Gated remainder: live sandbox-escape (Docker host), deployed backup-restore (Neon)
- [x] NORN-033 — **Pilot dress rehearsal**: full MVP flow in one test on real git — planning loop → hashed approvals → allocation w/ override → strict engine start → all nodes executed (2-worker + budget-block/resume) → dashboard 100% → human-gated merge to main. The live pilot re-runs this with real models + the chosen project

## In Progress
- [ ] NORN-015 — 🔄 GATE-1 review **awaiting the human to ferry the packet** to the external reviewer and return findings; disposition follows (note for reviewer: packet deviations #3 and #4 were closed after packet generation)

- [x] NORN-034 — **Railway Tier-1 deploy scaffold**: single-service Docker build (server serves built web + API), host/token prod-hardening, /health, railway.json, ADR-002 amended to Railway, [DEPLOY.md](DEPLOY.md) with the 3-tier path. Verified locally in the prod model

## Remaining — every item requires the human
- [ ] NORN-034b — Push repo to GitHub `TheNorns` + Railway "Deploy from repo" + set NORNS_TOKEN → live demo URL (Tier 1; steps in DEPLOY.md)
- [ ] NORN-024 — Postgres store port for Tier-2 persistence (Railway Postgres plugin → DATABASE_URL; port the tested in-memory RelayStores/DispatchStore to Drizzle)
- [ ] NORN-035 — Runner CLI (`norns-runner pair/start`) so a local runner can connect to the deployed relay (Tier 3; also the standalone-runner gap from the earlier issues list)
- [ ] NORN-027 — API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, NORNS_OPENAI_MODEL) → unlocks live adapter conformance, live Phase 3 prompt iteration, live Phase 5 Claude Code/Codex nodes
- [ ] NORN-008 — Fly.io + Neon accounts → unlocks NORN-024 (Postgres port), deployment, NORN-023 (cross-device 1A acceptance), passkeys, deployed restore test
- [ ] NORN-006 — Pick the pilot project → unlocks the live Phase 9 pilot (mechanics already rehearsed under NORN-033)
- [ ] (env) A Docker host → unlocks live sandbox-escape tests and containerized execution

## Open — gates (human)
- [ ] NORN-008 — Create Fly.io and Neon accounts + payment methods (**blocks 1A deployed acceptance**: cross-device test, passkey auth, Postgres adapter for RelayStores/dispatch)
- [ ] NORN-023 — Run the deployed 1A acceptance from a second device once NORN-008 is done (forced-disconnect + restart checks against the real relay)
- [ ] NORN-027 — Provide ANTHROPIC_API_KEY + OPENAI_API_KEY (+ NORNS_OPENAI_MODEL id) to run the live-provider halves: adapter conformance against live APIs and Phase 3 prompt-quality iteration on 3 real objectives
- [ ] NORN-006 — Pick pilot project for Phase 9

## Open — implementation queue
- [ ] NORN-021 — Phase 1A gate: external review packet (send after deployed acceptance, or on request for the local build)
- [ ] NORN-024 — Postgres/Drizzle adapters for RelayStores + DispatchStore (mechanical port of the tested in-memory semantics; needs NORN-008)
- [ ] NORN-025 — Phase 2: Anthropic + OpenAI LLM adapters, conformance suite, usage normalization + source labels
- [ ] NORN-012 — Verify `@openai/codex-sdk` lifecycle coverage at Phase 5; CLI/app-server subprocess fallback
- [ ] NORN-015 — Phase-gate reviews after 1A, 3, 5, 7, pre-pilot (standing)

## Backlog (post-MVP)
- [ ] NORN-016 — Prompt library (REVIEW-002 P2-6)
- [ ] NORN-017 — Transcript search across all agents (P2-7)
- [ ] NORN-018 — Automatic Project Memory extraction from transcripts

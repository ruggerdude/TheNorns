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

- [x] NORN-024 — **Tier-2 Postgres persistence built + verified** (pglite): PgPersistence + SnapshotFlusher; main.ts hydrates/flushes when DATABASE_URL set; relay/outbox/audit survive restart. Activates via the Railway Postgres plugin
- [x] NORN-035 — **Tier-3 runner CLI built + verified** end-to-end: `norns-runner pair/start` connects a local runner to a live relay and executes commands. Live LLM execution still needs keys + Docker
- [x] NORN-037 — **Live planning endpoint built + verified** (superseded by NORN-039's project-scoped routes below, kept for history): `POST /api/plan` ran the real cross-provider planning loop against live models against a single global graph. `@norns/adapters` moved to a real server dependency (was type-only; now the server calls the SDKs directly for planning)
- [x] NORN-039 — **Multi-project management ("sole point of entry") built + verified (2026-07-14)**: `ProjectStore` (apps/server/src/projects/store.ts) replaces the single hardcoded graph — create/list projects, each with its own PM provider (pick Anthropic or OpenAI; reviewer always auto-flips to the other, cross-provider review is never optional), its own plan/graph once planned, independent from every other project. Routes moved under `/api/projects[/:id[/graph|/plan|/plan/load]]`; the old global `/api/graph*`+`/api/plan*` routes are gone (not deprecated — replaced). Postgres Tier-2 now persists the whole `ProjectStore` (all projects, plans, allocations) under one `"projects"` key. Web app: **Projects** is now the real landing view after login (list + create-project form with the PM picker); opening a project shows the graph editor scoped to it; a new **QC review screen** (`PlanReview.tsx`) shows every module's acceptance criteria after a live planning run and lets you edit statement/verification/type before "Load into graph" commits it — nothing reaches the graph un-reviewed. 101 server tests (18 files: ProjectStore unit tests, project-scoped graph API, project-scoped planning guard/load, ProjectStore Postgres round-trip), browser-verified full flow: create project → PM=openai (reviewer auto-set anthropic) → Live Planning → QC review/edit → Load into graph → Auto Allocate → Approve → back to Projects shows "planned". The demo 10-node walkthrough that drives the PM Dashboard is now fully separate from real projects (`demoSession` in main.ts) — untouched, still scripted, not persisted

## Remaining — every item requires the human
- [ ] NORN-034b — Tier 1: push repo to GitHub `TheNorns` + Railway "Deploy from repo" + set NORNS_TOKEN → live URL (steps in DEPLOY.md). **Only I cannot do this — it's your accounts**
- [x] NORN-036 — Graph/project persistence built + verified (your graph edits persist, not just relay). Deployed. Activates with the Postgres plugin
- [ ] NORN-024b — Tier 2 activation: add the Railway Postgres plugin + DATABASE_URL reference (one click; all code done — persists relay AND graph)
- [x] NORN-027a — API keys added to Railway (ANTHROPIC_API_KEY, OPENAI_API_KEY, NORNS_OPENAI_MODEL) → live planning (NORN-037) is now usable on the deployed site
- [x] NORN-038 — **Docker installed on the dev machine (2026-07-14)**; ADR-003 sandbox verified against a real Docker daemon for the first time — isolated execution, real writable worktree mount, real enforced read-only mounts, real denied network, real fail-closed — closes NORN-032's gated "live sandbox-escape" remainder. `apps/server/test/sandbox-live.test.ts`, 5 tests, skips cleanly without Docker
- [ ] NORN-027b — Tier 3 live coding execution — still a real gap, now scoped precisely (see 2026-07-14 research): (a) `launch_run` payload is underspecified (no runtime/model/repo/budget fields, no `prompt_ref` resolution — [protocol.ts](packages/contracts/src/protocol.ts)); (b) `DispatchLoop` has zero production wiring — nothing calls `store.enqueue()`, no real `Deliverer` exists, it's never instantiated in `main.ts`; (c) `SandboxLauncher`/`LocalGitRepo` live under `apps/server/src/engine` with no path for `apps/runner` to reach them (wrong package boundary — runner has no dependency on server); (d) the runner daemon's command switch explicitly rejects `launch_run` today (`daemon.ts` — "arrive with Phase 5"). This is multiple further sessions of real design + build work, not a quick wire-up — recommended order: extract sandbox/git into a shared package first (self-contained), then extend the contract, then wire DispatchLoop, then build the runner executor
- [ ] NORN-006 — Pick the pilot project (mechanics already rehearsed)
- [ ] NORN-015 — Ferry the GATE-1 review packet to the external reviewer; disposition on return
- [ ] NORN-008 — Fly.io + Neon accounts → unlocks NORN-024 (Postgres port), deployment, NORN-023 (cross-device 1A acceptance), passkeys, deployed restore test
- [ ] (env) A Docker host → unlocks live sandbox-escape tests, containerized execution, and NORN-027b

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

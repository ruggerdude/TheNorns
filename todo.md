# TheNorns — todo

> **Historical tracker notice (2026-07-16):** this file records delivery
> against the previous plan-centric PRD and therefore contains completion
> claims that do not equal acceptance of the persistent-project Charter MVP.
> New work is governed by
> [docs/REFOUNDATION-PROGRAM.md](docs/REFOUNDATION-PROGRAM.md). Treat the
> remaining entries below as legacy backlog/input until they are migrated into
> the new phase structure.

## Re-foundation gate

- [x] Record Claude Fable 5 independent Phase 0 baseline and findings.
- [x] Accept and bind REF-REC-1 through REF-REC-18 to their governing ADRs and
  phase gates; no rejection, downgrade, or later-gate deferral.
- [x] Add REF-REC-9 effort/variance baseline and REF-REC-14 commit evidence.
- [x] Demonstrate the REF-REC-9 150% automatic-pause control in a recorded
  tabletop.
- [x] Human decision REF-OPEN-1 — keep GitHub App repository picker in MVP.
- [x] Human decision REF-OPEN-2 — rotate/revoke sessions and invitations at
  migration cutover, with encrypted/restricted archives.
- [x] Human decision REF-OPEN-3 — default to one executing phase per project.
- [x] Human decision REF-OPEN-4 — authorize 145 FSE maximum and the selected
  API spend posture.
- [x] Human authorization — `Start Phase 1 — Domain and Persistence
  Foundation`.
- [x] Phase 1 candidate contracts, normalized schema, transactional boundary,
  compatibility repositories, and required verification evidence.
- [x] Claude Fable independent review of the Phase 1 candidate contract
  package, disposition, and final contract freeze.
- [x] Re-foundation Phase 2 — preservation migration and recovery checkpoint.
- [x] Re-foundation Phase 3 — persistent project, source binding, and phase workflow.
- [x] Re-foundation Phase 4 — coordinator and runner execution loop.
- [x] Re-foundation Phase 5 — attention-first dashboard and execution monitoring.
- [x] Re-foundation Phase 6 — multi-agent autonomous coordination.
- [x] Re-foundation Phase 7 — security hardening, existing-project pilot,
  progressive cutover controls, and separately gated legacy-retirement authorization.

## EXECUTION program

- [x] E1 Task context assembly — the missing producer. Nothing in TheNorns ever
  assembled a task prompt: both schedule routes require caller-supplied
  `context_refs` and the only `storage_ref` producer was repository ingestion,
  so even a hand-crafted request could not start work. New
  `apps/server/src/execution/**` delivers the frozen `TaskContextAssembler`
  interface (`assembleForTask(taskId) => V2ContextRefT[]`), a content-addressed
  store reusing the FRONT DOOR P4 attachments pattern, and a runner-facing
  fetch route authenticated with the runner's EXISTING relay Ed25519 identity
  (no new credential, nothing secret in the URL). Deterministic hashing,
  specific missing-input refusals, and a 256 KiB cap that trims memory before
  acceptance criteria. Migration written as `NNNN_task_context.sql`, number
  unassigned. Suites green: server 639 (+40 over O4, 8 skip).
- [ ] E1 follow-up — the runner still constructs `SignedUrlContentFetcher`,
  which sends no credentials, so it cannot yet read an assembled context.
  Swap it for the signing fetcher (`RunnerSignedContextFetcher`) in
  `apps/runner/**`. Owned by the phase that may touch the runner (E2/E4).
- [x] E1 follow-up — context-fetch authorization is authentication-only: any
  paired runner may fetch any context document. Bind documents to a dispatch
  job (or the run's runner id) once E2 creates the dispatch record.
  **Closed by E2's `dispatchContextScope.ts`** below.
- [x] E2 Start-phase trigger + dispatch-context scoping — the other two of the
  five reasons nothing ever ran: nothing triggers work, and
  `UPDATE phases SET status='active'` only ever happened inside
  `Phase4Coordinator.schedule()`, which nothing called. Rescued and completed
  the previous agent's killed session (`worktree-agent-aab290f3bd0186fc0`,
  which had already landed `phaseLaunchService.ts`, `dispatchContextScope.ts`,
  and `main.ts`/`server.ts`/`migrate.ts` wiring, but zero tests). New
  `apps/server/src/coordinator/phaseLaunchService.ts`'s `PhaseLaunchService`
  finds a phase's dependency-ready tasks, assembles each one's context through
  E1's assembler, and schedules it through the EXISTING, unweakened
  `Phase4Coordinator.schedule()` (local-runner projects) or
  `ActionsExecutionCoordinator.schedule()` (GitHub Actions projects) — every
  precondition it checks upfront only ever refuses work the gate would also
  refuse, earlier and with a specific human-readable reason
  (`phase_not_ready`, `no_execution_binding`, `installation_not_ready`,
  `unverified_binding`, `actions_execution_unavailable`,
  `budget_exhausted`, plus every EXECUTION E1 assembly-failure code surfaced
  verbatim). `dispatchContextScope.ts`'s `DispatchContextScopeRepository`
  closes E1's authentication-only fetch-route gap: the moment a task is
  scheduled, the runner it was dispatched to is recorded against every exact
  context document it was handed, and the fetch route now requires both a
  valid signature AND that scope row. Wired `execution: {transactions,
  baseUrl}` into `main.ts` (was built by E1, never passed — the same
  unwired-service failure mode as FRONT DOOR P4/ONBOARDING O2) plus a new
  `GET/POST .../phases/:phaseId/start-readiness|start` route pair in
  server.ts's "EXECUTION E2" section. Minimal `apps/web/src/
  StartPhaseControl.tsx` "Start phase" trigger, shown only for
  approved/active phases, enabled only when the real read-only
  `start-readiness` preflight reports ready — never enabled when the gate
  would refuse. Found and fixed two bugs surfaced while writing tests: (1)
  merging E1+E2 broke 2 pre-existing E1 tests because the new authorization
  layer now 403s a runner that was never scoped (fixed the tests to record
  scope first, split one test into an authorized-404 case and an
  unauthorized-403 case); (2) `server.ts`'s Phase4 dispatch-tick/recovery-scan
  timers had no `.catch()` — an ordinary transient DB error was an unhandled
  rejection that could crash a production server outright; nothing had ever
  caught it because no test exercised `buildServer`'s `phase4` option before
  this program's boot-wiring test. Migration stays `0020_` (previous agent's
  provisional number; still unassigned, per instruction, for the PM).
  Suites green: server 667 (+28 net over E1's 639: +14 `phaseLaunchService`,
  +8 boot-wiring, +5 `dispatchContextScope`, +1 net from the E1 fix), web 113
  (+10). biome/tsc --noEmit/build all clean.

## ONBOARDING program

- [x] O6 Binding promotion — closes the blocker that made every GitHub project
  undispatchable. A candidate now becomes a `connected` binding through
  `ProjectActivationService`, on evidence Norns actually observed: a live
  installation probe, a resolve through that installation, and a real head
  revision read back (which becomes `observed_head`). Runs inline as part of
  `POST /api/v2/projects/onboarding`, with `POST /api/v2/projects/:id/activate`
  as the retry path once a human grants installation access. The laptop-runner
  promotion path is untouched. Also fixes silent adoption of a pre-existing
  repository in `new_repo` (durable creation intents) and the
  `blockers`-shape mismatch with the wizard. Migration written as
  `NNNN_onboarding_repository_intents.sql`, number unassigned. Suites green:
  server 599 (+26 over O2, 8 skip).

- [x] O2 Bindings — durable model and commands for GitHub-backed project
  setup. Adds a `role` column (`workspace` | `remote`) to both binding tiers
  (`repository_bindings`, `repository_binding_candidates`), leaving
  `projects.primary_repository_binding_id` and the Phase 4 dispatch gate
  untouched. Two atomic, actor-scoped-idempotent creation commands
  (`new_repo`, `existing_repo`) in `ProjectOnboardingService`, each attaching
  one repository under both roles; `POST /api/v2/projects/onboarding`. Push
  credential collapses to `actions_github_token` (GitHub provides
  `GITHUB_TOKEN` inside the Actions job; Norns issues nothing). Migration
  written as `NNNN_onboarding_bindings.sql` with the number unassigned — the
  PM assigns it at integration. Wired into `main.ts` alongside
  `planningRuns`/`attachments`, with a route-wiring test asserting the exact
  option shape production supplies. Suites green: server 550 (+15, 8 skip).

## FRONT DOOR program

- [x] P4 Attachments — image attachments end-to-end: content-addressed Postgres
  store (migration `0013_attachments`: `attachments` + `attachment_blobs`,
  plus `planning_runs.attachment_ids`), a capped/deduped `AttachmentService`
  and `POST/GET/DELETE /api/v2/projects/:id/attachments`, provider-neutral
  multi-part adapter message content (Anthropic base64 image blocks / OpenAI
  data-URI `input_image`, per-request cap 8, string-content callers unchanged),
  planning round-1-only image injection, and the isolated
  `apps/web/src/AttachmentInput.tsx` component (not mounted — Phase 1 mounts it).
  Suites green: adapters 25 (+2 live-skip), web 77, server 480 (+8 skip).

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

## Done (cont.)
- [x] NORN-042 — **Real user login system**, replacing the single shared `NORNS_TOKEN` as the day-to-day credential (2026-07-15): `UserStore` (scrypt password hashing + timing-safe compare, opaque session tokens, manual-add and email-invite lifecycles), `/api/auth/*` + `/api/admin/users*` routes, Resend email module (gated behind `RESEND_API_KEY`, degrades to a shareable invite link when unset — the created user record isn't lost if email delivery fails), one-time first-admin bootstrap gated by the existing `NORNS_TOKEN` (structurally one-time: gate checks `users.count === 0`, not just UI-hidden). Web app: rewrote `Login.tsx` into three modes (sign-in / bootstrap / accept-invite) driven by `/api/auth/status` and a `?invite=` URL param; new `Account` and `Admin` (role-gated) modal panels wired into both the Projects topbar and the graph-workspace sidebar. 5 pre-existing test files migrated off the old static `sessionToken`/`TOKEN` pattern onto real seeded sessions (`helpers.ts`'s `testAdminToken()` + per-file `UserStore` instances). Full monorepo CI green (server 134+1skipped incl. 16 new HTTP-route tests + 9 UserStore unit tests; web 31 incl. new Login/Account/Admin/App-auth-wiring suites). Live browser-verified: login, admin add-user, admin invite-by-email (email-not-configured path showing the manual link), role-gated Admin button visibility. Merged to main (`7519ad4`), pushed. **Deploy note**: production has zero accounts under the new system — first visit after deploy shows the bootstrap screen; use the existing `NORNS_TOKEN` Railway env var there once to create the first real admin, after which it's permanently disabled

## PHASE TAB program
- [x] PT-P1 — ✅ **Phase tab backend** (this worktree): per-run `review_rounds`
  + `worker_providers` on POST planning-runs (DTO exposes
  `review_rounds_total`/`rounds_completed`/`worker_providers`/`decision`);
  pinned defaults claude-fable-5 (PM) / openai gpt-5.6-sol (reviewer), env +
  per-project overrides still win; allocation recommendation constrained to
  the run's allowed implementation providers (reviewers stay cross-provider);
  POST .../planning-runs/:runId/decision (approve with registry-validated
  staffing / modify with direction-seeded revise→review re-entry / reject;
  409 outside converged|cap_reached; new terminal statuses approved/rejected);
  GET /api/v2/projects/:id/execution-status (per-phase percent_complete /
  est_completion / notes from existing phases+tasks+agent_runs data);
  migration UNASSIGNED_phase_tab_planning_decisions.sql (integrator assigns
  the number). Execution kickoff on approve is a named seam
  (ApprovedPlanExecutionKickoff), deliberately unwired in main.ts — see
  progress.log entry for why.

## In Progress
- [x] EXEC-CANCEL-1 — ✅ **Cancellation deadlock: acknowledged stop never finalizes a never-started run.** A run stuck in `dispatched` (agent never executed the delivered command — pre-5897cb5 build dropped the encoded-ID frame) was stopped by the user; the fixed agent acknowledged the cancellation but truthfully reports no live process, and the server only cancelled a run on `process_exited` evidence, so the run/task/phase hung forever and `can_stop` was disabled. Fix in `recordDeviceEvidence`: `runner_acknowledged` evidence now finalizes a run still in `created`/`dispatched` — such a run never emitted `run_status started`, so no managed process tree can exist and the acknowledgement is the strongest evidence the runner can ever send. Regression test added; full server suite green except the pre-existing `gatewayRealRuntime` timeout (fails identically on a clean tree). Live incident (StrumSheetV01 Phase 1 attempt 2) unstuck via the agent's local evidence journal: run `cancelled`, cancellation `process_exited`. **Round 2 (same push series):** the cancelled run then had NO recovery path — the evidence path stranded the task in `assigned` (no cascade), the retry gate refused `cancelled` runs, and the web recovery panel only rendered on `failure_detail` (null for cancelled). Fixed all three: evidence path now cascades the task to `blocked` (not terminal `cancelled` — it cannot distinguish "stop this stuck run" from "abandon the task"), retry accepts `failed`/`expired`/`cancelled` designated runs, and the web panel gates on run+task state mirroring the server. Live task transitioned `assigned→blocked` in production via the server's own `transitionV2TaskLifecycle`.
- [ ] EXEC-HANG-1 — 🟡 **Lost-promise hang in the agent's context load (mitigated, not solved).** Attempts 2 and 3 (StrumSheetV01) hung forever at `await context.load(...)`: heartbeats flowed (loop alive), `fetch` worked when re-run inside the same stuck process via the inspector (1.9s), no open socket, no rejection — the run's own promise was simply lost. Mitigation shipped: 60s `AbortSignal.timeout` on context fetches plus stage-breadcrumb `run_log`s, so a recurrence fails loudly in a minute and is retryable. Root mechanism still unknown — reproduce with the breadcrumbs in place. Related gap: the breadcrumb `run_log` events did not arrive in `runner_events` over the device transport (knowledge_heartbeat/run_status did) — find where run_log frames are dropped.
- [ ] EXEC-AGENT-1 — 🟡 **Agent reconnect lag after server redeploy + dev override note.** Every Railway deploy kills the WSS; the agent's liveness probe takes minutes to notice, and during that window dispatch refuses with `unverified_binding` (now visible in drain logs). Consider faster ping/pong or server-close handshake. ~~Repo-build plist override~~ RESOLVED 2026-08-19: agent 0.4.5 packaged (includes context-fetch timeout + breadcrumbs), installed, and launched — plist restored to the `/Applications` paths, device reconnected reporting 0.4.5. Also: `projects.primary_repository_binding_id` for StrumSheetV01 was flipped to a GitHub binding by a repository-claim flow at 2026-08-19T01:01Z while the project executes on a device grant — restored to the local binding by hand; decide how target selection should prevent that.
- [x] EXEC-WAIT-1 — ✅ **Human-input request no longer torches uncommitted work.** The human-wait path now checkpoints uncommitted changes (reusing checkpointUncommittedChanges, the same mechanism verification uses), publishes the resumable commit, and opens the wait — instead of failing the run. Two acceptance tests flipped to assert checkpoint-and-wait; 14/14 pass. The human-response UI already existed end-to-end (HumanWaitCard renders inline in the execution_pm conversation, answer→resume fully wired) — the runner failing before opening the wait was the only gap. Shipped ca0dccf, agent 0.4.8.*
- [x] EXEC-REVIEW-1 — ✅ **Resolved by policy: there is no reviewer between phases.** Every succeeded development run parked its task at `in_review` forever (`agent_reviews` never had a row, no worker reviewed runs, no UI approve control), so dependents never dispatched and Foundation needed a manual operator completion on every phase. Product decision (David, 2026-08-19): green verification is the bar. New `PhaseReviewAutoCompleter` poll (server timer beside the queue drainer) auto-completes every `in_review` task whose designated run succeeded + verified + published and has no `awaiting_human` conflict, through the existing `Phase4CompletionService` with synthesised review-waiver + published-commit evidence — the operator path, automated. The drainer then dispatches the unblocked dependents, so phases advance on green. Keyed off `published_commit_sha`, not a handoff row (planned runs may leave no handoff). Test in executionE12 (green→in_review→sweep→completed, phase_closed, idempotent); tsc + biome + full E12 suite green. Follow-up EXEC-REVIEW-2 if opt-in review is ever wanted.
- [x] EXEC-USAGE-1 — ✅ **Surface per-run actuals (compute time, tokens, cost) on the Development run card.** Prompted by "how long / how many tokens did StrumSheetV01's foundation run take" being unanswerable from the UI. The data already existed: `agent_runs` carries `started_at`/`finished_at` (wall-clock) and `usage_input_tokens`/`usage_output_tokens`/`usage_cost_usd`, the last three aggregated from `run_command_usage_receipts` (the runner's `usage_report` events — the Claude Code SDK reports real token counts even though coding runs don't pass through the metering proxy). `started_at`/`finished_at` were already in the attention DTO for the ETA math but never displayed. Threaded the three usage columns through the contract run object (`input_tokens`/`output_tokens`/`cost_usd`, defaulted so existing producers/fixtures parse unchanged) → `attentionService` SQL + DTO → a `developmentRunActuals` formatter rendered as a muted `.conversation-agent-run-actuals` line under each attempt's status. **Cost is deferred, not built:** runner-reported coding tokens have no pricing applied so `cost_usd` is null/0 there and the cost part simply hides; only proxied planning/QC calls carry real cost today. Applying a model pricing table to runner-reported tokens is the follow-up (EXEC-USAGE-2). Verification: contracts build + server/web `tsc --noEmit` clean, biome clean, ConversationWorkspace 75/79 (4 pre-existing skips) and phase5Attention 14/14 green.
- [x] EXEC-WAITUX-1 — ✅ **Human-wait reply is now one step, not two.** The `awaiting_human` card made you (1) fill "Exact answer" + "Rationale", (2) click "Prepare answer for confirmation", then (3) find and confirm a *separate* action card — with the caption "Preparing this answer does not resume work" — while branch/commit/budget-reservation evidence tables dominated the card. Live pain: operator sat on a Core-engine wait unable to tell that a second confirm was even required. Collapsed to one step entirely inside `HumanWaitCard` (no server/contract change): the existing "prepare" still creates the proposed `answer_human_wait` action, and a new `useEffect` auto-confirms it once it appears (`status === "proposed"`, not busy, no error, single-fire ref). The effect runs *after* render so `busy` has cleared and `onConfirm` is fresh — avoids the stale-closure race that chaining prepare→confirm inline would hit on the shared `busyActionId`. If the confirm fails the action stays `proposed` and its card still offers a manual Confirm as a fallback. UI simplified to a single "Your reply" box + "Send reply" (dropped the separate Rationale field — API still takes `null`), removed the confusing caption, and tucked the evidence tables into a collapsed `<details>Details</details>`. Tests rewritten to the one-step flow (auto-confirm via `waitFor`); ExecutionConversationControls 7/7, ConversationWorkspace 75/79 (4 pre-existing skips), tsc + biome clean. **Not done:** routing replies through the *global* composer (the reply is still an inline box under the question) and letting a human ask a clarifying question *back* without resuming the run — both are follow-ups (EXEC-WAITUX-2) if the inline box isn't enough.
- [x] EXEC-WAITUX-2 — ✅ **Stripped the human-wait ceremony down to a plain chat reply.** Operator's words: "this is too formalized, I just need to chat and tell it to proceed" — the post-answer card was an "EXPLICIT HUMAN DECISION" block with a Delivery-status stepper (proposed→…→applied), a separate Continuation stepper (queued→…→applied), a "Continue action" button, and a "Refresh continuation status" button — a multi-click ceremony over a one-line answer. **Decision (with the operator, after surfacing the tradeoff):** keep the durable session-resume *under the hood* (so work survives disconnects and GitHub-Actions execution still works) but make the *UI* a plain chat — the runtime already supports this (durability is the server/UI layer, not the runtime). All web-only, in `HumanWaitCard`: removed the `ConversationActionCard`, both step-trackers, and both buttons; replaced with a single self-updating `humanWaitAnswerStatusCopy` line ("Answer saved — waiting for the agent to pick it up. This resumes on its own." → "…resuming…" → "Answer sent — the agent has picked up where it left off."). Added a 5s auto-poll (`onRefresh`) that runs only while pending and stops on applied/terminal/error, so nothing needs a manual Refresh/Continue click. Kept a minimal error-only "Try again"/"Refresh" fallback. Plain-language pass on `waitStatusCopy` too (dropped "the runner was released after publishing its branch", "budget reservation", "continuation" jargon). Tests rewritten to the plain flow; ExecutionConversationControls 7/7, ConversationWorkspace 75/79 (4 pre-existing skips), tsc + biome clean. **Still deferred (EXEC-WAITUX-3):** routing the reply through the *global* Development composer (it's an inline box under the question today), and letting a human ask a clarifying question *back* without resuming.
- [ ] EXEC-WAITUX-3 — 🟡 **Reply from the global composer + ask-back without resuming.** Two remaining "make it feel like chat" items: (1) route the human-wait reply through the normal Development message composer instead of the inline reply box, so answering is literally typing in chat; (2) let a human ask the agent a clarifying question mid-wait and get an answer before committing the resume/budget. Both are experience polish on top of EXEC-WAITUX-2; build only if the inline reply still feels too separate in real use.
- [ ] EXEC-USAGE-2 — 🟡 **Price runner-reported coding tokens so per-run cost is non-zero.** EXEC-USAGE-1 surfaces `cost_usd` but the coding runtime's tokens (Claude Code / Codex on the local agent) never hit the metering proxy, so no pricing snapshot is applied and their cost reconciles to 0 — the run card shows time + tokens but no dollar figure for the actual development work. Apply a per-model price table to the `run_command_usage_receipts` runner-report path (mirror the proxy's pricing snapshot) so coding cost is real. Needs a pricing source keyed by the runtime's model id.
- [x] EXEC-INTEGRATE-1 — ✅ **DURABLE FIX BUILT (needs live-agent validation): the runner now integrates a verified run into the base branch, and the server advances the dispatch base with it.** Root cause recap: every dispatch branches from `repository_bindings.observed_head`, which nothing ever advanced past the initial commit, so each phase started from a base missing all prior phases' work (foundation→core-engine stranded). Server-side GitHub-App merge (Option B) was ruled out — StrumSheetV01 runs on a `local_runner` binding with no `github_installation_id`, so the server has no API merge path for it; only the runner (which holds the work and the push credentials) can merge. **Implementation (Option A), all layers tested:** (1) Contract — `V2DispatchCommand.integrate_base_branch?` and `run_published.{integration_outcome,integrated_base_branch,integrated_base_commit}?`, both additive/optional. (2) Coordinator dispatch — sets `integrate_base_branch` to the binding's `default_branch` for `local_runner` bindings only (GitHub-Actions bindings integrate through a PR, so it stays absent). (3) Runner `GitPublisher` — after publishing the task branch on a **verified** run, fast-forward-pushes the commit to the base branch; converges idempotently under redelivery; a base that advanced independently is reported as `conflict` and **never force-moved** (losing another phase's work is worse than a visible blocker); ff-only, upgrade path noted for concurrent phases. (4) Server `run_published` handler — advances `repository_bindings.observed_head` to `integrated_base_commit` on `integrated`/`already_integrated`, never on `conflict`. Tests: real-git ff-success + conflict-safety (runnerPublication), dispatch carries the base + observed_head advances / conflict doesn't (phase4Coordinator); contracts 230, affected server suites green, tsc + biome clean. **Remaining before trusting in production:** (a) live end-to-end validation on the actual local agent (the runner half only truly proves out against a real agent — I can't run one from here); (b) surface a `conflict` outcome to the operator as a blocker (today it just doesn't advance — silent-ish); (c) local-only bindings with no remote still don't integrate (out of scope — no remote to advance). Original design notes retained below for reference.
  - Original: Live on StrumSheetV01: foundation was completed via the operator/auto-complete path (EXEC-REVIEW-1), which recorded commit `0896ccc` as evidence and auto-dispatched core-engine — but never merged the `norns/task-…-foundation` branch into `main`. `main` stayed at the bare "Initial commit" `5916478` (README only), and core-engine was branched from that foundation-less `main`, so the engine-builder saw only a README. Manual unblock 2026-08-19: fast-forwarded `main` → `0896ccc` and pushed.
  - **Agent 0.4.9 packaged 2026-08-20** with the runner-side integration code (verified present in `norns-runner-0.1.0.tgz`): `dist-agent/macos/installer/Norns-Local-Agent-macOS.pkg` (463MB, sha256 `51f2747bdec7c287fb5504e6803f6cb256f5aebe981a1d61e2d407efac8e6dac`). Install (needs the human's password): `sudo installer -pkg "dist-agent/macos/installer/Norns-Local-Agent-macOS.pkg" -target /`. Unsigned — first launch needs a Gatekeeper allow. The server half (dispatch sets `integrate_base_branch`, observed_head advance) deploys via Railway on push `b3d6280`; GitHub-Actions runners get the new runner tarball from the same deploy's Docker repack, so only the local Mac agent needs this manual install. Then live-validate an actual phase hand-off before trusting it. Live on StrumSheetV01: foundation was completed via the operator/auto-complete path (EXEC-REVIEW-1), which recorded commit `0896ccc` as evidence and auto-dispatched core-engine — but never merged the `norns/task-…-foundation` branch into `main`. `main` stayed at the bare "Initial commit" `5916478` (README only), and core-engine was branched from that foundation-less `main`, so the engine-builder saw only a README and reported a bogus "not a git repository / grant write access" environment blocker (the repo/permissions were actually fine — the missing merge was the real cause). Norns normally integrates task branches with `git merge --no-ff <branch>` (engine/integration.ts); the completion shortcut skips it. **Manual unblock applied 2026-08-19:** fast-forwarded `ruggerdude/strumsheetv01` `main` → `0896ccc` and pushed, so `main` now carries the 21 foundation files (boot/auth/migration). **Still required:** re-dispatch core-engine from the new `main` — the queued run is pinned to base commit `5916478` (README-only), so the merge alone doesn't feed it foundation. **Durable fix:** the phase-completion/auto-advance path must integrate the completed phase's branch into `main` (and the next phase must branch from the integrated head) before dispatch. Until then every phase hand-off strands its predecessor's work.
- [ ] EXEC-INTEGRATE-2 — 🟡 **Runner mis-reports a missing-integration blocker as a filesystem/permissions failure.** The engine-builder for core-engine reported "every git command fails with 'not a git repository'" and asked the human to "restore read access" / "grant write access" to `/Users/dhatwell/Apps/strumsheetv01/.git` and the worktree. Verified false on the host: the repo is a valid git dir, `git status` is clean, files are `dhatwell:staff` rw. The actual cause was EXEC-INTEGRATE-1 (base commit had no foundation). A worker that can't find expected prior work should not confabulate an access/sandbox diagnosis — it sends the operator chasing a non-existent permissions fix. Surface the true state (base commit, branch, file list) instead.
- [x] EXEC-PLANHANG-1 — ✅ **Planning/PM turns could hang forever ("Weaving the plan…" that never resolves).** Live on StrumSheetV01. Root cause (same class as EXEC-HANG-1): `PlanningRunWorker` renews its lease from a `setInterval` heartbeat that runs *independently* of the awaited generation, and `reconcileOrphans` only fires on server restart — so a stalled LLM round (lost promise, provider that never returns, no client timeout) keeps the run `drafting`/`reviewing` forever while the heartbeat holds the lease fresh. The `AbortController` existed only for user-Stop, never a deadline. Fix: added a hard wall-clock cap `planningRunMaxMs` (option → `NORNS_PLANNING_RUN_MAX_MS` → 15 min default). Planned + quick paths race the generation via `withDeadline` (Promise.race); on timeout it rejects → existing catch → `fail()`, which rotates the lease so a late zombie resolution can't overwrite the terminal record. Review-only path aborts its controller on the same deadline (propagates through `signal`) and reports a truthful `PlanningRunDeadlineError`. Result: a stalled run fails and becomes retryable within the cap instead of spinning forever. Test added (hanging adapter + 80ms cap → run `failed` with a deadline error); planningRunWorker 10/10, phaseTabPlanning/qcPauseResume/planningAttachments 44/44, tsc + biome clean. **Not solved:** the underlying lost-promise root mechanism (EXEC-HANG-1) — this bounds the symptom loudly, it doesn't prevent the stall.
- [x] EXEC-CANCEL-2 — ✅ **Watchdog for delivered-but-never-started dispatch commands.** The stuck command's `expires_at` passed hours before anyone noticed, but expiry was only enforced pre-delivery. Fix: `Phase4RecoveryMonitor.scan()` now runs an `expireStaleDispatches` sweep first — a designated run still in `created`/`dispatched` whose command envelope `max(expires_at) <= now` (joined via `dispatch_jobs`→`commands`, active phase) is auto-transitioned to terminal `expired`, and its task cascades `assigned`→`blocked`. Those two run states provably never emitted `run_status started` (the `dispatched`→`running` edge), so expiry is unambiguous and needs no human; `blocked` is exactly the state the existing recovery surfaces (EXEC-CANCEL-1) offer retry from — so the task self-heals into a recoverable state with no user Stop. Best-effort and idempotent: a concurrent transition (runner started, human cancelled, version bumped) just skips that row, never aborts the scan. `scan()` return gained `expired_dispatches`. Test added (delivered command past 20:15Z deadline → run `expired`, task `blocked`; before the deadline → nothing); phase4Coordinator 24/24, planningExecutionKickoff 9/9, full server suite green except the pre-existing `gatewayRealRuntime` flake (fails identically on a clean tree). tsc + biome clean.
- [x] QC-ELAPSED — ✅ **Show elapsed time on the running QC step.** A round-1 review that had been running ~5 minutes was indistinguishable from a frozen page: the working panel said "Independent reviewer is checking the plan / No action is needed right now" with nothing changing and no clock. The data was already there — `planning_runs.live_progress` persists `stage`, `round`, `attempt`, `provider`, `model`, `started_at` (per operation) and `checkpoint_at`, and it is already on the review DTO the page renders — `QcWorkspace` simply never rendered any of it. Adds a `StageElapsed` component counting from the durable `live_progress.started_at` (so refresh/new tab shows the true step age, unlike `PlanGenerationProgress` which counts from mount), plus the model name and a "retry N" marker when `attempt > 1`. Web-only; no server or contract change.
- [ ] QC-SLOW — 🟡 **Local QC runs default to `legacy_full` revisions.** `server.ts:785` defaults `NORNS_QC_REVISION_FORMAT` to `legacy_full`, so the PM re-emits the entire plan JSON every round (uncapped `max_tokens`, vs 4,000 for targeted). Production sets `targeted_v1_with_fallback` in Railway env; a local/dev run without that variable gets the slow path. Decide whether the code default should follow production. Related: `planningWorker.tick()` is serialized behind `planningTickInFlight` and awaits the whole review, so one multi-minute QC run blocks every other planning claim for its duration.
- [x] QC-THINK — ✅ **Fix Sonnet-5 QC revision failures: thinking was eating the structured-output token budget.** `packages/adapters/src/anthropic.ts` never set `thinking`, and on Anthropic `max_tokens` bounds thinking AND visible output together. Claude Sonnet 5 / Opus 5 run adaptive thinking when `thinking` is omitted (Sonnet 4.6 did not), so callers that sized `maxTokens` around a JSON envelope (3k–5k for QC revisions, 16k default for legacy `plan_revision`) silently lost most of it to thinking and the envelope truncated mid-object → `structured:plan_revision / invalid_response`. Production runs `NORNS_PLANNING_MODEL_PROFILE=balanced`, whose PM **is** Sonnet 5, so the default config was the broken one (telemetry: sonnet-5 plan_revision failed 3 of 4). Fix: explicitly `thinking: {type:"disabled"}` on the non-chat completion paths (`complete`, `completeStructured`, `streamStructured`) so the budget deterministically means output tokens; `streamConversation` (chat) untouched — chat benefits from thinking and its budget is not load-bearing. Fable/Mythos 5 opt out (they 400 on an explicit disable). Live A/B on `claude-sonnet-5` at the real 4,000-token targeted-revision budget: **before** `stop_reason=max_tokens`, 4,000 output tokens with only 864 chars of visible JSON (thinking ate ~3,700), envelope unparseable; **after** `end_turn`, 3,621 output tokens, 10,591 chars, valid 7-module envelope. Also fixed the misleading `"response is not JSON"` message when `stop_reason=max_tokens` (the `output_truncated` classification was already correct and already wired to suppress retries). ~$0.35 spend. Regression test asserts the actual wire request in `packages/adapters/test/thinkingBudget.test.ts`.
- [ ] QC-THINK-OPENAI — 🟡 Same class of bug may exist in `packages/adapters/src/openai.ts`: `max_output_tokens` bounds reasoning + output together on the reasoning models, and the adapter sets no reasoning-effort cap. Not measured — unblocked by QC-THINK but not covered by it.
- [x] PERF-1 — ✅ **Stream initial plan generation** (backend + web client). Plan gen was one buffered `completeStructured` call (~4,200 output tokens, ~50s) showing nothing until the last token. Provider throughput is a constant 53–107 tok/s across every call type, so latency is a linear function of emitted tokens — streaming cannot reduce model time, it converts ~50s of blind spinner into ~2s-to-first-token. Adds `streamStructured` to all three adapters (`completeStructured` untouched, QC still uses it), a new SSE `plan-proposals/stream` route on the existing AI-SDK UI-message transport, and a web client that lists module titles as they arrive, falling back to the non-streaming route on any stream failure using the same idempotency key. Telemetry routes through the same `invoke()` so no second accounting path can drift.
- [x] PERF-2 — ✅ **Stop exponential QC plan inflation** (guard shipped; effect NOT proven). Baseline: seed 1,229 tok / 2 modules → 5,565 tok / 4 modules after ONE round; round-1 growth across reviews 3.9x–7.6x, compounding over the 3-round default, with two rounds hitting the 16,000-token ceiling and truncating. Root cause: `pmSystem` said "decompose into modules" (re-read every revision) and `revisionPrompt` carried no scope constraint. Fix: `SCOPE_DISCIPLINE` (wording reused from the never-inflating `quickChangePrompt`), a revision-only `pmRevisionSystem` (drafting untouched), and a server-side `moduleGrowthViolation` guard on both targeted and legacy paths, surfaced through the existing structured-failure/repair path. See PERF-4 — the live A/B was invalid and the guard bound is too loose.
- [x] PERF-3 — ✅ **Benchmark harness** (`apps/server/scripts/planning-benchmark.mjs`), read-only, reproduces the production baseline exactly; `--since 2026-07-30` is the window that matches.
- [ ] PERF-4 — 🔴 **PERF-2 measured and did NOT work; guard is inert.** Real one-round A/B through `runReviewOnlyPlanning` with the real Anthropic PM (opus-4-8), production system prompt, schema and frozen context, pre-fix arm in a `git worktree` at b29d8c0. n=6 pre-fix vs n=7 post-fix, $2.79. **Token growth identical: 2.72x mean in BOTH arms** (medians 2.72x vs 2.74x, distributions fully overlapping — no effect to detect). Module growth 3/7 pre-fix vs 1/7 post-fix added a module — right direction, Fisher p≈0.56, not significant; ~40+ runs/arm needed to demonstrate it. **`moduleGrowthViolation` fired 0 of 7 and cannot bind on this input**: the PM accepts 12–13 findings at must_fix/should_fix, permitting 14–15 modules against a 2-module seed. **Also corrected: the long-quoted 4.5x/2.0x baseline is the plan after TWO rounds, not one.** True one-round pre-fix result on this input is 3,221 tok / 3 modules = 2.62x / 1.50x; the harness BASELINE now records both. The compounding the fix targets happens going INTO round 2, which a one-round harness cannot observe. Next: n≈15/arm on claude-sonnet-5 over 2 rounds (~$2.40) to both gain power and exercise the actual mechanism; and re-scope the guard budget, which is far too loose.
- [x] QC-VIEW — ✅ **QC review page restructure**: pinned (sticky) status header carrying live phase text ("Round 2 of 3 · waiting for the QC reviewer"), progress bar, and every decision control (Stop / Approve / Retry / Skip / Reject) — previously buried below three redundant timelines, which is why the state was unreadable and retry looked missing. **Root-cause bug fixed**: retry/skip/reject follow-ups are proposed by the server against `review.plan_version_id`, but the client matched on `revised_plan_version_id ?? plan_version_id`, so any failure after a mid-review PM revision silently rendered *no* recovery buttons at all. Now matches either id; regression test added and confirmed to fail without the fix. Review receipt (models/hashes/context) demoted to a collapsed section. Polling no longer remounts the thread (no flicker). 357 web tests green, tsc + biome clean.
- [x] DES-R2-ONBOARD — ✅ **Onboarding 500 fix + "Approve plan" label** (opened and closed in the
  same push): production `POST /api/v2/projects/onboarding` 500 traced to 0018 granting only
  SELECT, INSERT on `project_onboarding_repository_intents` while the service locks rows with
  `SELECT ... FOR UPDATE` (needs UPDATE) under the restricted `norns_app` role. New UNASSIGNED
  migration `NNNN_onboarding_intents_update_grant.sql` (audit of 0016/0018 found no other gaps);
  boot guard `assertCurrentRuntimeSchema` now asserts the onboarding relations + candidate
  columns so a half-migrated deploy fails loudly at boot; onboarding catch-all logs pg
  code/detail/table and the silent 409/503 refusal branches now log reason + status; web
  `send_plan_to_qc` action relabeled "Approve plan" ("Approve and begin" unchanged). Pglite
  test proves the grant with a real `norns_app` role.
- [ ] NORN-041 — 🔄 **UI Integrity Remediation Program** (multi-phase, human-directed): resolving 7 accepted UI findings (UI-1 stale approval, UI-2 QC-edit loss on failed commit, UI-3 hidden convergence/cost/findings, UI-4 empty-acceptance-set bypass, UI-5 accordion reset, UI-6 wrong-project dashboard, UI-7 cross-node override drafts) without regressing the plan→graph→allocation→approval product contract. Phase 0 discovery complete: found and merged an out-of-band OpenAI Codex redesign (`codex/ui-design-pass` branch, commit `63d4bfc`, fast-forwarded into `main` 2026-07-14 with human approval) — dark theme now consistent app-wide, responsive layout, risk-colored graph nodes, node-delete confirmations, but fixes 0 of 4 Critical findings and introduces one new bug (UI-4's empty-module check is vacuously-true on an empty array). Live-reproduced all 7 findings in-browser against real endpoints; confirmed UI-5 already resolved by the redesign, UI-6 partially mitigated (disclosure banner only, still fetches/renders the wrong project's data). Root cause for UI-1: `approveAllocation()` computes a hash and returns it but persists nothing server-side; `graph.version` never bumps on allocate/override so it can't alone serve as the staleness fingerprint. Three ADRs decided (human-approved): approval binds to graph version **+ a new separate allocation fingerprint** (not reusing graph.version); non-converged plans **block with no override** (no unaudited exception path); dashboard gets **immediate containment only** (hide the entry for real projects) with durable per-project dashboard deferred as its own follow-on. **Phase 2 complete and merged to main** (2026-07-14): Agent D (sonnet, worktree) added Vitest+RTL+jsdom+Playwright to apps/web (was zero frontend test tooling), a mock-fetch helper, contracts-validated fixtures, and 9 baseline regression tests across all 7 findings — independently re-verified by the program manager (not just trusted): 7 fail for the documented reason, 2 pass (UI-5 already correct; UI-6 intentionally documents today's bug rather than a not-yet-decided fix, will need rewriting not flipping). Merged `worktree-agent-a516b9e1ef7880e3d` → main (`b77d63a`), pushed. **Phase 3/4/5A + Phase 6 (Integration) complete** (2026-07-15): Agent A (opus, App.tsx + server approval persistence), Agent B (sonnet, PlanReview.tsx presentation + UI-4 fix), Agent C (opus, dashboard route separation) all completed in parallel worktrees, each independently re-verified by the program manager by reading the actual diffs and re-running lint/typecheck/tests myself — not trusting summaries. All 7 findings resolved: UI-1 (server-authoritative approval bound to graph.version + a new separate `allocationFingerprint`, persisted through Tier-2), UI-2 (QC edits survive failed commits, with retry), UI-3 (full convergence/rounds/cost/outstanding-findings surfaced, ADR-2's no-override enforced structurally — the load path doesn't render at all when capped), UI-4 (empty-acceptance-set modules correctly block commit), UI-5 (confirmed still correct), UI-6 (Dashboard entry removed entirely for real projects; demo data isolated to `/api/demo/dashboard`, containment proven structural not just naming), UI-7 (override drafts keyed per node, explicit Save/Cancel). Integration required real conflict resolution: Agent A and Agent B each independently touched `PlanReview.tsx` (Agent A's was a minimal contract-only stub without the actual UI-4 fix; Agent B's was the complete, correct implementation) — resolved by taking Agent B's version wholesale. Agent A and Agent C's overlapping `server.ts` edits auto-merged cleanly (no conflict) since both stayed localized to their sections as instructed. Full monorepo CI green (contracts 31, adapters 10+2skipped, server 109+1skipped, web 12 — all 7 findings' regression tests passing). Live browser-verified post-integration: UI-1's staleness banner ("⚠ Approval out of date...") and UI-6's absent Dashboard entry both confirmed in a real running instance, not just component tests. Merged to main (`270a417`). **Phase 7 (Adversarial Review) attempted and killed** (2026-07-15): Agent E (Explore, no edit tools by design) ran ~12 hours and stalled — its last checkpoint matched one from minutes into the run, indicating a loop rather than progress. Killed via `TaskStop` rather than left running indefinitely. Only one finding survived independent verification: UI-7 isolation reconfirmed via direct DOM inspection (a draft on node A did not leak to node B and back). Treated as genuinely incomplete, not padded with unverified claims. **Not yet done**: a proper Phase 7 re-run (smaller scope per agent, or a different reviewer pattern) and Phase 9 (Closure — resolution matrix, human acceptance)

- [x] NORN-034 — **Railway Tier-1 deploy scaffold**: single-service Docker build (server serves built web + API), host/token prod-hardening, /health, railway.json, ADR-002 amended to Railway, [DEPLOY.md](DEPLOY.md) with the 3-tier path. Verified locally in the prod model

- [x] NORN-024 — **Tier-2 Postgres persistence built + verified** (pglite): PgPersistence + SnapshotFlusher; main.ts hydrates/flushes when DATABASE_URL set; relay/outbox/audit survive restart. Activates via the Railway Postgres plugin
- [x] NORN-035 — **Tier-3 runner CLI built + verified** end-to-end: `norns-runner pair/start` connects a local runner to a live relay and executes commands. Live LLM execution still needs keys + Docker
- [x] NORN-037 — **Live planning endpoint built + verified** (superseded by NORN-039's project-scoped routes below, kept for history): `POST /api/plan` ran the real cross-provider planning loop against live models against a single global graph. `@norns/adapters` moved to a real server dependency (was type-only; now the server calls the SDKs directly for planning)
- [x] NORN-039 — **Multi-project management ("sole point of entry") built + verified (2026-07-14)**: `ProjectStore` (apps/server/src/projects/store.ts) replaces the single hardcoded graph — create/list projects, each with its own PM provider (pick Anthropic or OpenAI; reviewer always auto-flips to the other, cross-provider review is never optional), its own plan/graph once planned, independent from every other project. Routes moved under `/api/projects[/:id[/graph|/plan|/plan/load]]`; the old global `/api/graph*`+`/api/plan*` routes are gone (not deprecated — replaced). Postgres Tier-2 now persists the whole `ProjectStore` (all projects, plans, allocations) under one `"projects"` key. Web app: **Projects** is now the real landing view after login (list + create-project form with the PM picker); opening a project shows the graph editor scoped to it; a new **QC review screen** (`PlanReview.tsx`) shows every module's acceptance criteria after a live planning run and lets you edit statement/verification/type before "Load into graph" commits it — nothing reaches the graph un-reviewed. 101 server tests (18 files: ProjectStore unit tests, project-scoped graph API, project-scoped planning guard/load, ProjectStore Postgres round-trip), browser-verified full flow: create project → PM=openai (reviewer auto-set anthropic) → Live Planning → QC review/edit → Load into graph → Auto Allocate → Approve → back to Projects shows "planned". The demo 10-node walkthrough that drives the PM Dashboard is now fully separate from real projects (`demoSession` in main.ts) — untouched, still scripted, not persisted

## FRONT DOOR program
- [x] FD-P1 — ✅ **Frontend + visual refresh (dashboard, wizard, plan review, workspace, tracking)**
  landed on the P1 worktree (merged `frontdoor/integration` first). Scope built for real, wired
  to the actual P2/P3/P5 endpoints — nothing mocked:
  - **Dashboard** (`Projects.tsx`): full-width color-coded stacked project rows (red = decision
    waiting/blocked, green = executing, blue = plan ready, neutral = draft), coordinator/reviewer
    chips, aggregate %/blended ETA/agents/decisions from each project's `GET .../resume`
    `progress` object, and one line per phase (P-designator, name, inline progress bar, human
    wall-clock ETA). **Human-approved addition**: each phase line ends in a compact button —
    "Answer →" (danger color) when blocked, "Open →" otherwise — that opens the project
    workspace pre-focused on that exact phase (`focus_phase_id`), reusing/extending the
    workspace's existing phase-monitoring mechanism. Routing tested directly (4 new tests
    incl. the blocked-vs-normal button distinction).
  - **New Project wizard** (`Projects.tsx`, replacing the old modal): one full-page screen —
    name, source picker (GitHub repo picker unchanged; local folder still goes through the
    existing runner-pairing/selection-token flow — see deviation below), Coordinator model
    select (existing PM-model field, relabeled), Reviewer model shown read-only/automatic (see
    deviation below), rounds stepper (1–5, default 3), and the objective field. Submitting a
    *new* project with an objective creates it, then moves to an in-place second step that
    mounts the real P4 `AttachmentInput` (now that a project id exists) and, on explicit
    confirmation, calls `POST .../planning-runs` with the objective/rounds/attachment ids and
    opens the workspace pre-focused on that run. "Existing codebase" imports are unaffected.
  - **Workspace** (`App.tsx`): killed the orphan raw-objective "Create the next phase" text box;
    new-phase creation now drafts an observable planning run (round-by-round transcript
    polling), materializes it into a phase + proposed strategy via P3's bridge
    (`POST .../phases {planning_run_id}`), and opens the new **`StrategyReview.tsx`** component
    (rounds banner, objectives/tasks, an editable staffing table wired to
    `PATCH .../strategy/staffing`, and `POST .../strategy/approve`). Added the phase-scoped
    "needs you" panel (human-approved addition's Q&A/decision thread) by filtering the existing
    portfolio attention feed to the monitored phase, with inline decision answering reused from
    the dashboard. Added a tracking update-interval control (`PATCH .../settings`, 60/300/900s)
    with the resume poll cadence honoring whatever interval the server reports. The full
    date-axis Gantt-with-gate-diamonds from the approved mockup was *not* built — deliberately
    scoped down to progress bars/ETA/interval controls given the size of the remaining surface
    and the hard "don't break the existing 77 web tests" constraint; a dedicated Gantt pass is a
    good follow-up. The legacy graph/`runPlanning`/`/plan/load` flow and its `PlanReview.tsx` are
    untouched (still used by projects mid-way through it).
  - **Deviations found and reported rather than worked around**: (1) the design-freeze's D2
    ("local folder = plain path input, no runner required") is not implemented server-side —
    `POST /api/projects` structurally rejects `source_type: "local"` with a raw path
    (`superRefine` message: "raw local paths are not accepted; create the project and bind a
    runner selection token"); the wizard therefore still requires a paired runner for local
    folders, same as before. (2) P2 never exposed a route to persist a manual reviewer
    override — `planning_reviewer_settings` is written only by tests via direct SQL; the wizard's
    Reviewer field is shown as read-only/automatic rather than pretending a selection is saved.
  - Tests: 4 new files (dashboard phase lines + routing, wizard create→attach→planning-run incl.
    a failure path, strategy-review materialize/staffing-edit/approve, tracking interval PATCH +
    poll-cadence honoring) plus 4 existing-test updates for the wizard's new two-step flow and
    button label. Verification: biome clean, `tsc --noEmit` clean, full `@norns/web` suite green
    (87 passed, up from 77 — zero regressions), `pnpm run build` clean.
- [x] FD-P1b — ✅ **Final frontend pass: full Gantt, reviewer selector, folder-first local path**
  landed on the P1 worktree after merging `frontdoor/integration` (P2b, which closed both gaps
  FD-P1 reported). Three deliverables, all wired to real endpoints:
  - **Full Gantt** (new `Gantt.tsx`, pure CSS/percentage-positioned divs, no charting library):
    one bar per phase, solid fill = `percent_complete`/hatched = remainder, gate diamonds
    (plan-approval/passed from phase status, red + labeled from a real blocking attention item —
    not a placeholder), a Today line, and a per-row agent-count chip from real per-phase agent
    counts (fetched once per phase from `GET .../phases/:phaseId/execution` and counted as
    distinct implementation+reviewer profile ids — the resume DTO has no per-phase agent count).
    Mounted twice: the full version in the reopened "Tracking" section (now also hosting the P5
    interval control), and a compact `mini` strip on the workspace's "Project Resume" phase list
    (the phase-board placement). **Honesty constraint respected**: the resume DTO has no
    per-phase start/created timestamps today, so the axis is *proportional ordinal placement*
    (equal slot per phase in priority order, Today positioned by overall ordinal progress) rather
    than a fabricated calendar axis — documented in `Gantt.tsx` as a deliberate, data-driven
    choice, ready to switch to real dates the moment the DTO carries them.
  - **Reviewer selector**: the wizard's Reviewer field (read-only in FD-P1, since P2 hadn't
    shipped a write route) is now a real select — same model catalog as Coordinator plus
    "Automatic (cross-provider)". Wired to P2b's `GET/PATCH/DELETE
    /api/v2/projects/:id/planning-reviewer`: an explicit pick PATCHes it, leaving it on Automatic
    DELETEs any override — both applied right after project creation, before the planning run
    starts, best-effort (a failure there doesn't block opening the workspace).
  - **Folder-first local path**: rebuilt the wizard's local-folder option per P2b's now-accepted
    `{source_type:"local", source_location:<raw path>}` creation body. A plain path input is now
    the primary, always-available flow ("a runner is only needed once execution starts…" helper
    text) — the old "No local runner is online" wall is gone entirely. The existing
    runner-pairing/browse/validate flow is kept as a collapsed `<details>` enhancement, shown only
    when an eligible runner is online, unchanged in its own mechanics (still used by the
    runner-verified test paths). A stale-`useCallback`-dependency bug (found while debugging the
    new path flow — `create()`'s deps array wasn't updated for two pieces of new state) was
    causing silent no-op submits; fixed and now covered by a passing test.
  - Tests: 3 new files (`Gantt.test.tsx` — 7 unit tests incl. no-signal/empty-phases degradation,
    ordinal Today placement, blocked-vs-upcoming-vs-passed gates, mini variant, agent-count
    chip's real-vs-unknown states; `App.gantt.test.tsx` — mini+full Gantt wired into a real
    workspace render with a genuine blocked-decision gate and real per-phase agent count;
    `Projects.reviewer-selector.test.tsx` — PATCH/DELETE/failure-is-non-blocking) plus rewrote one
    existing onboarding test (the removed "no runner" wall) into two (plain-path creation +
    runner-enhancement-still-offered) and updated the Tracking interval test for the
    now-open-by-default section. Verification: biome clean, `tsc --noEmit` clean, full
    `@norns/web` suite green (99 passed, up from 87 — zero regressions), `pnpm run build` clean.
  - **Not independently visually verified in a browser**: the sandbox's preview tool starts the
    dev server against a fixed session root, not this worktree's checkout, so a live render would
    have shown stale (pre-this-branch) code — confirmed via `preview_list`'s reported `cwd`.
    Reported rather than presented as verified; the RTL suite (real fetch mocking, exact DOM/CSS
    assertions incl. computed `--today` custom-property values and bar-fill widths) is the
    verification basis instead.
- [x] FD-P1c — ✅ **One canonical planning path — closed a live-browser-verification gap**: a
  freshly created draft project's workspace still showed the *legacy* "01 · Live planning" box
  (`runPlanning` → `POST ${base}/plan` → `commitPlan` → `POST ${base}/plan/load`), meaning a
  project's very first plan bypassed everything FD-P1/P1b built (per-project reviewer, rounds,
  attachments, an observable transcript, the strategy bridge) — found via live browser
  verification, not the test suite. Deleted the legacy box's JSX and its backing state/functions
  (`runPlanning`, `commitPlan`, `retryCommit`, `planObjective`/`planLoading`/`planResult`/
  `planError`/`committing`/`commitError`, `committingRef`, `lastCommitPlanRef`, App.tsx's own
  `PlanReviewResult` type, the `PlanReview`/`PlanLike` import) — zero remaining UI caller of
  `${base}/plan`. The existing next-phase durable-planning-run form (built in P1b to replace the
  *other* legacy "Create the next phase" text box) is now the sole entry point for planning a
  project's first phase too — it doesn't care whether `resume.phases.length` is 0 or N, so no new
  branch was needed, just upgraded it to parity with the wizard's attach-and-launch step
  (added a rounds stepper and the real `AttachmentInput`, neither of which the P1b version had),
  and labeled it "Draft the plan" vs. "Draft the next phase" depending on phase count. Also added
  a planning-cost display to the planning-run-status card (`result.total_cost_usd` — computed by
  P2 but never rendered anywhere until now). `PlanReview.tsx` is kept (not deleted) — its 3
  component tests (`PlanReview.accordion/acceptance/status.test.tsx`) still exercise it directly;
  it has no remaining caller from `App.tsx` and is noted as dead code there. Rewrote the two tests
  that exercised the deleted box (`App.ui2-failed-load-loses-edits`, `App.ui3-plan-result-metadata`)
  to verify the same properties against the new flow instead of deleting them: UI-2's "a rejected
  mutation must not discard the human's edits" now covers a rejected `strategy/approve` leaving
  the staffing edit and the StrategyReview screen in place; UI-3's "convergence/rounds/cost/
  outstanding-findings must reach the human" now covers the planning-run-status card (status,
  rounds, the newly-added cost line) plus the materialized StrategyReview screen's outstanding
  findings and rounds banner for a `cap_reached` run. Verification: biome clean, `tsc --noEmit`
  clean, full `@norns/web` suite green (99 passed — same count, two files rewritten in place, zero
  regressions), `pnpm run build` clean.
- [x] FD-P1d — ✅ **Workspace shell layout — closed a second live-browser-verification gap**:
  live screenshot evidence showed the workspace still rendered the React Flow canvas as the
  dominant panel with everything else crammed into a narrow right sidebar (the human's original
  #1 complaint) — the tab reorg from the approved mockup had never actually been built, only
  deferred with a note in FD-P1's report. Restructured the shell only, per the constraint "move
  JSX, don't rewrite logic": no state, effect, or handler changed — every section is the exact
  same component/JSX it was, regrouped under `workspaceTab` (`"overview" | "plan" | "graph"`,
  default `"overview"`) instead of always-visible-in-a-sidebar. New top-width page: a header
  (project name, status badge, coordinator/reviewer chips — small presentation upgrade from the
  old "Claude Sonnet 5 PM · anthropic · openai REVIEW" text line, matching the mockup's explicit
  "coordinator/reviewer chips" ask) and an **Overview | Plan | Graph | Debates | Settings** tab
  bar. Overview (default): Project Resume (stat-strip, architecture, mini-Gantt, phase rows,
  monitored-phase live view, needs-you panel) + Tracking (full Gantt, interval control) — plus a
  new small honest-empty-state pointer ("No plan yet — Draft the plan →") for a phases.length===0
  project, linking to the Plan tab. Plan: the "Draft the plan"/"Draft the next phase" form
  (objective + AttachmentInput + rounds stepper + planning-run-status/transcript card) and
  StrategyReview when a strategy exists. Graph: the React Flow canvas verbatim (same props/
  handlers) plus Allocate/Approve/node-inspector, gated on `graph` exactly as before. Debates and
  Settings keep their exact pre-existing behavior (a full-page swap / the Account modal) —
  reachable from the tab row now, nothing about them changed. Also fixed three hardcoded dark
  hexes in the touched CSS (`.graph-canvas`, `.project-tabs`, `.project-tab` backgrounds) that
  never worked correctly in light mode, and removed the light-theme/mobile overrides for the
  now-deleted `.graph-shell`/`.sidebar` classes. Tests: updated 9 existing test files to click the
  now-relevant tab before reaching graph/plan content they already covered (a pure test-harness
  change, no coverage lost), plus one label-text update (the new chip wording); added
  `App.workspace-tabs.test.tsx` (4 new tests: Overview-is-default with no graph canvas mounted,
  Graph tab reveals the canvas with full functionality, the empty-state pointer navigates to Plan,
  Debates' full-page swap still works from the tab row). Verification: biome clean, `tsc --noEmit`
  clean, full `@norns/web` suite green (103 passed, up from 99, zero regressions), `pnpm run build`
  clean. Not independently visually verified in a browser (same sandboxed-preview-tool cwd
  constraint noted in FD-P1b); the RTL suite is the verification basis instead.
- [x] FD-P3 — ✅ **Strategy bridge (planning run → relational phase/strategy)** built + verified on `frontdoor/integration`+P3. New `apps/server/src/projects/strategyBridgeService.ts` consumes a converged/cap_reached planning run and, through the EXISTING phase-3 workflow services (no parallel lifecycle), creates a phase + proposed StrategyVersion (objectives/tasks/assignment-proposals mapped from plan modules + staffing_proposal), resolves/creates AgentProfiles per provider/model pair, edits staffing (superseding version, staleness-respecting), and approves via the existing materialization path. Routes in server.ts "FRONT DOOR P3" section: `POST .../phases` ({planning_run_id}), `GET/PATCH .../phases/:phaseId/strategy[/staffing]`, `POST .../strategy/approve`. Idempotent per run via a new `phases.planning_run_id` link (migration 0013, partial unique index). Zero contract changes. Fixed a latent bug in `strategyWorkflowService.approve` (task_dependencies INSERT referenced non-existent predecessor/successor_phase_id columns; never hit because no prior test materialized task deps). Tests: `apps/server/test/frontDoorStrategyBridge.test.ts` (9 — full lifecycle, idempotency, cap_reached findings, post-approval staleness, authz). Full server suite green (474 passed).
- [x] FD-P5 — ✅ **Tracking read models (per-phase progress, ETA, burn rate, project aggregate, update-interval setting)** built + verified on the P5 worktree. `ProjectResumeService.open` (resume payload) and `AttentionService.phase` (phase-scoped execution read model) now compute, per phase: `percent_complete`/`tasks_completed`/`tasks_total` (task-weighted, 0 on the empty-phase division-by-zero guard), `eta_at` (linear projection from a 5-sample rolling window of recent task completions — null whenever there's no signal: phase not executing, <2 completions, or a degenerate zero time span, never fabricated), and `burn_rate_usd_per_hour` (cost/hour over recently finished runs, null with no signal or non-positive elapsed time). Resume payload also carries a project-level `progress` aggregate (`overall_percent_complete` task-weighted across non-cancelled phases, `blended_eta_at` = latest executing-phase ETA, `agents_active`/`decisions_waiting` reusing the existing attention/active-run queries — no parallel system) and `update_interval_seconds` (60|300|900, default 300, migration `0014_frontdoor_progress_tracking`), settable via new session-authed `PATCH /api/v2/projects/:id/settings` in server.ts's "FRONT DOOR P5" section, with a server-side floor independent of the allowed-value check. The new fields are additive to `@norns/contracts`' `.strict()` V2ProjectResume/V2PhaseExecution (owned by P3) — validated locally in `projectResumeService.ts` and merged onto the contract-validated base object rather than widening `packages/contracts`, which is outside this phase's ownership (flagged as a deviation for the integration owner). Tests: new `apps/server/test/frontDoorProgressTracking.test.ts` (33 — pure percent/ETA/burn-rate math incl. every no-signal/division-by-zero guard, mixed-phase-state aggregate, settings validation + persistence round-trip, resume/phase-execution payload shape, PATCH route authz/validation/persistence); `v2PreservationSchema.test.ts` updated for the new migration. Full server suite green (507 passed, 8 skipped).

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

- [x] NORN-040 — **UI feedback document** for a dedicated design/frontend pass → [docs/UI-FEEDBACK.md](docs/UI-FEEDBACK.md). Evidence-based audit (22 unique hardcoded hex colors/0 shared, 71 inline style objects, no design system, no responsive layout, Login's visual identity doesn't carry through the rest of the app, QC review doesn't scale past a few modules, node inspector dumps raw JSON, Dashboard shows the unrelated demo project not the open one) plus hard constraints (what must not regress), screen-by-screen notes, suggested priority order, and the full API surface

## Backlog (post-MVP)
- [ ] NORN-016 — Prompt library (REVIEW-002 P2-6)
- [ ] NORN-017 — Transcript search across all agents (P2-7)
- [ ] NORN-018 — Automatic Project Memory extraction from transcripts

## ONBOARDING O4 — Actions-hosted execution (risk centre)

- [x] O4-1 — `.github/workflows/norns-agent.yml` template asset + idempotent
  install/upgrade via the Contents API (never clobbers unmanaged files)
- [x] O4-2 — workflow_dispatch, run status/conclusion, and job-log reads; the
  Phase 4 coordinator can launch an Actions-hosted runner (gate extended, not
  weakened)
- [x] O4-3 — runner enrollment credential as a repository Actions secret
  (libsodium sealed box), single-use per dispatched job, rotatable, hash-only
  at rest; blast radius documented
- [x] O4-4 — pushes use the job's own `GITHUB_TOKEN`; no Norns token broker
- [x] O4-5 — remediated `installationToken()` scoping, expiry caching, and the
  inert `binding_ready` flag in `apps/server/src/integrations/github.ts`
- [x] O4-6 — **E14**: added `workflows: write`, `actions: write`,
  `secrets: write` to the GitHub App manifest (human approved). Existing
  installations still need re-authorization by their owner — documented in
  docs/runbooks/GITHUB-CONNECTIONS.md ("Upgrading an existing App"). Also gave
  the token-mint 422 caused by a not-yet-upgraded installation its own
  identifiable code, `github_app_permission_missing`, narrowly scoped to
  `installationToken()` — a deliberately narrow exception to the known
  "GitHub errors collapse into one generic code" limitation flagged (not
  fixed) in `apps/server/src/projects/githubRemoteRepositoryPort.ts`
- [x] O4-7 — migration numbered 0017 at integration; stale unassigned-number
  headers removed from 0016 and 0017
- [ ] O4-8 — publish `@norns/runner` to a registry the Actions job can install
  from (the workflow's install step assumes an installable spec)
- [ ] O4-9 — GitHub projects never reach `repository_bindings.status =
  'connected'` (project creation writes only an unverified candidate; nothing
  calls `POST /api/v2/projects/:id/source-bindings/github`), so the Phase 4
  gate refuses every GitHub project. Found, not owned by O4; blocks end-to-end

### Adversarial review remediation (all closed)

- [x] O4-R1 — BLOCKER: `${{ inputs.* }}` interpolated inside the workflow's
  `run:` block allowed shell injection and enrollment-secret exfiltration by
  anyone with repository write. Fixed with env indirection
- [x] O4-R2 — BLOCKER: the template set no `NORNS_APPROVED_ROOTS_JSON`, so the
  ephemeral runner's approved-root allowlist was empty and it could never
  execute anything. Fixed, with real-runner-path regression coverage
- [x] O4-R3 — BLOCKER: nothing in production created a
  `github_actions_execution_bindings` row. Now self-provisioned from the
  project's own primary GitHub binding
- [x] O4-R4 — org `administration: write` token is no longer cached
- [x] O4-R5 — enrollment TOCTOU: `markDispatched` commits before correlation
- [x] O4-R6 — enrollment secret rotates on every launch; timing-safe compare
- [x] O4-R7 — run correlation uses an exact delimited marker
- [x] O4-R8 — global `afterEach` closes every PGlite the harness opens
- [x] O4-R9 — migration 0017 grants `norns_app` SELECT/INSERT/UPDATE on both
  new tables (production-only failure; now covered by a `SET ROLE` test)
- [ ] O4-10 — pin `actions/checkout` and `actions/setup-node` by commit SHA in
  the workflow template (currently floating major tags)

## EXECUTION E3 — runner distribution, model credentials, context auth

- [x] E3-1 — the runner is installed from a version-pinned, sha256-verified
  tarball served by the Norns server (`/install/runner/:version/…`), not from
  npm; workflow template v2 → v3 so every already-broken installed file is
  upgraded in place. Closes O4-8 with the decided design (do NOT publish)
- [x] E3-2 — `assertSafeToken` grammar for the runner spec is NARROWER than the
  npm-spec pattern it replaced: `<semver>@sha256:<64 lower hex>` only
- [x] E3-3 — additive relay contract for proxied model inference
  (`inference_request` / `inference_response` frames, `model_proxy` capability,
  contracts 1.3.0 → 1.4.0); no existing frame changes meaning
- [x] E3-4 — server-side inference proxy: authorizes against
  `agent_runs.runner_id`, the dispatched `commands.runner_generation`, and
  `runner_revocations`; calls providers through the EXISTING
  `AnthropicAdapter`/`OpenAiAdapter`; deployment allowlist fails closed
- [x] E3-5 — hard budget enforcement before the provider call, against the
  run's own `budget_reservations` row; typed `budget_exhausted` refusal
- [x] E3-6 — real metering: first-ever writer of the `usage_events` table, and
  the same rows are read back as the run's settled spend
- [x] E3-7 — `SignedUrlContentFetcher` replaced by `RunnerSignedContextFetcher`
  at the single construction site shared by the laptop AND ephemeral paths
  (E1 handoff — every task-context fetch previously 401'd)
- [x] E3-8 — `proxied-completion` runtime registered in the runner CLI: the
  only runtime that works with no provider credentials in the process env
- [ ] E3-9 — **HUMAN/PM**: `claude-code` and `codex` CANNOT be served by this
  proxy. Both SDKs accept a base-URL override, but only to an endpoint speaking
  the provider's own HTTP API (Anthropic Messages / OpenAI Responses, both
  streaming), which `LlmAdapter` cannot serve. Decide: repo secrets for those
  runtimes, a provider-native gateway, or agentic runtimes stay laptop-only
- [ ] E3-10 — **PM ROUTING**: pass `runnerInference: { transactions }` from
  `main.ts` (E2's file this phase) instead of the proxy reaching for whichever
  relational option happens to be present in `buildServer`
- [ ] E3-11 — **PM ROUTING**: `agent_profiles.runtime` must be able to name
  `proxied-completion` for Actions-hosted work, or the coordinator will keep
  dispatching a runtime the job has no credentials for
- [ ] E3-12 — proxied inference is complete-response only; streaming needs a
  streaming method on `LlmAdapter` first (additive on both sides when wanted)

## EXECUTION E4 — runner publication + honest verification

- [x] ✅ E4-1 — publish the run's work before cleanup: `GitPublisher` pushes
  `target_branch` to `origin` and opens/reuses its pull request, using the
  ambient Actions `GITHUB_TOKEN` exactly as `pushCredentialProvider.ts` says
- [x] ✅ E4-2 — tautological verification replaced: `CommandPolicyVerifier` now
  runs real commands and reports their true exit status, and enforces the
  exact commit against the repository instead of against a copy of itself
- [x] ✅ E4-3 — regression test that the old tautology cannot return
- [x] ✅ E4-4 — redelivery bug found by the new real-git test: `git switch -c`
  failed on a redelivered command because `worktree remove` leaves the branch
  ref behind; now `-C`, with a leased force-update converging the remote
- [ ] 🟡 E4-5 — **PM ROUTING**: the runner still cannot see the project's REAL
  build/test/lint commands. They live server-side as `project_memory_entries`
  prose and E1 renders them into the PROMPT only; the dispatch command carries
  just `verification_policy_ref`. The runner therefore reads a committed
  `.norns/verification.json` at the exact commit, or fails closed. The clean
  fix is a structured `verification_commands` field on `V2DispatchCommand`
  populated by `phase4Coordinator` (E2's file) — routing needed
- [ ] 🟡 E4-6 — **PM ROUTING**: `strategyBridgeService.ts:853` hardcodes
  `verification_policy_ref: "verification"`, which is not a key in the runner's
  default policy map (`verification-policy:default-v1`). Three vocabularies are
  in use across the codebase; they need reconciling
- [ ] 🟡 E4-7 — **PM ROUTING**: `phase4EventProcessor.ts:284` still writes
  `command_results` as a hardcoded `'[]'::jsonb`. The runner now produces real
  per-command results; the event contract has nowhere to carry them
  (`verification_result` has only `output_digest`). Needs an additive contract
  field plus ingestion in `coordinator/**` — both outside E4's lane
- [ ] 🟡 E4-8 — **PM ROUTING**: no event, column, or contract field carries the
  published branch or pull-request URL, so the UI cannot link a run to its PR.
  E4 streams it as `run_log` text; a durable field belongs on `agent_runs`

## EXECUTION E9 — provider-native streaming gateway

Closes E3-9 with the human's decision: a forwarder, not a reimplementation.
`claude-code` and `codex` now run with NO provider credentials in the process.

- [x] E9-1 — Anthropic-compatible endpoint. `ANTHROPIC_BASE_URL =
  <origin>/api/gateway/anthropic`; Claude Code issues `POST .../v1/messages`
  (streaming AND non-streaming — both observed in one real turn),
  `/v1/messages/count_tokens`, `/v1/models`, and a `HEAD` probe on the base URL
- [x] E9-2 — OpenAI-compatible endpoint. Codex's `baseUrl =
  <origin>/api/gateway/openai/v1` and it issues `POST .../responses`, verified
  by reading `@openai/codex-sdk` 0.144.3 (`--config openai_base_url`,
  `CODEX_API_KEY`) and the bundled binary, not by guessing
- [x] E9-3 — per-run gateway credential: 32 bytes CSPRNG, stored only as
  sha-256, 90-minute TTL, revocable, generation-fenced, resolved through E3's
  `SqlProxiedRunLookup` + the extracted `authorizeProxiedRunAccess` on EVERY
  request. A client-supplied model key is stripped, never honoured
- [x] E9-4 — usage metered from the stream for both providers and written by
  E3's `SqlInferenceMeter`; a provider-killed stream and a client that
  disconnects mid-stream both still meter
- [x] E9-5 — budget refused before forwarding via E3's
  `SqlRunReservationBudget`; post-hoc reconciliation settles the TRUE cost even
  when it exceeds the hold, so an over-run is self-correcting on the next call
- [x] E9-6 — the runner mints per-run and points both agentic runtimes at the
  gateway, stripping every provider key from the child environment first
- [x] E9-7 — **BUG FIXED**: E1's server verifier and E3's runner client
  disagreed on the context-fetch signing scheme (`x-norns-runner-timestamp` vs
  `x-norns-timestamp`; `\n`-joined vs `|`-joined payload). Every real context
  fetch 401'd, so every dispatched run started with an empty prompt. No test
  caught it because the only test drove a fake server implementing the
  runner's spelling on both sides. Runner side fixed; the two canonical-payload
  functions are now asserted byte-identical
- [x] E9-8 — **BUG FIXED, found by the real-runtime test**: the gateway rebuilt
  the upstream URL from the path alone, silently dropping the query string.
  Claude Code really sends `?beta=true`
- [x] ✅ E9-9 — **CLOSED BY E10**: the coordinator now resolves a real runtime
  name. `StrategyBridgeService` wrote `agent_profiles.runtime = <provider>`
  (`anthropic`/`openai`), which is not a key in the runner's runtime map at
  all, so every task staffed through the normal planning path died with
  "runtime anthropic is unavailable" before doing any work. Fixed at the source
  and defensively at dispatch (`resolveDispatchRuntime`), mapping to
  `claude-code`/`codex` — credential-free since E9, so correct for Actions and
  laptop alike
- [x] ✅ E9-10 — **CLOSED BY E10**: `ServerOptions.runnerInference:
  { transactions }` added and wired from `main.ts`, with a boot-shape test that
  mounts the gateway credential route from that option ALONE. The old
  `planningRuns ?? onboarding ?? attachments` chain is retained below it purely
  for compatibility with existing callers
- [ ] E9-11 — the model allowlist is keyed on the RESOLVED model id in the
  request body. An operator who sets `NORNS_RUNNER_ALLOWED_MODELS` to an alias
  (`claude-sonnet-4-5`) rather than the registry id will see every call refused
  `model_unavailable`. Worth a startup warning
- [ ] E9-12 — a request whose stream dies before ANY usage appears is released,
  not charged. On Anthropic that window is one event wide; on OpenAI Responses
  usage only arrives at the end, so a long OpenAI stream killed near completion
  currently costs the run nothing. Audited as `gateway.unmetered` so it is
  measurable; closing it needs a provider-side usage signal we do not have
- [ ] E9-13 — no purge job calls `GatewayCredentialService.purgeExpired()`.
  Expired rows are inert (every request re-checks expiry) but accumulate
- [ ] E9-14 — **DESIGN WEAKENING WORTH A DECISION**. E3's
  `SqlRunReservationBudget` keeps in-flight holds in process MEMORY, and E3
  argued that is sound because a runner's frames arrive on exactly one relay
  socket on exactly one process. The gateway breaks that premise: it is plain
  HTTP, so behind a load balancer one run's concurrent model calls can land on
  different server instances, and those instances will not see each other's
  holds. Only the DURABLE settled figure (`usage_events`) bounds them, and that
  figure lags by one call. Single-instance deployments (the current shape) are
  unaffected. Fixing it means a durable hold row, not a memory map
- [ ] E9-15 — an OpenAI Responses request that declares no `max_output_tokens`
  is held against the proxy's 32k ceiling but forwarded verbatim, so the
  provider is free to exceed it. The overshoot is bounded by the model's own
  output cap, not by ours. Requiring the field would stop being a forwarder;
  the alternative is a per-model output cap in the registry

## EXECUTION E10 — joining the pipeline up

- [x] ✅ E10-1 (E4-5) — the project's real build/test/lint commands now reach the
  runner structurally: `V2DispatchCommand.verification_commands`, populated by
  `Phase4Coordinator` from the ingested `repository_fact` project memory. Takes
  precedence at the runner over the committed `.norns/verification.json`, which
  stays as the fallback; neither present still FAILS CLOSED
- [x] ✅ E10-2 — one policy-ref vocabulary. `verification-policy:default-v1`
  (`V2_DEFAULT_VERIFICATION_POLICY_REF`) kept because it is the only spelling
  the runner's default policy map can resolve; `strategyBridgeService`'s bare
  `"verification"` replaced
- [x] ✅ E10-3 — `phase4EventProcessor` no longer writes `'[]'::jsonb` for
  `command_results`; real per-command results are persisted and surfaced in
  `AttentionService.phase()` and in the workspace, naming the failing command
  and showing its output
- [x] ✅ E10-4 — branch + pull request persisted on `agent_runs` from a new
  `run_published` event and exposed in `AttentionService.phase()` and the
  resume payload; the task card links straight to the review
- [x] ✅ E10-5 (E9-9) — dispatch a real agentic runtime instead of a provider name
- [x] ✅ E10-6 (E9-10) — `runnerInference` named and wired from `main.ts`
- [ ] 🔴 E10-7 — **RUNNER-SIDE, ROUTED TO THE PM**: `apps/runner` must (a) prefer
  `command.verification_commands` over the committed manifest in
  `CommandPolicyVerifier`, (b) put `verification.command_results` on the
  `verification_result` event, and (c) emit the new `run_published` event from
  the publication block in `v2Execution.ts`. The server side of all three is
  merged and tested; until the runner emits them the columns stay null and the
  UI shows nothing. E10 was forbidden from touching `apps/runner/**`
- [ ] 🟡 E10-8 — a verification fact recorded with shell syntax (`pnpm build &&
  pnpm test`) is DROPPED rather than executed, and the drop is reported on
  `Phase4ScheduledRun.rejected_verification_commands` but nothing surfaces it to
  a human yet
- [ ] 🟡 E10-9 — `projectImportPlan` still mints
  `policy:legacy-verification:<id>` refs, which no runner resolves. Harmless now
  that commands travel on the dispatch command, but it is a third vocabulary
- [ ] 🟡 E10-10 — `verification_results.command_results` is persisted in the
  RUNNER's shape (inline `output`), not `V2VerificationCommandResult` from the
  evidence contract (artifact-backed `output_artifact`). Nothing reads the
  contract shape today; reconciling needs an artifact store on this path

## EXECUTION E11 — real control over a live coding run

- [x] ✅ E11-1 — controls now reach the in-flight V2 execution. New
  `LiveRunRegistry` (`apps/runner/src/liveRuns.ts`) owns each live run's
  `AbortController`; `V2RunnerExecutor` registers for the whole run and finally
  passes `runtime.run()` the `AbortSignal` every adapter already accepted and
  none had ever been handed. `daemon.ts` routes `cancel`/`interrupt`/`suspend`/
  `resume_session`/`stop_after_current`/`send_message` through `routeControl`,
  which asks the live registry first and falls back to the Phase 1A fixture only
  for run ids it has never seen
- [x] ✅ E11-2 — `send_message` delivered. `RuntimeSession` is published by a
  runtime only when its SDK really supports mid-turn input; the capability
  matrix gained `send_message`, verified per SDK (claude-code yes — now runs in
  streaming-input mode, which is also the only mode where the `interrupt()` it
  already advertised works; codex no; proxied-completion no; process yes, via
  the child's stdin). A message to an ended run is rejected with
  "already ended (<outcome>)" and streamed as a run log
- [x] ✅ E11-3 — publish-on-cancel. A cancelled run publishes the commits made
  before the human stopped it, marked UNVERIFIED, and stays `cancelled` even if
  publication fails
- [x] ✅ E11-4 — ack-ordering bug found by the new tests: the daemon acked
  `executing` before deciding, and `COMMAND_TRANSITIONS` has no
  `executing -> rejected` edge, so EVERY rejection was silently dropped by the
  server and the command sat in `executing` until it expired. Refusals now ack
  from `accepted`
- [x] ✅ E11-5 — resumability design note
  (`docs/phases/EXECUTION-E11-resumability.md`) plus the self-contained runner
  half: the runtime `session_id` is captured at every exit and emitted as a run
  log, and `RunnerRuntimeContext.resumeSessionId` is the seam a resuming
  dispatch will use
- [ ] 🟡 E11-6 — **PM ROUTING**: no contract field, event payload, or column
  carries a runtime session id, so resume state cannot be stored. Needs an
  additive `session_id` on `V2DispatchCommand` (in) and somewhere durable (out)
- [ ] 🟡 E11-7 — **PM ROUTING**: there is no ask-shaped run status. `RunStatus`
  has no way to say "the agent is blocked on a human", so the coordinator cannot
  distinguish an ask from a crash and `onRunSettled` retries it instead of
  prompting anyone
- [ ] 🟡 E11-8 — **PM ROUTING**: resume state must be keyed to the task, never
  the runner — an ephemeral Actions runner enrolls a new runner id and
  generation per job, so anything keyed to the runner is unreachable by the job
  that needs it
- [ ] 🟡 E11-9 — **UNVERIFIED CLAIM to settle before promising resume**: a
  session id is a pointer into provider-side or local state. On an ephemeral
  runner the Claude Code transcript and Codex thread state die with the job, so
  the id alone may resume nothing there. Needs a real cross-machine experiment
  per provider
- [ ] 🟡 E11-10 — **E9 SEAM**: the runtime factory map in `apps/runner/src/cli.ts`
  (E9's lane) must pass `context.resumeSessionId` into
  `ClaudeCodeRuntime({resumeSessionId})` / `CodexRuntime({resumeThreadId})` once
  E11-6 lands. Both adapters have accepted it since they were written; nothing
  has ever set it
- [x] ✅ E11-11 — **CLOSED (routed from E10)**: the runner now prefers the
  dispatch command's `verification_commands` over BOTH the local policy map and
  the committed manifest, attaches `command_results` to `verification_result`,
  and emits `run_published` — on the cancel path as well as the success path,
  because cancelled work still needs reviewing. The three E10 columns are no
  longer null in production
- [ ] 🟡 E11-12 — **PM ROUTING (lossy, low priority)**: `PublicationOutcomeKind`
  on the wire is `pushed | local_only`, while the runner distinguishes `pushed`,
  `already_published` and `republished`. The latter two collapse to `pushed`
  because all three mean "the commits are on the remote at this commit"; the
  finer fact survives only in the run log. Widening the enum is additive if the
  UI ever wants to say "a redelivery converged"
- [ ] 🟡 E11-13 — **DECISION RECORDED, worth confirming**: dispatch-supplied
  verification commands now outrank the operator's local
  `NORNS_VERIFICATION_POLICIES_JSON` map, not just the committed manifest. E10's
  contract comment only claimed precedence over the manifest, but a map-first
  order makes the field inert for every deployment that leaves the variable
  unset (the default map still resolves `verification-policy:default-v1`), so
  the project's real tests would be silently replaced by the whitespace lint.
  Safe because the vectors reach `execFile` with `shell: false` and the server
  refuses shell metacharacters — but it IS a widening of what the server can
  cause a runner to execute, and the PM should confirm it

## EXECUTION E5 — per-dispatch runner identity (concurrent Actions-hosted dispatch fencing)

- [x] ✅ E5 — fixed: `actionsRunnerId(projectId)` was ONE runner identity shared
  by every GitHub Actions dispatch in a project. `RelayStores.
  reserveRunnerGeneration` bumps a single generation counter keyed by that
  identity, so scheduling a second concurrent dispatch reserved a new
  generation for the FIRST dispatch's own identity too, fencing a still-running
  job off its own relay connection — unconditionally, even when the second
  dispatch's own request was itself later refused by the concurrency cap.
  New `actionsDispatchRunnerId(projectId, nonce)`
  (`apps/server/src/coordinator/actionsExecution.ts`) mints a fresh identity
  per dispatch (never reused, never shared, not even across dispatches in the
  same project), so two dispatches now hold disjoint `RelayStores` records —
  disjoint generation, disjoint relay socket slot — and nothing about
  scheduling one can fence the other. `github_actions_execution_bindings.
  runner_id` is untouched (it was never gate-checked for `binding_type=
  'github'` rows and remains a per-project provisioning placeholder);
  enrollment now resolves the binding through a new `ActionsExecutionRepository
  .bindingForDispatch(dispatchJobId, runnerId)`, joined through
  `github_actions_runs` (which already records the per-dispatch id at schedule
  time). New migration `NNNN_actions_dispatch_runner_identity.sql` (number
  unassigned, PM assigns at integration) adds
  `github_actions_runs_runner_id_unique_idx`, the real successor to 0017's
  binding-level uniqueness. The project concurrency cap
  (`projects.max_concurrent_tasks`, defaulting to 1 — REFOUNDATION-PROGRAM.md's
  "one executing phase per project by default") already existed inside
  `Phase4Coordinator.schedule()` and needed no new mechanism; it is now
  reachable without a wasted/harmful generation reservation racing ahead of it.
  Every fencing/authorization property audited and preserved: a stale/
  superseded generation is still fenced on its very next frame (no
  reconnection needed — matches how the real bug manifested); `authorize
  ProxiedRunAccess`/`SqlProxiedRunLookup` (E3) and the gateway (E9) both
  resolve run ownership through `agent_runs.runner_id` + `commands.
  runner_generation`, string-comparison based and untouched, and now MORE
  precise since two dispatches never share an identity; revocation
  (`/api/admin/runners/:id/revoke`) still cuts a runner off immediately, with
  no restart; laptop-runner pairing (`repository_bindings.runner_id` for
  `local_runner` bindings, `/api/pairing/*`) is completely separate code and
  unchanged. Verified the regression suite actually catches the bug: reverting
  to the old shared identity trips the new unique index immediately and fails
  5 of its 6 new end-to-end tests. Tests use the REAL relay (real WebSocket,
  real Ed25519 challenge/response via `@norns/runner`'s `RunnerDaemon`, real
  pglite Postgres, real GitHub-Actions-secret sealing/unsealing) — no mocked
  fencing logic. Suites green: server 797 (+7 over the 790-test integration
  baseline), biome/tsc --noEmit/build all clean.
## EXECUTION E13 — live cost + live activity while a run is executing

- [x] ✅ E13-1 — live cost. `AttentionService.phase()` and
  `ProjectResumeService.open()` now surface real spend from `usage_events`
  (E9's gateway / E3's proxy — the only writers that table has ever had),
  scoped per task (via the task's designated run) and per phase (summed
  across the phase), alongside the real budget: `budget_reservations.amount_usd`
  for a task's run, `phases.approved_budget_usd` for the phase. Honesty rule
  enforced structurally: a run/phase with zero matching `usage_events` rows
  reports `spend_usd: null` (Postgres's own `SUM` of an empty set), never a
  coalesced `0` that would read as "confirmed free"; a task's `budget_usd` is
  `null` when no reservation exists yet (not scheduled), distinct from a real
  $0 reservation. `V2PhaseProgress` (owned by `projectResumeService.ts`) grew
  the two fields so both read models share one shape.
- [x] ✅ E13-2 — live activity. New `AttentionService.runLog()` tails
  `run_log` events out of `runner_events` (previously write-only — recorded
  by `Phase4EventProcessor` since day one, never read back anywhere a human
  could see them) for a task's designated run, in two modes: an initial TAIL
  (most recent `RUN_LOG_PAGE_LIMIT`=200 entries) and an `after`-cursor mode
  for incremental polling. Bounded server-side (page limit + 20k-char/entry
  cap) and again client-side (`RunLog.tsx`: 500 entries / 100k chars kept in
  the DOM), with `truncated`/a client-side "older output not shown" note
  whenever either bound drops something — never silently.
- [x] ✅ E13-3 — polling cadence decision: phase-execution polling (which was
  hardcoded to 5s unconditionally, silently ignoring the human's configured
  `update_interval_seconds` even when idle) now polls fast (5s, fixed) ONLY
  while some task in the monitored phase has an active run, and otherwise
  honors the configured interval. `RunLog.tsx`'s own polling follows the same
  rule at the single-task level: fast (3s) while its run is active, one final
  fetch then stops the moment it isn't.
- [x] ✅ E13-4 — one dismissible honesty note (`ui.tsx`'s new
  `DismissibleNote`, localStorage-persisted) next to the phase's cost line,
  stating the honesty rule in plain language; no other UI chrome added.
- [ ] 🟡 E13-5 — **KNOWN GAP, out of this phase's ownership**:
  `Phase4EventProcessor.apply` inserts every `runner_events` row with
  `run_id = NULL` hardcoded, even though the column exists (FK to
  `agent_runs`) and every event's payload carries the real run id. `runLog()`
  works around this by scoping on `(runner_id, runner_generation)` instead
  (the same durable dispatch fence `SqlProxiedRunLookup` already authorizes
  against) plus a `payload->>'run_id'` filter, which is correct but not
  index-backed. Populating the column would let a future read fetch a run's
  events with a real index instead of a filtered scan over one runner
  generation's events. Lives in `apps/server/src/coordinator/**`, which this
  phase does not own (E5 was active there).
- [ ] 🟡 E13-6 — not yet surfaced: the gateway's cache-token split
  (`GatewayUsageTap`'s `cache_read_input_tokens`/`cache_creation_input_tokens`)
  is billed into `usage_events.cost_usd` but the split itself is discarded
  before the row is written — a human cannot see how much of a run's spend
  was cache reads vs. fresh tokens. Additive if ever wanted: widen
  `usage_events` (out of this phase's ownership) or carry the split on the
  in-memory `UsageEventT` the gateway already computes.


## EXECUTION E12 — concurrent tasks within one phase (fan-out + conflict safety)

- [x] ✅ Made `projects.max_concurrent_tasks > 1` genuinely work. **The shipped
  default is UNCHANGED at 1** — raising it is the human's cost decision, and
  E12 recommends 2 as the first step up, not more. Four findings and four
  fixes. (1) FAN-OUT. `PhaseLaunchService.startPhase()` already looped every
  dependency-ready task, but over-cap tasks hit the coordinator's
  concurrency refusal and were reported `blocked` — a failure — and nothing
  ever retried them, so a phase with a cap of 2 and three ready tasks
  dispatched two and silently abandoned the third until a human clicked Start
  again. New `Phase4CoordinatorDeferredError` (a SUBCLASS, so every existing
  catch site and every existing message is byte-identical) separates
  temporary refusals (project cap, profile cap, repository-scope conflict)
  from real blocks; over-cap work now lands in a new `deferred` bucket. (2)
  THE MISSING CALLER, again. `startPhase` was documented as safe to call
  after each completion and nothing ever did; new `PhaseQueueDrainer` polls
  every 5s for active phases with a free slot AND a ready task. A poll, not
  an event hook, because a slot also frees on paths that emit no event
  (dead-letter, recovery expiry, restart) and a missed hook is invisible.
  (3) CONFLICT SAFETY. `apps/server/src/engine/**` is SUPERSEDED, not
  adapted: its mechanism does `git merge` in a server-side checkout, and the
  V2 relay has no repository (the code is on the user's laptop or in an
  ephemeral Actions job). Its RULE is adopted whole — nothing merges,
  anywhere, so there is no auto-resolution path to reach. New
  `run_integration_conflicts` table + `RunIntegrationConflictService` detects,
  IN THE SAME TRANSACTION as the publication that creates it, when two sibling
  runs publish unintegrated branches off the same base revision, and refuses
  `Phase4CompletionService.complete()` on either task until a named human
  records a resolution. A DB CHECK constraint makes "no silent resolution" an
  invariant: a resolved row without an actor cannot be written. (4) A SIXTH
  DEAD PATH, found by reading. `task_coordination_constraints` — which
  `Phase4Coordinator.schedule()` reads to enforce repository-scope mutual
  exclusion — has two readers and had ZERO WRITERS. That gate has never once
  fired in production; it was real code over a permanently empty table. New
  `TaskConflictScopeRepository.declare()` is the missing writer, and the
  migration adds `conflict_scope_declared` so "nothing to declare" and
  "nobody declared" stop being the same empty array — they must fail in
  opposite directions. Detection is fail-closed: undeclared scope means
  unproven disjointness means conflict. Migration
  `NNNN_phase_concurrency_conflicts.sql` (number unassigned; PM assigns at
  integration). Zero contract changes. New routes: phase `/concurrency`,
  phase `/conflicts`, `POST /api/v2/run-conflicts/:id/resolve`. Suites green:
  server 832 (+17 over the 815 integration baseline), contracts 122,
  biome / `tsc --noEmit` / `pnpm run build` all clean.

## EXECUTION pre-deploy remediation (docs/reviews/EXECUTION-PREDEPLOY.md)

Scope: exactly two items from that review. Everything else in it is a PM
decision and is deliberately untouched.

- [x] **B1 (blocker) — the packed runner tarball installed but could not
  execute.** `bundledDependencies: ["@norns/contracts"]` forced npm to nest a
  `zod@3` under `@norns/runner` (the agent SDK's `zod@4` wins the top-level
  hoist), and npm's reifier will not write inside a bundled package: it created
  `node_modules/@norns/runner/node_modules/zod` as an EMPTY DIRECTORY, so the
  CLI died on `ERR_MODULE_NOT_FOUND` before printing its own help text and every
  Actions-hosted run failed at its first command. Fixed by removing the nested
  package entirely: `pack-tarball.mjs` now inlines the compiled contracts output
  into the runner's own `dist/_contracts/` and rewrites every
  `@norns/contracts` specifier, so the tarball ships no `node_modules/` and no
  `bundledDependencies`, and `zod` is an ordinary dependency npm nests normally.
  The script fails the build if any specifier is left unrewritten.
- [x] **B1 regression guard.** New `apps/server/test/runnerTarballInstall.test.ts`
  really runs `npm install --global --prefix …` on the built tarball and
  executes the installed `norns-runner` binary — the mode
  `actionsWorkflowTemplate.ts` actually uses. Verified it FAILS on the old pack
  script ("npm left an empty zod directory at …"). Not skipped by default;
  `NORNS_SKIP_TARBALL_INSTALL_TEST=1` is an explicit offline opt-out CI does not
  set.
- [x] **W1 (CI red) — hardcoded wall-clock dispatch window.**
  `actionsDispatchConcurrency.test.ts` pinned `expires_at` to
  `2026-07-21T20:15Z`; once that passed, every dispatch acked `expired` and the
  E5 regression assertion timed out. Now time-relative. Swept the suite: two
  more dispatch fixtures (`gatewayCredentialAuth`, `runnerInferenceProxy`) had
  already-lapsed windows and were made relative too.
- [ ] 🟡 Six test fixtures still carry the literal `2026-07-21T20:15:00.000Z`
  (`executionE10`, `executionE13`, `actionsExecution`, `onboardingO2`,
  `onboardingO6` ×2). Proven inert — nothing compares them to the real clock,
  and all pass with the window lapsed — so they were left alone, but they read
  as live windows and will become bombs if a live daemon is ever wired into
  those paths.
- [ ] 🟡 `norns-runner --help` previously fell through to "`--server` is
  required" because the first argv token is parsed as the command. Fixed
  minimally (`--help`/`-h`/`help` in the command position). The wider CLI arg
  parser is still hand-rolled and positional-fragile.

## POLISH program (dispatched 2026-07-22)

- [x] ✅ P1 — Remove the local-runner install surface (Settings "Local runners"
  panel, install-runner.sh, orphaned pairing/runner routes). The user rejected
  the runner-install design outright; the panel survived the front-door rework.
- [x] ✅ P2 — Safari cache hardening: index.html must never be reused without a
  re-check; hashed /assets/* become immutable. Implemented via
  `@fastify/static`'s `setHeaders` in `apps/server/src/server.ts`'s `webDist`
  block: `index.html` (both `/` and the SPA fallback) → `cache-control:
  no-cache`; `/assets/*` (Vite content-hashed) → `public, max-age=31536000,
  immutable`; everything else static → `public, max-age=3600`. Regression
  test: `apps/server/test/webDistCacheHeaders.test.ts`. Verified against a
  real `pnpm run build` + real `apps/web/dist` with curl.
  Done: the Settings panel, install-runner.sh, `/api/pairing/*`, `GET
  /api/runners`, the workspace-picker routes, `source-bindings/local`, and
  `workspaceBroker.ts` are gone. The relay core (Actions enrollment, signed
  websocket, context fetch, inference proxy) is untouched; tests now mint
  runner identities by direct key registration. `norns-runner pair` still
  exists in the CLI but its server endpoint is gone (404) — dead front door,
  kept because the package IS what Actions installs.
- [x] ✅ P3 — "Analyze the repository" made real. (a) `next_recommended_action`
  no longer renders in the red `<Alert>`: new neutral `NextStep` label/chip in
  `ui.tsx`/`styles.css` (theme vars only, both themes); `<Alert>` stays for the
  overview's real `error` state and analyze failures — the only other renderer
  of `next_recommended_action` was `phase8Pilot.ts` (server-side text report,
  unstyled). (b) New `RepositoryAnalysisService` +
  `POST /api/v2/projects/:id/analyze-repository` (beside the ingest route):
  fetches a bounded sample of the connected GitHub repository (≤400 tree
  paths, ≤12 key files, ≤16k chars/file, ≤120k chars total) via the existing
  installation-token broker (`contents: read`, repository-scoped), has the
  deployment's Anthropic adapter (`NORNS_REPOSITORY_ANALYSIS_MODEL`, default
  claude-sonnet-5) produce a structured summary, and records it through the
  EXISTING `RepositoryIngestionService.ingest()` seed — model output adapted
  to the contract, `directives` deliberately empty (a model inference never
  enters memory auto-approved). Honest refusals: `github_not_configured`,
  `model_not_configured`, `no_repository`, `no_github_repository`,
  `project_not_found`, `analysis_unavailable`. Wired in `main.ts` with a
  buildServer suite using the production option shape. (c) Web
  `AnalyzeRepositoryControl` in the overview NextStep row: in-progress state,
  server's own error on failure, resume reload shows the recorded
  architecture.
- [x] ✅ P3 hotfix — production 400 on the Analyze button: the control sent
  `content-type: application/json` (`authHeaders(true)`) with NO body, which
  Fastify rejects ("Body cannot be empty…") before the route handler runs.
  Now `authHeaders()` (the body-less POST convention, App.tsx ~1224).
  `MockFetch` records request headers so the control test asserts the REAL
  invocation shape (no content-type, no body) — a loose fetch mock is what
  let this ship.
- [x] ✅ P3 hotfix sweep (PM lifted the scope fence) — `StartPhaseControl.tsx`
  had the IDENTICAL defect shape (POST `.../phases/:id/start` with
  `authHeaders(true)`, no body → 400 before the handler). Fixed the same
  one-line way (`authHeaders()`), and its click test now asserts the real
  fetch invocation (no content-type header, no body) via the upgraded
  MockFetch.
- [x] ✅ `Account.tsx:147` (session revoke) — was CONFIRMED broken (Fastify
  5.10.0 puts DELETE in its `bodywith` method set, fastify.js:140; runtime
  probe returned 400 `FST_ERR_CTP_EMPTY_JSON_BODY` for DELETE + JSON
  content-type + empty body via both `inject` and a real socket). PM lifted
  the Account.tsx fence; fixed the same one-line way (`authHeaders()`), with
  a revoke test asserting the real DELETE invocation shape.
- [x] ✅ Fourth instance found in the final sweep: `Account.tsx:73`
  (`integrationRequest`) deliberately forced the JSON content-type onto
  body-less DELETEs (`|| init?.method === "DELETE"`), breaking GitHub
  connection Disconnect the same way. Fixed in a SEPARABLE commit (5dc9eca)
  — one step beyond the authorized 147 fix, deliberately kept apart so the
  integrating PM can drop it — content-type now follows the body, never the
  method; disconnect test asserts the real invocation; MockFetch learned
  null-body statuses (204) because the real disconnect route replies 204.

## Phase tab program (dispatched 2026-07-22)

- [x] ✅ PHTAB-1/2/3 (PM tracking) — opened at dispatch, all delivered; see
  PT-P1 (backend, above), PHASE-TAB P2, PHTAB-3, PHTAB-P4, PHTAB-P5b entries
  in this section. P5 independent review verdict: SHIP, 0 blockers. Backlog
  items PHTAB-B1..B7 recorded in BACKLOG.md.

- [x] ✅ PHASE-TAB P2 (frontend) — new "Phase" workspace tab (opened and
  finished in the same push): goal textarea + image `AttachmentInput`;
  Agents (Claude/ChatGPT/Both → `worker_providers`) and Review rounds (1–5,
  default 2) selectors with the fixed "PM: Claude Fable · Reviewer: ChatGPT
  Sol" identity line; Start → `POST .../planning-runs` (now with
  `review_rounds` + `worker_providers`) → live progress (status/rounds/
  reviewer findings, 3s active / 15s idle poll); decision panel at
  converged/cap_reached/awaiting_decision with per-phase provider+model
  staffing dropdowns (PM_MODEL_OPTIONS filtered to the run's providers) and
  Approve (staffing payload) / Modify (direction → back through review) /
  Reject (two-step confirm); execution status table once approved (5s/15s
  cadence). ALL fetches in `apps/web/src/phaseTabApi.ts` — the integrator's
  single reconciliation point (execution-status route is a PLACEHOLDER
  there). Component in `apps/web/src/PhaseTab.tsx`; tests in
  `App.phase-tab.test.tsx` (5). Built against the contract with MockFetch;
  backend built in parallel by another agent — end-to-end against the real
  server NOT exercised here.

- [x] ✅ PHTAB-3 (integration) — merged PT-P1 (backend) + PHASE-TAB P2
  (frontend) into `phase-tab/integration` (opened and finished in the same
  push). Migration number **0025** assigned
  (`0025_phase_tab_planning_decisions.sql`, constants in `migrate.ts`,
  preservation-schema expectations updated). Frontend reconciled to the
  backend as built, all in `apps/web/src/phaseTabApi.ts` +
  `PhaseTab.tsx` + `App.phase-tab.test.tsx`: no `awaiting_decision`
  status (converged/cap_reached ARE the awaiting states); DTO gains
  `worker_providers` + `decision`; staffed phases read from
  `result.staffing_proposal.recommendations` joined to `plan.modules`
  (the frontend had guessed `result.plan.phases`); execution-status
  repointed to project-scoped `GET /api/v2/projects/:id/execution-status`;
  modify's 202 re-queued run returns the UI to live-progress polling;
  approve's `execution: null` renders a neutral not-auto-started note,
  not an error. Execution kickoff seam remains deliberately unwired
  pending a product decision.

- [x] ✅ PHTAB-P4 — approve auto-starts execution (opened and finished in
  this worktree): real `ApprovedPlanExecutionKickoff`
  (`apps/server/src/planning/executionKickoff.ts`) driving
  StrategyBridgeService (materialize — the bridge now also accepts
  `approved` runs since the decision is recorded first; staffing overrides
  via editStaffing; approve attributed to the deciding user with the
  decision's decided_at as approved_at and the run id in the idempotency
  key) then `PhaseLaunchService.startPhase` through the real coordinator
  gate. Refuses honestly (`{started:false, detail}`) when a phase is
  already executing (one-executing-phase-per-project default, checked
  before any mutation), on unknown-node staffing overrides, and on every
  other failure — the recorded planning-run approval is never rolled back.
  Wired in `main.ts` (`planningRuns.executionKickoff`, PhaseLaunchService
  constructed exactly like buildServer's start-phase path); decision route
  resolves the session user (`decidedBy` — approvals.actor_id is FK-bound
  to users). Tests: `apps/server/test/planningExecutionKickoff.test.ts`
  (7: e2e approve→phase active + dispatch, overrides applied, active-phase
  refusal, unknown-node refusal, production-shape boot ×3);
  `App.phase-tab.test.tsx` +1 — PhaseTab renders the kickoff success
  detail when `started: true`. Server 868 passed / 12 skipped; web 133;
  tsc + biome + build clean.

- [x] ✅ PHTAB-P5b — review-fix pass on the Phase tab feature (opened and
  finished in this worktree): (1) decision-route audit entries
  (`planning_run.decision.*`, `planning_run.execution_kickoff`,
  `planning_run.dispatch_failed`) attributed to the resolved session user
  instead of the "operator" literal — sibling routes' legacy actor left
  alone; (2) approve staffing overrides now enforced against the run's own
  `worker_providers` constraint (422 `invalid_staffing`, message phrased
  like allocationRecommendation's `provider_constraint` refusal), with an
  HTTP test proving the refused run stays decidable; (3) dead
  `ApprovedPlanExecutionKickoffInput.plan` field removed (the kickoff
  re-loads the run itself); (4) `assignmentLocalId()` exported from
  strategyBridgeService and shared by executionKickoff instead of a
  re-derived `assignment-${node_id}`.

## DESIGN program — visual/UX overhaul (dispatched 2026-07-27)

- [x] ✅ DES-P1 — Design foundation: collapse the three stacked CSS layers in
  apps/web/src/styles.css into one token set; canonical type scale, container
  widths, header pattern; new logo mark + favicon; fix New Project
  bottom-pinned layout bug; remove login/index.html "AI" copy.
- [x] ✅ DES-P2a — Usage suite sweep (branch worktree-agent-ad9edeafdb865dffd @ 0fb936a).
- [x] ✅ DES-P2b — Settings/Admin/Login sweep (branch worktree-agent-a3f7fc0e0a3a130dc @ 4342f27).
- [x] ✅ DES-P2c — Portfolio sweep (worktree-agent-a1ea8378a5a1d7736 @ 373bc9e).
- [x] ✅ DES-P2d — Project workspace sweep (worktree-agent-a80a9a7be3bd38355
  @ f8e49d5): shell reorder, 43-site micro-text purge, AI copy neutralized.
- [x] ✅ DES-P3 — Integration, full verification gate (biome/tsc/271 unit/26 e2e/build), browser walkthrough light+dark. Light-first theme default. Branch design-overhaul.

## Design overhaul (Phase 2 — 2026-07-27)

- [x] ✅ P2b — settings/admin/login sweep (opened and finished in this
  worktree, one of four parallel Phase-2 agents against `docs/DESIGN-SYSTEM.md`).
  Worktree had drifted off the `design-overhaul` branch (base was `main`@`c1aa1ac`,
  missing Phase 1's token/PageHeader/Brand work); fast-forward merged
  `design-overhaul` (`7605a35`) in first. `Account.tsx`: adopted `PageHeader`
  for the "Workspace / Settings" intro, wrapped content in
  `.page-container.page-container-narrow`, renamed "AI providers" →
  "Model providers" (connection-icon glyph "AI" → "MP"), fixed the full-width
  red Sign out button (was an unconstrained grid child of `.form-stack`;
  wrapped in the existing `.session-row` flex class so it right-sizes and
  reads as a separated destructive row). `Admin.tsx`: adopted `PageHeader`
  for "Workspace controls / Administration", switched the page wrapper to
  `.page-container`, applied the existing token-based `.card` class to the
  Users / Add-a-user / Invite-by-email grid children for a consistent
  evenly-guttered card grid (`.admin-layout` already had the grid+gutter;
  audited existing typography — no sub-`--text-xs` violations found there).
  `Login.tsx`: reassigned eyebrow copy "AI program management" →
  "Program management" per PM redirect; hero layout/type size and the
  split-panel structure left untouched. Three requests blocked by the hard
  file-scope rule (no `styles.css` edits allowed) written up in
  `P2-SHARED-REQUESTS.md`: `.login-card` padding/radius are hardcoded
  (1.6rem/22px) instead of token values; `.meta` (micro-strip + Account's
  local-agent-setup copy) renders at .69rem, under the `--text-xs` floor;
  and a bigger finding — `.eyebrow` has three colliding un-namespaced
  definitions left over from the pre-Phase-1 layers, so today's actual
  rendered eyebrow (including through `PageHeader`) is a cascade hybrid of
  all three, not the clean Phase 1 token version — likely affects every
  other P2 page too. Verification: `pnpm exec biome check` on the 3 changed
  files — 0 issues; `pnpm --filter @norns/web exec tsc -p tsconfig.json
  --noEmit` — 0 errors (after building the pre-existing unbuilt
  `@norns/contracts` workspace dependency, unrelated to this change);
  `pnpm --filter @norns/web test` full suite — 58 files / 271 tests passed,
  including `Account.test.tsx` (4), `Admin.test.tsx` (6),
  `Account.connections.test.tsx` (6), `Login.test.tsx` (7), and
  `App.auth-wiring.test.tsx` (8, exercises opening both panels); `pnpm run
  build` — clean across all 5 workspace packages, web entry bundle 154.9 KiB
  gzip within the 161 KiB budget. No test copy assertions needed updating
  (existing tests use role/testid queries, not the exact strings that
  changed). Not visually browser-verified: the session's shared preview
  server was serving a different checkout (title mismatch confirmed it
  wasn't this worktree's `index.html`), so relied on the full automated
  verification bar instead.

## Design overhaul — Phase 2 (per docs/DESIGN-SYSTEM.md)

- [x] ✅ DESIGN-P2d — workspace sweep: App.tsx shell reorder (brand topbar
  first), micro-text purge in ConversationWorkspace / PhaseTab /
  ProjectOperationsDashboard / KnowledgeStatusPanel CSS, "AI" copy
  neutralized in PhaseTab, header/token normalization across operations
  dashboard, run log, debates, members.

## DESIGN R2 — feedback punch list (dispatched 2026-07-27)

- [x] ✅ R2-A — Portfolio dashboard punch list (headers, removals, tiles,
  centered stats, apollo card, side box, New Project button top-center).
- [x] ✅ R2-B — New Project wizard restructure (name-first, renames, Options,
  zero review rounds, standard width).
- [x] ✅ R2-C — Usage + Settings: persistent main header with sub-tabs below,
  renames, lede removals.
- [x] ✅ R2-D — Braided logo lockup (user-supplied design), icon-only theme
  toggle, gold accent pass.
- [x] ✅ R2-E — Diagnose "Project setup couldn't finish" + verify create →
  coordinator chat → Approve plan → Reviewer flow.

## Design overhaul — Round 2 (2026-07-28)

- [x] ✅ DES-R2 — portfolio + wizard punch list (this worktree,
  `apps/web/src/Projects.tsx` + its tests only). Portfolio: "Portfolio" H1
  page title with gold rule; eyebrows/ledes collapsed to plain section h2s
  ("Quick access", "All projects"; attention panel retitled "Status";
  "Portfolio status" heading removed); quiet-state subtext removed; stat
  tiles centered; planned/drafts/open/runner text row became a second tile
  grid; project card names at --text-lg/700 with filler descriptions
  suppressed; side panel restructured into badge / progress tile / 3-tile
  fact grid / actions; "+ New project" moved to top-center; subtle gold
  accents (title rule, ready dot, waiting-decisions count). Wizard:
  "Project setup" heading removed, wide container; name-first form
  (single-line "Project name" replaces the objective textarea; no wizard
  planning kickoff — planning starts in the conversation; description empty
  at creation); "Project type" / "Working location" / "Project location"
  renames; "Options" (name-override + reference-images removed); review
  rounds allow 0 with "Plan review is off" copy. Shared-CSS lifts logged in
  P2-SHARED-REQUESTS.md ("R2 portfolio/wizard").
- [ ] 🟡 DES-R2-FOLLOWUP — wizard "Plan review rounds" (incl. the new 0
  value) is not persisted anywhere since the wizard no longer starts a
  planning run; conversation planning (PhaseTab) uses its own reviewRounds
  default. Needs a per-project planning-rounds preference (server route +
  read in PhaseTab) for the wizard setting to be honest end-to-end.
- [ ] 🟡 DES-R2-FLAKY — two pre-existing e2e failures reproduce on base
  de367e5 (unrelated to R2): frontdoor "centered responsive shell" work-tab
  background assertion, and phase6 mockup approval (intermittent).

## Repo tooling (2026-07-31)

- [x] REPO-SKILL-1 — remove root `CLAUDE.md` agent instructions and add the
  `/full-scope-pm` project skill (`.claude/skills/full-scope-pm/SKILL.md`).
  Opened and completed in the same push. The skill's delivery clause was
  reworded to stand alone rather than cite the deleted `CLAUDE.md`.
- [ ] 🟡 REPO-SKILL-2 — the hard-won agent conventions that only lived in
  `CLAUDE.md` are now unrecorded: migration numbering left UNASSIGNED,
  `GRANT ... TO norns_app` on every new table, wiring optional services into
  `buildServer(...)` in `apps/server/src/main.ts`, running `tsc --noEmit`
  separately from `tsconfig.build.json`, and committing incrementally because
  background agents die with the host app. Each of these caused a production
  incident at least once. Decide whether to re-home them (a skill, `docs/`, or
  `README.md`) or accept the loss deliberately.

## QC PAUSE POINTS program (dispatched 2026-07-31, plan: QC-PAUSE-POINTS.md)

- [x] ✅ QCP-0 Contracts + schema: `awaiting_human` status, `paused_checkpoint`/
  `paused_at_round`/steering provenance, disposition adjudication block,
  `V2WorkPlanVersion.origin`, invariant updates, migration 0064.
- [x] ✅ QCP-1A reviewOnlySession: `paused` result, Gate B checkpoint, Gate C
  trigger (declared rebuttal + hollow acceptance, module-scoped hash), resume.
- [x] ✅ QCP-1B Park/resume through the worker: materialize interim plan
  version, release lease, resume action, orphan recovery skips `awaiting_human`.
- [x] ✅ QCP-2A Attention: `awaiting_human` items, Gate C ranking, TTL nudge.
- [x] ✅ QCP-2B Gate card UI: four distinct exits (Continue / Continue with a
  note / Accept now / Cancel) via `resumeConversationPlanReview`, Gate B
  interim-version diff reuse, Gate C no-ruling-yet notice, qc_interim excluded
  from default plan-version targets.
- [x] ✅ QCP-3A Steering + rulings (server): verified Gate A end-to-end +
  round-trip test; widened `continueReviewChat` to `awaiting_human` (question
  never advances the run) + human-steered-round provenance; adjudication
  route (`POST .../plan-reviews/:reviewId/adjudicate`, migration 0067:
  `adjudications`/`forced_accept_module_ids`/`adjudication_idempotency_key`)
  with rule-for-reviewer (blocks re-rebuttal via same-module force-accept),
  rule-for-pm, supply-the-missing-fact, and cap-raise-by-one; mid-flight
  `PATCH .../plan-reviews/:reviewId` (qc_mode freely, max_rounds raise-only-
  above-completed, reviewer identity has no field at all) + resume's
  "continue and stop asking" compound exit; `should_fix` same-module
  recurrence escalation in `qcGates.ts`; recurrence exposed on the finding
  read model (`recurs_of_finding_ids`, within-review only).
  RECONCILED 2026-07-31 (PM): QCP-3A flagged a possible duplicate with QCP-4A
  and speculated QCP-4A was in an unmerged worktree. That was wrong — it
  searched for a commit, but nothing in this program is committed yet; all of
  it is uncommitted working tree. QCP-4A's work is verified present
  (`qcModeSettingsOf`/`setQcModeSettings`/`QC_MODES` in runService.ts,
  `qc-mode` + `allow-unadjudicated-rebuttals` testids in Projects.tsx,
  `qc_mode` in the planning-reviewer routes, planningReviewerRoute.test.ts).
  No duplication: QCP-4A owns the PROJECT-level settings layer, QCP-3A owns
  the PER-REVIEW mutability PATCH and resume exits. Disjoint.
- [x] ✅ QCP-3B Adjudication card, approval-card aggregation, + the three
  qc_mode web surfaces QCP-4A could not own (kickoff, mid-flight, effective
  value/source).
- [x] ✅ QCP-4A `qc_mode` settings layer only: runService + planning-reviewer
  routes + project wizard. (Mid-flight mutability and compound exits were
  re-scoped to QCP-3A mid-program and are done there — per-review PATCH and
  resume `stopAsking`. No overlap; wording reconciled 2026-07-31.)
- [x] ✅ QCP-4B Three-tab Work layout, needs-you badge, QC status strip.
- [x] ✅ QCP-8 Make the kickoff `qc_mode` pin atomic. QCP-3B had to apply it as
  a follow-up PATCH after review creation because `V2SendPlanToQcParameters`
  has no `qc_mode` field; if the worker reaches its first checkpoint before the
  PATCH lands, that checkpoint sees the project default and a requested Gate A
  silently does not fire. Kickoff is the layer the plan says most decisions are
  made at, so best-effort is not good enough.
- [x] ✅ QCP-9 `qc_mode_source: "in_run"` carries no round or user, so surfaces
  can show "changed mid-review at round N" but not "by <user>". Needs a
  provenance field on the review. Found by QCP-3B.
- [x] ✅ QCP-5 CI review sweep.
- [x] ✅ QCP-6 Accept-now on a Gate A park. Root cause: `continueWithoutQc`
  falls back to the seed plan version, still `in_qc`, so
  `boundLatestPlan(..., "candidate")` throws `invalid_plan_state` (NOT
  `plan_not_reviewed` — that ternary keys on the expected status). Fix needed
  three parts, all verified load-bearing: (1) migration 0068 widens trigger
  `norns_guard_work_plan_version_update`'s `in_qc -> candidate` exception to
  `awaiting_human` AND `paused_checkpoint = 'after_review'` (Gate A only —
  deliberately not bare `awaiting_human`, since at Gate B a revision exists);
  (2) `continueWithoutQc` reverts the seed's status in that case; (3)
  `send_plan_to_qc`'s active-review conflict check excluded `awaiting_human`
  for `skip_qc` confirms only — it was matching the very review being accepted
  and throwing `qc_in_progress`.
- [x] ✅ QCP-7 Kickoff qc_mode control, mid-flight cadence editing, and
  effective-value/source display — all three built by QCP-3B (verified present
  in ConversationActionCard.tsx and ConversationQcCard.tsx 2026-08-01).
- [ ] 🔴 QCP-10 No live end-to-end exercise of a real gate. Every test uses
  FakeAdapter; no real reviewer/PM disagreement has ever tripped Gate C, and no
  review has actually parked and resumed across a worker lease in production.
  This is the single largest unknown in the program.
- [ ] 🔴 QCP-11 Playwright e2e never run for this program — every agent was
  told to skip it. The three-tab restructure of ConversationWorkspace.tsx
  (+739 lines) is exactly the class of change e2e catches and vitest does not.
  6 specs exist in apps/web/e2e/.
- [x] ✅ QCP-12 No post-creation project settings surface for QC. `qc_mode`
  and `default_max_rounds` are only settable in the New Project wizard;
  `default_max_rounds` is absent from the PATCH .../planning-reviewer schema
  entirely, so "turn QC off for this project" is unreachable after creation.
  RESOLVED 2026-08-01: `default_max_rounds` added to `PlanningReviewerBody`
  and `PlanningRunService.setQcModeSettings` (independently optional,
  COALESCE upsert, matches existing qc_mode/allow_unadjudicated_rebuttals
  pattern). New "Reviewer cadence" card in WorkspaceSettings.tsx
  (`qc-settings-rounds`/`qc-settings-mode`/`qc-settings-rebuttals`/
  `qc-settings-save`) reuses `QC_MODE_OPTIONS` from Projects.tsx.
  BLOCKER NOT LIFTED: `planning_reviewer_settings_default_max_rounds_check`
  (drizzle/0012_planning_runs.sql) still requires `BETWEEN 1 AND 5`, so 0
  ("review off") stays unreachable post-creation — schema and UI both cap at
  1-5 pending a migration outside this task's ownership.
- [x] ✅ QCP-13 applyMigrations.js documents itself as runnable from "the
  Railway service shell", but the app service only ever holds the RESTRICTED
  runtime role, which cannot run DDL (42501). The working path on this
  deployment is the Postgres container's local socket as the owner. The doc
  comment and DEPLOY.md both describe a path that cannot work here.
- [x] ✅ QCP-R7 Attention TTL rescans the whole JSONB `chat_messages` array on
  every poll. A `last_human_message_at` column maintained in
  `appendReviewChatEvent` would make it a column read. Deferred — the index
  (QCP-R3) addresses the larger cost first.
- [x] ✅ QCP-R8 Migration 0066 drops and rebuilds
  `conversation_plan_reviews_one_active_per_version` non-concurrently inside
  the runner's per-migration transaction, holding ACCESS EXCLUSIVE for the
  build. Fine now; a deploy-time stall once the table is large.
- [x] ✅ QCP-R9 `boundLatestPlan` hardcodes a `candidate` expectation for
  `send_plan_to_qc`, which is why Gate A accept-now needed both a status
  revert and the 0068 trigger exception. Letting `skip_qc` accept an `in_qc`
  seed directly would remove both special cases — including gate-topology
  knowledge currently living in DDL. Supersedes a written migration, so it is
  a deliberate design call, not a cleanup.
- [x] ✅ QCP-R10 Contract `superRefine` invariants and the DB guards express
  the same rules twice (intentional defence-in-depth, currently in lockstep).
  Nothing enforces they stay in sync — worth one parity test.
- [x] ✅ QCP-R11 Three idempotency-replay implementations (resume,
  adjudication, confirmation) hand-roll the same check-and-store branch
  against different columns.

## Plan generation streaming (web client)

- [x] ✅ PGS-1 Consume the streaming plan-proposal route in `apps/web`:
  `streamConversationPlanProposal` in `conversationApi.ts` reads the AI SDK UI
  message stream with `parseJsonEventStream`, and the plan busy card now lists
  each module title as it arrives instead of showing only an elapsed counter.
  Falls back to the non-streaming `plan-proposals` call with the same
  idempotency key whenever the stream cannot open or dies before a proposal.

## QC failure recovery (2026-08-19)

- [x] ✅ QCFR-1 Stop discarding completed work when a QC review fails.
  `failReviewOnly` now reads the durable `execution_checkpoint` it used to
  clear, materializes the last good plan as a `qc_interim` candidate version,
  records it on the review's new `salvaged_plan_version_id` column (migration
  `0085_qc_salvaged_plan`), points all three recovery follow-ups at it, and
  names what survived in the failure message. `continueWithoutQc` waives QC on
  the salvage, which is the route that satisfies `approve_plan`'s
  converged-review precondition. The failed QC card surfaces the salvaged plan
  and promotes "Keep this plan".
- [ ] 🟡 QCFR-2 `approve_plan` still cannot bind directly to a failed review
  (its precondition, the `conversation_plan_reviews` evidence CHECKs, and the
  0038 execution-handoff trigger all require `converged`/`cap_reached`).
  Approving a salvage therefore costs two confirmations (waive, then approve).
  Collapsing it to one means relaxing those DB invariants — a deliberate
  design call, not a cleanup.
- [x] EXEC-VERIFY-AUTODETECT — ✅ **Verification works for all projects without per-project setup.** Root cause (live on StrumSheetTA): verification commands only reached the runner from ingested `project_memory` build/test/lint facts, plan-level command acceptance, or a committed `.norns/verification.json`. A greenfield project has none of these, so it failed closed — an opaque "verification failed" with nothing to fix. Fix (runner-side, in `verify()` before fail-closed): `autoDetectVerificationCommands` reads the committed `package.json` at the exact commit and derives `install`/`build`/`test` from the project's OWN declared scripts, with the package manager taken from the committed lockfile (`pnpm`/`yarn`/`npm ci`, or `npm install` with no lockfile). Honest by construction — it runs the tests a human reading the repo would run, never a stand-in; a project with no real build/test (or only the `npm init` "no test specified" placeholder) still returns null and fails closed with an improved, actionable message. Also made a committed manifest and auto-detect **override the built-in git-hygiene DEFAULT** (a whitespace lint E4 flags as not-a-test), while leaving a real operator-configured `NORNS_VERIFICATION_POLICIES_JSON` policy untouched; opt out with `NORNS_VERIFICATION_AUTODETECT=0`. Tests: unit (pnpm/npm-ci/npm-install detection, placeholder/no-package.json → null) + a **small-development end-to-end through the real executor** (runtime writes a module+test+package.json, no verification configured → auto-detect runs real `npm test` → passes → work integrates into `main`). runnerVerificationPolicies + runnerPublication 21/21, 88 across verification-touching suites, tsc + biome clean. Ships in a new agent build (runner change). NOTE re StrumSheetTA specifically: its foundation branch has only `probe.txt`="hello" and no `package.json` — no real project — so it still (correctly) fails; that's an agent-output problem, not a verification-config one.
- [x] EXEC-PICKER-ASYNC — ✅ **Local folder picker no longer fails with "upstream error" / "Failed to fetch".** Recurring bug (hit live during the verify-test setup): choosing a project folder for a This-computer project did `await workspaceBroker.request({operation:"choose"})` inside the HTTP handler, holding ONE request open for up to the broker's 5-minute timeout while the human picks a directory. No edge proxy holds a request open that long — Railway returns 502 "upstream error", and a redeploy (or any network blip) mid-request drops it as "Failed to fetch". Fix (server + web, NO agent change — the agent answers the same `workspace_request` frames): `RunnerWorkspaceBroker` gains `initiate()` (fire the pick, return a request_id immediately, store the eventual outcome for a TTL) and `poll()` (collect it once). The route splits into POST `/…/choose` → `{request_id}` and GET `/…/choose/:requestId` → pending(202)/selection/error. The web `chooseLocalRepository()` initiates then polls with fast requests, treating a network blip or 5xx as "keep waiting" and only bailing on a definitive answer or a client deadline — so proxy timeouts, redeploys-between-polls, and blips can no longer kill a pick. (A server restart *during* the pick still loses the in-memory pending → a clean "try again", vs. the old opaque 502.) Tests: broker initiate/poll + disconnect-mid-pick unit tests, and the real-daemon frontDoor end-to-end updated to the poll flow (POST→poll→selection→create). runnerWorkspaceBroker 6/6, frontDoorLocalProjectCreation + deviceCutoverRoutes green, Account.connections 11/11, tsc + biome + web build clean. **Follow-up:** the New Project wizard uses a SECOND picker route — POST /api/v2/computers/:id/clone-destination (choose_clone_parent) — whose web caller did an uncaught res.json() (so a 502 body threw "Unexpected token u", the exact wizard error); applied the same initiate+poll async fix there (chooseCloneDestination polls resiliently), with the real-daemon clone-destination e2e and Projects.onboarding tests updated.

## Pipeline create→dispatch fixes (2026-08-20)

Root-caused live: a new project (esp. an empty/greenfield repo) cannot run a
development end-to-end. Evidence walked a real run through every gate. Five
root causes; fixes are shared across quick AND QC/phased unless noted.

- [x] ✅ PIPE-GREENFIELD — Server fail-closed dispatch when a project had no
  build/test/lint fact or committed manifest (`taskContextAssembler.ts:1243`),
  permanently blocking the first task on an empty repo — the one that would
  CREATE the tests (chicken-and-egg). Fix: `deriveAuthoritativeRepositoryFacts`
  records a deterministic `verification_bootstrap: greenfield` marker when the
  committed tree has no root `package.json` and no `.norns/verification.json`;
  it's an authoritative (reconciled) fact so it appears while greenfield and
  vanishes once a build system lands. The gate allows dispatch when the marker
  is present, deferring to the runner's chain (auto-detect → git-hygiene →
  fail-closed). Populated-but-undeclared repos still fail closed. ponytail
  ceiling: a non-Node greenfield repo is also flagged and would dispatch then
  fail closed at the runner — safe, minor wasted compute. Tests: 5 derivation +
  2 gate (bootstrap allows / populated still fails) — repositoryVerificationFacts
  + executionTaskContext 45/45. Shared (quick + phased).
- [ ] 🟡 PIPE-AUTOINGEST — New projects have no architecture revision, so the
  first dispatch is refused ("no architecture revision"); today only a
  frontend recovery triggers ingest, and the quick path never reaches it.
  Auto-ingest at project creation (or server-side on the missing-revision
  dispatch error). Shared.
- [x] ✅ PIPE-VALIDATE — Live GREEN end-to-end confirmed on ruggerdude/verify-live
  (empty repo): plan → auto-approve → dispatch (greenfield marker cleared the
  verification gate) → agent coded package.json+src/math.js+add.test.js →
  verification auto-detected & ran `npm test` (1 pass) → integrated: main
  advanced 8435fd5 → 5067a80. The only blockers were runner CREDENTIAL config
  (Codex 'minimal' effort — fixed by the clamp; Claude subscription login
  unavailable — used api/gateway mode), both surfaced instantly by the new
  failure logging. Earlier drive (superseded) from fresh
  projects: (1) a quick push and (2) a phased plan, each through plan →
  implement → verify → integrate onto `main`. Definition of done for this
  batch.
- [x] ✅ PIPE-QUICKRUN — Quick push had no execution engine: it routed to a
  bespoke dead-end (`createQuickWorkspace`/`insertQuickWorkItem`) that stamped
  the work item `executing` with `planning_run_id=NULL` and no plan, so the
  coordinator never dispatched and the UI spun "Preparing the approved phases…"
  forever (404s swallowed). Root design: quick IS phased minus QC — the two had
  diverged into separate code paths. Fix (convergence, per the product owner):
  persist `work_items.workflow` (migration 0088 + contract field on
  V2CreateWorkItemInput/V2WorkItem); route the quick workflow through the SAME
  `createPlanningWorkspace` as phased; at the plan-approval seam
  (`planWorkflow.send_plan_to_qc`) auto-waive QC when `workflow='quick'` (reuses
  the existing `skip_qc` waiver → converged review, no reviewer, then the human
  "proceed"/approve → kickoff intent → ExecutionKickoffService → real phase +
  tasks + dispatch). Deleted the dead-end (`createQuickWorkspace`,
  `insertQuickWorkItem`, the route branch). Frontend needs no change (quick now
  yields a planning conversation, rendered like phased); updated the composer
  copy. Tests: quick auto-waives-QC behavioral test (conversationPlanWorkflow),
  rewritten quickWorkItem + conversationUiStream, web fixtures. Server tsc/biome
  clean; conversation+qc+kickoff+migration suites green; web conversation/
  onboarding 98 green.
- [ ] ⛔ PIPE-BINDINGS — RE-CHECKED 2026-08-21: still cosmetic. Revoking the
  orphaned github workspace binding would also remove it from the
  execution-target picker (selection requires status connected/degraded/
  disconnected), i.e. no way back to Actions-hosted execution for that
  project; and the resume payload lists bindings regardless of status, so a
  status flip alone would not hide it. Leave as-is unless the picker gains a
  "re-attach GitHub" path. REASSESSED (attempt reverted). The 3-binding tangle is
  a KNOWN, deliberate artifact, not the dispatch blocker: for local execution
  the header of projectOnboardingService.ts intentionally records a github
  WORKSPACE candidate that activation promotes as a transient primary, then the
  device path repoints primary to the local binding — leaving the github
  workspace binding orphaned (cosmetic UI noise in the resume payload).
  Threading `source='local'` into the candidate BREAKS activation:
  `ProjectActivationService.promote` hard-throws `no_repository_attached`
  without a github workspace candidate (it needs one to set the primary). And
  live evidence shows the extra binding never blocked dispatch (the test run
  died at the verification gate, before the dispatch-target stage); a
  device-backed local binding is launchable even while `disconnected`. So this
  is cosmetic hygiene, not a runtime fix. Correct fix (deferred): revoke the
  orphaned github workspace binding after the local binding becomes primary —
  needs careful validation, low urgency.
- [x] ✅ PIPE-RUNNER-REAP — Runner never reaped orphaned `executing` runs on
  restart, so a killed run pinned the single concurrency slot and blocked all
  new dispatches. Fix: `RunnerStateFile.orphanedExecutingIds(live)` returns
  stuck `executing` entries with no live owner; `handleReconcileResponse` fails
  each once (`executing → failed`, the only legal terminal edge from
  `executing`) so the run frees its slot. `inFlightCommands` (empty on a fresh
  process) distinguishes a true orphan from a live run across a reconnect.
  Tests: orphanReap.test.mjs (3) + full runner suite 81/81. Requires a new
  agent build.

## Runner/execution follow-ups surfaced during live test (2026-08-21)

- [x] ✅ EXEC-BOUNDS-SIMPLIFY — Principle adopted: a run is bounded by MONEY
  (`max_charge_usd`) and WALL-CLOCK (`max_duration_seconds`), enforced by the
  runner; everything else is security or observability, not a gate. Done:
  (1) `max_turns` is no longer dispatched (contract field stays optional;
  runner still honors it if present) — tool calls are not a unit anyone can
  set a priori and the cap cut real work off twice; (2) the server watchdog
  no longer acts as a second, earlier timeout: it requests a stop only when a
  run has been silent past its OWN time bound + 5 min grace (the runner that
  should have enforced it is gone); quiet-but-alive runs still get a
  "stuck run" decision point for a human. Unchanged on purpose: budget,
  duration, sandbox, command expiry, and the concurrency/phase gates (product
  decisions that stopped being traps once slots/phases self-release).
- [x] ✅ EXEC-LIVE-GATE — The two best follow-on investments from the
  2026-08-21 incident, done: (1) `scripts/agent-diagnose.mjs` — one command
  that prints installed agent version/uptime, last dispatch outcomes
  (`rejected` vs `failed`), cancellation-journal entries that replay on
  reconnect, leftover worktrees, and the last coding session's final
  command/result/message (every question asked today, answered in one
  screen, no server session needed); (2) `docs/runbooks/LIVE-RUN-GATE.md` —
  the rule that runner/coordinator/devices/kickoff changes are not done until
  one live probe run passes on the deployed server + packaged agent,
  including the two recovery edges that bit us (stop→restart→dispatch, and
  failed run → next plan starts). Checked and NOT changed: the 15-min watchdog
  is safe because the runtime emits a knowledge heartbeat every 60s while
  device execution is on, and the server bumps the inactivity clock on it.
- [x] ✅ EXEC-CREDENTIALS-DECISION — Standardize on `api` (gateway) credential
  mode for the local agent; do NOT log the runner into a Claude subscription.
  Why: api mode already works end-to-end and is the credential-free runner
  design (E9); a subscription login would live in the runner's isolated HOME
  (fragile token refresh, breaks on every runtime-state rotation) and uses a
  consumer subscription for automated work. Defaults are already `api`
  (PhaseTab falls back to api; subscription stays an explicit per-phase opt-in
  that fails fast with "Claude subscription login is unavailable"). No code.
- [x] ✅ EXEC-TURNCAP-SANDBOX — Live (strumsheetx1 attempts 3+4, after the wedge
  fix): dispatch accepted, agent coded ~3 min, then "verification failed".
  Session transcripts show both attempts ended MID-FILE at 20 and 29 tool
  calls — the new per-complexity turn cap (12/20/30/45, fdcd7bf) cut a
  Foundation scaffold off long before it could finish, so verification ran
  on a half-built repo. Separately, inside the sandbox `npm install` got 403
  from the sandbox proxy (no egress allowlist), so the agent could neither
  install nor test. Fix: caps raised to 40/80/150/200 (budget + wall-clock
  remain the real bounds); sandbox egress allowlist (npm/yarn/GitHub/PyPI/
  crates/Go proxy) + allowLocalBinding in the flag-settings layer; a
  verification failure after an early runtime stop now leads with the stop.
  Agent 0.4.13 packaged — install it, then retry Foundation. The allowlist
  could not be verified outside the real runner; the live retry is the test.
- [x] ✅ EXEC-CANCEL-WEDGE — Live (strumsheetx1 Foundation, attempt 1): the
  runner REJECTED the dispatch ("local emergency stop is engaged") and the UI
  showed a bare "This attempt failed". Root cause: any server-delivered device
  cancellation (`emergency_stop` — now also the 15-min watchdog from
  fdcd7bf) ran `stopAllManagedForEvidence`, which set the runner-wide
  `executionPaused` flag; the server replays every unresolved cancellation on
  each reconnect (a stop for a long-dead run can never be proven exited), so a
  restart re-armed the pause and every later dispatch was rejected. Fix:
  runner stops only the named run and never touches the local dispatch kill
  switch; server persists the ack `detail` into `failure_code/failure_detail`
  so a rejection states its reason; server also stops replaying cancellations
  whose run is already terminal (so the installed 0.4.11 agent un-wedges on
  its next reconnect). Agent 0.4.12 packaged (sha256 8298c6ab…); install it
  for the runner half. Live re-run on strumsheetx1 still to be observed.
- [x] ✅ EXEC-CODEX-NOOUTPUT — Root cause found via the existing run-log: the
  Codex/OpenAI runtime was sent `reasoning_effort: 'minimal'`, which every
  gpt-5.6 model rejects (`unsupported_value`, param reasoning.effort) → model
  400 → run produced nothing → failed. Fix: `reasoningEffortForModel()` clamps
  the legacy `minimal` level to `low` at the dispatch boundary
  (phase4Coordinator), and the allocation prompt no longer offers `minimal`.
  contracts models test + coordinator/allocation suites green. No migration.
- [x] ✅ LOG-SURFACE-FAILURE — Failed runs now say WHY at a glance. The reason
  was already captured (agent_runs.failure_detail, run-log endpoint) and
  rendered — but buried in a collapsed "Technical details" disclosure. Added
  `conciseFailureReason()` (prefers an embedded API `message`, else the
  headline) and surfaced it in the prominent development run status line; full
  detail still available collapsed. ConversationWorkspace tests green.
- [ ] 🔴 EXEC-CODEX-NOOUTPUT-OLD — Live: a task dispatched to the Codex (openai)
  runtime ran ~13s and produced ZERO output (`last_agent_message: null`, empty
  worktree, no tool calls) → task failed with nothing to verify/integrate. The
  pipeline dispatched correctly; the agent-runtime/provider path returned
  nothing. Investigate the runner's Codex/OpenAI gateway credentials + runtime
  wiring. Claude-staffed runs have worked before, so likely provider-specific.
- [x] ✅ EXEC-PHASE-RELEASE — FIXED: the recovery monitor (60s scan) parks an
  `active` phase as `blocked` once nothing in it can run (no live/waiting
  runs, no schedulable tasks, no task mid-flight); kickoff then accepts the
  next plan. Retry re-activates the phase; cancel accepts `blocked`.
  Coordinator/kickoff/recovery suites green. Original report: a FAILED run leaves its phase `active`
  ("0/1 tasks complete; 1 task(s) failed"), and since the project runs one
  phase at a time, that stuck phase blocks every subsequent run (a Claude
  retry was refused: "already executing"). A terminally-failed run must release
  its phase's concurrency slot (or the phase must move to blocked/failed).
  Sibling to PIPE-RUNNER-REAP but server-side at the phase level.

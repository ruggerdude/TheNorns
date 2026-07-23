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

## In Progress
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

- [ ] 🔄 P1 — Remove the local-runner install surface (Settings "Local runners"
  panel, install-runner.sh, orphaned pairing/runner routes). The user rejected
  the runner-install design outright; the panel survived the front-door rework.
- [ ] 🔄 P2 — Safari cache hardening: index.html must never be reused without a
  re-check; hashed /assets/* become immutable.
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

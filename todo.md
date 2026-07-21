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

## ONBOARDING program

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
- [ ] O4-6 — **HUMAN**: add `workflows: write`, `actions: write`,
  `secrets: write` to the GitHub App manifest and re-authorize every existing
  installation (deliberately not changed by the agent)
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

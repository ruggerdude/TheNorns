# FRONT DOOR Program — Design Freeze (Phase 0)

**Status:** Frozen for implementation · **Date:** 2026-07-20
**PM / integration owner:** Claude Fable 5 (human-directed 2026-07-20)
**Mandate:** Make TheNorns usable end-to-end as an MVP: one simple path from
"describe a project (with screenshots)" to "watch a staffed, launched phase."
**Corrected by external review** (2026-07-20): consolidate existing machinery,
don't rebuild it; the relational strategy bridge is the risk center.

## Product journey being delivered

1. New project (one screen): name → source (GitHub repo | local folder path,
   no runner required) → Coordinator model → Reviewer model → review rounds →
   objective with pasted images → Create & draft plan.
2. Planning runs as an observable background job: Coordinator drafts,
   Reviewer critiques, revise — N rounds or convergence (existing
   `runPlanning` loop, exposed).
3. Plan review: rounds outcome + phases + **staffing table** (per assignment:
   agent role, provider/model — mixed providers, reviewer, budget), editable,
   then Approve & launch.
4. Tracking: per-phase % complete, ETA, configurable update interval,
   decision inbox with inline answers.

## Decisions (D1–D3)

### D1 — Canonical planning path: `runPlanning`, made observable

- The synchronous cross-provider loop in
  `apps/server/src/planning/session.ts` (`runPlanning`) is the one canonical
  planning engine. The durable debate engine (ADR-008) remains a
  general-purpose tool; bridging debates→strategy is deferred post-MVP.
- Project record gains persisted **reviewer selection** and
  **default_max_rounds**. Cross-provider default stays enforced;
  same-provider requires the existing recorded-exception path.
- New API (v2, relational-first):
  - `POST /api/v2/projects/:id/planning-runs`
    `{ objective, max_rounds?, attachment_ids? }` → `202 { planning_run_id }`
  - `GET  /api/v2/projects/:id/planning-runs/:runId` →
    `{ status: queued|drafting|reviewing|revising|converged|cap_reached|failed,
       round, max_rounds,
       transcript: [{ round, role: pm|reviewer, provider, model, summary,
                      finding_counts }],
       result?: { plan, content_hash, total_cost_usd,
                  staffing_proposal: V2StrategyAssignmentProposal[] } }`
  - Runs persist to a `planning_runs` table (id, project_id, phase intent,
    status, round, transcript jsonb, result jsonb, cost, timestamps) so a
    refresh/reopen never loses a run. Worker executes in-process off a simple
    claim (single-instance MVP per refoundation control 14).
- The legacy `POST /api/projects/:id/plan` synchronous route is removed from
  the UI path (kept server-side until retirement approval; no new callers).

### D2 — Local folders: folder-first, runner only at execution

- Project creation accepts `{ source: { type: "local", path } }` with **no
  runner online**. Binding is stored `unverified`; when a paired runner
  reports the workspace, it flips `verified`.
- Everything through planning, staffing, and approval works unverified.
  Execution (dispatching real runs) is the only gate requiring a verified
  binding + online runner; the UI says exactly that at the moment it matters,
  not at creation.
- Browser-filesystem access is rejected as the ongoing-execution mechanism
  (Safari support inadequate; git operations need a real process). The
  companion runner remains the execution answer — but it is no longer the
  front door's bouncer.

### D3 — Attachments: content-addressed Postgres, capped, storage-pluggable

- Table `attachments(id, project_id, sha256, mime, bytes, width, height,
  purpose, created_by, created_at, deleted_at)`; blob in a separate
  `attachment_blobs(sha256 pk, content bytea)` so metadata and storage
  decouple — moving blobs to object storage later changes no contract.
- Caps: image/png|jpeg|webp|gif only; ≤ 3 MB each; ≤ 8 per objective;
  ≤ 40 MB per project. Dedupe by sha256 within project. Cleanup on project
  archive; explicit `DELETE` supported.
- API: `POST /api/v2/projects/:id/attachments` (base64 JSON body),
  `GET /api/v2/projects/:id/attachments/:attachmentId`, `DELETE` same.
  Project-member authorization on every route.
- Adapters (`packages/adapters`): provider-neutral message content becomes
  `parts: ({ type:"text", text } | { type:"image", mime, base64 })[]`.
  Anthropic → `image` source blocks; OpenAI → data-URI `image_url`. Images
  are injected in planning round 1 only (cost control); later rounds carry
  the PM's textual summary of them. Per-request cap 8 images.
- Contract change to `packages/adapters` types requires PM sign-off (this
  document is that sign-off for the shape above).

## Phase → file ownership (collision map)

| Phase | Owns (writes) | Must not touch |
|---|---|---|
| P1 Front-door + visual refresh (Sonnet) | `apps/web/src/**` (Projects.tsx, App.tsx, styles/theme, new components) | any `apps/server/**`, `packages/**` |
| P2 Planning consolidation (Sonnet) | `apps/server/src/planning/**`, planning routes section of `server.ts`, project reviewer/rounds fields + migration | `apps/web/**`, `packages/adapters/**` |
| P3 Strategy bridge (Opus) | `apps/server/src/projects/**` relational repos, coordinator glue, `packages/contracts/src/v2/**` (PM approval required per change), migrations | `apps/web/**` (P1 consumes its DTOs), planning loop internals |
| P4 Attachments (Opus) | `packages/adapters/**`, new `apps/server/src/attachments/**` + routes, migration, one isolated web component `AttachmentInput.tsx` (P1 mounts it) | Projects.tsx/App.tsx layout, planning loop |
| P5 Tracking (Sonnet) | resume read-model additions, project `update_interval` setting, small web tracking components | everything else |
| All | — | `apps/runner/**`, `apps/server/src/runners/workspace*` (active external work) |

`server.ts` is shared: each phase adds routes in its own clearly-marked
section; the PM performs all merges and resolves overlaps.

## Sequencing, estimates, reporting

`P0 (1h, done) → P0b mockup (≤1h, user gate) → [P1 ∥ P2] (3–4h / 2h) →
P3 (3–4h) → [P4 ∥ P5] (2–3h / 1h) → P6 verify+deploy (1.5–2h)`
≈ 16h agent runtime → **~2–3.5 focused days** wall-clock. ≤2 implementation
agents concurrent; every merge preceded by PM diff-read + full CI.
Status reporting: every 5 minutes to the human — per-phase status,
% complete (task-weighted), ETA. Blockers and decisions surface immediately.

## Out of scope (explicit)

Full reskin of non-journey screens (auth/admin/settings/debates); debate→
strategy bridging; object storage; multi-instance control plane; legacy
retirement; runner/workspace-registry changes.

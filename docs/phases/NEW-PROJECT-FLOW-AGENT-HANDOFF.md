# New-project flow — implementation-agent handoff

**Audience:** the agent implementing the new-project journey
**Status:** next task; existing-project adoption is complete

## Mission

Optimize the **New project** path from the dashboard through the first coding
dispatch. Match the adoption journey's simplicity without coupling or
regressing it.

The desired user path is:

1. Choose **New project**.
2. Give one required brief: what should The Norns build?
3. Confirm the derived project/repository summary.
4. Watch planning.
5. Make one consequential decision: **Approve & start coding**.
6. Watch the first code task run.

There must not be separate required stops to create a phase, approve a second
strategy representation, allocate agents, or start the phase.

## Setup boundary

GitHub authorization, GitHub App installations, local-helper installation,
and approved local-folder inventory are Norns account/workspace setup. They
belong to **Settings → Connections**, not this project form.

For new projects, creating the project's repository is normal project
materialization; asking the user to configure Git is not. Use an already
connected GitHub installation:

- If exactly one writable destination exists, select it automatically.
- If more than one exists, ask for the destination because it changes where
  the repository is created.
- If none exists, show one **Open Connections** action. Do not embed setup.
- Default visibility according to the product/account default; expose a
  visibility override only if it changes repository creation.

Never ask for a local path, runner ID, pairing code, workspace ID, selection
token, verification-policy reference, provider, reviewer, or review-round
count in the primary flow.

## Input policy

The brief is the only universally required user-authored value. Derive:

- project name from the brief;
- repository slug from the derived name;
- description from the brief;
- coordinator and opposite-provider reviewer from account defaults;
- review cap, verification policy, staffing, budgets, and worker models from
  Norns defaults and recommendations.

Optional inputs are allowed only when they change downstream behavior:

- an explicit project/repository name overrides the derived name and slug;
- attachments enter round-one planning context;
- destination changes repository ownership;
- visibility changes repository creation;
- advanced reviewer/round options change the planning run.

Keep those controls secondary or collapsed. Do not add informational fields
that are merely collected and ignored.

## Reuse the canonical planning-to-code journey

Do not build another planning engine or revive the legacy multi-click Plan
path.

Reuse:

- `POST /api/v2/projects/:id/planning-runs`;
- `PhaseTab` and `phaseTabApi.ts` for live progress, plan review, optional
  staffing, decision, and execution status;
- `POST /api/v2/projects/:id/planning-runs/:runId/decision` for
  **Approve & start coding**;
- `GET /api/v2/projects/:id/planning-runs/latest` for refresh/reopen recovery;
- `POST /api/v2/projects/:id/planning-runs/:runId/execution` when an approved
  plan needs an idempotent coding-start retry.

The server already implements the approval saga:

planning-run approval → phase materialization → optional staffing overrides →
strategy approval/materialization → phase launch → first dependency-ready
task dispatch.

Preserve its human approval, audit actor, idempotency, repository readiness,
budget, verification, and one-active-phase gates.

## Isolation requirements

Existing-project adoption is a completed contract:

- GitHub/local selection uses reusable Connections state.
- Repository analysis always precedes optional planning.
- A blank first direction analyzes and opens without planning.
- A nonblank direction opens directly into the canonical planning journey.
- `entry_flow: "adoption"` is a transient browser hint, not durable domain
  state.
- Local analysis reads bounded committed `HEAD`; it never claims to include
  uncommitted files.
- Raw Mac paths never enter browser/server DTOs or storage.

Do not change those semantics while optimizing New project. If a shared
component must change, run the adoption tests and preserve its copy/actions.

## Recommended implementation sequence

1. Trace the current New-project calls and remove only redundant human stops.
2. Introduce a transient new-project entry hint if needed; do not overload the
   adoption hint.
3. Derive name/slug/default destination before submit, with a concise editable
   confirmation.
4. Create the repository/project and start planning in one recoverable
   journey; retain the created project if a later step fails.
5. Open the canonical planning screen with the returned run ID.
6. Verify approval actually dispatches a coding task through the real gate.
7. Preserve durable recovery for planning, awaiting approval, approved launch
   failure, and active execution.
8. Remove or clearly retire duplicate legacy UI only after every caller uses
   the canonical journey.

## Required acceptance tests

Cover at least:

- one connected GitHub destination: brief is the only required field;
- multiple destinations: destination choice appears and affects the request;
- no destination: one route to Connections, no embedded setup;
- derived name/slug and explicit override;
- optional attachment reaches `attachment_ids`;
- project/repository creation failure creates no misleading success state;
- planning failure retains the created project and allows retry;
- refresh during active planning restores the latest run;
- refresh while awaiting approval restores the same decision;
- **Approve & start coding** records one approval and dispatches the first
  dependency-ready task;
- kickoff failure states that coding did not start and retries without a
  second approval;
- adopted-project blank and directed flows remain unchanged;
- Chromium and WebKit cover the complete brief-to-first-code happy path.

Run targeted tests first, then the full build/typecheck, web, server,
contracts/adapters, scoped Biome, and browser suites. Commit only task-owned
changes, push the branch, and verify local and remote SHAs match.

# FRONT DOOR Program — Revised Delivery Plan

**Status:** Delivered and verified · **Completed:** 2026-07-23

**Mandate:** Give the user one truthful path from the project dashboard to a
staffed, approved, running project, whether the source is GitHub or a local
folder.

This revision replaces the 2026-07-20 design freeze. It records what is now
implemented, corrects the original diagnosis, and limits remaining work to
gaps that can be verified end to end.

## Corrected baseline

The following capabilities existed before this program and must be reused:

- `runPlanning` is already the canonical PM/reviewer planning loop. It drafts,
  critiques, revises, enforces review policy, and stops on convergence or the
  selected round cap.
- The durable debate workflow is a separate general-purpose aggregate by
  design (ADR-008). Debate-to-strategy integration is not required for the
  front-door MVP.
- Phase task progress and the attention decision-response UI already existed.
  The program extends their presentation; it does not replace their domains.
- The project wizard, GitHub connections, local-runner binding, relational
  `StrategyVersion`, and PM allocation recommendations already existed in
  partial form.
- PM allocation recommendations already choose the implementation provider,
  model, worker count, cross-provider reviewer, and budget. The product task is
  to make that recommendation part of an editable relational strategy and
  approval flow.

## Current delivered baseline

| Capability | Current state |
|---|---|
| Light mode | Delivered: light/dark toggle, system preference, and persisted selection |
| Project dashboard | Delivered: project cards, overall completion, ETA, active agents, decisions, row-wide click/keyboard entry, and explicit project entry |
| Dashboard project removal | Delivered: confirmed removal archives an idle project, closes its open tab, removes it from active reads, preserves repository/history, records human evidence, and refuses while agent/planning/debate work is active |
| GitHub onboarding | Delivered: connection, repository selection/creation, and project creation |
| Planning | Delivered: persisted asynchronous planning runs backed by `runPlanning`, selectable reviewer, configurable rounds, transcript/status, and refresh recovery |
| Images | Delivered for the MVP: paste/drop upload, validation and caps, provider-neutral image parts, and Anthropic/OpenAI planning context |
| Strategy and staffing | Delivered: planning output bridges to relational strategy; the PM recommends workers/models/reviewers/budgets; the user can review before approval |
| Approval and execution | Delivered: approved strategy materialization and execution kickoff with readiness checks |
| Tracking | Delivered: explicit percentage, blended ETA, phase progress, and decision handling |
| Local folder onboarding | Delivered: one-time helper setup, native folder selection, expiring user-bound selection tokens, atomic project/binding creation, safe reopen, and no browser or server raw-path seam |

## Completed hardening

### R1 — Local folder: one visible action, secure helper underneath

The user experience is:

1. Choose **Local folder** beside **GitHub repository**.
2. Click **Choose project folder…**.
3. Select the Git repository in the computer's native folder selector.
4. Return automatically to the completed project form with the selected
   repository name shown.

There is no runner ID selector, workspace dropdown, pairing-code workflow, or
raw-path text field in project creation.

Ongoing Git access and agent execution require a local process; a hosted web
page cannot safely retain an executable Safari folder path. The existing local
runner therefore becomes a user-invisible local helper for this flow:

- If the helper is installed and running, the folder button opens its native
  selector immediately.
- If it is absent, the UI presents one guided install/open action and resumes
  the same wizard automatically afterward.
- The helper returns an expiring, single-use selection token plus safe
  repository metadata. Raw paths never enter browser DTOs or server storage.
- Project planning may continue when the helper later goes offline. Execution
  clearly reports that the selected folder's helper must be online.
- The public raw `source_location` creation seam is retired after existing
  unverified records are migrated or invalidated.

The flow is implemented with an authenticated helper broker and a fixed,
server-served installer. Selection tokens are short-lived, bound to the
authenticated user and current helper generation, reservable for atomic
creation, and single-use after commit. Browser-supplied local paths and forged
repository metadata are rejected. The real helper integration test covers
native selection, durable binding, safe reopen, replay rejection, helper
generation/disconnect handling, and path non-disclosure; the helper registry
suite covers cancellation and non-Git folders.

### R2 — Attachment storage hardening

Attachment bytes now sit behind `AttachmentBlobStore`; PostgreSQL remains the
private default and a production object-store adapter can replace it without
changing metadata or planning contracts. The browser uploads bounded binary
image bodies rather than base64 JSON. Archive/delete orphan cleanup,
authorization, immutable private cache headers, MIME sniffing, pre-parse size
limits, quota usage reporting, and shared-blob retention are covered. The
provider-neutral image-parts contract and both provider conformance suites are
unchanged.

### R3 — Full journey and browser-state verification

Run the following journeys from a clean account and from an account with
existing cookies/local storage:

1. GitHub authorization → installation → callback → repository selection →
   project creation.
2. Local helper discovery/install → native folder selection → project
   creation.
3. Objective with pasted images → PM/reviewer rounds → editable staffing →
   approval → execution kickoff.
4. Refresh and reopen during planning, approval, and execution.
5. Enter a project by clicking its dashboard row and by keyboard, then open
   multiple projects, switch between them, close one, and return to the main
   dashboard without losing the others.
6. Remove an idle project and confirm it disappears from the dashboard and
   open-project tabs without deleting its repository or history. Attempt the
   same operation on a project with active work and confirm it is refused with
   a recoverable explanation.
7. Resolve an attention decision and confirm execution resumes.
8. Repeat the supported web journeys in normal Safari, Safari Private
   Browsing, and Chrome.

The browser acceptance layer now runs in Chromium and WebKit (Desktop Safari
engine). It covers the GitHub and Local-folder project front doors through
immediate entry into a nonblank Overview workspace, with persisted session and
theme state. The wider Vitest and server integration suites cover image
planning, editable PM staffing, approval/execution, refresh/reopen, dashboard
keyboard entry, multiple tabs, archival refusal, and attention decisions.
Fresh projects treat a missing graph as a normal draft state rather than a
blank workspace.

Native Safari normal/private cookie smoke testing remains a deployment
operation because it requires the deployed origin and a real account; WebKit
is the committed automated regression gate for both creation paths.

## Product acceptance criteria

- The main dashboard shows every project with source, status, current phase,
  completion, ETA, active work, and attention count.
- Clicking the non-interactive area of a project row enters that project
  immediately. The same entry action is keyboard accessible and each row
  retains an explicit **Enter project** control.
- Every project row offers **Remove** with confirmation. Removal means archival:
  the project disappears from the active dashboard and open tabs while its
  connected repository and historical evidence remain untouched.
- Removal is rejected while agent, planning, or debate work is active; the
  dashboard explains what must finish or be cancelled first.
- **New project** visibly offers both GitHub and Local folder.
- GitHub remains connected after its callback and refresh.
- Local-folder selection is a native chooser experience; implementation
  details such as runners and pairing codes are not part of routine project
  creation.
- Multiple projects can remain open and retain independent UI state.
- The project workspace opens on an Overview/Phase surface; the graph is
  optional, never an empty front door.
- Light and dark modes remain readable across dashboard, wizard, workspace,
  settings, planning review, and errors.
- The PM recommends the best cost/capability mix of workers and models from the
  approved catalog. Human overrides remain authoritative and are recorded.
- Reviewer, round cap, staffing, budget, and approval evidence survive refresh
  and reopen.
- Progress and ETA are labeled as measured estimates and never fabricated when
  the underlying data is unavailable.

## Verification record

- Scoped lint: `biome check apps packages scripts`
- Monorepo build and typecheck: passed
- Web unit/integration suite: 37 files, 140 tests passed
- Server suite: 109 files passed plus the real-runtime regression rerun; 8
  database-environment tests remain intentionally skipped
- Contracts: 15 files, 122 tests passed
- Adapters: 26 tests passed, one live-provider smoke intentionally skipped
- Browser front door: four passes across Chromium and WebKit (GitHub and
  Local-folder journeys)

## Delivery controls

- Do not create a third planning engine or duplicate the attention/read-model
  domains.
- Prefer narrow services and contracts over additional logic in `server.ts`.
- Preserve relational approval, idempotency, audit, and tenancy boundaries.
- Verify targeted tests first, then the full server, web, contracts, adapters,
  typecheck, format, and build suites.
- Test the deployed callback and cookie behavior in normal Safari before
  calling the GitHub journey complete.
- Commit only task-owned changes, push `main`, and confirm local and remote
  commit SHAs match.

## Explicitly out of scope

Debate-to-strategy integration; a full reskin of auth/admin/settings/debates;
multi-instance planning control; arbitrary browser-side Git execution; fake
local execution without a helper; and legacy retirement unrelated to the
front-door journey.

# TheNorns — running backlog

Kept per the standing rules of engagement. Nothing here is acted on without
the human's decision. Presented for scoping when a program closes.

## Missed scope — implied but not covered by a plan

- **Answering an agent mid-run** was promised by the UI and the protocol, but
  `send_message` is rejected by the runner. Now scoped as E11.
- **Concurrent phases** are shown on the dashboard but cannot happen: one
  runner identity per project, and the second dispatch fences the first.
  Scoped as E5, not yet dispatched.
- **Parallel agents inside one phase** exist in `apps/server/src/engine/**`
  but that code is imported only by tests. Scoped as E12.
- **Resumable runs.** A GitHub Actions job has a 6-hour ceiling and bills
  wall-clock, so an agent waiting on a human answer is expensive and
  eventually dies. Proper fix is ending the job and resuming with context.
  Design work, part of E11.

## Additional features worth adding

- **Live cost during a run.** Once the gateway meters per call, spend can be
  shown as it accrues instead of after the fact. Scoped as E13.
- **Link a run to its pull request** in the UI. Scoped as E10.
- **Streaming model responses** through the gateway (currently complete
  results only). Additive on both sides whenever wanted.
- **Local execution as a deliberate power-user path**, for code not in a
  GitHub repo, local databases/services, or licensed tooling. The runner
  already supports it; only the front door was removed.

## Recommendations, risks, technical debt

- **Authorization is single-tenant.** Any signed-in user can see every
  project. Fine for one operator; a real gap before anyone else logs in.
- **Test flakiness.** Roughly one failure per five full server runs, varying
  between runs, in tests unrelated to the change under test. Looks like
  worker contention. Makes CI hard to trust.
- **GitHub API errors all collapse** to a generic 409, so "repository not
  found" and "permission denied" are indistinguishable.
- **Orphaned server surface** after the local-runner UI was removed:
  `/api/runners`, `/api/pairing/start`, `workspaceBroker.ts`,
  `install-runner.sh`. Scoped as E8; do not delete until the tarball route
  work settles.
- **`agent_profiles.runtime`** cannot name the credential-free runtime, so
  the coordinator can dispatch a runtime that has no way to reach a model.
- **`PlanReview.tsx` is dead code** from the app's side since the planning
  paths were unified.
- **Gantt time axis is ordinal, not calendar**, until phase timestamps reach
  the resume payload.
- **The GitHub App still needs `workflows`, `actions`, and `secrets` write
  permissions**, plus re-authorization of every existing installation, before
  anything can run. Human step, outstanding.
- **The host app restarting kills every running agent** and can destroy their
  transcripts. Mitigated by incremental commits and a 3-minute snapshotter,
  not eliminated.

## Added during the execution program

- **`RelayStores` grows per dispatch, not per project** (E5). One in-memory
  runner record per Actions dispatch, with no cleanup path for terminal
  generations. Fine at current volume, unbounded as Actions usage grows.
- **Gateway holds are per-process** (E9-14). If Norns ever runs more than one
  server instance, two model calls for the same run could land on instances
  that cannot see each other's in-flight budget holds. Single-instance is
  unaffected. Needs a durable hold row before scaling horizontally.
- **OpenAI calls without a declared output ceiling** (E9-15) can overshoot the
  budget hold by up to roughly $2.88 on an expensive model, bounded to one
  request.
- **Long OpenAI streams killed near completion currently cost nothing**
  (E9-12) because usage only arrives on the terminal event. Audited as
  `gateway.unmetered` so it is measurable.
- **Model allowlist keys on the resolved model id** (E9-11); an operator who
  configures an alias will see every call refused.
- **Expired gateway credentials are never purged** (E9-13). Inert rows, but
  they accumulate.
- **Resume across machines is unverified** (E11-9). A runtime session id may
  point at local state that dies with an ephemeral Actions job, so resuming
  from it may resume nothing. Needs a real cross-machine experiment before
  anyone promises the feature.
- **Codex cannot accept mid-run answers** (E11). Claude Code can. This is an
  SDK limitation, declared honestly rather than faked.
- **`run_published` collapses three outcomes into two** (E11-12): the runner
  distinguishes pushed/already-published/republished, the wire enum does not.
  The finer fact survives only in the run log.
- **Shell-syntax verification commands are dropped, not run** (E10-8), and the
  human is not yet told which ones were dropped.
- **Legacy import policy vocabulary persists** (E10-9) alongside the canonical
  one.
- **Nothing declares which files a task will touch** (E12-1). The conflict
  detector is fail-closed: with no declared scope, *every* pair of runs in the
  same phase raises a "look at this" row. Safe, but noisy. The natural writer
  is the planner, which E12 did not own. This is the reason the parallel-agent
  cap should stay at 1 and step only to 2 until planning declares file scope.
- **`task_coordination_constraints` had two readers and no writer** (E12-2) — a
  sixth dead-but-green path. The repository-scope exclusion gate has never
  fired in production. E12 shipped the writer; see E12-1 for the missing caller.
- **`apps/server/src/engine/**` is superseded, not adapted** (E12-3). It merges
  branches on the server's own machine, which the relay architecture forbids.
  Left in place as a design reference; seven test files import it. Deleting it
  is a decision to take deliberately.
- **The phase queue drainer polls every 5 seconds per active phase** (E12-4).
  Fine now; worth revisiting past a few hundred concurrent active phases.
## Found by the pre-deploy review (E7a) — decisions for the human

Full report: `docs/reviews/EXECUTION-PREDEPLOY.md`. The one blocker it found
(the runner tarball installing but not executing) is being fixed as E7b and is
not listed here. These are the ones that are working as built but need a
product decision, not a bug fix:

- **`NORNS_RUNNER_ALLOWED_MODELS` fails closed and is documented nowhere an
  operator would look** (E7a-1). If it is unset, every model call is refused.
  Not in `DEPLOY.md`, not in the runbooks. Must be set before the first run.
- **An integration conflict can wedge a phase with no way out** (E7a-2).
  Detection fires even at a cap of 1, the completion gate then refuses, and
  the web app never calls the resolve route — so there is no button to press.
  Either the UI gains a resolve control or detection should not fire at cap 1.
- **Mid-run messaging has no button** (E7a-3). E11 built the whole path;
  nothing in the app issues a `send_message`.
- **Nothing writes `max_concurrent_tasks`** (E7a-4). The parallel-agent cap can
  only be changed in the database, so in practice it is permanently 1.
- **The manifest captures a webhook secret that nothing uses** (E7a-5). There
  is no webhook-receiving route; Norns polls GitHub instead.
- **`github_actions_runs.last_error` is not read by any route** (E7a-6), so
  the new specific permission-failure message does not reach a human on the
  Actions dispatch path without a database query.

## Recommendations, risks, technical debt (continued)

- **Verification results are stored in the runner's inline shape** (E10-10)
  rather than the evidence contract's artifact-backed form. Nothing reads the
  latter today; reconciling needs an artifact store on this path.

## Phase tab build — backlog for the owner (2026-07-22)

Product decisions:

- **Cap-reached approval vs must-fix findings** (PHTAB-B1). If review hits the
  round cap with unresolved must-fix findings and the owner approves anyway,
  execution kickoff refuses honestly (approval is recorded; the refusal reason
  is shown). Decide whether a Phase-tab approval should waive open must-fix
  findings for cap_reached runs.
- **Add Kimi as a third provider** (PHTAB-B2). The adapter layer is a clean
  seam (`packages/adapters`, ProviderName union, model registry, contracts
  PM_MODEL_OPTIONS); Kimi = one new adapter + registry/options entries +
  worker_providers extension.
- **General file attachments** (PHTAB-B3). The goal box accepts images only
  (server mime allow-list in apps/server/src/attachments/). Extend to
  PDFs/text/docs if wanted.

Minor debt from the P5 review (all assessed non-blocking):

- Phase-tab caption "PM: Claude Fable · Reviewer: ChatGPT Sol" is static; env/
  per-project overrides win server-side without changing the caption (PHTAB-B4).
- Active-phase guard in executionKickoff.ts is check-then-act, not atomic;
  mitigated by the coordinator's own gate (PHTAB-B5).
- Execution-status route maps all errors to 404 project_not_found, including
  genuine DB errors (matches sibling route; tighten someday) (PHTAB-B6).
- An approve whose staffing names a node the plan lacks refuses after the
  phase + proposed strategy were created (state consistent and recoverable;
  route-level 422 catches registry-invalid entries first) (PHTAB-B7).

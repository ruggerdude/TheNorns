# EXECUTION program — independent pre-deploy review

Branch reviewed: `execution/integration` @ `9d22507` (86 commits off `main`).
Reviewer worktree: `review/execution-predeploy`.
Method: source reading on both sides of every boundary, plus reproduction where
a claim could be executed. Findings are labelled **PROVEN** (I ran it) or
**INFERRED** (I read it and could not run it).

Known/accepted limitations recorded in `BACKLOG.md` on `main` are **not**
re-reported. Where a finding is adjacent to a BACKLOG entry but is materially
different, I say so explicitly.

---

## BLOCKERS

### B1. The runner tarball the Actions job installs cannot start. Every Actions-hosted run dies at the first command. **PROVEN**

**Writer:** `apps/runner/scripts/pack-tarball.mjs:95-114` — the generated
package manifest declares `dependencies: { "@norns/contracts": <version>, zod:
"^3.23.8", "@anthropic-ai/claude-agent-sdk": "^0.3.207", … }` together with
`bundledDependencies: ["@norns/contracts"]`, and physically stages
`node_modules/@norns/contracts` inside the tarball.

**Reader:** `apps/server/src/integrations/actionsWorkflowTemplate.ts:224-235`
(`npm install --global --no-fund --no-audit ./norns-runner.tgz`) and
`:266-270` (`norns-runner start --ephemeral …`).

**What happens.** `npm install` reports success. It then has to place
`zod@3.x` — required by the bundled `@norns/contracts` — *nested* under
`@norns/runner`, because the hoisted top-level `zod` resolves to `4.4.3` (the
peer that `@anthropic-ai/claude-agent-sdk@0.3.216` pulls in). npm creates
`node_modules/@norns/runner/node_modules/zod` as an **empty directory** and
never extracts into it — it will not write inside a package that declares
`bundledDependencies`. `npm ls zod` claims `zod@3.25.76` is there; the
filesystem disagrees. Node's ESM resolver finds the empty directory first, so
`@norns/contracts/dist/plan.js` fails to import `zod` and the binary aborts
before printing its usage text.

**Reproduction (exactly what I ran):**

```
pnpm install --frozen-lockfile
pnpm -r run build
pnpm --filter @norns/runner pack:tarball        # -> apps/runner/dist-pack/norns-runner-0.1.0.tgz

mkdir /tmp/probe && cd /tmp/probe && npm init -y
npm install --no-fund --no-audit <repo>/apps/runner/dist-pack/norns-runner-0.1.0.tgz
ls -la node_modules/@norns/runner/node_modules/zod     # empty directory, no package.json
node node_modules/@norns/runner/dist/cli.js help
```

Result:

```
Error: Cannot find package '…/node_modules/@norns/runner/node_modules/zod/index.js'
  imported from …/node_modules/@norns/runner/node_modules/@norns/contracts/dist/plan.js
  code: 'ERR_MODULE_NOT_FOUND'
```

I reproduced this both with a plain project install and with
`npm install --global --prefix …`, which is the shape the workflow uses.
Observed with npm 11.16.0 / Node 26 locally; the mechanism is npm's reifier and
is not platform- or Node-version-specific.

**Two confirmations that this is the cause and not a local artefact:**

1. `rmdir node_modules/@norns/runner/node_modules/zod` and re-run — the CLI
   prints its usage text normally. The empty directory is the entire failure.
2. Repeat the install in a project that already has `zod@3.25.76` hoisted at
   the top level (so no nesting is required): no empty directory is created and
   the CLI runs. The failure appears only when npm must nest `zod` under a
   package that declares `bundledDependencies` — which is exactly the situation
   in a fresh Actions job, where nothing else pins zod and the agent SDK's
   `zod@4` wins the hoist.

**Why CI is green.** Nothing in the test suites installs the packed tarball.
`apps/server/test/runnerDistribution.test.ts` verifies the manifest, the hash
and the serving route; it never executes the artefact. The Dockerfile packs the
tarball (`Dockerfile:27`) but never installs it either.

**Impact.** Every GitHub-Actions-hosted run fails at the `Run the dispatched
Norns job` step. Nothing downstream of the runner — context fetch, gateway,
publication, conflict detection, live cost — can ever be exercised in
production until this is fixed. This is the whole program's happy path.

---

## WORTH FIXING BEFORE THE FIRST REAL RUN

### W1. `apps/server/test/actionsDispatchConcurrency.test.ts` is time-bombed and now fails permanently. **PROVEN**

`scheduleInputFor()` (`apps/server/test/actionsDispatchConcurrency.test.ts:181-182`)
hardcodes `issued_at: "2026-07-21T20:00:00.000Z"` /
`expires_at: "2026-07-21T20:15:00.000Z"`. The runner's expiry check
(`apps/runner/src/daemon.ts:430`) compares against the real clock, so from
`2026-07-21T20:15Z` onward every dispatched command in this file is acked
`expired`.

I instrumented a copy of the test: both runs sit in state `expired`, and the
headline assertion `run A succeeded` times out. Wall clock at the time of review
was `2026-07-21T20:24Z` — nine minutes past the window.

Full server suite on this branch: **1 failed | 843 passed | 8 skipped (852)**;
`Test Files 1 failed | 105 passed | 4 skipped (110)`. The single failure is this
test, and it reproduces deterministically when the file is run alone. This is
**not** the one-in-five flakiness recorded in BACKLOG.

A test defect, not a production defect — but CI is red from now on, and the E5
"two concurrent dispatches both run to completion" regression is no longer
actually being verified.

### W2. `NORNS_RUNNER_ALLOWED_MODELS` fails closed and has no production population path. **PROVEN (reading)**

**Reader:** `apps/server/src/server.ts:492-494` and `:567-569` call
`parseRunnerAllowedModels(integrationEnvironment[RUNNER_ALLOWED_MODELS_ENV])`.
`parseRunnerAllowedModels` (`apps/server/src/runners/inferenceProxy.ts:126-132`)
returns `[]` for absent/empty. `ProviderGateway.forward`
(`apps/server/src/gateway/providerGateway.ts:477-486`) then refuses every call
with `model_unavailable`.

**Writer:** none. `grep -rn NORNS_RUNNER_ALLOWED_MODELS` over the repo (excluding
`node_modules`) returns three source references and one line in `todo.md`. It is
**not** in `DEPLOY.md`, not in `docs/runbooks/*`, and not set anywhere in the
Dockerfile or any config.

Same shape as the previously-shipped "allowlist empty in production so every
path was rejected" defect. It fails safely (a 4xx refusal, not silent success)
and it is an operator variable rather than dead code — but an operator following
`DEPLOY.md` will have an execution stack in which every model call from every
agent is refused, with nothing telling them why. BACKLOG's E9-11 note covers
*alias vs resolved model id*; it does not cover *the variable is undocumented
and unset*.

Related: `DEPLOY.md` was not touched by this program at all, so
`NORNS_RUNNER_TARBALL_DIR`, `NORNS_RUNNER_PACKAGE` and
`NORNS_ACTIONS_NODE_VERSION` are likewise undocumented.

### W3. A missing runner tarball at boot reports itself as "postgres persistence unavailable". **INFERRED**

`apps/server/src/main.ts:283-285` calls
`formatRunnerTarballSpec(loadRunnerTarball(defaultRunnerTarballDir()))` inside
the `if (databaseUrl)` try-block, whenever GitHub is configured.
`RunnerTarballUnavailableError` is not one of the fail-closed error types tested
in the catch at `:490-519`, and `identityRuntime` has not yet been reassigned to
the relational runtime at that point (that happens at `:429`). A staging mistake
that omits `apps/runner/dist-pack` is therefore reported as

```
postgres persistence unavailable — production startup will be refused. reason: no usable runner tarball manifest in …
```

The deployment still fails closed in production (via `evaluateAuthStartup` with
`persistenceReady=false`), so this is a diagnosis problem rather than a safety
problem — but it points a human at the database when the database is fine.

### W4. The gateway credential is minted once per run and never re-minted; the comment says otherwise. **PROVEN (reading)**

`apps/server/src/gateway/credentials.ts:43-47` states "A run outliving this
re-mints; the runner does that automatically." It does not.
`apps/runner/src/cli.ts:140-154` memoizes the mint promise per `runId` in a
`Map` that is only ever evicted on a *failed* mint (`:150`), and
`ClaudeCodeRuntime.run` mints exactly once
(`apps/runner/src/runtimes/claudeCode.ts:154`).

TTL is 90 minutes (`GATEWAY_CREDENTIAL_TTL_MS`) and the default workflow
`timeout-minutes` is 60 (`actionsWorkflowTemplate.ts:148`), so the default
configuration is safe. Any deployment that raises `timeoutMinutes` above 90 (the
template accepts up to 360) gets a run whose model calls start 401ing mid-flight
with no recovery.

### W5. E12's integration conflicts can deadlock a phase, and there is no UI to resolve them. **PROVEN (reading)**

- Writer: `RunIntegrationConflictService.detect`, called in the publication
  transaction at `apps/server/src/coordinator/phase4EventProcessor.ts:380`.
- Gate: `apps/server/src/coordinator/phase4Completion.ts:87-97` refuses task
  completion while any `awaiting_human` row names the task.
- Resolution route: `POST /api/v2/run-conflicts/:conflictId/resolve`
  (`apps/server/src/server.ts:4457`).
- **No caller.** `grep -rn conflict apps/web/src/*.tsx` (excluding tests)
  returns nothing. The web app never calls `/conflicts`,
  `/run-conflicts/:id/resolve`, or `/concurrency`.

Detection is fail-closed on undeclared scope and does **not** require
`max_concurrent_tasks > 1`: two tasks in one phase dispatched off the same
`expected_revision`, both published, neither yet completed, is enough
(`runIntegrationConflicts.ts:293-311` — siblings are filtered on
`UNINTEGRATED_TASK_STATES`, not on concurrency). When it fires, both tasks
become uncompletable and the only exit is a hand-rolled HTTP call.

BACKLOG's E12-1 records that nothing declares file scope and that detection is
therefore noisy. It does not record that the resolution route has no UI caller,
which is what turns noise into a dead end.

### W6. E11's mid-run controls have no caller. **PROVEN (reading)**

The runner now genuinely handles `send_message`, `interrupt`, `cancel`,
`suspend`, `stop_after_current` (`apps/runner/src/daemon.ts:484-495`,
`apps/runner/src/liveRuns.ts:160-200`), and `ClaudeCodeRuntime` really does
stream input so `interrupt()` / `sendMessage()` work. The only server surface
that can issue them is the generic `POST /api/commands`
(`apps/server/src/server.ts:1472`), which requires a `runner_id`.

`grep -rn "api/commands|send_message|interrupt" apps/web/src` returns no
issuance. Nothing in the product emits any of these commands, and for an
Actions-hosted run the `runner_id` is a per-dispatch minted string
(`actionsDispatchRunnerId`) that is never surfaced to a human. The capability is
reachable only by an operator who reads the database.

BACKLOG lists "answering an agent mid-run" as *scoped as E11*. E11 has now
shipped the runner half and the protocol half, but not a caller.

### W7. `max_concurrent_tasks` cannot be changed through the product. **PROVEN (reading)**

`projects.max_concurrent_tasks` defaults to `1`
(`apps/server/src/persistence/v2/schema.ts:94`) and is read by
`phaseConcurrency.ts:101-105` and `phase4Coordinator.ts:243`. The only project
settings route, `PATCH /api/v2/projects/:id/settings`
(`apps/server/src/server.ts:3071-3080`), forwards exactly one field
(`update_interval_seconds`). No route, service, or UI writes the cap.

E12's headline capability — parallel agents within a phase — therefore cannot be
enabled without direct SQL. BACKLOG argues the cap *should* stay at 1 for now,
which makes this defensible; it is worth stating plainly rather than discovering
it when someone wants to raise it.

---

## NOTED, NOT BLOCKING

- **`RunIntegrationConflictService.openCountForTask`
  (`apps/server/src/coordinator/runIntegrationConflicts.ts:402`) has zero
  callers** outside its own file. Same shape as the previously-shipped
  "repository method with no production caller". Harmless, but dead.
- **`GatewayCredentialService.revokeRun`
  (`apps/server/src/gateway/credentials.ts:162`) has zero production callers.**
  A cancelled or superseded run's credential stays live until its 90-minute TTL.
  Generation fencing in `authorizeProxiedRunAccess` still refuses the call, so
  the impact is bounded. (BACKLOG E9-13 covers *purge*, not *revoke*.)
- **`TaskConflictScopeRepository` (`runIntegrationConflicts.ts:205`) is never
  constructed in `apps/server/src`.** BACKLOG E12-2 says "E12 shipped the
  writer"; the class exists but has no production construction site, so
  `task_coordination_constraints` still has zero writers in practice. Covered in
  substance by BACKLOG E12-1; recorded here because the E12-2 wording implies
  otherwise.
- **The workflow passes `--run "$NORNS_RUN_ID"`
  (`actionsWorkflowTemplate.ts:270`) and the CLI never reads `flags.run`**
  (`apps/runner/src/cli.ts`). Inert, but it looks load-bearing.
- **`StartPhaseControl` drops the `deferred` bucket.** The server returns
  `{scheduled, deferred, blocked}` (`phaseLaunchService.ts`), while the DTO
  (`apps/web/src/StartPhaseControl.tsx:29-33`) and the summary line (`:135`)
  know only `scheduled` and `blocked`. With the cap at 1 and several ready
  tasks, a human is told "1 scheduled, 0 blocked" and never learns the rest were
  queued.
- **`recordScope` runs after dispatch, in a separate transaction.**
  `phaseLaunchService.ts:492` writes the `dispatch_context_documents`
  authorization row *after* `ActionsExecutionCoordinator.schedule()` has already
  fired `workflow_dispatch`. In practice the job needs ~30-60s to check out and
  install before it fetches context, so the race is not realistic — but if
  `recordScope` throws, the job is already running and will 403 on every context
  fetch with no compensating action.
- **`pack-tarball.mjs` sets `GZIP=-n`** (`:120`) for reproducible hashes. Modern
  GNU gzip deprecates and ignores that variable, so the tarball is probably not
  byte-reproducible across builds. Cosmetic: the manifest is written from the
  bytes actually produced, so the served hash is always correct.

---

## Things I checked and found correct

Recorded so the next reviewer does not repeat them.

- **Migrations 0019-0024 grants.** Every new table has an explicit
  `REVOKE … FROM PUBLIC` / `FROM norns_app` followed by a `GRANT … TO
  norns_app`, and the granted verbs match the DML actually issued:
  `task_context_blobs` / `task_context_documents` are INSERT/SELECT only and the
  store only INSERTs (`taskContextStore.ts:68-76`);
  `dispatch_context_documents` has UPDATE and the writer uses
  `ON CONFLICT … DO UPDATE` (`dispatchContextScope.ts:42-45`);
  `gateway_credentials` has DELETE and `purgeExpired` uses it. 0022 and 0023 add
  no table (columns on `agent_runs`, and an index), so they correctly issue no
  grant. All six are registered in `runCurrentV2Migrations`
  (`persistence/v2/migrate.ts:496-524`).
- **`main.ts` wiring.** `execution` (`main.ts:425`) and `runnerInference`
  (`:428`) are both constructed and both passed to `buildServer` (`:671`,
  `:673`). Every service this program added is reachable from one of them:
  `TaskContextStore` / `RelationalTaskContextAssembler` /
  `DispatchContextScopeRepository` (`server.ts:4300-4308`), `PhaseLaunchService`
  (`:4363`), `PhaseQueueDrainer` (`:4393`, with its interval started and cleared
  in `onClose` at `:775`), `RunIntegrationConflictService` (`:4440`),
  `InferenceProxy` (`:488`), `GatewayCredentialService` / `ProviderGateway` /
  `registerGatewayRoutes` (`:554`-`:593`). No file added by this program lacks a
  non-test importer.
- **The runner-context signing mismatch is genuinely fixed.** Header names
  (`x-norns-runner-id`, `x-norns-runner-timestamp`), scheme (`Norns-Runner`),
  domain separator (`norns:runner-context-fetch:v1`) and the `\n` join all match
  between `apps/runner/src/contextAuth.ts:29-80` and
  `apps/server/src/execution/runnerContextAuth.ts:18-47`. The gateway mint route
  reuses the same verifier (`gateway/routes.ts:106`).
- **`workflow_dispatch` inputs.** `norns_job_id` / `norns_runner_id` /
  `norns_run_id` agree exactly between the template (`:167-178`) and
  `githubActions.ts:272`. `NORNS_APPROVED_ROOTS_JSON`,
  `NORNS_RUNNER_ENROLLMENT_TOKEN`, `NORNS_SERVER` and `GITHUB_TOKEN` all match
  the names the runner reads (`cli.ts:125,317`, `publication.ts:153-156`).
- **Actions workflow template shell injection.** Every remaining `${{ … }}`
  occurrence is in `env:` (`:243-256`), `concurrency.group` (`:193`),
  `run-name` (`:162`) or `with:` — none inside a `run:` block. Both `run:`
  blocks use `$VAR` indirection only, and `NORNS_APPROVED_ROOTS_JSON` is built
  with `node -e JSON.stringify` rather than string interpolation. I found no
  remaining injection point.
- **`run_published` enum.** The runner collapses `pushed` /
  `already_published` / `republished` to `pushed` and maps `local_only` through
  unchanged (`v2Execution.ts:1115`); the wire enum is exactly
  `["pushed","local_only"]` (`protocol.ts:135`); the server writes
  `publication_outcome` verbatim (`phase4EventProcessor.ts:355-368`). No reader
  keys a map on it.
- **`verification-policy:default-v1`** is the same literal in
  `packages/contracts/src/v2/commands.ts:418`,
  `apps/runner/src/verificationPolicies.ts:36`,
  `projectActivationService.ts:349`, `relationalReadRepository.ts:316` and
  `strategyBridgeService.ts:862`.
- **Live cost** reads `usage_events.phase_id` / `.run_id`
  (`attentionService.ts`), and `SqlInferenceMeter` writes both
  (`inferenceProxy.ts:584-600`).
- **The context `storage_ref`** the assembler mints
  (`taskContextAssembler.ts:598`) uses the same `TASK_CONTEXT_ROUTE_PREFIX` the
  route is registered under (`server.ts:4310`).
- **Runner distribution route** `/install/runner/:version/norns-runner.tgz` is
  registered (`server.ts:1600`) and version-exact-matched, and the workflow
  downloads exactly that path (`actionsWorkflowTemplate.ts:146`).

---

## Summary

- **BLOCKERS: 1.** B1 — the packed runner tarball installs but cannot execute,
  so no Actions-hosted run can start. Proven by reproduction.
- **WORTH FIXING BEFORE THE FIRST REAL RUN: 7.**
- **NOTED, NOT BLOCKING: 7.**

The "seventh dead-but-green path" the brief asked me to assume exists is B1: the
artefact is built, hashed, served, and verified by tests that never run it.

# Live-run gate for runner and coordinator changes

Every one of the 2026-08-21 failures (watchdog wedge, turn cap, sandbox 403,
stuck phase) shipped green through the unit suites and was found by a human
hitting a wall in the UI. The suites cannot see a real dispatch, a real
sandbox, or a real reconnect. This gate can.

**Rule:** a change under `apps/runner/`, `apps/server/src/coordinator/`,
`apps/server/src/devices/`, or `apps/server/src/planning/executionKickoff.ts`
is not done until one live run has passed end to end on the deployed server
with the packaged agent. Budget ~15 minutes wall-clock; most of it is waiting.

## 1. Deploy both halves

- Server: push `main`; confirm the build with
  `railway deployment list -s TheNorns --limit 1` (status `SUCCESS`, commit hash
  is yours). A `FAILED` build leaves the previous build serving — do not assume.
- Agent (only if `apps/runner` changed): `pnpm --filter @norns/runner build &&
  pnpm --filter @norns/runner pack:tarball && sh scripts/package-macos-agent.sh
  <version>`, install the pkg, then confirm
  `node scripts/agent-diagnose.mjs` shows the new version and a fresh start time.

## 2. Run the probe project

Use the `verify-live` pattern: an empty GitHub repo, a quick push whose task is
tiny but real (e.g. "add `src/add.js` and a `node --test` for it, with
`package.json` `test` script"). It must exercise install → code → **its own
test** → integrate. A task with no dependency install does not prove the
sandbox egress path; include one `npm install` of a real package.

Pass means, in order:

1. The task reaches `running` (dispatch accepted — a `rejected` here is the
   runner refusing; read the reason in the status line).
2. The agent finishes with a closing summary, not mid-sentence
   (`agent-diagnose` → "last assistant text"; compare "tool calls" to the
   dispatch's `max_turns`).
3. Verification passes on the runner's auto-detected or configured commands.
4. `main` on the probe repo advances to the integrated commit.

## 3. Exercise the recovery edges that bit us

- **Stop / restart:** press Stop on a running task, then restart the agent
  (`launchctl kickstart -k gui/$(id -u)/com.thenorns.local-agent`) and dispatch
  again. The new dispatch must be accepted. (Guards the cancellation-replay
  wedge.)
- **Failed run releases the phase:** let one task fail (e.g. a deliberately
  broken test), wait one recovery scan (60 s), then approve a new plan. It
  must start instead of being refused as "already executing".

## When it fails

`node scripts/agent-diagnose.mjs` first. It prints the last dispatch outcomes,
any cancellation-journal entry that will replay on reconnect, leftover
worktrees, and the last coding session's final command, tool result, and
message. That output answered every question asked on 2026-08-21.

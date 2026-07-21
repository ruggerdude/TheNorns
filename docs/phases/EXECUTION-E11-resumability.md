# EXECUTION E11 — ask-then-resume: design note

Status: **design + runner-side foundation only.** Everything requiring a
contract field, a coordinator decision, or a stored row is listed at the end as
routing, not built. Written before the code, per the phase brief.

## The problem, stated precisely

A GitHub Actions job has a ~6-hour ceiling and bills wall-clock time. An agent
that stops to ask a human a question and then waits is therefore paying a
runner-minute rate for a human-response latency measured in hours, and will be
killed by the job timeout before most humans answer. E11's `send_message` makes
a mid-run answer *deliverable*; it does not make waiting *affordable*.

The intended shape is instead: **the agent records its question, the job ends
cleanly, and a later job resumes with prior context once the human answers.**
The run therefore has to survive the death of the machine that was running it.

## What must persist for a resume to be faithful

Five things, and they are not equally hard.

1. **The repository state.** Already solved, and solved well. E4's `GitPublisher`
   pushes the run's branch to the remote before the worktree is destroyed, and
   `GitWorktreeManager.prepare` uses `switch -C` so a later attempt converges on
   the same branch rather than colliding with it. A resuming job checks out the
   published branch instead of `expected_revision`. **Cost: a dispatch field
   saying which commit to resume from. No new mechanism.**

2. **The runtime session.** This is the gap that made the whole feature
   impossible and is the one thing E11 fixed at the runner. `ClaudeCodeRuntime`
   and `CodexRuntime` have always *returned* a `sessionId` (the Claude Code
   session, the Codex thread) and `V2RunnerExecutor` has always **discarded it
   within milliseconds, on a machine about to be deleted.** Both adapters have
   likewise always accepted `resumeSessionId` / `resumeThreadId` and nothing has
   ever set either. The executor now returns `session_id` and emits it as a run
   log so it at least reaches the durable event stream.

   **Caveat that must not be glossed:** a session id is a *pointer into
   provider-side or local state*, not the state itself. Claude Code's session
   transcript lives under the runner's `HOME`; Codex's thread lives with the
   Codex CLI's local state. On an ephemeral Actions runner both are destroyed
   with the job, so **a session id alone does not resume anything there.**
   Resuming faithfully on ephemeral infrastructure needs either (a) the
   provider to hold the session server-side and honour the id from a new
   machine, or (b) the transcript to be archived as an artifact and restored.
   This needs verification per provider before anyone promises it. On a
   *laptop* runner the id is sufficient today, because the state never left.

3. **The question and its answer.** There is no representation of "the agent is
   blocked on a human" anywhere in the system: no run status (`RunStatus` is
   `started|paused|resumed|completed|failed|cancelled`), no event payload, no
   column. `paused` is the closest and it means something else — the fixture's
   pause. Without this the coordinator cannot tell an ask-shaped ending from a
   crash, and the human is never prompted.

4. **The prompt continuity.** E1's assembler builds a task prompt from scratch
   each dispatch. A resumed run needs the original prompt *plus* the question
   and the answer, or the agent re-derives its plan and the "resume" is a
   restart wearing a hat. If (2) cannot be relied on across machines, this
   becomes the actual load-bearing mechanism: replay the conversation as text.

5. **Usage and budget continuity.** The resumed run must charge the same
   reservation, or a task that asks three questions silently gets four budgets.

## How the relay's existing machinery helps, and where it obstructs

**Helps.**

- *Durable event buffering and watermark replay.* The runner buffers events to
  disk and replays from the server's ack watermark, so the question event and
  the session-id log survive a disconnect between the agent's last word and the
  job's death. This is exactly the durability an ask needs, already built.
- *Command dedup.* A resumed dispatch is a new `command_id`; a redelivered one
  is answered from the recorded outcome rather than re-executed. Resume cannot
  accidentally double-run.
- *Convergent publication.* Re-publishing the same branch is idempotent
  (`pushed` / `already_published` / `republished`), so a resumed run that
  re-pushes does not fork the work or open a second PR.

**Obstructs.**

- *Generation fencing is per-runner, and an ephemeral runner is per-job.* Each
  Actions job enrolls a **new runner id and generation**; the resuming job is a
  different runner from the asking one. Any resume state keyed to the runner is
  therefore unreachable by the job that needs it. **Resume state must be keyed
  to the task/run, never to the runner.** This is the single most likely way to
  build this wrong.
- *`onRunSettled` collapses every terminal state into "the job may exit".* An
  ephemeral runner exits as soon as its one `launch_run` settles. An ask-shaped
  ending has to be a distinct settlement the coordinator can act on, or it is
  indistinguishable from a failure and gets retried rather than answered.
- *The dedup store is the runner's local disk.* On an ephemeral runner it is
  born and dies with the job, so it cannot carry anything across the gap.

## What the coordinator must do

1. Recognise an ask-shaped terminal state and put the task into a *waiting on
   human* state rather than failed — including deciding whether that pauses the
   phase, and what the budget reservation does while nobody is answering.
2. Store the resume record — commit, session id, question, answer, reservation —
   against the **task**, not the runner.
3. Surface the question in the attention-first dashboard and collect the answer.
4. On answer, dispatch a new job carrying the resume record, and re-assemble the
   prompt to include the prior conversation.
5. Decide the expiry policy. A question nobody answers for a week must not hold
   a budget reservation open forever.

## What it would cost

Wall-clock, in this working model, with the runner half already landed:

- **Contracts** (additive fields + an ask-shaped run status): under an hour of
  implementation; gated entirely by PM approval, since contracts are frozen and
  the PM is sole approver.
- **Coordinator + persistence** (state, migration with grants, resume dispatch):
  one to two sessions. The genuinely slow part is not the code, it is deciding
  the budget/expiry semantics in item 1 — that is a product decision and will
  gate the calendar more than the implementation does.
- **Prompt continuity in E1's assembler**: about a session, mostly test work.
- **UI for asking and answering**: one session.
- **Verifying cross-machine session resume per provider** (the caveat in §2):
  unknown until someone tries it against a real provider from a second machine.
  Budget a session for the experiment and be prepared for the answer to be "no,
  replay the conversation as text instead", which is item 4's fallback.

Total: roughly three to five sessions of implementation, plus the human decision
on budget-while-waiting, which is the real gate.

## What E11 actually built

- `V2RunnerExecutionResult.session_id`, populated from the runtime's own report
  at every exit — including the cancelled and failed exits, because the run a
  human most wants to resume is rarely the one that succeeded.
- The session id emitted as a `run_log`, which is today the **only** durable
  channel out of an ephemeral runner for this value.
- `RunnerRuntimeContext.resumeSessionId`: the seam a resuming dispatch will use,
  ready and unpopulated. The runtime adapters have accepted a resume id since
  they were written; from here it is one field on the dispatch command away.

## What E11 deliberately did not build

No ask-shaped run status, no resume record, no coordinator behaviour, no
dispatch field, no prompt continuity. All of it needs a contract change or lives
in `apps/server/src/coordinator/**`, which E11 does not own. Routed to the PM.

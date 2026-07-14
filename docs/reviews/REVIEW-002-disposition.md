# REVIEW-002 Disposition — Round-2 Independent Review of PLAN.md (R3)

**Date:** 2026-07-13 · **Verdict received:** Approve with minor changes (no P0s)
**Disposition:** All five P1s accepted; P2s accepted except one modified
(P2-5) and two deferred post-MVP (P2-6/7). Project Memory proposal accepted
into MVP in a deliberately minimal form. PRD revised to **R4**. Reviewer's
recommendation to stop broad architecture reviews and switch to phase-gate
reviews (after 1A, 3, 5, 7) is adopted — it matches the build plan's
existing review cadence.

## P1 findings — all accepted

| ID | Finding | Resolution in R4 |
|---|---|---|
| P1-1 | Runner is omnipotent; no runner/sandbox/PM trust boundary | New **Runner Trust Contract** section: exclusive capabilities per component (runner: worktrees, credential injection, container launch, push; sandbox: edit/test/commit; PM: intents only) and a "never" list (no raw shell on host, no worker pushes, no agent-side credential handling) |
| P1-2 | Planner-authored `test_commands` can weaken verification | Verification split: **project-level Required Verification Commands**, defined at repository registration outside the Plan Contract and changeable only via human approval, always run by the runner; plan-level `test_commands` are **additive only** — they can extend, never replace or reduce, required verification |
| P1-3 | Conflict-node dependency semantics undefined | Stated explicitly: the conflict node **replaces** the original — outgoing edges move to it, the original is archived (`superseded`), downstream scheduling keys on the replacement |
| P1-4 | DecisionRecords lack supersession | Added `supersedes` / `superseded_by` / `status: active \| obsolete`; PM summaries draw only on active records |
| P1-5 | No contingency in the estimate | Estimate restated: **40–65 expected + 15–25 contingency** (provider/SDK churn, runtime bugs, rework) |

## P2 suggestions

| ID | Suggestion | Disposition |
|---|---|---|
| P2-1 | Version the graph, not just the plan | **Accepted** — Workflow carries a graph version, bumped on structural edits; execution references a specific version |
| P2-2 | PM timeline view | **Accepted** — cheap render of the existing event log; added to dashboard spec |
| P2-3 | Live cost burn rate | **Accepted** — derivative of the usage ledger; added to dashboard spec |
| P2-4 | Repository health indicators | **Accepted** — dirty/ahead/behind/untracked/conflict surfaced from the runner's git status |
| P2-5 | PM confidence percentage | **Modified.** A numeric "93% confidence" would be fabricated precision from the same class of LLM self-report the spec bans elsewhere. Adopted the valuable half: completion badges carry **provenance** ("two independent reviews agreed; runner verification green") — evidence, not an invented number |
| P2-6 | Prompt library | **Deferred post-MVP** (reviewer's own framing: "eventually"); on the backlog |
| P2-7 | Transcript search | **Deferred post-MVP**; transcripts are already stored immutably, so search is retrofit-safe |

## Round-2 answers — items adopted

- **Q2:** every command/event envelope now carries `correlation_id` (thread
  of related activity) and `causation_id` (the message that directly caused
  this one), alongside `command_id`/`event_seq`.
- **Q6 naming:** the lifecycle state `review` is renamed **`in_review`** to
  stop colliding with the `Review` entity; `verified` unchanged.
- **Q7 pause controls:** all five control semantics remain in the protocol
  and capability matrix; the **UI defaults to Interrupt and Cancel**, with
  the rest behind an advanced menu. The runner maps UI intent to declared
  runtime capability.

## Project Memory — accepted into MVP (minimal form)

The reviewer's late addition is adopted; it fits the PM-is-the-product
thesis and costs little: a per-project, human-approved list of standing
directives ("never refactor combat.py without approval", "pytest only",
"no auto-installed dependencies") that the engine injects verbatim into
**every** agent context — PM, planner, reviewer, lead, worker, QA. Entries
are versioned and auditable; edits are human-approved (a DecisionRecord can
promote itself into memory). Deliberately **not** in MVP: automatic memory
extraction/learning from transcripts — post-MVP.

Placement: schema in the Phase 0B contracts freeze; injection wired in
Phase 3 (first phase where agent prompts exist).

## Process going forward

No further broad architecture reviews. Phase-gate reviews after 1A, 3, 5,
and 7 plus pre-pilot, validating implementation against this architecture.
The design is approved to begin implementation once the human accepts the
three ADRs (NORN-007).

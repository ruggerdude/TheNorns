# Phase 5 Candidate Evidence — Attention-first Execution Mode

Date: 2026-07-16

Status: implementation complete under the human owner's manual-gating policy.
Candidate branch: `refoundation/phase5-attention-execution`.
Implementation commit: `93b5b7b7642858bd3ad5f59d2f58aba764f713e8`.
Phase 4 baseline: `222a219`.

## Delivered

- An authenticated portfolio projection that answers “What needs your
  attention?” from normalized V2 state rather than the legacy demo dashboard.
- Ranked attention for open decisions, strategy approvals, blocked tasks,
  failed or expired runs, ambiguous budget reservations, and phase
  completions.
- Stable attention identity and a material source fingerprint. Acknowledgement
  and snooze survive projection rebuilds while the condition is unchanged;
  changed material re-raises the item immediately and only once per new
  fingerprint.
- Persistent per-user attention disposition in PostgreSQL with restricted
  application-role grants.
- Project health summaries containing the current phase, task progress, active
  runs, attention counts, and the next recommended action.
- A canonical phase-execution projection covering task state, dependencies,
  assignment, designated run, verification, commit, evidence, failure, and
  progress.
- Authenticated endpoints for portfolio attention, attention disposition, and
  project-scoped phase execution.
- An attention-first landing page with one-action project resume,
  acknowledgement, and one-hour snooze controls.
- A live phase monitor with bounded five-second project-scoped polling. The
  portfolio projection polls every ten seconds.

## Projection and interruption semantics

Attention item identity is derived from project, source entity type, source
entity ID, and condition class. Its fingerprint is derived only from the
condition's material fields. Projection rebuild therefore does not resurrect
an acknowledged or snoozed condition, while a changed source condition is not
hidden behind the earlier disposition.

The projection suppresses redundant task-level blockers when an open
DecisionPoint or failed designated run already represents the same work. The
result emphasizes the smallest actionable interruption set rather than asking
the human to manage duplicate project-management records.

## Verification evidence

- Phase 5 attention service tests: 3 passed, including acknowledgement across
  rebuild, snooze across rebuild, immediate re-raise after a material change,
  and canonical phase projection.
- Phase 5 authenticated API test: 1 passed.
- Phase 5 web interaction tests: portfolio attention and phase execution are
  included in the full web suite.
- Full web suite: 16 files and 40 tests passed.
- Full `pnpm run ci`: passed.
  - Contracts: 13 files, 107 tests passed.
  - Server: 61 files and 361 tests passed; 4 environment-gated files and 8
    environment-gated tests skipped.
  - All lint, build, and typecheck gates passed.
- Local in-app browser pass: authenticated portfolio rendered cleanly with no
  browser errors or warnings. The memory-mode development server correctly did
  not fabricate normalized Phase 5 data; normalized populated-state rendering
  is covered by deterministic component and service tests.

## Exit-gate disposition

Phase 5's authorized outcome is complete:

1. the landing page prioritizes the human's current attention;
2. acknowledgement and snooze semantics are durable and fingerprint-aware;
3. existing projects resume from persistent state in one action;
4. canonical phase execution state is visible without a demo endpoint; and
5. live updates are project-scoped and bounded.

No additional automatic architecture-review hold is applied under the human
owner's manual-gating direction.

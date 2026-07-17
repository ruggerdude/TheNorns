# Phase 1 Candidate — Independent Contract and Persistence Review (Findings of Record)

**Reviewer:** Claude Fable 5 · Independent Architecture and Product Reviewer
**Date:** 2026-07-16
**Candidate:** `7244dd8430128b99acb8e5facc4d7575ff3e05a8` · branch `refoundation/phase1-domain-persistence`
**Governing:** Program Charter, ADR-004–007, REFOUNDATION-PROGRAM, PHASE-1-BRIEF, REFOUNDATION-REVIEW-FINDINGS + DISPOSITION, PHASE-1-CANDIDATE-EVIDENCE
**Review type:** Read-only cross-provider Phase 1 gate. No files edited, no fixes implemented. Phase 2 not authorized.

## Method and packaging note

All candidate files named in the packet were read. Claims were verified against source rather than against the evidence file's summary; the DDL, contracts, adapters, and their tests were cross-checked against each other. The suite was **not executed** — reported pass counts are as claimed. Findings cite file and symbol at the candidate commit.

**Packaging caveat (repeat of REF-REC-14):** the archive is an unpinned working tree with no `REVIEW_COMMIT.txt` and no VCS metadata, so I cannot independently confirm it corresponds to `7244dd8`. The docs-only Phase 0 archive did carry that marker; this one should too. Attach `git rev-parse HEAD` and `git status --short` to the disposition.

**On the prior gate:** the disposition of the Phase 0 review is exemplary — 18 of 18 recommendations accepted, none rejected, downgraded, or deferred; four human decisions recorded before authorization; the tabletop pause test performed; the corrections to REF-REC-5 (GitHub's one-hour token floor) and REF-REC-14 (tree-object identity rather than "docs/ only") are places where Sol was right and the finding was imprecise. That is the disposition process working as designed.

## What the candidate gets right

Named because these should not be re-opened, and because the defects below are narrow by comparison:

- **REF-REC-2 is closed cleanly.** `v2CommandIdForDispatchJob()` derives command identity from the job ID, the contract rejects any other value, and `dispatch_jobs_command_unique` plus the `commands` FK enforce it in the database. Redelivery cannot mint a second command.
- **REF-REC-10 is closed structurally.** `task_dependencies` uses composite FKs into `tasks (project_id, phase_id, id)` for both endpoints — cross-phase and cross-project edges are unrepresentable, not merely validated.
- **REF-REC-1's chokepoint is stronger than recommended.** Beyond fold-vs-row reconciliation, an open finding *quarantines* the aggregate (`assertV2AutomationAllowed`), and `invalid_event_sequence` is treated as a mismatch class — closing the rejected-event hole the reducer could otherwise hide.
- **Append-only history is enforced in the database**, not by convention (`norns_reject_append_only_mutation` triggers) — the Q4 suggestion from the prior review, implemented.
- **Materialization is deterministic and hash-bound.** Re-materializing an approved strategy yields byte-identical IDs; the content hash is recomputed server-side and checked against both stored and approval hashes.
- **The SQL adapters are exercised against a real Postgres engine** (PGlite) running the real migration — not fakes. Q19's honest answer is "no" with one exception, covered in PH1-REC-1.
- **Scope discipline held.** `main.ts` contains no V2 wiring; the legacy adapter is untouched as production default; no import, cutover, or execution work leaked in. Q17/Q18 pass.
- **Budget terminal outcomes exceed REF-REC-16**, adding `ambiguous_execution`/`retained_ambiguous` for the case where usage cannot be determined — a category I did not ask for and should have.

---

## Blocking findings

```text
ID: PH1-BLOCK-1
Tier: Blocking
File/location: apps/server/src/persistence/v2/sqlRepositories.ts — SqlV2DecisionPointTransaction.supersedeAndInsertDecisionPoint(); reached via upsertV2DecisionPoint() in persistence/v2/application.ts
Finding: Supersession unconditionally writes `SET status = 'superseded'` onto the prior DecisionPoint, including one a human already resolved or dismissed. Supersession and disposition are orthogonal facts — the former is already carried by the `superseded_by_decision_point_id` link — but the status column is overwritten with the link's meaning, destroying the record of what the human decided.
Why it matters: DecisionPoints are the charter's human-interruption mechanism and the audit record of human judgment. `status` is the load-bearing field: it carries a CHECK constraint, it keys the `decision_points_open_condition_unique` partial index, and ADR-007's Resume/"recent decisions" and Attention projections will filter on it. Overwriting `resolved` with `superseded` silently deletes a human decision from every status-driven query. The overwrite is also unnecessary — the partial unique index only constrains `status = 'open'`, so inserting the new revision needs no change to a closed row at all.
Concrete failure scenario: The human resolves DP-1 ("integration conflict on task T — merge strategy A"). A DecisionRecord is written. The condition's material state later changes; the coordinator upserts the same condition_key with a new fingerprint. DP-1 flips from `resolved` to `superseded`. The project's decision history now shows the human never decided it; only `resolved_at` and a join to `decision_records` reveal otherwise, and nothing in the schema tells a future reader to distrust `status`.
Recommendation: Supersede the status only when the existing row is `open`. For `resolved`/`dismissed`, insert the new revision and set the `supersedes`/`superseded_by` links, leaving the disposition intact. Add a CHECK or trigger forbidding any transition out of `resolved`/`dismissed`, so the invariant survives future callers.
Acceptance test: A resolved DecisionPoint whose condition fingerprint then changes retains `status='resolved'`, gains `superseded_by_decision_point_id`, and the new revision opens at `condition_revision + 1`. A direct attempt to write `resolved -> superseded` is rejected by the database. (Note: the existing PGlite test covers resolved + *unchanged* fingerprint → `closed_unchanged`; the changed-fingerprint case is untested.)
```

---

## Recommended findings — P1

```text
ID: PH1-REC-1
Tier: Recommended (P1) — required before final Phase 1 freeze
File/location: apps/server/test/v2Application.test.ts, apps/server/test/v2SqlRepositories.test.ts (PGlite); apps/server/src/persistence/v2/database.ts (NodePgTransactionRunner); apps/server/test/v2Database.test.ts (RecordingClient mock)
Finding: Every concurrency claim in the evidence packet is unproven, because the test substrate structurally cannot produce concurrency. PGlite is a single-connection engine: `pglite.transaction()` serializes. The "coalesces concurrent duplicate callers" tests therefore demonstrate *sequential replay*, not coalescing — which their own assertions reveal, since a genuinely concurrent loser would return `command_in_progress`, not `replayed`. Worse, `pg_try_advisory_xact_lock` is re-entrant within a session, so on one connection it always returns true and its contention behavior is never exercised. The one test of the `command_in_progress` path hard-codes `lockAvailable = false` in a test double. Separately, the production `NodePgTransactionRunner` is verified only against a mock client that records BEGIN/COMMIT strings; no test opens a real connection.
Why it matters: REF-REC-13's disposition made concurrent tests mandatory at this gate, and program control #10 requires production-shaped exit gates to use PostgreSQL. The correctness backstop is real — `PRIMARY KEY (actor_id, command_family, idempotency_key)` makes double-mutation structurally impossible even if the advisory lock does nothing — so this is an evidence defect, not a known correctness defect. But the advisory lock is precisely what converts an ugly unique-violation exception into a graceful retriable conflict, and that conversion is what is unproven.
Concrete failure scenario: The lock key scope or hash is subtly wrong (e.g., collision handling, or acquisition ordering relative to the SELECT). In production, two real connections issuing the same command produce a raw 23505 unique violation surfacing as a 500 rather than the designed `command_in_progress`. Every Phase 1 test still passes, and Phase 4's dispatcher-crash proof — also concurrency-shaped — inherits the same blind substrate.
Recommendation: Add a real PostgreSQL service to CI (a container is sufficient) and re-run exactly the concurrency-dependent assertions against it with two pooled connections: advisory-lock contention returning `command_in_progress`, `FOR UPDATE` blocking, and the `NodePgTransactionRunner` BEGIN/COMMIT/ROLLBACK path. Keep PGlite for the fast suite. Mark in the evidence file which assertions are single-connection-only, so Phase 4 does not inherit the assumption silently.
Acceptance test: With two connections against real PostgreSQL, a duplicate command issued while the first is mid-mutation returns `command_in_progress` (not an exception, not a second mutation); `mutations === 1`; and the same suite run through `NodePgTransactionRunner` passes.
```

```text
ID: PH1-REC-2
Tier: Recommended (P1) — required before final Phase 1 freeze (schema is frozen for Phase 2; changes after freeze are forward-only)
File/location: apps/server/drizzle/0001_refoundation_v2.sql — domain_events / audit_events FK definitions vs. the norns_reject_append_only_mutation triggers
Finding: The append-only guarantee is contradicted from two directions. (a) `domain_events` and `audit_events` declare `project_id/phase_id/task_id ... ON DELETE CASCADE`, which instructs Postgres to delete history rows — while the BEFORE DELETE trigger raises 55000 on exactly that. The DDL states an intent the trigger forbids; the two cannot both be right. (b) The triggers are `BEFORE UPDATE OR DELETE ... FOR EACH ROW`, and **TRUNCATE fires neither** — so `TRUNCATE projects CASCADE`, or a test/ops helper truncating history directly, silently destroys the entire audit and domain history with no error.
Why it matters: This is the immutable record that REF-REC-1, the disposition authority rule, and the whole audit posture rest on. One hole is a lie the schema tells (cascade will never work), the other is a hole in the guard itself (truncate walks straight through). Both are near-free to close now and are migration-only changes later.
Concrete failure scenario: (a) A Phase 2 rollback or Phase 7 retirement routine deletes a project row and aborts mid-transaction with "domain_events is append-only; DELETE is forbidden" — an error message that names the wrong culprit and sends someone hunting through triggers. (b) A test-teardown helper standardizes on `TRUNCATE ... CASCADE` for speed; it is later reused against a shared environment and erases history the triggers were installed to protect.
Recommendation: Change the history FKs to `ON DELETE RESTRICT` (or NO ACTION) so the schema states the real rule and produces an honest FK error. Add statement-level `BEFORE TRUNCATE` triggers on both tables. Implement the production role grants the file's own comment already prescribes (INSERT/SELECT only), so ownership privileges are not the only thing standing between a bug and the audit trail.
Acceptance test: Deleting a project that has history fails with a foreign-key violation naming `domain_events`; `TRUNCATE domain_events` and `TRUNCATE projects CASCADE` are both rejected; the append-only tests run under the restricted production role, not the table owner.
```

```text
ID: PH1-REC-3
Tier: Recommended (P1) — required before final Phase 1 freeze
File/location: apps/server/drizzle/0001_refoundation_v2.sql — tasks.state / agent_runs.state (`TEXT NOT NULL`, no default, CHECK admits every enum value); apps/server/src/persistence/v2/reconciliation.ts — reduceV2TaskLifecycle("pending", 0, ...) / reduceV2AgentRunLifecycle("created", 0, ...)
Finding: Reconciliation folds every history from a hard-coded origin — `pending`/0 for tasks, `created`/0 for runs — but nothing in the schema requires a row to be created there. `materializeV2StrategyVersion` happens to comply today; the invariant lives in one function, not in the database.
Why it matters: This is the load-bearing assumption behind packet Q8 ("can lifecycle rows be reproduced from recorded transition events?"). If any future writer inserts a task at `ready` or a run at `dispatched` with `lifecycle_version = 0` and no origin event, the fold disagrees with the row, reconciliation raises `state_mismatch`, and the quarantine then *blocks all automation on that aggregate* — a correctly-behaving safety mechanism firing on a false positive, hard-stopping real work.
Concrete failure scenario: Phase 2's legacy import materializes tasks whose graph state was already in flight and inserts them at `in_progress`/0 to preserve fidelity. Every such task reconciles as a mismatch and is quarantined on arrival; migration reports thousands of integrity findings that are actually an origin-convention mismatch.
Recommendation: Pin the origin in the schema: `CHECK (lifecycle_version > 0 OR state = 'pending')` on tasks and `CHECK (lifecycle_version > 0 OR state = 'created')` on agent_runs. If Phase 2 needs to import mid-lifecycle rows, the correct answer is a synthesized origin event chain, not a naked row — and this constraint forces that conversation now rather than in the middle of migration.
Acceptance test: Inserting a task at any state other than `pending` with `lifecycle_version = 0` is rejected by the database; the same for agent_runs and `created`; reconciliation over a freshly materialized strategy reports zero findings.
```

```text
ID: PH1-REC-4
Tier: Recommended (P1) — required before final Phase 1 freeze
File/location: packages/contracts/src/v2/domain.ts — v2MaterializedId() / materializeV2StrategyVersion(); V2StrategyVersion.supersedes_strategy_version_id; V2Task.strategy_version_id
Finding: Materialized entity identity is derived from the *strategy version* ID (`task:<strategy_id>:<local_id>`). ADR-004 §5 requires that changing an active phase proceed by amendment — a new StrategyVersion superseding its predecessor. Materializing that amendment necessarily produces a wholly new task ID set; the "same" task cannot keep its identity, history, runs, or evidence across an amendment. The schema anticipates amendments (`supersedes_strategy_version_id` exists); the ID scheme forecloses them.
Why it matters: This is the direct answer to packet Q20 (contract decisions forcing avoidable rework). Determinism is the right instinct and should be kept — but keying it on the strategy version rather than the phase means amendment support requires either an ID migration across frozen contracts, or a task-remapping layer, both of which land after Phases 2–3 have built on these IDs. Fixing it now costs one line of the key function.
Concrete failure scenario: Phase 3 implements "amend an active phase." The amendment adds one task and changes another's acceptance criteria. Materialization emits an entirely new task set; the four completed tasks and one in-flight run under v1 are orphaned. The implementer's cheapest exit is to make amendment a phase-replacement — silently reintroducing the plan-replaces-project defect that ADR-004 exists to eliminate.
Recommendation: Key materialized identity on `(phase_id, local_id)` — `task:<phase_id>:<local_id>` — retaining full determinism while letting an amendment update the same rows and bump the existing `strategy_version_id` provenance field. Alternatively, declare phase amendment out of MVP scope in ADR-004 and record the ID scheme as the reason. Either is acceptable; silence is not, because Phase 3 will hit it.
Acceptance test: Materializing an amendment StrategyVersion for a phase preserves the IDs of unchanged tasks, updates their strategy_version_id, adds only genuinely new tasks, and leaves completed tasks and their evidence intact — or ADR-004 states that amendments are out of scope and the phase-strategy relationship is one-shot for the MVP.
```

```text
ID: PH1-REC-5
Tier: Recommended (P1) — required before final Phase 1 freeze (contract semantics)
File/location: apps/server/src/persistence/v2/application.ts — executeV2ApplicationCommand() commit path; v2ExpectedVersionConflict()
Finding: Business failures commit as `committed_failed` with the response stored for replay — a correct reading of REF-REC-13's "pick one and state it." But the same path swallows *retriable* failures: `v2ExpectedVersionConflict()` returns `outcome: "failed"` with HTTP 409, which is then permanently bound to that idempotency key. A caller who retries an optimistic-concurrency conflict — the canonical retry case — receives the stale 409 forever.
Why it matters: Optimistic concurrency exists to be retried after re-reading. Under this design the retry must carry a *new* idempotency key, or it is guaranteed to fail identically. That contract is not written down anywhere a Phase 4/5 client author would find it, and the failure is silent: the client sees a plausible 409 and re-reads and retries in a loop that cannot succeed.
Concrete failure scenario: The Phase 5 UI issues ApproveStrategyVersion with a per-user-action idempotency key, gets 409 (version moved), refreshes, and retries with the same key. It replays the stored 409 against fresh state. To the user, approval is permanently broken for that action and correct after a page reload — the worst kind of bug to diagnose.
Recommendation: Distinguish terminal business failures (stored and replayed — validation rejection, authorization denial) from retriable conflicts (not stored: release the key, or store with a `retriable: true` marker that permits re-execution on the same key with a matching fingerprint). State the chosen rule in ADR-005 and in the contract's doc comment, since every future client depends on it.
Acceptance test: A command that fails with `optimistic_concurrency_conflict` and is retried with the same idempotency key after the aggregate version advances executes against current state rather than replaying the stale conflict; a command that fails validation and is retried with the same key replays the original rejection.
```

---

## Recommended findings — P2

```text
ID: PH1-REC-6
Tier: Recommended (P2) — before any ORM-mediated write lands; no later than Phase 4
File/location: apps/server/test/v2ArchitectureFitness.test.ts
Finding: The fitness guard is a regex for raw `UPDATE tasks|agent_runs ... SET ... state|lifecycle_version` over `apps/server/src` only. It is blind to the Drizzle query builder (`db.update(tasks).set({ state }))`) — and `persistence/v2/schema.ts` declares the full Drizzle table set and re-exports it from `index.ts`, so that is the idiom an implementer will most naturally reach for. It is equally blind to dynamic SQL, CTE-wrapped updates, and anything outside `apps/server/src`.
Why it matters: The guard is advertised as enforcing REF-REC-1's chokepoint. Reconciliation is the real backstop and would catch the resulting divergence after the fact, which is why this is P2 rather than P1 — but a guard that passes green while the actual bypass route stands open is worse than no guard, because it is cited as evidence.
Concrete failure scenario: Phase 4's coordinator work uses Drizzle for a "quick" task-state update outside the chokepoint. The fitness test stays green. The divergence surfaces later as a reconciliation finding that quarantines a live task mid-execution.
Recommendation: Extend the pattern to the ORM surface (`.update(tasks)`, `.update(agentRuns)`), widen the scan to all workspace source, and — the durable fix — assert the *positive* property instead: that only `sqlRepositories.ts` imports the lifecycle table symbols from the Drizzle schema.
Acceptance test: A deliberately added Drizzle `update(tasks).set({ state })` outside the guarded adapter fails the fitness test.
```

```text
ID: PH1-REC-7
Tier: Recommended (P2) — before final Phase 1 freeze
File/location: apps/server/src/persistence/v2/application.ts — the `mutate()` contract
Finding: A `mutate()` returning `outcome: "failed"` still commits the surrounding transaction, so any domain writes it performed before deciding to fail are committed alongside the stored failure response. The convention that a failing mutate writes nothing is documented nowhere and enforced by nothing.
Why it matters: Only exceptions roll back. The distinction between "returned failed" and "threw" is invisible at the call site and easy to get wrong under Phase 4's larger command handlers.
Concrete failure scenario: A handler inserts a dispatch job, then detects a budget shortfall and returns a failure result. The job commits; the response says the command failed; a dispatcher picks the job up.
Recommendation: Document that `mutate()` must be write-free on any failure path, and add one test asserting that a mutate which writes and then returns `failed` leaves no domain rows behind — or, more robustly, use a savepoint around `mutate()` and roll back to it on a failed outcome before writing the idempotency response.
Acceptance test: A mutate that inserts a row and returns `outcome: "failed"` commits the idempotency failure record and no domain row.
```

---

## Open questions

```text
ID: PH1-OPEN-1
Tier: Open question
File/location: ties PH1-REC-2
Question: Must a project ever be hard-deletable — for an erasure request, a mis-created project, or environment teardown — or is archive-only acceptable permanently? The answer decides whether PH1-REC-2's fix is simply RESTRICT (never delete), or RESTRICT plus a designed, audited, privileged purge path. Reviewer leans archive-only for the MVP, with hard delete as a named later ADR if a real need appears; but this touches data-retention posture, which is the human's call, not the architecture's.
```

---

## Verdict

```text
Verdict: Approve with required changes

Phase 1 blockers:
  PH1-BLOCK-1 — DecisionPoint supersession overwrites a human's recorded
  disposition. Must be fixed and tested before the final freeze.

Required remediation before final freeze:
  PH1-BLOCK-1  DecisionPoint status/link separation + database-level guard
  PH1-REC-1    Real multi-connection PostgreSQL evidence for every
               concurrency claim; NodePgTransactionRunner exercised for real
  PH1-REC-2    History FKs to RESTRICT; BEFORE TRUNCATE triggers; restricted
               production role grants
  PH1-REC-3    Lifecycle origin pinned in the schema
  PH1-REC-4    Materialized ID key changed to (phase_id, local_id) — or
               amendments declared out of MVP scope in ADR-004
  PH1-REC-5    Retriable-vs-terminal failure rule stated and implemented
  PH1-REC-7    Failing mutate() guaranteed write-free (savepoint or test)
  Packaging    Commit pin (rev-parse + status) attached to the disposition

Later-gate recommendations:
  PH1-REC-6    Fitness guard extended to the ORM surface — before any
               ORM-mediated write; no later than Phase 4

Human decisions:
  PH1-OPEN-1   Is hard deletion of a project ever required, or is
               archive-only acceptable permanently?
  Plus, per the disposition rules: any proposed rejection, downgrade, or
  gate deferral of the findings above.

Phase 2 is not authorized by this review.
```

---

## Appendix — answers to the packet's 20 required questions

1. **Entity separation / Task canonical / StrategyVersion immutable:** Correct. Task carries execution state; StrategyVersion carries the proposal with its own content hash; `V2Task.strategy_version_id` records provenance without making strategy a second execution truth. The one identity flaw is PH1-REC-4.
2. **Approval binding:** Yes, and thoroughly — `materializeV2StrategyVersion` refuses unless status is `approved`, `approval` is present, and the server-recomputed content hash equals *both* the stored `content_hash` and `approval.content_hash`; convergence and unresolved must-fix findings are refused at the schema layer (`superRefine`).
3. **Materialization without a second truth:** Yes. Objectives, tasks, dependencies, and assignments are a pure deterministic function of the approved strategy; only lifecycle/version/timestamp defaults are introduced; IDs are reproducible, making re-materialization naturally idempotent.
4. **Cross-phase dependencies prohibited at both boundaries:** Yes, and the persistence side is the stronger of the two — composite FKs make the edge unrepresentable rather than merely invalid.
5. **Lifecycle machines and projection coherent:** Yes. Runs project no further than `in_review`; `succeeded` without green verification holds the task at `verifying` (`awaiting_green_verification`); non-designated and superseded runs cannot project; terminal tasks are inert. Evidence gates completion, exactly as REF-REC-6 asked.
6. **Chokepoint prevents divergence / preserves concurrency / blocks on mismatch:** Yes on all three — with the caveat that the enforcement *guard* has the hole in PH1-REC-6 and the origin assumption in PH1-REC-3.
7. **History append-only and correctly scoped:** Scoping is correct (stream uniqueness, project/phase/task shape checks, nullable-scope chains). Append-only is enforced for UPDATE/DELETE but contradicted by cascade and bypassed by TRUNCATE — PH1-REC-2.
8. **Rows reproducible from events:** Yes for anything created at the assumed origin; that assumption is unenforced — PH1-REC-3.
9. **Additive migration, checksum-protected, idempotent:** Yes. `norns_state` is untouched (no DROP/ALTER/DELETE against it anywhere in the DDL); DDL and tracking row commit atomically; an edited migration is refused rather than silently re-applied.
10. **Composite FKs prevent leakage:** Yes — the (project_id, phase_id, id) chaining is applied consistently across tasks, dependencies, assignments, runs, decisions, evidence, and supersession pointers.
11. **One pinned transaction sufficient:** Yes. `NodePgTransactionRunner` correctly pins one PoolClient across BEGIN→COMMIT, and the comment explaining why `Pool.query` cannot host a transaction shows the trap was understood rather than avoided by luck. It is mock-tested only — PH1-REC-1.
12. **Command identity stable and DB-protected:** Yes — the cleanest closure in the candidate.
13. **Budget terminal outcomes complete and balanced:** Yes, and beyond scope in a good way (`ambiguous_execution` → `retained_ambiguous` with retained_usd). Recovery evidence remains correctly assigned to Phase 4.
14. **Idempotency scope/fingerprint/replay/conflict/retention:** Design is correct and the PK is the real backstop. Two gaps: retriable-vs-terminal failure (PH1-REC-5) and the absence of genuine concurrency evidence (PH1-REC-1).
15. **DecisionPoint identity/dedup/suppression/revision:** The design is right — stable `condition_key`, material `condition_fingerprint`, one-open partial unique index, atomic supersession, unchanged-closed suppression. The implementation corrupts the resolved case — PH1-BLOCK-1.
16. **ProjectRepository port removes GraphSession leakage without behavior change:** Yes. The port exposes operations returning immutable views; `projectRepository()` wraps a bare `ProjectStore` so existing call sites and behavior are preserved; the surface is `Awaitable<>` so a relational adapter can implement it later without touching the HTTP layer.
17. **Legacy adapter still production default:** Yes — `main.ts` contains no V2 wiring at all. The relational implementation is inert.
18. **Phase 1 avoided later-gate work:** Yes. No import, no cutover, no execution activation, no destructive migration. The non-scope list matches what the code actually does.
19. **Promises supported only by miniature tests?** Largely no, and better than expected: the adapters run against a real Postgres engine executing the real DDL. Two exceptions: every concurrency assertion (single-connection substrate) and the production node-postgres runner (mock client) — PH1-REC-1.
20. **Contract/schema decisions forcing avoidable rework in Phases 2–6:** One — the strategy-scoped materialized ID (PH1-REC-4), which forecloses phase amendment. Secondarily, the unpinned lifecycle origin (PH1-REC-3) will meet Phase 2's importer.

---

*This review and its dispositions should be committed under `docs/reviews/` per the packet's immutability rule. Findings cite the candidate implementation as provided; see the packaging caveat above regarding commit pinning.*

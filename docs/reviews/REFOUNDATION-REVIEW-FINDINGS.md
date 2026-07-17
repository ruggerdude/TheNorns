# The Norns Re-foundation — Independent Architecture Review (Findings of Record)

**Reviewer:** Claude Fable 5 · Independent Architecture and Product Reviewer
**Date:** 2026-07-16
**Reviewed documents:** docs snapshot @ `b4afd44` (charter, Phase 0 review, ADR-001 amendment, ADR-004–007, program, packet, repo map)
**Code evidence:** `main` @ `4ee3b8a` (198 files) — the commit the docs describe
**Companion:** `REFOUNDATION-REVIEW-BASELINE.md` (reviewer pre-read of `4ee3b8a`, 2026-07-16)
**Review type:** Read-only cross-provider phase gate. No files edited; no implementation code produced.

## Method and packaging note

All 17 evidence files named in the packet exist at `4ee3b8a` and were examined; the repo map's code-dependent claims were spot-verified against source (project/session structure, snapshot persistence, unwired `DispatchStore`, `launch_run` rejection in the runner daemon, hardcoded `"operator"` actor, plaintext session/invite tokens, client-posted `/plan/load`). Every claim checked was accurate. The test suite was not executed. **Packaging caveat:** the docs archive contains documentation only, so the assertion that `b4afd44` changes no application source could not be independently confirmed from the two archives provided — see REF-REC-14.

The approved direction (persistent projects, immutable strategy versions, Task/TaskDependency as canonical, normalized Postgres + domain history + transactional outbox, runner-owned execution, deterministic coordinator, Resume/Attention read models, preservation of existing users and projects) is not re-litigated here. It is coherent, it matches the verified deficiencies of the current codebase, and it correctly preserves the system's best-verified assets — the contracts/protocol semantics (command state machine, watermark replay, dedup, fencing, deterministic reducer). The findings below are about seams the documents leave unspecified, sequencing, and evidence discipline.

---

## Blocking findings

**None.** No reviewed decision would, as written, lose or corrupt state, break the trust boundary, prevent safe recovery, or make the charter MVP unreachable. The material risks found are specification gaps in approved directions; each is assigned to a named gate below.

---

## Recommended findings — P1 (material; each names its landing gate)

```text
ID: REF-REC-1
Tier: Recommended (P1) — land at Phase 1 exit gate
ADR/document/location: ADR-005 §2 (domain events) vs §1 (normalized state); ADR-001 amendment ("Normalized state is the operational source of truth; lifecycle events provide reproducible history")
Finding: The hybrid model stores lifecycle truth twice — current-state columns and domain events — and requires reproducibility, but defines no arbitration rule when they diverge and no mechanism that detects divergence.
Why it matters: A handler that updates state without appending the event (or vice versa) silently splits truth: the scheduler acts on columns while Resume/Attention/history rebuild from events. This is the same class of dual-truth defect (plan vs graph) the re-foundation exists to eliminate.
Concrete failure scenario: A retry-path bug commits tasks.state='in_progress' without the TaskRetried event. Projections and audit show the task blocked; the coordinator dispatches it anyway. No test or job ever notices.
Recommendation: State the rule in ADR-005: events are the authoritative history; state columns are a transactionally-maintained cache; any lifecycle mutation MUST append its event in the same transaction (enforced by a single application-service chokepoint — no direct table writes, per Workstream C's existing rule — plus a CI/periodic reconciliation job folding events and diffing against columns).
Acceptance test: A fault-injected handler that writes state without an event (and one that writes an event without state) is caught by the reconciliation check; the fold-and-compare job runs green over the Phase 4 vertical-slice database.
```

```text
ID: REF-REC-2
Tier: Recommended (P1) — contract in Phase 1; proven at Phase 4 recovery matrix
ADR/document/location: ADR-005 §4 (outbox) × ADR-006 §6 (launch_run envelope); illustrative current code: DispatchLoop.tick() delivers then complete(job.id, commandId)
Finding: The seam between the dispatch_jobs outbox and the runner command outbox does not pin command identity across redelivery. If each delivery attempt mints a fresh command_id, the runner's dedup (which keys on command_id) cannot recognize a redelivered job.
Why it matters: The entire at-least-once + idempotent guarantee inherited from REVIEW-001 P0-2 collapses at this one seam: duplicate command_ids means duplicate execution, duplicate budget burn, and duplicate worktrees for the same task run.
Concrete failure scenario: Dispatcher claims job J, creates command c-123, crashes before complete(). Lease expires; another dispatcher claims J and creates c-456 for the same run. The runner, correctly, executes both.
Recommendation: Specify in the Phase 1 contracts that command identity is a deterministic function of the outbox job (command_id derived from job_id, or the command row created inside the original state+outbox transaction with a uniqueness constraint on job_id); delivery only flips status. Redelivery must re-present the same command_id.
Acceptance test: Kill the dispatcher between deliver and complete; recover; assert exactly one command row exists for the job and the runner's dedup store records exactly one execution.
```

```text
ID: REF-REC-3
Tier: Recommended (P1) — pull forward: land no later than the Phase 4 exit gate (before live execution against real repositories)
ADR/document/location: ADR-001 identity amendment (hardening "required before the security/pilot gate"); evidence: users/store.ts (no expiry logic; plaintext tokens), web auth.ts (sessionStorage bearer)
Finding: Minimum session hardening is scheduled for Phase 7, but Phase 4 activates real repository execution commanded from this internet-exposed control plane. Between those gates, non-expiring bearer tokens, stored as plaintext at rest, authorize dispatch of code execution and pushes.
Why it matters: The window pairs the product's maximum new capability with its weakest known credential posture. A single leaked token is a permanent key to the dispatch plane.
Concrete failure scenario: During Phase 5 UI work, a token captured from a debug log or browser extension in June is replayed in August; there is no expiry, no revocation inventory, and no at-rest hashing to limit it.
Recommendation: Split the amendment's requirements into "minimum before live execution" (token hashing at rest, session expiry + server-side revocation list, login rate limiting) landing at the Phase 4 exit gate, and "full posture" (cookie migration, CSRF, recent-auth, recovery, enrollment alerts) at Phase 7 as planned.
Acceptance test: At Phase 4 exit: DB rows contain no plaintext session/invite tokens; an expired or revoked token is refused on a dispatch-capable route; a login brute-force test is throttled.
```

```text
ID: REF-REC-4
Tier: Recommended (P1) — land at Phase 2 (recovery checkpoint / identity migration)
ADR/document/location: Program §2.1–2.2 × ADR-001 amendment; evidence: UserStoreSnapshot serializes raw tokens into the "users" snapshot
Finding: Hash-migrating session tokens preserves their plaintext VALUES as valid credentials, while §2.1 archives the raw legacy snapshots — which contain those same plaintext session and invitation tokens — and retains them through the rollback window.
Why it matters: After migration, the archived snapshot is a credential file: any still-active session's plaintext token sits readable in the rollback artifact, checksummed and deliberately preserved.
Concrete failure scenario: The Phase 7 retention-window archive is copied to object storage with lax ACLs; an attacker replays an admin session token that hash-migration kept valid; full workspace control, months later.
Recommendation: Choose one at the Phase 2 gate (human decision, see REF-OPEN-2): (a) rotate all sessions at cutover — one explicit re-authentication, which the ADR-001 amendment already permits; or (b) encrypt the snapshot archives and treat them as secrets with access logging. (a) is simpler and self-contained.
Acceptance test: Post-cutover, no token string present in any retained archive authenticates against the live system.
```

```text
ID: REF-REC-5
Tier: Recommended (P1) — land before Phase 3 GitHub work begins
ADR/document/location: ADR-006 §3 (GitHub App), §4 (runner-mediated push), trust invariant 3
Finding: The credential-brokering flow for GitHub bindings is unwritten: who holds the App private key, who mints installation tokens, how a short-lived scoped token reaches the runner for a push, and how tokens are kept out of envelopes, logs, and sandbox environments.
Why it matters: This is the highest-value secret in the system and the invariants ("workers never handle broad credentials") depend entirely on an unstated flow. Left to implementation, the natural shortcut is shipping a token inside launch_run or installing the App key on the runner.
Concrete failure scenario: An implementer embeds an installation token in the command payload; the runner's event replay and artifact upload persist it; redaction rules don't know its shape; it appears in a transcript artifact.
Recommendation: Write the flow into ADR-006 or the Phase 3 brief: App private key server-only; server mints per-operation installation tokens (minutes-scale TTL, single-repo scope) on runner request at push time; tokens travel over the authenticated runner channel, never in command envelopes or sandbox env; redaction patterns registered before first use. Enumerate the App's permission set explicitly.
Acceptance test: A push completes with a token whose TTL has provably expired minutes later; grep of all stored envelopes, events, logs, and artifacts from the run finds no token material.
```

```text
ID: REF-REC-6
Tier: Recommended (P1) — land in Program §1.1 (versioned domain contracts)
ADR/document/location: ADR-004 §4/§6; packet Q3; Program "unsafe parallel work" (coordinator and runner independently inventing task/run lifecycle states)
Finding: Task and AgentRun each have a lifecycle, but the mapping between them is undefined: which run outcomes move the task into which states, what a retry does to task state, which entity owns verifying / in_review, and what the task shows while a superseding run is in flight.
Why it matters: The program itself lists divergent lifecycle invention as unsafe; Workstreams B, C, and E all build against this mapping in Phases 1–4. It is the cheapest possible time to write it down and the most expensive thing to reconcile later.
Concrete failure scenario: Runner reports run failure; coordinator marks the task blocked; retry policy spawns run 2; Resume view derives "blocked" from task state while Attention derives "active" from the open run — contradictory truth on the two flagship read models.
Recommendation: Publish both state machines and the task⇐run projection rules (e.g., task enters in_review only when its designated active run's verification evidence is green; retry creates a new run and returns the task to in_progress; terminal task states are reachable only via recorded run/review/integration evidence) as a Phase 1.1 contract with reducer tests, adapting the existing lifecycle reducer.
Acceptance test: Contract tests enumerate every run transition and assert the resulting task state; a property test confirms no run event sequence can produce a task state unreachable in the published machine.
```

```text
ID: REF-REC-7
Tier: Recommended (P1) — schema in Phase 1; behavior proven in Phase 4 recovery matrix
ADR/document/location: ADR-007 §2 (idempotent evaluation) × §5 (DecisionPoint creation)
Finding: Dispatch is protected against re-evaluation by the state+outbox transaction, but DecisionPoint creation is not: a coordinator crash between creating a DecisionPoint and recording the evaluation can create a duplicate on restart.
Why it matters: DecisionPoints are the human-interruption mechanism and the charter's cognitive-load promise. Duplicates interrupt twice, and resolving one copy leaves the other blocking its declared scope.
Concrete failure scenario: Coordinator creates DP-1 ("merge conflict on task T"), crashes, restarts, re-evaluates T, creates DP-2 for the same condition. The human resolves DP-1; T stays blocked on DP-2 until someone notices.
Recommendation: Give DecisionPoints deterministic identity or a uniqueness constraint on open points per (scope entity, reason class) so re-evaluation upserts rather than duplicates; resolution of the surviving record unblocks the scope.
Acceptance test: Crash-inject between DecisionPoint insert and evaluation completion; restart; assert exactly one open DecisionPoint exists for the condition and resolving it unblocks the task.
```

```text
ID: REF-REC-8
Tier: Recommended (P1) — add to the Phase 1 exit gate
ADR/document/location: Program Phase 1 "Ownership" (independent gate review: Codex plus Sol architecture review)
Finding: The V2 domain contracts — the single highest-leverage artifact, per the program's own principles — are frozen at Phase 1 with no independent cross-provider review of the contracts themselves. This is a process regression against the project's own precedent (contracts v1 received an external review gate at Phase 0B).
Why it matters: Every later workstream implements against these schemas; the program's unsafe-parallel list already recognizes that building on unsettled DTOs is how rework happens. A contract defect discovered in Phase 4 costs multiples of a Phase 1 review.
Concrete failure scenario: A subtle V2 approval/staleness rule encoded wrong in the schema passes Codex's implementation-focused review; Workstreams C and D build on it; Phase 4's vertical slice exposes it; three workstreams rework.
Recommendation: Add a bounded independent review (this reviewer) of the frozen V2 contract package — schemas, lifecycle machines from REF-REC-6, event definitions, idempotency semantics — as a Phase 1 exit condition. Small artifact, one review cycle.
Acceptance test: Phase 1 exit evidence includes the contract-review findings and their dispositions under the standard disposition rules.
```

```text
ID: REF-REC-9
Tier: Recommended (P1) — land before Phase 1 authorization
ADR/document/location: REFOUNDATION-PROGRAM.md (entire) — no effort, duration, or cost baseline appears anywhere in the program
Finding: The program defines scope, ownership, and exit gates but carries no effort envelope, no per-phase budget or session estimate, and no cost checkpoint mechanism. The prior plan carried "40–65 sessions + 15–25 contingency"; its successor — a larger undertaking — carries nothing.
Why it matters: The July 14 episode demonstrated exactly what an unbounded agent program does: phases 0A–8 "completed" in a day, followed by remediation programs. Exit gates control quality; only a baseline controls scope and spend. A program without a baseline cannot report variance, and variance is the earliest honest signal that architecture or staffing is wrong.
Concrete failure scenario: Phase 4 quietly consumes triple its implicit share in runner/security iteration; nothing trips, because nothing was budgeted; the overrun is discovered as a bill, not a decision.
Recommendation: Before authorization, add per-phase effort estimates (sessions or agent-hours by role), an explicit contingency, a spend checkpoint at each exit gate ("estimated vs actual, variance, re-forecast"), and a stop-and-review trigger (e.g., any phase exceeding 150% of estimate pauses for human review). The human sets the envelope (REF-OPEN-4).
Acceptance test: Each phase-exit packet reports estimate vs actual with a re-forecast; a simulated 150% breach demonstrably pauses the phase pending human review.
```

```text
ID: REF-REC-10
Tier: Recommended (P1) — land in Phase 1 contracts
ADR/document/location: ADR-004 domain invariant 4 ("acyclic within the scheduler's active dependency scope"); charter (multiple active phases permitted by policy)
Finding: Cross-phase task dependencies are neither allowed nor forbidden. "Active dependency scope" is undefined, yet cycle detection, the scheduler, migration, and the graph projection all need the answer — and Phase dependencies and Task dependencies could encode contradictory orderings across two graphs.
Why it matters: If cross-phase task edges are legal, acyclicity must be checked across the union of active phases plus the phase-dependency graph; if illegal, migration and the phase-amendment flow need a rule for work that spans phases.
Concrete failure scenario: Task A (Phase 1) depends on Task B (Phase 2) while Phase 2 depends on Phase 1: both graphs are individually acyclic; jointly they deadlock, and nothing detects it.
Recommendation: For the MVP, declare task dependencies phase-local; cross-phase sequencing is expressed only through phase dependencies. Record it as an ADR-004 invariant clarification and enforce it in the TaskDependency schema.
Acceptance test: Creating a cross-phase TaskDependency is rejected at the contract layer; the joint phase/task ordering above is representable only in a form the scheduler can order.
```

---

## Recommended findings — P2 (valuable clarification / later hardening)

```text
ID: REF-REC-11
Tier: Recommended (P2) — documentation fix in this disposition cycle
ADR/document/location: PHASE-0-ARCHITECTURE-REVIEW.md ratification table; evidence: server.ts /plan/load accepts any schema-valid client-posted plan; ProjectStore.loadPlan replaces the session with no hash/convergence check
Finding: The table lists "Non-converged plan load prohibition — preserved as a strategy-approval safety policy," but at 4ee3b8a that prohibition is client-side only; the server load route enforces schema validity, nothing more. The table also names only one of NORN-041's three "decided ADRs" ambiguously.
Why it matters: A ratification map is only useful if it neither overstates current guarantees nor leaves logged "decisions" unmapped. Describing a client-side control as a safety policy invites relying on it during the migration window.
Concrete failure scenario: During Phases 1–3 someone treats the "preserved policy" as a server guarantee and skips it in the V2 command design review.
Recommendation: Reword to "client-side control at 4ee3b8a; becomes a server-enforced invariant via ADR-004 §5 approval materialization," and enumerate all three NORN-041 decisions (allocation fingerprint, plan-override prohibition, dashboard containment) with their dispositions.
Acceptance test: Updated table names all three items; ADR-004 acceptance criterion 4 covers the server-side enforcement.
```

```text
ID: REF-REC-12
Tier: Recommended (P2) — Phase 2 migration specification
ADR/document/location: ADR-004 §Migration; Program §2.4, §2.1; rollback strategy
Finding: Migration policy is sound but three mechanics are unspecified: (a) the plan/graph "disagreement" predicate is not machine-checkable (node-set diff incl. graph-only nodes and deleted modules, edge diff, assignment diff, approval currency evaluated and persisted at import); (b) imported audit rows should carry actor_type=legacy rather than a fabricated identity; (c) the rollback data-loss window after V2 writes begin is real but never surfaced — the legacy snapshots freeze at cutover, so a rollback's loss should be stamped and shown to the human at the rollback decision.
Why it matters: "No silent guessing" is only as strong as the enumerated checks; and a human authorizing rollback deserves the loss window in front of them.
Concrete failure scenario: A graph-only node (added via the graph editor, absent from the plan) imports as a task with empty acceptance criteria and no reconciliation finding, because "disagreement" was implemented as objective-string comparison.
Recommendation: Enumerate the reconciliation rule set in the Phase 2 spec; tag legacy audit actors; stamp legacy-snapshot freshness at cutover and render it in the rollback flow.
Acceptance test: A fixture project with a graph-only node, a deleted module, and a stale approval produces three distinct reconciliation findings; a rollback dry-run displays the frozen-at timestamp and affected-record counts.
```

```text
ID: REF-REC-13
Tier: Recommended (P2) — Phase 1 contract detail
ADR/document/location: ADR-005 §5 (idempotent command handling)
Finding: Idempotency-key mechanics are unstated: key scope (per actor? global?), storage and retention, behavior for two concurrent in-flight duplicates (second must block or 409, not double-execute), and whether a FAILED command's key may be retried.
Recommendation: Specify: unique index on (actor_id, idempotency_key) with stored response envelope; concurrent duplicate receives the first's result or a retriable conflict; failed commands release the key or record the failure as the replayable result — pick one and state it; retention window defined.
Why it matters / failure scenario: A double-clicked ApproveStrategyVersion or a client retry racing its original is the everyday case; ambiguity here becomes double materialization.
Acceptance test: Two concurrent identical commands produce one state change and two identical responses; a repeated key after failure behaves per the stated rule.
```

```text
ID: REF-REC-14
Tier: Recommended (P2) — attach in this disposition cycle
ADR/document/location: REFOUNDATION-REPO-MAP.md ("any application/package source difference … is a packaging error")
Finding: The docs-only property of b4afd44 relative to 4ee3b8a cannot be verified from the provided archives (the docs archive strips application source by construction).
Recommendation: Attach `git diff --stat 4ee3b8a..b4afd44` output to the disposition record as evidence the review commit changed documentation only.
Why it matters / failure scenario: The map's own rule is unenforceable without the diff; a stray source change would silently alter the reviewed baseline.
Acceptance test: Diffstat in the disposition shows changes under docs/ (and REVIEW_COMMIT.txt) only.
```

```text
ID: REF-REC-15
Tier: Recommended (P2) — Phase 4 design brief
ADR/document/location: ADR-006 §6 (content-addressed prompt/context references)
Finding: Who serves content-addressed artifacts to the runner, over what authenticated channel, and how the sandbox receives them without credentials, is unspecified.
Recommendation: State the fetch path (runner pulls by hash over its authenticated relay channel or a signed URL minted per command; runner stages content into the worktree/scratch mount; sandbox never receives fetch credentials) and the integrity check (hash verified before use).
Why it matters / failure scenario: The natural shortcut is inlining large prompts back into envelopes — recreating the size problem — or handing the sandbox a fetch token.
Acceptance test: A launch_run whose context reference hash mismatches is refused and audited; the sandbox environment contains no fetch credential.
```

```text
ID: REF-REC-16
Tier: Recommended (P2) — Phase 4 (durable scheduling)
ADR/document/location: ADR-005 §4 step 6, Program §4.2 (retry/dead-letter)
Finding: Budget reservation lifecycle on the failure paths is unstated: release on dead-letter, release on cancel/expiry, settle-vs-release on partial usage, and a leak sweep for orphaned reservations.
Recommendation: State the rule per terminal outcome and add a periodic reservation-reconciliation sweep with an audit event on any orphan found.
Why it matters / failure scenario: Orphaned reservations silently shrink available budget until dispatch mysteriously refuses work.
Acceptance test: Dead-lettering a dispatched job releases its reservation; the sweep detects and reports an injected orphan.
```

```text
ID: REF-REC-17
Tier: Recommended (P2) — one-paragraph scope statement in ADR-005
ADR/document/location: ADR-005 consequences ("multiple instances after lease and WebSocket routing behavior is verified")
Finding: Multi-instance operation interacts with runner WebSocket affinity (a job claimed by instance A for a runner connected to instance B is undeliverable) and deserves an explicit out-of-MVP-scope declaration so it is not "verified" casually.
Recommendation: State: MVP is single-instance; multi-instance requires a designed runner-affinity or shared-delivery mechanism and its own gate.
Acceptance test: The statement exists; no Phase gate claims multi-instance readiness without that design.
```

```text
ID: REF-REC-18
Tier: Recommended (P2) — Phase 5 implementation brief
ADR/document/location: ADR-007 §7 (acknowledgement must not resurrect unless the source changes)
Finding: Attention-item identity is undefined: the ack/snooze store needs a stable item key plus a source-state fingerprint so rebuilds honor acks yet genuine changes re-raise.
Recommendation: Define item key = (source entity type, id, condition class) and fingerprint = hash of the condition's material fields; re-raise iff fingerprint changes.
Acceptance test: Projection rebuild preserves an acked informational item as acked; changing the underlying condition re-raises it once.
```

---

## Open questions (require human input)

```text
ID: REF-OPEN-1
Tier: Open question
Location: ADR-006 §3; Program Phase 3
Question: Is GitHub App integration in the MVP, or is local-runner binding sufficient for first pilot? The charter's MVP success criteria are satisfiable with local bindings alone; the GitHub App adds real operational setup and a credential-brokering design (REF-REC-5) for a single-operator deployment. Recommendation available on request; this is a scope/cost call.
```

```text
ID: REF-OPEN-2
Tier: Open question
Location: Program §2.1–2.2 (ties REF-REC-4)
Question: At migration cutover, rotate all sessions (one explicit re-login for every user) or encrypt/secure the legacy snapshot archives? Reviewer leans rotation — simpler, self-contained, permitted by the ADR-001 amendment — but it is a user-facing decision.
```

```text
ID: REF-OPEN-3
Tier: Open question
Location: Charter (multiple active phases as policy); ADR-004 §2
Question: What is the MVP default for concurrent active phases per project? Reviewer suggests 1 (with the schema supporting more) to cut coordinator, integration, and attention complexity in Phases 4–6; raising it later is a policy flip, not a migration.
```

```text
ID: REF-OPEN-4
Tier: Open question
Location: REFOUNDATION-PROGRAM.md (ties REF-REC-9)
Question: What effort/cost envelope and per-phase checkpoint thresholds does the human set for this program? The reviewer can propose numbers once the human states the intended spend posture (subscription-seat time vs API spend, and appetite per phase).
```

---

## Verdict

```text
Verdict: Approve with required changes

Phase 1 blockers: None that prevent authorization, on two conditions:
  (1) REF-REC-9 (program baseline: estimates, contingency, checkpoints, breach
      trigger) and the documentation fixes REF-REC-11 / REF-REC-14 land in this
      disposition cycle, before the human signs "Start Phase 1"; and
  (2) REF-REC-1, -2, -6, -7 (schema part), -10, -13 are bound into Phase 1
      scope as exit-gate criteria, and REF-REC-8 (independent V2-contract
      review) is added to the Phase 1 exit gate.

Decisions requiring the human:
  REF-OPEN-1 (GitHub App in/out of MVP)
  REF-OPEN-2 (session rotation vs encrypted archives at Phase 2)
  REF-OPEN-3 (MVP concurrent-active-phase default)
  REF-OPEN-4 (program effort/cost envelope)
  Plus, per the disposition rules: any rejection, downgrade, or gate deferral
  of the findings above.

Recommended changes before implementation (later named gates):
  Phase 2: REF-REC-4 (token exposure at cutover), REF-REC-12 (migration
           mechanics bundle)
  Phase 3: REF-REC-5 (GitHub credential-brokering flow, if in scope)
  Phase 4: REF-REC-3 (minimum session hardening before live execution),
           REF-REC-7 (recovery-matrix proof), REF-REC-15, REF-REC-16
  Phase 5: REF-REC-18
  Anytime: REF-REC-17
```

---

## Appendix — answers to the packet's 27 required questions

1. **Entity separation:** Correct and well-factored; the two genuine gaps are the Task⇄Run lifecycle mapping (REF-REC-6) and cross-phase dependency scope (REF-REC-10).
2. **StrategyVersion approval without second truth:** Yes — atomic materialization plus invariant 5 closes the plan/graph dual-truth defect, and moves plan-approval enforcement server-side where it currently isn't (REF-REC-11).
3. **Task vs run clarity:** Not yet sufficient — REF-REC-6.
4. **Missing invariants (history loss / leakage):** Cross-project leakage is covered by FKs plus invariants 3–4. Add: domain/audit events are append-only at the database-privilege level (no UPDATE/DELETE grants), and the event/state divergence check (REF-REC-1).
5. **Identity amendment adequacy:** Yes — scope is well-bounded (single-tenant named accounts, explicit non-goals, NORNS_TOKEN confined to bootstrap). The issue is sequencing, not content (REF-REC-3).
6. **Token/session target requirements:** Sufficient in content; add explicit log/artifact redaction of token material, the archive-exposure control (REF-REC-4), and the pulled-forward minimum set (REF-REC-3).
7. **Ratification map completeness:** Nearly — name all three NORN-041 decisions and correct the plan-load characterization (REF-REC-11). No other undocumented architecture-relevant change was found in the log or code.
8. **Disposition authority and independence:** Yes — the rule (Sol may accept/triage but rejection, downgrade, or deferral routes to the human with both positions side by side, immutable record) is a material improvement and answers the reviewer's pre-engagement concern. Suggested addition: the disposition matrix itself is committed before Phase 1 authorization.
9. **Hybrid model coherence:** Coherent and preferable to blanket event-sourcing at this scale, once the arbitration rule and divergence detection exist (REF-REC-1).
10. **Transaction boundary completeness:** The eight-step command transaction is right; the two open seams are outbox→command identity (REF-REC-2) and reservation lifecycle on failure paths (REF-REC-16).
11. **Idempotency/concurrency/leases/races/budget:** Semantics carried over from v1 are sound (first-terminal-commits, fencing, watermarks preserved per ADR-005 §5); specify key mechanics (REF-REC-13) and command determinism (REF-REC-2).
12. **Legacy migration and rollback:** Safe as designed, given REF-REC-12's enumerated predicate, REF-REC-4's token handling, and the stated forward-only production-migration rule.
13. **Reconciliation without silent guessing:** Policy is right; make the disagreement predicate computable (REF-REC-12).
14. **Local folder via runner:** Feasible and the correct pattern (approved roots, opaque IDs, validation on the runner). Ensure raw paths never transit the cloud even in error messages.
15. **GitHub App bounding:** Direction correct; the credential flow and permission enumeration must be written before implementation (REF-REC-5); MVP inclusion is a human call (REF-OPEN-1).
16. **Boundary placement:** Correct — ADR-006 §4/§5 plus the package move. Treat the move itself as Phase 4.3's first, behavior-preserving step with conformance tests before any behavior change.
17. **Execution command binding/idempotency:** Field set is sufficient; add deterministic command identity (REF-REC-2) and the artifact fetch path (REF-REC-15).
18. **Coordinator restart safety:** Yes for dispatch via the state+outbox transaction; DecisionPoint creation is the unprotected side effect (REF-REC-7).
19. **Deterministic vs LLM separation:** Crisp and correct. Add one stated rule: schema-invalid LLM output is never partially applied — it retries or raises a DecisionPoint.
20. **Assignment factors:** Comprehensive; ADR-004's assignment `rationale` field gives the audit trail — require it populated.
21. **DecisionPoint interruption discipline:** The trigger list is appropriately strategic; the duplication risk under re-evaluation is the one defect (REF-REC-7).
22. **Resume/Attention buildability:** Yes — every listed field maps to a normalized table or an event fold; the ack-identity detail is REF-REC-18.
23. **Phase ordering:** Correct and strictly linear with sane parallel-work carve-outs; add the V2-contract review to the Phase 1 gate (REF-REC-8).
24. **Concurrency safety:** Yes — ≤3 implementers, frozen artifacts before review, no co-authored core files, and the two-failures-stop rule match hard-won precedent (including the Agent E stall).
25. **Unstable-contract exposure:** The risk concentrates on Workstream D; the program already marks it unsafe — enforce via contract freeze + REF-REC-8 before D implements against V2 DTOs.
26. **Rollback viability after V2 writes:** Viable under the stated non-destructive rules; make the loss window explicit and visible at the rollback decision (REF-REC-12).
27. **Missing gates before pilot:** Security minimum pulled to Phase 4 (REF-REC-3); restore/rollback drills already sit in Phases 1–2; program baseline and checkpoints (REF-REC-9) are the remaining absent control.

---

*This review, the companion baseline memo, and their eventual dispositions should be committed under `docs/reviews/` per the packet's immutability rule. Findings cite `b4afd44` (documents) and `4ee3b8a` (code).*

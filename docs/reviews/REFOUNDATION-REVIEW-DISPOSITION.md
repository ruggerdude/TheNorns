# Re-foundation Independent Review Disposition

**Review:** [REFOUNDATION-REVIEW-FINDINGS.md](REFOUNDATION-REVIEW-FINDINGS.md)
**Reviewer:** Claude Fable 5
**Architecture author / disposition preparer:** ChatGPT Sol
**Reviewed documents:** `b4afd44514632f1a66733c115f8bfa3279bd9da2`
**Code evidence:** `4ee3b8a`
**Disposition date:** 2026-07-16
**Status:** All recommendations accepted or strengthened; all four human
decisions approved; Phase 1 is not authorized.

## Disposition principles

- The reviewer reported no blocking findings.
- No recommendation is rejected, downgraded, or deferred past the reviewer's
  named gate.
- Precision changes below strengthen or make recommendations implementable;
  they do not reduce severity or scope.
- The original baseline and findings remain unchanged. All responses and
  amendments live in this separate record and the governing documents.
- `REF-OPEN-1` through `REF-OPEN-4` were explicitly approved by the human on
  2026-07-16 and are recorded in
  [REFOUNDATION-HUMAN-DECISIONS.md](REFOUNDATION-HUMAN-DECISIONS.md).
- A later implementation gate must provide the acceptance evidence; a
  documentation disposition does not claim that implementation exists.

## Recommended findings

| ID | Disposition | Governing change and landing gate |
|---|---|---|
| REF-REC-1 | Accepted with precision | ADR-005 now states that lifecycle events are authoritative transition history and current lifecycle columns are the authoritative operational projection maintained by the same transaction. Direct writes are prohibited; append-only privileges and fold-versus-row reconciliation are required. Phase 1 fault-injects one-sided writes; Phase 4 runs reconciliation over the vertical-slice database. |
| REF-REC-2 | Accepted | ADR-005 assigns immutable command identity when the dispatch job is created. Redelivery reuses the same ID. Phase 1 freezes the contract; Phase 4 kills the dispatcher between delivery and completion and proves one command/one execution. |
| REF-REC-3 | Accepted and strengthened | ADR-001 and the Phase 4 gate pull token hashing, expiry, revocation, rate limiting, project authorization, real actor/session attribution, removal of generic command bypass, and bearer-free WebSocket/log handling ahead of live repository execution. Full cookie/CSRF/recent-auth/recovery posture remains Phase 7. |
| REF-REC-4 | Accepted with stronger minimum; human policy approved | The approved cutover is rotation/revocation of legacy session and invitation credentials plus explicit re-login. Retained archives are encrypted, access-controlled, logged, and time-bounded because they contain other sensitive data. Phase 2 must prove no archived credential authenticates. |
| REF-REC-5 | Accepted with provider-constrained wording | ADR-006 defines a server-only App private key, just-in-time single-repository installation tokens, explicit permissions, operation-bound/single-consumption Norns brokering, ephemeral askpass use, post-operation GitHub revocation, audit, and redaction. GitHub sets installation-token expiry at one hour, so Norns does not falsely promise a minutes-only cryptographic lifetime; it mints immediately before one bounded operation and proves replay rejection after revocation. Landing is before Phase 3 GitHub work. |
| REF-REC-6 | Accepted | ADR-004 and Program Phase 1 define separate Task/AgentRun machines, one designated active run, superseded-run behavior, retry projection, and evidence-gated terminal Task states. Exhaustive reducer/property tests are a Phase 1 exit condition. |
| REF-REC-7 | Accepted with precision | ADR-007 separates a stable scope/reason/source `condition_key` from the material `condition_fingerprint`, permits one open row per key, and atomically supersedes the prior revision when the fingerprint changes. This avoids both duplicate points and accidental coalescing of different conditions. Schema lands in Phase 1; crash proof lands in Phase 4. |
| REF-REC-8 | Accepted | Claude Fable performs a bounded independent review of frozen V2 schemas, lifecycle machines, events, approval/staleness, and idempotency semantics at the Phase 1 exit. Codex implementation/race review and Sol integration review remain separate. |
| REF-REC-9 | Accepted | The program now defines per-phase/per-role FSE accounting, a 9–16 week planning window, 116 planned FSE, 29 contingency, an approved 145-FSE ceiling, per-gate variance reporting, defined 100%/125%/150% controls with automatic pause at 150%, and the required tabletop pause test. `REF-OPEN-4` approved the seat-first $500 incremental API hard cap. |
| REF-REC-10 | Accepted | ADR-004 declares MVP TaskDependencies phase-local. Cross-phase ordering is represented only by PhaseDependency and is rejected at contract/persistence boundaries. Phase 1 tests enforce it. |
| REF-REC-11 | Accepted | The Phase 0 ratification table now enumerates all three NORN-041 decisions and states accurately that `/plan/load` at `4ee3b8a` is not a server convergence guarantee. ADR-004 server-side strategy approval/materialization is the target invariant. |
| REF-REC-12 | Accepted | ADR-004 and Program Phase 2 enumerate machine-checkable reconciliation classes, preserve legacy actor provenance, stamp snapshot freshness, and require rollback visibility/data-window evidence. |
| REF-REC-13 | Accepted and strengthened | ADR-005 defines actor/command-family scope, request fingerprints, uniqueness, in-flight duplicate behavior, mismatched-payload rejection, committed-failure replay, and retention. Phase 1 concurrent tests are mandatory. |
| REF-REC-14 | Accepted with corrected evidence | [REFOUNDATION-REVIEW-DIFF-EVIDENCE.md](REFOUNDATION-REVIEW-DIFF-EVIDENCE.md) records identical `apps/` and `packages/` tree objects and the complete 17-file diff. The accurate statement is documentation/program-tracking only, not literally `docs/` only; `REVIEW_COMMIT.txt` was archive metadata. |
| REF-REC-15 | Accepted | ADR-006 defines authenticated runner fetch, signed/reference transport, hash/size verification, runner staging, and no sandbox fetch credentials. Phase 4 proves mismatch rejection and audit. |
| REF-REC-16 | Accepted; contract pulled forward | ADR-005 defines reservation settle/release for success, partial usage, cancel, expiry, rejection, and dead-letter plus an orphan sweep. Contract semantics are Phase 1; recovery evidence is Phase 4. |
| REF-REC-17 | Accepted | ADR-005 and the program state explicitly that MVP is single-instance. Multi-instance runner affinity/shared delivery needs a separate ADR and recovery gate. |
| REF-REC-18 | Accepted | ADR-007 and Program Phase 5 define stable Attention item identity plus condition fingerprint. Rebuild retains acknowledgement and re-raises a changed condition once. |

## Human decisions

| ID | Sol recommendation | Status and effect |
|---|---|---|
| REF-OPEN-1 — GitHub App in MVP | **Include it.** The user explicitly requested GitHub login and repository selection. Use local binding for the first runner vertical slice, but complete GitHub App binding before the real-project pilot. | **Approved by the human, 2026-07-16.** |
| REF-OPEN-2 — session cutover | **Rotate/revoke every active session and unused invitation at cutover, require one explicit re-login, and encrypt/restrict retained archives.** | **Approved by the human, 2026-07-16.** |
| REF-OPEN-3 — concurrent active phases | **Default to one executing phase per project for MVP.** Multiple proposed/approved phases may exist; the schema continues to support a later policy increase. | **Approved by the human, 2026-07-16.** |
| REF-OPEN-4 — effort/cost envelope | **Seat-first hybrid:** 116 planned FSE + 29 contingency = 145 maximum; expected incremental API spend $150–300, hard cap $500. | **Approved by the human, 2026-07-16.** |

## Phase-gate binding

### Before Phase 1 authorization

- This baseline, findings record, disposition, and diff evidence are committed.
- REF-REC-9, REF-REC-11, and REF-REC-14 documentation changes are present.
- [A simulated 150% threshold
  breach](REFOUNDATION-PROGRAM-CONTROL-TABLETOP.md) proves the program pause
  control.
- REF-OPEN-1 through REF-OPEN-4 are recorded by the human.
- The human explicitly authorized the final FSE/API envelope.

### Phase 1 exit

`REF-REC-1`, `REF-REC-2`, `REF-REC-6`, the schema portion of `REF-REC-7`,
`REF-REC-8`, `REF-REC-10`, `REF-REC-13`, and the contract portion of
`REF-REC-16`.

### Phase 2 exit

`REF-REC-4` and `REF-REC-12`.

### Before Phase 3 GitHub implementation

`REF-REC-5`.

### Phase 4 exit

`REF-REC-2` recovery proof, `REF-REC-3`, `REF-REC-7` crash proof,
`REF-REC-15`, and `REF-REC-16` recovery proof.

### Phase 5 exit

`REF-REC-18`.

### Standing scope

`REF-REC-17`.

## Authorization state

Phase 0 has an independent verdict of **Approve with required changes**.
The findings have been accepted into the architecture and program, but the
program remains stopped at its human gate.

The only implementation-start command remains:

> Start Phase 1 — Domain and Persistence Foundation.

# Phase 1 Candidate Review Disposition

**Review:** [PHASE-1-CANDIDATE-REVIEW-FINDINGS.md](PHASE-1-CANDIDATE-REVIEW-FINDINGS.md)
**Reviewer:** Claude Fable 5
**Architecture author / disposition preparer:** ChatGPT Sol
**Reviewed candidate:** `7244dd8430128b99acb8e5facc4d7575ff3e05a8`
**Remediation candidate:** `0b15579757bf6d0320ee537ab728fe3dfdf9d9ac`
**Final technical freeze:** `50c9e7b0576f31d32ec01994c069b72c07e7e031`
**Disposition date:** 2026-07-16
**Status:** Closed. All findings accepted and implemented; archive-only
approved for `PH1-OPEN-1`; Phase 1 finally frozen; Phase 2 separately
authorized.

## Disposition principles

- No finding is rejected, downgraded, or deferred.
- `PH1-REC-6`, originally allowed no later than Phase 4, was pulled into this
  remediation cycle.
- The immutable reviewer findings remain unchanged. Responses and precision
  changes live only in this disposition and the governing ADRs.
- The remediation received a second read-only adversarial audit after the
  required changes; that audit reported all previously identified gaps closed.
- The human approved archive-only for `PH1-OPEN-1`; no implementation evidence
  was substituted for that policy decision.

## Findings

| ID | Disposition | Implementation and acceptance evidence |
|---|---|---|
| PH1-BLOCK-1 | Accepted and fixed | DecisionPoint supersession changes status only when the prior point is open. Resolved and dismissed dispositions keep their status while revision links are added. A database trigger rejects transitions out of resolved/dismissed. PGlite and production-repository tests cover open, resolved, dismissed, rollback, and changed-fingerprint revision cases. |
| PH1-REC-1 | Accepted and strengthened | CI now provides PostgreSQL 17. `v2PostgresConcurrency.test.ts` uses separate pooled connections and the production `NodePgTransactionRunner`; it proves advisory-lock contention returns `command_in_progress`, one mutation executes, redelivery replays one response, `FOR UPDATE` is actually waiting through `pg_stat_activity` plus `pg_blocking_pids`, and COMMIT/ROLLBACK behavior is real. PGlite tests remain fast single-connection evidence only. |
| PH1-REC-2 | Accepted and strengthened | Domain/audit foreign keys use `RESTRICT`; row and statement triggers reject UPDATE, DELETE, and TRUNCATE. Migration preflight fails if `norns_app` is absent or cannot be assumed. Runtime transactions explicitly `SET LOCAL ROLE norns_app`; all operational V2 tables receive CRUD without TRUNCATE, while domain/audit history receives only SELECT/INSERT. PGlite and real PostgreSQL tests prove the privilege boundary. |
| PH1-REC-3 | Accepted | Database and Zod contracts both require Task version zero to be `pending` and AgentRun version zero to be `created`. Importers must synthesize lifecycle history rather than insert naked mid-lifecycle rows. |
| PH1-REC-4 | Accepted and strengthened | Materialized identities are Phase/local-ID scoped. `mergeV2StrategyAmendment()` performs the canonical amendment merge: it preserves lifecycle, evidence, designations, and historical timestamps; updates Task strategy provenance; permits proposal changes only before execution/history lock; adds new entities deterministically; and rejects silent removal, rename, dependency removal, or identity-relationship mutation for the MVP. Tests prove completed work survives amendments without caller-authored overlays. ADR-004 records the rule. |
| PH1-REC-5 | Accepted | Command mutation results now distinguish terminal from retriable failure. Optimistic-concurrency conflicts roll back mutation writes, emit a redacted attributable audit, release the idempotency key, and expose `retriable: true`; the same matching key can then execute against refreshed state. Terminal failures roll back mutation writes, emit the audit, retain the non-retriable response, and replay it. ADR-005 and contract tests pin the client rule. |
| PH1-REC-6 | Accepted early | The architecture fitness guard scans TypeScript, TSX, MTS, CTS, JavaScript, JSX, MJS, and CJS workspace source; detects raw SQL and Drizzle lifecycle writes; includes positive bypass fixtures; and prevents public export/direct import of the mutable V2 table set outside the guarded adapter. |
| PH1-REC-7 | Accepted and strengthened | `mutate()` executes behind a savepoint. Every returned failure rolls back to that savepoint before the application boundary writes the durable failure audit and retains or releases the idempotency key. A fault test proves a handler that inserts a domain row and returns failed commits the failure record/audit but not the domain write. |

## Packaging evidence

The reviewed candidate and remediation are fixed commits:

```text
reviewed candidate:
7244dd8430128b99acb8e5facc4d7575ff3e05a8

remediation candidate:
0b15579757bf6d0320ee537ab728fe3dfdf9d9ac

git status --short immediately after remediation commit:
<empty>
```

The original packaging caveat is therefore closed for the remediation
candidate. The detailed commands, test counts, and single-connection versus
real-PostgreSQL evidence boundary are recorded in
[PHASE-1-REMEDIATION-EVIDENCE.md](PHASE-1-REMEDIATION-EVIDENCE.md).

## Human decision

| ID | Sol recommendation | Status |
|---|---|---|
| PH1-OPEN-1 — project hard deletion | Use archive-only for the MVP and as the normal permanent product path. If a legal erasure or environment-purge requirement later appears, design a separate human-authorized, audited, privileged purge ADR; do not expose hard delete through ordinary application commands. | **Approved by the human on 2026-07-16.** See [PHASE-1-HUMAN-RETENTION-DECISION.md](PHASE-1-HUMAN-RETENTION-DECISION.md). |

## Authorization state

The implementation blocker and every recommended finding were remediated at
`0b155797`. The CI-portable final technical tree is frozen at `50c9e7b`.
The retention decision and final effort checkpoint are committed in
[PHASE-1-FINAL-FREEZE.md](PHASE-1-FINAL-FREEZE.md). The human separately
authorized Phase 2 in
[PHASE-2-START-AUTHORIZATION.md](PHASE-2-START-AUTHORIZATION.md).

# Phase 1 Review Remediation Evidence

**Reviewed candidate:** `7244dd8430128b99acb8e5facc4d7575ff3e05a8`
**Remediation candidate:** `0b15579757bf6d0320ee537ab728fe3dfdf9d9ac`
**Branch:** `refoundation/phase1-domain-persistence`
**Evidence date:** 2026-07-16
**Status:** Technical remediation complete; human retention decision and final
Phase 1 freeze pending

## Fixed-snapshot evidence

```text
$ git rev-parse HEAD
0b15579757bf6d0320ee537ab728fe3dfdf9d9ac

$ git status --short
<empty>
```

The immutable independent findings are in
[PHASE-1-CANDIDATE-REVIEW-FINDINGS.md](PHASE-1-CANDIDATE-REVIEW-FINDINGS.md).
Their dispositions are in
[PHASE-1-CANDIDATE-REVIEW-DISPOSITION.md](PHASE-1-CANDIDATE-REVIEW-DISPOSITION.md).

## Full verification

The final remediation gate ran:

```text
V2_POSTGRES_TEST_URL=postgresql://… pnpm run ci
```

| Workspace | Result |
|---|---:|
| Contracts | 97 passed |
| Adapters | 12 passed, 1 live-provider smoke skipped |
| Web | 37 passed |
| Server | 204 passed, 1 live-planning test skipped |
| Lint | Green |
| Typecheck | Green |
| Build | Green |

The two skips are pre-existing environment-dependent live tests. The run also
produced the existing Vite bundle-size warning and React shorthand-style test
warning; neither is a Phase 1 gate failure.

## Evidence boundary

PGlite remains the fast PostgreSQL-compatible engine for schema, transaction,
reconciliation, role-preflight, and adapter tests. It is a single-connection
engine and is not cited as concurrency proof.

`apps/server/test/v2PostgresConcurrency.test.ts` runs only when
`V2_POSTGRES_TEST_URL` is present. CI supplies a PostgreSQL 17 service. That
suite proves with real pooled connections:

- runtime transactions assume `norns_app`;
- the migration applies grants in the selected current schema;
- runtime CRUD works on operational V2 tables;
- runtime UPDATE, DELETE, and TRUNCATE are denied on domain/audit history;
- advisory-lock contention returns `command_in_progress`;
- one duplicate command performs exactly one mutation and later replays;
- a second `FOR UPDATE` query is observed waiting on the first backend through
  PostgreSQL lock telemetry; and
- the production runner performs real COMMIT and ROLLBACK.

## Finding-to-test map

| Finding | Primary evidence |
|---|---|
| PH1-BLOCK-1 | `v2Application.test.ts`, `v2SqlRepositories.test.ts`, `v2Schema.test.ts` |
| PH1-REC-1 | `v2PostgresConcurrency.test.ts`, PostgreSQL service in `.github/workflows/ci.yml` |
| PH1-REC-2 | `0001_refoundation_v2.sql`, `v2Schema.test.ts`, `v2Database.test.ts`, `v2PostgresConcurrency.test.ts` |
| PH1-REC-3 | `packages/contracts/test/v2-domain.test.ts`, `v2Schema.test.ts` |
| PH1-REC-4 | `mergeV2StrategyAmendment()` and amendment/history-lock/removal tests in `v2-domain.test.ts` |
| PH1-REC-5 | `v2-commands.test.ts`, `v2Application.test.ts`, `v2SqlRepositories.test.ts` |
| PH1-REC-6 | `v2ArchitectureFitness.test.ts` |
| PH1-REC-7 | savepoint failure-write tests in `v2Application.test.ts` plus production audit-adapter coverage in `v2SqlRepositories.test.ts` |

## Migration checksum policy

The reviewed `7244dd8` migration was never authorized for production or a
shared environment. Any database that applied it is disposable verification
state and must be recreated before final-freeze validation. The remediation
therefore amends `0001_refoundation_v2.sql` before its checksum is frozen.

After the final Phase 1 freeze, schema evolution is forward-only through new
numbered migrations.

## Adversarial re-audit

A read-only post-remediation audit rechecked the amendment merge, runtime-role
enforcement, failure audit, lifecycle contract parity, architecture guard,
real lock-wait proof, and pre-freeze migration policy. Result:

```text
All closed.
```

## Remaining gate

This evidence does not claim Phase 1 completion. `PH1-OPEN-1` still requires
the human retention-policy decision. The final effort/variance checkpoint and
contract freeze follow that decision; Phase 2 remains unauthorized.

# Phase 2 Migration and Recovery Runbook

**Status:** Candidate — do not run against production before the Phase 2
independent review is dispositioned and the human authorizes the checkpoint.

## Purpose

This runbook moves the three legacy snapshot sources into the normalized V2
preservation model, proves that the protected database backup restores, and
stops at `shadowing`.

It does not:

- activate project relational writes;
- activate relay or runner execution;
- approve any imported strategy;
- delete a legacy snapshot;
- activate an identity or project route automatically.

## Preconditions

1. The reviewed Phase 2 candidate commit is deployed to the execution
   environment.
2. PostgreSQL role `norns_app` exists as `NOLOGIN`, has no privileged role
   attributes, and the migration login may `SET ROLE norns_app`.
3. A separate `norns_runtime` login exists with no privileged role attributes
   and membership only in `norns_app`. Its URL is the ordinary service's
   `DATABASE_URL`; the owner/migration URL is never present in that service.
4. A protected provider backup has completed and its immutable reference is
   recorded.
5. A separate restore target is available for the recovery drill.
6. Every application instance is stopped. The migration refuses its exclusive
   lease while any application instance holds the shared persistence lease.
7. The archive key and credential-HMAC key are stored as secret environment
   variables, not in the repository, a command argument, or review evidence.

One way to generate each 32-byte value is:

```text
openssl rand -base64 32
```

Store the result directly in the deployment secret manager. Do not paste it
into a ticket, log, chat, or committed file.

## Required variables

| Variable | Purpose |
| --- | --- |
| `NORNS_MIGRATION_DATABASE_URL` | Privileged live PostgreSQL connection used only by offline migration/recovery/cutover commands |
| `NORNS_PHASE2_RUN_ID` | Stable ID reused for every retry of this migration |
| `NORNS_PHASE2_BACKUP_REFERENCE` | Provider backup identifier created before capture |
| `NORNS_PHASE2_BACKUP_PROVIDER` | Backup provider; defaults to `railway` |
| `NORNS_APPLICATION_COMMIT` | Exact deployed commit if the platform does not supply `RAILWAY_GIT_COMMIT_SHA` |
| `NORNS_ARCHIVE_RETENTION_UNTIL` | ISO timestamp after the approved rollback/retention window |
| `NORNS_ARCHIVE_KEY` | Canonical base64 encoding of exactly 32 bytes |
| `NORNS_ARCHIVE_KEY_ID` | Non-secret archive-key version identifier |
| `NORNS_CREDENTIAL_HMAC_KEY` | Canonical base64 encoding of exactly 32 bytes |
| `NORNS_CREDENTIAL_HMAC_KEY_ID` | Non-secret credential-key version identifier |
| `NORNS_PHASE2_HUMAN_ADMIN_ID` | Active administrator who explicitly authorizes identity cutover |

The ordinary application uses a separate variable set:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Restricted `norns_runtime` connection; never the migration/table-owner URL |
| `NORNS_CREDENTIAL_HMAC_KEY` | Current credential issuance key |
| `NORNS_CREDENTIAL_HMAC_KEY_ID` | Current registered key identifier |
| `NORNS_CREDENTIAL_HMAC_KEYRING` | Optional JSON map of prior registered key IDs to base64 keys while live credentials still reference them |

`NORNS_MIGRATION_DATABASE_URL`, `NORNS_ARCHIVE_KEY`, and
`NORNS_ARCHIVE_KEY_ID` must be absent from the ordinary application
environment. Startup checks the actual PostgreSQL login posture and refuses to
run if it can read archive ciphertext or has superuser, role/database creation,
replication, or row-security bypass authority.

For the restore drill, also supply:

| Variable | Purpose |
| --- | --- |
| `NORNS_RESTORED_DATABASE_URL` | Separate database restored from the named pre-cutover backup |

## Checkpoint and import

With all application instances stopped, run:

```text
pnpm --filter @norns/server migrate:phase2
```

The command:

1. takes the exclusive migration lease;
2. applies every checksum-pinned forward migration through the current release;
3. captures every `norns_state` row in one pinned transaction;
4. encrypts and records exact source archives;
5. imports identity with all legacy sessions and invitations revoked;
6. removes reusable session/invitation material from the live legacy users
   snapshot;
7. imports and reconciles every project independently;
8. verifies project ledgers and step evidence; and
9. leaves the migration run at `shadowing`.

The JSON result contains only IDs, hashes, status, and non-secret counts.
Retain it with the gate evidence. A failure may be retried with the same
`NORNS_PHASE2_RUN_ID`; completed work is replayed and conflicting source
identity fails closed.

## Restore drill

Restore the provider backup into a separate database. Never point
`NORNS_RESTORED_DATABASE_URL` at the live database.

Then run:

```text
pnpm --filter @norns/server verify:phase2-restore
```

This command:

1. takes the live exclusive migration lease;
2. reads expected exact and semantic hashes from the live checkpoint;
3. reads `norns_state` only from the restored database;
4. requires the restored source-key set and every hash to match;
5. stamps the live recovery checkpoint and encrypted archives once; and
6. writes an immutable `recovery_restore_verification` migration step and
   per-archive access evidence.

It does not change a persistence route.

## Required evidence before identity cutover

The durable control repository requires the latest observation for every named
identity proof to be green:

- public user projection matches;
- every retained legacy session and invitation token is rejected;
- a normalized session survives service restart; and
- expired and revoked normalized credentials are rejected.

Recording one unrelated green comparison cannot authorize cutover. Route
activation is a separate, explicit control action after review and human
approval. Once identity writes become relational, the Phase 2 policy forbids
reactivating legacy identity credentials.

Every comparison is bound by PostgreSQL to the current migration manifest,
the relevant live `norns_state` source hash and revision, and the database
transaction time. Caller timestamps and caller-supplied provenance are
ignored. Evidence older than the successful restore drill, evidence for a
stale source revision, and a later mismatch cannot authorize cutover.

## Fenced identity cutover

Keep every application instance stopped from the final checkpoint/proof pass
through cutover. Do not restart the legacy application in this window: it can
mint sessions or change the source after it was proved. If it is restarted,
stop it again and create a new approved supplemental checkpoint/proof set
before proceeding.

After the restore drill, all four current identity proofs, resolution or
explicit human disposition of every blocking finding, and human approval, run:

```text
pnpm --filter @norns/server cutover:phase2-identity
```

The command acquires and holds the exclusive application persistence fence. In
the same privileged transaction that writes the route and immutable audit it
rechecks the recovery checkpoint and restore step, migration status, current
source hash/revision, sanitized legacy users snapshot, all named green proofs,
all blocking findings, and the active administrator. Caller timestamps are
not accepted. A successful transaction creates the forward-only
`relational`/`relational` identity route and moves the run through readiness to
`cutover`.

The command then exits. It never starts the application. Restart The Norns as
a separate operator action using only the restricted runtime database login;
do not expose the privileged migration URL or archive keys to that process.

## Project shadowing

Project reads may be compared through `ShadowProjectRepository`, which returns
the legacy value and stores only hashes and redacted JSON-pointer differences.
The latest `summary` and `pmSelectionOf` observations must be green; a planned
project also requires a green `graph` observation. Project mutations remain
on the legacy `ProjectStore` in both legacy and shadow modes. The Phase 2
router delegates them to that source; no relational project mutation exists
before Phase 3.

Local repository paths remain only in the protected legacy archive. Relational
compatibility rows store an opaque fingerprint and a basename; mismatch
evidence never stores the raw path.

## Rollback

The Phase 2 rollback drill is deliberately narrow. It proves reversal of
`project` and `new_projects` **read canaries before identity credential
cutover**. It is not a general database rollback and cannot reverse project
writes, relay execution, or credential migration.

Stop every application instance and take the exclusive Phase 2 migration
lease. The privileged rollback control then runs in two steps:

1. `SqlPhase2RollbackController.prepare(migrationRunId)` derives the active
   project/new-project canary scopes, route versions, legacy freeze/source
   timestamps, last included legacy project record, affected project IDs,
   record counts/revision fingerprints, visibility windows, and the
   conservative data-loss window directly from PostgreSQL. It persists the
   exact immutable report. The caller cannot provide or override any scope,
   timestamp, count, or source marker.
2. Display that report and its fingerprint to the active administrator. Within
   five minutes, pass only its `evidence_id`, exact `report_fingerprint`, and
   the authenticated administrator's user ID to
   `approveAndReverse(...)`. The transaction re-locks the migration and every
   route, re-derives the evidence, and refuses stale or changed state. It then
   records the immutable human approval and audit events in the same
   transaction that changes every eligible read route back to `legacy`.

No approval row can exist without all route reversals committing, and no route
reversal from this control can commit without its approval and audit evidence.
Normalized rows, archives, migration evidence, and comparison evidence are
never deleted. Evidence and approval tables are append-only; the runtime role
may read but cannot manufacture either record.

Identity credential cutover is forward-only in both the route policy and a
database trigger. Once `v2_writes_started_at` is present, the identity route
cannot point reads or writes at the legacy snapshot and the timestamp cannot be
cleared. A write freeze may pause normalized credential issuance, but it does
not permit legacy credential reuse.

If recovery is required after identity cutover, do not edit the route and do
not start an old restored database as the application. Restore the protected
pre-cutover backup into an offline target, run the Phase 2 preservation and
credential-sanitization workflow again under a new migration run, repeat the
restore and credential-rejection proofs, and only then authorize a new
cutover. This is restore-and-re-run before service, not reactivation of an
archived session or invitation token.

## Login abuse control

The single-instance MVP rejects a sixth failed login for the same normalized
account/IP pair during a rolling 15-minute window and returns a bounded
`Retry-After`. A successful login clears that pair. This closes the Phase 2
brute-force gate; a shared distributed limiter remains a later requirement if
multi-instance control-plane operation is authorized.

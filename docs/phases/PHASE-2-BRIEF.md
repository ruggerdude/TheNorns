# Phase 2 Brief — Legacy Migration and Recovery Checkpoint

**Status:** Authorized — implementation starting
**Authorized:** 2026-07-16
**Branch:** `refoundation/phase2-preservation-migration`
**Phase 1 technical baseline:** `50c9e7b0576f31d32ec01994c069b72c07e7e031`
**Program baseline:** 12 FSE
**Program manager / integration owner:** ChatGPT Sol
**Primary implementation:** Backend Sonnet
**Recovery, race, and reconciliation verification:** Codex
**Independent migration review:** Claude Fable 5

## Objective

Create a recoverable, deterministic bridge from the three legacy snapshot
blobs into the normalized V2 identity and project model without deleting
source data, inventing identities, carrying reusable legacy credentials, or
activating execution.

The phase ends with identity capable of a proven cutover and project state
capable of shadow-read comparison. Project mutation remains legacy until
Phase 3; relay/dispatch remains legacy until Phase 4.

## Work packages

### P2-A — Forward contracts and schema closure

- Add migration/archive/reconciliation contracts and stable finding codes.
- Add forward migration `0002`; never edit frozen `0001`.
- Represent invited users, nullable legacy names/password state, hash scheme,
  revoked session/invitation inventory, and first-login rehash metadata.
- Add encrypted snapshot archive metadata, access log, recovery checkpoint,
  migration step ledger, project import provenance, ID mappings, findings,
  shadow comparisons, and durable routing state.
- Preserve PM provider/model preferences and raw unverified local/GitHub
  source candidates without fabricating runner, workspace, installation, or
  credential identities.
- Preserve historical legacy allocation approval separately from V2 Strategy
  approval.
- Add explicit legacy import/genesis event payloads.
- Keep the runtime role unable to delete immutable history or read archive
  ciphertext.

Owner: one schema/contracts writer.
Review: Sol and Codex.

### P2-B — Encrypted recovery checkpoint

- Acquire an exclusive migration lock and refuse capture while a legacy app
  flusher is active.
- Capture every `norns_state` row, including unknown keys, in one pinned,
  repeatable-read transaction.
- Record exact source text, source hashes, bundle hash, object counts, last
  included records, freeze timestamp, transaction/WAL markers, application
  commit, and database-backup identity.
- Encrypt archive payloads with authenticated encryption, injected key
  identifiers, per-object nonces, bound associated data, and ciphertext
  hashes.
- Log every archive read and deny ciphertext access to the runtime role.
- Exercise a real database backup and restore, not only a logical marker.

Owner: persistence/recovery implementation.
Fault and restore verification: Codex.

### P2-C — Identity import and credential cutover

- Preserve user IDs, normalized usernames/email addresses, nullable names,
  roles, admin state, creation metadata, and legacy scrypt password hashes.
- Import legacy sessions and invitations only as attributed, revoked hashed
  inventory.
- Replace live credentials with opaque split tokens whose stored verifier is a
  keyed hash and whose lifetime/revocation are server-enforced.
- After the encrypted archive and import commit, atomically sanitize reusable
  session/invitation tokens from the live legacy users snapshot.
- Revoke existing sessions, close authenticated live connections, and require
  one explicit re-login.
- Rehash legacy passwords on the first successful explicit login.
- Prove that no plaintext token from any retained archive authenticates.

Owner: identity migration implementation.
Security/race verification: Codex.

### P2-D — Deterministic project import and reconciliation

- Parse the frozen ProjectStore snapshot tolerantly but validate plans, graph
  nodes, edges, assignments, and approvals independently.
- Preserve project IDs, timestamps, names, descriptions, PM preferences,
  source metadata, exact source hashes, graph version, plan/graph payloads,
  assignments, and historical approval evidence.
- Use stable IDs derived from source identity, never a random migration-run
  identity.
- Draft projects import without a fabricated phase.
- Planned projects import one initial Phase and an unapproved
  StrategyVersion, with Tasks built over the plan/graph union.
- Graph-only nodes become visibly non-executable placeholders with must-fix
  findings. Plan-only/deleted modules retain history and reach `cancelled`
  through the lifecycle chokepoint.
- Current graph dependencies and allocations are the operational projection;
  exact legacy source remains available through protected provenance.
- Legacy approval uses `actor_type = legacy`, never fabricates a V2 user, and
  never satisfies V2 Strategy approval.
- Every imported planned project remains paused or blocked and non-executable
  until must-fix findings are resolved and a human approves a fresh V2
  StrategyVersion.

Owner: project migration implementation.
Reconciliation verification: Codex.

### P2-E — Shadow reads, cutover controls, and rollback

- Store routing per bounded scope with explicit legacy, shadow, frozen, and
  relational modes.
- Shadow mode returns legacy project reads while comparing deterministic V2
  projections and recording redacted, structured mismatch evidence.
- A mismatch blocks project read cutover.
- Identity may cut over after its complete proof.
- Project relational writes remain disabled; canary scope covers read
  comparison only.
- Relay remains legacy and is only archived/accounted for in this phase.
- Rollback is a visibility/routing operation; it never deletes V2 writes.
- Before rollback approval, report legacy freeze time, V2 records created or
  changed, affected scopes, hidden records, and the resulting visibility/data
  loss window.

Owner: integration/cutover implementation.
Recovery verification: Codex.

### P2-F — Gate evidence

- Unit tests for canonical JSON, crypto tamper detection, stable IDs, finding
  determinism, and credential non-reuse.
- PGlite tests for forward migration, archive metadata, identity/project
  import, lifecycle fold parity, and idempotent restart.
- Real PostgreSQL tests for exclusive locks, concurrent import, restricted
  roles, fault rollback, durable routing, backup/restore, and restart.
- Required project fixtures: clean draft, clean planned/unallocated,
  graph-only node, deleted module, changed shared fields, edge added/removed,
  orphan dependency, changed assignment, stale structure approval, tampered
  approval hash, unattributable actor, multi-worker assignment, invalid plan,
  and duplicate graph node.
- Independent Claude Fable migration-semantics review and immutable
  disposition before final freeze.

Owner: Codex plus Sol.

## Stable reconciliation classes

The implementation contract must distinguish at least:

- invalid plan or graph payload;
- plan/graph presence mismatch;
- graph-only and plan-only/deleted task identity;
- shared task field mismatch;
- unavailable or non-round-tripping acceptance data;
- added, removed, or orphaned dependency edges;
- missing, changed, or non-representable multi-worker assignments;
- stale graph version, allocation fingerprint, or approval content hash;
- unattributable legacy approval actor;
- changed source after freeze;
- imported count or checksum mismatch;
- unknown snapshot key;
- nonterminal legacy command inventory.

The contract owns the exact machine-readable identifiers and severities.

## Invariants

1. The complete frozen source is durable before transformation begins.
2. Archive encryption and access control fail closed.
3. No plaintext session or invitation token is stored in normalized state.
4. No retained legacy credential authenticates after cutover.
5. Every migration step is restart-safe and either commits completely or
   leaves no partial aggregate.
6. Stable source produces byte-stable semantic hashes, IDs, findings, and
   canonical projections.
7. No V2 identity, runner, repository, approval, or execution authority is
   fabricated from ambiguous legacy data.
8. Legacy allocation approval is historical evidence only.
9. Imported projects are non-executable pending reconciliation and fresh V2
   approval.
10. Archive-only is the normal MVP retention path; hard delete is absent.
11. Project relational writes and relay/execution cutover remain outside
    Phase 2.

## Exit gate

- Every legacy snapshot key, user, project, and relevant relay record is
  accounted for by source hash, count, or an explicit finding.
- A protected backup restores and the restored source hashes match the frozen
  checkpoint.
- Repeated and crash-interrupted imports converge without duplicate or partial
  records.
- No unexplained ID, count, checksum, reference, or lifecycle-fold mismatch
  remains.
- No token string present in an archive authenticates; expired/revoked
  credentials and brute-force paths are rejected as designed.
- Every project has a deterministic reconciliation report and fixture-specific
  finding codes.
- Legacy allocation evidence never produces a V2 Strategy approval.
- Identity cutover and rollback routing are demonstrated.
- Project shadow reads match clean legacy fixtures and block on a mismatch.
- The rollback report states the freeze timestamp, affected records, and
  visibility/data-loss window.
- No legacy snapshot is deleted and no project hard-delete path exists.
- Independent findings and dispositions are committed.

Phase 3 cannot begin on component tests alone. It requires this complete gate
and a separate human authorization.

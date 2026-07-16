# Phase 2 Start Authorization

**Authority:** Human operator
**Authorization date:** 2026-07-16
**Recorded by:** ChatGPT Sol
**Source instruction:** “Approve archive-only for the MVP. Start Phase 2 —
Legacy Migration and Recovery Checkpoint.”
**Authorized phase:** Phase 2 — Legacy Migration and Recovery Checkpoint
**Implementation branch:** `refoundation/phase2-preservation-migration`

## Preconditions satisfied

- Phase 1 independent review is complete.
- All Phase 1 findings were accepted and remediated.
- `PH1-OPEN-1` is closed by the archive-only decision.
- The Phase 1 effort checkpoint and final technical freeze are recorded.
- GitHub CI is green at the Phase 1 technical freeze.

## Authorized scope

Phase 2 may:

- add forward migration `0002` and versioned migration contracts;
- create an encrypted, checksummed, access-logged recovery checkpoint;
- import users while preserving account identity and password hashes;
- revoke legacy sessions and invitations and require one explicit re-login;
- sanitize reusable credentials from the live legacy identity snapshot after
  the protected archive is durable;
- deterministically import legacy project state and reconciliation evidence;
- shadow-compare legacy and relational project reads;
- canary and complete identity read/write cutover after its exit evidence;
- exercise reversible project read routing and rollback reporting.

Phase 2 may not:

- edit frozen migration `0001`;
- delete a legacy snapshot or hard-delete a project;
- translate legacy allocation approval into V2 Strategy approval;
- make imported projects executable before reconciliation and fresh human V2
  Strategy approval;
- activate relational project mutation commands, repository ingestion, or
  phase-amendment workflows assigned to Phase 3;
- normalize or cut over relay/dispatch/execution state assigned to Phase 4;
- enable real-repository execution.

## Next gate

Phase 3 remains unauthorized until Phase 2's production-shaped migration,
restore, credential-revocation, reconciliation, shadow-read, and rollback
evidence passes independent review and receives a separate human start
instruction.

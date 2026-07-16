# Phase 3 Start Authorization

Date: 2026-07-16

Phase 2 was independently reviewed and approved by the human program owner.
The archive-only MVP retention policy is approved. Phase 2 candidate branch
`refoundation/phase2-preservation-migration` is frozen at the reviewed and
post-review PostgreSQL exit proof (`aaa4f54`).

Phase 3 is authorized on branch `refoundation/phase3-existing-projects`.

## Approved scope

- Bind existing projects to durable source identities.
- Implement existing-project ingestion and reconciliation workflows.
- Add persistent phase and objective services on the approved V2 contracts.
- Preserve legacy-owned project writes until the explicitly gated cutover.
- Implement the GitHub App credential-broker flow if required by the approved
  repository binding, keeping private keys server-only and tokens out of
  envelopes, logs, artifacts, and sandbox environments.

## Controls

- No relay/dispatch execution activation; that remains Phase 4 scope.
- No unapproved schema replacement or destructive migration.
- Every source import is immutable, hash-bound, replay-safe, and reviewable.
- New contracts and migration decisions require independent review before the
  next phase gate.

Phase 3 implementation must stop at its exit gate until the independent review
and human disposition are complete.

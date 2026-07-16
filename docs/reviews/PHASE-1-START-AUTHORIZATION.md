# Phase 1 Start Authorization

**Phase:** Domain and Persistence Foundation
**Human instruction:** “Proceed”
**Authorized:** 2026-07-16
**Recorded by:** ChatGPT Sol
**Starting commit:** `aa351a07fd9d4716fe49a632af127473703b4d9a`
**Implementation branch:** `refoundation/phase1-domain-persistence`

## Interpretation

The instruction followed the explicit Phase 1 gate and is recorded as
authorization to begin:

> Start Phase 1 — Domain and Persistence Foundation.

## Authorized scope

- V2 domain and application-command contracts.
- Task and AgentRun lifecycle/projection contracts.
- Normalized PostgreSQL/Drizzle schema and additive migrations.
- Domain/audit event, idempotency, budget-reservation, command, and
  transactional-outbox semantics.
- Transactional repository/application boundary.
- Compatibility repositories that preserve legacy APIs and data.
- Fault-injection, concurrency, reconciliation, and backup/restore evidence.
- Candidate contract freeze and independent Claude Fable review packet.

## Excluded scope

- Phase 2 production migration or cutover.
- GitHub App implementation.
- Real coordinator-to-runner execution activation.
- Attention/Resume production UI.
- Multi-agent production scheduling.
- Legacy snapshot deletion or retirement.

## Gate behavior

Phase 1 may proceed to a candidate contract freeze and implementation
verification. Final contract freeze and Phase 1 closure require the independent
Claude Fable contract review and disposition required by REF-REC-8.

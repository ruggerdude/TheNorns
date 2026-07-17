# Phase 1 Human Retention Decision

**Authority:** Human operator
**Decision date:** 2026-07-16
**Recorded by:** ChatGPT Sol
**Source instruction:** “Approve archive-only for the MVP. Start Phase 2 —
Legacy Migration and Recovery Checkpoint.”
**Related finding:** `PH1-OPEN-1`
**Related review:**
[PHASE-1-CANDIDATE-REVIEW-FINDINGS.md](PHASE-1-CANDIDATE-REVIEW-FINDINGS.md)

## Decision

Archive-only is approved for the MVP and is the normal project-retention path.

- Ordinary application commands may archive and restore projects.
- Ordinary application commands must not hard-delete projects or their
  domain, audit, migration, approval, evidence, or execution history.
- Database foreign keys remain restrictive rather than cascading through
  immutable history.
- A future legal-erasure or environment-purge requirement must be designed in
  a separate ADR with explicit human authorization, least-privilege execution,
  an immutable purge record, and recovery/retention analysis.
- Phase 2 must preserve the complete frozen legacy source before any
  transformation and must not delete legacy snapshots.

## Gate effect

This decision closes `PH1-OPEN-1`. Together with the final Phase 1 freeze and
the explicit Phase 2 start instruction, it permits Phase 2 work within the
scope recorded in
[PHASE-2-START-AUTHORIZATION.md](PHASE-2-START-AUTHORIZATION.md).

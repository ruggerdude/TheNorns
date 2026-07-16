# Phase 2 Candidate Evidence — Legacy Migration and Recovery Checkpoint

Status: candidate snapshot for independent review; Phase 3 is not authorized.

## Scope

This candidate implements the Phase 2 brief: additive preservation schema, encrypted legacy archives, replay-safe identity and project import, shadow reads, recovery verification, controlled rollback, restricted runtime database access, credential/session hardening, and a fenced, restart-required identity cutover. The MVP retention decision is archive-only: projects are never hard-deleted in Phase 2.

## Verification executed

- `pnpm -r typecheck` — green for contracts, adapters, runner, web, and server.
- `pnpm --filter @norns/server typecheck` — green.
- Server Vitest suite — green, including migration, restore, identity, rollback, project routing, cutover, and concurrency coverage.
- Focused cutover, restore, identity, rollback, project-import, and schema suites — green.
- `git diff --check` — clean.

The real PostgreSQL exit test is Docker-gated and is recorded separately when the environment provides Docker/PostgreSQL.

## Safety assertions

- Ordinary runtime credentials cannot write migration routes, archives, findings, or cutover records.
- Privileged migration operations require the exclusive Phase 2 process lease.
- Cutover binds source hashes, manifest, application revision, recovery proof, restore verification, active administrator, and sanitized credential evidence in one transaction.
- Identity routing is forward-only after cutover and requires an operator restart.
- Archive ciphertext is encrypted, key-fingerprint bound, and validated before recovery stamps are written.
- Session and invitation credentials are HMAC-protected, revocable, expiry-bound, and rate limited.
- Project writes remain legacy-owned during the shadow period; relational project reads are constrained to imported phase/strategy scope.

## Review packaging

The final candidate commit must include `REVIEW_COMMIT.txt` containing `git rev-parse HEAD`, `git status --short`, and the parent SHA. This document and the Phase 2 runbook are immutable review artifacts. Findings, dispositions, and any later changes must be recorded under `docs/reviews/`.

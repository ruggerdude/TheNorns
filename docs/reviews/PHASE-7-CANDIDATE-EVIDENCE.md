# Phase 7 Candidate Evidence — Hardening, Pilot, and Cutover

Date: 2026-07-16

Status: implementation and verification complete under the human owner's
manual-gating policy.
Candidate branch: `refoundation/phase6-7-completion`.
Phase 6 implementation baseline: `0201aca`.
Phase 7 implementation commit: `8d3bca05e5fb7a8c92d668312be24d0a9a6dc677`.

## Security and resilience delivered

- Secure, HttpOnly, SameSite=Strict browser sessions with double-submit CSRF
  validation; the browser receives no raw bearer credential in JSON and stores
  only a non-secret presence marker.
- Recent-auth enforcement on high-risk administrator mutations.
- Server-side session inventory, current-session identification, and revocation.
- One-hour, single-use password recovery with HMAC-only token storage, account
  enumeration resistance, all-session revocation, and durable security notices.
- Durable runner revocation by generation. Scheduling and event ingestion both
  reject stale/revoked generations while permitting a newly paired generation.
- Append-only resilience drill, cutover, and legacy-retirement evidence.
- Progressive cutover state transitions with restore and reconciliation gates.
- Machine assertion that relational persistence is authoritative for every
  active project and all newly created projects.
- A separately guarded legacy-retirement authorization. No destructive legacy
  deletion is included or implied.

## Existing-project pilot evidence

The production-shaped persistent-project scenario opens an existing project,
uses its retained phase and task graph, allocates dependent and parallel work
across OpenAI and Anthropic profiles, executes runner events through verification
and review, completes reviewer-directed rework, records a strategic
DecisionPoint, closes the phase, captures project memory, reconstructs a new
coordinator after restart, and later reopens the project from relational state.
The later Resume result correctly presents the unresolved strategic decision as
the next human action rather than proposing unrelated work.

This is a production-shaped local pilot against the real relational contracts,
PostgreSQL behavior, source-binding/phase workflows, provider-family registry,
and runner protocol. It does not claim that a Railway production repository was
mutated during the gate.

## Recovery and attack evidence

- A disposable PostgreSQL 17 service produced a real custom-format `pg_dump`,
  restored it into a distinct database, and verified exact and semantic hashes
  for all frozen legacy sources.
- A second real-PostgreSQL run passed the multi-connection advisory-lock,
  transaction-runner, migration-lock, preservation, restricted-role, and
  decrypted restore checkpoint suites.
- Browser and HTTP tests prove cookie flags, absence of a browser bearer token,
  CSRF refusal, recent-auth refusal, session inventory/revocation, recovery token
  consumption, old-password refusal, and old-session invalidation.
- Runner tests prove revoked-generation refusal and later-generation acceptance.
- Existing Phase 4/6 restart, stuck-run, dead-letter, reviewer-rework, budget,
  audit, sandbox, and network-denial tests remain green.

## Verification record

- `pnpm run lint`: passed, 292 files checked.
- `pnpm run typecheck`: passed for all five built workspaces.
- Full workspace test run: 524 passed, 9 skipped.
  - contracts: 107 passed;
  - adapters: 12 passed, 1 live-provider test skipped;
  - web: 40 passed;
  - server: 365 passed, 8 environment-gated tests skipped.
- Separate real-PostgreSQL gate: 7 passed across backup/restore, preservation,
  concurrency, and migration locking; these are the tests skipped when the
  normal suite has no disposable database URL.
- Local browser inspection confirmed the login, password-recovery request, and
  reset-link screens render correctly; the reset screen states that all existing
  sessions will be revoked.

The Vite build reports an existing advisory that the main web chunk exceeds
500 kB. It is not a correctness or security failure, but code splitting remains
a follow-on performance improvement.

## Exit disposition

- Existing-project pilot: accepted under the human owner's manual gate and the
  production-shaped evidence above.
- Recovery objectives: demonstrated through real PostgreSQL restore and
  generation/restart tests.
- Security gate: automated attack-path checks and browser inspection passed.
  No claim of a separate Claude review is made because the owner removed the
  automatic reviewer hold.
- Relational authority: enforced by the progressive-cutover service and proven
  in the Phase 7 database scenario.
- Legacy retirement: authorization prerequisites are implemented and proven;
  destructive retirement remains separately human-approved, exactly as the
  program requires.

Phase 7 implementation is complete. The only intentionally open operation is
the later, destructive legacy-retirement change after its distinct approval.

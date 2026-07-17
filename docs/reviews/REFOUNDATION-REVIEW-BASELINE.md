# Re-foundation Review — Reviewer Pre-Read Baseline

**Reviewer:** Claude Fable 5 (independent architecture reviewer, per program assignment)
**Date:** 2026-07-16 · **Baseline:** `main` @ `4ee3b8a` (archive dated 2026-07-15 21:14, 198 files, post-NORN-042)
**Status:** Pre-read only. The Phase 0 re-foundation documents were **not present** in the provided archive; review of ADR-004–007 and the charter is pending their receipt.

---

## 1. Received vs. not received

**Received:** full `main` source; PRD R4; ADR-001–003; GATE-1 packet; REVIEW-001/002 dispositions; PLAN.md, todo.md, progress.log, STAFFING.md.

**Not received** (uncommitted local files, therefore absent from any `main` archive): `PROGRAM-CHARTER.md`, `PHASE-0-ARCHITECTURE-REVIEW.md`, `REFOUNDATION-PROGRAM.md`, `ADR-004` through `ADR-007`, `REFOUNDATION-REVIEW-PACKET.md`.

**Method and limits:** static read of source and documents at the pinned commit. The test suite was **not executed**; test counts below are as claimed in progress.log. I can run the full suite during the main review if useful.

---

## 2. Baseline observations (verified against source at `4ee3b8a`)

These are facts about current `main` that the Phase 0 documents will be evaluated against.

**B-1 — The persistence substrate diverges from the accepted architecture.**
ADR-001 (accepted 2026-07-14) specifies: append-only event log in Postgres, node state via a deterministic reducer, a normalized Drizzle schema, a durable `dispatch_jobs` table claimed with `FOR UPDATE SKIP LOCKED` + leases, and budget reservations as atomic Postgres transactions. What `main` actually does (`apps/server/src/persistence/pg.ts`, `apps/server/src/main.ts`): all state — command outbox, runner event log, audit trail, budget ledger, projects, plans, graphs, user accounts, live sessions — is held in process memory and flushed as **three whole-state JSONB snapshot blobs** (`relay`, `projects`, `users`) on a ~1-second change-detected interval. In plain terms: instead of the approved row-by-row database design, the entire system state is periodically saved as three big JSON documents. The code's own comment acknowledges a loss window of one flush interval on a hard crash and frames the ADR-001 schema as "the scale follow-on." The `DispatchLoop` (`engine/dispatchLoop.ts`) implements the lease/poll semantics correctly, but over the in-memory store — the durability the pattern exists to provide is not there yet.

**B-2 — Audit-trail durability and growth.**
The "complete audit trail" is an in-memory array serialized inside the `relay` snapshot (`stores.ts`). Consequences: the most recent entries (up to one flush interval) can be silently lost on crash — the one record class that should never be lossy — and the array grows without bound inside a blob rewritten on every change. Any re-foundation persistence ADR should treat audit as first-class append-only storage, not snapshot cargo.

**B-3 — Auth drifted twice, the second time out of scope, with no ADR.**
Accepted spec: single-operator WebAuthn passkeys (ADR-001), with an explicit note that multi-user "gets replaced wholesale if it ever lands." GATE-1 declared deviation #1 (bearer token, temporary). NORN-042 (2026-07-15) then shipped a **multi-user** password/session/invite system with roles and admin panels. That is a product-scope change, not just a mechanism swap, and no ADR records it. Open item for the full review: whether session tokens are stored hashed, given that live sessions are persisted inside the `users` snapshot.

**B-4 — Architecture-relevant changes landed outside the decision process after the GATE-1 packet.**
The multi-project `ProjectStore` replacing the single global graph (NORN-039) and the multi-user auth system (NORN-042) have no ADRs. NORN-041 records "3 ADRs decided" for the UI remediation program (allocation fingerprint, no unaudited plan-override, dashboard containment) — no corresponding files exist in `docs/adr/`. The snapshot-persistence choice (NORN-024) was a conscious, code-commented interim step and was declared in GATE-1 deviation #2, but was never ratified as an ADR amendment. For contrast, the Railway hosting move **was** handled correctly — ADR-002 carries a dated, human-approved amendment adopting its own designated fallback. That is the model the other changes should have followed.

**B-5 — No completed independent review of any implementation exists.**
REVIEW-001 and REVIEW-002 (both 2026-07-13) predate all code. The GATE-1 packet was assembled 2026-07-14 at 108 tests but has no disposition anywhere on the branch, and `main` has since advanced roughly ten work items past it (Railway deploy, snapshot persistence, runner CLI, live planning, multi-project, UI remediation, user accounts). The one adversarial implementation review attempted (UI program Phase 7, Agent E) stalled for ~12 hours and was killed, and was correctly treated as incomplete rather than backfilled. Net: every line of shipped implementation is currently unreviewed by an independent party.

**B-6 — What is sound and should be preserved.**
The contracts package and protocol semantics are coherent and carefully test-pinned: command state machine with first-terminal-commits, contiguous event sequences with watermark replay, durable-dedup semantics, per-runner generation fencing, a pure deterministic reducer with determinism/idempotency harnesses, and honest capability matrices. These match the REVIEW-001 P0-2/P0-3 dispositions at the semantic level. The gap is the **substrate under** those semantics, not the semantics themselves. A re-foundation that rewrites the protocol layer rather than re-platforming its persistence would be destroying the best-verified part of the system.

---

## 3. Criteria the Phase 0 review will apply

Published in advance so the packet can anticipate them.

1. **Do ADR-004/005 close B-1/B-2 concretely?** Not just target architecture, but the migration path: snapshot → event log + outbox cutover, backfill of existing project/user state, dual-write or freeze window, schema versioning and replay.
2. **Does the charter fix the governance failures behind B-3/B-4?** Specifically: what may merge to `main` without review, who dispositions findings, where the human gate sits, and how "decided" ADRs become committed files.
3. **Does the program restore independent verification, given B-5?** Either the GATE cadence resumed against current `main`, or an equivalent mechanism — with the packet-then-freeze discipline that GATE-1's aftermath lacked.
4. **Scope honesty on shipped-but-off-spec features.** Multi-user auth and multi-project each need one of: a ratifying ADR, or a rollback decision. Silence is the only unacceptable disposition.
5. **Preservation of B-6.** The plan should state explicitly what is *not* being re-founded.

---

## 4. To proceed

Commit the eight Phase 0 documents to a branch and push, then provide that branch's archive (or the eight files directly). The review will pin to that commit SHA, so findings and their dispositions trace to a fixed snapshot.

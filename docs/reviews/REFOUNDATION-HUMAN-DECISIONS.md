# Re-foundation Human Decisions

**Authority:** Human operator
**Decision date:** 2026-07-16
**Recorded by:** ChatGPT Sol
**Source instruction:** “Approve all four”
**Related review:** [REFOUNDATION-REVIEW-FINDINGS.md](REFOUNDATION-REVIEW-FINDINGS.md)
**Disposition:** [REFOUNDATION-REVIEW-DISPOSITION.md](REFOUNDATION-REVIEW-DISPOSITION.md)

## Decisions

### REF-OPEN-1 — GitHub App in MVP

**Decision:** Approved.

GitHub App login, installation authorization, and repository selection remain
inside the MVP. The local-runner binding may be used for the first execution
vertical slice, but GitHub App binding must pass its Phase 3 trust-boundary
gate before the real-project pilot.

### REF-OPEN-2 — Session cutover

**Decision:** Approved.

Migration cutover revokes every active legacy session and unused invitation,
requires one explicit re-login, and preserves account/session audit metadata.
Retained legacy archives are encrypted, access-controlled, logged, and
time-bounded. No credential string present in an archive may authenticate
against the live system after cutover.

### REF-OPEN-3 — Concurrent active phases

**Decision:** Approved.

The MVP default is one executing phase per project. Multiple proposed,
awaiting-approval, approved, blocked, completed, or cancelled phases may
coexist, but no more than one phase executes unless a later human-approved
policy change raises the limit.

### REF-OPEN-4 — Effort and cost envelope

**Decision:** Approved.

The seat-first hybrid posture is authorized:

- 116 planned FSE;
- 29 FSE central contingency;
- 145 FSE maximum program envelope;
- 9–16 week planning window, excluding human and infrastructure pauses;
- expected incremental metered API spend of $150–300;
- $400 phase API allocation plus $100 central API reserve;
- $500 hard incremental metered-API cap;
- subscription-seat and infrastructure spending remain separate disclosed
  ledgers and require separate approval when new spend is introduced.

The scope assumptions match the approved baseline, so recalculation leaves the
phase allocations, contingency, envelope, and 80%/100% program thresholds
unchanged.

## Authorization effect

These decisions close `REF-OPEN-1` through `REF-OPEN-4`. They do **not**
authorize implementation.

Phase 1 remains stopped until the human separately issues:

> Start Phase 1 — Domain and Persistence Foundation.

# Re-foundation Program-Control Tabletop

**Control:** REF-REC-9 — 150% phase pause
**Date:** 2026-07-16
**Facilitator:** ChatGPT Sol
**Status:** Passed as a pre-implementation governance simulation
**Scope:** Program authorization control only; this is not evidence that a
future Norns runtime enforcement feature has been implemented.

## Policy under test

When either:

```text
actual + committed
```

or:

```text
EAC = actual + committed + forecast_remaining
```

reaches or exceeds 150% of the phase baseline:

1. Phase status becomes `paused`.
2. New implementation commitments are rejected.
3. Only containment, rollback, and evidence-preservation work may continue.
4. Resume requires a human decision to increase budget, reduce scope, approve
   redesign/reassignment, or terminate.

## Scenario

Phase 1 baseline:

```text
14 FSE
```

Pause threshold:

```text
14 × 1.50 = 21 FSE
```

Observed control state:

| Field | Value |
|---|---:|
| `actual` | 12 FSE |
| `committed` | 8 FSE |
| `forecast_remaining` | 1 FSE |
| `actual + committed` | 20 FSE / 142.9% |
| `EAC` | 21 FSE / 150.0% |

## Expected and observed decision

| Attempt | Expected | Observed tabletop result |
|---|---|---|
| Evaluate phase control | Set phase to `paused` because EAC reached 150% | `paused` |
| Commit another 1 FSE implementation task | Reject | Rejected with reason `phase_effort_gate_paused` |
| Commit 0.5 FSE evidence-preservation task | Permit under restricted class | Permitted and labeled `evidence_preservation` |
| Resume ordinary implementation without human record | Reject | Rejected |

## Required human disposition to resume

The phase remains paused until one immutable decision records exactly one of:

- increase the phase/program envelope;
- remove or defer named scope;
- approve a redesign or reassignment with a new forecast;
- terminate the phase.

The decision must update the baseline/EAC record before another implementation
commitment is accepted.

## Result

The policy is internally consistent and produces the required stop behavior.
This satisfies the pre-Phase-1 governance simulation required by REF-REC-9.
Phase implementation must later automate the same rule if program accounting
is incorporated into The Norns itself.

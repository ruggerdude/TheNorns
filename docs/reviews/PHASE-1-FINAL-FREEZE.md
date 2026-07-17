# Phase 1 Final Freeze and Effort Checkpoint

**Phase:** Domain and Persistence Foundation
**Freeze date:** 2026-07-16
**Branch:** `refoundation/phase1-domain-persistence`
**Technical freeze:** `50c9e7b0576f31d32ec01994c069b72c07e7e031`
**Status:** Complete and frozen

## Gate result

Phase 1 is complete. The final technical tree includes all accepted
independent-review remediation and the CI-portability corrections needed to
prove the production-shaped gate on GitHub.

- Independent findings: one blocker, five required P1 recommendations, two P2
  recommendations, and one human question.
- Disposition: every finding accepted; none rejected, downgraded, or deferred.
- Human question: archive-only approved for the MVP.
- Final GitHub CI:
  [run 29534527591](https://github.com/ruggerdude/TheNorns/actions/runs/29534527591),
  `success`, exact head `50c9e7b0576f31d32ec01994c069b72c07e7e031`.
- Local production-shaped gate: contracts 97 passed; adapters 12 passed plus
  one live-provider skip; web 37 passed; server 204 passed plus one
  environment-dependent live-planning skip; lint, typecheck, and build green.
- No V2 production cutover, legacy import, or real-repository execution was
  activated.

The checksum of `0001_refoundation_v2.sql` is frozen at the technical freeze.
All later schema evolution is forward-only in a new numbered migration.

## Effort and variance

FSE accounting is reconstructed from the authorized work ledger and rounded
to the program's required 0.5-FSE precision.

| Measure | FSE |
|---|---:|
| Baseline | 14.0 |
| Actual | 14.0 |
| Committed/in flight | 0.0 |
| Forecast remaining | 0.0 |
| Estimate at completion | 14.0 |
| Variance | 0.0 / 0% |
| Central contingency used | 0.0 |

| Role/model surface | Actual FSE |
|---|---:|
| Sol program architecture/integration | 2.5 |
| Backend implementation | 5.5 |
| Codex verification/remediation | 3.0 |
| Claude Fable independent review | 2.0 |
| Support/fixtures | 1.0 |
| **Total** | **14.0** |

| Work class | Actual FSE |
|---|---:|
| First-pass contracts/schema/application boundary | 8.5 |
| Independent review | 2.0 |
| Review remediation and CI correction | 3.5 |
| **Total** | **14.0** |

## Delivery state

| Deliverable | State |
|---|---|
| V2 contracts and lifecycle machines | acceptance-tested |
| Additive normalized schema and restricted runtime role | acceptance-tested |
| Transactional command/lifecycle boundary | acceptance-tested |
| Legacy compatibility repository port | integrated |
| Relational V2 adapters | acceptance-tested, not production-active |
| Independent review and dispositions | accepted and committed |
| V2 production cutover | not in Phase 1 scope |

## Failed attempts and corrective action

- The first GitHub CI run duplicated the pnpm version declared by
  `packageManager`. The workflow now takes its version only from the manifest.
- The Docker sandbox live test inherited owner-only GitHub temporary-directory
  permissions. Test mount roots now receive explicit fixture permissions,
  while the read-only assertion still proves Docker mount enforcement.
- Both corrections are included in the final green technical freeze.

## Cost ledgers

- Subscription seats: existing approved seats only; no new seat purchased.
- Metered API: no new Phase 1 production workload. One existing-key live smoke
  check was used during verification; the provider did not expose a
  per-request cost in the evidence, so no invented dollar amount is recorded.
  Phase 1 remained inside its approved $10 cap.
- Infrastructure: existing local Docker, GitHub Actions, and configured
  PostgreSQL resources only; no new paid tier authorized.

## Next-phase effect

Phase 2 is separately authorized by the human. Phase 1 files and migration
`0001` are frozen; Phase 2 changes must land on the dedicated Phase 2 branch
and use forward migration `0002`.

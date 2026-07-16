# Re-foundation Review Commit Evidence

**Finding:** REF-REC-14
**Code baseline:** `4ee3b8a8f609165c2d7f01ddebfd1e0fd78eaf92`
**Reviewed architecture commit:** `b4afd44514632f1a66733c115f8bfa3279bd9da2`
**Recorded:** 2026-07-16

## Application and package tree identity

Commands:

```sh
git rev-parse 4ee3b8a:apps
git rev-parse b4afd44514632f1a66733c115f8bfa3279bd9da2:apps
git rev-parse 4ee3b8a:packages
git rev-parse b4afd44514632f1a66733c115f8bfa3279bd9da2:packages
```

```text
4ee3b8a:apps      9d3aab1a169ad4002245706e0296da94cf23bf0a
b4afd445:apps     9d3aab1a169ad4002245706e0296da94cf23bf0a

4ee3b8a:packages  52a1884818a1990762b83f1d4b41450dfce37fac
b4afd445:packages 52a1884818a1990762b83f1d4b41450dfce37fac
```

Command:

```sh
git diff --quiet \
  4ee3b8a..b4afd44514632f1a66733c115f8bfa3279bd9da2 \
  -- apps packages
```

Result: exit status `0`. The `apps/` and `packages/` trees are byte-identical.
No application or package source changed in the reviewed architecture commit.

## Complete diffstat

```text
 README.md                                          |  35 +-
 TheNorns_MVP_PRD.md                                |   6 +
 docs/PHASE-0-ARCHITECTURE-REVIEW.md                | 151 +++++
 docs/PROGRAM-CHARTER.md                            | 219 +++++++
 docs/REFOUNDATION-PROGRAM.md                       | 691 +++++++++++++++++++++
 docs/STAFFING.md                                   |   6 +
 docs/UI-FEEDBACK.md                                |   6 +
 docs/adr/ADR-001-tech-stack.md                     |  74 ++-
 docs/adr/ADR-002-relay-hosting.md                  |  71 +--
 docs/adr/ADR-004-persistent-project-domain.md      | 253 ++++++++
 docs/adr/ADR-005-persistence-events-outbox.md      | 220 +++++++
 ...ADR-006-repository-bindings-runner-ownership.md | 234 +++++++
 .../ADR-007-coordinator-attention-read-models.md   | 286 +++++++++
 docs/reviews/REFOUNDATION-REPO-MAP.md              | 127 ++++
 docs/reviews/REFOUNDATION-REVIEW-PACKET.md         | 209 +++++++
 progress.log                                       |   1 +
 todo.md                                            |   8 +
 17 files changed, 2533 insertions(+), 64 deletions(-)
```

The exact claim supported by this evidence is:

> The reviewed commit changed documentation and program-tracking artifacts
> only. It changed no path under `apps/` or `packages/`.

The commit was not literally limited to `docs/`; it also changed `README.md`,
`TheNorns_MVP_PRD.md`, `progress.log`, and `todo.md`. `REVIEW_COMMIT.txt` was
archive metadata and was not a tracked repository file. This qualification is
recorded rather than overstating the evidence.

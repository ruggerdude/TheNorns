# Phase 7 Cutover and Retirement Runbook

## Progressive cutover

Each cohort moves through an explicit state machine:

```text
missing -> shadow -> canary -> authoritative
                     |             
                     +-> paused -> shadow/canary
```

Promotion requires a passed restore drill and zero open blocking migration
findings for the affected scope. Becoming authoritative atomically changes the
scope's persistence route to relational reads and writes. Promotion order is:

1. internal/admin project;
2. selected migrated projects;
3. new projects by default; and
4. remaining active projects after reconciliation.

`assertRelationalAuthoritative()` is the final machine check: every non-archived
project and the new-project default must use relational reads and writes.

## Legacy retirement is a separate operation

Completing the cutover does not delete legacy data. Retirement authorization is
append-only evidence and requires all of the following in the same database:

- an active human administrator;
- the completed retention window;
- a passed restore drill; and
- zero open migration discrepancies.

The authorization record must identify the exact scope. Code or data removal is
then performed in a separately reviewed change. The Phase 7 implementation
deliberately contains no endpoint that deletes legacy snapshots or compatibility
code.

## Rollback rule

Before relational writes begin, use the established Phase 2 rollback flow.
After relational writes begin, identity remains forward-only and any project
route reversal requires its immutable loss-window report and explicit human
approval. A cutover-cohort status change is not itself permission to discard
relational state.


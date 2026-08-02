# Planning and QC performance work: goals, changes, and current status

Status date: 2026-08-02

## Executive summary

The planning and QC work had six goals. Five produced verified reliability,
visibility, or QC-efficiency changes that remain in production. The attempted
initial plan-proposal optimization failed its live A/B benchmark and was
rolled back.

Production currently runs Git commit
`bd90d9e2afc18bff902e3492f76d5f7453d8fca6`. This is the rollback of the
regressing plan-proposal envelope. The public application and `/health`
endpoint were healthy after deployment.

No claim should be made that initial plan generation is faster. That goal is
not achieved.

## Original goals

1. Show durable planning/QC progress so a long review does not look frozen.
2. Make QC safe across process restarts without repeating completed model
   calls or losing exact usage.
3. Stop rewriting the complete plan for every QC correction when a bounded,
   attributable change is sufficient.
4. Diagnose malformed structured output and limit repair attempts and output
   size.
5. Provide explicit model speed/quality profiles and reduce oversized QC
   context without weakening binding rules or the durable audit receipt.
6. Reduce and measure initial plan-proposal latency.

## Work completed

### 1. Durable progress and transcript visibility

Commit: `9d3dce18c30e7eeecdf55ae660eaa16be7726ab7`

- Added persisted live progress for plan proposals and QC stages.
- Added durable reviewer/PM transcript messages and Markdown artifacts.
- Exposed the current stage, round, attempt, provider, model, and checkpoint
  time to the UI.
- Applied production migration `0075_planning_live_progress`.

Current state: retained in production.

### 2. Restart-safe QC execution

Commit: `75710bf4970b0c6bb61993ab863eb187dcdb3d6c`

- Added durable checkpoints after reviewer and revision completion.
- Preserved usage from completed calls across recovery.
- Added renewable fenced leases and expired-work recovery.
- Added graceful worker draining.
- Prevented duplicate transcript/artifact insertion during resume.
- Applied production migration `0076_qc_restart_checkpoints`.

Current state: retained in production.

### 3. Targeted QC revisions

Commit: `5555a43a5e6fa65d92d202f4e20b44990c2499bb`

- Added a closed set of validated plan-change operations.
- Pinned every targeted response to the exact base-plan hash.
- Required changes to identify the accepted reviewer findings they address.
- Materialized and validated the complete plan on the server.
- Added one explicit legacy full-plan fallback mode.
- Included staffing in module-scoped QC comparison.
- Pinned each review's revision format for its full lifetime.
- Applied production migration `0077_qc_targeted_revisions`.

Production configuration:

```text
NORNS_QC_REVISION_FORMAT=targeted_v1_with_fallback
```

Existing reviews remain pinned to their historical `legacy_full` format. New
reviews use targeted revisions with the validated legacy fallback.

Current state: retained and active for newly created reviews.

### 4. Structured-output diagnostics and bounded repair

Commit: `ecdd21752062e9a297f097d445cea66550fda992`

- Classified structured failures as `not_json`, `schema_validation`, or
  `output_truncated`.
- Added bounded, sanitized diagnostics.
- Limited repair to one useful retry.
- Prevented repair or legacy fallback after output truncation.
- Capped reviewer output at 5,000 tokens.
- Capped targeted revision output at 4,000 tokens and targeted repair at 3,000
  tokens.
- Preserved uncapped legacy full-plan compatibility.

Current state: retained in production.

### 5. Model profiles and compact QC context

Commit: `64c8a4b86f3c7005d1c95bcc57fb4888c4a14b17`

- Added `quality`, `balanced`, and `fast` planning profiles.
- Preserved exact project model selections, persisted reviewer selections, and
  exact legacy model environment overrides.
- Made `balanced` the fallback for otherwise-unconfigured participants.
- Added deterministic prompt-only QC context compaction.
- Preserved all binding rules, decisions, artifact metadata, and manual QC
  guidance.
- Bounded approved knowledge to 24 items and 24,000 canonical characters,
  with explicit omission counts and hashes.
- Left the full durable context receipt, manifest, and context hash unchanged.

Production configuration:

```text
NORNS_PLANNING_MODEL_PROFILE=balanced
```

The balanced pairing is Claude Sonnet 5 and GPT-5.6 Terra. An exact model
selected on a project still wins over this fallback.

Current state: retained and active.

### 6. Initial plan-proposal optimization attempt

Original commit: `50f648cc04193d7f98dd43cedde2ad6d867af00f`

The attempted change:

- Added the latest 16 visible messages in a bounded 16,000-character digest.
- Added omission hashes for excluded discussion.
- Requested a shorter, less repetitive plan.
- Reduced the maximum output from the adapter's 16,000-token default to 7,000
  tokens.

The change passed schema, unit, integration, and full regression tests, but it
was deployed before a live latency A/B test was run. That was an incorrect
release decision: functional tests proved correctness and bounds, not improved
latency.

## Benchmarks

### Historical production baseline

Five successful plan proposals before the attempted optimization:

| Metric | Baseline |
| --- | ---: |
| Sample size | 5 |
| Median latency | 45.89 seconds |
| Mean latency | 47.48 seconds |
| P90 latency | 66.46 seconds |
| Observed range | 26.25-76.37 seconds |
| Average input | 4,007 tokens |
| Average output | 4,244 tokens |
| Average manifest estimate | 5,201 tokens |

### Controlled live A/B

The old and attempted envelopes were run against the same realistic input and
the same Claude Sonnet 5 model, alternating order. Each variant completed three
schema-valid runs.

| Metric | Legacy envelope | Attempted envelope |
| --- | ---: | ---: |
| Successful runs | 3/3 | 3/3 |
| Median latency | 45.72 seconds | 62.64 seconds |
| Mean latency | 49.54 seconds | 61.57 seconds |
| Average input | 2,388 tokens | 4,132 tokens |
| Average output | 5,452 tokens | 6,354 tokens |
| Average modules | 5.00 | 6.67 |

Measured regression:

- Median latency increased by approximately 37%.
- Mean latency increased by approximately 24%.
- Average input increased by approximately 73%.
- Average output increased by approximately 17%.

The additional discussion envelope increased input, and the concision
instruction produced more modules and more output in this sample. A maximum
token setting is only a ceiling; it does not make a model generate less.

### Rollback

Rollback commit: `bd90d9e2afc18bff902e3492f76d5f7453d8fca6`

The rollback removed the attempted initial-plan envelope, its test, and its
performance document. It restored the initial plan-proposal path to the state
before commit `50f648c` while retaining all earlier planning/QC changes.

Rollback verification:

- Workspace build and TypeScript checks passed.
- Repository lint passed.
- Focused plan-workflow tests passed: 16/16.
- Full server suite passed: 1,513 tests; 19 skipped.
- Local `main` and GitHub `origin/main` matched the rollback commit.
- Railway deployed the exact rollback commit successfully.
- Public application returned HTTP 200 and `/health` returned success.

## Current goal status

| Goal | Current status |
| --- | --- |
| Durable progress and transcript visibility | Achieved and retained |
| Restart-safe QC | Achieved and retained |
| Targeted, attributable QC revisions | Achieved and active for new reviews |
| Diagnostic structured-output repair and caps | Achieved and retained |
| Explicit model profiles and compact QC context | Achieved and active |
| Faster initial plan generation | Not achieved; failed change rolled back |

## Current production state

- Deployed Git SHA: `bd90d9e2afc18bff902e3492f76d5f7453d8fca6`
- Planning profile: `balanced`
- New-review revision format: `targeted_v1_with_fallback`
- Initial plan-proposal implementation: restored to the pre-optimization
  behavior from commit `64c8a4b`
- Initial plan latency: no verified improvement over the historical baseline
- Worktree after rollback: clean

No replacement initial-plan optimization is included or in progress. Any
future attempt should be benchmarked against the same live A/B gate before it
is committed or deployed.

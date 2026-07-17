# Phase 4 Start Authorization

Date: 2026-07-16

The human program owner accepted the Phase 3 result at candidate `595becb` and
authorized Phase 4 under manual gating. No automatic independent-review hold
applies; the owner decides when to pause, review, or advance.

Phase 4 is authorized on branch `refoundation/phase4-coordinator-runner`.

## Scope

- Coordinator commands and dependency-aware scheduling.
- Transactional outbox, leasing, fencing, stable command identity, retries,
  dead-letter behavior, and budget finalization.
- Runner-owned worktree, sandbox, runtime, verification, artifacts, and
  structured events.
- Review, integration, task completion, phase closure, and memory update.
- Production-shaped restart and failure recovery matrix.

## Boundaries

- The server executes no repository shell commands.
- Credentials and fetch secrets never enter persisted envelopes, prompts,
  artifacts, logs, or sandbox environments.
- Existing protocol state-machine, deduplication, watermark, and generation
  fencing semantics remain authoritative.
- The Phase 4 exit requires a real task to traverse the durable coordinator to
  runner path and resume correctly after restart.

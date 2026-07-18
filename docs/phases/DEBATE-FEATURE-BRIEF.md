# Debate Feature Implementation Brief

## Objective

Deliver a project-scoped, durable debate workflow whose participants, role labels, providers, and
models are selected by the user at runtime. The workflow must preserve transcript, usage, budgets,
control state, and recovery evidence across restarts.

## Build agents

| Agent | Model | Ownership |
| --- | --- | --- |
| Program Manager / Integrator | GPT-5.6 Sol | Work graph, contracts, integration, release |
| Architecture and Contracts | GPT-5.6 Sol | ADR, state machine, DTO and event freeze |
| Domain and Persistence | GPT-5.6 Terra | Migration, repositories, lifecycle rules |
| Durable Orchestration | GPT-5.6 Sol | Scheduling, leases, retries, recovery, controls |
| Provider and Protocol | GPT-5.6 Sol | Model catalog, prompts, structured outputs, routing |
| Budget and Convergence | GPT-5.6 Terra | Reservations, settlement, stopping rules |
| API and Realtime | GPT-5.6 Terra | Authenticated commands, replay, live updates |
| Frontend | GPT-5.6 Terra | Setup and live debate workspace |
| Automated Verification | GPT-5.6 Sol | Deterministic mocks and fault/recovery matrix |
| Independent Review | GPT-5.6 Sol | Read-only findings of record |

These are build agents only. Runtime debate actors remain user-selected records.

## Implementation sequence

1. Freeze ADR-008, domain contracts, state machines, API DTOs, event types, and file ownership.
2. Add forward-only migration and contract tests.
3. Implement domain repository, event/history projection, actor-scoped idempotent commands, and
   debate-specific budget ledger.
4. Implement provider protocol, structured outputs, context packaging, and model capability catalog.
5. Implement the durable coordinator and dispatch/recovery loop.
6. Add authenticated API, ordered event replay, and live-update transport.
7. Add setup, transcript, artifact, comparison, budget, control, and intervention UI.
8. Run deterministic provider, restart, callback, timeout, budget, convergence, API, and UI tests.
9. Run independent read-only review; remediate all blocking and material findings.
10. Run full CI, push, obtain green GitHub CI, merge to `main`, and verify local/remote SHAs.

## Required acceptance

- Arbitrary participant role labels and independently selected provider/model combinations.
- Optional judge and synthesizer each independently configured.
- No hardcoded debate-role models.
- The MVP uses persisted actor-order round robin and configured OpenAI/Anthropic provider APIs;
  explicit schedules, in-place definition editing, and runner-backed Codex/Claude Code turns are
  truthful follow-on capabilities, not nonfunctional UI choices.
- Durable round/turn state and ordered transcript replay after restart.
- Fixed and conditional stopping policies enforced with recorded evidence.
- Pause, resume, stop, cancel, rerun, intervention, retry, and dead-letter behavior.
- Budget reserved before dispatch and reconciled after every terminal outcome.
- Exact usage, latency, tool/provider identifiers when available, and content hashes retained.
- Browser authorization and project isolation verified.
- Full repository CI and independent review green before merge.

## Explicit non-goals

- Replacing the existing plan/review workflow.
- Encoding debates as repository tasks.
- Prescribing which runtime model performs a debate role.
- Beginning local-folder implementation before the debate change is merged.

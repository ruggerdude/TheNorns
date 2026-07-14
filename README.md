# TheNorns

Visual AI Program Management platform: a PM agent orchestrates planning,
cross-provider review (Anthropic ⇄ OpenAI), and sandboxed execution via
Claude Code and Codex, with a deterministic workflow engine, human approval
gates, and a complete audit trail.

**Spec:** [TheNorns_MVP_PRD.md](TheNorns_MVP_PRD.md) (R4, externally reviewed
twice — dispositions in [docs/reviews/](docs/reviews/)) ·
**Decisions:** [docs/adr/](docs/adr/) · **Staffing:** [docs/STAFFING.md](docs/STAFFING.md) ·
**Tracking:** [todo.md](todo.md), [progress.log](progress.log)

## Layout

| Path | Package | What it is |
|---|---|---|
| `packages/contracts` | `@norns/contracts` | **Contracts v1 (frozen at Phase 0B):** Plan Contract, node lifecycle + pure reducer, runner protocol (command state machine, envelopes, dedup semantics), usage/reservations, approvals, artifacts, Project Memory, verification. Single source of truth — changes require architecture-lead approval. |
| `apps/server` | `@norns/server` | Backend: API, relay (browser + runner WebSockets), workflow engine, dispatch outbox (Phase 1A+) |
| `apps/runner` | `@norns/runner` | Local Runner daemon: pairing, buffered replay, sandbox launcher, runtime adapters (Phase 1A+) |
| `apps/web` | `@norns/web` | Frontend: PM workspace, plan review, workflow graph, dashboard (Phase 1A+) |

## Development

Requires Node ≥ 24 and pnpm 11.

```sh
pnpm install
pnpm run ci      # lint + typecheck + test
```

Every implementation change runs through the phase plan in the PRD
(§Development Order); the current phase and open items are in `todo.md`.

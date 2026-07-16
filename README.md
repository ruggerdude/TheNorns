# TheNorns

The Norns is being developed as an AI operating system for complex knowledge
work: persistent projects, evolving phases, durable memory, deterministic
coordination, multi-provider AI execution, and human strategic control.

## Canonical program documents

- **Charter:** [docs/PROGRAM-CHARTER.md](docs/PROGRAM-CHARTER.md)
- **Phase 0 review:** [docs/PHASE-0-ARCHITECTURE-REVIEW.md](docs/PHASE-0-ARCHITECTURE-REVIEW.md)
- **Re-foundation program:** [docs/REFOUNDATION-PROGRAM.md](docs/REFOUNDATION-PROGRAM.md)
- **Architecture decisions:** [docs/adr/](docs/adr/)

The earlier [R4 MVP PRD](TheNorns_MVP_PRD.md), [staffing plan](docs/STAFFING.md),
[todo](todo.md), and [progress log](progress.log) remain implementation-history
references. Where they conflict with the Program Charter or ADR-004 through
ADR-007, the newer documents govern.

## Layout

| Path | Package | What it is |
|---|---|---|
| `packages/contracts` | `@norns/contracts` | Existing Plan, lifecycle, runner-protocol, usage, approval, artifact, memory, and verification contracts. V2 persistent-domain contracts will be introduced through the approved re-foundation. |
| `packages/adapters` | `@norns/adapters` | Anthropic and OpenAI planning/provider adapters and usage normalization. |
| `apps/server` | `@norns/server` | Cloud API, relay, authentication, current project store, planning, and coordination primitives. |
| `apps/runner` | `@norns/runner` | Local Runner daemon, protocol replay/dedup, and coding runtime adapters. |
| `apps/web` | `@norns/web` | Current project/planning/graph UI; scheduled to become the Attention and Execution Mode experience. |

## Development

Requires Node ≥ 24 and pnpm 11.

```sh
pnpm install
pnpm run ci      # lint + typecheck + test
```

New implementation follows the gates in
[docs/REFOUNDATION-PROGRAM.md](docs/REFOUNDATION-PROGRAM.md).

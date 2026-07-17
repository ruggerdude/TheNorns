# The Norns Re-foundation Review Repository Map

**Purpose:** Code context for the independent ADR-004 through ADR-007 review

The review archive is generated from a committed Git snapshot. The archive
filename contains the short commit ID. Review findings should cite that commit
and exact file/symbol so later changes cannot silently alter the reviewed
baseline.

## Repository structure

```text
packages/contracts
  Shared Zod schemas for plans, lifecycle, approvals, memory, verification,
  usage, artifacts, runner protocol, and wire frames.

packages/adapters
  Anthropic/OpenAI planning adapters, failure taxonomy, model registry, and
  usage normalization.

apps/server
  Fastify API, WebSocket relay, authentication, current ProjectStore,
  planning, graph/allocation, persistence, and execution/coordinator
  primitives.

apps/runner
  Local Runner CLI/daemon, pairing, buffered event replay, command dedup,
  fixture execution, redaction, and Claude/Codex runtime adapters.

apps/web
  React project inventory, authentication/admin, planning review, graph
  editing, allocation approval, and the disconnected demo dashboard.
```

## Current live project path

```text
ProjectStore
└── ProjectRecord
    ├── metadata
    ├── PM provider/model
    ├── raw source type/location
    └── GraphSession | null
        ├── one current PlanContract
        ├── one mutable WorkflowGraph
        └── one allocation approval
```

Primary evidence:

- `apps/server/src/projects/store.ts`
- `apps/server/src/graph/session.ts`
- `apps/server/src/graph/graph.ts`
- `apps/server/src/graph/allocation.ts`

## Code-dependent architecture claims

| Claim | Primary evidence |
|---|---|
| A project holds one replaceable plan/graph session | `apps/server/src/projects/store.ts`, `apps/server/src/graph/session.ts` |
| Plan and graph can diverge after graph edits | `packages/contracts/src/plan.ts`, `apps/server/src/graph/graph.ts`, graph mutation routes in `apps/server/src/server.ts` |
| Production projects do not own a WorkflowEngine | `apps/server/src/main.ts`, `apps/server/src/projects/store.ts` |
| The only startup-created engine is the scripted demo engine | `apps/server/src/main.ts` |
| Persistence is whole-store JSONB snapshots | `apps/server/src/persistence/pg.ts`, persistence wiring in `apps/server/src/main.ts` |
| DispatchStore is in-memory and not production-wired | `apps/server/src/engine/dispatch.ts`, construction search across `apps/server/src` |
| Real runner execution commands are rejected | command switch in `apps/runner/src/daemon.ts` |
| Git/worktree/sandbox/execution responsibilities currently live under the server package | `apps/server/src/engine/git.ts`, `sandbox.ts`, `execution.ts`, `coordination.ts` |
| The source connection stores strings but does not connect/analyze a repository | project creation routes in `apps/server/src/server.ts`, `apps/server/src/projects/store.ts`, `apps/web/src/Projects.tsx` |
| Project Memory is accepted by planning helpers but omitted by the live route/store | `packages/contracts/src/memory.ts`, `apps/server/src/planning/session.ts`, planning route in `apps/server/src/server.ts` |
| Plan approval exists as a helper but is not persisted by the production load route | `apps/server/src/planning/session.ts`, plan routes in `apps/server/src/server.ts` |
| Multi-user auth stores reusable session and invitation tokens inside the users snapshot | `apps/server/src/users/store.ts`, `apps/server/src/main.ts`, `apps/web/src/auth.ts` |
| Audit actions often use a hardcoded operator rather than the authenticated user | project/graph/planning routes in `apps/server/src/server.ts` |
| Real-project dashboard/read model is absent | `apps/server/src/main.ts`, `apps/server/src/server.ts`, `apps/web/src/App.tsx`, `apps/web/src/Dashboard.tsx` |
| The project UI ends at plan, allocation, and approval | `apps/web/src/App.tsx` |
| The pilot test manually composes disconnected components | `apps/server/test/pilot.test.ts` |

## Production-integrated versus component/test-only

| Capability | Current status |
|---|---|
| User login and project list | Production-integrated |
| Named admin/member accounts and invitations | Production-integrated but target token/session hardening is not implemented |
| Project-scoped planning and graph editing | Production-integrated |
| Allocation and server-authoritative allocation approval | Production-integrated |
| PostgreSQL snapshot restoration | Production-integrated when configured |
| Runner pairing/replay/fixture execution | Integrated protocol vertical slice |
| Real `launch_run` execution through the relay | Not production-integrated |
| Durable database dispatch jobs | Test-only/in-memory model |
| WorkflowEngine on a real project | Demo/test-only composition |
| Budget ledger on a real project | Demo/test-only composition |
| Verification and multi-worker execution | Direct local/test composition |
| Project Memory persistence/injection in live projects | Not integrated |
| Project Resume / Attention dashboard | Not implemented |
| Local folder picker / GitHub App repository picker | GitHub App authorization, workspace installations, repository discovery/creation, and project selection implemented by `0008_workspace_connections`, `integrations/github.ts`, `Account.tsx`, and `Projects.tsx`; local folders remain runner-owned and require the runner picker surface |

## Important tests

- `apps/server/test/projectStore.test.ts`
- `apps/server/test/graphApi.test.ts`
- `apps/server/test/planning.test.ts`
- `apps/server/test/planning-live.test.ts`
- `apps/server/test/persistence.test.ts`
- `apps/server/test/engine.test.ts`
- `apps/server/test/dispatch.test.ts`
- `apps/server/test/relay.test.ts`
- `apps/server/test/execution.test.ts`
- `apps/server/test/coordination.test.ts`
- `apps/server/test/security.test.ts`
- `apps/server/test/pilot.test.ts`
- `apps/server/test/demoDashboard.test.ts`
- `apps/web/src/PlanReview.status.test.tsx`
- `apps/web/src/App.ui6-dashboard-demo-leak.test.tsx`

## Suggested reviewer checks

```sh
git rev-parse HEAD
git status --short
rg "new WorkflowEngine|new DispatchStore|executeNode|launch_run" apps packages
rg "ProjectMemoryEntry|DecisionRecord|RequiredVerification" apps packages
pnpm run typecheck
pnpm run test
```

The architecture snapshot intentionally changes documentation and
program-tracking artifacts only. No path under `apps/` or `packages/` may
differ from code baseline `4ee3b8a`; any such difference is a packaging error.
The exact tree-object and diff evidence for reviewed commit `b4afd44` is
recorded in
[REFOUNDATION-REVIEW-DIFF-EVIDENCE.md](REFOUNDATION-REVIEW-DIFF-EVIDENCE.md).

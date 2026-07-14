# TheNorns — todo

## Done
- [x] NORN-001 — Review original MVP PRD; produce corrected R2 (`TheNorns_MVP_PRD.md`)
- [x] NORN-002 — Choose tech stack → [ADR-001](docs/adr/ADR-001-tech-stack.md) (TypeScript monorepo; Fastify/Postgres; React Flow; Node runner)
- [x] NORN-003 — Decide relay hosting → [ADR-002](docs/adr/ADR-002-relay-hosting.md) (relay folded into backend; Fly.io app + Neon managed Postgres + Tigris/S3)
- [x] NORN-009 — Consolidate full plan into review packet for external vetting → [PLAN.md](PLAN.md)
- [x] NORN-010 — Disposition REVIEW-001; PRD R3, ADR-001/002 amended, [ADR-003 sandbox](docs/adr/ADR-003-execution-sandbox.md) added → [disposition](docs/reviews/REVIEW-001-disposition.md)
- [x] NORN-005 — Worker command restrictions → defense-in-depth inside the ADR-003 sandbox
- [x] NORN-011 — Regenerate PLAN.md as the R3 review packet; R2 snapshot archived to docs/reviews/PLAN-R2-snapshot.md
- [x] NORN-013 — Round-2 review dispositioned → **approved, no blockers**; PRD now **R4** (Runner Trust Contract, Required Verification Commands, conflict-node replacement semantics, DecisionRecord supersession, correlation/causation ids, `in_review` rename, Project Memory, +15–25 contingency) → [disposition](docs/reviews/REVIEW-002-disposition.md)
- [x] NORN-019 — Agent staffing plan with concrete model assignments and phase matrix → [docs/STAFFING.md](docs/STAFFING.md) (proposed; approve with ADRs under NORN-007)

## Open — gates to implementation (human)
- [ ] NORN-007 — Approve ADR-001, ADR-002, ADR-003 (Phase 0A exit; design is externally approved, these are your sign-offs)
- [ ] NORN-008 — Create Fly.io and Neon accounts + payment methods (gates Phase 1A)
- [ ] NORN-006 — Pick pilot project for Phase 9

## Open — implementation queue
- [ ] NORN-014 — Phase 0A: scaffold pnpm monorepo (apps/server, apps/web, apps/runner, packages/contracts), Biome, Vitest, CI
- [ ] NORN-004 — Phase 0B: freeze contracts v1 (Plan Contract incl. additive-only test_commands, Execution Contract, Required Verification Commands, ProjectMemory schema, command/event envelopes with correlation/causation ids, command state machine)
- [ ] NORN-012 — Verify `@openai/codex-sdk` lifecycle coverage at Phase 5; CLI/app-server subprocess fallback
- [ ] NORN-015 — Schedule phase-gate reviews after Phases 1A, 3, 5, 7, and pre-pilot (replaces broad architecture reviews per REVIEW-002)

## Backlog (post-MVP, from REVIEW-002)
- [ ] NORN-016 — Prompt library (P2-6)
- [ ] NORN-017 — Transcript search across all agents (P2-7; transcripts already stored immutably, retrofit-safe)
- [ ] NORN-018 — Automatic Project Memory extraction from transcripts (deliberately excluded from MVP)

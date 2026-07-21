# TheNorns — conventions for agents working in this repo

## Commit incrementally (durability rule)

Background agents are child processes of the host app. When it restarts —
auto-update, re-auth, or a quit — every running agent dies immediately and its
transcript may be destroyed. This has happened three times. Uncommitted work is
the only thing that is ever lost.

Therefore, in every worktree:

- **Commit after each coherent piece lands** — a new module, a wired route, a
  passing test file. Not once at the end.
- A commit does not have to be releasable. `wip(<phase>): <what>` is fine and
  expected; the integrating PM squashes or merges as needed.
- Never leave a large uncommitted working tree while starting something new.
- If you are interrupted and resumed, run `git status` and `git log --oneline`
  first and build on what survived rather than restarting.

An automated snapshotter also patches every agent worktree periodically, but it
is a backstop, not a substitute — it cannot produce a coherent history.

## Verification bar

Every phase reports against all of these, and each is run explicitly:

- `pnpm exec biome check` (or `--write`) clean on changed files
- `pnpm --filter <pkg> exec tsc --noEmit` — **run separately**;
  `tsconfig.build.json` excludes tests and has hidden real type errors twice
- the FULL package test suite, not just the file you touched
- `pnpm run build` clean

Report the numbers. "Tests pass" without counts is not a report.

## Wiring is part of done

A service that exists, is tested, and is not passed into `buildServer(...)` in
`apps/server/src/main.ts` is **dead in production while CI is green**. This has
shipped three times (attachments, the onboarding route, Actions execution
bindings). When you add an optional `ServerOptions` service:

1. wire it in `main.ts`, and
2. add a test that boots `buildServer` with the option shape production
   actually supplies.

## Migrations

- Name new migrations `NNNN_<name>.sql` with the number **UNASSIGNED**. The
  integrating PM assigns numbers; parallel agents have collided three times.
- Additive and forward-only. No destructive statements.
- **Every new table needs `GRANT ... TO norns_app`.** Production runs under a
  restricted role; pglite tests do not model this, so a missing grant is
  invisible in CI and fails only in production.

## Evidence over assertion

- Prefer the real dependency to a mock in tests. Mocks have concealed three
  dead code paths here (an empty allowlist, an unwired service, an
  uncalled repository method).
- If you believe a finding sent to you is wrong, say so with evidence rather
  than complying.
- Never report a capability as working that you have not exercised.

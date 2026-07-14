# ADR-003: Execution Sandbox

**Status:** Proposed · **Date:** 2026-07-13
**Origin:** REVIEW-001 finding P0-1

## Context

A Git worktree provides source-control isolation, not OS isolation. A coding
agent with shell access on the bare host could read `$HOME`, SSH keys, cloud
and browser credentials, follow symlinks out of the worktree, reach the
network, or touch sibling processes. Command allowlists alone cannot close
these paths. The PRD therefore mandates an Execution Sandbox Contract
(fail-closed) for every coding run; this ADR picks the MVP implementation.

## Decision

**Primary: disposable OCI containers** launched by the runner for every
coding run:

- Only the assigned worktree (and a scratch dir) bind-mounted writable;
  explicit read-only allowlist mounts beyond that; nothing else from the
  host filesystem.
- Explicit environment allowlist; nothing inherited from the runner process.
- Network: deny by default; egress permitted only to the provider runtime's
  endpoints, plus package registries when the node's policy allows
  installation. Enforced at the container network layer, not by prompt.
- cgroup CPU/memory/pids limits and a per-node wall-clock ceiling.
- No Docker socket or container-management access inside the sandbox.
- Credentials: runner-brokered — short-lived, narrowly scoped tokens
  injected per run; git push/fetch performed by the runner **outside** the
  sandbox against commits the worker made locally inside it.
- Test services (databases etc.) run as sibling containers on an isolated
  per-run network, declared via the module's `environment_requirements`.

**Secondary (only when the primary is impossible on a host):** the provider
runtime's own verified sandbox mode, configured to **fail if unavailable**
(e.g. Claude Code's sandbox with `failIfUnavailable`) — never silent
fallback to unsandboxed execution.

**Fail-closed rule:** if neither mode can be established, the run does not
start and the node blocks with a human-visible reason.

Runner registration reports the host's sandbox capability (container
runtime present, version) — part of the capability matrix; scheduling
respects it.

## Rationale

- Containers are the cheapest boundary that actually closes the filesystem,
  network, and process gaps at once, on macOS and Linux hosts alike (via
  Docker Desktop/OrbStack/colima on macOS).
- Runner-mediated git keeps repository credentials permanently out of the
  agent's reach — the worker can only affect its own branch via commits the
  runner chooses to push.
- Fail-closed converts "sandboxing misconfigured" from a silent security
  hole into a visible operational error.

## Alternatives rejected

- **Bare subprocess + allowlist** (the R2 design) — cannot guarantee the
  contract; rejected per REVIEW-001 P0-1.
- **Full VMs per run** — strongest boundary but heavy on a developer
  laptop; revisit for multi-tenant/commercial deployments.
- **chroot/jail-style confinement** — platform-inconsistent, does not
  address network policy.

## Consequences

- Runner host prerequisite: a container runtime. Documented at install;
  registration fails visibly without it (or downgrades to secondary mode
  where the provider runtime supports verified sandboxing).
- Coding runtimes must run correctly inside a container (both Claude Code
  and Codex support headless/containerized operation; verified in Phase 5,
  whose acceptance includes minimum sandbox enforcement).
- Phase 8 adversarially tests the boundary (escape attempts, planted-secret
  exfiltration, egress probes) rather than introducing it.
- Worker command allowlists (NORN-005) become defense-in-depth inside the
  sandbox, not the primary boundary.

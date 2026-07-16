# ADR-006: Repository Bindings and Local Runner Ownership

**Status:** Accepted · **Date:** 2026-07-16
**Supersedes:** Raw source path/URL storage as a connected repository
**Depends on:** ADR-004, ADR-005; preserves ADR-003 sandbox guarantees

## Context

The current project form accepts either an absolute local path or a GitHub URL.
The server validates the string and stores it as project metadata.

This is not a repository connection:

- a Railway server cannot browse or execute against a folder on the user’s
  local machine;
- the server does not authenticate to GitHub or present a repository picker;
- the repository is not cloned, registered, validated, or analyzed;
- local repository contents are intended to remain on the Local Runner;
- git, worktree, sandbox, and execution utilities currently sit on the wrong
  side of that trust boundary.

## Decision

### 1. Represent repositories with durable RepositoryBindings

A Project references one primary `RepositoryBinding` for the MVP. The design
allows additional bindings later.

Binding types:

```text
local_runner
github
```

Common fields include:

- project and binding identity;
- binding type and status;
- runner/repository identity;
- default branch and observed head;
- required verification policy;
- last validation and last sync;
- repository health;
- provenance and actor;
- optimistic version.

Raw paths and clone URLs are not the durable public identity.

### 2. Local folders are registered by the Local Runner

The Local Runner owns a workspace registry:

- the operator approves one or more workspace roots;
- the runner browses or accepts paths only inside those roots;
- it validates that a selected path is a supported repository;
- it assigns opaque `workspace_id` and `repository_id` values;
- it reports non-sensitive metadata to the cloud service;
- the Project stores those opaque identifiers.

The folder picker must execute on the user’s machine through the Local Runner
or a local companion surface. The cloud browser never receives arbitrary
filesystem access.

The normal UI flow is:

```text
Select online runner
→ browse runner-approved workspaces
→ select repository
→ runner validates
→ server creates RepositoryBinding
```

A raw-path troubleshooting flow may remain behind an advanced local-only
control, but it is not the normal product path.

### 3. GitHub uses a GitHub App and repository picker

The cloud service uses a GitHub App/OAuth installation flow:

1. Authorize or select a GitHub App installation.
2. List repositories available to that installation.
3. Search and select a repository.
4. Store installation ID, repository ID, owner/name, permissions, and default
   branch.
5. Bind an approved Local Runner for execution.

Repository permissions are least-privilege and explicit. The server may read
GitHub metadata and create branches/pull-request intents according to policy,
but coding execution and worktree operations remain runner-owned.

Long-lived personal access tokens and “credentials configured on the server”
are not the default design.

### 4. The Local Runner owns repository execution

Runner-exclusive responsibilities:

- repository validation and local status;
- fetch/clone according to binding policy;
- worktree and branch creation;
- sandbox launch;
- coding runtime launch and controls;
- verification at the exact commit;
- artifact/log redaction before upload;
- runner-mediated push;
- repository health reporting.

The cloud coordinator supplies intents and policies. It never sends an
unrestricted host shell command.

The sandbox may edit/test/commit only within its assigned worktree and allowed
scratch paths. It does not push, manage credentials, or choose repositories.

### 5. Move execution code to a runner-owned boundary

Git, worktree, sandbox, runtime, verification, and integration implementations
move from `apps/server/src/engine` into a runner-owned package or directly into
`apps/runner`.

Recommended package boundary:

```text
packages/runner-core
├── repository
├── worktrees
├── sandbox
├── runtimes
├── verification
└── integration

apps/runner
└── daemon, pairing, workspace registry, command executor
```

`apps/server` depends on contracts and coordination abstractions, not on
runner implementation code.

### 6. Expand the execution command contract

`launch_run` must carry or reference:

- project, phase, task, assignment, and run IDs;
- repository binding and expected revision;
- target branch/worktree policy;
- runtime, provider, and model;
- immutable prompt/context artifact references;
- budget reservation ID and execution limits;
- verification-policy reference;
- sandbox-policy reference;
- authorization/session identity;
- idempotency, correlation, causation, expiry, and runner generation.

Large prompts, memory bundles, and artifacts are content-addressed references,
not oversized command envelopes.

Runner results report structured state transitions, commits, usage, evidence,
artifacts, failures, and capability limitations.

### 7. Repository ingestion is an explicit workflow

Connecting a repository creates an ingestion job that records:

- language/framework and package metadata;
- directory/module summary;
- current architecture baseline;
- build/test/lint commands;
- repository health;
- existing documentation and ADRs;
- known constraints and unresolved findings.

The output becomes attributable repository facts and an ArchitectureRevision,
subject to coordinator/human review where strategic conclusions are made.

## Trust-boundary invariants

1. The cloud service never assumes it can read a local filesystem path.
2. Agents never receive unrestricted host shell access.
3. Workers never handle broad GitHub or provider credentials.
4. Workers commit inside their worktree; the runner mediates pushes.
5. Every execution command is bound to project, task, repository, runner, and
   generation.
6. Repository binding changes are audited and require appropriate human
   authorization.
7. Required verification commands are stored outside strategy proposals and
   cannot be weakened by an agent.

## Alternatives rejected

### Store raw absolute paths

Works only when the server and repository share a machine and exposes paths as
durable identity. It fails for the deployed topology.

### Clone and execute repositories on Railway

Violates the local-runner trust model, increases credential exposure, and makes
local tools/subscription runtimes unavailable.

### Upload a folder through the browser

Copies repository contents into the cloud, loses local Git/runtime context,
and cannot support continuous work efficiently.

### Use personal access tokens as the normal GitHub flow

Provides poor permission scope, rotation, installation visibility, and
repository-selection UX compared with a GitHub App.

## Consequences

- The current source form is replaced by real connection flows.
- “Add existing” is renamed to “Open another project”; importing an existing
  repository is a distinct operation.
- A Local Runner must be online for local selection and execution.
- GitHub integration requires a human-created GitHub App configuration.
- Runner protocol and package ownership change before real execution can ship.

## Acceptance criteria

1. A user can select a local repository without typing its absolute path into
   the cloud UI.
2. Railway never attempts to read that local path.
3. A user can authorize GitHub and select an accessible repository from a
   picker.
4. Private GitHub credentials are scoped to the installation and are not
   exposed to worker prompts or sandbox environments.
5. The runner executes one real task in a selected repository, verifies the
   exact commit, and reports evidence.
6. A command with the wrong project, repository, runner generation, or expected
   revision is rejected and audited.
7. Repository ingestion populates architecture and repository facts that are
   available after restart.

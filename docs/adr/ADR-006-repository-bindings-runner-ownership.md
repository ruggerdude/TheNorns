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

`REF-OPEN-1` includes GitHub App binding in the MVP. The trust boundary below
must pass before Phase 3 GitHub implementation begins.

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

The MVP permission set is:

- Metadata: read, as required by GitHub Apps.
- Contents: read/write only for the selected repositories so the runner can
  fetch and push approved branches.
- Pull requests: read/write only when Norns creates or updates pull requests.
- Checks and Actions: no permission by default; read-only permission may be
  added by a separately reviewed verification requirement.
- Administration, members, secrets, workflows, and organization permissions:
  none.

#### 2026-07-16 amendment — workspace connections and explicit provisioning

GitHub authorization is configured once at workspace scope. A Norns project
stores only the selected `service_connection_id`, installation identity, and
repository identity. User access and refresh tokens are encrypted at rest in
`github_user_authorizations`; they never enter a project, repository binding,
runner command, event, log, or browser response.

The normal existing-repository flow retains the permissions above. The human
has additionally requested an explicit **Create on GitHub** action. GitHub's
repository-creation API requires repository Administration write permission.
That permission is therefore an opt-in deployment capability with these
constraints:

- it is exercised only after a user explicitly selects Create on GitHub and
  confirms owner, repository name, and visibility;
- Norns uses it only to create the repository; rename, delete, transfer,
  settings mutation, collaborator administration, and secret administration
  remain outside the product surface;
- creation is attributed and audited;
- installations without Administration write remain fully usable for
  repository selection and normal source binding, but repository creation
  fails closed with an actionable permission error;
- selected-repository installations may require the human to add the newly
  created repository to the installation before it can be bound.

This amendment does not broaden runner credentials. Installation tokens are
still minted just in time and remain outside the coding sandbox.

Long-lived personal access tokens and “credentials configured on the server”
are not the default design.

#### GitHub credential broker

- The GitHub App private key exists only in the server-side secret store. It is
  never installed on a runner or placed in a command, event, log, artifact, or
  sandbox environment.
- At push time, the authenticated runner requests authorization for a specific
  RepositoryBinding, expected revision, branch operation, and run.
- The server revalidates the installation, repository, permissions, run,
  approval, and runner generation, then mints a just-in-time installation
  token restricted to that repository and the minimum permission subset.
- [GitHub installation tokens expire after one
  hour](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).
  Norns mints them immediately before the operation, permits one bounded push
  workflow, and requires the runner to discard them immediately afterward; it
  does not misstate that provider credential as having a shorter cryptographic
  expiry.
- The token travels only over the authenticated runner channel in a
  Norns-operation-bound, single-consumption broker response protected by the
  runner channel's authenticated encryption. The underlying GitHub token
  remains a bearer credential until GitHub expiry or revocation. It is never
  embedded in `launch_run`, stored in the command/event outbox, or passed into
  the coding sandbox.
- The runner holds the token only in memory and supplies it through an
  ephemeral askpass/credential helper or standard input. It never places the
  token in a remote URL, process argument, shell history, or persistent Git
  configuration.
- Immediately after the bounded operation, the runner uses GitHub's
  [`DELETE /installation/token`
  endpoint](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token)
  to revoke the bearer token, then clears its in-memory credential state.
  Credential closure is recorded only after GitHub returns success or the
  server records natural expiry. Revocation failure is audited and prevents
  the workflow from being reported as securely closed.
- Token shapes and known derived credential forms are registered with runner,
  relay, log, and artifact redaction before the first live use.
- Credential issue, use, denial, expiry, and disposal are audited without
  recording the credential.

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

The runner resolves those references through its authenticated relay channel
or a per-command signed object URL. It verifies the declared content hash and
size before use, stages the content into the assigned worktree or scratch
mount, and records provenance. A mismatch is rejected and audited. Fetch
credentials remain in runner infrastructure and are never exposed to the
sandbox process or persisted in run artifacts.

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
8. A GitHub push uses a just-in-time, single-repository installation token;
   stored commands, events, logs, sandbox environments, and artifacts contain
   no token material. After the bounded operation, revocation succeeds and an
   attempted replay is rejected.
9. A content-addressed context reference with the wrong hash is rejected and
   audited, and the sandbox contains no artifact-fetch credential.

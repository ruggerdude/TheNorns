# Knowledge Package and Agent Execution System

TheNorns transfers validated project knowledge between agents, not conversation
history. The relational subsystem introduced in migration `0027` implements the
operating model in the product specification.

## Canonical artifacts

- **Knowledge Packages** are stable identities with immutable semantic versions.
  Packages are classified as project, architecture, domain, quality, phase, or
  current-state knowledge and as constitutional, domain-standard, or
  operational authority.
- **Interface Contracts** are versioned separately so independently implemented
  components can pin inputs, outputs, timing, ownership, cancellation,
  concurrency, and performance behavior.
- **Task Packages** bound one task's assignment, scope, file ownership,
  dependencies, acceptance criteria, tests, reporting cadence, and escalation
  rules.
- **Context Manifests** record the repository commit and exact Knowledge
  Package, Interface Contract, and Decision Record versions supplied to a task.
  The manifest hash excludes its generation time, making assembly idempotent for
  identical authoritative inputs.
- **Knowledge Deltas** are proposals. An agent cannot mutate approved knowledge;
  a PM or human dispositions each delta as accepted, rejected, modified,
  deferred, or escalated.
- **Agent Heartbeats and Handoffs** use the specification's structured shapes.
  Repeated identical heartbeats are counted for stagnation detection.

## Lifecycle and approval

Knowledge and interface versions move through:

```text
draft → under_review → approved → active → archived
```

Activating a new version atomically marks the previous active version
`superseded` and links both versions. Approved and active versions require an
attributable approver. Content is immutable after creation; changes require a
new version.

Only one approved and one active version may exist for a package or interface.
The database enforces these invariants with partial unique indexes.

## Context assembly

For an approved Task Package, the assembly engine includes:

1. The active Project Package scoped to the project.
2. The active Phase Package scoped to the task's phase.
3. Packages explicitly required by the Task Package.
4. Active current-state packages scoped to the project or phase.
5. Every active parent package in the selected hierarchy.
6. Every exact package-version dependency pinned by a selected version.
7. Required active Interface Contracts and active Decision Records.

Assembly fails if mandatory knowledge is missing, a pinned dependency is
superseded, or a required contract or decision is inactive. Every active but
unselected package is recorded as an explicit exclusion. When a Task Package
exists, the existing content-addressed execution briefing adds an untrimmable
`knowledge` section rendered from the stored manifest.

## Conflict safety

Conflict scans compare active task registrations and persist stable conflicts:

- undeclared or overlapping file ownership: `C2`;
- same branch or workspace: `C4`;
- different versions of the same Knowledge Package: `C3`;
- two completed agents changing the same interface: `C3`.

`C3` and `C4` findings block completion. Resolution is always attributable;
there is no silent auto-resolution path.

## Completion gates

A task passes only when it has an approved Task Package, reported deliverables,
all acceptance criteria pass with evidence, required tests are reported, runner
verification passes, independent review is approved when required, a Knowledge
Delta exists, a completed handoff exists, and no open `C3`/`C4` conflict
remains.

A phase additionally requires all task gates, clean integration, quality
requirements, no open human decisions, reconciled deltas, and no pending phase
package version. Every evaluation is stored as audit evidence.

## HTTP surface

All routes are under `/api/v2/projects/:id`:

- `GET/POST /knowledge/packages`
- `POST /knowledge/packages/:packageId/versions`
- `POST /knowledge/package-versions/:versionId/transition`
- `POST /knowledge/interfaces`
- `POST /knowledge/interface-versions/:versionId/transition`
- `POST /tasks/:taskId/knowledge-package`
- `POST /tasks/:taskId/context-manifest`
- `POST /runs/:runId/knowledge/register`
- `POST /runs/:runId/knowledge/heartbeat`
- `POST /runs/:runId/knowledge/delta`
- `POST /runs/:runId/knowledge/handoff`
- `POST /knowledge/deltas/:deltaId/disposition`
- `POST /phases/:phaseId/knowledge/conflicts/detect`
- `POST /knowledge/conflicts/:conflictId/resolve`
- `GET /tasks/:taskId/knowledge/completion`
- `GET /phases/:phaseId/knowledge/completion`
- `GET /phases/:phaseId/knowledge/status`

Administrative mutations require an administrator with recent authentication.
The service layer remains the internal integration seam for the coordinator and
runner protocol.

## Auditability

Every lifecycle change, manifest assembly, agent registration, heartbeat,
handoff, delta disposition, conflict action, and completion evaluation is
durable. Package and manifest content uses canonical JSON SHA-256 hashes so the
exact knowledge used for a task can be reproduced and audited.

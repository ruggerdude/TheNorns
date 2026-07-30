# Device Identity and Local Execution Program

**Status:** Staged implementation plan

**Scope:** Correction of the existing Local Agent plan; no additional product scope

**Estimate:** 35–50 person-days; approximately 4–6 calendar weeks with three
implementation agents and serialized integration gates

## Purpose and scope boundary

This program makes the existing Norns Local Agent safe for multiple users,
multiple agent installations, explicit repository grants, and durable execution
target selection. It corrects the identity, enrollment, authorization,
transport, cancellation, migration, UI, packaging, sequencing, and estimation
defects in the earlier plan.

It does not add automatic updating, account or device transfer, remote
folder-approval notifications, a new desktop application, or new conversation
features. Existing folders, pins, rename, attachments, model selector, Plan,
edit, copy, and streamed-response Stop behavior are integration points, not new
scope.

The repository trust boundary in
[ADR-006](../adr/ADR-006-repository-bindings-runner-ownership.md) remains
authoritative and is extended rather than replaced. Phase 0 adds a dedicated
device-identity ADR that references ADR-006.

## Valid foundations and current gaps

The implementation already provides useful foundations:

- The Local Runner creates an outbound WebSocket connection, authenticates with
  an Ed25519 key, and uses generation fencing.
- The workspace registry keeps raw filesystem paths local and reports opaque
  workspace and repository identifiers to the cloud.
- Repository selection tokens are user-bound, generation-bound, short-lived,
  and single-use.
- Windows and macOS packaging workflows already support signing and
  notarization.
- The conversation UI already has semantic presentation for human, agent,
  reviewer, and system messages.
- ADR-006 correctly assigns local repository, worktree, runtime, verification,
  and push responsibilities to the Local Runner.

The current implementation is still effectively global:

- The current pairing identifier is too small and is not bound to a user in
  [ids.ts](../../apps/server/src/ids.ts).
- Pairing and runner state have no durable owner in
  [stores.ts](../../apps/server/src/stores.ts).
- Pairing, helper status, runner selection, and repository selection operate
  against a global runner collection in
  [server.ts](../../apps/server/src/server.ts).
- The current HTTP signature in
  [runnerContextAuth.ts](../../apps/server/src/execution/runnerContextAuth.ts)
  does not bind the body, query, credential, generation, or a one-time request
  identifier.
- WSS authentication signs a bare nonce in
  [server.ts](../../apps/server/src/server.ts).
- The installed helper has no host responsibility that can keep a local UI
  available before enrollment, during enrollment, and after daemon restarts.
- The Local Runner package's current test command is only an informational
  `echo` in [apps/runner/package.json](../../apps/runner/package.json).

## Terminology and identity

### Device

In server contracts and storage, a **device** is one Norns agent installation
under one operating-system user. It is not a guaranteed physical-computer
identity. A shared computer with two OS users has two installations. Reinstalling
without recovering the prior credential creates a new device.

The website may use **Computer** as the user-facing collection label because
that is the user's mental model. Authorization and protocol code must use the
precise device definition.

A device is identified only by:

1. A stable, opaque, server-issued `device_id`.
2. An active device credential whose private key the installation proves it
   possesses.

The following are not identity:

- owner: authorization;
- repository and project grants: authorization;
- generation: revocation and fencing;
- public-key fingerprint: human verification;
- connection and last-seen state: presence;
- OS, architecture, name, and optional location label: display metadata;
- protocol, version, and capabilities: compatibility metadata.

The agent does not upload the hostname by default. A user-supplied device name
and optional location label are distinct from an OS hostname.

### Credential

A credential is a durable public-key record associated with one device. Its
private key remains in the OS user's secure credential store. A canonical
public-key fingerprint is globally unique and is shown only as human
verification metadata; it does not replace proof of possession.

For the first release there is one active credential per device. Rotation or
replacement revokes the prior credential and fences the prior generation.

## Architecture and trust boundaries

```text
Agent installation under one OS user
  ├─ AgentHost
  │   ├─ single-instance and per-user startup
  │   ├─ loopback Control Center
  │   ├─ enrollment and local UI session
  │   └─ daemon lifecycle and port discovery
  ├─ OS-secured device private key
  ├─ local repository registry
  └─ Norns-managed process trees and preserved worktrees
          │
          │ outbound HTTPS/WSS
          ▼
Norns server
  ├─ device authorization and credentials
  ├─ typed action-specific authorization
  ├─ registrations, project grants, and bindings
  ├─ generation and request replay fencing
  └─ audited command and cancellation state
          │
          ▼
Website
  ├─ owned Computers management
  ├─ privacy-reduced project execution targets
  ├─ Project Settings target binding
  └─ read-only conversation execution metadata
```

The cloud never receives raw local paths and never assumes access to a local
filesystem. The agent accepts typed Norns commands, not unrestricted host-shell
requests. Workers do not receive broad GitHub or provider credentials.

The loopback Control Center protects against malicious websites and other OS
users. It cannot protect against a compromised process already running as the
same OS user, which can act with that user's local authority.

## Authorization model

There is no generic `DeviceAccessPolicy` boolean. The policy boundary returns
typed decisions with explicit denial reasons:

- `canViewOwnedDevice`
- `canManageDevice`
- `canGrantRepository`
- `canAcceptProjectTarget`
- `canDispatch`
- `canStopProjectRun`
- `canEmergencyStopDevice`

Every call site supplies the action's complete scope. A successful decision for
one action cannot be reused as authorization for another.

### First-release decision matrix

| Action | Required authority |
|---|---|
| View full device details | Device owner |
| Rename, revoke, or otherwise manage a device | Device owner |
| Register or remove Norns access to a local repository | Device owner acting through the local installation |
| Grant a registered repository to a project | Device owner, with an eligible target project |
| Accept or change a project's execution target | Project owner |
| Use a repository | Active project membership and an active repository grant |
| Dispatch work | Authorized project action, active binding and grant, active device and credential, current generation, and compatible runner |
| Stop one project run | `canStopProjectRun` for that exact project and run |
| Emergency-stop all local Norns work | Device owner through the local Control Center |

Current administrators can implicitly see all projects. That does not translate
into computer access: administrator status alone grants no device listing,
device management, repository use, execution, or stop authority.

Project ownership transfer does not transfer a device. Device transfer is not in
the first release; revoke and re-enroll instead.

## Lifecycle and state vocabulary

Lifecycle, presence, compatibility, workload, and access are separate
dimensions.

### Authorization request lifecycle

```text
pending
→ approved_pending_redemption
→ active
```

`denied` and `expired` are terminal. Approval does not activate a device.
Activation occurs only when the agent redeems the approved request while
proving the persisted private key.

### Device and credential lifecycle

An active device has an owner and one active credential. Revocation is a
terminal authorization state for that device record. Re-enrollment creates a
new device unless an explicitly supported credential-recovery operation
restores the existing identity.

These are derived dimensions, not lifecycle values:

- availability: `online`, `connecting`, `offline`;
- compatibility: `ready`, `limited`, `update_required`;
- workload: `idle`, `busy`;
- access presentation: `owned`, `shared`, `pending`, `revoked`.

## Enrollment contract

Enrollment is modeled after the polling, expiry, throttling, and `slow_down`
behavior in [RFC 8628](https://www.rfc-editor.org/info/rfc8628/), with
Norns-specific proof of possession and response-loss safety.

1. The agent generates its keypair and persists the private key in macOS
   Keychain, Windows Credential Manager/DPAPI, or Linux Secret Service before it
   requests enrollment.
2. The agent starts an idempotent authorization request bound to that public key
   and receives:

   - a 256-bit `device_code`;
   - a short human `user_code`;
   - a verification URI;
   - expiry and polling interval.

3. The agent opens the normal website verification page and displays the human
   code locally.
4. The authenticated website user submits the human code in a throttled POST
   body. It is never accepted through a GET URL.
5. The approval page shows the current Norns account, user-provided proposed
   name, OS and architecture, key fingerprint on both surfaces, requested
   capabilities, and explicit Approve and Deny actions. Approval requires recent
   authentication.
6. Approval changes the request to `approved_pending_redemption`.
7. The agent continues polling no faster than the issued interval. If no
   interval is supplied, it uses five seconds. `slow_down` adds five seconds to
   this and all subsequent polling intervals. Connection timeouts reduce polling
   frequency with backoff. Denial, expiry, and non-pending errors stop polling.
8. Redemption proves the persisted private key, creates or returns the same
   device and credential, and atomically changes the request to `active`.
9. If the activation HTTP response is lost, the agent retries with the same
   persisted key and device code. The server returns the original activation
   result rather than creating a second device or binding a key the agent has
   discarded.

The `device_code` must never appear in a URL, command line, custom URI, log,
audit record, analytics event, crash report, or support bundle. The server stores
only a keyed hash. Request-body logging and error reporting redact both the
device code and derived values. A custom URI may launch AgentHost, but cannot
carry the device code or any reusable enrollment secret.

The agent stores no Norns password, browser session, or general account token.

## Runner transport authentication

### WSS authentication

The WSS handshake validates:

- an active device and active owner;
- an active credential for that device;
- the current device generation;
- a compatible protocol version;
- proof of the credential's private key.

The signed value is a canonical, domain-separated handshake transcript, not the
current bare nonce. It includes purpose, challenge, `device_id`,
`credential_id`, generation, and negotiated protocol data.

A WSS connection has no single project context and may legitimately have no
repository grants. The handshake therefore never requires a project,
repository, or grant.

### HTTP signed transcript

Every runner-authenticated HTTP request signs one canonical transcript:

```text
purpose
device_id
credential_id
generation
HTTP method
canonical path and query
body SHA-256
timestamp
unique request_id
```

Canonicalization is shared by the contracts, agent, and server. The server
validates the active device, credential, and generation; checks timestamp skew;
verifies the body hash and signature; and atomically consumes `request_id`.
Reusing a request ID is rejected even if every other field matches.

This replaces the current context-only shape and applies to:

- context retrieval;
- gateway/model credential minting;
- visual-evidence and artifact uploads;
- every future runner HTTP endpoint.

### Per-operation authorization

Project, repository, registration, grant, binding, run, and generation checks
occur for every command, workspace request, context fetch, credential mint,
event, upload, retry, and continuation. Authorization is rechecked immediately
before dispatch or delivery and again on security-sensitive follow-up
operations. Background paths cannot bypass the same typed decisions used by
routes.

Browser runner-status broadcasts are scoped to the owned-device or
privacy-reduced project projection. They are never global runner broadcasts to
all authenticated users.

## Revocation, stop, and cancellation semantics

Revocation can immediately:

- revoke server-side authorization;
- fence the generation and close a live WSS connection;
- reject new dispatches;
- revoke model, context, and gateway credentials controlled by Norns;
- cancel queued commands;
- ask an online runner to stop;
- block subsequent events, uploads, credential minting, and publication;
- record an audit event.

The server cannot guarantee that an offline, hung, or compromised installation
has terminated its local process. Records and UI distinguish:

```text
cancellation_requested
runner_acknowledged
process_exited
unconfirmed_offline
```

The agent stops only Norns-managed process trees. Worktrees are preserved for
diagnosis and recovery. Revocation prevents a later reconnect from publishing
work produced after the fence unless an authorized user explicitly reauthorizes
that publication.

Three controls remain distinct:

- **Stop response:** cancels only the current streamed chat response.
- **Stop project work:** issues an audited typed cancellation for the selected
  run.
- **Emergency stop:** the local Control Center stops all Norns-managed
  processes for the owned device.

## Data model and migration sequence

The next available migration number is currently `0053`. The cutover is staged
across additive, forward-only migrations; it is not attempted in one migration.
Every new table receives the production `norns_app` grants required by
[CLAUDE.md](../../CLAUDE.md).

### Core tables

```text
devices
device_credentials
device_authorization_requests
device_repository_registrations
project_device_repository_grants
```

The authorization chain is:

```text
device
→ repository registration
→ project grant
→ repository binding
```

Required constraints:

- one active credential per device;
- globally unique canonical public-key fingerprint;
- unique `(device_id, generation)`;
- unique repository registration per device/workspace/repository;
- unique project/registration grant;
- active devices require an owner;
- foreign keys prevent grants from referring to unrelated registrations;
- lifecycle checks exclude online, busy, limited, and update-required.

`repository_bindings` references the grant or registration. It does not
separately duplicate `device_id`, because duplicated device identity could drift
from the registration and grant chain. New device-backed bindings are immutable;
a target change creates a new binding and atomically changes the project's
primary binding.

Raw paths remain absent from server tables, commands, events, logs, audit
records, artifacts, and browser DTOs.

### Migration sequence

1. `0053` adds the core device, credential, authorization-request, registration,
   and grant tables plus nullable compatibility columns or references needed for
   dual-read operation.
2. A later additive migration adds cancellation acknowledgement state and
   `legacy_claim_required` compatibility fields to existing local bindings.
3. A later additive migration adds immutable device-backed binding references
   and the atomic primary-binding switch support.
4. Cutover migrations retire obsolete compatibility constraints only after
   legacy claim, production evidence, and rollback gates pass.

No migration bulk-converts a historical `runner-1` into a device.

## API projections and privacy

Owned-device management and project target selection are separate projections:

```text
GET /api/devices
GET /api/projects/:projectId/execution-targets
```

`GET /api/devices` returns full management details only for devices owned by the
current user. `GET /api/projects/:projectId/execution-targets` returns only the
grant-scoped, privacy-reduced fields required to select an eligible project
target.

Project members do not receive unrelated task counts, repository inventory,
fingerprints, version details, grants, or device activity. Full device DTOs are
never reused as project-target DTOs.

Enrollment uses POST bodies for authorization creation, human-code lookup,
approval/denial, polling, and redemption. Device management uses owner-scoped
detail, rename, and revoke endpoints. Repository registration and project-grant
endpoints call the corresponding typed authorization decision.

## Repository registrations, grants, and bindings

Local repository approval happens on the installation under the OS user. The
agent validates repositories inside its approved workspace roots and reports
only opaque identifiers and safe metadata.

For a local execution target:

```text
choose eligible device
→ choose a registered repository
→ create or confirm the project grant
→ create an immutable device-backed binding
→ atomically select it as the project's primary binding
```

Repository removal means “remove Norns access.” It revokes or retires the
registration and affected grants and bindings; it never deletes the user's
local repository or files.

## Website presentation

### Computers

The owned Computers list displays separate status dimensions rather than
compressing them into one status color:

- availability: online, connecting, offline;
- compatibility: ready, limited, update required;
- workload: idle, busy;
- access: owned, shared, pending, revoked.

Busy is informational, not a warning. After destructive confirmation, revoked
is a muted terminal state rather than a permanently flashing emergency.

Cards show only:

- user-defined name;
- optional user-supplied location label;
- OS;
- availability;
- workload;
- last seen.

Fingerprint, protocol, capabilities, grants, architecture, and version belong
in device details. Color is never the only signal; labels, icons, accessible
names, and explanatory text accompany status.

Owner-scoped actions are Add, Rename, Details, Revoke, and manual update
guidance. There is no transfer action.

### Project Settings

Project Settings uses the privacy-reduced execution-target projection. The
project owner selects or changes the target there. Rebinding is blocked while
project work is active.

One eligible target may be visibly preselected, but it is never anonymous.
Multiple eligible devices are never resolved by “first available” behavior.
Repository rows always show the user-defined device name.

### Conversation

The conversation control is read-only and changes wording with state:

- idle: `Execution target · Office Mac mini`;
- active: `Running on · Office Mac mini`;
- historical: `Last ran on · Office Mac mini`.

It can reveal the bound repository, branch, availability, compatibility, and
current run metadata, but it cannot rebind the project. Stop response and Stop
project work remain separate controls with their distinct semantics. Emergency
stop exists only in the local Control Center.

When execution is blocked, the header explains whether the device is offline,
requires an update, has lost repository permission, has been revoked, or lacks
the required runtime. Existing semantic colors for human, agent, reviewer, and
system messages do not change meaning to accommodate device status.

## AgentHost and local Control Center

The existing Local Agent package gains an `AgentHost` responsibility; this is
not a new application. AgentHost owns:

- single-instance enforcement;
- loopback server;
- enrollment state;
- local UI session;
- daemon lifecycle;
- local port discovery;
- per-user startup.

The UI assets are bundled with the signed package and work offline. AgentHost is
available before enrollment, survives daemon restarts, and can present Home,
Security, and Diagnostics without assuming an authenticated WSS session.

### Home

- enrollment/account state;
- user-defined device name and optional location;
- separate availability, compatibility, and workload status;
- agent version and manual update guidance;
- start-at-login and daemon state;
- recent local Norns activity.

### Security

- enrolled account;
- device fingerprint for human verification;
- current local repository registrations and project grants;
- revoke/disconnect actions with their different effects;
- failed authorization notices;
- emergency stop for Norns-managed process trees.

### Repositories, after Phase 4

- add or remove Norns access to a repository;
- show the raw local path only in the loopback UI;
- show the cloud-safe label, Git status, and default branch;
- show projects currently granted access;
- show local approval and revocation history.

### Tasks, after Phase 5

- active and queued Norns tasks;
- project, conversation, agent, start time, and current phase;
- typed stop for one task;
- emergency stop for all Norns-managed process trees;
- recent success and failure history.

### Diagnostics

- connectivity and WSS state;
- Git and runtime detection;
- redacted logs and support bundle;
- daemon restart;
- installed version and manual signed-package update instructions.

Repository approval is added in Phase 4, after the authorization gate. Task
stopping is integrated in Phase 5. Remote folder-approval notifications are not
part of this program.

### Loopback security contract

- Bind only to `127.0.0.1` and `::1`.
- Use a random or persisted high port owned and discovered by AgentHost.
- Accept only exact IP-literal `Host` and `Origin` values for the selected
  loopback address and port; reject names such as `localhost` and reject DNS
  rebinding attempts.
- Send no CORS headers and support no cross-origin API use.
- Use no state-changing GET endpoints.
- Protect every state-changing request with CSRF validation.
- Serve only bundled offline assets under a strict Content Security Policy.
- Exchange a short-lived, one-use bootstrap token for an HttpOnly,
  `SameSite=Strict` local session; never put reusable enrollment credentials in
  the bootstrap URL.
- Provide no normal setting that binds the UI to a LAN or public interface.
- Provide no Norns account-password form in the local interface.
- Redact raw paths, keys, codes, and secrets from diagnostics by default.

## Installer, update, and uninstall contract

Updates are manual installation of a newer signed package. Automatic updating
is outside this program.

Release artifacts are immutable. A published asset for an existing version is
never overwritten. Installers:

1. validate the signed package;
2. stop AgentHost and its daemon safely;
3. preserve device credentials, enrollment state, registrations, diagnostics,
   and recoverable worktrees;
4. replace binaries and bundled assets;
5. restart per-user AgentHost and the daemon.

Uninstall and server revocation are separate actions. Uninstall removes the
local software according to the platform's explicit user choice; it does not
pretend to revoke a server record. Server revocation does not uninstall local
software.

The existing distribution constraints and signing requirements remain in
[local-agent-distribution.md](../local-agent-distribution.md), subject to the
enrollment and immutable-release rules in this program.

## Legacy claim and cutover

Historical `runner-1` identifiers are not globally unique. Multiple
installations may have reused that value, so no migration creates one
`legacy_unclaimed` device or maps historical projects to whichever `runner-1`
is online.

The claim flow is:

1. Mark each existing local binding `legacy_claim_required`.
2. Enroll the actual installation through the normal device flow.
3. Require proof of its current private key.
4. Re-catalog repositories from that installation.
5. Ask the user to confirm each repository.
6. Create a new immutable device-backed binding.
7. Atomically switch the project's primary binding.
8. Retire the old binding.

Projects remain visible while a local binding requires claim, but local
execution is blocked with an explicit recovery message. GitHub Actions
ephemeral runners remain separate and are not migrated into user devices.

After adoption evidence passes, the global helper selection and legacy pairing
routes are retired. The existing `runner-1` runbook in
[PHASE-4-RUNNER.md](../runbooks/PHASE-4-RUNNER.md) remains historical until that
cutover phase updates it.

## Feature flags and rollout controls

The staged work uses independently controlled server flags:

- device schema and dual-read support;
- device enrollment creation and redemption;
- device-authenticated WSS and HTTP transports;
- owned Computers management UI;
- repository registration and project grants;
- device-backed dispatch;
- legacy claim and binding cutover;
- device-dispatch kill switch.

Flags default off in production until their phase gates pass. The
device-dispatch kill switch blocks only device-backed local dispatch and leaves
GitHub Actions execution available. Rollback disables the newest read or
dispatch path without deleting additive schema or historical records.

## Delivery phases and ownership

### Phase 0 — Contracts and threat model

Owner: Project manager, with all three specialists reviewing.

- Dedicated device identity ADR referencing ADR-006.
- Device lifecycle and authorization matrix.
- Enrollment and protocol contracts.
- UI wireframes and status vocabulary.
- Feature flags and migration sequence.

Gate: identity, authorization, threat boundaries, lifecycle transitions, DTO
privacy, and rollout controls are unambiguous before implementation begins.

### Phase 1 — Additive schema and thin enrollment slice

Owners: McClintock and Raman; Poincaré supplies the approval page.

- Add tables and nullable compatibility fields.
- Persist keys before enrollment.
- Implement idempotent authorization and redemption.
- Add minimal AgentHost enrollment UI.
- Add minimal website approval UI.
- Keep production capability disabled.

Gate: lost enrollment responses, repeated redemption, denial, expiry, throttled
human-code lookup, and key persistence behave correctly without enabling
production device dispatch.

### Phase 2 — Complete authorization enforcement

Owners: McClintock and Raman.

- Typed device policy decisions.
- WSS authentication state machine.
- Runner HTTP signed-transcript replacement.
- Context, gateway, command, event, upload, retry, and continuation enforcement.
- Revocation and cancellation state tracking.
- Scoped browser broadcasts.

Gate: cross-user access and background-path bypass tests pass before any
Computers UI is enabled. Device application dispatch remains fail-closed after
this phase; cancellation tracking alone is not publication authority.

### Phase 3 — Device management surfaces

Owner: Poincaré; Raman integrates AgentHost.

- Website-owned Computers list and details.
- Local Home, Security, and Diagnostics.
- Rename, revoke, status, and manual update guidance.
- Accessibility and responsive verification.

Gate: owned-device privacy, status dimensions, destructive confirmation,
keyboard use, responsive layout, and accessible names pass review.

### Phase 4 — Repository grants and bindings

Owners: McClintock, Raman, and Poincaré.

- Local repository approval.
- Device repository registrations.
- Project grants.
- New immutable device-backed bindings.
- Project Settings target selection.
- One-use, signed publication permits bound to the current run, device,
  credential generation, commit, branch, and active grant chain.

Gate: repository removal means “remove Norns access” and never deletes local
files. Device dispatch cannot be enabled until publication fails closed while
offline and every permit is reauthorized immediately before use.

### Phase 5 — Conversation execution integration

Owners: Poincaré and Raman.

- Execution-target metadata.
- Accurate active, idle, and historical wording.
- Project stop controls.
- Local emergency stop.
- Confirmed cancellation and offline states.

Gate: response stop, project-run cancellation, emergency stop, and offline
unconfirmed cancellation remain observably distinct.

### Phase 6 — Legacy claim and cutover

Owners: McClintock and Raman.

- Claim-required markers.
- Fresh device enrollment and repository proof.
- New binding creation and atomic primary-binding switch.
- Retirement of global helper selection and pairing routes.

Gate: no historical project is assigned through a reused global runner
identifier, and each cutover has device-key and repository-confirmation
evidence.

### Phase 7 — Independent QA and canary

- Real runner tests; replace the current no-op runner test script.
- Two-user/two-computer authorization matrix.
- Response-loss, replay, reconnect, revocation, and offline-stop tests.
- Windows/macOS install, reboot, upgrade, and uninstall testing.
- Hostile-origin and local UI security testing.
- Light/dark, keyboard, screen-reader, zoom, and forced-color inspection.
- Canary rollout with a device-dispatch kill switch that leaves GitHub Actions
  available.

Gate: critical and high findings are closed, medium findings are explicitly
dispositioned, signed-package journeys pass on real Windows and macOS systems,
and the canary can be disabled without disabling GitHub Actions.

## Verification and delivery requirements

Each repository-changing phase follows [CLAUDE.md](../../CLAUDE.md):

- Biome is clean on changed files.
- TypeScript is checked separately with `tsc --noEmit`.
- Full affected package test suites run and report counts.
- The repository build passes.
- New services are wired through the production `buildServer(...)` shape and
  tested through that wiring.
- Migrations are additive, forward-only, and grant new tables to `norns_app`.

Each completed phase stages only its own changes, creates a task-specific
commit, pushes the exact commit to GitHub `main`, verifies local `main` and
`origin/main` match, waits for Railway's automatic deployment, verifies Railway
deployed that exact SHA, and checks the public health endpoint. Installer phases
also exercise the signed package workflow.

### Railway sequencing for additive device migrations

The ordinary application must never receive the privileged migration database
URL or run migrations during process startup. For releases containing the
additive device migrations:

1. Push the reviewed commit while the prior healthy application deployment
   remains live.
2. From the Railway operations service built from that exact commit, run
   `node apps/server/dist/applyMigrations.js` with the privileged migration
   `DATABASE_URL`.
3. Verify the `0053` through current-release migration ledger checksums
   (currently `0058`) and the new relations, columns, constraints, triggers,
   and `norns_app` privileges before promoting the application deployment.
4. Allow the automatic application deployment to start or retry, verify it is
   running the pushed commit, and then check `/health`.

The new application intentionally refuses startup with
`runtime_schema_outdated` until these migrations are present. If Railway starts
the new image before the operations service finishes, the failed health check
must leave the prior healthy deployment serving traffic; finish the additive
migrations and retry the same application commit. Do not work around the gate
by granting migration privileges to the application or by removing its schema
posture checks.

## Estimate, exclusions, and dependencies

For this refined scope:

- **35–50 person-days**
- **Approximately 4–6 calendar weeks** with three implementation agents and
  serialized integration gates

The earlier 24–34 person-day estimate was inconsistent with its 5–7-week
calendar estimate and understated cross-platform security and packaging work.

Explicit exclusions:

- automatic updating;
- device or account transfer;
- remote folder-approval notifications;
- a separate desktop application;
- physical-computer identity;
- deletion of local repositories;
- administrator-derived computer access.

External release dependencies:

- Apple Developer ID signing and notarization credentials;
- Windows Authenticode signing credentials;
- physical or representative Windows and macOS test systems;
- final installer publishing permissions.

These dependencies do not block contracts, additive schema, authorization,
transport hardening, or UI development. They do block the signed installer and
production canary gates.

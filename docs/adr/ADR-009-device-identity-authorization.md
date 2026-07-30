# ADR-009: Device identity and authorization

- **Status:** Accepted for implementation
- **Date:** 2026-07-29
- **Owners:** Program Manager / Integrator and Security Specialist
- **Decision scope:** Persistent local-agent device identity, enrollment, transport authentication,
  repository authorization, revocation, and privacy
- **Depends on:** [ADR-006](./ADR-006-repository-bindings-runner-ownership.md)

## Context

ADR-006 establishes that local repository contents and execution remain on the Local Runner, that a
project uses a durable repository binding, and that every execution command is bound to a project,
task, repository, runner, and generation. This ADR adds the durable device identity and
authorization model needed to enforce those decisions for persistent local-agent installations. It
does not replace ADR-006 or move repository execution across its trust boundary.

The existing `runner_id` model is not a safe device identity. Several installations may have used
the same historical default, such as `runner-1`; a user-selected or globally reused string cannot
prove which installation is connected. Existing runner HTTP authentication also signs only a
method, path, runner ID, and timestamp. It does not bind the query, body, credential, generation, or
a one-time request identifier. The runner WebSocket signs a bare nonce and does not bind the
credential, generation, or protocol until later reconciliation.

Device authentication also must not become project authorization. A legitimate device can be
online with no repository grants. Conversely, an authenticated device must not read project
context, receive a command, mint a credential, upload evidence, publish work, or emit an accepted
event unless the server proves the exact current authorization chain for that action.

## Decision

### 1. Device identity is an installation identity

A device means one Norns Agent installation under one OS user. It is not a physical-computer,
hardware, host, or operating-system identity.

The identity invariant is:

```text
stable server-issued device_id
+ proof of the private key for a currently active device credential
```

Both terms are required. A `device_id` without credential proof is only a claim. A valid key whose
credential is inactive, revoked, or assigned to a different device proves no current identity.

The following are not identity:

- owner or account;
- repository registration or project grant;
- generation;
- public-key fingerprint;
- protocol, version, or capability;
- online, connecting, offline, idle, busy, limited, or update-required state.

Those values describe authorization, revocation, verification, compatibility, or presence.
Reinstalling without recovering the protected device credential creates a new device. The first
release has no device transfer. Moving use to another account requires revocation and fresh
enrollment.

The server assigns opaque `device_id` and `credential_id` values. The agent never derives them from
a hostname, OS installation identifier, MAC address, serial number, path, or account identifier.
The hostname is not uploaded by default. A display name and optional location are user-supplied
labels and confer no authority.

### 2. Public-key fingerprints are canonical

Device credentials use Ed25519 keys. A fingerprint is computed from key material, not from its PEM
text:

1. Parse the submitted public key and require an Ed25519 SubjectPublicKeyInfo.
2. Re-encode it as canonical DER SubjectPublicKeyInfo.
3. Compute SHA-256 over those DER bytes.
4. Encode the 32-byte digest as lowercase hexadecimal.

The resulting 64-character value is the canonical public-key fingerprint. Whitespace, PEM labels,
or alternate textual encodings cannot produce distinct fingerprints for the same key. Parsing
failure, a non-Ed25519 algorithm, trailing data, or a non-canonicalizable key fails enrollment.
Fingerprints are globally unique across device credentials.

### 3. Enrollment is response-loss safe

`device_authorization_requests` use this state machine:

```text
pending
  → approved_pending_redemption
  → active

pending | approved_pending_redemption
  → denied

pending | approved_pending_redemption
  → expired
```

`denied` and `expired` are terminal. `active` is terminal for the authorization request; later
device or credential revocation does not rewrite enrollment history. Approval and redemption are
separate durable operations.

Enrollment proceeds as follows:

1. AgentHost generates an Ed25519 keypair.
2. Before any enrollment network request, AgentHost stores the private key and pending-enrollment
   metadata in protected per-user state using the platform credential or protected-storage
   facility. A crash or restart must recover the same key.
3. AgentHost creates an authorization request with the exact public key and receives a 256-bit
   `device_code`, a separate human `user_code`, an expiry, and a polling interval.
4. A signed-in human submits the `user_code` to the website in a throttled POST body. Approval binds
   the approving user as owner and binds the already-submitted canonical public-key fingerprint.
5. AgentHost polls the redemption endpoint using the `device_code` in a POST body.
6. Redemption atomically creates or returns the same device, credential, and generation and moves
   the request from `approved_pending_redemption` to `active`.
7. AgentHost records the returned opaque identifiers alongside the already-persisted private key.

The redemption transaction is exactly-key idempotent. A retry of an `active` authorization request
with the same device-code hash and public-key fingerprint returns the original `device_id`,
`credential_id`, and generation. It does not rotate the key, increment generation, or create a
second credential. A retry with a changed key, owner, authorization request, or code fails without
revealing which predicate failed. The server retains the minimum encrypted or non-secret result
material needed to provide this idempotent response for the documented retry period.

The agent must never generate a replacement key merely because a request timed out or a response
could not be parsed. If protected pending state cannot be recovered, that enrollment is abandoned;
a new request produces a new device rather than attempting to claim the old one.

### 4. Enrollment codes follow RFC 8628

The polling protocol follows [RFC 8628](https://www.rfc-editor.org/info/rfc8628/):

- Before approval, polling returns `authorization_pending`.
- The agent waits at least the server-provided interval between requests.
- On `slow_down`, the agent increases the interval by at least five seconds for that and all later
  requests in the same flow.
- Transport timeouts use increasing backoff and do not cause a replacement key or authorization
  request.
- Denial returns `access_denied`; expiry returns `expired_token`.
- Polling stops on success, denial, or expiry.
- The website throttles human-code submissions by authenticated user and source, and the server
  throttles polling independently. Responses do not disclose whether a guessed code was once
  valid, was approved for another user, or named a particular device.

The `device_code` contains 256 random bits from a cryptographically secure generator. It is a
credential and must never enter:

- a URL or query string;
- a custom URI;
- a command line, installer command, shell history, or process title;
- application, proxy, analytics, tracing, or crash logs;
- an audit record;
- browser-visible HTML or client telemetry.

The server stores only a versioned keyed hash of the device code. The HMAC key is held in the
server-side secret store and supports explicit rotation. Comparisons are constant-time after
indexed hash lookup. Generic request logging and error reporting must redact both code fields before
the first production enrollment.

The human `user_code` is distinct from the device code. It is submitted only in a CSRF-protected
POST body to a generic approval page; there is no code-bearing GET URL or “complete verification”
link. It is normalized according to the frozen enrollment contract before hashing and comparison.
It is short-lived, single-flow, throttled, and never grants a device credential by itself.

### 5. Device WebSocket authentication is grantless

The device WebSocket state machine is:

```text
connected
  → challenge_issued
  → authenticated_pending_reconcile
  → active

any nonterminal state
  → rejected
  → closed
```

The server applies an authentication deadline. Only the expected frame is accepted in each state.
Repeated authentication, reconciliation before authentication, application frames before active
state, or a second identity on the same socket is rejected. A challenge is cryptographically
random, one-use, connection-bound, and discarded when the socket closes or the deadline expires.

The authentication response signs this domain-separated transcript:

```text
domain        = norns:device-wss-auth:v1
purpose       = runner_wss_auth
challenge
device_id
credential_id
generation
protocol
```

The transcript uses the length-prefixed field encoding defined in section 7. `generation` and
`protocol` are canonical unsigned base-10 integers with no sign or leading zero, except the value
zero. The challenge uses unpadded base64url.

Before sending authentication success, the server verifies from durable state:

- the device lifecycle is active;
- the device has an owner and that owner account is active;
- the named credential belongs to the device and is active;
- the credential is the device's one current active credential;
- the supplied generation is current;
- the protocol is compatible;
- the signature verifies over the exact transcript.

Connection availability, workload, repository registrations, and project grants are not handshake
predicates. In particular, a valid device with no grants may authenticate, reconcile, report
presence, and remain connected.

Authentication establishes only device identity and a current transport generation. Every command,
workspace request, context fetch, gateway credential mint, repository credential mint, event,
upload, retry, continuation, and publication is authorized for its own project, run, repository,
and binding immediately before that action.

### 6. All runner HTTP endpoints use one hardened verifier

The context-specific HTTP signature is replaced by a shared, deny-by-default runner request
verifier. A runner HTTP route must register one explicit purpose. Unknown purposes and
runner-facing routes without the verifier fail closed.

The signed fields, in this exact order, are:

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

The domain is `norns:device-http-request:v1`. Context retrieval, gateway credential minting,
visual-evidence upload, repository credential minting, and any future runner HTTP endpoint use
different purpose constants. A signature valid for one purpose is invalid for every other purpose.

The method is uppercase ASCII. `device_id`, `credential_id`, and `request_id` must satisfy their
opaque identifier contract. Generation is a canonical unsigned base-10 integer. Timestamp is UTC
RFC 3339 with exactly three fractional digits and a `Z` suffix. The body digest is the lowercase
64-character SHA-256 hexadecimal digest of the exact HTTP entity bytes presented to the
application before parsing. Requests using `Content-Encoding` are rejected. A bodyless request
uses the SHA-256 digest of the empty byte string.

The client serializes a body once, hashes those bytes, and sends the same bytes. The server captures
and hashes the raw entity before JSON, form, or multipart parsing. Re-serialization is never used
for verification.

### 7. Signed transcripts are unambiguous

Both WSS and HTTP transcripts use this byte encoding:

```text
UTF8(domain + "\n")
+ field(name_1, value_1)
+ field(name_2, value_2)
+ ...

field(name, value) =
  ASCII(name)
  + ASCII(":")
  + ASCII(decimal UTF-8 byte length of value)
  + ASCII(":")
  + UTF8(value)
  + ASCII("\n")
```

Field names and order are fixed by the relevant protocol version. Names are lowercase ASCII.
Values are first validated by their field contract. Implementations do not apply Unicode
normalization to opaque IDs or signed values. A new field, encoding, or normalization rule
requires a new transcript domain version.

For HTTP, `canonical path and query` is computed as follows:

1. Start with the origin-form request target. An absolute URI, authority form, fragment, userinfo,
   control character, raw backslash, or invalid percent escape is rejected.
2. The path is absolute and non-empty; an empty path becomes `/`.
3. Decode percent-encoded unreserved ASCII octets. All other octets remain percent-encoded with
   uppercase hexadecimal. Non-ASCII text must be valid UTF-8 and is encoded as UTF-8 octets using
   uppercase percent escapes. Unreserved characters are never percent-encoded.
4. Apply RFC 3986 dot-segment removal after decoding unreserved octets, so encoded `.` segments
   cannot survive normalization.
5. Preserve slash count and case. Do not collapse repeated slashes and do not add or remove a
   trailing slash.
6. Reject a request when routing or proxy normalization produced a different application path than
   this canonical path. The verifier and router must act on the same path.
7. Parse the query as `&`-separated name/value pairs, splitting each pair at its first `=`.
   Semicolon separators, empty pairs, empty names, malformed UTF-8, and decoded duplicate names are
   rejected. A missing `=` is equivalent to an empty value.
8. Decode query components as UTF-8, treating `+` as a literal plus rather than a space. Re-encode
   names and values using RFC 3986 unreserved characters and uppercase percent escapes; space is
   `%20`.
9. Sort pairs lexicographically by encoded name and then encoded value. Render every pair as
   `name=value` joined by `&`.
10. If there are no pairs, the signed value is the canonical path. Otherwise it is
    `canonical_path + "?" + canonical_query`.

Runner-authenticated routes do not accept duplicate query names. An endpoint that later needs
repeated values requires a new reviewed canonicalization version rather than weakening this one.

### 8. Request IDs are consumed to prevent replay

Each signed HTTP request carries a cryptographically random request ID with at least 128 bits of
entropy. It is not a business idempotency key.

After validating syntax, freshness, device, credential, generation, body digest, and signature, the
server atomically inserts the request ID into a durable replay ledger with a uniqueness constraint
before invoking the endpoint operation. A previously consumed request ID is rejected even when the
earlier operation failed. Replay records live for at least the maximum accepted clock skew plus the
maximum request-processing interval. Clock freshness limits ledger retention; it is not by itself
replay protection.

Retries use a new signed request ID. Operations that must survive response loss also carry a
separate, body-bound business idempotency key and replay the stored business result. The verifier
returns authenticated device facts, not authorization to the endpoint.

### 9. Authorization decisions are action-specific

There is no generic `DeviceAccessPolicy` allow/deny bit. Callers request one typed decision with the
complete resource facts needed for that action:

| Decision | First-release rule |
| --- | --- |
| `canViewOwnedDevice` | The active caller owns the device. Revoked devices remain visible to their owner as terminal records. |
| `canManageDevice` | The caller is the device owner. |
| `canGrantRepository` | The caller owns the device and its active local repository registration, and grants that exact registration to an eligible project. |
| `canAcceptProjectTarget` | The caller is the project owner and the target resolves to an active registration that its device owner explicitly granted to this project. |
| `canDispatch` | The attributable actor has active project access; the device, registration, grant, binding, credential, and generation are current; and the command names the same project and repository chain. |
| `canStopProjectRun` | The caller has active access to the exact run's project and the run resolves to that project. This grants no general device authority. |
| `canEmergencyStopDevice` | The caller is the device owner. |

Project owners count as active project members for repository use. Other active project members may
use an already accepted target only while its repository grant is active. The device owner creates
or revokes the project grant for an active local registration. That grant makes only the named
registration eligible for only the named project; it does not select the project's execution
target. The project owner separately accepts or changes the execution target from registrations
whose owners explicitly granted them to that project. Local repository registration remains a
separate approval on the device, so neither a project owner nor an administrator can cause an
unapproved local folder to be registered or grant another owner's registration.

Administrator status alone grants no device listing, device detail, repository use, dispatch,
project-stop, or emergency-stop authority. Existing administrative visibility of projects is not
computer access and must not be reused to discover, expose, or grant another owner's device
repository registrations.

Decisions fail closed on missing, inactive, ambiguous, or inconsistent data. Background dispatch,
retry, continuation, event ingestion, credential brokers, and upload handlers re-evaluate the same
typed decision using the attributable original actor and current durable facts. Passing an HTTP
route once does not authorize later background work.

### 10. The data model has one authorization chain

The additive core tables are:

```text
devices
device_credentials
device_authorization_requests
device_repository_registrations
project_device_repository_grants
```

For local execution, the only valid authorization chain is:

```text
device
  → device repository registration
  → project grant
  → repository binding
```

The following constraints are mandatory:

- one active credential per device, enforced by a partial unique index;
- globally unique canonical public-key fingerprint;
- unique `(device_id, generation)` on credentials;
- unique repository registration for the same device, opaque workspace, and repository;
- unique project/registration grant;
- an active device has a non-null owner;
- credential generation is monotonic for a device;
- a grant references one registration and a registration references one device.

`repository_bindings` references the project grant, or during an explicitly documented intermediate
stage the registration. It does not also store a separately writable device identity. Device
identity is resolved through the foreign-key chain so binding and device cannot drift. Existing
legacy runner columns may remain nullable compatibility fields during cutover but are not
authoritative for a device-backed binding.

Device lifecycle values describe durable lifecycle only. Online, connecting, offline, idle, busy,
limited, and update-required are derived availability, workload, or compatibility projections and
are not stored as device lifecycle values.

### 11. Revocation and cancellation report only what is known

On device revocation, the server can immediately:

- make the device and active credential unauthorized;
- advance the generation fence;
- reject new dispatches, retries, and continuations;
- revoke or refuse model, context, repository, and publication credentials;
- cancel queued commands;
- reject later events and uploads;
- close a current socket and ask an online runner to stop.

The server cannot prove that an offline, partitioned, hung, or compromised computer has terminated
its local process. Socket closure is not process-exit evidence.

Run cancellation records these distinct milestones:

```text
cancellation_requested
runner_acknowledged
process_exited
unconfirmed_offline
```

They are not compressed into one `cancelled` assertion. `cancellation_requested` is the durable,
audited server decision. `runner_acknowledged` requires a signed acknowledgement from the current
device generation. `process_exited` requires the AgentHost to have stopped and reaped the complete
Norns-managed process tree. `unconfirmed_offline` means the server has fenced authorization but
has no current runner acknowledgement or exit proof. A later valid acknowledgement may resolve the
uncertainty without rewriting the original request time.

AgentHost uses platform process-tree containment and stops all managed descendants for a local
emergency stop. It preserves managed worktrees for recovery; stop and revocation do not use
worktree deletion as process cleanup.

### 12. Publication has a final authorization fence

Every Norns-mediated publication performs a just-in-time `canDispatch`-equivalent authorization
check specialized to the exact run, registration, grant, binding, repository, device, credential,
and generation immediately before publication authority is issued or used. The repository
credential broker refuses revoked or stale generations and attempts to revoke already-issued
bounded credentials when authorization is withdrawn.

A cancellation may retain recoverable local commits, but revocation prevents Norns from publishing
them unless a human explicitly reauthorizes publication through a current device and grant. A late
runner event cannot turn revoked local work into an accepted publication record.

This guarantee covers Norns-managed processes and Norns-mediated credentials. A process compromised
as the same OS user may have unrelated filesystem or Git credentials outside Norns. Preventing that
user-equivalent process from acting is outside this trust boundary and is not claimed.

### 13. AgentHost owns the local Control Center boundary

AgentHost is a responsibility inside the existing Local Agent package, not a separate product. It
owns:

- per-OS-user single-instance enforcement;
- the loopback server and local port discovery;
- enrollment and protected credential state;
- the local UI session;
- daemon start, stop, and restart;
- per-user startup;
- Norns-managed process-tree containment.

The loopback server binds only IP-literal loopback addresses. It does not bind wildcard, LAN, or
hostname interfaces. It validates the exact `Host` value, including the selected port, against the
IP literal on which the request arrived. `localhost`, suffix matches, alternate numeric spellings,
userinfo, and forwarded-host substitution are rejected.

State-changing requests require an exact `Origin` equal to the loopback scheme, IP literal, and
port serving that UI. Missing, `null`, hostname-based, or mismatched origins are rejected. The
server emits no CORS headers and does not treat CORS as authentication. There are no state-changing
GET or HEAD handlers. Mutations require a local UI session plus a session-bound, single-use CSRF
token.

The native launcher creates a cryptographically random, short-lived, one-use bootstrap token and
opens the loopback UI with the token in the URL fragment so it is not sent in the HTTP request,
Referer, or server log. Bundled UI code exchanges it in a POST body under the exact Host/Origin
checks. Successful exchange invalidates the token and creates the local UI session; timeout,
restart, or an attempted second exchange invalidates it.

All assets are bundled for offline use. The UI loads no third-party scripts, styles, fonts,
frames, or network resources. It uses a strict CSP rooted at `default-src 'none'`, with only the
minimum same-origin directives required by bundled assets and loopback API calls. Inline script and
`unsafe-eval` are forbidden. Sensitive responses use `Cache-Control: no-store`.

This boundary protects against malicious websites, DNS rebinding, cross-origin browser requests,
and other OS users who cannot access the protected per-user state. It does not protect against a
compromised process running as the same OS user with equivalent access to AgentHost state.

### 14. Owned-device and project-target projections are separate

The server exposes separate projections:

```text
GET /api/devices
GET /api/projects/:projectId/execution-targets
```

`GET /api/devices` returns full device-management detail only for devices owned by the current
user, including terminal revoked records. Detailed fingerprint, credential, protocol, version,
capability, registration, grant, and diagnostic facts are owner-only.

The project execution-target projection requires current project access and returns only
privacy-reduced information for registrations explicitly granted to that project. Project members
receive accepted active targets; the project owner may additionally receive pending grants that
require target acceptance. Project membership, ownership, or administrator visibility never
permits enumeration of a device owner's other registrations. The projection does not expose
unrelated task counts, other repositories or grants, fingerprints, credential identifiers,
detailed device activity, diagnostics, or owner-only controls.

List cards contain only user-supplied name, optional user-supplied location, OS, availability,
workload, and last seen. Fingerprint, protocol, capabilities, grants, and version belong in
owner-only details. Hostname is not collected or returned by default.

Browser snapshots, WebSocket notifications, and status broadcasts use the same projection policy.
There is no global runner snapshot sent to every authenticated user.

### 15. Migration and release gates are staged

Migration `0053` is the first additive device migration. It adds the core identity/enrollment
tables and only the nullable compatibility references needed by the thin enrollment slice. It does
not perform the full binding cutover, bulk-map legacy runner IDs, or delete legacy columns.

Later forward-only migrations separately add or enforce:

1. replay-consumption and complete transport-authentication persistence;
2. repository registrations and project grants;
3. immutable device-backed binding references and primary-binding switching;
4. legacy claim-required markers and retirement constraints;
5. cleanup only after the new path is authoritative and rollback observation has ended.

Production enrollment and dispatch are independently disabled by default when the additive schema
first lands. Feature flags have these constraints:

- enrollment can be enabled for a canary without enabling device dispatch;
- device dispatch has a kill switch independent of GitHub Actions execution;
- Computers UI remains disabled until cross-user access and background-path bypass tests pass;
- repository target selection remains disabled until registration/grant/binding enforcement is
  authoritative;
- legacy claim remains explicit and cannot silently select whichever historical runner is online;
- disabling a feature refuses new authority but does not erase enrollment, audit, or recovery
  records.

Legacy local bindings first become `legacy_claim_required`. Claiming requires fresh enrollment of
the actual installation, proof of its current key, device-side repository recataloging, human
confirmation of each repository, creation of a new device-backed binding, and an atomic switch of
the project's primary binding. Only then is the old binding retired. Historical `runner-1`
references are never bulk-mapped to one device.

## Security invariants

1. Authentication never implies project or repository authorization.
2. A server-issued device ID is not sufficient without proof of the current active credential.
3. Ownership, administrator role, presence, fingerprint, and generation are not device identity.
4. A grantless device may authenticate and connect.
5. Every runner HTTP request binds purpose, device, credential, generation, method, canonical
   target, exact body, time, and a consumed request ID.
6. Every command, event, fetch, mint, upload, retry, continuation, and publication resolves current
   action-specific authority through one device-to-binding chain.
7. At most one credential is active for a device, and stale generations cannot act.
8. No device code or derived bearer credential enters a URL, log, audit record, command line,
   custom URI, browser projection, command, event, or artifact.
9. Revocation is monotonic and immediately removes server-mediated authority.
10. Cancellation state distinguishes a server request, runner acknowledgement, proven process
    exit, and unconfirmed offline execution.
11. Device-backed bindings do not duplicate writable device identity.
12. Administrator status alone grants no computer access.
13. Project members see only grant-scoped target projections; device owners see their own device
    management projection.
14. Legacy runner IDs never establish a new device identity.
15. Security gates fail closed when durable policy, replay, revocation, or relationship data is
    unavailable.

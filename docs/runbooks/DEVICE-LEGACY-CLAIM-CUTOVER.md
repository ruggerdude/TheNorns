# Device legacy-repository claim cutover

This runbook describes the production choreography for replacing each exact
legacy local repository binding with a device-backed binding. It is a procedure,
not evidence that a production enrollment, repository confirmation, operating
system canary, or cutover has been completed.

The cutover is deliberately per project. Never group, select, or update records
by `runner_id`. Historical installations could reuse the same runner identifier,
so it is not a device identity and cannot prove which computer owns a
repository.

At the time this runbook was prepared, the production inventory contained one
candidate project. That is a point-in-time observation, not a reason to
special-case the process. Re-run the inventory queries at every gate and do not
copy production project, claim, binding, grant, device, credential, repository,
or runner identifiers into tickets, chat, logs, or this document.

## Safety invariants

- Migration `0060_legacy_repository_binding_claims.sql` is additive. It creates
  claim machinery and the `legacy_claim_required` binding status but performs no
  data cutover.
- An owner starts a claim for one project's exact current primary legacy
  binding. The application does not infer a binding from an online runner or
  from a runner identifier.
- The owner must enroll the actual agent installation with a fresh key proof,
  re-catalog its repository, receive an active project repository grant, choose
  the exact grant-scoped target, and type the repository name to confirm it.
- Finalization creates a new immutable device-backed binding, switches the
  project's primary binding, revokes the old binding, and finalizes the claim in
  one transaction.
- Beginning and finalizing are prohibited while project work is active.
- Removing Norns access, revoking a grant, retiring a binding, or rolling back a
  deployment never deletes, moves, cleans, or resets local files or worktrees.
- `NORNS_ENABLE_DEVICE_DISPATCH` is the local-device dispatch kill switch. It is
  independent from GitHub Actions execution and must remain available as an
  immediate rollback control.
- Existing authenticated device connections remain useful for cancellation and
  management even while new device dispatch is disabled. Disabling dispatch
  cannot prove that an offline, hung, or compromised host stopped a local
  process.

## Exact gates

All server cutover flags accept only the literal strings `true` or `false`.
They default to `false`, and any other value refuses server startup.

| Server setting | Purpose during cutover |
| --- | --- |
| `NORNS_ENABLE_DEVICE_ENROLLMENT` | Mounts device authorization and redemption. Enabling it also requires a stable `NORNS_DEVICE_ENROLLMENT_HMAC_KEY_ID` and a canonical base64/base64url `NORNS_DEVICE_ENROLLMENT_HMAC_KEY` containing at least 256 bits. |
| `NORNS_ENABLE_DEVICE_MANAGEMENT` | Mounts owned-device management routes. |
| `NORNS_ENABLE_DEVICE_REPOSITORY_ACCESS` | Mounts repository registration, project grant, and execution-target routes. Enabling it also requires `NORNS_DEVICE_PUBLICATION_SIGNING_KEY_ID` and an Ed25519 PKCS#8 key in `NORNS_DEVICE_PUBLICATION_SIGNING_PRIVATE_KEY`. |
| `NORNS_ENABLE_LEGACY_REPOSITORY_CLAIMS` | Mounts the owner-only per-project legacy claim routes. |
| `NORNS_ENABLE_LEGACY_PAIRING_ROUTES` | Temporary compatibility for `/api/pairing/start` and `/api/pairing/complete`. Disable before retiring legacy authentication. |
| `NORNS_ENABLE_LEGACY_HELPER_ROUTES` | Temporary compatibility for the old global helper/local-project surfaces and legacy `/install/runner.sh` and `/install/runner.ps1` distribution. It also controls `legacy_local_creation_available` in the capabilities projection. Disable before retiring legacy authentication. It does not control the Actions manifest or versioned runner tarball. |
| `NORNS_ENABLE_LEGACY_LOCAL_RUNNER_AUTH` | Temporary authentication compatibility for old local runners only. Keep it enabled until every exact project claim is finalized or explicitly removed from the cutover inventory. GitHub Actions runner authentication is independent. |
| `NORNS_LEGACY_GLOBAL_RUNNER_COMPATIBILITY` | Broad temporary compatibility for unattributed global runner selection. It is strict/default-off and must be `false` before enabling claims or any device canary. Prefer project-attributed legacy authorization during the bridge. |
| `NORNS_ENABLE_DEVICE_DISPATCH` | Allows new device execution protocol frames. Keep it `false` until the human OS canary gate; return it to `false` to stop new local-device delivery without disabling GitHub Actions. |

The installed Local Agent has separate process-local gates:

| Agent setting | Purpose during cutover |
| --- | --- |
| `NORNS_ENABLE_DEVICE_AGENT_HOST` | Enables the per-user `AgentHost` preview/control surface. |
| `NORNS_ENABLE_DEVICE_ENROLLMENT` | Enables the agent's persisted-key enrollment path. |
| `NORNS_ENABLE_DEVICE_CONTROL` | Enables authenticated device control. |
| `NORNS_ENABLE_DEVICE_EXECUTION` | Enables local device execution and requires device control. Leave off until the execution canary. |
| `NORNS_ENABLE_LEGACY_LOCAL_COMPATIBILITY` | Temporarily permits the legacy pairing/daemon path on an older installation. Disable it after all claims and legacy local authentication are retired. |

Use the authenticated, no-store capabilities response to confirm what the
deployed server actually mounted:

```text
GET /api/v2/capabilities/local-execution
```

Do not infer availability from environment configuration alone. The strict
response fields are `enrollment_available`, `computers_available`,
`repository_grants_available`, `legacy_claim_available`, and
`legacy_local_creation_available`.

## Two-delivery choreography

### Delivery 1: additive schema and compatibility-preserving application

1. Record the current GitHub Actions health and one known-good Actions-hosted
   project run. This is the fallback baseline.
2. Before deploying code that makes compatibility gates default-off,
   preconfigure the server with:

   ```text
   NORNS_ENABLE_LEGACY_PAIRING_ROUTES=true
   NORNS_ENABLE_LEGACY_HELPER_ROUTES=true
   NORNS_ENABLE_LEGACY_LOCAL_RUNNER_AUTH=true
   NORNS_LEGACY_GLOBAL_RUNNER_COMPATIBILITY=false
   NORNS_ENABLE_LEGACY_REPOSITORY_CLAIMS=false
   NORNS_ENABLE_DEVICE_DISPATCH=false
   ```

   Preconfigure existing local installations with
   `NORNS_ENABLE_LEGACY_LOCAL_COMPATIBILITY=true` only where the old path must
   remain usable during the bridge. Do not expose any secret value in change
   records.
3. Apply `0060_legacy_repository_binding_claims.sql` with the privileged
   migration role. Do not run any data update that groups rows by `runner_id`.
4. Deploy the application with all new enrollment, management, repository
   access, claim, and device-dispatch capabilities still default-off unless
   their prerequisites have been separately prepared.
5. Run the schema and compatibility validation below. Confirm that legacy
   behavior still works where deliberately retained and that GitHub Actions
   still reaches its known-good health/run baseline.
6. Stop. Delivery 1 is complete only as a software deployment. It does not
   satisfy the physical enrollment or signed-package canary gates.

If Delivery 1 fails before any claim is opened, roll the application back while
leaving the additive `0060` schema in place, or roll forward with a fixed build.
Do not reverse the migration in production merely to roll back application
code.

### Delivery 2: enrolled-device claims and retirement

1. Configure the enrollment HMAC and publication signing keys in the server
   secret store. Confirm `NORNS_LEGACY_GLOBAL_RUNNER_COMPATIBILITY=false`, then
   enable device enrollment, management, repository access, and legacy claims.
   Keep `NORNS_ENABLE_DEVICE_DISPATCH=false`.
2. Deploy a newer immutable, signed Local Agent package to the candidate
   operating system. A human must verify the package identity, perform the
   installation/upgrade, confirm per-user startup after reboot, and confirm
   that prior agent state is preserved.
3. A human owner enrolls the actual installation. The agent must persist its
   private key before requesting authorization and prove that key during
   redemption. Approval requires a recent web session. This physical
   enrollment and key-proof check is a blocking human gate; API or unit-test
   evidence does not satisfy it.
4. On that installation, the owner re-catalogs the exact local repository and
   approves it locally. The owner then creates an active repository grant for
   the exact project. Confirm the resulting target through:

   ```text
   GET /api/projects/:projectId/execution-targets
   ```

   Project members may receive only `legacy_claim_required: true`; they must not
   receive claim, candidate, repository, grant, device, or credential
   identifiers.
5. Retire the old entry surfaces first:

   ```text
   NORNS_ENABLE_LEGACY_PAIRING_ROUTES=false
   NORNS_ENABLE_LEGACY_HELPER_ROUTES=false
   ```

   Restart and verify `/api/pairing/start`, `/api/pairing/complete`, and legacy
   helper/local-project routes fail closed. Confirm
   `legacy_local_creation_available: false`. Keep
   `NORNS_ENABLE_LEGACY_LOCAL_RUNNER_AUTH=true` so an existing authenticated
   local runner is not cut off before its projects are claimed.
6. For one project at a time, while it has no live run, begin the exact claim
   through the authenticated owner flow:

   ```text
   POST /api/projects/:projectId/legacy-repository-claim/begin
   ```

   The strict POST body contains only `expected_project_version` and a unique
   `idempotency_key`. Retry a lost response with the same key. A browser reload
   with a fresh key replays the already-open claim for that exact project; it
   never selects by runner identifier.
7. Reload the owner-only projection:

   ```text
   GET /api/projects/:projectId/legacy-repository-claim
   GET /api/projects/:projectId/legacy-repository-claims/:claimId
   ```

   Confirm `state: claim_required`, inspect only the returned grant-scoped
   `candidate_targets`, and require the owner to choose the exact target and
   type its `repository_display_name`.
8. Finalize through:

   ```text
   POST /api/projects/:projectId/legacy-repository-claims/:claimId/finalize
   ```

   The strict body is:

   ```json
   {
     "execution_target_id": "<selected target>",
     "expected_claim_version": 1,
     "expected_project_version": 1,
     "idempotency_key": "<unique retry-stable value>",
     "confirmation": "use_this_repository"
   }
   ```

   The numeric versions shown are structural examples, not production values.
   Use the current projection's actual versions. Retry response loss with the
   same body and key. On `claim_version_changed`, `project_version_changed`,
   `project_work_active`, `execution_target_changed`, or
   `claim_already_finalized`, reload and review; never bypass the compare-and-set
   checks with direct SQL.
9. Run the per-project post-finalize validation before moving to the next
   project. Preserve the old binding as revoked recovery evidence and preserve
   all local files/worktrees.
10. Repeat the inventory. Only after there are zero open claims and zero
    remaining exact primary legacy candidates may the operator set:

    ```text
    NORNS_ENABLE_LEGACY_LOCAL_RUNNER_AUTH=false
    ```

    Then disable `NORNS_ENABLE_LEGACY_LOCAL_COMPATIBILITY` on upgraded agents.
    Validate GitHub Actions again; its durable runner authentication must remain
    available.
    Confirm `/install/runner.sh` and `/install/runner.ps1` return 404 when
    `NORNS_ENABLE_LEGACY_HELPER_ROUTES=false`; the Actions
    `/install/runner/manifest.json` and versioned tarball remain independently
    available.
11. The signed OS execution canary is a separate blocking human gate. With a
    human observing the enrolled host, enable the agent's
    `NORNS_ENABLE_DEVICE_EXECUTION=true`, temporarily set the server's
    `NORNS_ENABLE_DEVICE_DISPATCH=true`, dispatch one bounded project run, and
    verify authorization, repository scope, output, publication fencing, and
    cancellation evidence. This runbook does not assert that canary has been
    performed.
12. If the canary fails, immediately restore
    `NORNS_ENABLE_DEVICE_DISPATCH=false`. Keep GitHub Actions available and
    investigate before another canary. Do not start a manual local dispatch to
    work around the kill switch.

## Validation queries

Run these with the read-only/operator database role unless a step explicitly
requires the privileged migration role. Set `project_id` in the local `psql`
session; do not paste its value or query output into shared logs.

### Schema and migration

```sql
SELECT to_regclass('public.legacy_repository_binding_claims') IS NOT NULL
  AS claim_table_present;

SELECT conname, convalidated
FROM pg_constraint
WHERE conname IN (
  'repository_bindings_status_check',
  'legacy_repository_binding_claims_state_check',
  'legacy_repository_binding_claims_state_shape_check',
  'legacy_repository_binding_claims_project_legacy_fk',
  'legacy_repository_binding_claims_project_grant_fk',
  'legacy_repository_binding_claims_project_replacement_fk'
)
ORDER BY conname;
```

Expected: the table is present and every listed constraint is validated.

### Point-in-time candidate inventory

This query counts exact project-primary legacy bindings. It intentionally does
not select or group by `runner_id`.

```sql
SELECT count(*) AS exact_primary_legacy_candidates
FROM projects AS project
JOIN repository_bindings AS binding
  ON binding.id = project.primary_repository_binding_id
 AND binding.project_id = project.id
WHERE project.status = 'active'
  AND binding.binding_type = 'local_runner'
  AND binding.runner_id IS NOT NULL
  AND binding.project_device_repository_grant_id IS NULL
  AND binding.status IN (
    'unverified_candidate',
    'validating',
    'connected',
    'degraded',
    'disconnected',
    'legacy_claim_required'
  );
```

### Exact project before begin

```sql
\set project_id '<project selected in the private operator session>'

SELECT
  project.status = 'active' AS project_active,
  binding.id = project.primary_repository_binding_id AS binding_is_primary,
  binding.binding_type = 'local_runner' AS binding_is_local,
  binding.runner_id IS NOT NULL AS is_legacy_runner_binding,
  binding.project_device_repository_grant_id IS NULL AS has_no_device_grant,
  binding.status,
  project.aggregate_version AS project_version,
  count(run.id) FILTER (
    WHERE run.state IN (
      'created',
      'dispatched',
      'running',
      'waiting_for_human',
      'verifying'
    )
  ) AS live_run_count
FROM projects AS project
JOIN repository_bindings AS binding
  ON binding.id = project.primary_repository_binding_id
 AND binding.project_id = project.id
LEFT JOIN agent_runs AS run
  ON run.project_id = project.id
WHERE project.id = :'project_id'
GROUP BY project.id, binding.id;
```

Expected: all booleans are true, the binding has a preclaim-compatible status,
and `live_run_count` is zero.

### Open claim and eligible targets

```sql
SELECT
  claim.state,
  binding.status AS legacy_binding_status,
  project.primary_repository_binding_id = claim.legacy_binding_id
    AS exact_primary_preserved,
  claim.aggregate_version AS claim_version,
  project.aggregate_version AS project_version
FROM legacy_repository_binding_claims AS claim
JOIN projects AS project
  ON project.id = claim.project_id
JOIN repository_bindings AS binding
  ON binding.id = claim.legacy_binding_id
 AND binding.project_id = claim.project_id
WHERE claim.project_id = :'project_id';

SELECT count(*) AS eligible_grant_scoped_targets
FROM project_device_repository_grants AS grant_record
JOIN device_repository_registrations AS registration
  ON registration.id = grant_record.repository_registration_id
 AND registration.state = 'active'
 AND registration.default_branch IS NOT NULL
JOIN devices AS device
  ON device.id = registration.device_id
 AND device.lifecycle = 'active'
JOIN users AS device_owner
  ON device_owner.id = device.owner_user_id
 AND device_owner.status = 'active'
JOIN device_credentials AS credential
  ON credential.device_id = device.id
 AND credential.id = registration.approved_credential_id
 AND credential.generation = registration.approved_generation
 AND credential.generation = device.current_generation
 AND credential.state = 'active'
WHERE grant_record.project_id = :'project_id'
  AND grant_record.state = 'active';
```

Expected before finalization: `state` and binding status are both
`claim_required`, `exact_primary_preserved` is true, and at least one exact
grant-scoped target exists.

### Atomic finalize

```sql
SELECT
  claim.state = 'finalized' AS claim_finalized,
  claim.finalized_at IS NOT NULL AS has_finalized_time,
  legacy.status = 'revoked' AS legacy_binding_revoked,
  replacement.id = project.primary_repository_binding_id
    AS replacement_is_primary,
  replacement.runner_id IS NULL AS replacement_has_no_legacy_runner,
  replacement.project_device_repository_grant_id =
    claim.project_device_repository_grant_id AS replacement_matches_claim_grant
FROM legacy_repository_binding_claims AS claim
JOIN projects AS project
  ON project.id = claim.project_id
JOIN repository_bindings AS legacy
  ON legacy.id = claim.legacy_binding_id
 AND legacy.project_id = claim.project_id
JOIN repository_bindings AS replacement
  ON replacement.id = claim.replacement_binding_id
 AND replacement.project_id = claim.project_id
WHERE claim.project_id = :'project_id';
```

Expected: every boolean is true.

### Global retirement gate

```sql
SELECT
  count(*) FILTER (WHERE state = 'claim_required') AS open_claims,
  count(*) FILTER (WHERE state = 'finalized') AS finalized_claims
FROM legacy_repository_binding_claims;

SELECT count(*) AS remaining_primary_legacy_candidates
FROM projects AS project
JOIN repository_bindings AS binding
  ON binding.id = project.primary_repository_binding_id
 AND binding.project_id = project.id
WHERE project.status = 'active'
  AND binding.binding_type = 'local_runner'
  AND binding.runner_id IS NOT NULL
  AND binding.project_device_repository_grant_id IS NULL;
```

Both `open_claims` and `remaining_primary_legacy_candidates` must be zero before
disabling legacy local runner authentication. The finalized count is retained
as audit/recovery evidence.

## Failure and rollback handling

| Failure point | Required response |
| --- | --- |
| Migration or default-off application fails before a claim begins | Keep `0060` in place, restore the prior compatible application or roll forward, and retain only the explicitly required temporary legacy compatibility flags. Never silently enable global compatibility. Validate GitHub Actions. |
| Enrollment response is lost | The agent keeps its persisted key and follows the enrollment polling/redeeming contract. Never generate and discard a replacement key merely because an HTTP response was lost. |
| Claim begin response is lost | Retry the same POST with the same idempotency key, or GET the current claim. Do not begin another project or select by runner identifier. |
| Finalize response is lost | Retry the exact same finalize body and idempotency key. A successful replay returns the finalized projection. |
| Version, active-work, or target conflict | Reload the execution-target and claim projections, stop or finish active work through the normal audited controls, and obtain a fresh human confirmation if the target or repository changed. |
| Claim is open but cannot finalize | Leave it open with the binding at `legacy_claim_required`; keep GitHub Actions available. There is no application rollback transition from `claim_required` to a preclaim state. Any exceptional database repair requires a separately reviewed, audited privileged transaction. |
| Device canary fails | Set `NORNS_ENABLE_DEVICE_DISPATCH=false`, request cancellation from an online runner, fence authorization as needed, and record offline termination as unconfirmed. Preserve worktrees and use GitHub Actions while investigating. |
| Newly installed agent fails | Stop it safely, preserve its state and credentials for diagnosis, reinstall a newer immutable signed package or restore the prior signed package, and restart. Uninstall and server revocation are separate actions. |

Do not roll an old application binary across open claims unless it is known to
understand `legacy_claim_required`. Once marking starts, prefer a feature-flag
rollback or a roll-forward fix. Never delete a claim, rewrite a binding, or
reenable legacy global selection merely to make a dashboard look healthy.

## Evidence packet

For each gate, record only redacted operational evidence:

- deployed application commit and applied migration number;
- exact boolean flag values, never key material;
- capabilities projection;
- counts and boolean results from the validation queries, without private IDs;
- owner confirmation that fresh enrollment, key proof, and repository
  re-cataloging occurred on the actual installation;
- owner confirmation of the exact repository selection;
- signed package version, platform, signature-verification result, reboot
  result, and canary outcome;
- GitHub Actions health before, during, and after the cutover;
- device-dispatch kill-switch state;
- any response-loss retry key correlation recorded only in the protected audit
  system.

The physical enrollment/confirmation gate and the signed OS canary gate require
human sign-off. Automated tests, schema state, or the presence of a single
production candidate do not complete either gate.

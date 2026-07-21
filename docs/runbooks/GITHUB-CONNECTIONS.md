# GitHub workspace connection runbook

The Norns uses one GitHub App for user authorization, installation discovery,
repository selection, and optional repository creation. Projects never store
GitHub credentials.

## Recommended: guided GitHub App setup

With relational identity enabled, a workspace administrator can open
**Settings → Connections → GitHub → Set up GitHub** and choose whether the App
should be owned by their personal account or a GitHub organization.

The Norns uses GitHub's App Manifest flow to preconfigure the callback URL,
setup URL, permissions, and events. GitHub asks the administrator to confirm
the generated App and then returns its credentials directly to the server. The
server encrypts the client secret, private key, and webhook secret before
storing them in `github_app_configurations`; raw credentials are never returned
to the browser or stored in project records.

Configuration, OAuth-state, and token-encryption keys are independently derived
with HKDF from the active `NORNS_CREDENTIAL_HMAC_KEY`. No additional Railway
secret is required. The configuration records the credential key ID so a key
rotation remains readable while that prior key remains in
`NORNS_CREDENTIAL_HMAC_KEYRING`.

The guided flow is:

1. Confirm the preconfigured App on GitHub.
2. Authorize the new App identity.
3. Install it for the desired account and repositories.
4. Return to The Norns with the reusable workspace connection available.

## Advanced: environment-managed GitHub App

Operators may instead configure an existing GitHub App entirely through the
deployment secret store. Environment configuration takes precedence over a
database-stored manifest configuration.

Configure these GitHub App URLs for the deployed Norns origin:

Configure these GitHub App URLs for the deployed Norns origin:

- Callback URL: `https://<norns-origin>/api/integrations/github/callback`
- Setup URL: `https://<norns-origin>/api/integrations/github/setup`
- Request user authorization during installation: enabled
- Expiring user access tokens: enabled

Minimum permissions for repository selection and normal Norns work:

- Metadata: read
- Contents: read/write
- Pull requests: read/write
- Checks: none (or read only when verification requires it)

Required for Actions-hosted execution (E14 — the runtime that runs Norns'
work by committing a workflow file and dispatching GitHub Actions runs; see
`GITHUB_TOKEN_SCOPES` in `apps/server/src/integrations/github.ts`):

- Workflows: write — commits `.github/workflows/norns-agent.yml`. GitHub
  rejects any Contents write under `.github/workflows/` without this.
- Actions: read/write — dispatches a workflow run and reads its status,
  conclusion, and job logs.
- Secrets: write — reads the repository public key and writes the runner's
  enrollment secret.

Without these three, Actions-hosted execution fails closed with a
`github_app_permission_missing` error (see "Upgrading an existing App" below)
rather than silently doing nothing; all other connection features (browsing
repositories, connecting a repository, the guided setup flow itself) work
without them.

Optional permission for **Create on GitHub**:

- Administration: write

Administration write is not required to connect GitHub or select existing
repositories. When omitted, repository creation fails closed and all other
connection features remain available.

### Deployment secrets

Set the following only in the server secret store:

- `NORNS_GITHUB_APP_ID`
- `NORNS_GITHUB_CLIENT_ID`
- `NORNS_GITHUB_CLIENT_SECRET`
- `NORNS_GITHUB_APP_SLUG`
- `NORNS_GITHUB_PRIVATE_KEY` (PEM; escaped newlines are accepted)
- `NORNS_GITHUB_STATE_SECRET` (at least 32 bytes)
- `NORNS_GITHUB_TOKEN_ENCRYPTION_KEY` (base64-encoded 32-byte key)
- `NORNS_PUBLIC_ORIGIN`

The application treats an entirely absent GitHub configuration as disabled.
A partial configuration is a startup error so an operator cannot mistake a
broken or insecure integration for a healthy connection.

## Rollout

1. Apply `0008_workspace_connections` and `0010_github_app_manifest` with the
   privileged migration role.
2. Open **Settings → Connections → Set up GitHub** as a workspace administrator.
3. Complete the guided GitHub confirmation, authorization, and installation.
4. Confirm the installation appears and its repositories are selectable from
   **New project → Existing codebase**.

For environment-managed configuration, perform the URL, secret, restart, and
installation steps manually instead.

Rotate the client secret, private key, state secret, or token-encryption key
through the normal credential incident process. Rotating the encryption key
without reauthorizing stored users makes existing encrypted authorizations
unreadable; reconnect GitHub immediately after such a rotation.

## Upgrading an existing App to add a permission (e.g. Actions-hosted execution)

Changing the manifest (or the environment-managed permission list above) only
changes what a **newly created** App requests. GitHub does **not**
retroactively change an already-created App's permissions — an App created
before `workflows`, `actions`, or `secrets` were added to `default_permissions`
keeps its old permission set indefinitely, and every installation of it keeps
that old set too, until a human does both of the following on GitHub:

1. **Update the App's permissions.** GitHub → **Settings → Developer
   settings → GitHub Apps** → the app → **Permissions & events**. Add or
   raise the permissions (Workflows: write, Actions: read/write, Secrets:
   write — see the minimum-permissions list above), then **Save changes**.
2. **Accept the pending permission update on each installation.** Editing the
   App's permissions does not push the change to installations automatically
   — GitHub queues it and requires the account that installed the App to
   approve it. Go to **Settings → Applications → Installed GitHub Apps** →
   find the app → **Configure**, and accept the permission update GitHub
   prompts for there. Do this once per installation (once per personal
   account or organization that has installed the App).

Until step 2 is done for a given installation, that installation's tokens are
still minted against its old grant. Norns detects this at the moment it tries
to mint a token needing the new permission and fails the operation with a
`github_app_permission_missing` error naming the missing permission(s) and
these same two steps, rather than a generic GitHub failure — see
`GitHubIntegrationService.installationToken` in
`apps/server/src/integrations/github.ts`. This is not something Norns can
detect or fix in advance; it is only discovered when the operation that needs
the new permission is attempted.

## The "Only select repositories" trap

An installation can be scoped to "All repositories" or "Only select
repositories" for its owner account. If it is scoped to "Only select
repositories," a repository Norns creates through **Create on GitHub** — or
any repository added to GitHub after the installation was configured — is
**not** automatically part of that installation. Nothing Norns dispatches to
that repository can succeed (no token can be scoped to it, so no workflow
commit, secret write, or dispatch will work) until a human adds it explicitly:
**Settings → Applications → Installed GitHub Apps** → the app → **Configure**
→ under "Repository access," add the repository → **Save**.

Norns already surfaces this rather than failing silently: a project whose
repository is not in its installation reports the onboarding blocker
`installation_not_ready` (backed by `GitHubIntegrationService
.installationReadiness()`'s `reason: "repository_not_in_installation"`), with
an `action_required` message and a direct link to the installation's
configuration page. If a newly created or newly connected repository will not
proceed past this state, check the installation's repository-access setting
first.

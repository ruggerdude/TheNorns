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
- Actions: none (or read only when verification requires it)

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

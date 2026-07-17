# GitHub workspace connection runbook

The Norns uses one GitHub App for user authorization, installation discovery,
repository selection, and optional repository creation. Projects never store
GitHub credentials.

## GitHub App configuration

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

## Deployment secrets

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

1. Apply `0008_workspace_connections` with the privileged migration role.
2. Configure the GitHub App callback/setup URLs and permissions.
3. Add the seven GitHub environment variables to the server.
4. Restart The Norns.
5. Open **Settings → Connections → Connect GitHub**.
6. Install the App for the desired personal account or organization.
7. Confirm the installation appears and its repositories are selectable from
   **New project → Existing codebase**.

Rotate the client secret, private key, state secret, or token-encryption key
through the normal credential incident process. Rotating the encryption key
without reauthorizing stored users makes existing encrypted authorizations
unreadable; reconnect GitHub immediately after such a rotation.

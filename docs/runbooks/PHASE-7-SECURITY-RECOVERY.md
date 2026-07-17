# Phase 7 Security and Recovery Runbook

## Browser sessions

- Browser login uses a `Secure`, `HttpOnly`, `SameSite=Strict` session cookie.
- A separate readable CSRF cookie must match `x-csrf-token` on unsafe
  cookie-authenticated requests.
- The web application stores only a non-secret session-presence marker. It does
  not store a bearer credential in `localStorage` or `sessionStorage`.
- High-risk administrator mutations require authentication within the last 15
  minutes.
- Account settings list current and other server-side sessions and allow other
  sessions to be revoked.

CLI/API clients may request a bearer response with
`x-norns-api-client: bearer`. Browser clients do not receive the raw session
token in the response body.

Set `NORNS_PUBLIC_ORIGIN` to the canonical `https://` application origin for
emailed invite and recovery links. Railway deployments use
`RAILWAY_PUBLIC_DOMAIN` automatically when the explicit value is absent.

## Password recovery

1. `POST /api/auth/recovery/request` always returns an accepted response so
   account existence is not disclosed.
2. The server records only the credential HMAC, never the raw recovery token.
3. Recovery tokens expire after one hour and are single-use.
4. Completing recovery replaces the password, revokes every existing session,
   consumes the token, and records a security notification.
5. The user must sign in again with the new password.

## Runner revocation

An administrator revokes a runner through the Phase 7 operations route with a
`revoked_through_generation`. Queued or dispatched commands at or below that
generation are cancelled. Both scheduling and runner-event ingestion reject
the revoked generation; a later generation can be paired and used.

## Database recovery evidence

The production-shaped restore check must:

1. create a checkpoint containing every frozen legacy source;
2. produce a real PostgreSQL custom-format `pg_dump`;
3. restore it into a distinct database;
4. verify exact-text and canonical semantic hashes for every source;
5. prove the active migration run is absent from the restored target; and
6. clean up the isolated recovery database after the assertion completes.

Run it with a disposable or explicitly approved PostgreSQL instance:

```sh
V2_POSTGRES_TEST_URL=postgresql://... \
PHASE2_DOCKER_BACKUP_TEST=1 \
pnpm --filter @norns/server exec vitest run \
  test/phase2PostgresRecovery.test.ts
```

Do not point this test at an unapproved production database. It creates and
drops isolated schemas and databases.

# Deploying TheNorns

## The topology (read this first)

TheNorns is split across two places, by design (ADR-002):

- **The control plane runs on Railway** — the relay, HTTP API, dashboard, and
  PostgreSQL-backed account/project state. This is the public website.
- **The runner runs on your own machine** — it checks out git worktrees and
  launches coding agents (Claude Code / Codex). It makes an **outbound-only**
  connection to the Railway URL, so your machine needs no open ports and is
  never exposed.

You "use" TheNorns by opening the Railway URL in a browser **and** running a
local runner that pairs with it.

## What works today vs. what each tier unlocks

| Tier | You get | Needs |
|---|---|---|
| **1 — Control plane** | The Railway URL serves the project workspace, graph editor, and demo dashboard with durable user accounts. | The app service, PostgreSQL, and a one-time first-admin setup key. |
| **2 — Persistent state** | Users, projects, relay/outbox, and audit state survive restarts + redeploys. | ✅ Automatic once `DATABASE_URL` points at PostgreSQL. |
| **3 — Run work via your runner** | Pair a local runner to the deployed relay and drive it. | ✅ Runner CLI built + verified. Live coding agents also need API keys (NORN-027) + a local Docker host. |

Production requires durable account storage: the server deliberately refuses
to start if PostgreSQL is missing or unavailable. This prevents a restart from
silently forgetting the admin account and reopening first-time setup.

## Tier 1 — deploy the control plane to Railway

1. **Push this repo to your `TheNorns` GitHub repo:**
   ```sh
   git remote add origin https://github.com/<you>/TheNorns.git
   git push -u origin main
   ```
2. **In Railway:** New Project → Deploy from GitHub repo → pick `TheNorns`.
   Railway detects `railway.json` and builds the `Dockerfile` (single service,
   serves web + API).
3. **Add PostgreSQL before creating the first account:** Railway project →
   **New → Database → Add PostgreSQL**. Confirm the app service receives a
   non-empty `DATABASE_URL` reference. The database must be in the same
   Railway project when using its private hostname.
4. **Set a one-time setup key** in the app service:
   - `NORNS_TOKEN` = a long random string used only to authorize creation of
     the very first admin. It is not a login password or an API session token.
   Railway provides `PORT`, `NODE_ENV=production`, and the Dockerfile sets
   `NORNS_WEB_DIST` — you don't set those.
5. **Open the plain Railway URL** — never put `NORNS_TOKEN` in the URL. The
   one-time setup screen asks for the setup key, admin email, and a new
   password. Create the first admin and verify you reach the project list.
6. **Make setup permanent:** wait for the `users` snapshot to be saved, remove
   `NORNS_TOKEN` from the app service, and redeploy. From this point onward,
   sign-in uses only the admin email and password. The browser manages its
   server-issued session credential; users never copy or type one.
7. **Health check:** `GET /health` returns `{"ok":true,...}` (Railway uses it).

If the first-admin setup screen ever returns after this, do not create another
account. Check the deployment logs and `DATABASE_URL`: it means PostgreSQL did
not restore the existing user snapshot. Production should fail closed rather
than serve an empty identity store.

## Tier 2 — persistence details

On boot, the server prints a `postgres:` line showing whether relay, project,
and user snapshots were restored or are fresh. It creates the `norns_state`
table automatically and flushes state on a 1s cadence and on graceful
shutdown. First-admin creation is flushed before the successful setup response
is returned.

Durability shape: state is snapshotted to a JSONB row and reconstructed via
the same `snapshot()`/`restore()` that's unit-tested against a real Postgres
engine. A hard crash can lose at most ~1s of the very latest events —
acceptable at single-operator scale; a normalized Drizzle schema (ADR-001) is
the scale follow-on when you need it.

### Applying schema migrations

**The server does not apply migrations on boot, by design** — a process that
silently mutates schema every time it starts is how a bad migration reaches
production unannounced. Applying them is a deliberate operator step.

On Railway, the application service's `DATABASE_URL` is bound to a restricted
runtime role that cannot execute DDL (error `42501` — permission denied). This
is intentional: `assertRestrictedRuntimeDatabase` in
`apps/server/src/persistence/postgresConnection.ts` enforces it. You **cannot**
run `applyMigrations.js` from the app service shell or via `railway run` from
your laptop (the private hostname `postgres.railway.internal` is unresolvable
outside Railway's network). Using the public endpoint (`DATABASE_PUBLIC_URL`)
is also blocked: `postgresPoolConfig` requires a valid TLS chain, and the
public endpoint presents a self-signed certificate. Disabling TLS verification
is not acceptable — that would send production credentials over the public
internet unverified.

**The correct procedure: SSH into the PostgreSQL service and apply migrations
via psql with the Unix socket (no TLS required, connection as the owner):**

```bash
railway ssh --service Postgres 'psql -v ON_ERROR_STOP=1 \
  -h /var/run/postgresql -U postgres -d railway'
```

The Postgres container has no `node`, so each migration must be applied by
piping its SQL plus a tracking row in a single transaction. For each migration
file in `apps/server/drizzle/`:

```sql
BEGIN;
<paste the full contents of NNNN_name.sql here>
INSERT INTO norns_schema_migrations (name, checksum)
  VALUES ('NNNN_name', '<sha256 hex of the .sql file>');
COMMIT;
```

The checksum must be the SHA-256 hex digest of the migration file itself
(what `v2MigrationChecksum` in `apps/server/src/persistence/v2/migrate.ts`
computes). A later `applyMigrations.js` run will see the migration as already
applied instead of aborting on a checksum mismatch.

Apply this **before** starting a build that expects new columns. If you forget,
the server refuses to start: `assertCurrentRuntimeSchema`
(`apps/server/src/persistence/postgresConnection.ts`) proves the exact
relations and columns the build needs and fails with `runtime_schema_outdated`,
naming what is missing.

## Tier 3 — run work via your local runner

The runner runs on **your machine**, not Railway. It's built and verified.

1. **Get a pairing code** from the authenticated web UI's runner panel. No
   manual session token is required. For API-only automation, first exchange
   the account credentials for a short-lived session credential, then use it:
   ```sh
   SESSION_TOKEN="$(curl -fsS -X POST \
     -H 'content-type: application/json' \
     -d '{"email":"you@example.com","password":"your-password"}' \
     https://<your-app>.up.railway.app/api/auth/login | jq -r .token)"
   curl -X POST -H "authorization: Bearer $SESSION_TOKEN" \
     https://<your-app>.up.railway.app/api/pairing/start
   ```
   `SESSION_TOKEN` is an API automation detail, not `NORNS_TOKEN`, and it is
   never entered on the normal login screen.
2. **Pair and start the runner locally** (needs Node 24 + git):
   ```sh
   # from a clone of the repo, after: pnpm install && pnpm --filter @norns/runner build
   node apps/runner/dist/cli.js pair <code> --server https://<your-app>.up.railway.app --id my-laptop
   node apps/runner/dist/cli.js start --server https://<your-app>.up.railway.app --id my-laptop
   ```
   The runner connects outbound (https→wss); the UI shows it online. You can
   now drive fixture tasks and the full remote-control set against it.
3. **For live coding agents** (real Claude Code / Codex work), also:
   - add `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `NORNS_OPENAI_MODEL` as
     Railway variables, and
   - run the runner on a host with **Docker** (the ADR-003 sandbox fails
     closed without it).
   Then create a project, run the planning loop, approve, allocate, and
   execute — the local runner does the coding and streams results back.

### Planning model configuration

New projects store the exact project-manager model selected in the UI (for
example, `claude-fable-5` or `gpt-5.6-sol`). Both provider API keys are still
required because every plan receives cross-provider review.

- `NORNS_OPENAI_MODEL` selects the OpenAI reviewer for Anthropic-led projects
  and remains the OpenAI fallback for legacy provider-only projects.
- `NORNS_REVIEWER_ANTHROPIC_MODEL` optionally selects the Anthropic reviewer
  for OpenAI-led projects. It falls back to `NORNS_PM_MODEL`, then
  `claude-sonnet-5`.
- `NORNS_PM_MODEL` is retained only as an Anthropic fallback for projects
  persisted before exact PM model selection was introduced.

## Local development

```sh
pnpm install
pnpm --filter @norns/server run build && node apps/server/dist/main.js   # :8787
pnpm --filter @norns/web dev                                             # :5173 (proxies /api)
# open http://localhost:5173 and sign in with dev@local.test / dev-password
```

### Deploy ordering (Railway auto-deploys, migrations do not)

Railway rebuilds on every push to `main`. **Migrations do not run with it.** So a
push that adds a migration opens a window where the new code is live against the
old schema. That window has caused two production incidents:

- a conversation route selecting a column that did not exist yet, and
- the attention/portfolio read model failing silently, degrading the dashboard
  to "showing last known data" while it still listed a deleted project.

Apply migrations **before** pushing the code that needs them, or immediately
after and accept the gap. `assertCurrentRuntimeSchema` catches the columns it
knows about at startup — **extend it whenever you add a column a runtime path
reads**, or the gap shows up as a degraded read model rather than a refused
boot, which is much harder to attribute.

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

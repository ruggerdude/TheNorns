# Deploying TheNorns

## The topology (read this first)

TheNorns is split across two places, by design (ADR-002):

- **The control plane runs on Railway** — the relay, HTTP API, dashboard, and
  (once ported) the database. This is the public website.
- **The runner runs on your own machine** — it checks out git worktrees and
  launches coding agents (Claude Code / Codex). It makes an **outbound-only**
  connection to the Railway URL, so your machine needs no open ports and is
  never exposed.

You "use" TheNorns by opening the Railway URL in a browser **and** running a
local runner that pairs with it.

## What works today vs. what each tier unlocks

| Tier | You get | Needs |
|---|---|---|
| **1 — Live demo** | The Railway URL serves the graph editor + dashboard against the built-in demo project. | Nothing but the deploy below. |
| **2 — Persistent** | Relay/outbox/audit state survives restarts + redeploys. | ✅ Built. Just add the Railway Postgres plugin (injects `DATABASE_URL`). |
| **3 — Run work via your runner** | Pair a local runner to the deployed relay and drive it. | ✅ Runner CLI built + verified. Live coding agents also need API keys (NORN-027) + a local Docker host. |

Tier 1 is your deploy. Tiers 2 and 3 are built and tested — Tier 2 activates
automatically when `DATABASE_URL` is present; Tier 3's runner CLI works today
(live LLM execution is the only part still gated on your keys + Docker).

## Tier 1 — deploy the demo to Railway

1. **Push this repo to your `TheNorns` GitHub repo:**
   ```sh
   git remote add origin https://github.com/<you>/TheNorns.git
   git push -u origin main
   ```
2. **In Railway:** New Project → Deploy from GitHub repo → pick `TheNorns`.
   Railway detects `railway.json` and builds the `Dockerfile` (single service,
   serves web + API).
3. **Set one environment variable** in the Railway service:
   - `NORNS_TOKEN` = a long random string (this is the session password;
     the server refuses to start in production without it).
   Railway provides `PORT`, `NODE_ENV=production`, and the Dockerfile sets
   `NORNS_WEB_DIST` — you don't set those.
4. **Open the URL** Railway gives you, with the token as a query param:
   `https://<your-app>.up.railway.app/?token=<NORNS_TOKEN>`
   You should see the workflow graph; the **PM Dashboard** button shows the
   demo engine's derived state.
5. **Health check:** `GET /health` returns `{"ok":true,...}` (Railway uses it).

> ⚠️ **Single-user only, for now.** The token travels in the URL and is a
> shared secret — fine for you testing privately, not for real users. Proper
> per-user auth (passkeys) is Tier-3 work; do not share the URL+token as if it
> were multi-user.

## Tier 2 — persistence (built; one click to activate)

1. In the Railway project: **New → Database → Add PostgreSQL**. Railway
   injects `DATABASE_URL` into your service automatically.
2. Redeploy (or it redeploys on the variable change). On boot the server now
   prints `relay state restored from postgres` (or `fresh` the first time),
   creates its `norns_state` table, and flushes state on a 1s cadence and on
   shutdown. Relay/outbox/audit/runner state now survives restarts and
   redeploys.

Durability shape: state is snapshotted to a JSONB row and reconstructed via
the same `snapshot()`/`restore()` that's unit-tested against a real Postgres
engine. A hard crash can lose at most ~1s of the very latest events —
acceptable at single-operator scale; a normalized Drizzle schema (ADR-001) is
the scale follow-on when you need it.

## Tier 3 — run work via your local runner

The runner runs on **your machine**, not Railway. It's built and verified.

1. **Get a pairing code** — from the web UI's runner panel, or directly:
   ```sh
   curl -X POST -H "authorization: Bearer $NORNS_TOKEN" \
     https://<your-app>.up.railway.app/api/pairing/start
   ```
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

## Local development (unchanged)

```sh
pnpm install
pnpm --filter @norns/server run build && node apps/server/dist/main.js   # :8787
pnpm --filter @norns/web dev                                             # :5173 (proxies /api)
# open http://localhost:5173?token=dev-token
```

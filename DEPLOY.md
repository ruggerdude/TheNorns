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
| **1 — Live demo** | The Railway URL serves the graph editor + dashboard against the built-in demo project (in-memory). | Nothing but the deploy below. |
| **2 — Persistent + multi-project** | Real projects that survive restarts. | Railway Postgres + the NORN-024 store port (not yet built). |
| **3 — Actually run work** | Create a project, plan it with real models, execute it via your local runner. | API keys (NORN-027) + the runner CLI (not yet built) + a local Docker host for the sandbox. |

Tier 1 is deployable right now. Tiers 2–3 are tracked work items.

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

## Tier 2 — persistence (when you're ready)

1. Add the **Postgres** plugin to the Railway project; it injects
   `DATABASE_URL`.
2. Build the NORN-024 store adapters (port the tested in-memory
   `RelayStores` + `DispatchStore` semantics to Drizzle/Postgres — the
   semantics are already pinned by tests).
3. Swap `main.ts` to construct the Postgres-backed stores when `DATABASE_URL`
   is present.

## Tier 3 — running real work

1. Add `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` (+ `NORNS_OPENAI_MODEL`) as
   Railway variables — the relay hands runs to the runtime adapters.
2. On your **local machine**, once the runner CLI exists:
   ```sh
   npx norns-runner pair <pairing-code-from-the-UI> --server https://<your-app>.up.railway.app
   npx norns-runner start
   ```
   The runner needs Node 24, git, and (for the sandbox) a Docker host.
3. Create a project in the UI, run the planning loop, approve, allocate,
   and execute — the local runner does the coding work and streams back.

## Local development (unchanged)

```sh
pnpm install
pnpm --filter @norns/server run build && node apps/server/dist/main.js   # :8787
pnpm --filter @norns/web dev                                             # :5173 (proxies /api)
# open http://localhost:5173?token=dev-token
```

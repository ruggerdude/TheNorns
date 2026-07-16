# ADR-002: Relay Topology, Hosting & Data Services (Phase 1A)

**Status:** Accepted 2026-07-14; **Railway text consolidated 2026-07-16** ·
**Date:** 2026-07-13
**Resolves:** NORN-003 · **Amended by:**
`docs/reviews/REVIEW-001-disposition.md`, ADR-005, ADR-006

> **Amendment (2026-07-14) — Railway supersedes Fly.io + Neon.** The operator
> created a GitHub repo (`TheNorns`) and a Railway project, so hosting moves
> to **Railway** (app **and** Postgres on one platform). This is not a
> reversal — Railway was the explicit designated fallback in this ADR ("app +
> DB together"); it is now the primary. What is unchanged: the outbound-only
> runner topology, the backend-is-the-relay decision, and that connection
> state is never trusted solely in process memory. Deploy shape is a single
> Docker service (`Dockerfile` + `railway.json`) that serves the built web
> app and the API/relay from one process; add a Railway Postgres plugin and
> wire `DATABASE_URL` for the NORN-024 store port. Neon remains a valid
> alternative if a separate DB is ever wanted.

## Context

The PRD topology is Browser ⇄ cloud relay/API ⇄ Local Runner, runner
outbound-only. Open questions: separate relay service or not; where the
cloud side runs; and (added by REVIEW-001) who operates Postgres, plus
artifact blob storage.

## Decision

**1. No separate relay service.** The backend server *is* the relay: one
deployable Node service exposing the HTTP API plus `/ws/session` (browser)
and `/ws/runner` (runner). The server holds routing state, the durable
command outbox, and the audit feed; repository contents stay on the runner.
**Connection state is never trusted solely in process memory** — outbox rows
and ack watermarks are durable, so a server restart recovers from the
database (REVIEW-001 P0-2/P1-5).

**2. App hosting: Railway**, initially one Node/Docker service serving the
built web application, HTTP API, and WebSocket relay. The service is
production-configured through Railway variables and deploys from the GitHub
repository.

**3. Database: Railway managed PostgreSQL**, linked to the application with
Railway reference variables. ADR-005 governs normalized schema, migrations,
backup/restore, events, and the transactional outbox.

**4. Artifact/blob storage: S3-compatible object storage** selected during the
evidence/artifact implementation phase. Local development may use a compatible
filesystem implementation. PostgreSQL stores metadata and content hashes.

**5. Operational requirements (mandatory before pilot):** automated backups
verified; point-in-time recovery expectations documented; migration
rollback procedure; **a tested restore** (Phase 8 exit).

## Rationale

- Long-lived runner sockets and a resident dispatch loop require a
  classic long-running service; Railway supports the current Docker topology.
- A separate relay would be a third protocol hop with no MVP benefit.
- Managed Postgres shifts backups/upgrades/recovery off the project; for an
  MVP intended to become commercial, self-operating the database is the
  wrong place to spend operator attention (REVIEW-001 P1-5).
- Everything is a plain Docker image + connection strings — moving hosts is
  a redeploy, not a redesign.
- Phase 1A acceptance is only meaningful against a genuinely remote relay.

## Alternatives rejected

Fly.io/Neon (previous primary; no longer the operator’s selected deployment).
Self-operated PostgreSQL (unnecessary operational burden). Hetzner VPS
(cheapest but most operations). Request-scoped platforms (coordinator and
runner sockets need a resident process). Tailscale direct-to-runner (audit and
coordination state must survive runner loss).

## Security posture

- Only the Railway service is internet-exposed; the runner connects outbound
  with Ed25519 authentication, revocation, and generation fencing.
- Railway injects database/provider configuration as service variables.
  Provider and repository credentials must not be included in the image or
  worker prompts.
- Kill switch is a server-side flag checked by the dispatch loop.

## Consequences

- Deployment remains one Railway app service plus Railway PostgreSQL until
  scale requires separation. Artifact storage is added independently.
- `/ws/runner` retains outbox-backed delivery and watermark replay; acceptance
  includes cross-network operation and server-restart recovery.
- Single machine = brief downtime on deploys; tolerated because runner
  buffer-and-replay doubles as deploy tolerance.
- Database notifications are hints only; polling durable jobs guarantees
  recovery.
- Human-controlled prerequisites are the Railway project, PostgreSQL service,
  GitHub App configuration, and eventual object-storage account.

# ADR-002: Relay Topology, Hosting & Data Services (Phase 1A)

**Status:** Accepted 2026-07-14 (human direction to proceed with Phase 0A) · **Date:** 2026-07-13
**Resolves:** NORN-003 · **Amended by:** `docs/reviews/REVIEW-001-disposition.md`

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

**2. App hosting: Fly.io**, single region, single small machine
(`shared-cpu-1x`, 512 MB), TLS automatic, deploys via `flyctl`.

**3. Database: managed Postgres on Neon** (same region as the Fly app).
Fly's legacy "Fly Postgres" is explicitly unmanaged; Fly's newer Managed
Postgres (MPG) is genuinely managed but starts at ~$38/mo — out of
proportion for a single-operator MVP. Neon provides automated backups,
point-in-time recovery, and zero database operations at ~$0–19/mo for this
scale. Fly MPG is the designated same-platform alternative if Neon latency
or connection behavior disappoints.

**4. Artifact/blob storage: S3-compatible object storage** (Tigris via Fly,
or any S3-compatible bucket; local disk in dev) for large logs, transcripts,
patches, artifacts. Postgres keeps metadata + content hashes only.

**5. Operational requirements (mandatory before pilot):** automated backups
verified; point-in-time recovery expectations documented; migration
rollback procedure; **a tested restore** (Phase 8 exit).

## Rationale

- Long-lived runner sockets + a resident dispatch loop rule out
  request-scoped platforms; Fly is the cheapest managed host in the
  classic-server class. Cost envelope all-in: **~US$10–35/month**.
- A separate relay would be a third protocol hop with no MVP benefit.
- Managed Postgres shifts backups/upgrades/recovery off the project; for an
  MVP intended to become commercial, self-operating the database is the
  wrong place to spend operator attention (REVIEW-001 P1-5).
- Everything is a plain Docker image + connection strings — moving hosts is
  a redeploy, not a redesign.
- Phase 1A acceptance is only meaningful against a genuinely remote relay.

## Alternatives rejected

Railway (fine fallback, app + DB together). Fly MPG (managed but ~$38/mo
minimum; designated alternative). Self-operated Fly Postgres (unmanaged;
operational burden). Hetzner VPS (cheapest, most ops). Cloudflare
Workers/DO (engine wants a long-running Node process). Tailscale
direct-to-runner (audit trail must survive runner loss; couples browser
access to runner uptime).

## Security posture

- Only the server is internet-exposed; runner outbound-only WSS with
  Ed25519 keypair + rotation + revocation + generation fencing; browser via
  passkeys with the hardening set from the PRD Security section.
- Neon reached over TLS with credentials held as Fly secrets; provider keys
  encrypted at rest in the credential store, encryption key as a Fly secret
  — never in the image.
- Kill switch is a server-side flag checked by the dispatch loop.

## Consequences

- Phase 1A infra: Fly app, Neon database, Tigris/S3 bucket, `flyctl`
  pipeline, `/ws/runner` with outbox-backed command delivery and
  watermark-based replay; 1A acceptance run from a device on a different
  network, including the server-restart recovery test.
- Single machine = brief downtime on deploys; tolerated because runner
  buffer-and-replay doubles as deploy tolerance.
- NOTIFY-over-Neon may drop across connection interruptions — irrelevant by
  design, since polling the durable jobs table guarantees recovery
  (ADR-001).
- Human-only prerequisites: Fly.io and Neon accounts + payment methods.

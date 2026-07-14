// @norns/server — backend entrypoint.
// Phase 1A builds the Fastify app, /ws/session and /ws/runner endpoints,
// the durable command outbox, and the audit log on top of @norns/contracts.
import { CONTRACTS_VERSION } from "@norns/contracts";

export function serverInfo(): { name: string; contracts: string } {
  return { name: "@norns/server", contracts: CONTRACTS_VERSION };
}

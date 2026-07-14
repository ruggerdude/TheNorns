// @norns/runner — Local Runner daemon entrypoint.
// Phase 1A builds pairing, the outbound WebSocket with buffered replay,
// the durable command-dedup store, and the fixture task executor.
import { CONTRACTS_VERSION } from "@norns/contracts";

export function runnerInfo(): { name: string; contracts: string } {
  return { name: "@norns/runner", contracts: CONTRACTS_VERSION };
}

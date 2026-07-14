// @norns/web — frontend placeholder.
// Phase 1A replaces this with a Vite + React app (runner status, log stream,
// remote controls); React Flow graph arrives in Phase 4.
import { CONTRACTS_VERSION } from "@norns/contracts";

export function webInfo(): { name: string; contracts: string } {
  return { name: "@norns/web", contracts: CONTRACTS_VERSION };
}

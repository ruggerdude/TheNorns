import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOCAL_AGENT_PAIRING_PROTOCOL = "norns-agent:";
export const LOCAL_AGENT_CONFIG_FILENAME = "agent-config.json";

export interface LocalAgentConfig {
  version: 1;
  server: string;
  runner_id: string;
}

export interface LocalAgentPairing {
  server: string;
  runnerId: string;
  code: string;
}

const SAFE_RUNNER_ID = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_PAIRING_CODE = /^[a-f0-9]{8}$/;

function serverOrigin(value: string): string {
  const url = new URL(value);
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("local-agent pairing server must use HTTPS");
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("local-agent pairing server must be an origin");
  }
  if (url.search || url.hash) throw new Error("local-agent pairing server must be an origin");
  return url.origin;
}

function runnerId(value: string): string {
  if (!SAFE_RUNNER_ID.test(value)) throw new Error("invalid local-agent runner id");
  return value;
}

export function parseLocalAgentPairingUri(value: string): LocalAgentPairing {
  const url = new URL(value);
  if (url.protocol !== LOCAL_AGENT_PAIRING_PROTOCOL || url.hostname !== "pair") {
    throw new Error("invalid local-agent pairing link");
  }
  const server = url.searchParams.get("server");
  const code = url.searchParams.get("code");
  const id = url.searchParams.get("runner_id") ?? "runner-1";
  if (!server || !code || !SAFE_PAIRING_CODE.test(code)) {
    throw new Error("invalid or incomplete local-agent pairing link");
  }
  return { server: serverOrigin(server), runnerId: runnerId(id), code };
}

export function writeLocalAgentConfig(dataDir: string, config: LocalAgentConfig): void {
  const normalized: LocalAgentConfig = {
    version: 1,
    server: serverOrigin(config.server),
    runner_id: runnerId(config.runner_id),
  };
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, LOCAL_AGENT_CONFIG_FILENAME);
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readLocalAgentConfig(dataDir: string): LocalAgentConfig {
  const parsed = JSON.parse(
    readFileSync(join(dataDir, LOCAL_AGENT_CONFIG_FILENAME), "utf8"),
  ) as Partial<LocalAgentConfig>;
  if (parsed.version !== 1 || !parsed.server || !parsed.runner_id) {
    throw new Error("local agent is not configured — connect it from The Norns first");
  }
  return {
    version: 1,
    server: serverOrigin(parsed.server),
    runner_id: runnerId(parsed.runner_id),
  };
}

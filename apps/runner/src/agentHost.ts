import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  PendingDeviceCredentialStore,
  type PendingDeviceCredentialSummary,
} from "./pendingDeviceCredential.js";

export const AGENT_HOST_LOCK_FILENAME = "agent-host.lock";
export const AGENT_HOST_PORT_FILENAME = "agent-host.json";
export const AGENT_HOST_SESSION_COOKIE = "norns_agent_session";
export const AGENT_HOST_CSRF_HEADER = "x-norns-agent-csrf";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"] as const);
const DEFAULT_BOOTSTRAP_TTL_MS = 60_000;
const DEFAULT_SESSION_TTL_MS = 15 * 60_000;
const MAX_JSON_BODY_BYTES = 8 * 1024;
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

const ENROLLMENT_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Norns Local Agent</title>
  <link rel="stylesheet" href="/agent-host.css">
  <script defer src="/agent-host.js"></script>
</head>
<body>
  <main>
    <p class="eyebrow">Norns Local Agent</p>
    <h1>Enrollment</h1>
    <p id="message">Opening the local Control Center…</p>
    <dl>
      <dt>Enrollment</dt><dd id="enrollment">Checking…</dd>
      <dt>Daemon</dt><dd id="daemon">Checking…</dd>
    </dl>
    <div class="actions">
      <button id="prepare" type="button">Prepare enrollment</button>
      <button id="start" type="button">Start daemon</button>
      <button id="stop" type="button">Stop daemon</button>
    </div>
  </main>
</body>
</html>
`;

const ENROLLMENT_CSS = `:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{width:min(36rem,calc(100% - 2rem));padding:2rem;border:1px solid GrayText;border-radius:1rem}
.eyebrow{font-weight:700;letter-spacing:.08em;text-transform:uppercase}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.5rem 1rem}
dt{font-weight:700}.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.5rem}
button{font:inherit;padding:.65rem .9rem}
`;

const ENROLLMENT_JAVASCRIPT = `(() => {
  let csrf = null;
  const message = document.querySelector("#message");
  const enrollment = document.querySelector("#enrollment");
  const daemon = document.querySelector("#daemon");

  async function request(path, options = {}) {
    const headers = { "content-type": "application/json", ...(options.headers || {}) };
    if (csrf) headers["x-norns-agent-csrf"] = csrf;
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Local Agent request failed");
    return body;
  }

  function render(status) {
    enrollment.textContent = status.enrollment_state;
    daemon.textContent = status.daemon_state;
    message.textContent = "This page is served only by the Local Agent on loopback.";
  }

  async function refresh() {
    render(await request("/api/status", { method: "GET", headers: {} }));
  }

  async function bootstrap() {
    const token = new URLSearchParams(location.hash.slice(1)).get("bootstrap");
    if (token) {
      const result = await request("/api/session/bootstrap", {
        method: "POST",
        body: JSON.stringify({ bootstrap_token: token }),
      });
      csrf = result.csrf_token;
      history.replaceState(null, "", "/");
    }
    await refresh();
  }

  document.querySelector("#prepare").addEventListener("click", async () => {
    await request("/api/enrollment/prepare", { method: "POST", body: "{}" });
    await refresh();
  });
  document.querySelector("#start").addEventListener("click", async () => {
    await request("/api/daemon/start", { method: "POST", body: "{}" });
    await refresh();
  });
  document.querySelector("#stop").addEventListener("click", async () => {
    await request("/api/daemon/stop", { method: "POST", body: "{}" });
    await refresh();
  });

  bootstrap().catch((error) => {
    message.textContent = error.message;
    enrollment.textContent = "Unavailable";
    daemon.textContent = "Unavailable";
  });
})();
`;

export type AgentHostLoopbackAddress = "127.0.0.1" | "::1";
export type AgentDaemonState = "stopped" | "starting" | "running" | "stopping" | "failed";
export type AgentEnrollmentState =
  | "not_enrolled"
  | "credential_prepared"
  | "pending"
  | "approved_pending_redemption"
  | "active"
  | "denied"
  | "expired";

export interface AgentDaemonLifecycle {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface AgentHostSingleInstanceLock {
  acquire(): void;
  release(): void;
}

export interface AgentHostPortRecord {
  version: 1;
  host: AgentHostLoopbackAddress;
  port: number;
  origin: string;
}

export interface AgentHostPortDiscovery {
  publish(record: AgentHostPortRecord): void;
  clear(): void;
}

export interface AgentHostStartResult extends AgentHostPortRecord {
  bootstrap_url: string;
}

export interface AgentHostOptions {
  dataDir: string;
  daemon: AgentDaemonLifecycle;
  host?: AgentHostLoopbackAddress;
  port?: number;
  bootstrapTokenTtlMs?: number;
  sessionTtlMs?: number;
  now?: () => number;
  lock?: AgentHostSingleInstanceLock;
  portDiscovery?: AgentHostPortDiscovery;
  credentialStore?: PendingDeviceCredentialStore;
}

interface BoundAgentHost extends AgentHostPortRecord {
  expectedHostHeader: string;
}

interface BootstrapGrant {
  digest: Buffer;
  expiresAt: number;
}

interface LocalSession {
  csrfDigest: Buffer;
  expiresAt: number;
}

class AgentHostHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class AgentHostAlreadyRunningError extends Error {
  constructor() {
    super("Norns Local Agent is already running for this OS user");
  }
}

function ensurePrivateDirectory(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretMatches(candidate: string, expected: Buffer): boolean {
  const actual = sha256(candidate);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function loopbackOrigin(host: AgentHostLoopbackAddress, port: number): string {
  return `http://${host === "::1" ? `[${host}]` : host}:${port}`;
}

function expectedHostHeader(host: AgentHostLoopbackAddress, port: number): string {
  return `${host === "::1" ? `[${host}]` : host}:${port}`;
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    if (entry.slice(0, separator).trim() === name) {
      return entry.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    throw new AgentHostHttpError(415, "application/json is required");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_JSON_BODY_BYTES) {
      throw new AgentHostHttpError(413, "request body is too large");
    }
    chunks.push(bytes);
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AgentHostHttpError(400, "request body must be a JSON object");
  }
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": contentType,
    "content-length": Buffer.byteLength(body).toString(),
    ...extraHeaders,
  });
  response.end(body);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(body), extraHeaders);
}

export class FileAgentHostSingleInstanceLock implements AgentHostSingleInstanceLock {
  private descriptor: number | null = null;
  readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = join(dataDir, AGENT_HOST_LOCK_FILENAME);
  }

  acquire(): void {
    if (this.descriptor !== null) throw new AgentHostAlreadyRunningError();
    ensurePrivateDirectory(this.dataDir);
    try {
      this.descriptor = openSync(this.filePath, "wx", 0o600);
      writeFileSync(this.descriptor, `${process.pid}\n`, "utf8");
      fsyncSync(this.descriptor);
      chmodSync(this.filePath, 0o600);
    } catch (error) {
      if (this.descriptor !== null) {
        closeSync(this.descriptor);
        this.descriptor = null;
        try {
          unlinkSync(this.filePath);
        } catch {
          // Preserve the original lock persistence error.
        }
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new AgentHostAlreadyRunningError();
      }
      throw error;
    }
  }

  release(): void {
    if (this.descriptor === null) return;
    closeSync(this.descriptor);
    this.descriptor = null;
    try {
      unlinkSync(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export class FileAgentHostPortDiscovery implements AgentHostPortDiscovery {
  readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = join(dataDir, AGENT_HOST_PORT_FILENAME);
  }

  publish(record: AgentHostPortRecord): void {
    ensurePrivateDirectory(this.dataDir);
    writeFileSync(this.filePath, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    chmodSync(this.filePath, 0o600);
  }

  read(): AgentHostPortRecord | null {
    if (!existsSync(this.filePath)) return null;
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<AgentHostPortRecord>;
    if (
      parsed.version !== 1 ||
      !LOOPBACK_HOSTS.has(parsed.host as AgentHostLoopbackAddress) ||
      typeof parsed.port !== "number" ||
      !Number.isInteger(parsed.port) ||
      parsed.port < 1 ||
      parsed.port > 65_535 ||
      parsed.origin !== loopbackOrigin(parsed.host as AgentHostLoopbackAddress, parsed.port)
    ) {
      throw new Error("AgentHost port discovery file is malformed");
    }
    return {
      version: 1,
      host: parsed.host as AgentHostLoopbackAddress,
      port: parsed.port,
      origin: parsed.origin,
    };
  }

  clear(): void {
    try {
      unlinkSync(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export class AgentHost {
  private readonly host: AgentHostLoopbackAddress;
  private readonly port: number;
  private readonly bootstrapTokenTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  private readonly lock: AgentHostSingleInstanceLock;
  private readonly portDiscovery: AgentHostPortDiscovery;
  private readonly credentialStore: PendingDeviceCredentialStore;
  private readonly sessions = new Map<string, LocalSession>();
  private server: Server | null = null;
  private bound: BoundAgentHost | null = null;
  private bootstrapGrant: BootstrapGrant | null = null;
  private daemonState: AgentDaemonState = "stopped";
  private enrollmentState: AgentEnrollmentState;
  private daemonTransition: Promise<void> = Promise.resolve();

  constructor(private readonly options: AgentHostOptions) {
    this.host = options.host ?? "127.0.0.1";
    if (!LOOPBACK_HOSTS.has(this.host))
      throw new Error("AgentHost must use an IP-literal loopback");
    this.port = options.port ?? 0;
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65_535) {
      throw new Error("AgentHost port must be an integer from 0 through 65535");
    }
    this.bootstrapTokenTtlMs = options.bootstrapTokenTtlMs ?? DEFAULT_BOOTSTRAP_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (this.bootstrapTokenTtlMs <= 0 || this.sessionTtlMs <= 0) {
      throw new Error("AgentHost token lifetimes must be positive");
    }
    this.now = options.now ?? Date.now;
    this.lock = options.lock ?? new FileAgentHostSingleInstanceLock(options.dataDir);
    this.portDiscovery = options.portDiscovery ?? new FileAgentHostPortDiscovery(options.dataDir);
    this.credentialStore =
      options.credentialStore ?? new PendingDeviceCredentialStore(options.dataDir);
    this.enrollmentState = this.credentialStore.exists() ? "credential_prepared" : "not_enrolled";
  }

  get localPort(): number | null {
    return this.bound?.port ?? null;
  }

  get localOrigin(): string | null {
    return this.bound?.origin ?? null;
  }

  get enrollment(): AgentEnrollmentState {
    return this.enrollmentState;
  }

  get daemon(): AgentDaemonState {
    return this.daemonState;
  }

  setEnrollmentState(state: AgentEnrollmentState): void {
    this.enrollmentState = state;
  }

  async start(): Promise<AgentHostStartResult> {
    if (this.server) throw new Error("AgentHost has already started");
    this.lock.acquire();
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.port, this.host);
      });

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("AgentHost did not receive a TCP port");
      }
      const port = (address as AddressInfo).port;
      const origin = loopbackOrigin(this.host, port);
      this.bound = {
        version: 1,
        host: this.host,
        port,
        origin,
        expectedHostHeader: expectedHostHeader(this.host, port),
      };
      this.portDiscovery.publish(this.bound);
      return { ...this.publicRecord(), bootstrap_url: this.issueBootstrapUrl() };
    } catch (error) {
      this.server = null;
      this.bound = null;
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      try {
        this.portDiscovery.clear();
      } finally {
        this.lock.release();
      }
      throw error;
    }
  }

  issueBootstrapUrl(): string {
    const bound = this.requireBound();
    const token = randomBytes(32).toString("base64url");
    this.bootstrapGrant = {
      digest: sha256(token),
      expiresAt: this.now() + this.bootstrapTokenTtlMs,
    };
    return `${bound.origin}/#bootstrap=${encodeURIComponent(token)}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    try {
      if (this.daemonState !== "stopped") {
        await this.transitionDaemon("stop");
      }
    } finally {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      } finally {
        this.server = null;
        this.bound = null;
        this.bootstrapGrant = null;
        this.sessions.clear();
        try {
          this.portDiscovery.clear();
        } finally {
          this.lock.release();
        }
      }
    }
  }

  private publicRecord(): AgentHostPortRecord {
    const bound = this.requireBound();
    return {
      version: 1,
      host: bound.host,
      port: bound.port,
      origin: bound.origin,
    };
  }

  private requireBound(): BoundAgentHost {
    if (!this.bound) throw new Error("AgentHost has not started");
    return this.bound;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const bound = this.requireBound();
      if (request.headers.host !== bound.expectedHostHeader) {
        throw new AgentHostHttpError(403, "invalid loopback Host");
      }

      const requestOrigin = request.headers.origin;
      if (
        Array.isArray(requestOrigin) ||
        (requestOrigin !== undefined && requestOrigin !== bound.origin)
      ) {
        throw new AgentHostHttpError(403, "invalid loopback Origin");
      }
      if (request.method === "POST" && requestOrigin !== bound.origin) {
        throw new AgentHostHttpError(403, "exact loopback Origin is required");
      }

      const url = new URL(request.url ?? "/", bound.origin);
      if (url.search.length > 0) {
        throw new AgentHostHttpError(400, "query parameters are not accepted");
      }

      if (request.method === "GET") {
        await this.handleGet(url.pathname, request, response);
        return;
      }
      if (request.method === "POST") {
        await this.handlePost(url.pathname, request, response);
        return;
      }
      throw new AgentHostHttpError(405, "method not allowed");
    } catch (error) {
      const status = error instanceof AgentHostHttpError ? error.status : 500;
      const message =
        error instanceof AgentHostHttpError ? error.message : "local AgentHost request failed";
      if (!response.headersSent) sendJson(response, status, { error: message });
      else response.destroy();
    }
  }

  private async handleGet(
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    switch (path) {
      case "/":
        send(response, 200, "text/html; charset=utf-8", ENROLLMENT_HTML);
        return;
      case "/agent-host.css":
        send(response, 200, "text/css; charset=utf-8", ENROLLMENT_CSS);
        return;
      case "/agent-host.js":
        send(response, 200, "text/javascript; charset=utf-8", ENROLLMENT_JAVASCRIPT);
        return;
      case "/api/status":
        this.requireSession(request);
        sendJson(response, 200, this.statusBody());
        return;
      case "/api/session/bootstrap":
      case "/api/enrollment/prepare":
      case "/api/daemon/start":
      case "/api/daemon/stop":
        throw new AgentHostHttpError(405, "method not allowed");
      default:
        throw new AgentHostHttpError(404, "not found");
    }
  }

  private async handlePost(
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (path === "/api/session/bootstrap") {
      const body = await readJsonBody(request);
      const token = body.bootstrap_token;
      if (typeof token !== "string") {
        throw new AgentHostHttpError(400, "bootstrap_token is required");
      }
      const grant = this.bootstrapGrant;
      if (!grant || !secretMatches(token, grant.digest)) {
        throw new AgentHostHttpError(401, "invalid or consumed bootstrap token");
      }
      if (this.now() >= grant.expiresAt) {
        this.bootstrapGrant = null;
        throw new AgentHostHttpError(410, "bootstrap token expired");
      }
      this.bootstrapGrant = null;

      const sessionToken = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(32).toString("base64url");
      const sessionKey = sha256(sessionToken).toString("hex");
      this.sessions.set(sessionKey, {
        csrfDigest: sha256(csrfToken),
        expiresAt: this.now() + this.sessionTtlMs,
      });
      const maxAge = Math.max(1, Math.floor(this.sessionTtlMs / 1000));
      sendJson(
        response,
        200,
        { csrf_token: csrfToken },
        {
          "set-cookie": `${AGENT_HOST_SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
        },
      );
      return;
    }

    const session = this.requireSession(request);
    const csrfToken = request.headers[AGENT_HOST_CSRF_HEADER];
    if (typeof csrfToken !== "string" || !secretMatches(csrfToken, session.csrfDigest)) {
      throw new AgentHostHttpError(403, "valid CSRF token is required");
    }
    await readJsonBody(request);

    switch (path) {
      case "/api/enrollment/prepare": {
        const prepared = this.credentialStore.prepare();
        this.enrollmentState = "credential_prepared";
        sendJson(response, 200, this.preparedCredentialBody(prepared));
        return;
      }
      case "/api/daemon/start":
        await this.transitionDaemon("start");
        sendJson(response, 200, this.statusBody());
        return;
      case "/api/daemon/stop":
        await this.transitionDaemon("stop");
        sendJson(response, 200, this.statusBody());
        return;
      default:
        throw new AgentHostHttpError(404, "not found");
    }
  }

  private requireSession(request: IncomingMessage): LocalSession {
    const token = cookieValue(request.headers.cookie, AGENT_HOST_SESSION_COOKIE);
    if (!token) throw new AgentHostHttpError(401, "local UI session is required");
    const key = sha256(token).toString("hex");
    const session = this.sessions.get(key);
    if (!session) throw new AgentHostHttpError(401, "local UI session is invalid");
    if (this.now() >= session.expiresAt) {
      this.sessions.delete(key);
      throw new AgentHostHttpError(401, "local UI session expired");
    }
    return session;
  }

  private statusBody(): Record<string, unknown> {
    return {
      enrollment_state: this.enrollmentState,
      daemon_state: this.daemonState,
      credential_prepared: this.credentialStore.exists(),
    };
  }

  private preparedCredentialBody(
    prepared: PendingDeviceCredentialSummary,
  ): Record<string, unknown> {
    return {
      enrollment_state: this.enrollmentState,
      algorithm: prepared.algorithm,
      public_key_fingerprint: prepared.public_key_fingerprint,
      created_at: prepared.created_at,
    };
  }

  private transitionDaemon(action: "start" | "stop"): Promise<void> {
    const operation = this.daemonTransition.then(async () => {
      if (action === "start") {
        if (this.daemonState === "running") return;
        this.daemonState = "starting";
        try {
          await this.options.daemon.start();
          this.daemonState = "running";
        } catch (error) {
          this.daemonState = "failed";
          throw error;
        }
        return;
      }

      if (this.daemonState === "stopped") return;
      this.daemonState = "stopping";
      try {
        await this.options.daemon.stop();
        this.daemonState = "stopped";
      } catch (error) {
        this.daemonState = "failed";
        throw error;
      }
    });
    this.daemonTransition = operation.catch(() => undefined);
    return operation;
  }
}

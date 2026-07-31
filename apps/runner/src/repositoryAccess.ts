import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DEVICE_REPOSITORY_REGISTRATION_HTTP_SIGNATURE_PURPOSE,
  DEVICE_REPOSITORY_REGISTRATION_REVOCATION_HTTP_SIGNATURE_PURPOSE,
  DeviceRepositoryRegistrationRequest,
  type DeviceRepositoryRegistrationRequestT,
  DeviceRepositoryRegistrationResponse,
  type DeviceRepositoryRegistrationResponseT,
  DeviceRepositoryRegistrationRevocationRequest,
  DeviceRepositoryRegistrationRevocationResponse,
} from "@norns/contracts";
import { type DeviceRunnerHttpIdentity, signRunnerHttpRequest } from "./contextAuth.js";
import { ActiveDeviceIdentityStore } from "./deviceInstallationIdentity.js";
import type { PendingDeviceCredentialStore } from "./pendingDeviceCredential.js";
import type { LocalRepositoryApproval, WorkspaceRegistry } from "./workspaceRegistry.js";

export const LOCAL_REPOSITORY_ACCESS_FILENAME = "repository-access.json";

export type CloudRepositoryIdentity = DeviceRepositoryRegistrationRequestT;
export type DeviceRepositoryRegistration = DeviceRepositoryRegistrationResponseT;

export interface DeviceRepositoryRegistrationClient {
  register(identity: CloudRepositoryIdentity): Promise<DeviceRepositoryRegistration>;
  revoke(input: {
    registration_id: string;
    workspace_id: string;
    repository_id: string;
  }): Promise<{ registration_id: string; status: "revoked" }>;
}

export type LocalRepositorySyncState = "pending_registration" | "active" | "revocation_pending";

interface RepositoryAccessRecord extends CloudRepositoryIdentity {
  registration_id: string | null;
  sync_state: LocalRepositorySyncState;
  approved_at: string;
}

export interface RepositoryAccessHistory {
  event_id: string;
  workspace_id: string;
  repository_id: string;
  repository_display_name: string;
  action: "approved" | "revoked";
  occurred_at: string;
  server_sync: "complete" | "pending";
}

interface PersistedRepositoryAccess {
  version: 1;
  records: RepositoryAccessRecord[];
  history: RepositoryAccessHistory[];
}

export interface LocalRepositoryAccessView extends CloudRepositoryIdentity {
  local_path: string;
  git_status: "clean" | "modified";
  registration_id: string | null;
  sync_state: "pending_registration" | "active";
  approved_at: string;
  project_grants: readonly [];
}

export interface LocalRepositoryRemovalResult {
  workspace_id: string;
  repository_id: string;
  local_access_removed: true;
  server_sync: "complete" | "pending";
}

const MAX_HISTORY_RECORDS = 200;

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validAccessRecord(value: unknown): value is RepositoryAccessRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    exactObjectKeys(record, [
      "workspace_id",
      "repository_id",
      "repository_display_name",
      "default_branch",
      "observed_head",
      "registration_id",
      "sync_state",
      "approved_at",
    ]) &&
    DeviceRepositoryRegistrationRequest.safeParse({
      workspace_id: record.workspace_id,
      repository_id: record.repository_id,
      repository_display_name: record.repository_display_name,
      default_branch: record.default_branch,
      observed_head: record.observed_head,
    }).success &&
    (record.registration_id === null ||
      (typeof record.registration_id === "string" && record.registration_id.length > 0)) &&
    (record.sync_state === "pending_registration" ||
      record.sync_state === "active" ||
      record.sync_state === "revocation_pending") &&
    (record.sync_state === "active"
      ? typeof record.registration_id === "string"
      : record.sync_state === "pending_registration"
        ? record.registration_id === null
        : true) &&
    validIsoDate(record.approved_at)
  );
}

function validHistoryRecord(value: unknown): value is RepositoryAccessHistory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    exactObjectKeys(record, [
      "event_id",
      "workspace_id",
      "repository_id",
      "repository_display_name",
      "action",
      "occurred_at",
      "server_sync",
    ]) &&
    typeof record.event_id === "string" &&
    record.event_id.length > 0 &&
    typeof record.workspace_id === "string" &&
    record.workspace_id.length > 0 &&
    typeof record.repository_id === "string" &&
    record.repository_id.length > 0 &&
    typeof record.repository_display_name === "string" &&
    record.repository_display_name.length > 0 &&
    (record.action === "approved" || record.action === "revoked") &&
    validIsoDate(record.occurred_at) &&
    (record.server_sync === "complete" || record.server_sync === "pending")
  );
}

function privateDirectory(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}

function cloudIdentity(repository: LocalRepositoryApproval): CloudRepositoryIdentity {
  return {
    workspace_id: repository.workspace_id,
    repository_id: repository.repository_id,
    repository_display_name: repository.repository_display_name,
    default_branch: repository.default_branch,
    observed_head: repository.observed_head,
  };
}

function serverOrigin(value: string): string {
  const url = new URL(value);
  const local =
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !local) {
    throw new Error("device repository registration server must use HTTPS");
  }
  if (
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("device repository registration server must be an origin");
  }
  return url.origin;
}

function routedId(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,499}$/.test(value)) {
    throw new Error(`${name} is not a valid opaque identifier`);
  }
  return encodeURIComponent(value);
}

/**
 * Cloud registration transport for an already-active device identity.
 *
 * The request body is built only from opaque IDs and safe Git metadata. The
 * device, active credential, and current generation are bound by the shared
 * hardened transcript and never duplicated as caller-controlled body fields.
 */
export class SignedDeviceRepositoryRegistrationClient
  implements DeviceRepositoryRegistrationClient
{
  private readonly origin: string;

  constructor(
    server: string,
    private readonly identity: DeviceRunnerHttpIdentity,
    private readonly httpFetch: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly newRequestId: () => string = randomUUID,
    private readonly timeoutMs = 10_000,
  ) {
    this.origin = serverOrigin(server);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("device repository registration timeout must be positive");
    }
  }

  async register(identity: CloudRepositoryIdentity): Promise<DeviceRepositoryRegistration> {
    const request = DeviceRepositoryRegistrationRequest.parse(identity);
    const url = new URL("/api/device-repository-registrations", this.origin);
    const body = JSON.stringify(request);
    const signed = signRunnerHttpRequest({
      identity: this.identity,
      purpose: DEVICE_REPOSITORY_REGISTRATION_HTTP_SIGNATURE_PURPOSE,
      method: "POST",
      url,
      body,
      timestamp: this.now().toISOString(),
      requestId: this.newRequestId(),
    });
    const response = await this.httpFetch(url, {
      method: "POST",
      redirect: "error",
      headers: { ...signed.headers, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`device repository registration failed with ${response.status}`);
    }
    const value = DeviceRepositoryRegistrationResponse.parse(await response.json());
    if (
      value.workspace_id !== request.workspace_id ||
      value.repository_id !== request.repository_id
    ) {
      throw new Error("device repository registration response did not match the request");
    }
    return value;
  }

  async revoke(input: {
    registration_id: string;
    workspace_id: string;
    repository_id: string;
  }): Promise<{ registration_id: string; status: "revoked" }> {
    const registrationId = routedId(input.registration_id, "registration_id");
    const url = new URL(
      `/api/device-repository-registrations/${registrationId}/revoke`,
      this.origin,
    );
    const body = JSON.stringify(
      DeviceRepositoryRegistrationRevocationRequest.parse({
        workspace_id: input.workspace_id,
        repository_id: input.repository_id,
      }),
    );
    const signed = signRunnerHttpRequest({
      identity: this.identity,
      purpose: DEVICE_REPOSITORY_REGISTRATION_REVOCATION_HTTP_SIGNATURE_PURPOSE,
      method: "POST",
      url,
      body,
      timestamp: this.now().toISOString(),
      requestId: this.newRequestId(),
    });
    const response = await this.httpFetch(url, {
      method: "POST",
      redirect: "error",
      headers: { ...signed.headers, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`device repository revocation failed with ${response.status}`);
    }
    const value = DeviceRepositoryRegistrationRevocationResponse.parse(await response.json());
    if (value.registration_id !== input.registration_id) {
      throw new Error("device repository revocation response did not match the request");
    }
    return value;
  }
}

/**
 * Resolves the active device identity at the moment each registration is sent.
 *
 * AgentHost exists before enrollment is complete, so caching an identity in
 * its constructor would either fail startup or require a restart after
 * approval. Looking up the durable activation record for each operation keeps
 * pre-enrollment approvals pending and lets the same process synchronize them
 * immediately after successful redemption.
 */
export class ActiveDeviceRepositoryRegistrationClient
  implements DeviceRepositoryRegistrationClient
{
  private readonly activeIdentity: ActiveDeviceIdentityStore;

  constructor(
    private readonly server: string,
    dataDir: string,
    private readonly credentialStore: PendingDeviceCredentialStore,
    private readonly httpFetch: typeof fetch = fetch,
  ) {
    this.activeIdentity = new ActiveDeviceIdentityStore(dataDir);
  }

  async register(identity: CloudRepositoryIdentity): Promise<DeviceRepositoryRegistration> {
    return await this.client().register(identity);
  }

  async revoke(input: {
    registration_id: string;
    workspace_id: string;
    repository_id: string;
  }): Promise<{ registration_id: string; status: "revoked" }> {
    return await this.client().revoke(input);
  }

  private client(): SignedDeviceRepositoryRegistrationClient {
    const active = this.activeIdentity.read();
    if (!active) {
      throw new Error("device enrollment is not active");
    }
    if (!this.credentialStore.read()) {
      throw new Error("active device credential is unavailable");
    }
    return new SignedDeviceRepositoryRegistrationClient(
      this.server,
      {
        mode: "device",
        deviceId: active.device_id,
        credentialId: active.credential_id,
        generation: active.generation,
        sign: (payload) => this.credentialStore.sign(payload),
      },
      this.httpFetch,
    );
  }
}

/**
 * Local approval boundary used by AgentHost.
 *
 * Local removal is authoritative and happens before best-effort cloud sync,
 * so an offline server can never keep the repository usable on this agent.
 * A pending tombstone preserves the server revocation for later reconciliation.
 */
export class LocalRepositoryAccessController {
  private readonly file: string;
  private readonly dataDir: string;
  private state: PersistedRepositoryAccess;
  private synchronization: Promise<void> | null = null;
  private mutationTransition: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly workspaces: WorkspaceRegistry,
    private readonly registrations?: DeviceRepositoryRegistrationClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    privateDirectory(dataDir);
    this.dataDir = dataDir;
    this.file = join(dataDir, LOCAL_REPOSITORY_ACCESS_FILENAME);
    this.state = this.readOrEmpty();
    this.reconcileLocalRegistry();
    this.persist();
  }

  list(): readonly LocalRepositoryAccessView[] {
    this.reload();
    const records = new Map(
      this.state.records.map((record) => [
        this.repositoryKey(record.workspace_id, record.repository_id),
        record,
      ]),
    );
    return this.workspaces.listLocalRepositoryApprovals().map((repository) => {
      const record = records.get(
        this.repositoryKey(repository.workspace_id, repository.repository_id),
      );
      const identity = cloudIdentity(repository);
      return {
        ...identity,
        local_path: repository.local_path,
        git_status: repository.git_status,
        registration_id: record?.registration_id ?? null,
        sync_state: record?.sync_state === "active" ? "active" : "pending_registration",
        approved_at: record?.approved_at ?? this.now().toISOString(),
        project_grants: [],
      };
    });
  }

  count(): number {
    return this.workspaces.approvedRepositoryCount();
  }

  history(): readonly RepositoryAccessHistory[] {
    this.reload();
    return this.state.history.map((entry) => ({ ...entry }));
  }

  choose(): Promise<LocalRepositoryAccessView | null> {
    return this.withMutation(() => this.chooseRepository());
  }

  private async chooseRepository(): Promise<LocalRepositoryAccessView | null> {
    const repository = await this.workspaces.chooseLocalRepository();
    if (!repository) return null;
    return this.approveRepository(repository);
  }

  /**
   * Approve a repository created through the authenticated workspace channel.
   * This uses the same local/cloud registration boundary as the Control
   * Center's manual picker without asking for the freshly cloned folder twice.
   */
  approve(repository: CloudRepositoryIdentity): Promise<LocalRepositoryAccessView> {
    return this.withMutation(() => {
      const local = this.workspaces
        .listLocalRepositoryApprovals()
        .find(
          (candidate) =>
            candidate.workspace_id === repository.workspace_id &&
            candidate.repository_id === repository.repository_id &&
            candidate.repository_display_name === repository.repository_display_name &&
            candidate.default_branch === repository.default_branch &&
            candidate.observed_head === repository.observed_head,
        );
      if (!local) throw new Error("workspace repository is no longer approved");
      return this.approveRepository(local);
    });
  }

  private async approveRepository(
    repository: LocalRepositoryApproval,
  ): Promise<LocalRepositoryAccessView> {
    this.reload();
    const identity = cloudIdentity(repository);
    const existing = this.state.records.find(
      (record) =>
        record.workspace_id === repository.workspace_id &&
        record.repository_id === repository.repository_id,
    );
    const record: RepositoryAccessRecord = {
      ...identity,
      registration_id: existing?.registration_id ?? null,
      sync_state: existing?.registration_id ? "active" : "pending_registration",
      approved_at: existing?.approved_at ?? this.now().toISOString(),
    };
    this.upsert(record);
    if (
      !this.state.history.some(
        (entry) =>
          entry.workspace_id === record.workspace_id &&
          entry.repository_id === record.repository_id &&
          entry.action === "approved",
      )
    ) {
      this.recordHistory({
        workspace_id: record.workspace_id,
        repository_id: record.repository_id,
        repository_display_name: record.repository_display_name,
        action: "approved",
        server_sync: "pending",
      });
    }
    this.persist();

    if (this.registrations) {
      try {
        const registration = await this.registrations.register(identity);
        record.registration_id = registration.registration_id;
        record.sync_state = "active";
        this.upsert(record);
        this.markLatestHistorySynced(record.workspace_id, record.repository_id, "approved");
        this.persist();
      } catch {
        // The local choice remains explicit and visible but cannot become a
        // project target until this business-idempotent operation succeeds.
      }
    }
    return {
      ...identity,
      local_path: repository.local_path,
      git_status: repository.git_status,
      registration_id: record.registration_id,
      sync_state: record.sync_state === "active" ? "active" : "pending_registration",
      approved_at: record.approved_at,
      project_grants: [],
    };
  }

  remove(input: {
    workspace_id: string;
    repository_id: string;
  }): Promise<LocalRepositoryRemovalResult | null> {
    return this.withMutation(() => this.removeRepository(input));
  }

  private async removeRepository(input: {
    workspace_id: string;
    repository_id: string;
  }): Promise<LocalRepositoryRemovalResult | null> {
    this.reload();
    let record = this.state.records.find(
      (entry) =>
        entry.workspace_id === input.workspace_id && entry.repository_id === input.repository_id,
    );
    if (!record) {
      const local = this.workspaces
        .listLocalRepositoryApprovals()
        .find(
          (entry) =>
            entry.workspace_id === input.workspace_id &&
            entry.repository_id === input.repository_id,
        );
      if (!local) return null;
      record = {
        ...cloudIdentity(local),
        registration_id: null,
        sync_state: "revocation_pending",
        approved_at: this.now().toISOString(),
      };
    }

    const at = this.now().toISOString();
    // Persist the revocation tombstone before changing the local registry. A
    // crash after this write is recovered by reconcileLocalRegistry(), which
    // removes local access first and retains any required server revocation.
    record.sync_state = "revocation_pending";
    this.upsert(record);
    this.recordHistory({
      workspace_id: record.workspace_id,
      repository_id: record.repository_id,
      repository_display_name: record.repository_display_name,
      action: "revoked",
      server_sync: record.registration_id ? "pending" : "complete",
      occurred_at: at,
    });
    this.persist();
    this.workspaces.removeRepositoryAccess(record.workspace_id, record.repository_id);

    if (record.registration_id && this.registrations) {
      try {
        await this.registrations.revoke({
          registration_id: record.registration_id,
          workspace_id: record.workspace_id,
          repository_id: record.repository_id,
        });
        this.state.records = this.state.records.filter(
          (entry) =>
            entry.workspace_id !== record.workspace_id ||
            entry.repository_id !== record.repository_id,
        );
        this.markLatestHistorySynced(record.workspace_id, record.repository_id, "revoked");
        this.persist();
        return {
          workspace_id: input.workspace_id,
          repository_id: input.repository_id,
          local_access_removed: true,
          server_sync: "complete",
        };
      } catch {
        // The local access removal is already durable. Keep the cloud
        // revocation tombstone without persisting a possibly path-bearing error.
      }
    } else if (!record.registration_id) {
      this.state.records = this.state.records.filter(
        (entry) =>
          entry.workspace_id !== record.workspace_id ||
          entry.repository_id !== record.repository_id,
      );
      this.markLatestHistorySynced(record.workspace_id, record.repository_id, "revoked");
      this.persist();
      return {
        workspace_id: input.workspace_id,
        repository_id: input.repository_id,
        local_access_removed: true,
        server_sync: "complete",
      };
    }

    return {
      workspace_id: input.workspace_id,
      repository_id: input.repository_id,
      local_access_removed: true,
      server_sync: "pending",
    };
  }

  synchronize(): Promise<void> {
    if (this.synchronization) return this.synchronization;
    const operation = this.withMutation(() => this.runSynchronization());
    this.synchronization = operation;
    const clear = () => {
      if (this.synchronization === operation) this.synchronization = null;
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async runSynchronization(): Promise<void> {
    if (!this.registrations) return;
    this.reload();
    for (const record of [...this.state.records]) {
      if (record.sync_state === "revocation_pending" && record.registration_id) {
        try {
          await this.registrations.revoke({
            registration_id: record.registration_id,
            workspace_id: record.workspace_id,
            repository_id: record.repository_id,
          });
          this.state.records = this.state.records.filter(
            (entry) =>
              entry.workspace_id !== record.workspace_id ||
              entry.repository_id !== record.repository_id,
          );
          this.markLatestHistorySynced(record.workspace_id, record.repository_id, "revoked");
          this.persist();
        } catch {
          // A later reconnect retries with a fresh transport request_id.
        }
        continue;
      }
      if (record.sync_state === "pending_registration") {
        const local = this.workspaces
          .listLocalRepositoryApprovals()
          .find(
            (entry) =>
              entry.workspace_id === record.workspace_id &&
              entry.repository_id === record.repository_id,
          );
        if (!local) continue;
        try {
          const registration = await this.registrations.register(cloudIdentity(local));
          record.registration_id = registration.registration_id;
          record.sync_state = "active";
          this.upsert(record);
          this.markLatestHistorySynced(record.workspace_id, record.repository_id, "approved");
          this.persist();
        } catch {
          // Reconciliation is deliberately fail-closed and retryable.
        }
      }
    }
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTransition.then(operation, operation);
    this.mutationTransition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private upsert(record: RepositoryAccessRecord): void {
    const index = this.state.records.findIndex(
      (entry) =>
        entry.workspace_id === record.workspace_id && entry.repository_id === record.repository_id,
    );
    if (index === -1) this.state.records.push(record);
    else this.state.records[index] = record;
  }

  private recordHistory(
    input: Omit<RepositoryAccessHistory, "event_id" | "occurred_at"> & {
      occurred_at?: string;
    },
  ): void {
    this.state.history.push({
      event_id: `local:${randomUUID().replaceAll("-", "")}`,
      occurred_at: input.occurred_at ?? this.now().toISOString(),
      workspace_id: input.workspace_id,
      repository_id: input.repository_id,
      repository_display_name: input.repository_display_name,
      action: input.action,
      server_sync: input.server_sync,
    });
    if (this.state.history.length > MAX_HISTORY_RECORDS) {
      this.state.history = this.state.history.slice(-MAX_HISTORY_RECORDS);
    }
  }

  private markLatestHistorySynced(
    workspaceId: string,
    repositoryId: string,
    action: RepositoryAccessHistory["action"],
  ): void {
    for (let index = this.state.history.length - 1; index >= 0; index -= 1) {
      const entry = this.state.history[index];
      if (
        entry?.workspace_id === workspaceId &&
        entry.repository_id === repositoryId &&
        entry.action === action
      ) {
        entry.server_sync = "complete";
        return;
      }
    }
  }

  private reconcileLocalRegistry(): void {
    for (const tombstone of this.state.records.filter(
      (record) => record.sync_state === "revocation_pending",
    )) {
      this.workspaces.removeRepositoryAccess(tombstone.workspace_id, tombstone.repository_id);
      if (tombstone.registration_id === null) {
        this.state.records = this.state.records.filter(
          (record) =>
            record.workspace_id !== tombstone.workspace_id ||
            record.repository_id !== tombstone.repository_id,
        );
        this.markLatestHistorySynced(tombstone.workspace_id, tombstone.repository_id, "revoked");
      }
    }
    const approved = new Map(
      this.workspaces
        .listLocalRepositoryApprovals()
        .map((repository) => [
          this.repositoryKey(repository.workspace_id, repository.repository_id),
          repository,
        ]),
    );
    for (const repository of approved.values()) {
      if (
        this.state.records.some(
          (record) =>
            record.workspace_id === repository.workspace_id &&
            record.repository_id === repository.repository_id,
        )
      ) {
        continue;
      }
      this.state.records.push({
        ...cloudIdentity(repository),
        registration_id: null,
        sync_state: "pending_registration",
        approved_at: this.now().toISOString(),
      });
    }
    this.state.records = this.state.records.filter(
      (record) =>
        record.sync_state === "revocation_pending" ||
        approved.has(this.repositoryKey(record.workspace_id, record.repository_id)),
    );
  }

  private repositoryKey(workspaceId: string, repositoryId: string): string {
    return `${workspaceId}\u0000${repositoryId}`;
  }

  private readOrEmpty(): PersistedRepositoryAccess {
    if (!existsSync(this.file)) return { version: 1, records: [], history: [] };
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("state must be an object");
      }
      const candidate = value as Record<string, unknown>;
      if (
        !exactObjectKeys(candidate, ["version", "records", "history"]) ||
        candidate.version !== 1 ||
        !Array.isArray(candidate.records) ||
        !candidate.records.every(validAccessRecord) ||
        !Array.isArray(candidate.history) ||
        candidate.history.length > MAX_HISTORY_RECORDS ||
        !candidate.history.every(validHistoryRecord)
      ) {
        throw new Error("state fields are invalid");
      }
      return candidate as unknown as PersistedRepositoryAccess;
    } catch (error) {
      throw new Error("local repository access state is malformed", { cause: error });
    }
  }

  private reload(): void {
    this.state = this.readOrEmpty();
    this.reconcileLocalRegistry();
  }

  private persist(): void {
    privateDirectory(this.dataDir);
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(this.state), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.file);
      chmodSync(this.file, 0o600);
      const directory = openSync(this.dataDir, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
  }
}

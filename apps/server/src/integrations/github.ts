import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createSign,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

export interface GitHubIntegrationEnvironment {
  NORNS_GITHUB_APP_ID?: string;
  NORNS_GITHUB_CLIENT_ID?: string;
  NORNS_GITHUB_CLIENT_SECRET?: string;
  NORNS_GITHUB_APP_SLUG?: string;
  NORNS_GITHUB_PRIVATE_KEY?: string;
  NORNS_GITHUB_STATE_SECRET?: string;
  NORNS_GITHUB_TOKEN_ENCRYPTION_KEY?: string;
}

export interface GitHubIntegrationConfig {
  appId: string;
  clientId: string;
  clientSecret: string;
  appSlug: string;
  privateKey: string;
  stateSecret: string;
  tokenEncryptionKey: Uint8Array;
  publicOrigin: string;
}

export interface GitHubManifestBootstrapKey {
  keyId: string;
  key: Uint8Array;
}

export interface GitHubManifestBootstrap {
  publicOrigin: string;
  currentKey: GitHubManifestBootstrapKey;
  keys: ReadonlyMap<string, GitHubManifestBootstrapKey>;
}

export interface GitHubManifestRegistration {
  action: string;
  manifest: string;
  state: string;
}

export interface GitHubConnectionSummary {
  id: string;
  provider: "github";
  display_name: string;
  owner_type: "user" | "organization";
  owner_login: string;
  installation_id: string;
  repository_selection: "all" | "selected";
  status: "connected" | "action_required" | "disconnected";
  last_validated_at: string | null;
}

export interface GitHubRepositorySummary {
  id: string;
  connection_id: string;
  owner: string;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  clone_url: string;
  description: string | null;
  language: string | null;
  archived: boolean;
  updated_at: string;
}

export interface GitHubIntegrationStatus {
  configured: boolean;
  setup_available: boolean;
  configuration_source: "environment" | "manifest" | null;
  user_authorization: {
    connected: boolean;
    login: string | null;
  };
  connections: GitHubConnectionSummary[];
}

interface AuthorizationRow {
  user_id: string;
  github_user_id: string;
  github_login: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string | null;
  access_token_expires_at: Date | string | null;
  refresh_token_expires_at: Date | string | null;
}

interface ConnectionRow {
  id: string;
  provider: "github";
  display_name: string;
  status: GitHubConnectionSummary["status"];
  owner_type: GitHubConnectionSummary["owner_type"];
  owner_login: string;
  installation_id: string;
  repository_selection: GitHubConnectionSummary["repository_selection"];
  last_validated_at: Date | string | null;
}

interface GitHubUser {
  id: number;
  login: string;
}

interface GitHubInstallation {
  id: number;
  account: { id: number; login: string; type: "User" | "Organization" };
  repository_selection: "all" | "selected";
}

interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string | null;
  html_url: string;
  clone_url: string;
  description: string | null;
  language: string | null;
  archived: boolean;
  updated_at: string;
  owner: { login: string };
}

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

interface StoredAppConfigurationRow {
  key_id: string;
  app_id: string;
  client_id: string;
  app_slug: string;
  credentials_ciphertext: string;
}

interface StoredAppSecrets {
  client_secret: string;
  private_key: string;
  webhook_secret: string | null;
}

interface GitHubManifestConversion {
  id?: number;
  slug?: string;
  client_id?: string;
  client_secret?: string;
  pem?: string;
  webhook_secret?: string | null;
  message?: string;
}

const GITHUB_API_VERSION = "2022-11-28";
const API_BASE = "https://api.github.com";

function derivedKey(key: Uint8Array, purpose: "configuration" | "state" | "tokens"): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(key),
      Buffer.from("TheNorns GitHub integration", "utf8"),
      Buffer.from(`github:${purpose}:v1`, "utf8"),
      32,
    ),
  );
}

function required(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new Error(`${name} is required when GitHub integration is configured`);
  return value.trim();
}

export function githubIntegrationConfigFromEnvironment(
  environment: GitHubIntegrationEnvironment,
  publicOrigin: string,
): GitHubIntegrationConfig | null {
  const values = [
    environment.NORNS_GITHUB_APP_ID,
    environment.NORNS_GITHUB_CLIENT_ID,
    environment.NORNS_GITHUB_CLIENT_SECRET,
    environment.NORNS_GITHUB_APP_SLUG,
    environment.NORNS_GITHUB_PRIVATE_KEY,
    environment.NORNS_GITHUB_STATE_SECRET,
    environment.NORNS_GITHUB_TOKEN_ENCRYPTION_KEY,
  ];
  if (values.every((value) => !value?.trim())) return null;

  const encryptionKey = Buffer.from(
    required("NORNS_GITHUB_TOKEN_ENCRYPTION_KEY", environment.NORNS_GITHUB_TOKEN_ENCRYPTION_KEY),
    "base64",
  );
  if (encryptionKey.length !== 32) {
    throw new Error("NORNS_GITHUB_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  const stateSecret = required("NORNS_GITHUB_STATE_SECRET", environment.NORNS_GITHUB_STATE_SECRET);
  if (Buffer.byteLength(stateSecret) < 32) {
    throw new Error("NORNS_GITHUB_STATE_SECRET must contain at least 32 bytes");
  }

  return {
    appId: required("NORNS_GITHUB_APP_ID", environment.NORNS_GITHUB_APP_ID),
    clientId: required("NORNS_GITHUB_CLIENT_ID", environment.NORNS_GITHUB_CLIENT_ID),
    clientSecret: required("NORNS_GITHUB_CLIENT_SECRET", environment.NORNS_GITHUB_CLIENT_SECRET),
    appSlug: required("NORNS_GITHUB_APP_SLUG", environment.NORNS_GITHUB_APP_SLUG),
    privateKey: required(
      "NORNS_GITHUB_PRIVATE_KEY",
      environment.NORNS_GITHUB_PRIVATE_KEY,
    ).replaceAll("\\n", "\n"),
    stateSecret,
    tokenEncryptionKey: encryptionKey,
    publicOrigin: publicOrigin.replace(/\/$/, ""),
  };
}

export class GitHubIntegrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "GitHubIntegrationError";
  }
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

type GitHubStatePurpose = "authorize" | "install" | "manifest";

interface GitHubStateContext {
  userId: string;
  next: "install" | null;
}

function statePayload(
  userId: string,
  purpose: GitHubStatePurpose,
  next: "install" | null = null,
): string {
  return base64Url(
    JSON.stringify({
      user_id: userId,
      purpose,
      next,
      nonce: randomBytes(16).toString("hex"),
      expires_at: Date.now() + 10 * 60_000,
    }),
  );
}

function signState(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function createState(
  userId: string,
  purpose: GitHubStatePurpose,
  secret: string,
  next: "install" | null = null,
): string {
  const payload = statePayload(userId, purpose, next);
  return `${payload}.${signState(payload, secret)}`;
}

function stateContext(
  state: string,
  purpose: GitHubStatePurpose,
  secret: string,
): GitHubStateContext {
  const [payload, suppliedSignature, extra] = state.split(".");
  if (!payload || !suppliedSignature || extra) {
    throw new GitHubIntegrationError(
      "invalid_oauth_state",
      "GitHub authorization state is invalid",
      400,
    );
  }
  const expected = Buffer.from(signState(payload, secret));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new GitHubIntegrationError(
      "invalid_oauth_state",
      "GitHub authorization state is invalid",
      400,
    );
  }
  let parsed: { user_id?: string; purpose?: string; expires_at?: number; next?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof parsed;
  } catch {
    throw new GitHubIntegrationError(
      "invalid_oauth_state",
      "GitHub authorization state is invalid",
      400,
    );
  }
  if (
    typeof parsed.user_id !== "string" ||
    parsed.purpose !== purpose ||
    typeof parsed.expires_at !== "number" ||
    parsed.expires_at < Date.now()
  ) {
    throw new GitHubIntegrationError(
      "invalid_oauth_state",
      "GitHub authorization state expired",
      400,
    );
  }
  if (parsed.next !== undefined && parsed.next !== null && parsed.next !== "install") {
    throw new GitHubIntegrationError(
      "invalid_oauth_state",
      "GitHub authorization state is invalid",
      400,
    );
  }
  return { userId: parsed.user_id, next: parsed.next === "install" ? "install" : null };
}

function verifyState(
  state: string,
  userId: string,
  purpose: GitHubStatePurpose,
  secret: string,
): GitHubStateContext {
  const context = stateContext(state, purpose, secret);
  if (context.userId !== userId) {
    throw new GitHubIntegrationError(
      "invalid_oauth_state",
      "GitHub authorization state is invalid",
      400,
    );
  }
  return context;
}

class TokenCipher {
  constructor(private readonly key: Uint8Array) {}

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
  }

  decrypt(value: string): string {
    const [version, iv, tag, ciphertext, extra] = value.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext || extra) {
      throw new GitHubIntegrationError(
        "credential_unavailable",
        "Stored GitHub authorization is invalid",
        500,
      );
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new GitHubIntegrationError(
        "credential_unavailable",
        "Stored GitHub authorization could not be decrypted",
        500,
      );
    }
  }
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function connectionSummary(row: ConnectionRow): GitHubConnectionSummary {
  return {
    id: row.id,
    provider: row.provider,
    display_name: row.display_name,
    owner_type: row.owner_type,
    owner_login: row.owner_login,
    installation_id: row.installation_id,
    repository_selection: row.repository_selection,
    status: row.status,
    last_validated_at: iso(row.last_validated_at),
  };
}

function repositorySummary(
  connectionId: string,
  repository: GitHubRepository,
): GitHubRepositorySummary {
  return {
    id: String(repository.id),
    connection_id: connectionId,
    owner: repository.owner.login,
    name: repository.name,
    full_name: repository.full_name,
    private: repository.private,
    default_branch: repository.default_branch ?? "main",
    html_url: repository.html_url,
    clone_url: repository.clone_url,
    description: repository.description,
    language: repository.language,
    archived: repository.archived,
    updated_at: repository.updated_at,
  };
}

export type GitHubFetch = typeof fetch;

export class GitHubIntegrationService {
  private config: GitHubIntegrationConfig | null;
  private cipher: TokenCipher | null;
  private configurationSource: "environment" | "manifest" | null;

  constructor(
    private readonly transactions: V2TransactionRunner,
    config: GitHubIntegrationConfig | null,
    private readonly http: GitHubFetch = fetch,
    private readonly manifestBootstrap: GitHubManifestBootstrap | null = null,
  ) {
    this.config = config;
    this.cipher = config ? new TokenCipher(config.tokenEncryptionKey) : null;
    this.configurationSource = config ? "environment" : null;
  }

  async loadStoredConfiguration(): Promise<void> {
    if (this.config || !this.manifestBootstrap) return;
    const row = await this.transactions.transaction(async (tx) => {
      return (
        await tx.query<StoredAppConfigurationRow>(
          `SELECT key_id, app_id, client_id, app_slug, credentials_ciphertext
           FROM github_app_configurations
           WHERE id = 'primary'`,
        )
      ).rows[0];
    });
    if (!row) return;
    const key = this.manifestBootstrap.keys.get(row.key_id);
    if (!key) {
      throw new GitHubIntegrationError(
        "github_configuration_key_unavailable",
        `Stored GitHub configuration requires unavailable credential key ${row.key_id}`,
        500,
      );
    }
    const secrets = this.parseStoredSecrets(
      new TokenCipher(derivedKey(key.key, "configuration")).decrypt(row.credentials_ciphertext),
    );
    this.activateManifestConfiguration(row, secrets, key.key);
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  setupAvailable(): boolean {
    return this.config === null && this.manifestBootstrap !== null;
  }

  manifestRegistration(userId: string, organization?: string): GitHubManifestRegistration {
    if (!this.manifestBootstrap) {
      throw new GitHubIntegrationError(
        "github_manifest_unavailable",
        "Guided GitHub setup requires durable relational identity credentials",
        503,
      );
    }
    if (this.config) {
      throw new GitHubIntegrationError(
        "github_already_configured",
        "GitHub App is already configured",
      );
    }
    const normalizedOrganization = organization?.trim();
    if (
      normalizedOrganization &&
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(normalizedOrganization)
    ) {
      throw new GitHubIntegrationError(
        "invalid_github_organization",
        "GitHub organization names may contain letters, numbers, and single hyphens",
        400,
      );
    }
    const origin = this.manifestBootstrap.publicOrigin.replace(/\/$/, "");
    const hostLabel =
      new URL(origin).hostname.split(".")[0]?.replace(/[^A-Za-z0-9-]/g, "-") || "workspace";
    const name = `The Norns ${hostLabel} ${randomBytes(3).toString("hex")}`.slice(0, 34);
    const manifest = {
      name,
      url: origin,
      description: "AI project coordination and repository execution for The Norns",
      redirect_url: `${origin}/api/integrations/github/manifest/callback`,
      callback_urls: [`${origin}/api/integrations/github/callback`],
      setup_url: `${origin}/api/integrations/github/setup`,
      public: false,
      request_oauth_on_install: false,
      setup_on_update: true,
      default_permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        administration: "write",
      },
      default_events: [],
    };
    const action = normalizedOrganization
      ? `https://github.com/organizations/${encodeURIComponent(normalizedOrganization)}/settings/apps/new`
      : "https://github.com/settings/apps/new";
    const stateSecret = derivedKey(this.manifestBootstrap.currentKey.key, "state").toString(
      "base64url",
    );
    return {
      action,
      manifest: JSON.stringify(manifest),
      state: createState(userId, "manifest", stateSecret),
    };
  }

  manifestUserId(state: string): string {
    const bootstrap = this.requireManifestBootstrap();
    return stateContext(
      state,
      "manifest",
      derivedKey(bootstrap.currentKey.key, "state").toString("base64url"),
    ).userId;
  }

  async completeManifest(userId: string, code: string, state: string): Promise<void> {
    const bootstrap = this.requireManifestBootstrap();
    verifyState(
      state,
      userId,
      "manifest",
      derivedKey(bootstrap.currentKey.key, "state").toString("base64url"),
    );
    if (this.config) {
      throw new GitHubIntegrationError(
        "github_already_configured",
        "GitHub App is already configured",
      );
    }
    const response = await this.http(
      `${API_BASE}/app-manifests/${encodeURIComponent(code)}/conversions`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": "TheNorns",
        },
      },
    );
    const conversion = (await response.json().catch(() => ({}))) as GitHubManifestConversion;
    if (!response.ok) {
      throw new GitHubIntegrationError(
        "github_manifest_conversion_failed",
        conversion.message ?? `GitHub App creation failed (${response.status})`,
        502,
      );
    }
    const appId = conversion.id === undefined ? "" : String(conversion.id);
    const clientId = conversion.client_id?.trim() ?? "";
    const appSlug = conversion.slug?.trim() ?? "";
    const secrets: StoredAppSecrets = {
      client_secret: conversion.client_secret?.trim() ?? "",
      private_key: conversion.pem?.trim() ?? "",
      // GitHub returns null when the manifest does not configure an active webhook.
      webhook_secret: conversion.webhook_secret?.trim() ?? null,
    };
    if (!appId || !clientId || !appSlug || !secrets.client_secret || !secrets.private_key) {
      throw new GitHubIntegrationError(
        "github_manifest_conversion_invalid",
        "GitHub returned an incomplete App configuration",
        502,
      );
    }
    const ciphertext = new TokenCipher(
      derivedKey(bootstrap.currentKey.key, "configuration"),
    ).encrypt(JSON.stringify(secrets));
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO github_app_configurations (
           id, key_id, app_id, client_id, app_slug, credentials_ciphertext,
           created_by_user_id, created_at, updated_at
         ) VALUES ('primary',$1,$2,$3,$4,$5,$6,now(),now())`,
        [bootstrap.currentKey.keyId, appId, clientId, appSlug, ciphertext, userId],
      );
    });
    this.activateManifestConfiguration(
      {
        key_id: bootstrap.currentKey.keyId,
        app_id: appId,
        client_id: clientId,
        app_slug: appSlug,
        credentials_ciphertext: ciphertext,
      },
      secrets,
      bootstrap.currentKey.key,
    );
  }

  authorizationUrl(userId: string, next: "install" | null = null): string {
    const config = this.requireConfig();
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", `${config.publicOrigin}/api/integrations/github/callback`);
    url.searchParams.set("state", createState(userId, "authorize", config.stateSecret, next));
    return url.toString();
  }

  installationUrl(userId: string): string {
    const config = this.requireConfig();
    const url = new URL(`https://github.com/apps/${config.appSlug}/installations/new`);
    url.searchParams.set("state", createState(userId, "install", config.stateSecret));
    return url.toString();
  }

  authorizationUserId(state: string): string {
    return stateContext(state, "authorize", this.requireConfig().stateSecret).userId;
  }

  installationUserId(state: string): string {
    return stateContext(state, "install", this.requireConfig().stateSecret).userId;
  }

  async completeAuthorization(
    userId: string,
    code: string,
    state: string,
  ): Promise<{ next: "install" | null }> {
    const config = this.requireConfig();
    const context = verifyState(state, userId, "authorize", config.stateSecret);
    const token = await this.oauthToken({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: `${config.publicOrigin}/api/integrations/github/callback`,
    });
    if (!token.access_token) {
      throw new GitHubIntegrationError(
        "github_authorization_failed",
        token.error_description ?? token.error ?? "GitHub did not issue an access token",
        400,
      );
    }
    const accessToken = token.access_token;
    const user = await this.github<GitHubUser>("/user", accessToken);
    const now = new Date();
    const accessExpiresAt = token.expires_in
      ? new Date(now.getTime() + token.expires_in * 1000).toISOString()
      : null;
    const refreshExpiresAt = token.refresh_token_expires_in
      ? new Date(now.getTime() + token.refresh_token_expires_in * 1000).toISOString()
      : null;
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO github_user_authorizations (
           user_id, github_user_id, github_login, access_token_ciphertext,
           refresh_token_ciphertext, access_token_expires_at,
           refresh_token_expires_at, connected_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
         ON CONFLICT (user_id) DO UPDATE SET
           github_user_id = EXCLUDED.github_user_id,
           github_login = EXCLUDED.github_login,
           access_token_ciphertext = EXCLUDED.access_token_ciphertext,
           refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
           access_token_expires_at = EXCLUDED.access_token_expires_at,
           refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
           updated_at = now()`,
        [
          userId,
          String(user.id),
          user.login,
          this.requireCipher().encrypt(accessToken),
          token.refresh_token ? this.requireCipher().encrypt(token.refresh_token) : null,
          accessExpiresAt,
          refreshExpiresAt,
        ],
      );
    });
    await this.syncConnections(userId);
    return { next: context.next };
  }

  async completeInstallation(userId: string, state: string | undefined): Promise<void> {
    if (state) verifyState(state, userId, "install", this.requireConfig().stateSecret);
    await this.syncConnections(userId);
  }

  async status(userId: string, refresh = true): Promise<GitHubIntegrationStatus> {
    if (!this.config) return disabledGitHubStatus(this.setupAvailable());
    if (refresh) {
      try {
        await this.syncConnections(userId);
      } catch (error) {
        if (!(error instanceof GitHubIntegrationError && error.code === "github_not_connected")) {
          throw error;
        }
      }
    }
    return this.transactions.transaction(async (tx) => {
      const authorization = await tx.query<Pick<AuthorizationRow, "github_login">>(
        "SELECT github_login FROM github_user_authorizations WHERE user_id = $1",
        [userId],
      );
      const connections = await this.selectConnections(tx);
      return {
        configured: true,
        setup_available: false,
        configuration_source: this.configurationSource,
        user_authorization: {
          connected: authorization.rows.length > 0,
          login: authorization.rows[0]?.github_login ?? null,
        },
        connections: connections.map(connectionSummary),
      };
    });
  }

  async syncConnections(userId: string): Promise<GitHubConnectionSummary[]> {
    const token = await this.userAccessToken(userId);
    const response = await this.github<{ installations: GitHubInstallation[] }>(
      "/user/installations?per_page=100",
      token,
    );
    return this.transactions.transaction(async (tx) => {
      for (const installation of response.installations) {
        const ownerType = installation.account.type === "Organization" ? "organization" : "user";
        await tx.query(
          `INSERT INTO service_connections (
             id, provider, display_name, base_url, status, owner_type,
             owner_login, external_account_id, installation_id,
             repository_selection, connected_by_user_id, last_validated_at,
             created_at, updated_at
           ) VALUES ($1,'github',$2,'https://github.com','connected',$3,$4,$5,$6,$7,$8,now(),now(),now())
           ON CONFLICT (provider, installation_id) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             status = CASE
               WHEN service_connections.status = 'disconnected' THEN 'disconnected'
               ELSE 'connected'
             END,
             owner_type = EXCLUDED.owner_type,
             owner_login = EXCLUDED.owner_login,
             external_account_id = EXCLUDED.external_account_id,
             repository_selection = EXCLUDED.repository_selection,
             last_validated_at = now(),
             updated_at = now()`,
          [
            `github:${installation.id}`,
            `${installation.account.login} on GitHub`,
            ownerType,
            installation.account.login,
            String(installation.account.id),
            String(installation.id),
            installation.repository_selection,
            userId,
          ],
        );
      }
      return (await this.selectConnections(tx)).map(connectionSummary);
    });
  }

  async listRepositories(
    _userId: string,
    connectionId: string,
    query = "",
  ): Promise<GitHubRepositorySummary[]> {
    const connection = await this.connection(connectionId);
    const token = await this.installationToken(connection.installation_id);
    const repositories: GitHubRepository[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.github<{ repositories: GitHubRepository[] }>(
        `/installation/repositories?per_page=100&page=${page}`,
        token,
      );
      repositories.push(...response.repositories);
      if (response.repositories.length < 100) break;
    }
    const normalizedQuery = query.trim().toLowerCase();
    return repositories
      .filter((repository) =>
        normalizedQuery ? repository.full_name.toLowerCase().includes(normalizedQuery) : true,
      )
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .map((repository) => repositorySummary(connectionId, repository));
  }

  async resolveRepository(
    _userId: string,
    connectionId: string,
    repositoryId: string,
  ): Promise<GitHubRepositorySummary> {
    const connection = await this.connection(connectionId);
    const token = await this.installationToken(connection.installation_id);
    const repository = await this.github<GitHubRepository>(
      `/repositories/${encodeURIComponent(repositoryId)}`,
      token,
    );
    if (repository.owner.login.toLowerCase() !== connection.owner_login.toLowerCase()) {
      throw new GitHubIntegrationError(
        "repository_connection_mismatch",
        "The selected repository does not belong to this GitHub connection",
        409,
      );
    }
    return repositorySummary(connectionId, repository);
  }

  async createRepository(
    userId: string,
    input: {
      connection_id: string;
      name: string;
      description: string;
      private: boolean;
      auto_init: boolean;
    },
  ): Promise<GitHubRepositorySummary & { binding_ready: boolean }> {
    const connection = await this.connection(input.connection_id);
    let repository: GitHubRepository;
    if (connection.owner_type === "organization") {
      const token = await this.installationToken(connection.installation_id);
      repository = await this.github<GitHubRepository>(
        `/orgs/${encodeURIComponent(connection.owner_login)}/repos`,
        token,
        {
          method: "POST",
          body: JSON.stringify({
            name: input.name,
            description: input.description,
            private: input.private,
            auto_init: input.auto_init,
          }),
        },
      );
    } else {
      const authorization = await this.authorization(userId);
      if (authorization.github_login.toLowerCase() !== connection.owner_login.toLowerCase()) {
        throw new GitHubIntegrationError(
          "github_owner_mismatch",
          `Connect GitHub as ${connection.owner_login} to create a repository there`,
          403,
        );
      }
      repository = await this.github<GitHubRepository>("/user/repos", authorization.accessToken, {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          description: input.description,
          private: input.private,
          auto_init: input.auto_init,
        }),
      });
    }
    return {
      ...repositorySummary(input.connection_id, repository),
      binding_ready: connection.repository_selection === "all",
    };
  }

  async disconnect(connectionId: string): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const result = await tx.query(
        `UPDATE service_connections
         SET status = 'disconnected', updated_at = now()
         WHERE id = $1 AND provider = 'github'`,
        [connectionId],
      );
      if ((result.affectedRows ?? result.rows.length) === 0) {
        throw new GitHubIntegrationError(
          "connection_not_found",
          "GitHub connection not found",
          404,
        );
      }
    });
  }

  async reconnect(connectionId: string): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const result = await tx.query(
        `UPDATE service_connections
         SET status = 'connected', updated_at = now()
         WHERE id = $1 AND provider = 'github'`,
        [connectionId],
      );
      if ((result.affectedRows ?? result.rows.length) === 0) {
        throw new GitHubIntegrationError(
          "connection_not_found",
          "GitHub connection not found",
          404,
        );
      }
    });
  }

  private requireConfig(): GitHubIntegrationConfig {
    if (!this.config) {
      throw new GitHubIntegrationError(
        "github_not_configured",
        "GitHub App is not configured",
        503,
      );
    }
    return this.config;
  }

  private requireCipher(): TokenCipher {
    this.requireConfig();
    if (!this.cipher) {
      throw new GitHubIntegrationError(
        "credential_unavailable",
        "GitHub credential encryption is unavailable",
        500,
      );
    }
    return this.cipher;
  }

  private requireManifestBootstrap(): GitHubManifestBootstrap {
    if (!this.manifestBootstrap) {
      throw new GitHubIntegrationError(
        "github_manifest_unavailable",
        "Guided GitHub setup is unavailable",
        503,
      );
    }
    return this.manifestBootstrap;
  }

  private parseStoredSecrets(value: string): StoredAppSecrets {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new GitHubIntegrationError(
        "github_configuration_invalid",
        "Stored GitHub App configuration is invalid",
        500,
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("client_secret" in parsed) ||
      typeof parsed.client_secret !== "string" ||
      !("private_key" in parsed) ||
      typeof parsed.private_key !== "string" ||
      !("webhook_secret" in parsed) ||
      (parsed.webhook_secret !== null && typeof parsed.webhook_secret !== "string") ||
      !parsed.client_secret ||
      !parsed.private_key
    ) {
      throw new GitHubIntegrationError(
        "github_configuration_invalid",
        "Stored GitHub App configuration is incomplete",
        500,
      );
    }
    return {
      client_secret: parsed.client_secret,
      private_key: parsed.private_key,
      webhook_secret: parsed.webhook_secret,
    };
  }

  private activateManifestConfiguration(
    row: StoredAppConfigurationRow,
    secrets: StoredAppSecrets,
    rootKey: Uint8Array,
  ): void {
    const bootstrap = this.requireManifestBootstrap();
    const tokenEncryptionKey = derivedKey(rootKey, "tokens");
    this.config = {
      appId: row.app_id,
      clientId: row.client_id,
      clientSecret: secrets.client_secret,
      appSlug: row.app_slug,
      privateKey: secrets.private_key,
      stateSecret: derivedKey(rootKey, "state").toString("base64url"),
      tokenEncryptionKey,
      publicOrigin: bootstrap.publicOrigin.replace(/\/$/, ""),
    };
    this.cipher = new TokenCipher(tokenEncryptionKey);
    this.configurationSource = "manifest";
  }

  private async selectConnections(tx: V2SqlExecutor): Promise<ConnectionRow[]> {
    return (
      await tx.query<ConnectionRow>(
        `SELECT id, provider, display_name, status, owner_type, owner_login,
                installation_id, repository_selection, last_validated_at
         FROM service_connections
         WHERE provider = 'github'
         ORDER BY owner_login`,
      )
    ).rows;
  }

  private async connection(connectionId: string): Promise<ConnectionRow> {
    return this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<ConnectionRow>(
          `SELECT id, provider, display_name, status, owner_type, owner_login,
                  installation_id, repository_selection, last_validated_at
           FROM service_connections
           WHERE id = $1 AND provider = 'github' AND status = 'connected'`,
          [connectionId],
        )
      ).rows[0];
      if (!row) {
        throw new GitHubIntegrationError(
          "connection_not_found",
          "The selected GitHub connection is unavailable",
          404,
        );
      }
      return row;
    });
  }

  private async authorization(userId: string): Promise<AuthorizationRow & { accessToken: string }> {
    const row = await this.transactions.transaction(async (tx) => {
      return (
        await tx.query<AuthorizationRow>(
          `SELECT user_id, github_user_id, github_login, access_token_ciphertext,
                  refresh_token_ciphertext, access_token_expires_at, refresh_token_expires_at
           FROM github_user_authorizations WHERE user_id = $1`,
          [userId],
        )
      ).rows[0];
    });
    if (!row) {
      throw new GitHubIntegrationError(
        "github_not_connected",
        "Connect your GitHub account in Settings first",
        409,
      );
    }
    const expiresAt = row.access_token_expires_at
      ? new Date(row.access_token_expires_at).getTime()
      : null;
    if (expiresAt !== null && expiresAt <= Date.now() + 60_000) {
      return this.refreshAuthorization(row);
    }
    return { ...row, accessToken: this.requireCipher().decrypt(row.access_token_ciphertext) };
  }

  private async userAccessToken(userId: string): Promise<string> {
    return (await this.authorization(userId)).accessToken;
  }

  private async refreshAuthorization(
    row: AuthorizationRow,
  ): Promise<AuthorizationRow & { accessToken: string }> {
    if (!row.refresh_token_ciphertext) {
      throw new GitHubIntegrationError(
        "github_reauthorization_required",
        "Your GitHub authorization expired; reconnect GitHub",
        409,
      );
    }
    if (
      row.refresh_token_expires_at &&
      new Date(row.refresh_token_expires_at).getTime() <= Date.now()
    ) {
      throw new GitHubIntegrationError(
        "github_reauthorization_required",
        "Your GitHub authorization expired; reconnect GitHub",
        409,
      );
    }
    const config = this.requireConfig();
    const cipher = this.requireCipher();
    const token = await this.oauthToken({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: cipher.decrypt(row.refresh_token_ciphertext),
    });
    if (!token.access_token) {
      throw new GitHubIntegrationError(
        "github_reauthorization_required",
        token.error_description ?? "GitHub authorization could not be refreshed",
        409,
      );
    }
    const now = Date.now();
    const next: AuthorizationRow = {
      ...row,
      access_token_ciphertext: cipher.encrypt(token.access_token),
      refresh_token_ciphertext: token.refresh_token
        ? cipher.encrypt(token.refresh_token)
        : row.refresh_token_ciphertext,
      access_token_expires_at: token.expires_in
        ? new Date(now + token.expires_in * 1000).toISOString()
        : null,
      refresh_token_expires_at: token.refresh_token_expires_in
        ? new Date(now + token.refresh_token_expires_in * 1000).toISOString()
        : row.refresh_token_expires_at,
    };
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE github_user_authorizations SET
           access_token_ciphertext = $2,
           refresh_token_ciphertext = $3,
           access_token_expires_at = $4,
           refresh_token_expires_at = $5,
           updated_at = now()
         WHERE user_id = $1`,
        [
          row.user_id,
          next.access_token_ciphertext,
          next.refresh_token_ciphertext,
          next.access_token_expires_at,
          next.refresh_token_expires_at,
        ],
      );
    });
    return { ...next, accessToken: token.access_token };
  }

  private appJwt(): string {
    const config = this.requireConfig();
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64Url(
      JSON.stringify({ iat: now - 30, exp: now + 9 * 60, iss: config.appId }),
    );
    const unsigned = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(config.privateKey, "base64url")}`;
  }

  private async installationToken(installationId: string): Promise<string> {
    const response = await this.github<InstallationTokenResponse>(
      `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      this.appJwt(),
      { method: "POST", body: JSON.stringify({}) },
    );
    return response.token;
  }

  private async oauthToken(body: Record<string, string>): Promise<OAuthTokenResponse> {
    const response = await this.http("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as OAuthTokenResponse;
    if (!response.ok) {
      throw new GitHubIntegrationError(
        "github_authorization_failed",
        payload.error_description ??
          payload.error ??
          `GitHub authorization failed (${response.status})`,
        502,
      );
    }
    return payload;
  }

  private async github<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
    const response = await this.http(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "TheNorns",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const payload = (await response.json().catch(() => ({}))) as T & {
      message?: string;
      documentation_url?: string;
    };
    if (!response.ok) {
      const permissionHint =
        response.status === 403 || response.status === 422
          ? " Check the GitHub App installation and repository permissions."
          : "";
      throw new GitHubIntegrationError(
        "github_api_error",
        `${payload.message ?? `GitHub request failed (${response.status})`}.${permissionHint}`,
        409,
      );
    }
    return payload;
  }
}

export function disabledGitHubStatus(setupAvailable = false): GitHubIntegrationStatus {
  return {
    configured: false,
    setup_available: setupAvailable,
    configuration_source: null,
    user_authorization: { connected: false, login: null },
    connections: [],
  };
}

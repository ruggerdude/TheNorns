import { randomUUID } from "node:crypto";
import {
  DEVICE_PUBLICATION_PERMIT_CONSUME_HTTP_SIGNATURE_PURPOSE,
  DEVICE_PUBLICATION_PERMIT_ISSUE_HTTP_SIGNATURE_PURPOSE,
  DevicePublicationPermitConsumeRequest,
  DevicePublicationPermitConsumeResponse,
  type DevicePublicationPermitConsumeResponseT,
  DevicePublicationPermitIssueRequest,
  type DevicePublicationPermitIssueRequestT,
  SignedDevicePublicationPermit,
  type SignedDevicePublicationPermitT,
} from "@norns/contracts";
import { type DeviceRunnerHttpIdentity, signRunnerHttpRequest } from "./contextAuth.js";
import {
  GitPublisher,
  type GitPublisherOptions,
  PublicationError,
  type RunnerPublicationInput,
  type RunnerPublisher,
} from "./publication.js";

const MAX_PUBLICATION_PERMIT_LIFETIME_MS = 30_000;

function serverOrigin(value: string): string {
  const url = new URL(value);
  const local =
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !local) {
    throw new Error("device publication permit server must use HTTPS");
  }
  if (
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("device publication permit server must be an origin");
  }
  return url.origin;
}

function routedId(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,499}$/.test(value)) {
    throw new Error(`${name} is not a valid opaque identifier`);
  }
  return encodeURIComponent(value);
}

function claimsMatch(
  signed: SignedDevicePublicationPermitT,
  requested: DevicePublicationPermitIssueRequestT,
  identity: DeviceRunnerHttpIdentity,
): boolean {
  const claims = signed.permit;
  return (
    claims.run_id === requested.run_id &&
    claims.device_id === identity.deviceId &&
    claims.credential_id === identity.credentialId &&
    claims.generation === identity.generation &&
    claims.repository_registration_id === requested.repository_registration_id &&
    claims.project_device_repository_grant_id === requested.project_device_repository_grant_id &&
    claims.repository_binding_id === requested.repository_binding_id &&
    claims.repository_id === requested.repository_id &&
    claims.branch === requested.branch &&
    claims.commit_sha === requested.commit_sha
  );
}

export interface DevicePublicationPermitAuthorizer {
  issueAndConsume(
    scope: DevicePublicationPermitIssueRequestT,
  ): Promise<DevicePublicationPermitConsumeResponseT>;
}

/**
 * Obtains and consumes a server-signed, single-use publication permit.
 *
 * The signature bytes remain opaque to the runner. The runner compares every
 * canonical claim to its request and authenticated identity, then asks the
 * server to verify, reauthorize, and atomically consume the signed envelope.
 */
export class SignedDevicePublicationPermitClient implements DevicePublicationPermitAuthorizer {
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
      throw new Error("device publication permit timeout must be positive");
    }
  }

  async issueAndConsume(
    scope: DevicePublicationPermitIssueRequestT,
  ): Promise<DevicePublicationPermitConsumeResponseT> {
    const requested = DevicePublicationPermitIssueRequest.parse(scope);
    const issueUrl = new URL("/api/device-publication-permits", this.origin);
    const issueBody = JSON.stringify(requested);
    const issueSigned = signRunnerHttpRequest({
      identity: this.identity,
      purpose: DEVICE_PUBLICATION_PERMIT_ISSUE_HTTP_SIGNATURE_PURPOSE,
      method: "POST",
      url: issueUrl,
      body: issueBody,
      timestamp: this.now().toISOString(),
      requestId: this.newRequestId(),
    });
    const issued = await this.httpFetch(issueUrl, {
      method: "POST",
      redirect: "error",
      headers: { ...issueSigned.headers, "content-type": "application/json" },
      body: issueBody,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!issued.ok) {
      throw new PublicationError(
        "device publication authorization was refused",
        `permit issue failed with ${issued.status}`,
      );
    }

    const envelope = SignedDevicePublicationPermit.parse(await issued.json());
    if (!claimsMatch(envelope, requested, this.identity)) {
      throw new PublicationError(
        "device publication authorization did not match this run",
        "the permit claims did not match the requested device, grant chain, repository, branch, or commit",
      );
    }
    const now = this.now().getTime();
    const issuedAt = Date.parse(envelope.permit.issued_at);
    const expiresAt = Date.parse(envelope.permit.expires_at);
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      expiresAt <= issuedAt ||
      expiresAt > issuedAt + MAX_PUBLICATION_PERMIT_LIFETIME_MS
    ) {
      throw new PublicationError(
        "device publication authorization was stale",
        "the permit was expired or exceeded its maximum lifetime",
      );
    }

    const consumeUrl = new URL(
      `/api/device-publication-permits/${routedId(envelope.permit.permit_id, "permit_id")}/consume`,
      this.origin,
    );
    const consumeRequest = DevicePublicationPermitConsumeRequest.parse(envelope);
    const consumeBody = JSON.stringify(consumeRequest);
    const consumeSigned = signRunnerHttpRequest({
      identity: this.identity,
      purpose: DEVICE_PUBLICATION_PERMIT_CONSUME_HTTP_SIGNATURE_PURPOSE,
      method: "POST",
      url: consumeUrl,
      body: consumeBody,
      timestamp: this.now().toISOString(),
      requestId: this.newRequestId(),
    });
    const consumed = await this.httpFetch(consumeUrl, {
      method: "POST",
      redirect: "error",
      headers: { ...consumeSigned.headers, "content-type": "application/json" },
      body: consumeBody,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!consumed.ok) {
      throw new PublicationError(
        "device publication authorization could not be consumed",
        `permit consume failed with ${consumed.status}`,
      );
    }
    const result = DevicePublicationPermitConsumeResponse.parse(await consumed.json());
    if (result.permit_id !== envelope.permit.permit_id) {
      throw new PublicationError(
        "device publication authorization response did not match",
        "the consumed permit identifier differed from the issued permit",
      );
    }
    return result;
  }
}

export type DevicePublicationScopeResolver = (
  input: RunnerPublicationInput,
) => DevicePublicationPermitIssueRequestT;

/**
 * The only Git publisher intended for device-backed local execution.
 *
 * `GitPublisher` calls the injected guard immediately before each actual push,
 * including a force-with-lease retry. Every attempt therefore receives a new
 * issue+consume cycle. The legacy/GitHub Actions construction continues to use
 * plain `GitPublisher` and is not changed by this device-only seam.
 */
export class DeviceBackedGitPublisher implements RunnerPublisher {
  private readonly publisher: GitPublisher;

  constructor(
    permits: DevicePublicationPermitAuthorizer,
    scopeFor: DevicePublicationScopeResolver,
    options: Omit<GitPublisherOptions, "beforePush"> = {},
  ) {
    this.publisher = new GitPublisher({
      ...options,
      beforePush: async (input) => {
        const scope = DevicePublicationPermitIssueRequest.parse(scopeFor(input));
        if (
          scope.run_id !== input.run_id ||
          scope.branch !== input.branch ||
          scope.commit_sha !== input.commit
        ) {
          throw new PublicationError(
            "device publication scope did not match the produced work",
            "the run, branch, and commit must match immediately before publication",
          );
        }
        await permits.issueAndConsume(scope);
      },
    });
  }

  publish(input: RunnerPublicationInput) {
    return this.publisher.publish(input);
  }
}

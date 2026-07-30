import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceEnrollmentRouteService } from "../src/devices/routes.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";

let server: NornsServer | null = null;

afterEach(async () => {
  await server?.app.close();
  server = null;
});

function serviceMock(): DeviceEnrollmentRouteService {
  return {
    createAuthorization: vi.fn(async () => ({
      authorization_request_id: "deviceauth-1",
      device_code: "d".repeat(43),
      user_code: "ABCD-EFGH",
      verification_uri: "https://norns.example/device-authorization",
      expires_at: "2026-07-29T15:00:00.000Z",
      interval_seconds: 5,
    })),
    lookup: vi.fn(async () => ({
      authorization_request_id: "deviceauth-1",
      authorization_context: "context-1",
      proposed_name: "Office Mac mini",
      os_family: "macos" as const,
      architecture: "arm64",
      public_key_fingerprint: "a".repeat(64),
      expires_at: "2026-07-29T15:00:00.000Z",
    })),
    approve: vi.fn(async () => ({
      authorization_request_id: "deviceauth-1",
      state: "approved_pending_redemption" as const,
    })),
    deny: vi.fn(async () => ({
      authorization_request_id: "deviceauth-1",
      state: "denied" as const,
    })),
    poll: vi.fn(async () => ({
      outcome: "authorization_pending" as const,
      retry_after_seconds: 5,
    })),
  };
}

async function start(
  service?: DeviceEnrollmentRouteService,
  options: { staleSession?: boolean } = {},
): Promise<{
  stack: NornsServer;
  token: string;
  userId: string;
}> {
  const users = new UserStore();
  const user = users.createActive({
    email: "owner@example.com",
    password: "owner-password",
    role: "member",
  });
  const token = users.login("owner@example.com", "owner-password").token;
  if (options.staleSession) {
    const snapshot = users.snapshot();
    snapshot.sessions = snapshot.sessions.map((session) =>
      session.token === token ? { ...session, createdAt: "2000-01-01T00:00:00.000Z" } : session,
    );
    users.restoreFrom(snapshot);
  }
  server = await buildServer({
    stores: new RelayStores(),
    users,
    ...(service ? { deviceEnrollment: { service } } : {}),
    clock: () => new Date("2026-07-29T14:00:00.000Z"),
  });
  return { stack: server, token, userId: user.id };
}

describe("device enrollment HTTP routes", () => {
  it("projects authenticated, no-store local-execution capability gates", async () => {
    const { stack, token } = await start(serviceMock());
    const unauthorized = await stack.app.inject({
      method: "GET",
      url: "/api/v2/capabilities/local-execution",
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await stack.app.inject({
      method: "GET",
      url: "/api/v2/capabilities/local-execution",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      schema_version: 1,
      enrollment_available: true,
      computers_available: false,
      repository_grants_available: false,
      legacy_claim_available: false,
      legacy_local_creation_available: false,
    });
  });

  it("remain unmounted unless the explicit runtime is supplied", async () => {
    const { stack } = await start();
    const response = await stack.app.inject({
      method: "POST",
      url: "/api/device-authorizations",
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it("creates and polls through POST bodies with no-store responses", async () => {
    const service = serviceMock();
    const { stack } = await start(service);
    const created = await stack.app.inject({
      method: "POST",
      url: "/api/device-authorizations",
      payload: {
        device_code: Buffer.alloc(32, 1).toString("base64url"),
        user_code: "ABCD-EFGH",
        public_key_pem: "-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----",
        proposed_name: "Office Mac mini",
        os_family: "macos",
        architecture: "arm64",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(created.json()).toMatchObject({
      device_code: "d".repeat(43),
      user_code: "ABCD-EFGH",
    });
    expect(service.createAuthorization).toHaveBeenCalledOnce();

    const malformedProof = await stack.app.inject({
      method: "POST",
      url: "/api/device-authorizations/token",
      payload: { device_code: "d".repeat(43), public_key_pem: "key-without-proof" },
    });
    expect(malformedProof.statusCode).toBe(400);
    expect(service.poll).not.toHaveBeenCalled();

    const polled = await stack.app.inject({
      method: "POST",
      url: "/api/device-authorizations/token",
      payload: { device_code: "d".repeat(43) },
    });
    expect(polled.statusCode).toBe(200);
    expect(polled.json()).toEqual({
      outcome: "authorization_pending",
      retry_after_seconds: 5,
    });
  });

  it("authenticates lookup and binds decisions to the current user and lookup context", async () => {
    const service = serviceMock();
    const { stack, token, userId } = await start(service);
    const unauthorized = await stack.app.inject({
      method: "POST",
      url: "/api/device-authorizations/lookup",
      payload: { user_code: "ABCDEFGH" },
    });
    expect(unauthorized.statusCode).toBe(401);

    const lookup = await stack.app.inject({
      method: "POST",
      url: "/api/device-authorizations/lookup",
      headers: { authorization: `Bearer ${token}` },
      payload: { user_code: "ABCDEFGH" },
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({
      authorization_request_id: "deviceauth-1",
      authorization_context: "context-1",
    });

    const approved = await stack.app.inject({
      method: "POST",
      url: "/api/device-authorizations/deviceauth-1/approve",
      headers: { authorization: `Bearer ${token}` },
      payload: { authorization_context: "context-1" },
    });
    expect(approved.statusCode).toBe(200);
    expect(service.approve).toHaveBeenCalledWith({
      authorization_request_id: "deviceauth-1",
      authorization_context: "context-1",
      owner_user_id: userId,
    });

    const denied = await stack.app.inject({
      method: "POST",
      url: "/api/device-authorizations/deviceauth-1/deny",
      headers: { authorization: `Bearer ${token}` },
      payload: { authorization_context: "context-1" },
    });
    expect(denied.statusCode).toBe(200);
    expect(service.deny).toHaveBeenCalledWith({
      authorization_request_id: "deviceauth-1",
      authorization_context: "context-1",
      denied_by_user_id: userId,
    });
  });

  it("requires a recent owner session for approve and deny but not lookup", async () => {
    const service = serviceMock();
    const { stack, token } = await start(service, { staleSession: true });
    const headers = { authorization: `Bearer ${token}` };

    expect(
      (
        await stack.app.inject({
          method: "POST",
          url: "/api/device-authorizations/lookup",
          headers,
          payload: { user_code: "ABCDEFGH" },
        })
      ).statusCode,
    ).toBe(200);

    for (const decision of ["approve", "deny"]) {
      const response = await stack.app.inject({
        method: "POST",
        url: `/api/device-authorizations/deviceauth-1/${decision}`,
        headers,
        payload: { authorization_context: "context-1" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "recent_auth_required" });
    }
    expect(service.approve).not.toHaveBeenCalled();
    expect(service.deny).not.toHaveBeenCalled();
  });

  it("throttles every human-code submission and returns Retry-After", async () => {
    const service = serviceMock();
    const { stack, token } = await start(service);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await stack.app.inject({
        method: "POST",
        url: "/api/device-authorizations/lookup",
        headers: { authorization: `Bearer ${token}` },
        payload: { user_code: "ABCDEFGH" },
        remoteAddress: "192.0.2.10",
      });
      expect(response.statusCode).toBe(200);
    }

    const blocked = await stack.app.inject({
      method: "POST",
      url: "/api/device-authorizations/lookup",
      headers: { authorization: `Bearer ${token}` },
      payload: { user_code: "ABCDEFGH" },
      remoteAddress: "192.0.2.10",
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("900");
    expect(service.lookup).toHaveBeenCalledTimes(10);
  });
});

import { PGlite } from "@electric-sql/pglite";
import type { AiUsageLifecycleEventInputT } from "@norns/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqlAiUsageTelemetryRepository } from "../src/persistence/v2/aiUsageTelemetry.js";
import {
  type PGliteDatabaseLike,
  PGliteTransactionRunner,
} from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { ProjectStore } from "../src/projects/store.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { RelationalIdentityService } from "../src/users/relationalIdentityService.js";
import { UserStore } from "../src/users/store.js";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const PASSWORD = "integration-password";

function bearer(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "x-norns-api-client": "bearer",
  };
}

describe.sequential("production usage-intelligence host composition", () => {
  let pg: PGlite;
  let server: NornsServer;
  let adminId: string;
  let ownerId: string;
  let memberId: string;
  let outsiderId: string;
  let adminToken: string;
  let ownerToken: string;
  let memberToken: string;
  let outsiderToken: string;
  let managedProjectId: string;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    const transactions = new PGliteTransactionRunner(pg as unknown as PGliteDatabaseLike);
    let userCounter = 0;
    let randomCounter = 1;
    const identity = new RelationalIdentityService({
      transactions,
      credentialKey: {
        keyId: "usage-host-key",
        key: Buffer.alloc(32, 31),
      },
      clock: () => NOW,
      newId: () => `usage-host-user-${++userCounter}`,
      randomBytes: (size) => Buffer.alloc(size, randomCounter++),
    });
    const admin = await identity.createActive({
      email: "admin@usage.test",
      password: PASSWORD,
      role: "admin",
    });
    const owner = await identity.createActive({
      email: "owner@usage.test",
      password: PASSWORD,
      role: "member",
    });
    const member = await identity.createActive({
      email: "member@usage.test",
      password: PASSWORD,
      role: "member",
    });
    const outsider = await identity.createActive({
      email: "outsider@usage.test",
      password: PASSWORD,
      role: "member",
    });
    adminId = admin.id;
    ownerId = owner.id;
    memberId = member.id;
    outsiderId = outsider.id;
    adminToken = (await identity.login(admin.email, PASSWORD)).token;
    ownerToken = (await identity.login(owner.email, PASSWORD)).token;
    memberToken = (await identity.login(member.email, PASSWORD)).token;
    outsiderToken = (await identity.login(outsider.email, PASSWORD)).token;
    const legacyProjects = new ProjectStore();
    managedProjectId = legacyProjects.create({
      name: "Managed Project",
      description: "Project authorization host test",
      pmProvider: "openai",
    }).id;

    await pg.query(
      `INSERT INTO projects (
         id, name, status, assignment_policy_ref, verification_policy_ref,
         budget_policy_ref, owner_user_id
       ) VALUES
         ('usage-project','Usage Project','active','assignment/default',
          'verification/default','budget/default',$1),
         ('usage-unowned','Legacy Unowned','active','assignment/default',
          'verification/default','budget/default',NULL)`,
      [ownerId],
    );
    await pg.query(
      `INSERT INTO projects (
         id, name, description, status, assignment_policy_ref,
         verification_policy_ref, budget_policy_ref, owner_user_id
       ) VALUES (
         $1,'Managed Project','Project authorization host test','active',
         'assignment/default','verification/default','budget/default',$2
       )`,
      [managedProjectId, ownerId],
    );
    await pg.query(
      `INSERT INTO project_members (
         project_id, user_id, status, added_by_user_id
       ) VALUES ('usage-project',$1,'active',$2)`,
      [memberId, ownerId],
    );
    await pg.query(
      `INSERT INTO phases (id, project_id, objective_summary, status)
       VALUES ('usage-phase','usage-project','Measure usage','proposed')`,
    );

    const repository = new SqlAiUsageTelemetryRepository(transactions);
    const base: AiUsageLifecycleEventInputT = {
      request_id: "usage-host-request",
      event_type: "request_started",
      status: "started",
      occurred_at: "2026-07-25T11:00:00.000Z",
      provider: "openai",
      model: "gpt-5.6-terra",
      provider_request_id: null,
      endpoint: "/v1/responses",
      request_type: "provider_native",
      retry_group_id: null,
      retry_attempt: 0,
      initiated_by_user_id: memberId,
      project_id: "usage-project",
      phase_id: "usage-phase",
      task_id: null,
      run_id: null,
      usage_source: "unavailable",
      confidence: 0,
      pricing_profile_id: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      cost_usd: null,
      cost_classification: "unavailable",
      latency_ms: null,
      http_status: null,
      error_code: null,
      error_category: null,
      error_message_redacted: null,
      sanitized_error: null,
      adjusts_event_id: null,
    };
    await repository.appendEvent(base, "usage-host-start");
    await repository.appendEvent(
      {
        ...base,
        event_type: "usage_observed",
        status: "in_progress",
        occurred_at: "2026-07-25T11:00:01.000Z",
        provider_request_id: "provider-usage-host",
        usage_source: "provider_api",
        confidence: 1,
        input_tokens: 1_000,
        output_tokens: 200,
        cache_read_tokens: 100,
        cache_write_tokens: 0,
        cost_usd: 5,
        cost_classification: "actual",
      },
      "usage-host-observed",
    );
    await repository.appendEvent(
      {
        ...base,
        event_type: "request_completed",
        status: "succeeded",
        occurred_at: "2026-07-25T11:00:02.000Z",
        provider_request_id: "provider-usage-host",
        latency_ms: 250,
        http_status: 200,
      },
      "usage-host-completed",
    );

    server = await buildServer({
      stores: new RelayStores(),
      users: new UserStore(),
      identity,
      projects: legacyProjects,
      runnerInference: { transactions },
      clock: () => NOW,
      publicOrigin: "https://norns.test",
    });
  }, 60_000);

  afterAll(async () => {
    await server?.app.close();
    if (!pg.closed) await pg.close();
  });

  it("denies global, cross-user, project, phase, and legacy-unowned usage by default", async () => {
    expect((await server.app.inject({ method: "GET", url: "/api/usage/summary" })).statusCode).toBe(
      401,
    );
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: "/api/usage/summary",
          headers: bearer(memberToken),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: `/api/usage/users/${outsiderId}/summary`,
          headers: bearer(memberToken),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: "/api/usage/projects/usage-project/summary",
          headers: bearer(outsiderToken),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: "/api/usage/phases/usage-phase/summary",
          headers: bearer(outsiderToken),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: "/api/usage/projects/usage-unowned/summary",
          headers: bearer(outsiderToken),
        })
      ).statusCode,
    ).toBe(403);
  });

  it("serves admin, self, member project/phase dashboards and a bounded CSV export", async () => {
    const global = await server.app.inject({
      method: "GET",
      url: "/api/usage/summary",
      headers: bearer(adminToken),
    });
    expect(global.statusCode).toBe(200);
    expect(global.json()).toMatchObject({
      requests: 1,
      succeeded_requests: 1,
      input_tokens: 1_000,
      output_tokens: 200,
      known_cost_usd: 5,
    });
    const globalBreakdown = await server.app.inject({
      method: "GET",
      url: "/api/usage/breakdown?dimensions=provider,model,project,user",
      headers: bearer(adminToken),
    });
    expect(globalBreakdown.statusCode).toBe(200);
    expect(globalBreakdown.json().breakdowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: "provider", value: "openai", requests: 1 }),
        expect.objectContaining({ dimension: "model", value: "gpt-5.6-terra", requests: 1 }),
        expect.objectContaining({ dimension: "project", value: "usage-project", requests: 1 }),
        expect.objectContaining({ dimension: "user", value: memberId, requests: 1 }),
      ]),
    );

    const self = await server.app.inject({
      method: "GET",
      url: `/api/usage/users/${memberId}/summary`,
      headers: bearer(memberToken),
    });
    expect(self.statusCode).toBe(200);
    expect(self.json()).toMatchObject({ requests: 1, known_cost_usd: 5 });
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: `/api/usage/users/${memberId}/summary`,
          headers: bearer(adminToken),
        })
      ).statusCode,
    ).toBe(200);

    for (const url of [
      "/api/usage/projects/usage-project/summary",
      "/api/usage/phases/usage-phase/summary",
    ]) {
      const response = await server.app.inject({
        method: "GET",
        url,
        headers: bearer(memberToken),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ requests: 1, known_cost_usd: 5 });
    }
    const projectBreakdown = await server.app.inject({
      method: "GET",
      url: "/api/usage/projects/usage-project/breakdown?dimensions=user,model,phase",
      headers: bearer(memberToken),
    });
    expect(projectBreakdown.statusCode).toBe(200);
    expect(projectBreakdown.json().breakdowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: "phase", value: "usage-phase", requests: 1 }),
      ]),
    );

    const csv = await server.app.inject({
      method: "GET",
      url: "/api/usage/projects/usage-project/export.csv",
      headers: bearer(memberToken),
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("ai-usage.csv");
    expect(csv.body).toContain("usage-host-request");
    expect(csv.body).not.toContain("prompt");
  });

  it("composes membership management and project-scoped budget evaluation", async () => {
    const outsiderBefore = await server.app.inject({
      method: "GET",
      url: "/api/v2/projects/usage-project/access",
      headers: bearer(outsiderToken),
    });
    expect(outsiderBefore.statusCode).toBe(200);
    expect(outsiderBefore.json()).toMatchObject({ can_access: false, source: "none" });

    const add = await server.app.inject({
      method: "POST",
      url: "/api/v2/projects/usage-project/members",
      headers: bearer(ownerToken),
      payload: { user_id: outsiderId },
    });
    expect(add.statusCode).toBe(200);
    expect(add.json()).toMatchObject({ owner_user_id: ownerId });
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: "/api/usage/projects/usage-project/summary",
          headers: bearer(outsiderToken),
        })
      ).statusCode,
    ).toBe(200);

    const created = await server.app.inject({
      method: "POST",
      url: "/api/usage/budgets",
      headers: bearer(ownerToken),
      payload: {
        scope_type: "project",
        scope_id: "usage-project",
        period: "daily",
        limit_usd: 1,
        threshold_percentages: [50, 100],
      },
    });
    expect(created.statusCode).toBe(201);
    const policyId = (created.json() as { id: string }).id;

    const memberList = await server.app.inject({
      method: "GET",
      url: "/api/usage/budgets?scope_type=project&scope_id=usage-project",
      headers: bearer(memberToken),
    });
    expect(memberList.statusCode).toBe(200);
    expect(memberList.json()).toMatchObject({
      policies: [expect.objectContaining({ id: policyId, scope_id: "usage-project" })],
    });

    const evaluated = await server.app.inject({
      method: "POST",
      url: "/api/usage/budgets/evaluate",
      headers: bearer(ownerToken),
      payload: { policy_id: policyId },
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json()).toMatchObject({
      evaluations: [
        expect.objectContaining({
          consumed_usd: 5,
          consumed_tokens: 1_200,
          notifications_created: [
            expect.objectContaining({ threshold_percentage: 50, metric: "usd" }),
            expect.objectContaining({ threshold_percentage: 100, metric: "usd" }),
          ],
        }),
      ],
    });
    const replay = await server.app.inject({
      method: "POST",
      url: "/api/usage/budgets/evaluate",
      headers: bearer(ownerToken),
      payload: { policy_id: policyId },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      evaluations: [expect.objectContaining({ notifications_created: [] })],
    });
  });

  it("enforces collaboration on legacy project list/read/create routes like a user", async () => {
    const outsiderList = await server.app.inject({
      method: "GET",
      url: "/api/projects",
      headers: bearer(outsiderToken),
    });
    expect(outsiderList.statusCode).toBe(200);
    expect(outsiderList.json()).toEqual([]);

    const forbidden = await server.app.inject({
      method: "GET",
      url: `/api/projects/${managedProjectId}`,
      headers: bearer(outsiderToken),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: `/api/projects/${managedProjectId}`,
          headers: bearer(memberToken),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.app.inject({
          method: "DELETE",
          url: `/api/projects/${managedProjectId}`,
          headers: bearer(outsiderToken),
        })
      ).statusCode,
    ).toBe(403);

    for (const token of [ownerToken, adminToken]) {
      const allowed = await server.app.inject({
        method: "GET",
        url: `/api/projects/${managedProjectId}`,
        headers: bearer(token),
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({ id: managedProjectId, name: "Managed Project" });
    }

    const created = await server.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: bearer(outsiderToken),
      payload: {
        name: "Outsider-owned",
        description: "Owned at authenticated creation time",
        pm_provider: "openai",
        pm_model: "gpt-5.6-terra",
      },
    });
    expect(created.statusCode).toBe(201);
    const createdId = (created.json() as { id: string }).id;
    const ownership = await pg.query<{ owner_user_id: string; owner_membership: boolean }>(
      `SELECT project.owner_user_id,
              EXISTS (
                SELECT 1
                FROM project_members membership
                WHERE membership.project_id=project.id
                  AND membership.user_id=project.owner_user_id
                  AND membership.status='active'
              ) AS owner_membership
       FROM projects project
       WHERE project.id=$1`,
      [createdId],
    );
    expect(ownership.rows[0]).toEqual({
      owner_user_id: outsiderId,
      owner_membership: true,
    });
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: `/api/projects/${createdId}`,
          headers: bearer(outsiderToken),
        })
      ).statusCode,
    ).toBe(200);
  });

  it("keeps analytics and calibration admin-only through the production host", async () => {
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: "/api/usage/analytics/signals",
          headers: bearer(memberToken),
        })
      ).statusCode,
    ).toBe(403);
    const signals = await server.app.inject({
      method: "GET",
      url: "/api/usage/analytics/signals",
      headers: bearer(adminToken),
    });
    expect(signals.statusCode).toBe(200);
    expect(signals.json()).toMatchObject({
      requests: 1,
      input_tokens: 1_000,
      output_tokens: 200,
      known_cost_usd: 5,
    });
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: "/api/usage/calibration/plans",
          headers: bearer(memberToken),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: "/api/usage/calibration/plans",
          headers: bearer(adminToken),
        })
      ).statusCode,
    ).toBe(200);
    expect(adminId).not.toBe(ownerId);
  });
});

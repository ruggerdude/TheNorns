// FRONT DOOR P2b: the write path for planning_reviewer_settings that P2 left
// missing. P2 already built the storage table, the read
// (PlanningRunService.reviewerSelectionOf) and the resolution
// (planning/reviewerSelection.ts resolvePlanningParticipants), all covered by
// planningReviewerSelection.test.ts and planningRunSchema.test.ts. This file
// only exercises the new HTTP surface: GET/PATCH/DELETE
// /api/v2/projects/:id/planning-reviewer, and proves the write lands in the
// exact row the existing resolution path already trusts.
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { PlanningRunService } from "../src/planning/runService.js";
import { RelationalProjectReadRepository } from "../src/projects/relationalReadRepository.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

interface InjectedResponse {
  statusCode: number;
  json: () => unknown;
}

async function inject(
  server: NornsServer,
  method: "GET" | "PATCH" | "DELETE",
  url: string,
  token?: string,
  body?: unknown,
): Promise<InjectedResponse> {
  const response = await server.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return response as unknown as InjectedResponse;
}

describe.sequential("FRONT DOOR P2b: planning-reviewer HTTP route", () => {
  let pg: PGlite;
  let server: NornsServer;
  let token: string;
  let transactions: PGliteTransactionRunner;
  const projectId = "project-reviewer-1";

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO projects (
        id, name, description, status, assignment_policy_ref,
        verification_policy_ref, budget_policy_ref
      ) VALUES ('${projectId}','Project One','','active','assignment','verification','budget');
      INSERT INTO project_planning_preferences (
        project_id, pm_provider, pm_model, reviewer_provider, source, created_at, updated_at
      ) VALUES ('${projectId}','anthropic','claude-sonnet-5','openai','native', now(), now());
    `);
    transactions = new PGliteTransactionRunner(pg);
    const users = new UserStore();
    token = testAdminToken(users);
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new RelationalProjectReadRepository(transactions, "reviewer-route-test"),
      planningRuns: { transactions },
    });
  });

  afterEach(async () => {
    await server?.app.close();
    if (!pg.closed) await pg.close();
  });

  it("requires a session for every method", async () => {
    const get = await inject(server, "GET", `/api/v2/projects/${projectId}/planning-reviewer`);
    expect(get.statusCode).toBe(401);
    const patch = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      undefined,
      { provider: "openai", model: "gpt-5.6-luna" },
    );
    expect(patch.statusCode).toBe(401);
    const del = await inject(server, "DELETE", `/api/v2/projects/${projectId}/planning-reviewer`);
    expect(del.statusCode).toBe(401);
  });

  it("404s GET/PATCH/DELETE for an unknown project", async () => {
    const get = await inject(
      server,
      "GET",
      "/api/v2/projects/no-such-project/planning-reviewer",
      token,
    );
    expect(get.statusCode).toBe(404);
    expect(get.json()).toMatchObject({ error: "not_found" });

    const patch = await inject(
      server,
      "PATCH",
      "/api/v2/projects/no-such-project/planning-reviewer",
      token,
      { provider: "openai", model: "gpt-5.6-luna" },
    );
    expect(patch.statusCode).toBe(404);

    const del = await inject(
      server,
      "DELETE",
      "/api/v2/projects/no-such-project/planning-reviewer",
      token,
    );
    expect(del.statusCode).toBe(404);
  });

  it("GET reports the automatic opposite-provider default when nothing is persisted", async () => {
    const res = await inject(
      server,
      "GET",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: "openai", model: null, mode: "automatic" });
  });

  it("rejects an invalid body", async () => {
    const badProvider = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { provider: "gemini", model: "gemini-pro" },
    );
    expect(badProvider.statusCode).toBe(400);

    const emptyModel = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { provider: "openai", model: "" },
    );
    expect(emptyModel.statusCode).toBe(400);

    const missingModel = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { provider: "openai" },
    );
    expect(missingModel.statusCode).toBe(400);

    const extraField = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { provider: "openai", model: "gpt-5.6-luna", nope: true },
    );
    expect(extraField.statusCode).toBe(400);
  });

  it("PATCH sets an explicit override that GET reflects, and DELETE clears it back to automatic", async () => {
    const patch = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { provider: "openai", model: "gpt-5.6-luna" },
    );
    expect(patch.statusCode).toBe(204);

    const afterPatch = await inject(
      server,
      "GET",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
    );
    expect(afterPatch.statusCode).toBe(200);
    expect(afterPatch.json()).toEqual({
      provider: "openai",
      model: "gpt-5.6-luna",
      mode: "explicit",
    });

    // The existing resolution path (PlanningRunService.reviewerSelectionOf,
    // consumed unchanged by resolvePlanningParticipants) must see exactly
    // what the route persisted — this is the "P2's read path picks it up
    // unchanged" guarantee, exercised at the service level.
    const planningRunService = new PlanningRunService(transactions);
    await expect(planningRunService.reviewerSelectionOf(projectId)).resolves.toEqual({
      provider: "openai",
      model: "gpt-5.6-luna",
    });

    const del = await inject(
      server,
      "DELETE",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
    );
    expect(del.statusCode).toBe(204);

    const afterDelete = await inject(
      server,
      "GET",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
    );
    expect(afterDelete.statusCode).toBe(200);
    expect(afterDelete.json()).toEqual({ provider: "openai", model: null, mode: "automatic" });
    await expect(planningRunService.reviewerSelectionOf(projectId)).resolves.toBeNull();
  });

  it("PATCH is idempotent and overwrites a prior explicit override", async () => {
    await inject(server, "PATCH", `/api/v2/projects/${projectId}/planning-reviewer`, token, {
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    const second = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { provider: "anthropic", model: "claude-sonnet-5" },
    );
    expect(second.statusCode).toBe(204);
    const res = await inject(
      server,
      "GET",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
    );
    expect(res.json()).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      mode: "explicit",
    });
  });
});

// FRONT DOOR P2b: the write path for planning_reviewer_settings that P2 left
// missing. P2 already built the storage table, the read
// (PlanningRunService.reviewerSelectionOf) and the resolution
// (planning/reviewerSelection.ts resolvePlanningParticipants), all covered by
// planningReviewerSelection.test.ts and planningRunSchema.test.ts. This file
// only exercises the new HTTP surface: GET/PATCH/DELETE
// /api/v2/projects/:id/planning-reviewer, and proves the write lands in the
// exact row the existing resolution path already trusts.
//
// QCP-4A adds the project-layer qc_mode default and its
// allow_unadjudicated_rebuttals escape hatch to the same row and the same
// route (GET reports both; PATCH sets either independently of the reviewer
// override).
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
    expect(res.json()).toEqual({
      provider: "openai",
      model: null,
      mode: "automatic",
      qc_mode: "automatic",
      allow_unadjudicated_rebuttals: false,
      default_max_rounds: 3,
    });
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
      qc_mode: "automatic",
      allow_unadjudicated_rebuttals: false,
      default_max_rounds: 3,
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
    expect(afterDelete.json()).toEqual({
      provider: "openai",
      model: null,
      mode: "automatic",
      qc_mode: "automatic",
      allow_unadjudicated_rebuttals: false,
      default_max_rounds: 3,
    });
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
      qc_mode: "automatic",
      allow_unadjudicated_rebuttals: false,
      default_max_rounds: 3,
    });
  });

  // -----------------------------------------------------------------------
  // QCP-4A: the project-layer qc_mode default and its
  // allow_unadjudicated_rebuttals escape hatch, read/written through the
  // same route/service as the reviewer override above.
  // -----------------------------------------------------------------------

  it("rejects an invalid qc_mode", async () => {
    const res = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { qc_mode: "gated_when_convenient" },
    );
    expect(res.statusCode).toBe(400);
  });

  it("defaults qc_mode to automatic and allow_unadjudicated_rebuttals to false with no row", async () => {
    const res = await inject(
      server,
      "GET",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
    );
    expect(res.json()).toMatchObject({
      qc_mode: "automatic",
      allow_unadjudicated_rebuttals: false,
      default_max_rounds: 3,
    });
  });

  it("PATCH round-trips qc_mode and allow_unadjudicated_rebuttals independently of the reviewer override", async () => {
    const setMode = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { qc_mode: "gated_when_contested" },
    );
    expect(setMode.statusCode).toBe(204);

    const afterMode = await inject(
      server,
      "GET",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
    );
    expect(afterMode.json()).toEqual({
      provider: "openai",
      model: null,
      mode: "automatic",
      qc_mode: "gated_when_contested",
      allow_unadjudicated_rebuttals: false,
      default_max_rounds: 3,
    });

    // Setting the escape hatch alone must not disturb the qc_mode just set,
    // nor require resupplying the reviewer override.
    const setRebuttals = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { allow_unadjudicated_rebuttals: true },
    );
    expect(setRebuttals.statusCode).toBe(204);

    const afterRebuttals = await inject(
      server,
      "GET",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
    );
    expect(afterRebuttals.json()).toEqual({
      provider: "openai",
      model: null,
      mode: "automatic",
      qc_mode: "gated_when_contested",
      allow_unadjudicated_rebuttals: true,
      default_max_rounds: 3,
    });

    // And setting the reviewer override alone must not reset qc_mode back to
    // the shipped default.
    const setReviewer = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { provider: "openai", model: "gpt-5.6-luna" },
    );
    expect(setReviewer.statusCode).toBe(204);

    const afterReviewer = await inject(
      server,
      "GET",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
    );
    expect(afterReviewer.json()).toEqual({
      provider: "openai",
      model: "gpt-5.6-luna",
      mode: "explicit",
      qc_mode: "gated_when_contested",
      allow_unadjudicated_rebuttals: true,
      default_max_rounds: 3,
    });
  });

  // -----------------------------------------------------------------------
  // QCP-14: default_max_rounds joins the same independently-optional PATCH.
  // 0 ("review off") is now valid end-to-end — the DB CHECK
  // (planning_reviewer_settings_default_max_rounds_check,
  // drizzle/0071_qc_zero_rounds.sql) allows BETWEEN 0 AND 5. Only negative
  // values, values above 5, and non-integers are rejected.
  // -----------------------------------------------------------------------

  it("rejects an out-of-range default_max_rounds", async () => {
    const negative = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { default_max_rounds: -1 },
    );
    expect(negative.statusCode).toBe(400);

    const tooHigh = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { default_max_rounds: 6 },
    );
    expect(tooHigh.statusCode).toBe(400);

    const notInt = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { default_max_rounds: 2.5 },
    );
    expect(notInt.statusCode).toBe(400);
  });

  it("PATCH round-trips default_max_rounds independently of qc_mode and the reviewer override", async () => {
    const setRounds = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { default_max_rounds: 5 },
    );
    expect(setRounds.statusCode).toBe(204);

    const afterRounds = await inject(
      server,
      "GET",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
    );
    expect(afterRounds.json()).toEqual({
      provider: "openai",
      model: null,
      mode: "automatic",
      qc_mode: "automatic",
      allow_unadjudicated_rebuttals: false,
      default_max_rounds: 5,
    });

    // Setting qc_mode alone afterward must not reset default_max_rounds.
    const setMode = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { qc_mode: "gated_each_round" },
    );
    expect(setMode.statusCode).toBe(204);

    const afterMode = await inject(
      server,
      "GET",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
    );
    expect(afterMode.json()).toEqual({
      provider: "openai",
      model: null,
      mode: "automatic",
      qc_mode: "gated_each_round",
      allow_unadjudicated_rebuttals: false,
      default_max_rounds: 5,
    });

    // And setting the reviewer override alone must leave default_max_rounds
    // untouched too.
    const setReviewer = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { provider: "anthropic", model: "claude-sonnet-5" },
    );
    expect(setReviewer.statusCode).toBe(204);

    const afterReviewer = await inject(
      server,
      "GET",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
    );
    expect(afterReviewer.json()).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      mode: "explicit",
      qc_mode: "gated_each_round",
      allow_unadjudicated_rebuttals: false,
      default_max_rounds: 5,
    });
  });

  it("QCP-14: PATCH round-trips default_max_rounds of 0 (review off)", async () => {
    const setZero = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { default_max_rounds: 0 },
    );
    expect(setZero.statusCode).toBe(204);

    const afterZero = await inject(
      server,
      "GET",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
    );
    expect(afterZero.json()).toMatchObject({ default_max_rounds: 0 });
  });

  it("changing the project default does not alter an existing review's pinned qc_mode", async () => {
    // Seed a review row pinned at kickoff with a qc_mode that differs from
    // both the shipped default and the value the project is about to be
    // switched to — proving the project-layer write never reaches into
    // conversation_plan_reviews, which pins its own copy at kickoff and
    // never re-reads planning_reviewer_settings.
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash, password_hash_scheme, role, status
      ) VALUES ('user-pin-1','pin@example.com','Pin','pin@example.com','Pin',
                'hash','scrypt-v1','admin','active');
      INSERT INTO work_items (id, project_id, created_by_user_id, title, objective)
      VALUES ('work-item-pin-1','${projectId}','user-pin-1','Pinned review item','Pinned review item');
      INSERT INTO work_conversations (id, project_id, work_item_id, created_by_user_id, kind, provider, model)
      VALUES ('conversation-pin-1','${projectId}','work-item-pin-1','user-pin-1','planning','anthropic','claude');
      INSERT INTO work_messages (
        id, project_id, work_item_id, conversation_id, initiated_by_user_id,
        actor_type, actor_id, role, sequence, parts, client_message_id, request_fingerprint
      ) VALUES ('message-pin-1','${projectId}','work-item-pin-1','conversation-pin-1','user-pin-1',
                'human','user-pin-1','user',1,'[{"type":"text","text":"Send this plan to QC."}]'::jsonb,
                'client-pin-1',repeat('4',64));
      INSERT INTO conversation_actions (
        id, project_id, work_item_id, conversation_id, initiated_by_user_id,
        actor_type, actor_id, source_message_id, action_type, payload, payload_hash,
        status, confirmed_by_user_id, confirmation_idempotency_key,
        confirmation_request_fingerprint, confirmed_at
      ) VALUES ('action-pin-1','${projectId}','work-item-pin-1','conversation-pin-1','user-pin-1',
                'human','user-pin-1','message-pin-1','send_plan_to_qc',
                '{"parameters":{"plan_version_id":"plan-version-pin-1","content_hash":"${"1".repeat(64)}"}}'::jsonb,
                repeat('3',64),'confirmed','user-pin-1','idempotency-pin-1',repeat('4',64),now());
      INSERT INTO work_plan_versions (
        id, project_id, work_item_id, conversation_id, created_by_user_id,
        version, status, plan, content_hash
      ) VALUES ('plan-version-pin-1','${projectId}','work-item-pin-1','conversation-pin-1','user-pin-1',
                1,'in_qc','{"objective":"Pinned review item","tasks":[]}'::jsonb,repeat('1',64));
      INSERT INTO planning_runs (
        id, project_id, status, round, max_rounds, objective, transcript,
        result, total_cost_usd, error, attachment_ids, worker_providers, mode,
        requested_by, initiated_by_user_id, pm_provider, pm_model, agent_provider, agent_model
      ) VALUES ('planning-run-pin-1','${projectId}','queued',0,3,'Pinned review item','[]'::jsonb,
                NULL,0,NULL,'[]'::jsonb,'both','review_only','user-pin-1','user-pin-1',
                'anthropic','claude','openai','gpt-4');
      INSERT INTO conversation_plan_reviews (
        id, project_id, work_item_id, conversation_id, action_id, plan_version_id,
        planning_run_id, initiated_by_user_id, attempt_number, pm_provider, pm_model,
        reviewer_provider, reviewer_model, usage_request_group_id, seed_plan,
        plan_content_hash, result_plan_content_hash, context_receipt, context_manifest,
        context_hash, qc_mode, qc_mode_source
      ) VALUES (
        'review-pin-1','${projectId}','work-item-pin-1','conversation-pin-1','action-pin-1',
        'plan-version-pin-1','planning-run-pin-1','user-pin-1',1,'anthropic','claude',
        'openai','gpt-4','review-pin-1','{"objective":"Pinned review item","tasks":[]}'::jsonb,
        repeat('1',64),repeat('1',64),'{}'::jsonb,'{"entries":[],"context_hash":"${"2".repeat(64)}"}'::jsonb,
        repeat('2',64),'gated_each_step','work_item'
      );
    `);

    const patch = await inject(
      server,
      "PATCH",
      `/api/v2/projects/${projectId}/planning-reviewer`,
      token,
      { qc_mode: "gated_when_contested" },
    );
    expect(patch.statusCode).toBe(204);

    const pinned = await pg.query<{ qc_mode: string; qc_mode_source: string }>(
      "SELECT qc_mode, qc_mode_source FROM conversation_plan_reviews WHERE id = 'review-pin-1'",
    );
    expect(pinned.rows[0]).toEqual({ qc_mode: "gated_each_step", qc_mode_source: "work_item" });
  });
});

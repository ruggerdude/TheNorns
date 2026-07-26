import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import {
  type V2MigrationDatabase,
  runCurrentV2Migrations,
  runV2Migrations,
} from "../src/persistence/v2/migrate.js";
import {
  InitiatorAttributionError,
  InitiatorAttributionService,
} from "../src/projects/initiatorAttribution.js";
import { PostgresProjectAccessRepository } from "../src/projects/projectAccessRepository.js";
import { registerProjectAccessRoutes } from "../src/projects/projectAccessRoutes.js";
import { ProjectAccessService } from "../src/projects/projectAccessService.js";

const migrationUrl = new URL("../drizzle/0031_project_access_attribution.sql", import.meta.url);

describe("project collaboration migration backfill", () => {
  it("assigns one deterministic owner without expanding historical access", async () => {
    const candidate = new PGlite();
    try {
      await candidate.exec(`
        CREATE ROLE norns_app NOLOGIN;
        CREATE TABLE norns_schema_migrations (
          name TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        INSERT INTO norns_schema_migrations (name, checksum)
        VALUES ('0027_knowledge_packages','prerequisite');
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE planning_runs (
          id TEXT PRIMARY KEY,
          requested_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE phases (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          planning_run_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          phase_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE agent_runs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          phase_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        INSERT INTO users (id, role, status, created_at) VALUES
          ('admin-old','admin','active','2026-01-01T00:00:00Z'),
          ('admin-new','admin','active','2026-02-01T00:00:00Z'),
          ('member','member','active','2026-03-01T00:00:00Z'),
          ('disabled','member','disabled','2026-04-01T00:00:00Z');
        INSERT INTO projects (id, status) VALUES ('legacy-project','active');
        INSERT INTO planning_runs (id, requested_by)
        VALUES ('legacy-quick-run','member');
      `);
      await runV2Migrations(candidate as unknown as V2MigrationDatabase, [
        {
          name: "0031_project_access_attribution",
          sql: await readFile(migrationUrl, "utf8"),
        },
      ]);

      const project = await candidate.query<{ owner_user_id: string | null }>(
        "SELECT owner_user_id FROM projects WHERE id='legacy-project'",
      );
      expect(project.rows[0]?.owner_user_id).toBe("admin-old");
      const members = await candidate.query<{ user_id: string }>(
        `SELECT user_id FROM project_members
         WHERE project_id='legacy-project' ORDER BY user_id`,
      );
      expect(members.rows.map((row) => row.user_id)).toEqual(["admin-old"]);
      const planning = await candidate.query<{ initiated_by_user_id: string | null }>(
        "SELECT initiated_by_user_id FROM planning_runs WHERE id='legacy-quick-run'",
      );
      expect(planning.rows[0]?.initiated_by_user_id).toBe("member");
    } finally {
      await candidate.close();
    }
  });
});

describe.sequential("project collaboration and initiator attribution", () => {
  let pg: PGlite;
  let service: ProjectAccessService;
  let attribution: InitiatorAttributionService;
  let app: FastifyInstance;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);

    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status, created_at
      ) VALUES
        ('admin-old','admin-old@example.com','Old Admin','admin-old@example.com','Old Admin',
         'hash','scrypt-v1','admin','active','2026-01-01T00:00:00Z'),
        ('admin-new','admin-new@example.com','New Admin','admin-new@example.com','New Admin',
         'hash','scrypt-v1','admin','active','2026-02-01T00:00:00Z'),
        ('owner','owner@example.com','Owner','owner@example.com','Owner',
         'hash','scrypt-v1','member','active','2026-03-01T00:00:00Z'),
        ('member-a','member-a@example.com','Member A','member-a@example.com','Member A',
         'hash','scrypt-v1','member','active','2026-04-01T00:00:00Z'),
        ('member-b','member-b@example.com','Member B','member-b@example.com','Member B',
         'hash','scrypt-v1','member','active','2026-05-01T00:00:00Z'),
        ('outsider','outsider@example.com','Outsider','outsider@example.com','Outsider',
         'hash','scrypt-v1','member','active','2026-06-01T00:00:00Z'),
        ('disabled','disabled@example.com','Disabled','disabled@example.com','Disabled',
         'hash','scrypt-v1','member','disabled','2026-07-01T00:00:00Z');

    `);

    await pg.exec(`
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES
        ('owned-project','Owned Project','active','assignment/default',
         'verification/default','budget/default','owner'),
        ('unowned-project','Unowned Project','active','assignment/default',
         'verification/default','budget/default',NULL);

      INSERT INTO project_members (
        project_id, user_id, status, added_by_user_id
      ) VALUES ('owned-project','member-a','active','owner');
    `);

    const transactions = new PGliteTransactionRunner(pg);
    service = new ProjectAccessService(new PostgresProjectAccessRepository(transactions));
    attribution = new InitiatorAttributionService(transactions);
    app = Fastify({ logger: false });
    registerProjectAccessRoutes(app, {
      service,
      requireIdentity: async (request, reply) => {
        const header = request.headers["x-test-user"];
        const id = Array.isArray(header) ? header[0] : header;
        if (!id) {
          reply.code(401).send({ error: "unauthorized" });
          return null;
        }
        return { id };
      },
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pg.close();
  });

  it("enforces owner/member/admin rules through the HTTP seam like a user", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v2/project-access" })).statusCode).toBe(
      401,
    );

    const memberAccess = await app.inject({
      method: "GET",
      url: "/api/v2/projects/owned-project/access",
      headers: { "x-test-user": "member-a" },
    });
    expect(memberAccess.statusCode).toBe(200);
    expect(memberAccess.json()).toMatchObject({
      can_access: true,
      can_manage_members: false,
      source: "membership",
    });

    const outsiderAccess = await app.inject({
      method: "GET",
      url: "/api/v2/projects/owned-project/access",
      headers: { "x-test-user": "outsider" },
    });
    expect(outsiderAccess.json()).toMatchObject({ can_access: false, source: "none" });

    const disabledAccess = await app.inject({
      method: "GET",
      url: "/api/v2/projects/owned-project/access",
      headers: { "x-test-user": "disabled" },
    });
    expect(disabledAccess.statusCode).toBe(401);
    expect(disabledAccess.json()).toMatchObject({ error: "identity_inactive" });

    const adminAccess = await app.inject({
      method: "GET",
      url: "/api/v2/projects/owned-project/access",
      headers: { "x-test-user": "admin-old" },
    });
    expect(adminAccess.json()).toMatchObject({
      can_access: true,
      can_manage_members: true,
      source: "admin",
    });

    const forbiddenCandidates = await app.inject({
      method: "GET",
      url: "/api/v2/projects/owned-project/member-candidates",
      headers: { "x-test-user": "member-a" },
    });
    expect(forbiddenCandidates.statusCode).toBe(403);

    const candidates = await app.inject({
      method: "GET",
      url: "/api/v2/projects/owned-project/member-candidates",
      headers: { "x-test-user": "owner" },
    });
    expect(candidates.statusCode).toBe(200);
    expect(candidates.json()).toMatchObject({
      candidates: [
        expect.objectContaining({ user_id: "member-b" }),
        expect.objectContaining({ user_id: "outsider" }),
      ],
    });

    const forbiddenAdd = await app.inject({
      method: "POST",
      url: "/api/v2/projects/owned-project/members",
      headers: { "x-test-user": "member-a" },
      payload: { user_id: "member-b" },
    });
    expect(forbiddenAdd.statusCode).toBe(403);

    const forbiddenTransfer = await app.inject({
      method: "PUT",
      url: "/api/v2/projects/owned-project/owner",
      headers: { "x-test-user": "member-a" },
      payload: { owner_user_id: "member-a" },
    });
    expect(forbiddenTransfer.statusCode).toBe(403);

    const adminAdded = await app.inject({
      method: "POST",
      url: "/api/v2/projects/owned-project/members",
      headers: { "x-test-user": "admin-old" },
      payload: { user_id: "outsider" },
    });
    expect(adminAdded.statusCode).toBe(200);
    const adminRemoved = await app.inject({
      method: "DELETE",
      url: "/api/v2/projects/owned-project/members/outsider",
      headers: { "x-test-user": "admin-old" },
    });
    expect(adminRemoved.statusCode).toBe(200);
    const adminCannotRemoveOwner = await app.inject({
      method: "DELETE",
      url: "/api/v2/projects/owned-project/members/owner",
      headers: { "x-test-user": "admin-old" },
    });
    expect(adminCannotRemoveOwner.statusCode).toBe(409);
    expect(adminCannotRemoveOwner.json()).toMatchObject({ error: "owner_cannot_be_removed" });
    const adminCannotReplaceActiveOwner = await app.inject({
      method: "PUT",
      url: "/api/v2/projects/owned-project/owner",
      headers: { "x-test-user": "admin-old" },
      payload: { owner_user_id: "member-a" },
    });
    expect(adminCannotReplaceActiveOwner.statusCode).toBe(409);
    expect(adminCannotReplaceActiveOwner.json()).toMatchObject({
      error: "ownership_recovery_required",
    });

    const added = await app.inject({
      method: "POST",
      url: "/api/v2/projects/owned-project/members",
      headers: { "x-test-user": "owner" },
      payload: { user_id: "member-b" },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({ owner_user_id: "owner" });
    expect(
      (added.json() as { members: Array<{ user_id: string; membership_status: string }> }).members,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ user_id: "member-b", membership_status: "active" }),
      ]),
    );

    const transferred = await app.inject({
      method: "PUT",
      url: "/api/v2/projects/owned-project/owner",
      headers: { "x-test-user": "owner" },
      payload: { owner_user_id: "member-b" },
    });
    expect(transferred.statusCode).toBe(200);
    expect(transferred.json()).toMatchObject({ owner_user_id: "member-b" });

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/v2/projects/owned-project/members/member-a",
      headers: { "x-test-user": "member-b" },
    });
    expect(removed.statusCode).toBe(200);
    expect(
      (removed.json() as { members: Array<{ user_id: string; membership_status: string }> })
        .members,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ user_id: "member-a", membership_status: "removed" }),
      ]),
    );

    const legacyClosed = await service.access("unowned-project", { id: "outsider" });
    expect(legacyClosed).toMatchObject({
      can_access: false,
      can_manage_members: false,
      source: "none",
    });
    await expect(
      service.assertCanAccess("unowned-project", { id: "outsider" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.access("owned-project", { id: "disabled" })).rejects.toMatchObject({
      code: "identity_inactive",
    });
    await expect(service.listAccessibleProjectIds({ id: "member-b" })).resolves.toContain(
      "owned-project",
    );
    await expect(service.listAccessibleProjectIds({ id: "outsider" })).resolves.not.toContain(
      "unowned-project",
    );
    await expect(service.listAccessibleProjectIds({ id: "admin-old" })).resolves.toEqual(
      expect.arrayContaining(["owned-project", "unowned-project"]),
    );
    await expect(service.access("unowned-project", { id: "admin-old" })).resolves.toMatchObject({
      can_access: true,
      can_manage_members: true,
      source: "admin",
    });
    const recovered = await service.transferOwnership(
      "unowned-project",
      { id: "admin-old" },
      "owner",
    );
    expect(recovered.owner_user_id).toBe("owner");
  });

  it("propagates one authenticated initiator through planning, phase, task, and run", async () => {
    await pg.exec(`
      INSERT INTO planning_runs (
        id, project_id, status, max_rounds, objective, mode, requested_by
      ) VALUES (
        'attribution-plan','owned-project','queued',2,'Build attributed work','planned','owner'
      );
      INSERT INTO phases (
        id, project_id, objective_summary, status, planning_run_id
      ) VALUES (
        'attribution-phase','owned-project','Attributed phase','proposed','attribution-plan'
      );
      INSERT INTO strategy_versions (
        id, project_id, phase_id, version, status, objective, content,
        convergence, content_hash
      ) VALUES (
        'attribution-strategy','owned-project','attribution-phase',1,'draft',
        'Attributed phase','{}'::jsonb,'pending',repeat('a',64)
      );
      INSERT INTO objectives (
        id, project_id, phase_id, outcome, success_measures, status
      ) VALUES (
        'attribution-objective','owned-project','attribution-phase','Attributed outcome',
        '["observable"]'::jsonb,'proposed'
      );
      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id,
        title, description, deliverables, acceptance_criteria,
        complexity, risk, required_roles, expected_outputs,
        environment_policy_ref, verification_policy_ref, state
      ) VALUES (
        'attribution-task','owned-project','attribution-phase','attribution-objective',
        'attribution-strategy','Attributed task','Implement it','["change"]'::jsonb,
        '["works"]'::jsonb,'M','medium','["implementation"]'::jsonb,
        '["commit"]'::jsonb,'environment/default','verification/default','pending'
      );
      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, workspace_id,
        repository_id, repository_display_name, default_branch,
        verification_policy_ref, created_by_actor_type
      ) VALUES (
        'attribution-binding','owned-project','local_runner','connected','runner-a','workspace-a',
        'repository-a','Attributed repository','main','verification/default','human'
      );
      INSERT INTO agent_profiles (
        id, provider, runtime, model, roles, context_limit_tokens, status, cost_metadata
      ) VALUES (
        'attribution-profile','openai','codex','gpt-5','["implementation"]'::jsonb,
        200000,'available','{}'::jsonb
      );
      INSERT INTO agent_assignments (
        id, project_id, phase_id, task_id, agent_profile_id, status,
        rationale, rationale_factors, allocation_policy_ref
      ) VALUES (
        'attribution-assignment','owned-project','attribution-phase','attribution-task',
        'attribution-profile','active','Capability fit','["capability"]'::jsonb,
        'assignment/default'
      );
      INSERT INTO agent_runs (
        id, project_id, phase_id, task_id, assignment_id, attempt, state,
        is_designated, repository_binding_id, expected_revision
      ) VALUES (
        'attribution-run','owned-project','attribution-phase','attribution-task',
        'attribution-assignment',1,'created',true,'attribution-binding','base-revision'
      );
    `);

    const result = await attribution.propagateFromPlanningRun("attribution-plan");
    expect(result).toEqual({
      planningRunId: "attribution-plan",
      initiatedByUserId: "owner",
      phasesAttributed: 0,
      tasksAttributed: 0,
      runsAttributed: 0,
    });

    const lineage = await pg.query<{
      planning_user: string | null;
      phase_user: string | null;
      task_user: string | null;
      run_user: string | null;
    }>(
      `SELECT planning.initiated_by_user_id AS planning_user,
              phase.initiated_by_user_id AS phase_user,
              task.initiated_by_user_id AS task_user,
              run.initiated_by_user_id AS run_user
       FROM planning_runs planning
       JOIN phases phase ON phase.planning_run_id=planning.id
       JOIN tasks task ON task.phase_id=phase.id
       JOIN agent_runs run ON run.task_id=task.id
       WHERE planning.id='attribution-plan'`,
    );
    expect(lineage.rows[0]).toEqual({
      planning_user: "owner",
      phase_user: "owner",
      task_user: "owner",
      run_user: "owner",
    });

    await expect(
      attribution.attributePlanningRun("attribution-plan", "member-b"),
    ).rejects.toBeInstanceOf(InitiatorAttributionError);
  });
});

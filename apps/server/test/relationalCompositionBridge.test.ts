import { PGlite } from "@electric-sql/pglite";
import { FakeAdapter, type LlmAdapter, type ProviderName } from "@norns/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { ProjectOnboardingService } from "../src/projects/projectOnboardingService.js";
import type {
  RemoteRepositoryDescriptor,
  RemoteRepositoryPort,
} from "../src/projects/remoteRepositoryPort.js";
import { SourceBindingService } from "../src/projects/sourceBindingService.js";
import { ProjectStore } from "../src/projects/store.js";
import { buildServer } from "../src/server.js";
import {
  RelationalCompositionBridge,
  RelationalCompositionConflictError,
} from "../src/startup/relationalCompositionBridge.js";
import { RelayStores } from "../src/stores.js";
import { LegacyIdentityService } from "../src/users/legacyIdentityService.js";
import { UserStore } from "../src/users/store.js";

const REMOTE: RemoteRepositoryDescriptor = {
  connection_id: "github-connection",
  repository_id: "4242",
  owner: "norns-test",
  name: "composition",
  full_name: "norns-test/composition",
  default_branch: "main",
  clone_url: "https://github.com/norns-test/composition.git",
  html_url: "https://github.com/norns-test/composition",
  installation_ready: true,
};

class StaticRemote implements RemoteRepositoryPort {
  resolveById(): Promise<RemoteRepositoryDescriptor> {
    return Promise.resolve(REMOTE);
  }

  findByName(): Promise<RemoteRepositoryDescriptor | null> {
    return Promise.resolve(null);
  }

  create(): Promise<RemoteRepositoryDescriptor> {
    return Promise.resolve(REMOTE);
  }
}

describe.sequential("relational composition matrix", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let users: UserStore;
  let projects: ProjectStore;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO service_connections (
        id, provider, display_name, owner_type, owner_login,
        external_account_id, installation_id, repository_selection,
        connected_by_user_id
      ) VALUES (
        'github-connection','github','norns-test','organization','norns-test',
        'account-composition','installation-composition','all','bootstrap-operator'
      )
    `);
    transactions = new PGliteTransactionRunner(pg);
    users = new UserStore();
    projects = new ProjectStore();
  });

  afterEach(async () => {
    await pg.close();
  });

  function bridge(
    identityAuthority: "legacy" | "relational",
    newProjectReadMode: "legacy" | "shadow" | "relational",
    newProjectWriteAuthority: "legacy" | "relational",
  ): RelationalCompositionBridge {
    return new RelationalCompositionBridge({
      transactions,
      users,
      projects,
      identityAuthority,
      newProjectReadMode,
      newProjectWriteAuthority,
    });
  }

  async function legacyActor() {
    const summary = users.createActive({
      email: "operator@example.com",
      name: "Operator",
      password: "test-password-1",
      role: "admin",
    });
    const token = users.login("operator@example.com", "test-password-1").token;
    const actor = await new LegacyIdentityService(users).userForToken(token);
    if (!actor) throw new Error("test actor was not authenticated");
    expect(actor.id).toBe(summary.id);
    return actor;
  }

  it("declares the production-default and relational route policies explicitly", async () => {
    const defaultComposition = bridge("legacy", "legacy", "legacy");
    const relationalComposition = bridge("relational", "relational", "relational");
    await defaultComposition.prepare();
    await relationalComposition.prepare();
    expect(defaultComposition.readiness()).toEqual({
      status: "ready",
      identity_authority: "legacy",
      new_project_read_mode: "legacy",
      new_project_write_authority: "legacy",
      compatibility_bridge: true,
      conflict: null,
    });
    expect(relationalComposition.readiness()).toEqual({
      status: "ready",
      identity_authority: "relational",
      new_project_read_mode: "relational",
      new_project_write_authority: "relational",
      compatibility_bridge: false,
      conflict: null,
    });
  });

  it("synchronizes an authoritative legacy credential upgrade without weakening identity checks", async () => {
    const actor = await legacyActor();
    const composition = bridge("legacy", "legacy", "legacy");
    const legacy = users.snapshot().users.find((user) => user.id === actor.id);
    if (!legacy) throw new Error("legacy actor disappeared from the snapshot");
    if (!legacy.passwordHash) throw new Error("legacy actor has no credential");
    const upgradedHash = legacy.passwordHash;
    const staleLegacyHash = `${"a".repeat(32)}:${"b".repeat(128)}`;
    await pg.query(
      `INSERT INTO users (
         id, username, display_name, email, name, password_hash,
         password_hash_scheme, role, status, source, source_record_id,
         created_at, updated_at
       ) VALUES (
         $1,$2,$3,$2,$3,$4,'legacy-scrypt-v0',$5,$6,
         'legacy_snapshot',$1,$7,$7
       )`,
      [
        actor.id,
        actor.email,
        actor.name,
        staleLegacyHash,
        actor.role,
        actor.status,
        actor.createdAt,
      ],
    );

    await composition.prepare();

    const result = await pg.query<{
      password_hash: string;
      password_hash_scheme: string;
      password_rehashed_at: Date | null;
      source: string;
      source_record_id: string | null;
    }>(
      `SELECT password_hash, password_hash_scheme, password_rehashed_at,
              source, source_record_id
       FROM users
       WHERE id = $1`,
      [actor.id],
    );
    expect(result.rows[0]).toMatchObject({
      password_hash: upgradedHash,
      password_hash_scheme: "scrypt-v1",
      source: "legacy_snapshot",
      source_record_id: actor.id,
    });
    expect(result.rows[0]?.password_rehashed_at).not.toBeNull();
  });

  it("anchors an existing legacy local project before the relational source FK is written", async () => {
    const actor = await legacyActor();
    const composition = bridge("legacy", "legacy", "legacy");
    await composition.ensureActor(actor);
    const project = projects.create({
      name: "Existing local",
      description: "A legacy-authoritative local project",
      pmProvider: "anthropic",
      sourceType: "local",
      sourceLocation: "repository",
    });

    await composition.ensureProjectAnchor(project);
    await new SourceBindingService(transactions).createLocal({
      project_id: project.id,
      runner_id: "runner-local",
      workspace_id: "workspace-local",
      repository_id: "repository-local",
      repository_display_name: "repository",
      default_branch: "main",
      observed_head: "a".repeat(40),
      verification_policy_ref: "verification/default",
      created_by: { actor_type: "human", actor_id: actor.id },
    });

    const binding = await pg.query<{ project_id: string }>(
      "SELECT project_id FROM repository_bindings WHERE project_id = $1",
      [project.id],
    );
    expect(binding.rows).toEqual([{ project_id: project.id }]);
  });

  it("anchors a legacy-visible project before starting relational Phase planning", async () => {
    const actor = await legacyActor();
    const token = users.login(actor.email, "test-password-1").token;
    const composition = bridge("legacy", "legacy", "legacy");
    await composition.prepare();
    const project = projects.create({
      name: "Legacy planning project",
      description: "Visible through the legacy project authority",
      pmProvider: "anthropic",
    });
    const pm = new FakeAdapter("anthropic");
    pm.enqueue({
      objective: "Correct the empty-state grammar",
      modules: [
        {
          id: "copy-fix",
          title: "Correct copy",
          description: "Apply the requested grammar correction.",
          deliverables: ["apps/web/src/App.tsx"],
          acceptance: [
            {
              id: "AC-1",
              statement: "The corrected copy is visible.",
              verification_type: "command",
              verification: "pnpm test",
            },
          ],
          dependencies: [],
          estimated_complexity: "S",
          risk: "low",
        },
      ],
    });
    const server = await buildServer({
      stores: new RelayStores(),
      users,
      projects,
      relationalComposition: composition,
      planningRuns: { transactions },
      integrationEnvironment: {
        ANTHROPIC_API_KEY: "test-anthropic",
        NORNS_RUNNER_ALLOWED_MODELS: "anthropic/claude-fable-5",
      },
      createPlanningAdapter: (_provider: ProviderName): LlmAdapter => pm,
    });

    try {
      const response = await server.app.inject({
        method: "POST",
        url: `/api/v2/projects/${project.id}/planning-runs`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          objective: "Correct the empty-state grammar",
          mode: "quick",
          review_rounds: 0,
        },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        planning_run_id: expect.any(String),
      });
      const relational = await pg.query<{ id: string; name: string }>(
        "SELECT id, name FROM projects WHERE id = $1",
        [project.id],
      );
      expect(relational.rows).toEqual([{ id: project.id, name: project.name }]);
      const runs = await pg.query<{ project_id: string; mode: string }>(
        "SELECT project_id, mode FROM planning_runs WHERE project_id = $1",
        [project.id],
      );
      expect(runs.rows).toEqual([{ project_id: project.id, mode: "quick" }]);
    } finally {
      await server.app.close();
    }
  });

  it("returns the structured composition conflict when Phase planning cannot anchor a legacy project", async () => {
    const actor = await legacyActor();
    const token = users.login(actor.email, "test-password-1").token;
    const composition = bridge("legacy", "legacy", "legacy");
    await composition.prepare();
    const project = projects.create({
      name: "Legacy planning project",
      description: "Legacy metadata",
      pmProvider: "anthropic",
    });
    await pg.query(
      `INSERT INTO projects (
         id, name, description, status, assignment_policy_ref,
         verification_policy_ref, budget_policy_ref
       ) VALUES ($1,'Conflicting relational name','Relational metadata','active',
                 'assignment/default','verification/default','budget/default')`,
      [project.id],
    );
    await pg.query(
      `INSERT INTO project_planning_preferences (
         project_id, pm_provider, pm_model, reviewer_provider, source
       ) VALUES ($1,'anthropic','claude-sonnet-5','openai','native')`,
      [project.id],
    );
    const server = await buildServer({
      stores: new RelayStores(),
      users,
      projects,
      relationalComposition: composition,
      planningRuns: { transactions },
    });

    try {
      const response = await server.app.inject({
        method: "POST",
        url: `/api/v2/projects/${project.id}/planning-runs`,
        headers: { authorization: `Bearer ${token}` },
        payload: { objective: "Start work" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: "persistence_composition_conflict",
        code: "relational_project_conflict",
        operation: "project_anchor",
        action: expect.stringContaining("Reconcile"),
      });
      const runs = await pg.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM planning_runs WHERE project_id = $1",
        [project.id],
      );
      expect(runs.rows[0]?.count).toBe(0);
    } finally {
      await server.app.close();
    }
  });

  it.each(["new_repo", "existing_repo"] as const)(
    "keeps a %s GitHub onboarding project visible through legacy reads",
    async (scenario) => {
      const actor = await legacyActor();
      const composition = bridge("legacy", "legacy", "legacy");
      await composition.ensureActor(actor);
      const onboarding = new ProjectOnboardingService({
        transactions,
        remotes: new StaticRemote(),
      });
      const base = {
        name: `${scenario} project`,
        description: "Composition coverage",
        pm_provider: "openai" as const,
        pm_model: "gpt-5.6-sol" as const,
        actor: { actor_type: "human" as const, actor_id: actor.id },
        idempotency_key: `composition-${scenario}`,
        connection_id: REMOTE.connection_id,
      };
      const result =
        scenario === "new_repo"
          ? await onboarding.createNewRepo({
              ...base,
              repository_name: REMOTE.name,
              private: true,
            })
          : await onboarding.createFromExistingRepo({
              ...base,
              repository_id: REMOTE.repository_id,
            });

      await composition.mirrorOnboardedProject({
        project_id: result.project_id,
        scenario,
        name: base.name,
        description: base.description,
        pm_provider: base.pm_provider,
        pm_model: base.pm_model,
        connection_id: base.connection_id,
        repository_id: REMOTE.repository_id,
        default_branch: REMOTE.default_branch,
        github_url: result.workspace?.github?.url ?? null,
      });

      expect(projects.summary(result.project_id)).toMatchObject({
        id: result.project_id,
        name: base.name,
        source_type: "github",
        onboarding_scenario: scenario,
        workspace_location: "github.com/norns-test/composition",
        remote_location: "github.com/norns-test/composition",
      });
    },
  );

  it.each(["legacy", "relational"] as const)(
    "allows approvals to reference a %s identity authority",
    async (authority) => {
      const actor = await legacyActor();
      const composition = bridge(authority, "legacy", "legacy");
      if (authority === "legacy") {
        await composition.ensureActor(actor);
      } else {
        const legacy = users.snapshot().users[0];
        await pg.query(
          `INSERT INTO users (
             id, username, display_name, email, name, password_hash,
             password_hash_scheme, role, status, source, source_record_id,
             created_at, updated_at
           ) VALUES ($1,$2,$3,$2,$3,$4,'scrypt-v1',$5,'active','native',NULL,$6,$6)`,
          [actor.id, actor.email, actor.name, legacy?.passwordHash, actor.role, actor.createdAt],
        );
        await composition.ensureActor(actor);
      }
      const project = projects.create({
        name: `${authority} approval`,
        description: "Approval FK coverage",
        pmProvider: "anthropic",
      });
      await composition.ensureProjectAnchor(project);
      await pg.query(
        `INSERT INTO approvals (
           id, project_id, phase_id, kind, subject_entity_type,
           subject_entity_id, actor_id, content_hash, status, approved_at
         ) VALUES ($1,$2,NULL,'strategy','strategy_version',$3,$4,$5,'active',$6)`,
        [
          `approval-${authority}`,
          project.id,
          `strategy-${authority}`,
          actor.id,
          "a".repeat(64),
          "2026-07-25T00:00:00.000Z",
        ],
      );
      const approval = await pg.query<{ actor_id: string }>(
        "SELECT actor_id FROM approvals WHERE id = $1",
        [`approval-${authority}`],
      );
      expect(approval.rows).toEqual([{ actor_id: actor.id }]);
    },
  );

  it("returns actionable diagnostics when an existing relational actor disagrees", async () => {
    const actor = await legacyActor();
    await pg.query(
      `INSERT INTO users (
         id, username, display_name, email, name, password_hash,
         password_hash_scheme, role, status, source, source_record_id
       ) VALUES ($1,'different@example.com','Different','different@example.com','Different',
                 $2,'scrypt-v1','admin','active','native',NULL)`,
      [actor.id, users.snapshot().users[0]?.passwordHash],
    );
    const error = await bridge("legacy", "legacy", "legacy")
      .ensureActor(actor)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RelationalCompositionConflictError);
    expect((error as RelationalCompositionConflictError).diagnostic()).toMatchObject({
      error: "persistence_composition_conflict",
      code: "relational_actor_conflict",
      operation: "identity_bridge",
      action: expect.stringContaining("Reconcile"),
    });
  });

  it("surfaces composition conflicts through HTTP instead of a generic 409", async () => {
    const actor = await legacyActor();
    const token = users.login(actor.email, "test-password-1").token;
    await pg.query(
      `INSERT INTO users (
         id, username, display_name, email, name, password_hash,
         password_hash_scheme, role, status, source, source_record_id
       ) VALUES ($1,'other@example.com','Other','other@example.com','Other',
                 $2,'scrypt-v1','admin','active','native',NULL)`,
      [actor.id, users.snapshot().users[0]?.passwordHash],
    );
    const server = await buildServer({
      stores: new RelayStores(),
      users,
      projects,
      relationalComposition: bridge("legacy", "legacy", "legacy"),
    });
    try {
      const response = await server.app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: "persistence_composition_conflict",
        code: "relational_actor_conflict",
        operation: "identity_bridge",
        action: expect.stringContaining("Reconcile"),
      });
    } finally {
      await server.app.close();
    }
  });
});

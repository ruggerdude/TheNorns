import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { AttentionService } from "../src/projects/attentionService.js";
import { ProjectStore } from "../src/projects/store.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

describe.sequential("Phase 5 authenticated attention API", () => {
  let pg: PGlite;
  let server: NornsServer;
  let token: string;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE norns_state (key TEXT PRIMARY KEY, snapshot JSONB NOT NULL,
                                updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    `);
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    const users = new UserStore();
    token = testAdminToken(users);
    const user = users.list()[0];
    if (!user) throw new Error("missing test user");
    await pg.query(
      `INSERT INTO users (
         id,username,display_name,email,name,password_hash,password_hash_scheme,role,status
       ) VALUES ($1,$2,$3,$2,$3,'hash','scrypt-v1','admin','active')`,
      [user.id, user.email, user.name ?? "Admin"],
    );
    await pg.exec(`
      INSERT INTO projects (
        id,name,description,status,assignment_policy_ref,verification_policy_ref,budget_policy_ref
      ) VALUES ('project-1','Project One','','active','assignment','verification','budget');
    `);
    const transactions = new PGliteTransactionRunner(pg);
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new ProjectStore(),
      phase5: { attention: new AttentionService(transactions) },
    });
  });

  afterEach(async () => {
    await server.app.close();
    await pg.close();
  });

  it("requires a session and returns normalized portfolio health", async () => {
    expect((await server.app.inject({ method: "GET", url: "/api/v2/attention" })).statusCode).toBe(
      401,
    );
    const response = await server.app.inject({
      method: "GET",
      url: "/api/v2/attention",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      counts: { active_projects: 1, critical: 0 },
      projects: [{ id: "project-1", health: "healthy", attention_count: 0 }],
      items: [],
    });
  });
});

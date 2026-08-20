import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresConversationRepository } from "../src/conversations/repository.js";
import { ConversationService } from "../src/conversations/service.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const asMigrationDatabase = (database: PGlite): V2MigrationDatabase =>
  database as unknown as V2MigrationDatabase;

// Quick and phased are ONE flow (plan → implement); quick just waives QC. Both
// build the same planning workspace — the only durable difference is
// work_items.workflow, which the plan-approval seam reads to auto-waive QC for
// quick. There is no separate "executing, plan-less" quick dead end anymore.
describe.sequential("quick work-item workspace (phased minus QC)", () => {
  const actor = { id: "quick-owner" };
  let pg: PGlite;
  let conversations: ConversationService;
  let idSequence = 0;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(asMigrationDatabase(pg));
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES (
        'quick-owner', 'quick-owner@example.com', 'Quick Owner',
        'quick-owner@example.com', 'Quick Owner', 'hash', 'scrypt-v1',
        'member', 'active'
      );
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES (
        'quick-project', 'Quick Project', 'active',
        'assignment/default', 'verification/default', 'budget/default',
        'quick-owner'
      );
    `);
    const transactions = new PGliteTransactionRunner(pg);
    conversations = new ConversationService(new PostgresConversationRepository(transactions), {
      newId: (prefix) => `${prefix}-quick-${++idSequence}`,
    });
  }, 60_000);

  afterAll(async () => {
    await pg.close();
  });

  it("a quick push builds a planning workspace tagged workflow='quick', not an executing dead end", async () => {
    const created = await conversations.createPlanningWorkspace(
      actor,
      {
        project_id: "quick-project",
        title: "Fix the compact header",
        objective: "Increase the compact header hit target without changing navigation.",
        workflow: "quick",
      },
      { provider: "openai", model: "gpt-5.6-terra" },
    );

    // A real plan-first workspace: 'planning' status, no premature 'executing',
    // and a planning conversation — identical to phased except the workflow tag.
    expect(created.work_item).toMatchObject({
      project_id: "quick-project",
      status: "planning",
      workflow: "quick",
      planning_run_id: null,
      phase_id: null,
      execution_started_at: null,
    });
    expect(created.conversation).toMatchObject({
      work_item_id: created.work_item.id,
      kind: "planning",
      status: "active",
    });
  });

  it("defaults to phased when no workflow is given", async () => {
    const created = await conversations.createPlanningWorkspace(
      actor,
      {
        project_id: "quick-project",
        title: "Adjust button copy",
        objective: "Change the submit label to Start development.",
      },
      { provider: "openai", model: "gpt-5.6-terra" },
    );
    expect(created.work_item.workflow).toBe("phased");
    expect(created.work_item.status).toBe("planning");
  });
});

import { V2StartPhaseCommand, V2WorkPlanContract } from "@norns/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationPlanWorkflowService } from "../src/conversations/planWorkflow.js";
import { ConversationPmUpdateScheduler } from "../src/conversations/pmUpdateScheduler.js";
import { PostgresConversationRepository } from "../src/conversations/repository.js";
import { ConversationService } from "../src/conversations/service.js";
import { canonicalSha256 } from "../src/persistence/migration/canonicalJson.js";
import { executeV2ApplicationCommand } from "../src/persistence/v2/application.js";
import { NodePgTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { SqlV2ApplicationTransaction } from "../src/persistence/v2/sqlRepositories.js";

const databaseUrl = process.env.V2_POSTGRES_TEST_URL;
const postgresDescribe = databaseUrl ? describe.sequential : describe.skip;

const realPgPlan = V2WorkPlanContract.parse({
  plan: {
    objective: "Prove plan confirmation concurrency.",
    assumptions: [],
    modules: [
      {
        id: "concurrency",
        title: "Concurrency",
        description: "Verify exact-once plan actions.",
        deliverables: ["Real PostgreSQL evidence"],
        acceptance: [
          {
            id: "real-pg-pass",
            statement: "Concurrent confirmation creates one effect.",
            verification_type: "test",
            verification: "Run the real PostgreSQL suite.",
          },
        ],
        dependencies: [],
        estimated_complexity: "S",
        risk: "low",
      },
    ],
    risks: [],
    out_of_scope: [],
  },
  staffing: [
    {
      module_id: "concurrency",
      agent_role: "implementation",
      provider: "openai",
      model: "gpt-5.6-sol",
    },
  ],
  verification_requirements: ["Real PostgreSQL concurrency passes."],
  open_decisions: [],
  estimated_budget: { currency: "USD", amount: 5 },
});

postgresDescribe("V2 real PostgreSQL concurrency evidence", () => {
  let administrationPool: Pool;
  let applicationPool: Pool;
  let privilegedRunner: NodePgTransactionRunner;
  let runtimeRunner: NodePgTransactionRunner;
  let databaseUser: string;
  let runtimeRoleMembershipAdded = false;
  let schemaName: string;
  let conversationService: ConversationService;
  let conversationWorkItemId: string;
  let conversationId: string;
  let conversationMessageId: string;
  let conversationIdSequence = 0;

  beforeAll(async () => {
    if (!databaseUrl) return;
    administrationPool = new Pool({ connectionString: databaseUrl, max: 2 });
    const identity = await administrationPool.query<{ current_user: string }>(
      "SELECT current_user",
    );
    databaseUser = identity.rows[0]?.current_user ?? "";
    // norns_app is a deployment-level role shared by all isolated real-PG
    // suites. Provision it race-safely and leave it in place for peer files.
    await administrationPool.query(`
      DO $role$
      BEGIN
        CREATE ROLE norns_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN
        NULL;
      END
      $role$;
    `);
    const membership = await administrationPool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1
         FROM pg_auth_members AS membership
         JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
         JOIN pg_roles AS member_role ON member_role.oid = membership.member
         WHERE granted_role.rolname = 'norns_app'
           AND member_role.rolname = current_user
       ) AS exists`,
    );
    runtimeRoleMembershipAdded = !membership.rows[0]?.exists;
    if (runtimeRoleMembershipAdded) {
      await administrationPool.query(`GRANT norns_app TO "${databaseUser.replaceAll('"', '""')}"`);
    }

    schemaName = `norns_v2_${process.pid}_${Date.now()}`;
    await administrationPool.query(`CREATE SCHEMA ${schemaName}`);
    applicationPool = new Pool({
      connectionString: databaseUrl,
      max: 6,
      options: `-c search_path=${schemaName}`,
    });
    privilegedRunner = new NodePgTransactionRunner(applicationPool, { mode: "privileged" });
    runtimeRunner = new NodePgTransactionRunner(applicationPool, {
      mode: "runtime",
      role: "norns_app",
    });
    const migrationDatabase: V2MigrationDatabase = {
      query: async <TRow = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const result = await applicationPool.query(sql, params);
        return result.rowCount === null
          ? { rows: result.rows as TRow[] }
          : { rows: result.rows as TRow[], affectedRows: result.rowCount };
      },
      transaction: (work) => privilegedRunner.transaction(work),
    };
    await applicationPool.query(`
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await runCurrentV2Migrations(migrationDatabase);
    await applicationPool.query(`
      INSERT INTO projection_checkpoints (
        projection_name, partition_key, version
      ) VALUES ('concurrency-probe', 'shared', 1);
      INSERT INTO users (
        id, username, display_name, email, password_hash, password_hash_scheme,
        role, status
      ) VALUES (
        'conversation-concurrency-user', 'conversation-concurrency@example.com',
        'Conversation Concurrency', 'conversation-concurrency@example.com',
        'hash', 'scrypt-v1', 'member', 'active'
      );
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES (
        'conversation-concurrency-project', 'Conversation concurrency', 'active',
        'assignment/default', 'verification/default', 'budget/default',
        'conversation-concurrency-user'
      );
      INSERT INTO phases (
        id,project_id,objective_summary,priority,status,approved_budget_usd,
        initiated_by_user_id
      ) VALUES (
        'pm-concurrency-phase','conversation-concurrency-project',
        'Prove deterministic PM update concurrency',1,'awaiting_approval',1,
        'conversation-concurrency-user'
      );
      INSERT INTO work_items (
        id,project_id,created_by_user_id,title,objective,status,phase_id,
        execution_started_at
      ) VALUES (
        'pm-concurrency-work','conversation-concurrency-project',
        'conversation-concurrency-user','PM concurrency proof',
        'Emit one deterministic update across competing schedulers','executing',
        'pm-concurrency-phase',now()
      );
      INSERT INTO work_conversations (
        id,project_id,work_item_id,created_by_user_id,kind,status,provider,model
      ) VALUES (
        'pm-concurrency-execution','conversation-concurrency-project',
        'pm-concurrency-work','conversation-concurrency-user',
        'execution_pm','active','openai','gpt-5.6-sol'
      );
    `);
    conversationService = new ConversationService(
      new PostgresConversationRepository(runtimeRunner),
      {
        newId: (prefix) => `${prefix}-real-pg-${++conversationIdSequence}`,
      },
    );
    const workItem = await conversationService.createWorkItem(
      { id: "conversation-concurrency-user" },
      {
        project_id: "conversation-concurrency-project",
        title: "Concurrency proof",
        objective: "Prove ordering and action idempotency on real PostgreSQL.",
      },
    );
    conversationWorkItemId = workItem.id;
    const conversation = await conversationService.createConversation(
      { id: "conversation-concurrency-user" },
      {
        project_id: "conversation-concurrency-project",
        work_item_id: workItem.id,
        kind: "planning",
        provider: "openai",
        model: "gpt-5.6-sol",
      },
    );
    conversationId = conversation.id;
    const message = await conversationService.submitUserMessage(
      { id: "conversation-concurrency-user" },
      {
        project_id: "conversation-concurrency-project",
        work_item_id: workItem.id,
        conversation_id: conversation.id,
        client_message_id: "real-pg-initial-message",
        parts: [{ type: "text", format: "plain", text: "Plan this work." }],
      },
    );
    conversationMessageId = message.id;
  }, 30_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    await applicationPool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    if (runtimeRoleMembershipAdded) {
      await administrationPool.query(
        `REVOKE norns_app FROM "${databaseUser.replaceAll('"', '""')}"`,
      );
    }
    await administrationPool.end();
  });

  it("uses the isolated current schema and the restricted runtime role operationally", async () => {
    const identity = await runtimeRunner.transaction((tx) =>
      tx.query<{ current_schema: string; current_user: string }>(
        "SELECT current_schema(), current_user",
      ),
    );
    expect(identity.rows[0]).toEqual({
      current_schema: schemaName,
      current_user: "norns_app",
    });

    const schemaPrivilege = await administrationPool.query<{ allowed: boolean }>(
      "SELECT has_schema_privilege('norns_app', $1, 'USAGE') AS allowed",
      [schemaName],
    );
    expect(schemaPrivilege.rows[0]?.allowed).toBe(true);

    await runtimeRunner.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO projects (
           id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
         ) VALUES (
           'runtime-project', 'Runtime project', 'active',
           'assignment/default', 'verification/default', 'budget/default'
         )`,
      );
      await tx.query(
        `UPDATE projects
         SET description = 'updated through norns_app'
         WHERE id = 'runtime-project'`,
      );
      await tx.query(
        `INSERT INTO domain_events (
           event_id, stream_type, stream_id, stream_version, event_type,
           project_id, actor_type, actor_id, correlation_id, occurred_at, payload
         ) VALUES (
           'runtime-domain-event', 'project', 'runtime-project', 1, 'ProjectCreated',
           'runtime-project', 'system', 'coordinator', 'runtime-role-proof',
           now(), '{}'::jsonb
         )`,
      );
      await tx.query(
        `INSERT INTO audit_events (
           audit_id, audit_type, project_id, actor_type, actor_id, outcome,
           severity, correlation_id, occurred_at, summary
         ) VALUES (
           'runtime-audit-event', 'project.created', 'runtime-project', 'system',
           'coordinator', 'succeeded', 'info', 'runtime-role-proof', now(),
           'Runtime role inserted immutable history'
         )`,
      );
    });

    const project = await applicationPool.query<{ description: string }>(
      "SELECT description FROM projects WHERE id = 'runtime-project'",
    );
    expect(project.rows[0]?.description).toBe("updated through norns_app");

    await expect(
      runtimeRunner.transaction((tx) =>
        tx.query(
          `UPDATE domain_events
           SET event_type = 'Changed'
           WHERE event_id = 'runtime-domain-event'`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runtimeRunner.transaction((tx) =>
        tx.query("DELETE FROM audit_events WHERE audit_id = 'runtime-audit-event'"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runtimeRunner.transaction((tx) => tx.query("TRUNCATE domain_events")),
    ).rejects.toThrow(/permission denied/);
  });

  it("returns command_in_progress across two real connections and later replays one result", async () => {
    const command = V2StartPhaseCommand.parse({
      schema_version: 2,
      kind: "start_phase",
      command_id: "command-real-concurrency",
      command_family: "phase",
      actor: { actor_type: "human", actor_id: "user-1" },
      idempotency_key: "real-concurrency-key",
      correlation_id: "correlation-real-concurrency",
      causation_id: null,
      issued_at: "2026-07-16T18:30:00.000Z",
      project_id: "project-1",
      phase_id: "phase-1",
      expected_project_version: 1,
      expected_phase_version: 1,
    });

    let mutations = 0;
    let releaseMutation = (): void => {};
    let markMutationEntered = (): void => {};
    const mutationEntered = new Promise<void>((resolve) => {
      markMutationEntered = resolve;
    });
    const mutationRelease = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const execute = () =>
      executeV2ApplicationCommand({
        command,
        transactionRunner: runtimeRunner,
        transactionFactory: {
          bind: (sql) => new SqlV2ApplicationTransaction(sql),
        },
        mutate: async () => {
          mutations += 1;
          markMutationEntered();
          await mutationRelease;
          return {
            outcome: "succeeded" as const,
            http_status: 200,
            body: { phase_id: "phase-1" },
          };
        },
      });

    const firstPromise = execute();
    await mutationEntered;
    const concurrent = await execute();
    expect(concurrent).toEqual({
      kind: "command_in_progress",
      command_id: null,
    });

    releaseMutation();
    const first = await firstPromise;
    expect(first.kind).toBe("executed");
    expect(mutations).toBe(1);

    const retry = await execute();
    expect(retry.kind).toBe("replayed");
    expect(mutations).toBe(1);
    expect(retry.kind === "replayed" && first.kind === "executed" ? retry.response : null).toEqual(
      first.kind === "executed" ? first.response : null,
    );
  });

  it("uses real BEGIN/COMMIT/ROLLBACK and blocks FOR UPDATE across connections", async () => {
    let firstBackendPid = 0;
    let secondBackendPid = 0;
    let releaseFirst = (): void => {};
    let markLocked = (): void => {};
    let markSecondStarted = (): void => {};
    const firstLocked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runtimeRunner.transaction(async (tx) => {
      const identity = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      firstBackendPid = identity.rows[0]?.pid ?? 0;
      await tx.query(
        `SELECT version
         FROM projection_checkpoints
         WHERE projection_name = 'concurrency-probe' AND partition_key = 'shared'
         FOR UPDATE`,
      );
      markLocked();
      await firstRelease;
      await tx.query(
        `UPDATE projection_checkpoints
         SET version = version + 1
         WHERE projection_name = 'concurrency-probe' AND partition_key = 'shared'`,
      );
    });
    await firstLocked;

    const second = runtimeRunner.transaction(async (tx) => {
      const identity = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      secondBackendPid = identity.rows[0]?.pid ?? 0;
      markSecondStarted();
      await tx.query(
        `SELECT version
         FROM projection_checkpoints
         WHERE projection_name = 'concurrency-probe' AND partition_key = 'shared'
         FOR UPDATE`,
      );
      await tx.query(
        `UPDATE projection_checkpoints
         SET version = version + 1
         WHERE projection_name = 'concurrency-probe' AND partition_key = 'shared'`,
      );
    });
    await secondStarted;

    let waiting:
      | {
          blockers: number[];
          wait_event: string | null;
          wait_event_type: string | null;
        }
      | undefined;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const activity = await administrationPool.query<{
        blockers: number[];
        wait_event: string | null;
        wait_event_type: string | null;
      }>(
        `SELECT pg_blocking_pids(pid) AS blockers, wait_event, wait_event_type
         FROM pg_stat_activity
         WHERE pid = $1`,
        [secondBackendPid],
      );
      const observed = activity.rows[0];
      if (observed?.wait_event_type === "Lock" && observed.blockers.length > 0) {
        waiting = observed;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waiting).toMatchObject({
      wait_event_type: "Lock",
    });
    expect(waiting?.blockers).toContain(firstBackendPid);
    expect(waiting?.wait_event).toMatch(/transactionid|tuple/);

    releaseFirst();
    await Promise.all([first, second]);

    const committed = await applicationPool.query<{ version: number }>(
      `SELECT version
       FROM projection_checkpoints
       WHERE projection_name = 'concurrency-probe' AND partition_key = 'shared'`,
    );
    expect(committed.rows[0]?.version).toBe(3);

    await expect(
      runtimeRunner.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO projection_checkpoints (
             projection_name, partition_key, version
           ) VALUES ('rollback-probe', 'shared', 1)`,
        );
        throw new Error("rollback probe");
      }),
    ).rejects.toThrow("rollback probe");
    const rolledBack = await applicationPool.query<{ present: boolean }>(
      `SELECT EXISTS(
         SELECT 1
         FROM projection_checkpoints
         WHERE projection_name = 'rollback-probe' AND partition_key = 'shared'
       ) AS present`,
    );
    expect(rolledBack.rows[0]?.present).toBe(false);
  });

  it("lets one of two real-connection PM schedulers emit a stable transition and makes the loser retry-safe", async () => {
    const asOf = "2100-01-01T00:00:00.000Z";
    const [left, right] = await Promise.all([
      new ConversationPmUpdateScheduler(runtimeRunner).tick(asOf),
      new ConversationPmUpdateScheduler(runtimeRunner).tick(asOf),
    ]);
    const results = [left, right];
    const emitted = results.filter((evaluation) => evaluation?.emitted);
    expect(emitted).toHaveLength(1);
    expect(results.filter((evaluation) => evaluation === null)).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      conversation_id: "pm-concurrency-execution",
      emitted: true,
      transition_sequence: 1,
      message_id: "message:conversation-pm-update:pm-concurrency-execution:1",
    });

    await expect(new ConversationPmUpdateScheduler(runtimeRunner).tick(asOf)).resolves.toBeNull();
    const durable = await applicationPool.query<{
      updates: number;
      messages: number;
      evaluation_count: number;
      transition_count: number;
      transition_sequence: number;
      update_id: string;
    }>(
      `SELECT
         (SELECT count(*)::int FROM conversation_pm_updates
           WHERE conversation_id='pm-concurrency-execution') AS updates,
         (SELECT count(*)::int FROM work_messages
           WHERE conversation_id='pm-concurrency-execution'
             AND actor_id='deterministic-pm-update') AS messages,
         cursor.evaluation_count::int,
         cursor.transition_count::int,
         update.transition_sequence::int,
         update.id AS update_id
       FROM conversation_pm_update_cursors cursor
       JOIN conversation_pm_updates update
         ON update.conversation_id=cursor.conversation_id
      WHERE cursor.conversation_id='pm-concurrency-execution'`,
    );
    expect(durable.rows[0]).toEqual({
      updates: 1,
      messages: 1,
      evaluation_count: 1,
      transition_count: 1,
      transition_sequence: 1,
      update_id: "conversation-pm-update:pm-concurrency-execution:1",
    });
  });

  it("serializes conversation ordering and confirmation idempotency across real connections", async () => {
    const actor = { id: "conversation-concurrency-user" };
    const submitted = await Promise.all(
      ["first concurrent message", "second concurrent message"].map((text, index) =>
        conversationService.submitUserMessage(actor, {
          project_id: "conversation-concurrency-project",
          work_item_id: conversationWorkItemId,
          conversation_id: conversationId,
          client_message_id: `real-pg-concurrent-message-${index}`,
          parts: [{ type: "text", format: "plain", text }],
        }),
      ),
    );
    expect(submitted.map((message) => message.sequence).sort()).toEqual([2, 3]);

    const action = await conversationService.proposeAction(actor, {
      project_id: "conversation-concurrency-project",
      work_item_id: conversationWorkItemId,
      conversation_id: conversationId,
      source_message_id: conversationMessageId,
      action_type: "send_plan_to_qc",
      payload: {
        parameters: {
          plan_version_id: "real-pg-plan",
          content_hash: "a".repeat(64),
        },
      },
    });
    const confirmation = {
      project_id: "conversation-concurrency-project",
      work_item_id: conversationWorkItemId,
      conversation_id: conversationId,
      action_id: action.id,
      idempotency_key: "real-pg-same-action-key",
    };
    const [confirmed, replayed] = await Promise.all([
      conversationService.confirmAction(actor, confirmation),
      conversationService.confirmAction(actor, confirmation),
    ]);
    expect(replayed).toEqual(confirmed);
    expect(confirmed.confirmation_request_fingerprint).toBe(
      canonicalSha256({
        action_id: action.id,
        action_type: action.action_type,
        payload_hash: action.payload_hash,
      }),
    );

    const competingActions = await Promise.all(
      ["pause_work" as const, "resume_work" as const].map((actionType) =>
        conversationService.proposeAction(actor, {
          project_id: "conversation-concurrency-project",
          work_item_id: conversationWorkItemId,
          conversation_id: conversationId,
          source_message_id: conversationMessageId,
          action_type: actionType,
          payload: { parameters: { reason: "real PostgreSQL concurrency fixture" } },
        }),
      ),
    );
    const competing = await Promise.allSettled(
      competingActions.map((candidate) =>
        conversationService.confirmAction(actor, {
          project_id: "conversation-concurrency-project",
          work_item_id: conversationWorkItemId,
          conversation_id: conversationId,
          action_id: candidate.id,
          idempotency_key: "real-pg-competing-action-key",
        }),
      ),
    );
    expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(competing.find((result) => result.status === "rejected")).toMatchObject({
      status: "rejected",
      reason: { code: "idempotency_conflict", httpStatus: 409 },
    });
  });

  it("serializes plan save effects and QC creation through the real workflow", async () => {
    const actor = { id: "conversation-concurrency-user" };
    const dispatches: string[] = [];
    const workflow = new ConversationPlanWorkflowService(runtimeRunner, {
      newId: (prefix) => `${prefix}-workflow-real-pg-${++conversationIdSequence}`,
      resolveReviewModels: async (_projectId, pm) => ({
        pm,
        reviewer: { provider: "anthropic", model: "claude-fable-5" },
      }),
      runReviewNow: async (runId) => {
        dispatches.push(runId);
      },
    });
    const saveAction = await conversationService.proposeAction(actor, {
      project_id: "conversation-concurrency-project",
      work_item_id: conversationWorkItemId,
      conversation_id: conversationId,
      source_message_id: conversationMessageId,
      action_type: "save_plan_candidate",
      payload: {
        parameters: {
          plan: realPgPlan,
          predecessor_plan_version_id: null,
          predecessor_content_hash: null,
          referenced_artifacts: [],
        },
      },
    });
    const saveConfirmation = {
      project_id: "conversation-concurrency-project",
      work_item_id: conversationWorkItemId,
      conversation_id: conversationId,
      action_id: saveAction.id,
      idempotency_key: "real-pg-plan-save-key",
    };
    const [saved, saveReplay] = await Promise.all([
      workflow.confirm(actor.id, saveConfirmation),
      workflow.confirm(actor.id, saveConfirmation),
    ]);
    expect(saveReplay).toEqual(saved);
    expect(saved.effect.kind).toBe("plan_saved");
    const afterSave = await workflow.detail(
      actor.id,
      "conversation-concurrency-project",
      conversationWorkItemId,
      conversationId,
    );
    expect(afterSave.plan_versions).toHaveLength(1);
    expect(
      afterSave.action_effects.filter((effect) => effect.action_id === saveAction.id),
    ).toHaveLength(1);
    const sendAction = afterSave.actions.find(
      (candidate) => candidate.action_type === "send_plan_to_qc" && candidate.status === "proposed",
    );
    if (!sendAction) throw new Error("plan save did not emit send-to-QC");
    const sendConfirmation = {
      ...saveConfirmation,
      action_id: sendAction.id,
      idempotency_key: "real-pg-plan-qc-key",
    };
    const [sent, sendReplay] = await Promise.all([
      workflow.confirm(actor.id, sendConfirmation),
      workflow.confirm(actor.id, sendConfirmation),
    ]);
    expect(sendReplay).toEqual(sent);
    expect(sent.effect.kind).toBe("qc_started");
    expect(dispatches).toHaveLength(1);
    const counts = await applicationPool.query<{
      reviews: number;
      review_runs: number;
      effects: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM conversation_plan_reviews
           WHERE conversation_id=$1) AS reviews,
         (SELECT count(*)::int FROM planning_runs
           WHERE project_id='conversation-concurrency-project'
             AND mode='review_only') AS review_runs,
         (SELECT count(*)::int FROM conversation_plan_action_effects
           WHERE action_id=$2) AS effects`,
      [conversationId, sendAction.id],
    );
    expect(counts.rows[0]).toEqual({ reviews: 1, review_runs: 1, effects: 1 });
  });

  it("serializes attachment reference creation against concurrent tombstoning", async () => {
    const attachmentId = "real-pg-conversation-attachment";
    const attachmentSha = "a".repeat(64);
    await runtimeRunner.transaction(async (tx) => {
      await tx.query("INSERT INTO attachment_blobs (sha256, content) VALUES ($1, $2)", [
        attachmentSha,
        Buffer.from([0x01]),
      ]);
      await tx.query(
        `INSERT INTO attachments (
           id, project_id, sha256, mime, bytes, purpose
         ) VALUES ($1, 'conversation-concurrency-project', $2, 'image/png', 1, 'objective')`,
        [attachmentId, attachmentSha],
      );
    });

    let releaseReference = (): void => {};
    let markReferenceInserted = (): void => {};
    let markDeleteStarted = (): void => {};
    const referenceInserted = new Promise<void>((resolve) => {
      markReferenceInserted = resolve;
    });
    const deleteStarted = new Promise<void>((resolve) => {
      markDeleteStarted = resolve;
    });
    const referenceRelease = new Promise<void>((resolve) => {
      releaseReference = resolve;
    });
    let deleteBackendPid = 0;

    const reference = runtimeRunner.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO work_messages (
           id, project_id, work_item_id, conversation_id, initiated_by_user_id,
           actor_type, actor_id, role, visibility_status, sequence, parts,
           client_message_id, request_fingerprint
         ) VALUES (
           'real-pg-attachment-message','conversation-concurrency-project',$1,$2,
           'conversation-concurrency-user','human','conversation-concurrency-user',
           'user','complete',1000,$3::jsonb,'real-pg-attachment-client',$4
         )`,
        [
          conversationWorkItemId,
          conversationId,
          JSON.stringify([
            {
              type: "attachment",
              attachment_id: attachmentId,
              name: "evidence.png",
              media_type: "image/png",
            },
          ]),
          canonicalSha256({
            client_message_id: "real-pg-attachment-client",
            parts: [
              {
                type: "attachment",
                attachment_id: attachmentId,
                name: "evidence.png",
                media_type: "image/png",
              },
            ],
          }),
        ],
      );
      await tx.query(
        `INSERT INTO work_message_attachment_refs (
           project_id, work_item_id, conversation_id, message_id,
           attachment_id, created_by_user_id
         ) VALUES (
           'conversation-concurrency-project',$1,$2,
           'real-pg-attachment-message',$3,'conversation-concurrency-user'
         )`,
        [conversationWorkItemId, conversationId, attachmentId],
      );
      markReferenceInserted();
      await referenceRelease;
    });
    await referenceInserted;

    const tombstone = runtimeRunner.transaction(async (tx) => {
      const identity = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      deleteBackendPid = identity.rows[0]?.pid ?? 0;
      markDeleteStarted();
      await tx.query("UPDATE attachments SET deleted_at=now() WHERE id=$1", [attachmentId]);
    });
    const tombstoneSettlement = Promise.allSettled([tombstone]);
    await deleteStarted;

    let waiting:
      | {
          blockers: number[];
          wait_event_type: string | null;
        }
      | undefined;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const activity = await administrationPool.query<{
        blockers: number[];
        wait_event_type: string | null;
      }>(
        `SELECT pg_blocking_pids(pid) AS blockers, wait_event_type
           FROM pg_stat_activity
          WHERE pid = $1`,
        [deleteBackendPid],
      );
      const observed = activity.rows[0];
      if (observed?.wait_event_type === "Lock" && observed.blockers.length > 0) {
        waiting = observed;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waiting).toMatchObject({ wait_event_type: "Lock" });

    releaseReference();
    await reference;
    const [tombstoneResult] = await tombstoneSettlement;
    expect(tombstoneResult).toMatchObject({ status: "rejected" });
    expect(tombstoneResult?.status === "rejected" ? String(tombstoneResult.reason) : "").toMatch(
      /conversation-referenced attachments cannot be deleted/,
    );

    const durable = await applicationPool.query<{ deleted_at: Date | null; refs: string }>(
      `SELECT attachment.deleted_at,
              count(ref.message_id)::text AS refs
         FROM attachments attachment
         LEFT JOIN work_message_attachment_refs ref
           ON ref.project_id=attachment.project_id
          AND ref.attachment_id=attachment.id
        WHERE attachment.id=$1
        GROUP BY attachment.deleted_at`,
      [attachmentId],
    );
    expect(durable.rows[0]).toEqual({ deleted_at: null, refs: "1" });
  });
});

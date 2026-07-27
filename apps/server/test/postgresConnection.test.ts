import { describe, expect, it } from "vitest";
import {
  assertCurrentRuntimeSchema,
  assertRestrictedRuntimeDatabase,
  isPrivatePostgresHostname,
  postgresPoolConfig,
} from "../src/persistence/postgresConnection.js";

describe("PostgreSQL connection security", () => {
  it("classifies only exact private hostnames and validates public TLS", () => {
    expect(isPrivatePostgresHostname("localhost")).toBe(true);
    expect(isPrivatePostgresHostname("db.railway.internal")).toBe(true);
    expect(isPrivatePostgresHostname("db.railway.internal.example.com")).toBe(false);

    expect(
      postgresPoolConfig("postgresql://localhost-in-password@public.example.com/norns").ssl,
    ).toEqual({ rejectUnauthorized: true });
    expect(
      postgresPoolConfig("postgresql://user:pass@db.railway.internal/norns").ssl,
    ).toBeUndefined();
    expect(postgresPoolConfig("postgresql://user:pass@127.0.0.1:5432/norns").ssl).toBeUndefined();
  });

  it("rejects archive keys in the ordinary application environment", async () => {
    await expect(
      assertRestrictedRuntimeDatabase(
        {
          query: async () => ({ rows: [] }),
        } as never,
        { NORNS_ARCHIVE_KEY: "secret" },
      ),
    ).rejects.toMatchObject({
      code: "archive_key_in_runtime",
    });
  });

  it("rejects privileged logins and proves archive ciphertext is denied", async () => {
    let calls = 0;
    const privileged = {
      query: async () => {
        calls += 1;
        if (calls === 1) return { rows: [{ relation: "legacy_snapshot_archives" }] };
        return {
          rows: [
            {
              rolname: "owner",
              rolsuper: true,
              rolcreatedb: false,
              rolcreaterole: false,
              rolreplication: false,
              rolbypassrls: false,
              can_set_runtime_role: true,
            },
          ],
        };
      },
    };
    await expect(assertRestrictedRuntimeDatabase(privileged as never, {})).rejects.toMatchObject({
      code: "privileged_runtime_login",
    });

    calls = 0;
    const restricted = {
      query: async () => {
        calls += 1;
        if (calls === 1) return { rows: [{ relation: "legacy_snapshot_archives" }] };
        if (calls === 2) {
          return {
            rows: [
              {
                rolname: "norns_runtime",
                rolsuper: false,
                rolcreatedb: false,
                rolcreaterole: false,
                rolreplication: false,
                rolbypassrls: false,
                can_set_runtime_role: true,
              },
            ],
          };
        }
        throw Object.assign(new Error("permission denied for table legacy_snapshot_archives"), {
          code: "42501",
        });
      },
    };
    await expect(assertRestrictedRuntimeDatabase(restricted as never, {})).resolves.toBeUndefined();
  });
});

describe("PostgreSQL runtime schema compatibility", () => {
  it("accepts the complete current runtime schema", async () => {
    const compatible = {
      query: async () => ({
        rows: [
          {
            planning_mode: true,
            knowledge_packages: "knowledge_packages",
            agent_execution_registrations: "agent_execution_registrations",
            agent_handoffs: "agent_handoffs",
            knowledge_deltas: "knowledge_deltas",
            agent_reasoning_effort: true,
            global_rule_settings: "global_rule_settings",
            ai_usage_events: "ai_usage_events",
            project_owner_user_id: true,
            project_members: "project_members",
            usage_budget_policies: "usage_budget_policies",
            ai_usage_calibration_observations: "ai_usage_calibration_observations",
            shadow_read_recorded_order: true,
            conversation_domain_complete: true,
            conversation_stream_lifecycle: "conversation_stream_lifecycle_v1",
            conversation_plan_workflow: "conversation_plan_workflow_v1",
            conversation_execution_handoff: "conversation_execution_handoff_v1",
          },
        ],
      }),
    };

    await expect(assertCurrentRuntimeSchema(compatible as never)).resolves.toBeUndefined();
  });

  it("fails closed with the exact missing runtime schema surfaces", async () => {
    const outdated = {
      query: async () => ({
        rows: [
          {
            planning_mode: false,
            knowledge_packages: null,
            agent_execution_registrations: "agent_execution_registrations",
            agent_handoffs: null,
            knowledge_deltas: "knowledge_deltas",
            agent_reasoning_effort: false,
            global_rule_settings: "global_rule_settings",
            ai_usage_events: null,
            project_owner_user_id: true,
            project_members: null,
            usage_budget_policies: "usage_budget_policies",
            ai_usage_calibration_observations: null,
            shadow_read_recorded_order: false,
            conversation_domain_complete: false,
            conversation_stream_lifecycle: null,
            conversation_plan_workflow: null,
            conversation_execution_handoff: null,
          },
        ],
      }),
    };

    await expect(assertCurrentRuntimeSchema(outdated as never)).rejects.toMatchObject({
      code: "runtime_schema_outdated",
      message:
        "database migrations are required before startup; missing: " +
        "planning_runs.mode, knowledge_packages, agent_handoffs, " +
        "agent_profiles.reasoning_effort, ai_usage_events, project_members, " +
        "ai_usage_calibration_observations, shadow_read_comparisons.recorded_order, " +
        "conversation domain tables, conversation_stream_lifecycle_v1, " +
        "conversation_plan_workflow_v1, conversation_execution_handoff_v1",
    });
  });

  it("fails closed on a 0035-only conversation schema without the 0036 marker", async () => {
    const phase1ConversationOnly = {
      query: async () => ({
        rows: [
          {
            planning_mode: true,
            knowledge_packages: "knowledge_packages",
            agent_execution_registrations: "agent_execution_registrations",
            agent_handoffs: "agent_handoffs",
            knowledge_deltas: "knowledge_deltas",
            agent_reasoning_effort: true,
            global_rule_settings: "global_rule_settings",
            ai_usage_events: "ai_usage_events",
            project_owner_user_id: true,
            project_members: "project_members",
            usage_budget_policies: "usage_budget_policies",
            ai_usage_calibration_observations: "ai_usage_calibration_observations",
            shadow_read_recorded_order: true,
            conversation_domain_complete: true,
            conversation_stream_lifecycle: null,
            conversation_plan_workflow: null,
            conversation_execution_handoff: null,
          },
        ],
      }),
    };

    await expect(assertCurrentRuntimeSchema(phase1ConversationOnly as never)).rejects.toMatchObject(
      {
        code: "runtime_schema_outdated",
        message:
          "database migrations are required before startup; missing: " +
          "conversation_stream_lifecycle_v1, conversation_plan_workflow_v1, " +
          "conversation_execution_handoff_v1",
      },
    );
  });
});

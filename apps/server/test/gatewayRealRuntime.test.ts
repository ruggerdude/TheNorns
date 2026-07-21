import { mkdtempSync, rmSync } from "node:fs";
// EXECUTION E9 — the test that drives a REAL agentic runtime through the
// gateway. No mock of the SDK, no mock of the CLI, no hand-rolled client.
//
// WHY THIS ONE MATTERS MORE THAN THE OTHERS. Every earlier E9 test proves the
// gateway behaves correctly when something we wrote talks to it. That is
// exactly the shape of assurance that has been wrong four times in this repo:
// E3's context-fetch test drove a fake server implementing the client's own
// spelling, and the real pair had never once exchanged a byte. The only way to
// know Claude Code can use this gateway is to make Claude Code use it.
//
// So this spawns the actual Claude Code process (via the installed
// `@anthropic-ai/claude-agent-sdk`, through the runner's real
// `ClaudeCodeRuntime`), points it at a real `buildServer` gateway with a real
// per-run credential minted from the real credential service, and lets the
// gateway forward to a local stand-in provider.
//
// WHAT THAT ALREADY CAUGHT, AND WHAT NO MOCK WOULD HAVE:
//   1. Claude Code requests `POST <base>/v1/messages?beta=true` — WITH a query
//      string. The gateway originally rebuilt the upstream URL from the path
//      alone and silently dropped `?beta=true`. That is a forwarder changing
//      the request, which is the one thing this phase must never do.
//   2. Before its first model call it issues `HEAD <ANTHROPIC_BASE_URL>` as a
//      reachability probe. Without a route for it, a perfectly healthy
//      deployment answers 404 to the first request an agent ever makes.
//   3. One "turn" is several `/v1/messages` calls (the turn itself plus Claude
//      Code's own follow-ups), so metering writes several `usage_events` rows
//      per run — the ledger's arithmetic has to be per-CALL, not per-turn.
//
// The upstream is local because the alternative is billing a real provider on
// every CI run. Everything between the CLI and that upstream is production code.
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { ClaudeCodeRuntime } from "@norns/runner";
import { afterEach, describe, expect, it } from "vitest";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import {
  GatewayCredentialService,
  type GatewaySurface,
  InMemoryGatewayCredentialStore,
  ProviderGateway,
  anthropicGatewayBaseUrl,
  openAiGatewayBaseUrl,
} from "../src/gateway/index.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import {
  SqlInferenceMeter,
  SqlProxiedRunLookup,
  SqlRunReservationBudget,
} from "../src/runners/inferenceProxy.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { listen } from "./helpers.js";

// Claude Code asks for whatever alias it was given; the gateway prices what
// the BODY names, so the allowlist entry has to be the resolved model id.
const MODEL = "claude-sonnet-5"; // $2/MTok in, $10/MTok out
const PROVIDER_KEY = "sk-ant-REAL-KEY-MUST-NEVER-REACH-THE-RUNTIME";
const MARKER = "NORNS_E9_GATEWAY_OK";

interface UpstreamCall {
  method: string;
  url: string;
  authorization: string | undefined;
  apiKey: string | undefined;
  body: string;
}

/**
 * A stand-in Anthropic. It answers the Messages API well enough for the real
 * CLI to complete a turn, and records exactly what reached it.
 */
function startUpstream(calls: UpstreamCall[]): Promise<{ origin: string; server: Server }> {
  const event = (type: string, payload: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(parts).toString("utf8");
      calls.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        apiKey: req.headers["x-api-key"] as string | undefined,
        body,
      });
      if (req.url?.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      const model = (() => {
        try {
          return (JSON.parse(body) as { model?: string }).model ?? MODEL;
        } catch {
          return MODEL;
        }
      })();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        event("message_start", {
          message: {
            id: "msg_e9_real",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 1_000,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 1,
            },
          },
        }),
      );
      res.write(
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      );
      res.write(
        event("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: MARKER },
        }),
      );
      res.write(event("content_block_stop", { index: 0 }));
      res.write(
        event("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 100 },
        }),
      );
      res.write(event("message_stop", {}));
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${address.port}`, server });
    });
  });
}

async function seed(pg: PGlite): Promise<void> {
  await pg.exec(`
    CREATE ROLE norns_app NOLOGIN;
    CREATE TABLE norns_state (
      key TEXT PRIMARY KEY, snapshot JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
  await pg.exec(`
    INSERT INTO projects (
      id, name, description, status, assignment_policy_ref,
      verification_policy_ref, budget_policy_ref
    ) VALUES ('project-1','Project One','','active','assignment','verification','budget');
    INSERT INTO repository_bindings (
      id, project_id, binding_type, status, runner_id, workspace_id,
      repository_id, repository_display_name, granted_permissions,
      default_branch, observed_head, verification_policy_ref,
      repository_health, created_by_actor_type, created_by_actor_id
    ) VALUES ('binding-1','project-1','local_runner','connected','runner-1',
      'workspace-1','repository-1','Project One','{}'::jsonb,'main','commit-1',
      'verification','healthy','human','admin-1');
    UPDATE projects SET primary_repository_binding_id = 'binding-1' WHERE id = 'project-1';
    INSERT INTO phases (
      id, project_id, objective_summary, priority, status, approved_budget_usd
    ) VALUES ('phase-1','project-1','Slice',1,'awaiting_approval',500);
    INSERT INTO strategy_versions (
      id, project_id, phase_id, version, status, objective, content,
      convergence, review_rounds, content_hash
    ) VALUES ('strategy-1','project-1','phase-1',1,'approved','Slice',
      '{}'::jsonb,'converged',1,repeat('a',64));
    UPDATE phases SET status='approved', approved_strategy_version_id='strategy-1'
      WHERE id='phase-1';
    INSERT INTO objectives (
      id, project_id, phase_id, outcome, success_measures, status, "order"
    ) VALUES ('objective-1','project-1','phase-1','Done','["ok"]'::jsonb,'active',0);
    INSERT INTO tasks (
      id, project_id, phase_id, objective_id, strategy_version_id, title,
      description, deliverables, acceptance_criteria, complexity, risk,
      required_roles, required_capabilities, required_inputs, expected_outputs,
      environment_policy_ref, verification_policy_ref, state, lifecycle_version
    ) VALUES ('task-1','project-1','phase-1','objective-1','strategy-1','Do work',
      'Slice','["change"]'::jsonb,'["verified"]'::jsonb,'M','medium',
      '["implementation"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["commit"]'::jsonb,
      'environment','verification','pending',0);
    INSERT INTO agent_profiles (
      id, provider, runtime, model, roles, capabilities, context_limit_tokens,
      security_restrictions, status, active_workload, cost_metadata
    ) VALUES ('agent-1','anthropic','claude-code','${MODEL}','["implementation"]'::jsonb,
      '["typescript"]'::jsonb,200000,'[]'::jsonb,'available',0,
      '{"billing_mode":"api"}'::jsonb);
    INSERT INTO agent_assignments (
      id, project_id, phase_id, task_id, agent_profile_id, status, rationale,
      rationale_factors, budget_limit_usd, allocation_policy_ref
    ) VALUES ('assignment-1','project-1','phase-1','task-1','agent-1','proposed',
      'Best','["capability"]'::jsonb,200,'allocation');
  `);
}

interface Stack {
  origin: string;
  server: NornsServer;
  upstream: Server;
  calls: UpstreamCall[];
  token: string;
  worktree: string;
  pg: PGlite;
  transactions: PGliteTransactionRunner;
  stop(): Promise<void>;
}

async function startStack(): Promise<Stack> {
  const calls: UpstreamCall[] = [];
  const { origin: upstreamOrigin, server: upstream } = await startUpstream(calls);

  const pg = new PGlite();
  await seed(pg);
  const transactions = new PGliteTransactionRunner(pg);
  const scheduled = await new Phase4Coordinator(transactions).schedule({
    project_id: "project-1",
    phase_id: "phase-1",
    task_id: "task-1",
    assignment_id: "assignment-1",
    runner_id: "runner-1",
    runner_generation: 3,
    authorized_by: { actor_type: "human", actor_id: "admin-1" },
    authorized_by_session_id: "session-1",
    correlation_id: "correlation-1",
    causation_id: null,
    context_refs: [
      {
        artifact_id: "prompt-1",
        content_hash: "b".repeat(64),
        byte_size: 12,
        storage_ref: "relay://artifacts/prompt-1",
      },
    ],
    target_branch: "norns/task-1",
    worktree_policy_ref: "worktree-default",
    sandbox_policy_ref: "sandbox-default",
    max_input_tokens: 10_000,
    max_output_tokens: 8_000,
    max_duration_seconds: 900,
    issued_at: "2026-07-16T20:00:00.000Z",
    expires_at: "2026-07-16T20:15:00.000Z",
  });

  const runs = new SqlProxiedRunLookup(transactions);
  const run = await runs.lookup(scheduled.run_id);
  if (!run) throw new Error("fixture failed to produce a run");

  const credentials = new GatewayCredentialService(new InMemoryGatewayCredentialStore());
  const surface = (provider: "anthropic" | "openai"): GatewaySurface => ({
    provider,
    origin: upstreamOrigin, // the only seam
    paths:
      provider === "anthropic"
        ? new Set(["/v1/messages", "/v1/messages/count_tokens", "/v1/models"])
        : new Set(["/v1/responses", "/v1/models"]),
    meteredPaths: provider === "anthropic" ? new Set(["/v1/messages"]) : new Set(["/v1/responses"]),
    authHeaders: (apiKey) =>
      provider === "anthropic" ? { "x-api-key": apiKey } : { authorization: `Bearer ${apiKey}` },
  });

  const server = await buildServer({
    stores: new RelayStores(),
    users: new UserStore(),
    gatewayCredentials: credentials,
    gatewayRuns: runs,
    modelGateway: new ProviderGateway({
      runs,
      credentials,
      budget: new SqlRunReservationBudget(transactions),
      meter: new SqlInferenceMeter(transactions),
      allowedModels: [`anthropic/${MODEL}`],
      apiKey: () => PROVIDER_KEY,
      surfaces: { anthropic: surface("anthropic"), openai: surface("openai") },
    }),
  });
  const origin = await listen(server);
  const minted = await credentials.mint(run);
  const worktree = mkdtempSync(join(tmpdir(), "norns-e9-runtime-"));

  return {
    origin,
    server,
    upstream,
    calls,
    token: minted.token,
    worktree,
    pg,
    transactions,
    stop: async () => {
      await server.app.close();
      await new Promise<void>((resolve) => {
        upstream.close(() => resolve());
        upstream.closeAllConnections?.();
      });
      await pg.close();
      rmSync(worktree, { recursive: true, force: true });
    },
  };
}

describe.sequential("EXECUTION E9 — a real Claude Code process through the gateway", () => {
  let stack: Stack;

  afterEach(async () => {
    await stack?.stop();
  });

  it(
    "runs credential-free, reaches the provider only through the gateway, and is metered",
    { timeout: 120_000 },
    async () => {
      stack = await startStack();

      // The production runtime object, constructed exactly as the runner CLI
      // constructs it, with the gateway credential the runner would have
      // minted. `baseEnv` is scrubbed of every provider key so this test
      // cannot pass by accident on a developer machine that happens to hold a
      // real ANTHROPIC_API_KEY.
      const baseEnv: NodeJS.ProcessEnv = { ...process.env };
      baseEnv.ANTHROPIC_API_KEY = "sk-ant-A-REAL-KEY-THAT-MUST-BE-STRIPPED";
      const runtime = new ClaudeCodeRuntime({
        model: MODEL,
        baseEnv,
        gateway: async () => ({
          token: stack.token,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          anthropic_base_url: anthropicGatewayBaseUrl(stack.origin),
          openai_base_url: openAiGatewayBaseUrl(stack.origin),
        }),
      });

      const result = await runtime.run({
        runId: "run-1",
        worktreePath: stack.worktree,
        prompt: "Reply with exactly one short line and then stop.",
      });

      // 1. THE RUNTIME ACTUALLY RAN AND GOT AN ANSWER. If the gateway had
      //    rejected it, mangled the body, or broken the SSE framing, the CLI
      //    would have failed or hung instead.
      expect(result.outcome).toBe("completed");
      expect(result.detail).toContain(MARKER);

      // 2. EVERY provider call went through the gateway to the stand-in
      //    upstream — the CLI never reached anything else.
      const messageCalls = stack.calls.filter((call) => call.url.includes("/v1/messages"));
      expect(messageCalls.length).toBeGreaterThan(0);

      // 3. THE QUERY STRING SURVIVED. Claude Code sends `?beta=true`; a
      //    forwarder that dropped it would be changing the request. This
      //    assertion is here because the gateway originally did drop it.
      expect(messageCalls.some((call) => call.url.includes("?beta=true"))).toBe(true);
      expect(messageCalls.every((call) => call.url.startsWith("/v1/messages"))).toBe(true);

      // 4. THE REAL KEY WAS INJECTED SERVER-SIDE and the runtime's own
      //    credential never left the gateway.
      for (const call of messageCalls) {
        expect(call.apiKey).toBe(PROVIDER_KEY);
        expect(call.authorization).toBeUndefined();
      }
      const everythingTheUpstreamSaw = JSON.stringify(stack.calls);
      expect(everythingTheUpstreamSaw).not.toContain(stack.token);
      // And the key the runtime's environment claimed to hold was stripped
      // before the subprocess started, so it can never have been used.
      expect(everythingTheUpstreamSaw).not.toContain("A-REAL-KEY-THAT-MUST-BE-STRIPPED");

      // 5. THE BODY THE PROVIDER RECEIVED IS THE BODY CLAUDE CODE WROTE —
      //    tool definitions and all. Nothing here understands `tools`; it
      //    arrived because nothing re-serialized it.
      const bodies = messageCalls.map(
        (call) =>
          JSON.parse(call.body) as {
            model?: string;
            stream?: boolean;
            tools?: unknown[];
            system?: unknown;
          },
      );
      expect(bodies.every((body) => body.model === MODEL)).toBe(true);
      // OBSERVED, not assumed: one turn is three calls — two streaming (the
      // main one carrying Claude Code's full tool set) and one NON-streaming
      // post-turn summary. Both framings therefore have to work, and the
      // metering assertion below covers all three.
      expect(bodies.filter((body) => body.stream === true).length).toBeGreaterThan(0);
      expect(bodies.filter((body) => body.stream !== true).length).toBeGreaterThan(0);
      // The main call's tool definitions arrived intact despite nothing in the
      // gateway knowing what a tool is.
      const withTools = bodies.filter((body) => (body.tools ?? []).length > 0);
      expect(withTools.length).toBeGreaterThan(0);
      expect(JSON.stringify(withTools[0]?.tools)).toContain("input_schema");

      // 6. IT WAS METERED. One usage_events row per provider call, with the
      //    numbers the stand-in provider reported, charged to the real run.
      const rows = await stack.transactions.transaction(async (sql) => {
        const result = await sql.query<{
          provider: string;
          model: string;
          input_tokens: number | string;
          output_tokens: number | string;
          cost_usd: string;
        }>("SELECT provider, model, input_tokens, output_tokens, cost_usd FROM usage_events");
        return result.rows;
      });
      expect(rows.length).toBe(messageCalls.length);
      expect(rows[0]?.provider).toBe("anthropic");
      expect(rows[0]?.model).toBe(MODEL);
      expect(Number(rows[0]?.input_tokens)).toBe(1_000);
      expect(Number(rows[0]?.output_tokens)).toBe(100);
      // 1000 * $2/MTok + 100 * $10/MTok = 0.002 + 0.001 = 0.003
      expect(Number(rows[0]?.cost_usd)).toBeCloseTo(0.003, 9);
    },
  );
});

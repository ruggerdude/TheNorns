// EXECUTION E9 — the forwarder, end to end, with nothing mocked in the middle.
//
// WHAT IS REAL HERE, AND WHY. Mocks have hidden four dead paths in this
// codebase, so this file mocks nothing that could hide one:
//   * a real Fastify server built by `buildServer`, listening on a real socket;
//   * a real HTTP client (`fetch`) talking to it;
//   * a real `node:http` upstream on another real socket, standing in for
//     api.anthropic.com / api.openai.com — it records the EXACT bytes and
//     headers it received, which is the only way to assert verbatim forwarding;
//   * real PGlite persistence with the real migrations, a real scheduled run
//     from `Phase4Coordinator`, and therefore E3's real `SqlRunReservationBudget`
//     and real `SqlInferenceMeter` writing real `usage_events` rows.
// The only injected seam is `GatewaySurface.origin`, pointed at the local
// upstream — because the alternative is billing a real provider in CI.
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import {
  GATEWAY_REFUSAL_HEADER,
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
  type ProxiedRunFacts,
  SqlInferenceMeter,
  SqlProxiedRunLookup,
  SqlRunReservationBudget,
} from "../src/runners/inferenceProxy.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { listen } from "./helpers.js";

const ANTHROPIC_MODEL = "claude-sonnet-5"; // $2/MTok in, $10/MTok out
const OPENAI_MODEL = "gpt-5.6-sol"; // $5/MTok in, $30/MTok out
const PROVIDER_KEY_ANTHROPIC = "sk-ant-THIS-MUST-NEVER-APPEAR-IN-A-RESPONSE";
const PROVIDER_KEY_OPENAI = "sk-proj-THIS-MUST-NEVER-APPEAR-IN-A-RESPONSE";

// ---------------------------------------------------------------------------
// A stand-in provider that records exactly what reached it
// ---------------------------------------------------------------------------

interface UpstreamCall {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** The raw bytes, decoded. Compared byte-for-byte against what was sent. */
  body: string;
}

interface UpstreamResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Written one at a time, with a beat between, so streaming is observable. */
  chunks: string[];
  /** Destroy the socket after this many chunks, simulating a dying stream. */
  dieAfter?: number;
  betweenChunksMs?: number;
}

class FakeProvider {
  readonly calls: UpstreamCall[] = [];
  private server: Server | undefined;
  private next: UpstreamResponse = { chunks: ["{}"] };
  origin = "";

  respondWith(response: UpstreamResponse): void {
    this.next = response;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (chunk: Buffer) => parts.push(chunk));
      req.on("end", async () => {
        this.calls.push({
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(parts).toString("utf8"),
        });
        const plan = this.next;
        res.writeHead(plan.status ?? 200, {
          "content-type": "text/event-stream",
          ...plan.headers,
        });
        let written = 0;
        for (const chunk of plan.chunks) {
          if (plan.dieAfter !== undefined && written >= plan.dieAfter) {
            // A provider stream that simply stops. The socket dies with bytes
            // already delivered and no terminal event.
            res.destroy();
            return;
          }
          res.write(chunk);
          written += 1;
          if (plan.betweenChunksMs) {
            await new Promise((resolve) => setTimeout(resolve, plan.betweenChunksMs));
          }
        }
        res.end();
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server?.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }
}

// ---------------------------------------------------------------------------
// Real payload fixtures (shapes verified against the installed SDK types)
// ---------------------------------------------------------------------------

function anthropicStream(inputTokens: number, outputTokens: number): string[] {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_e9",
        type: "message",
        role: "assistant",
        model: ANTHROPIC_MODEL,
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: inputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "done" },
    })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: outputTokens },
    })}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
}

function openAiStream(inputTokens: number, outputTokens: number): string[] {
  return [
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp_e9", object: "response", status: "in_progress", output: [] },
    })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      sequence_number: 1,
      delta: "done",
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "resp_e9",
        object: "response",
        status: "completed",
        output: [],
        usage: {
          input_tokens: inputTokens,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: outputTokens,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: inputTokens + outputTokens,
        },
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Fixture {
  server: NornsServer;
  origin: string;
  upstream: FakeProvider;
  credentials: GatewayCredentialService;
  run: ProxiedRunFacts;
  token: string;
  transactions: PGliteTransactionRunner;
  audit: Array<{ actor: string; action: string; detail: string }>;
  usageRows(): Promise<
    Array<{
      provider: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }>
  >;
  stop(): Promise<void>;
}

async function seed(pg: PGlite, approvedBudgetUsd: number): Promise<void> {
  await pg.exec(`
    CREATE ROLE norns_app NOLOGIN;
    CREATE TABLE norns_state (
      key TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
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
    ) VALUES ('phase-1','project-1','Implement vertical slice',1,'awaiting_approval',1000);
    INSERT INTO strategy_versions (
      id, project_id, phase_id, version, status, objective, content,
      convergence, review_rounds, content_hash
    ) VALUES ('strategy-1','project-1','phase-1',1,'approved','Vertical slice',
      '{}'::jsonb,'converged',1,repeat('a',64));
    UPDATE phases SET status='approved', approved_strategy_version_id='strategy-1'
      WHERE id='phase-1';
    INSERT INTO objectives (
      id, project_id, phase_id, outcome, success_measures, status, "order"
    ) VALUES ('objective-1','project-1','phase-1','One completed task',
      '["task completes"]'::jsonb,'active',0);
    INSERT INTO tasks (
      id, project_id, phase_id, objective_id, strategy_version_id, title,
      description, deliverables, acceptance_criteria, complexity, risk,
      required_roles, required_capabilities, required_inputs, expected_outputs,
      environment_policy_ref, verification_policy_ref, state, lifecycle_version
    ) VALUES ('task-1','project-1','phase-1','objective-1','strategy-1','Do work',
      'Complete the vertical slice','["change"]'::jsonb,'["verified"]'::jsonb,
      'M','medium','["implementation"]'::jsonb,'[]'::jsonb,'[]'::jsonb,
      '["commit"]'::jsonb,'environment','verification','pending',0);
    INSERT INTO agent_profiles (
      id, provider, runtime, model, roles, capabilities, context_limit_tokens,
      security_restrictions, status, active_workload, cost_metadata
    ) VALUES ('agent-1','anthropic','claude-code','${ANTHROPIC_MODEL}','["implementation"]'::jsonb,
      '["typescript"]'::jsonb,200000,'[]'::jsonb,'available',0,
      '{"billing_mode":"api"}'::jsonb);
    INSERT INTO agent_assignments (
      id, project_id, phase_id, task_id, agent_profile_id, status, rationale,
      rationale_factors, budget_limit_usd, allocation_policy_ref
    ) VALUES ('assignment-1','project-1','phase-1','task-1','agent-1','proposed',
      'Best implementation agent','["capability"]'::jsonb,${approvedBudgetUsd},'allocation');
  `);
}

async function startFixture(
  options: { approvedBudgetUsd?: number; allowedModels?: string[] } = {},
): Promise<Fixture> {
  const upstream = new FakeProvider();
  await upstream.start();

  const pg = new PGlite();
  await seed(pg, options.approvedBudgetUsd ?? 25);
  const transactions = new PGliteTransactionRunner(pg);

  // A REAL scheduled run: the coordinator writes agent_runs, commands, and the
  // budget_reservations row the gateway later enforces against.
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
  const runId = scheduled.run_id;

  const runs = new SqlProxiedRunLookup(transactions);
  const run = await runs.lookup(runId);
  if (!run) throw new Error("fixture failed to produce a run");

  const credentials = new GatewayCredentialService(new InMemoryGatewayCredentialStore());
  const audit: Array<{ actor: string; action: string; detail: string }> = [];
  const surface = (provider: "anthropic" | "openai"): GatewaySurface => ({
    provider,
    // THE ONLY SEAM. Everything else is the production object.
    origin: upstream.origin,
    paths:
      provider === "anthropic"
        ? new Set(["/v1/messages", "/v1/messages/count_tokens", "/v1/models"])
        : new Set(["/v1/responses", "/v1/models"]),
    meteredPaths: provider === "anthropic" ? new Set(["/v1/messages"]) : new Set(["/v1/responses"]),
    authHeaders: (apiKey) =>
      provider === "anthropic" ? { "x-api-key": apiKey } : { authorization: `Bearer ${apiKey}` },
  });

  const gateway = new ProviderGateway({
    runs,
    credentials,
    budget: new SqlRunReservationBudget(transactions),
    meter: new SqlInferenceMeter(transactions),
    allowedModels: options.allowedModels ?? [
      `anthropic/${ANTHROPIC_MODEL}`,
      `openai/${OPENAI_MODEL}`,
    ],
    apiKey: (provider) => (provider === "anthropic" ? PROVIDER_KEY_ANTHROPIC : PROVIDER_KEY_OPENAI),
    audit: (actor, action, detail) => audit.push({ actor, action, detail }),
    surfaces: { anthropic: surface("anthropic"), openai: surface("openai") },
  });

  const server = await buildServer({
    stores: new RelayStores(),
    users: new UserStore(),
    modelGateway: gateway,
    gatewayCredentials: credentials,
    gatewayRuns: runs,
    publicOrigin: "https://norns.test",
  });
  const origin = await listen(server);
  const minted = await credentials.mint(run);

  return {
    server,
    origin,
    upstream,
    credentials,
    run,
    token: minted.token,
    transactions,
    audit,
    usageRows: async () =>
      transactions.transaction(async (sql) => {
        const result = await sql.query<{
          provider: string;
          model: string;
          input_tokens: number | string;
          output_tokens: number | string;
          cost_usd: string;
        }>(
          "SELECT provider, model, input_tokens, output_tokens, cost_usd FROM usage_events WHERE run_id = $1 ORDER BY occurred_at",
          [runId],
        );
        return result.rows.map((row) => ({
          provider: row.provider,
          model: row.model,
          input_tokens: Number(row.input_tokens),
          output_tokens: Number(row.output_tokens),
          cost_usd: Number(row.cost_usd),
        }));
      }),
    stop: async () => {
      await server.app.close();
      await upstream.stop();
      await pg.close();
    },
  };
}

function messagesUrl(origin: string): string {
  return `${anthropicGatewayBaseUrl(origin)}/v1/messages`;
}

function responsesUrl(origin: string): string {
  return `${openAiGatewayBaseUrl(origin)}/responses`;
}

// ---------------------------------------------------------------------------

describe.sequential("EXECUTION E9 provider gateway", () => {
  let fx: Fixture;

  afterEach(async () => {
    await fx?.stop();
  });

  // -- verbatim forwarding --------------------------------------------------

  it("forwards the request body byte for byte, including fields it does not understand", async () => {
    fx = await startFixture();
    fx.upstream.respondWith({ chunks: anthropicStream(1_000, 200) });

    // Deliberately hostile to a re-serializing proxy: keys out of alphabetical
    // order, an unknown top-level field, an unknown nested field, a tool
    // definition, unicode, and significant whitespace inside a string.
    const body = JSON.stringify({
      stream: true,
      max_tokens: 1024,
      model: ANTHROPIC_MODEL,
      an_unknown_future_parameter: { nested: ["a", 1, null, true] },
      messages: [{ role: "user", content: "héllo\t— world  " }],
      tools: [
        {
          name: "Read",
          description: "read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      metadata: { user_id: "u1", not_a_real_field: 7 },
    });

    const response = await fetch(messagesUrl(fx.origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fx.token}`,
        // A header no gateway code knows about, plus the beta header the SDKs
        // really send. Both must survive.
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "some-future-beta-2099-01-01",
        "x-stainless-lang": "js",
      },
      body,
    });
    await response.text();

    expect(fx.upstream.calls).toHaveLength(1);
    const call = fx.upstream.calls[0];
    // THE ASSERTION THIS PHASE EXISTS FOR: identical bytes, not merely
    // equivalent JSON. Key order and whitespace are preserved because nothing
    // parsed and re-emitted it.
    expect(call?.body).toBe(body);
    expect(call?.url).toBe("/v1/messages");
    expect(call?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call?.headers["anthropic-beta"]).toBe("some-future-beta-2099-01-01");
    expect(call?.headers["x-stainless-lang"]).toBe("js");
  });

  it("replaces the caller's credential with the real key and never forwards theirs", async () => {
    fx = await startFixture();
    fx.upstream.respondWith({ chunks: anthropicStream(100, 10) });

    await fetch(messagesUrl(fx.origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fx.token}`,
        // A caller trying to smuggle its own model key past the meter.
        "x-api-key": "sk-ant-ATTACKER-SUPPLIED-KEY",
      },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 16, messages: [] }),
    }).then((r) => r.text());

    const call = fx.upstream.calls[0];
    expect(call?.headers["x-api-key"]).toBe(PROVIDER_KEY_ANTHROPIC);
    // The gateway credential must not reach the provider either.
    expect(call?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(call?.headers)).not.toContain("ATTACKER-SUPPLIED-KEY");
    expect(JSON.stringify(call?.headers)).not.toContain(fx.token);
  });

  it("forwards Codex's Responses request on the path the codex binary actually calls", async () => {
    fx = await startFixture();
    fx.upstream.respondWith({ chunks: openAiStream(300, 50) });

    const body = JSON.stringify({
      model: OPENAI_MODEL,
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      max_output_tokens: 2048,
    });
    const response = await fetch(responsesUrl(fx.origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.token}` },
      body,
    });
    await response.text();

    // openAiGatewayBaseUrl ends in /v1 and codex appends /responses, so the
    // upstream path must be exactly /v1/responses.
    expect(fx.upstream.calls[0]?.url).toBe("/v1/responses");
    expect(fx.upstream.calls[0]?.body).toBe(body);
    expect(fx.upstream.calls[0]?.headers.authorization).toBe(`Bearer ${PROVIDER_KEY_OPENAI}`);
  });

  // -- streaming ------------------------------------------------------------

  it("streams response bytes back chunk for chunk, not buffered to the end", async () => {
    fx = await startFixture();
    const chunks = anthropicStream(1_000, 200);
    fx.upstream.respondWith({ chunks, betweenChunksMs: 30 });

    const response = await fetch(messagesUrl(fx.origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.token}` },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 256, stream: true, messages: [] }),
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    if (!reader) throw new Error("no response body");
    const decoder = new TextDecoder();
    const arrivals: Array<{ at: number; text: string }> = [];
    const started = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) arrivals.push({ at: Date.now() - started, text: decoder.decode(value) });
    }

    // Incrementality: the upstream spaced its writes 30ms apart, so a gateway
    // that buffered would deliver everything at once at the very end.
    expect(arrivals.length).toBeGreaterThan(1);
    const first = arrivals[0];
    const last = arrivals[arrivals.length - 1];
    if (!first || !last) throw new Error("expected multiple arrivals");
    expect(last.at - first.at).toBeGreaterThan(30);
    // Fidelity: concatenated, the bytes are exactly what the provider emitted.
    expect(arrivals.map((a) => a.text).join("")).toBe(chunks.join(""));
  });

  // -- metering -------------------------------------------------------------

  it("meters an Anthropic stream into usage_events with the provider's own numbers", async () => {
    fx = await startFixture();
    fx.upstream.respondWith({ chunks: anthropicStream(1_000, 200) });

    await fetch(messagesUrl(fx.origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.token}` },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 256, stream: true, messages: [] }),
    }).then((r) => r.text());

    const rows = await fx.usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe("anthropic");
    expect(rows[0]?.model).toBe(ANTHROPIC_MODEL);
    expect(rows[0]?.input_tokens).toBe(1_000);
    expect(rows[0]?.output_tokens).toBe(200);
    // 1000 * $2/MTok + 200 * $10/MTok = 0.002 + 0.002 = 0.004
    expect(rows[0]?.cost_usd).toBeCloseTo(0.004, 9);
  });

  it("meters an OpenAI stream from the terminal usage event", async () => {
    fx = await startFixture();
    fx.upstream.respondWith({ chunks: openAiStream(2_000, 400) });

    await fetch(responsesUrl(fx.origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.token}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        stream: true,
        input: "hi",
        max_output_tokens: 1024,
      }),
    }).then((r) => r.text());

    const rows = await fx.usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe("openai");
    expect(rows[0]?.input_tokens).toBe(2_000);
    expect(rows[0]?.output_tokens).toBe(400);
    // 2000 * $5/MTok + 400 * $30/MTok = 0.01 + 0.012 = 0.022
    expect(rows[0]?.cost_usd).toBeCloseTo(0.022, 9);
  });

  it("still meters a stream the provider kills mid-flight", async () => {
    fx = await startFixture();
    // message_start lands (input tokens known); the socket dies before
    // message_delta, so no terminal usage is ever emitted.
    fx.upstream.respondWith({
      chunks: anthropicStream(1_500, 600),
      dieAfter: 2,
      betweenChunksMs: 5,
    });

    await fetch(messagesUrl(fx.origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.token}` },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 256, stream: true, messages: [] }),
    })
      .then((r) => r.text())
      .catch(() => undefined);

    const rows = await fx.usageRows();
    expect(rows).toHaveLength(1);
    // The input tokens were really consumed and are really charged. A gateway
    // that only read the terminal event would have charged nothing at all.
    expect(rows[0]?.input_tokens).toBe(1_500);
    expect(rows[0]?.output_tokens).toBe(1);
    expect(fx.audit.some((entry) => entry.action === "gateway.metered_partial")).toBe(true);
  });

  it("meters what a client that disconnects mid-stream already consumed", async () => {
    fx = await startFixture();
    fx.upstream.respondWith({ chunks: anthropicStream(900, 300), betweenChunksMs: 40 });

    const response = await fetch(messagesUrl(fx.origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.token}` },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 256, stream: true, messages: [] }),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no response body");
    await reader.read(); // take the first chunk only
    await reader.cancel(); // then walk away, as an aborted agent would

    await new Promise((resolve) => setTimeout(resolve, 400));
    const rows = await fx.usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.input_tokens).toBe(900);
  });

  // -- budget ---------------------------------------------------------------

  it("refuses an exhausted budget BEFORE anything reaches the provider", async () => {
    // $0.01 of headroom against a request declaring 32k output tokens at
    // $10/MTok — the hold alone is $0.32, so it cannot possibly fit.
    fx = await startFixture({ approvedBudgetUsd: 0.01 });
    fx.upstream.respondWith({ chunks: anthropicStream(10, 10) });

    const response = await fetch(messagesUrl(fx.origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.token}` },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 32_000,
        stream: true,
        messages: [],
      }),
    });

    expect(response.status).toBe(402);
    expect(response.headers.get(GATEWAY_REFUSAL_HEADER)).toBe("budget_exhausted");
    // THE POINT: not one byte went upstream, so not one cent was spent.
    expect(fx.upstream.calls).toHaveLength(0);
    const body = (await response.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe("norns_gateway_error");
    expect(body.error.code).toBe("budget_exhausted");
  });

  it("refuses a model outside the deployment allowlist", async () => {
    fx = await startFixture({ allowedModels: [`openai/${OPENAI_MODEL}`] });
    const response = await fetch(messagesUrl(fx.origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.token}` },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 16, messages: [] }),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get(GATEWAY_REFUSAL_HEADER)).toBe("model_unavailable");
    expect(fx.upstream.calls).toHaveLength(0);
  });

  it("refuses a request whose body cannot be priced", async () => {
    fx = await startFixture();
    const response = await fetch(messagesUrl(fx.origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.token}` },
      body: "this is not json",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get(GATEWAY_REFUSAL_HEADER)).toBe("invalid_request");
    expect(fx.upstream.calls).toHaveLength(0);
  });

  it("refuses a path outside the surface's allowlist", async () => {
    fx = await startFixture();
    const response = await fetch(
      `${anthropicGatewayBaseUrl(fx.origin)}/v1/organizations/api_keys`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${fx.token}` },
      },
    );
    expect(response.status).toBe(400);
    expect(response.headers.get(GATEWAY_REFUSAL_HEADER)).toBe("invalid_request");
    expect(fx.upstream.calls).toHaveLength(0);
  });

  // -- credentials ----------------------------------------------------------

  it("refuses an unknown, malformed, revoked, or expired credential identically", async () => {
    fx = await startFixture();
    const expiring = new GatewayCredentialService(
      new InMemoryGatewayCredentialStore(),
      () => new Date(),
      -1, // already expired at mint
    );
    const expired = await expiring.mint(fx.run);
    const revoked = await fx.credentials.mint(fx.run);
    await fx.credentials.revokeRun(fx.run.run_id);

    for (const token of [
      "nrngw_totally-made-up",
      "not-even-prefixed",
      revoked.token,
      expired.token,
    ]) {
      const response = await fetch(messagesUrl(fx.origin), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 16, messages: [] }),
      });
      expect(response.status, token.slice(0, 12)).toBe(401);
      expect(response.headers.get(GATEWAY_REFUSAL_HEADER)).toBe("unauthorized");
      // Indistinguishable on the wire: a compromised job must not be able to
      // probe which tokens exist.
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toBe("gateway credential is not valid");
    }
    expect(fx.upstream.calls).toHaveLength(0);
  });

  it("refuses a credential minted for another run, and one fenced to an old generation", async () => {
    fx = await startFixture();
    const otherRun = await fx.credentials.mint({
      ...fx.run,
      run_id: "run-that-does-not-exist",
    });
    const staleGeneration = await fx.credentials.mint({
      ...fx.run,
      runner_generation: fx.run.runner_generation - 1,
    });
    const otherRunner = await fx.credentials.mint({ ...fx.run, runner_id: "runner-99" });

    for (const credential of [otherRun, staleGeneration, otherRunner]) {
      const response = await fetch(messagesUrl(fx.origin), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential.token}`,
        },
        body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 16, messages: [] }),
      });
      expect(response.status).toBe(401);
    }
    expect(fx.upstream.calls).toHaveLength(0);
  });

  it("accepts the credential in x-api-key as well as in a bearer header", async () => {
    fx = await startFixture();
    fx.upstream.respondWith({ chunks: anthropicStream(10, 5) });
    const response = await fetch(messagesUrl(fx.origin), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": fx.token },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 16, messages: [] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(fx.upstream.calls).toHaveLength(1);
  });

  // -- failure honesty ------------------------------------------------------

  it("passes an upstream error through with its status and body intact", async () => {
    fx = await startFixture();
    const providerError = JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message: "Number of requests has exceeded your limit" },
    });
    fx.upstream.respondWith({
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "17" },
      chunks: [providerError],
    });

    const response = await fetch(messagesUrl(fx.origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fx.token}` },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 16, messages: [] }),
    });

    expect(response.status).toBe(429);
    // The agent needs the provider's own retry hint to behave correctly.
    expect(response.headers.get("retry-after")).toBe("17");
    expect(await response.text()).toBe(providerError);
    // And it must be able to tell this was NOT a Norns refusal.
    expect(response.headers.get(GATEWAY_REFUSAL_HEADER)).toBeNull();
    // A failed call with no usage in its body is not invented into a charge.
    expect(await fx.usageRows()).toHaveLength(0);
  });

  it("never leaks the provider key on any refusal or error path", async () => {
    fx = await startFixture({ allowedModels: [] });
    const attempts: string[] = [];

    // allowlist refusal
    attempts.push(
      await fetch(messagesUrl(fx.origin), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${fx.token}` },
        body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 16, messages: [] }),
      }).then((r) => `${r.status} ${JSON.stringify([...r.headers])} ${r.text()}`),
    );
    // credential refusal
    attempts.push(
      await fetch(messagesUrl(fx.origin), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer nrngw_nope" },
        body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 16, messages: [] }),
      }).then(async (r) => `${r.status} ${JSON.stringify([...r.headers])} ${await r.text()}`),
    );
    // unreachable upstream
    await fx.upstream.stop();
    attempts.push(
      await fetch(responsesUrl(fx.origin), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${fx.token}` },
        body: JSON.stringify({ model: OPENAI_MODEL, input: "hi", max_output_tokens: 8 }),
      }).then(async (r) => `${r.status} ${JSON.stringify([...r.headers])} ${await r.text()}`),
    );

    const everything = `${attempts.join("\n")}\n${JSON.stringify(fx.audit)}`;
    expect(everything).not.toContain(PROVIDER_KEY_ANTHROPIC);
    expect(everything).not.toContain(PROVIDER_KEY_OPENAI);
    expect(everything).not.toContain("sk-ant-");
    expect(everything).not.toContain("sk-proj-");
    // The audit trail records decisions, never secrets.
    expect(fx.audit.length).toBeGreaterThan(0);
  });
});

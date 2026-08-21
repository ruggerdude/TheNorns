import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeCodeRuntime, CodexRuntime, PROVIDER_KEY_ENV_VARS } from "../dist/index.js";

const providerEnvironment = Object.fromEntries(
  PROVIDER_KEY_ENV_VARS.map((name) => [name, `must-not-survive-${name}`]),
);

function gatewayCredential() {
  return {
    token: "norns-short-lived-token",
    expires_at: "2030-01-01T00:00:00.000Z",
    anthropic_base_url: "https://gateway.example/anthropic",
    deepseek_base_url: "https://gateway.example/deepseek",
    openai_base_url: "https://gateway.example/openai/v1",
  };
}

function codexSubscriptionAuth(authenticated = true) {
  return {
    runtime: "codex",
    installed: true,
    supported_credential_modes: ["api", "subscription"],
    subscription_authenticated: authenticated,
    subscription_auth_mode: authenticated ? "chatgpt" : null,
    subscription_type: null,
  };
}

function claudeSubscriptionAuth(authenticated = true) {
  return {
    runtime: "claude-code",
    installed: true,
    supported_credential_modes: ["api", "subscription"],
    subscription_authenticated: authenticated,
    subscription_auth_mode: authenticated ? "claude.ai" : null,
    subscription_type: authenticated ? "max" : null,
  };
}

function assertProviderEnvironmentWasStripped(env) {
  assert.equal(env.NORNS_TEST_SAFE_VALUE, "preserved");
  for (const name of PROVIDER_KEY_ENV_VARS) {
    assert.equal(Object.hasOwn(env, name), false, `${name} leaked to the runtime`);
  }
}

test("Codex subscription mode never mints and uses only sanitized persisted login", async () => {
  let mintCalls = 0;
  let clientOptions;
  const runtime = new CodexRuntime({
    credentialMode: "subscription",
    baseEnv: { ...providerEnvironment, NORNS_TEST_SAFE_VALUE: "preserved" },
    gateway: async () => {
      mintCalls += 1;
      return gatewayCredential();
    },
    subscriptionAuthProbe: () => codexSubscriptionAuth(),
    createClient: (options) => {
      clientOptions = options;
      return {
        resumeThread() {
          throw new Error("unexpected resume");
        },
        startThread() {
          return {
            id: "thread-subscription",
            async run() {
              return { finalResponse: "done" };
            },
          };
        },
      };
    },
  });

  const result = await runtime.run({
    runId: "run-subscription",
    worktreePath: "/tmp/norns-subscription-test",
    prompt: "Do the work.",
  });

  assert.equal(result.outcome, "completed");
  assert.equal(mintCalls, 0);
  assert.equal(Object.hasOwn(clientOptions, "apiKey"), false);
  assert.equal(Object.hasOwn(clientOptions, "baseUrl"), false);
  assertProviderEnvironmentWasStripped(clientOptions.env);
});

test("Codex replaces a missing local rollout with a fresh session and full task context", async () => {
  const calls = [];
  const logs = [];
  const runtime = new CodexRuntime({
    credentialMode: "subscription",
    resumeThreadId: "thread-missing-locally",
    subscriptionAuthProbe: () => codexSubscriptionAuth(),
    createClient: () => ({
      resumeThread(id) {
        calls.push(["resume", id]);
        return {
          id,
          async run(prompt) {
            calls.push(["resume-run", prompt]);
            throw new Error(
              "Codex Exec exited with code 1: Error: thread/resume: thread/resume failed: no rollout found for thread id thread-missing-locally (code -32600)",
            );
          },
        };
      },
      startThread() {
        calls.push(["start"]);
        return {
          id: "thread-fresh",
          async run(prompt) {
            calls.push(["start-run", prompt]);
            return { finalResponse: "implemented and committed" };
          },
        };
      },
    }),
  });

  const result = await runtime.run({
    runId: "run-missing-rollout",
    worktreePath: "/tmp/norns-subscription-test",
    prompt: "Continue the previous coding session.",
    resumeFallbackPrompt: "Full approved task context.",
    onLog: (chunk) => logs.push(chunk),
  });

  assert.equal(result.outcome, "completed");
  assert.equal(result.sessionId, "thread-fresh");
  assert.deepEqual(calls, [
    ["resume", "thread-missing-locally"],
    ["resume-run", "Continue the previous coding session."],
    ["start"],
    ["start-run", "Full approved task context."],
  ]);
  assert.match(logs[0], /saved Codex session is no longer available/);
  assert.equal(logs[1], "implemented and committed");
});

test("Codex does not start a replacement session for an uncertain resume failure", async () => {
  let freshStarts = 0;
  const runtime = new CodexRuntime({
    credentialMode: "subscription",
    resumeThreadId: "thread-network-error",
    subscriptionAuthProbe: () => codexSubscriptionAuth(),
    createClient: () => ({
      resumeThread() {
        return {
          async run() {
            throw new Error("connection closed before the resume response arrived");
          },
        };
      },
      startThread() {
        freshStarts += 1;
        throw new Error("must not start a duplicate session");
      },
    }),
  });

  const result = await runtime.run({
    runId: "run-uncertain-resume",
    worktreePath: "/tmp/norns-subscription-test",
    prompt: "Continue the previous coding session.",
    resumeFallbackPrompt: "Full approved task context.",
  });

  assert.equal(result.outcome, "failed");
  assert.match(result.detail, /connection closed/);
  assert.equal(freshStarts, 0);
});

test("Claude subscription mode never mints and strips API, OAuth, and base URL overrides", async () => {
  let mintCalls = 0;
  let queryOptions;
  const runtime = new ClaudeCodeRuntime({
    credentialMode: "subscription",
    baseEnv: { ...providerEnvironment, NORNS_TEST_SAFE_VALUE: "preserved" },
    gateway: async () => {
      mintCalls += 1;
      return gatewayCredential();
    },
    subscriptionAuthProbe: () => claudeSubscriptionAuth(),
    queryImpl: ({ options }) => {
      queryOptions = options;
      return {
        async interrupt() {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: "result",
            subtype: "success",
            result: "done",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      };
    },
  });

  const result = await runtime.run({
    runId: "run-subscription",
    worktreePath: "/tmp/norns-subscription-test",
    prompt: "Do the work.",
  });

  assert.equal(result.outcome, "completed");
  assert.equal(mintCalls, 0);
  assertProviderEnvironmentWasStripped(queryOptions.env);
});

test("API mode mints once and uses the generalized Anthropic-compatible gateway", async () => {
  let mintCalls = 0;
  let queryOptions;
  const runtime = new ClaudeCodeRuntime({
    credentialMode: "api",
    provider: "deepseek",
    baseEnv: { ...providerEnvironment, NORNS_TEST_SAFE_VALUE: "preserved" },
    gateway: async () => {
      mintCalls += 1;
      return gatewayCredential();
    },
    queryImpl: ({ options }) => {
      queryOptions = options;
      return {
        async interrupt() {},
        async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "success", result: "done" };
        },
      };
    },
  });

  await runtime.run({
    runId: "run-api",
    worktreePath: "/tmp/norns-api-test",
    prompt: "Do the work.",
  });

  assert.equal(mintCalls, 1);
  assert.equal(queryOptions.env.ANTHROPIC_AUTH_TOKEN, "norns-short-lived-token");
  assert.equal(queryOptions.env.ANTHROPIC_BASE_URL, "https://gateway.example/deepseek");
  assert.equal(Object.hasOwn(queryOptions.env, "ANTHROPIC_API_KEY"), false);
  assert.equal(Object.hasOwn(queryOptions.env, "DEEPSEEK_API_KEY"), false);
});

test("agentic runtimes confine autonomous filesystem access to runner-approved paths", async () => {
  let claudeOptions;
  await new ClaudeCodeRuntime({
    credentialMode: "api",
    baseEnv: { HOME: "/Users/example", NORNS_TEST_SAFE_VALUE: "preserved" },
    gateway: async () => gatewayCredential(),
    queryImpl: ({ options }) => {
      claudeOptions = options;
      return {
        async interrupt() {},
        async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "success", result: "done" };
        },
      };
    },
  }).run({
    runId: "run-sandbox-claude",
    worktreePath: "/Users/example/repository-worktree",
    runtimeStateDirectory: "/Users/example/.norns/runtime-state",
    additionalReadDirectories: ["/Users/example/.norns/approved-inputs"],
    additionalWriteDirectories: ["/Users/example/repository/.git"],
    prompt: "Do the work.",
  });

  assert.deepEqual(claudeOptions.settingSources, []);
  assert.equal(claudeOptions.managedSettings.sandbox.enabled, true);
  assert.equal(claudeOptions.managedSettings.sandbox.failIfUnavailable, true);
  assert.equal(claudeOptions.managedSettings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(claudeOptions.managedSettings.sandbox.filesystem.denyRead, [
    "/Users/example/.ssh",
    "/Users/example/.aws",
    "/Users/example/.gnupg",
    "/Users/example/.kube",
    "/Users/example/.netrc",
    "/Users/example/.npmrc",
  ]);
  assert.deepEqual(claudeOptions.managedSettings.sandbox.filesystem.allowRead, [
    "/Users/example/repository-worktree",
    "/Users/example/.norns/runtime-state",
    "/Users/example/.norns/approved-inputs",
    "/Users/example/repository/.git",
  ]);
  assert.deepEqual(claudeOptions.managedSettings.sandbox.filesystem.allowWrite, [
    "/Users/example/repository-worktree",
    "/Users/example/.norns/runtime-state",
    "/Users/example/repository/.git",
  ]);
  assert.equal(claudeOptions.env.HOME, "/Users/example/.norns/runtime-state");

  let codexThreadOptions;
  await new CodexRuntime({
    credentialMode: "api",
    baseEnv: { HOME: "/Users/example", NORNS_TEST_SAFE_VALUE: "preserved" },
    gateway: async () => gatewayCredential(),
    createClient: () => ({
      resumeThread() {
        throw new Error("unexpected resume");
      },
      startThread(options) {
        codexThreadOptions = options;
        return {
          async run() {
            return { finalResponse: "done" };
          },
        };
      },
    }),
  }).run({
    runId: "run-sandbox-codex",
    worktreePath: "/Users/example/repository-worktree",
    runtimeStateDirectory: "/Users/example/.norns/runtime-state",
    additionalReadDirectories: ["/Users/example/.norns/approved-inputs"],
    additionalWriteDirectories: ["/Users/example/repository/.git"],
    prompt: "Do the work.",
  });

  assert.equal(codexThreadOptions.sandboxMode, "workspace-write");
  assert.equal(codexThreadOptions.approvalPolicy, "never");
  assert.deepEqual(codexThreadOptions.additionalDirectories, [
    "/Users/example/.norns/runtime-state",
    "/Users/example/.norns/approved-inputs",
    "/Users/example/repository/.git",
  ]);
});

test("explicit API mode fails before either SDK can spawn when no gateway is configured", async () => {
  let codexSpawned = false;
  const codex = await new CodexRuntime({
    credentialMode: "api",
    createClient: () => {
      codexSpawned = true;
      throw new Error("must not spawn");
    },
  }).run({
    runId: "run-api-without-gateway",
    worktreePath: "/tmp/norns-api-test",
    prompt: "Do the work.",
  });

  let claudeSpawned = false;
  const claude = await new ClaudeCodeRuntime({
    credentialMode: "api",
    queryImpl: () => {
      claudeSpawned = true;
      throw new Error("must not spawn");
    },
  }).run({
    runId: "run-api-without-gateway",
    worktreePath: "/tmp/norns-api-test",
    prompt: "Do the work.",
  });

  assert.equal(codex.outcome, "failed");
  assert.match(codex.detail, /API mode requires a Norns gateway/);
  assert.equal(codexSpawned, false);
  assert.equal(claude.outcome, "failed");
  assert.match(claude.detail, /API mode requires a Norns gateway/);
  assert.equal(claudeSpawned, false);
});

test("subscription mode fails before spawning when the matching persisted login is absent", async () => {
  let codexSpawned = false;
  const codex = await new CodexRuntime({
    credentialMode: "subscription",
    subscriptionAuthProbe: () => codexSubscriptionAuth(false),
    createClient: () => {
      codexSpawned = true;
      throw new Error("must not spawn");
    },
  }).run({
    runId: "run-subscription-without-login",
    worktreePath: "/tmp/norns-subscription-test",
    prompt: "Do the work.",
  });

  let claudeSpawned = false;
  const claude = await new ClaudeCodeRuntime({
    credentialMode: "subscription",
    provider: "anthropic",
    subscriptionAuthProbe: () => claudeSubscriptionAuth(false),
    queryImpl: () => {
      claudeSpawned = true;
      throw new Error("must not spawn");
    },
  }).run({
    runId: "run-subscription-without-login",
    worktreePath: "/tmp/norns-subscription-test",
    prompt: "Do the work.",
  });

  assert.equal(codex.outcome, "failed");
  assert.match(codex.detail, /subscription login is unavailable/);
  assert.equal(codexSpawned, false);
  assert.equal(claude.outcome, "failed");
  assert.match(claude.detail, /subscription login is unavailable/);
  assert.equal(claudeSpawned, false);
});

test("DeepSeek subscription mode is rejected before probing or spawning", async () => {
  let probeCalls = 0;
  let spawned = false;
  const result = await new ClaudeCodeRuntime({
    credentialMode: "subscription",
    provider: "deepseek",
    subscriptionAuthProbe: () => {
      probeCalls += 1;
      return claudeSubscriptionAuth();
    },
    queryImpl: () => {
      spawned = true;
      throw new Error("must not spawn");
    },
  }).run({
    runId: "run-deepseek-subscription",
    worktreePath: "/tmp/norns-subscription-test",
    prompt: "Do the work.",
  });

  assert.equal(result.outcome, "failed");
  assert.match(result.detail, /DeepSeek does not support subscription/);
  assert.equal(probeCalls, 0);
  assert.equal(spawned, false);
});

test("omitted credential mode preserves legacy direct-construction SDK seams", async () => {
  let codexSpawned = false;
  const codex = await new CodexRuntime({
    subscriptionAuthProbe: () => {
      throw new Error("legacy construction must not probe");
    },
    createClient: () => ({
      resumeThread() {
        throw new Error("unexpected resume");
      },
      startThread() {
        codexSpawned = true;
        return {
          async run() {
            return { finalResponse: "done" };
          },
        };
      },
    }),
  }).run({
    runId: "run-legacy",
    worktreePath: "/tmp/norns-legacy-test",
    prompt: "Do the work.",
  });

  let claudeSpawned = false;
  const claude = await new ClaudeCodeRuntime({
    subscriptionAuthProbe: () => {
      throw new Error("legacy construction must not probe");
    },
    queryImpl: () => {
      claudeSpawned = true;
      return {
        async interrupt() {},
        async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "success", result: "done" };
        },
      };
    },
  }).run({
    runId: "run-legacy",
    worktreePath: "/tmp/norns-legacy-test",
    prompt: "Do the work.",
  });

  assert.equal(codex.outcome, "completed");
  assert.equal(codexSpawned, true);
  assert.equal(claude.outcome, "completed");
  assert.equal(claudeSpawned, true);
});

test("Claude emits readable messages and tool actions without hidden reasoning", async () => {
  const logs = [];
  const worktreePath = "/tmp/norns-readable-transcript";
  const runtime = new ClaudeCodeRuntime({
    queryImpl: () => ({
      async interrupt() {},
      async *[Symbol.asyncIterator]() {
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "hidden chain of thought" },
              { type: "text", text: "I found the configuration and am updating it now." },
              {
                type: "tool_use",
                name: "Read",
                input: { file_path: `${worktreePath}/src/config.ts` },
              },
              {
                type: "tool_use",
                name: "Bash",
                input: { command: "pnpm test --token=must-not-appear" },
              },
            ],
          },
        };
        yield { type: "result", subtype: "success", result: "done" };
      },
    }),
  });

  const result = await runtime.run({
    runId: "run-readable-transcript",
    worktreePath,
    prompt: "Do the work.",
    onLog: (chunk) => logs.push(JSON.parse(chunk)),
  });

  assert.equal(result.outcome, "completed");
  assert.deepEqual(logs, [
    {
      type: "norns_activity",
      kind: "message",
      text: "I found the configuration and am updating it now.",
    },
    { type: "norns_activity", kind: "tool", text: "Reading src/config.ts" },
    {
      type: "norns_activity",
      kind: "tool",
      text: "Running tests · pnpm test --token=[redacted]",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /hidden chain of thought|must-not-appear/);
});

test("Claude Code falls back to a fresh session when the resumed session no longer exists", async () => {
  const resumeOptionsSeen = [];
  const runtime = new ClaudeCodeRuntime({
    credentialMode: "subscription",
    baseEnv: { ...providerEnvironment },
    subscriptionAuthProbe: () => claudeSubscriptionAuth(),
    resumeSessionId: "session-gone",
    queryImpl: ({ options }) => {
      resumeOptionsSeen.push(options.resume);
      return {
        async interrupt() {},
        async *[Symbol.asyncIterator]() {
          if (options.resume !== undefined) {
            // The real SDK THROWS for this condition (verified in
            // @anthropic-ai/claude-agent-sdk 0.3.207 sdk.mjs), it does not
            // yield an error result message.
            throw new Error(
              "Claude Code returned an error result: No conversation found with session ID: session-gone",
            );
          }
          yield {
            type: "result",
            subtype: "success",
            result: "done",
            usage: { input_tokens: 2, output_tokens: 3 },
          };
        },
      };
    },
  });

  const logs = [];
  const result = await runtime.run({
    runId: "run-stale-claude-session",
    worktreePath: "/tmp/norns-subscription-test",
    prompt: "Continue the previous coding session.",
    onLog: (line) => logs.push(line),
  });

  assert.equal(result.outcome, "completed");
  assert.deepEqual(resumeOptionsSeen, ["session-gone", undefined]);
  assert.match(logs.join("\n"), /no longer available on this computer/);
});

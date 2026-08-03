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

import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_KEY_ENV_VARS,
  probeClaudeSubscriptionAuth,
  probeCodexSubscriptionAuth,
} from "../dist/index.js";

function result({ stdout = "", stderr = "", status = 0, error } = {}) {
  return { stdout, stderr, status, error };
}

test("Codex auth probe accepts ChatGPT login and reports no command output or identity", () => {
  let invocation;
  const capability = probeCodexSubscriptionAuth(
    {
      OPENAI_API_KEY: "sk-must-not-reach-probe",
      OPENAI_BASE_URL: "https://untrusted.example",
      NORNS_TEST_SAFE_VALUE: "preserved",
    },
    (command, args, options) => {
      invocation = { command, args, options };
      return result({ stderr: "Logged in using ChatGPT\n" });
    },
  );

  assert.equal(invocation.command, "codex");
  assert.deepEqual(invocation.args, ["login", "status"]);
  assert.equal(invocation.options.env.NORNS_TEST_SAFE_VALUE, "preserved");
  assert.equal(Object.hasOwn(invocation.options.env, "OPENAI_API_KEY"), false);
  assert.equal(Object.hasOwn(invocation.options.env, "OPENAI_BASE_URL"), false);
  assert.deepEqual(capability, {
    runtime: "codex",
    installed: true,
    supported_credential_modes: ["api", "subscription"],
    subscription_authenticated: true,
    subscription_auth_mode: "chatgpt",
    subscription_type: null,
  });
  assert.equal(JSON.stringify(capability).includes("Logged in"), false);
});

test("Codex auth probe rejects persisted API-key login as a subscription capability", () => {
  const capability = probeCodexSubscriptionAuth({}, () =>
    result({ stderr: "Logged in using an API key - sk-redacted\n" }),
  );

  assert.equal(capability.subscription_authenticated, false);
  assert.equal(capability.subscription_auth_mode, null);
  assert.equal(JSON.stringify(capability).includes("sk-redacted"), false);
});

test("Claude auth probe accepts only claude.ai subscription auth and drops secret metadata", () => {
  let probeEnvironment;
  const capability = probeClaudeSubscriptionAuth(
    Object.fromEntries(PROVIDER_KEY_ENV_VARS.map((name) => [name, `secret-${name}`])),
    (_command, _args, options) => {
      probeEnvironment = options.env;
      return result({
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          email: "operator@example.test",
          orgId: "org-secret",
          subscriptionType: "Max",
          accessToken: "oauth-secret",
        }),
      });
    },
  );

  for (const name of PROVIDER_KEY_ENV_VARS) {
    assert.equal(Object.hasOwn(probeEnvironment, name), false, `${name} reached auth probe`);
  }
  assert.deepEqual(capability, {
    runtime: "claude-code",
    installed: true,
    supported_credential_modes: ["api", "subscription"],
    subscription_authenticated: true,
    subscription_auth_mode: "claude.ai",
    subscription_type: "max",
  });
  const reported = JSON.stringify(capability);
  assert.equal(reported.includes("operator@example.test"), false);
  assert.equal(reported.includes("org-secret"), false);
  assert.equal(reported.includes("oauth-secret"), false);
});

test("Claude auth probe rejects API-key auth even when logged in", () => {
  const capability = probeClaudeSubscriptionAuth({}, () =>
    result({
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "api_key",
        apiProvider: "firstParty",
        apiKeySource: "ANTHROPIC_API_KEY",
      }),
    }),
  );

  assert.equal(capability.subscription_authenticated, false);
  assert.equal(capability.subscription_auth_mode, null);
  assert.equal(capability.subscription_type, null);
});

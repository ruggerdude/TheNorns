import { describe, expect, it } from "vitest";
import {
  AiUsageLifecycleEventInput,
  type AiUsageLifecycleEventInputT,
  UsageEvent,
  type UsageEventT,
} from "../src/index.js";

const legacyUsage: UsageEventT = {
  id: "usage-1",
  provider: "anthropic",
  model: "claude",
  project_id: "project-1",
  node_id: null,
  run_id: null,
  input_tokens: 120,
  output_tokens: 20,
  cache_read_tokens: 15,
  cache_write_tokens: 5,
  estimated_cost_usd: 0.01,
  actual_cost_usd: null,
  usage_source: "provider_api",
  pricing_version: "pricing-1",
  occurred_at: "2026-07-25T00:00:00.000Z",
};

const canonicalUsage: AiUsageLifecycleEventInputT = {
  request_id: "request-1",
  event_type: "usage_observed",
  status: "in_progress",
  occurred_at: "2026-07-25T00:00:00.000Z",
  provider: "anthropic",
  model: "claude",
  provider_request_id: null,
  endpoint: "/v1/messages",
  request_type: "provider_native",
  retry_group_id: null,
  retry_attempt: 0,
  initiated_by_user_id: null,
  project_id: null,
  phase_id: null,
  task_id: null,
  run_id: null,
  usage_source: "provider_api",
  confidence: 1,
  pricing_profile_id: null,
  input_tokens: 120,
  output_tokens: 20,
  cache_read_tokens: 15,
  cache_write_tokens: 5,
  cost_usd: 0.01,
  cost_classification: "actual",
  latency_ms: null,
  http_status: null,
  error_code: null,
  error_category: null,
  error_message_redacted: null,
  sanitized_error: null,
  adjusts_event_id: null,
};

describe("normalized cache token invariants", () => {
  it("accepts provider-normalized cache subsets in legacy and canonical usage", () => {
    expect(UsageEvent.parse(legacyUsage)).toMatchObject({ input_tokens: 120 });
    expect(AiUsageLifecycleEventInput.parse(canonicalUsage)).toMatchObject({
      input_tokens: 120,
    });
  });

  it("rejects double-count-prone cache totals above normalized input", () => {
    expect(() =>
      UsageEvent.parse({ ...legacyUsage, input_tokens: 10, cache_read_tokens: 11 }),
    ).toThrow(/cache token categories/);
    expect(() =>
      AiUsageLifecycleEventInput.parse({
        ...canonicalUsage,
        input_tokens: 10,
        cache_read_tokens: 11,
      }),
    ).toThrow(/cache token categories/);
  });
});
